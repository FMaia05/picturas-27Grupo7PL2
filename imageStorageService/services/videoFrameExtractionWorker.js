const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
let axios;
try {
  axios = require("axios");
} catch (_) {
  axios = null;
}
const Video = require("../models/video");
const VideoTask = require("../models/videoTask");
const s3 = require("./s3Client");
const { refundTaskOperation, videoStorageQuota } = require("./videoTaskBilling");

const PROJECTS_URL = process.env.PROJECTS_URL || "https://projects:9001/";
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const pendingTasks = [];
let isWorkerRunning = false;
const activeProcesses = new Map();
const cancelledTasks = new Set();

function formatTimestamp(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return [
    String(h).padStart(2, "0"),
    String(m).padStart(2, "0"),
    String(s).padStart(2, "0"),
    String(ms).padStart(3, "0"),
  ].join("-");
}

async function postJsonInternal(targetUrl, payload, headers = {}) {
  if (axios) {
    try {
      const resp = await axios.post(targetUrl, payload, {
        httpsAgent,
        headers,
      });
      return resp.data;
    } catch (err) {
      // Fallback to native https/http if axios fails
      console.warn("Axios post failed, trying native request:", err.message);
    }
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === "https:" ? https : http;
    const bodyStr = JSON.stringify(payload);
    const req = client.request(
      parsed,
      {
        method: "POST",
        agent: parsed.protocol === "https:" ? httpsAgent : undefined,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let parsedData = null;
          try {
            parsedData = raw ? JSON.parse(raw) : null;
          } catch (_) {
            parsedData = raw;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsedData);
          } else {
            const err = new Error(`Request to ${targetUrl} failed with status ${res.statusCode}: ${raw}`);
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

async function extractSingleFrame(tempInput, outputFilePath, timestamp, format, taskId) {
  const ffmpegArgs = [
    "-ss",
    String(timestamp),
    "-i",
    tempInput,
    "-frames:v",
    "1",
  ];

  if (format === "jpeg") {
    ffmpegArgs.push("-q:v", "2"); // Quality ~90
  }

  ffmpegArgs.push("-y", outputFilePath);

  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });
    activeProcesses.set(taskId, child);

    child.on("error", (err) => {
      activeProcesses.delete(taskId);
      reject(err);
    });

    child.on("close", (code) => {
      activeProcesses.delete(taskId);
      if (cancelledTasks.has(taskId)) {
        return reject(new Error("Task was cancelled by user."));
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg frame extraction exited with code ${code}`));
      }
    });
  });
}

async function executeExtractFrames(task, isRetry = false) {
  const taskId = task.id.toString();

  if (cancelledTasks.has(taskId)) {
    task.status = "cancelled";
    task.error = "Extração cancelada. Nenhuma operação foi contabilizada.";
    await task.save();
    await refundTaskOperation(task);
    cancelledTasks.delete(taskId);
    return;
  }

  task.status = "processing";
  task.progress = 5;
  task.extractedFramesCount = 0;
  await task.save();

  const originalVideo = await Video.findOne({
    _id: task.sourceVideoId,
    userId: task.userId,
  });

  if (!originalVideo || originalVideo.status !== "ready") {
    task.status = "failed";
    task.error = "Original video not found or not in ready state.";
    await task.save();
    await refundTaskOperation(task);
    return;
  }

  const extension = path.extname(originalVideo.originalName).toLowerCase() || ".mp4";
  const tempInput = path.join(
    os.tmpdir(),
    `picturas-extract-in-${taskId}-${Date.now()}${extension}`,
  );
  const tempFramesDir = path.join(
    os.tmpdir(),
    `picturas-extract-frames-${taskId}-${Date.now()}`,
  );

  const bucket = `user-${task.userId}`;
  const uploadedS3Keys = [];
  let timeoutHandle = null;

  try {
    await fs.promises.mkdir(tempFramesDir, { recursive: true });

    // 10 minutes global timeout (RN8, REQ-VID-FRAME-052)
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const child = activeProcesses.get(taskId);
        if (child) {
          try {
            child.kill("SIGKILL");
          } catch (_) {}
        }
        const timeoutErr = new Error("A extração demorou mais do que o permitido. Reduza o intervalo ou aumente o passo.");
        timeoutErr.code = "TASK_TIMEOUT";
        reject(timeoutErr);
      }, 10 * 60 * 1000);
    });

    const processPromise = (async () => {
      // 1. Download original video from S3 to temporary input file
      await new Promise((resolve, reject) => {
        const input = s3.getObject({ Bucket: bucket, Key: originalVideo.objectKey }).createReadStream();
        const output = fs.createWriteStream(tempInput);
        input.on("error", reject);
        output.on("error", reject);
        output.on("finish", resolve);
        input.pipe(output);
      });

      if (cancelledTasks.has(taskId)) {
        throw new Error("Task was cancelled by user.");
      }

      task.progress = 10;
      await task.save();

      // 2. Compute instants t_k = start + k * step (RN4, REQ-VID-FRAME-032)
      const instants = [];
      const step = task.step || 5;
      for (let t = task.start; t <= task.end + 0.0001; t += step) {
        instants.push(Number(t.toFixed(3)));
      }
      task.totalFramesCount = instants.length;
      await task.save();

      const baseVideoName = path.basename(originalVideo.originalName, extension);
      const outputExt = task.format === "jpeg" ? "jpg" : "png";
      const mimeType = task.format === "jpeg" ? "image/jpeg" : "image/png";

      const extractedFiles = [];

      // 3. Extract frames sequentially, updating progress at least every 5s (REQ-VID-FRAME-030)
      for (let i = 0; i < instants.length; i++) {
        if (cancelledTasks.has(taskId)) {
          throw new Error("Task was cancelled by user.");
        }

        const instant = instants[i];
        const timestampStr = formatTimestamp(instant);
        const fileName = `${baseVideoName}_${timestampStr}.${outputExt}`;
        const outputFilePath = path.join(tempFramesDir, fileName);

        await extractSingleFrame(tempInput, outputFilePath, instant, task.format, taskId);

        const stat = await fs.promises.stat(outputFilePath);
        if (stat.size <= 0) {
          throw new Error(`Extracted frame ${fileName} is empty.`);
        }

        extractedFiles.push({
          instant,
          fileName,
          filePath: outputFilePath,
          size: stat.size,
        });

        task.extractedFramesCount = i + 1;
        task.progress = Math.min(85, Math.round(((i + 1) / instants.length) * 75) + 10);
        await task.save();
      }

      if (cancelledTasks.has(taskId)) {
        throw new Error("Task was cancelled by user.");
      }

      // 4. Verify storage quota (RN2, Exceção 8, REQ-VID-FRAME-051)
      const totalExtractedBytes = extractedFiles.reduce((acc, f) => acc + f.size, 0);
      const usage = await Video.aggregate([
        { $match: { userId: task.userId, status: { $in: ["uploading", "processing", "ready"] } } },
        { $group: { _id: null, total: { $sum: "$size" } } },
      ]);
      const currentUsage = usage[0]?.total || 0;
      const userQuota = videoStorageQuota(task.userType);

      if (currentUsage + totalExtractedBytes > userQuota) {
        const err = new Error("Armazenamento insuficiente para guardar os fotogramas.");
        err.code = "STORAGE_FULL";
        throw err;
      }

      // 5. Upload extracted frames to S3 and prepare images array for projects service
      task.progress = 88;
      await task.save();

      // Determine project ID
      const mongoose = require("mongoose");
      const targetProjectId = task.destinationType === "existing" && task.destinationProjectId
        ? task.destinationProjectId
        : new mongoose.Types.ObjectId().toString();

      const imagesForProject = [];

      for (const item of extractedFiles) {
        if (cancelledTasks.has(taskId)) {
          throw new Error("Task was cancelled by user.");
        }

        const fileBuffer = await fs.promises.readFile(item.filePath);
        const sha = crypto.createHash("sha256").update(fileBuffer).digest("hex");
        const s3KeyUuid = crypto.randomUUID();
        const objectKey = `${targetProjectId}/src/${s3KeyUuid}.${outputExt}`;

        await s3
          .upload({
            Bucket: bucket,
            Key: objectKey,
            Body: fileBuffer,
            ContentType: mimeType,
          })
          .promise();

        uploadedS3Keys.push(objectKey);

        const og_uri = `./images/users/${task.userId}/projects/${targetProjectId}/src/${item.fileName}`;
        const new_uri = `./images/users/${task.userId}/projects/${targetProjectId}/out/${item.fileName}`;

        imagesForProject.push({
          og_uri,
          new_uri,
          og_img_key: `${s3KeyUuid}.${outputExt}`,
          og_sha256: sha,
        });
      }

      if (cancelledTasks.has(taskId)) {
        throw new Error("Task was cancelled by user.");
      }

      task.progress = 95;
      await task.save();

      // 6. Integrate with projects microservice (REQ-VID-FRAME-040, FA2)
      const internalToken = process.env.INTERNAL_SERVICE_TOKEN || "picturas-internal-video-token";

      if (task.destinationType === "existing" && task.destinationProjectId) {
        // FA2: Acrescentar a projeto existente
        const data = await postJsonInternal(
          `${PROJECTS_URL}internal/${task.userId}/${task.destinationProjectId}/append-frames`,
          { imgs: imagesForProject },
          { "x-internal-service-token": internalToken },
        );
        task.resultProjectId = data?._id?.toString() || task.destinationProjectId;
      } else {
        // Novo projeto (REQ-VID-FRAME-040)
        const projectName = task.targetName || `${baseVideoName} - Fotogramas`;
        const data = await postJsonInternal(
          `${PROJECTS_URL}internal/${task.userId}/create-with-frames`,
          {
            _id: targetProjectId,
            name: projectName,
            imgs: imagesForProject,
          },
          { "x-internal-service-token": internalToken },
        );
        task.resultProjectId = data?._id?.toString() || targetProjectId;
      }

      // 7. Complete task successfully
      task.status = "completed";
      task.progress = 100;
      await task.save();
    })();

    await Promise.race([processPromise, timeoutPromise]);
  } catch (error) {
    console.error(`Error processing extract frames task ${taskId}:`, error.message);

    // If images were uploaded to S3 but task failed/cancelled before project was created, clean them up (RN12, REQ-VID-FRAME-046)
    if (!task.resultProjectId && uploadedS3Keys.length > 0) {
      for (const key of uploadedS3Keys) {
        await s3.deleteObject({ Bucket: bucket, Key: key }).promise().catch(() => {});
      }
    }

    if (cancelledTasks.has(taskId) || error.message.includes("cancelled")) {
      task.status = "cancelled";
      task.error = "Extração cancelada. Nenhuma operação foi contabilizada.";
      await task.save();
      await refundTaskOperation(task);
      cancelledTasks.delete(taskId);
      return;
    }

    if (error.code === "STORAGE_FULL") {
      task.status = "failed";
      task.error = "Armazenamento insuficiente para guardar os fotogramas.";
      await task.save();
      await refundTaskOperation(task);
      return;
    }

    if (error.code === "TASK_TIMEOUT") {
      task.status = "failed";
      task.error = "A extração demorou mais do que o permitido. Reduza o intervalo ou aumente o passo.";
      await task.save();
      await refundTaskOperation(task);
      return;
    }

    // REQ-VID-FRAME-050: 1 repetição automática interna perante falha de worker
    if (!isRetry && task.retries === 0) {
      console.log(`Retrying extract frames task ${taskId} (attempt 2)...`);
      task.retries = 1;
      task.progress = 0;
      task.extractedFramesCount = 0;
      await task.save();
      await new Promise((res) => setTimeout(res, 1500));
      return executeExtractFrames(task, true);
    }

    // Failed after retry
    task.status = "failed";
    task.error = "Não foi possível extrair os fotogramas deste vídeo. A operação não foi contabilizada.";
    await task.save();
    await refundTaskOperation(task);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    activeProcesses.delete(taskId);
    // RN12: Ficheiros temporários eliminados em qualquer estado final
    await fs.promises.rm(tempInput, { force: true }).catch(() => {});
    await fs.promises.rm(tempFramesDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function drainQueue() {
  if (isWorkerRunning) return;
  isWorkerRunning = true;
  while (pendingTasks.length > 0) {
    const taskId = pendingTasks.shift();
    try {
      const task = await VideoTask.findById(taskId);
      if (task && (task.status === "queued" || task.status === "processing")) {
        await executeExtractFrames(task);
      }
    } catch (err) {
      console.error(`Error in queue worker for extract frames task ${taskId}:`, err);
    }
  }
  isWorkerRunning = false;
}

function enqueueExtractFramesTask(taskId) {
  pendingTasks.push(taskId.toString());
  setImmediate(drainQueue);
}

async function cancelExtractFramesTask(taskId) {
  cancelledTasks.add(taskId.toString());
  const child = activeProcesses.get(taskId.toString());
  if (child) {
    try {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (_) {}
      }, 2000);
    } catch (_) {}
  }

  const task = await VideoTask.findById(taskId);
  if (task && (task.status === "queued" || task.status === "processing")) {
    task.status = "cancelled";
    task.error = "Extração cancelada. Nenhuma operação foi contabilizada.";
    await task.save();
    await refundTaskOperation(task);
  }
}

module.exports = {
  enqueueExtractFramesTask,
  cancelExtractFramesTask,
};
