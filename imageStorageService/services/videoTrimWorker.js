const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const Video = require("../models/video");
const VideoTask = require("../models/videoTask");
const s3 = require("./s3Client");
const inspectVideo = require("./videoMetadata");

const USERS_URL = process.env.USERS_URL || "https://users:10001/";
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const pendingTasks = [];
let isWorkerRunning = false;
const activeProcesses = new Map();
const cancelledTasks = new Set();

async function refundOperation(userId) {
  try {
    const url = new URL(`${userId}/process/refund/1`, USERS_URL);
    await new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: "POST",
          agent: httpsAgent,
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          res.resume();
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            console.warn(`Refund returned status ${res.statusCode} for user ${userId}`);
            resolve(); // Do not crash worker on refund failure
          }
        },
      );
      req.on("error", (err) => {
        console.error(`Refund network error for user ${userId}:`, err.message);
        resolve(); // Continue even if users service has transient error
      });
      req.end();
    });
  } catch (error) {
    console.error(`Refund failed for user ${userId}:`, error.message);
  }
}

async function uploadFileStream(bucket, key, filePath, mimeType) {
  const fileStream = fs.createReadStream(filePath);
  return s3
    .upload({
      Bucket: bucket,
      Key: key,
      Body: fileStream,
      ContentType: mimeType,
    })
    .promise();
}

async function executeTrim(task, isRetry = false) {
  const taskId = task.id.toString();
  if (cancelledTasks.has(taskId)) {
    task.status = "cancelled";
    await task.save();
    if (task.chargedOperation) await refundOperation(task.userId);
    cancelledTasks.delete(taskId);
    return;
  }

  task.status = "processing";
  task.progress = 10;
  await task.save();

  const originalVideo = await Video.findOne({
    _id: task.sourceVideoId,
    userId: task.userId,
  });

  if (!originalVideo || originalVideo.status !== "ready") {
    task.status = "failed";
    task.error = "Original video not found or not in ready state.";
    await task.save();
    if (task.chargedOperation) await refundOperation(task.userId);
    return;
  }

  const extension = path.extname(originalVideo.originalName).toLowerCase() || ".mp4";
  const tempInput = path.join(
    os.tmpdir(),
    `picturas-trim-in-${taskId}-${Date.now()}${extension}`,
  );
  const tempOutput = path.join(
    os.tmpdir(),
    `picturas-trim-out-${taskId}-${Date.now()}${extension}`,
  );

  const bucket = `user-${task.userId}`;

  try {
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

    task.progress = 30;
    await task.save();

    // 2. Run ffmpeg with Stream Copy (lossless, RN6, NF07, NF08)
    // -avoid_negative_ts make_zero aligns timestamps and keyframe
    const ffmpegArgs = [
      "-ss",
      String(task.start),
      "-to",
      String(task.end),
      "-i",
      tempInput,
      "-map",
      "0",
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      "-y",
      tempOutput,
    ];

    await new Promise((resolve, reject) => {
      const child = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });
      activeProcesses.set(taskId, child);

      // 10 minutes timeout (RN7, REQ-VID-TRIM-NF10)
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Processing timeout exceeded 10 minutes."));
      }, 10 * 60 * 1000);

      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        activeProcesses.delete(taskId);
        if (cancelledTasks.has(taskId)) {
          return reject(new Error("Task was cancelled by user."));
        }
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });
    });

    task.progress = 70;
    await task.save();

    // 3. Inspect generated file for metadata and size
    const stat = await fs.promises.stat(tempOutput);
    const newSize = stat.size;
    if (newSize <= 0) {
      throw new Error("Generated trimmed video file is empty.");
    }

    // Inspect metadata of trimmed file
    const metadata = await inspectVideo(bucket, null, extension, tempOutput);

    // 4. Validate storage quota before final persist (Passo 7 Exceção)
    const quota = Number(process.env.FREE_VIDEO_QUOTA_BYTES || 1024 ** 3); // Base fallback
    const usage = await Video.aggregate([
      { $match: { userId: task.userId, status: { $in: ["uploading", "processing", "ready"] } } },
      { $group: { _id: null, total: { $sum: "$size" } } },
    ]);
    const currentUsage = usage[0]?.total || 0;
    const additionalSize = task.replaceOriginal ? Math.max(0, newSize - originalVideo.size) : newSize;

    // We verify if adding this video exceeds storage (using reasonable default or environment)
    const userStorageQuota = originalVideo.size > 200 * 1024 * 1024 || (task.duration > 300)
      ? Number(process.env.PREMIUM_VIDEO_QUOTA_BYTES || 20 * 1024 ** 3)
      : Number(process.env.FREE_VIDEO_QUOTA_BYTES || 1024 ** 3);

    if (currentUsage + additionalSize > userStorageQuota) {
      const err = new Error("Armazenamento insuficiente para guardar o novo vídeo.");
      err.code = "STORAGE_FULL";
      throw err;
    }

    // 5. Upload trimmed video to S3 and save/update database
    task.progress = 85;
    await task.save();

    if (task.replaceOriginal) {
      // FA2 – Substituir vídeo original: remove old S3 object, upload new, update DB record
      const newKey = `videos/${crypto.randomUUID()}${extension}`;
      await uploadFileStream(bucket, newKey, tempOutput, originalVideo.mimeType);
      await s3.deleteObject({ Bucket: bucket, Key: originalVideo.objectKey }).promise().catch(() => {});

      originalVideo.objectKey = newKey;
      originalVideo.size = newSize;
      originalVideo.metadata = metadata;
      if (task.targetName) {
        originalVideo.originalName = task.targetName;
      }
      await originalVideo.save();

      task.resultVideoId = originalVideo._id;
    } else {
      // Normal flow: create new video in library
      const newKey = `videos/${crypto.randomUUID()}${extension}`;
      await uploadFileStream(bucket, newKey, tempOutput, originalVideo.mimeType);

      const createdVideo = await Video.create({
        userId: task.userId,
        originalName: task.targetName,
        mimeType: originalVideo.mimeType,
        size: newSize,
        objectKey: newKey,
        status: "ready",
        metadata,
      });

      task.resultVideoId = createdVideo._id;
    }

    // 6. Complete task successfully
    task.status = "completed";
    task.progress = 100;
    await task.save();
  } catch (error) {
    console.error(`Error processing trim task ${taskId}:`, error.message);

    if (cancelledTasks.has(taskId) || error.message.includes("cancelled")) {
      task.status = "cancelled";
      task.error = "Recorte cancelado. Nenhuma operação foi contabilizada.";
      await task.save();
      if (task.chargedOperation) await refundOperation(task.userId);
      cancelledTasks.delete(taskId);
      return;
    }

    if (error.code === "STORAGE_FULL") {
      task.status = "failed";
      task.error = "Armazenamento insuficiente para guardar o novo vídeo.";
      await task.save();
      if (task.chargedOperation) await refundOperation(task.userId);
      return;
    }

    // REQ-VID-TRIM-NF12: 1 retry automático interno perante falha de worker
    if (!isRetry && task.retries === 0) {
      console.log(`Retrying trim task ${taskId} (attempt 2)...`);
      task.retries = 1;
      task.progress = 0;
      await task.save();
      // Wait 1.5s before retry
      await new Promise((res) => setTimeout(res, 1500));
      return executeTrim(task, true);
    }

    // Failed after retry or timeout
    task.status = "failed";
    task.error = "Ocorreu um erro ao processar o seu vídeo. Nenhuma operação foi contabilizada.";
    await task.save();
    if (task.chargedOperation) await refundOperation(task.userId);
  } finally {
    activeProcesses.delete(taskId);
    await fs.promises.rm(tempInput, { force: true }).catch(() => {});
    await fs.promises.rm(tempOutput, { force: true }).catch(() => {});
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
        await executeTrim(task);
      }
    } catch (err) {
      console.error(`Error in queue worker for task ${taskId}:`, err);
    }
  }
  isWorkerRunning = false;
}

function enqueueTrimTask(taskId) {
  pendingTasks.push(taskId.toString());
  setImmediate(drainQueue);
}

async function cancelTrimTask(taskId) {
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
    task.error = "Recorte cancelado. Nenhuma operação foi contabilizada.";
    await task.save();
    if (task.chargedOperation) {
      await refundOperation(task.userId);
    }
  }
}

module.exports = {
  enqueueTrimTask,
  cancelTrimTask,
};
