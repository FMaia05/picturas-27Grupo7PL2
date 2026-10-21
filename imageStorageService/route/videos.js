const crypto = require("crypto");
const express = require("express");
const path = require("path");
const Video = require("../models/video");
const VideoTask = require("../models/videoTask");
const internalAuth = require("../middleware/internalAuth");
const conversionVisibility = require("../services/videoConversionAccess");
const createBucket = require("../services/createBucket");
const { getPublicObjectUrl } = require("../services/getPresignedUrl");
const s3 = require("../services/s3Client");
const enqueueVideo = require("../services/videoWorker");
const { enqueueTrimTask, cancelTrimTask } = require("../services/videoTrimWorker");
const { enqueueExtractFramesTask, cancelExtractFramesTask } = require("../services/videoFrameExtractionWorker");

const router = express.Router();
const PART_SIZE = 8 * 1024 * 1024;
const SUPPORTED = {
  ".mp4": ["video/mp4"],
  ".mov": ["video/quicktime"],
  ".webm": ["video/webm"],
};

router.use(internalAuth);

function ownerFilter(req) {
  return { _id: req.params.videoId, userId: req.params.userId, ...conversionVisibility(req) };
}

router.post("/:userId/uploads", async (req, res) => {
  const { name, size, mimeType, userType } = req.body;
  const extension = path.extname(name || "").toLowerCase();
  const limit = userType === "premium" ? 2000 * 1024 * 1024 : 200 * 1024 * 1024;
  const quota = userType === "premium"
    ? Number(process.env.PREMIUM_VIDEO_QUOTA_BYTES || 20 * 1024 ** 3)
    : Number(process.env.FREE_VIDEO_QUOTA_BYTES || 1024 ** 3);

  if (!SUPPORTED[extension]?.includes(mimeType) || !Number.isSafeInteger(size) || size <= 0 || size > limit) {
    return res.status(400).json({ error: "Unsupported file or file exceeds your plan's size limit." });
  }

  let multipart;
  let bucket;
  let objectKey;
  try {
    const usage = await Video.aggregate([
      { $match: { userId: req.params.userId, status: { $in: ["uploading", "processing", "ready"] } } },
      { $group: { _id: null, total: { $sum: "$size" } } },
    ]);
    if ((usage[0]?.total || 0) + size > quota) {
      return res.status(413).json({ error: "Cloud storage is full. Delete old files or upgrade to Premium." });
    }

    bucket = `user-${req.params.userId}`;
    await createBucket(bucket);
    objectKey = `videos/${crypto.randomUUID()}${extension}`;
    multipart = await s3.createMultipartUpload({
      Bucket: bucket,
      Key: objectKey,
      ContentType: mimeType,
      Metadata: { originalName: encodeURIComponent(name) },
    }).promise();
    const video = await Video.create({
      userId: req.params.userId,
      originalName: name,
      mimeType,
      size,
      objectKey,
      uploadId: multipart.UploadId,
    });
    return res.status(201).json({ videoId: video.id, uploadId: multipart.UploadId, partSize: PART_SIZE });
  } catch (error) {
    if (multipart?.UploadId && bucket && objectKey) {
      await s3.abortMultipartUpload({
        Bucket: bucket,
        Key: objectKey,
        UploadId: multipart.UploadId,
      }).promise().catch(() => {});
    }
    console.error("Unable to start video upload", error);
    return res.status(500).json({ error: "Unable to start video upload." });
  }
});

router.put(
  "/:userId/uploads/:videoId/parts/:partNumber",
  express.raw({ type: "application/octet-stream", limit: "9mb" }),
  async (req, res) => {
    try {
      const video = await Video.findOne(ownerFilter(req));
      if (!video || video.status !== "uploading" || video.uploadId !== req.query.uploadId) {
        return res.status(404).json({ error: "Upload session not found." });
      }
      const data = await s3.uploadPart({
        Bucket: `user-${video.userId}`,
        Key: video.objectKey,
        UploadId: video.uploadId,
        PartNumber: Number(req.params.partNumber),
        Body: req.body,
      }).promise();
      return res.json({ etag: data.ETag, partNumber: Number(req.params.partNumber) });
    } catch (error) {
      console.error("Unable to upload video part", error);
      return res.status(500).json({ error: "Unable to upload video part." });
    }
  },
);

router.post("/:userId/uploads/:videoId/complete", async (req, res) => {
  try {
    const video = await Video.findOne(ownerFilter(req));
    if (!video || video.status !== "uploading" || video.uploadId !== req.body.uploadId) {
      return res.status(404).json({ error: "Upload session not found." });
    }
    const parts = (req.body.parts || []).sort((a, b) => a.PartNumber - b.PartNumber);
    if (!parts.length) return res.status(400).json({ error: "No uploaded parts supplied." });
    await s3.completeMultipartUpload({
      Bucket: `user-${video.userId}`,
      Key: video.objectKey,
      UploadId: video.uploadId,
      MultipartUpload: { Parts: parts },
    }).promise();
    const stored = await s3.headObject({ Bucket: `user-${video.userId}`, Key: video.objectKey }).promise();
    if (stored.ContentLength !== video.size) {
      await s3.deleteObject({ Bucket: `user-${video.userId}`, Key: video.objectKey }).promise().catch(() => {});
      video.status = "failed";
      video.error = "The uploaded file did not pass the integrity check.";
      video.uploadId = undefined;
      await video.save();
      return res.status(422).json({ error: video.error });
    }
    video.status = "processing";
    await video.save();
    enqueueVideo(video.id);
    return res.status(202).json(video);
  } catch (error) {
    console.error("Unable to complete video upload", error);
    return res.status(500).json({ error: "Unable to complete video upload." });
  }
});

router.delete("/:userId/uploads/:videoId", async (req, res) => {
  try {
    const video = await Video.findOne(ownerFilter(req));
    if (!video) return res.sendStatus(204);
    if (video.status === "uploading" && video.uploadId) {
      await s3.abortMultipartUpload({
        Bucket: `user-${video.userId}`,
        Key: video.objectKey,
        UploadId: video.uploadId,
      }).promise().catch(() => {});
    } else if (video.status !== "failed") {
      await s3.deleteObject({ Bucket: `user-${video.userId}`, Key: video.objectKey }).promise().catch(() => {});
    }
    await video.deleteOne();
    return res.sendStatus(204);
  } catch (error) {
    return res.status(500).json({ error: "Unable to cancel video upload." });
  }
});

// Task endpoints MUST be declared before /:userId/:videoId to avoid route conflicts
router.get("/:userId/tasks", async (req, res) => {
  try {
    const tasks = await VideoTask.find({
      userId: req.params.userId,
      status: { $in: ["queued", "processing"] },
    })
      .sort({ createdAt: -1 })
      .lean();
    return res.json(tasks);
  } catch (error) {
    return res.status(500).json({ error: "Unable to list video tasks." });
  }
});

router.get("/:userId/tasks/:taskId", async (req, res) => {
  try {
    const task = await VideoTask.findOne({
      _id: req.params.taskId,
      userId: req.params.userId,
    }).lean();
    if (!task) return res.status(404).json({ error: "Task not found." });
    return res.json(task);
  } catch (error) {
    return res.status(500).json({ error: "Unable to retrieve video task." });
  }
});

router.post("/:userId/tasks/:taskId/cancel", async (req, res) => {
  try {
    const task = await VideoTask.findOne({
      _id: req.params.taskId,
      userId: req.params.userId,
    });
    if (!task) return res.status(404).json({ error: "Task not found." });
    if (task.type === "extract_frames") {
      await cancelExtractFramesTask(task.id);
      return res.json({ message: "Extração cancelada. Nenhuma operação foi contabilizada." });
    } else {
      await cancelTrimTask(task.id);
      return res.json({ message: "Recorte cancelado. Nenhuma operação foi contabilizada." });
    }
  } catch (error) {
    return res.status(500).json({ error: "Unable to cancel video task." });
  }
});

router.get("/:userId", async (req, res) => {
  const videos = await Video.find({ userId: req.params.userId, status: "ready", ...conversionVisibility(req) }).sort({ createdAt: -1 }).lean();
  const result = await Promise.all(videos.map(async (video) => ({
    ...video,
    url: video.conversionTaskId
      ? await require("../services/videoConversionDownload")(video)
      : await getPublicObjectUrl(video.userId, video.objectKey),
  })));
  return res.json(result);
});

router.get("/:userId/:videoId", async (req, res) => {
  const video = await Video.findOne(ownerFilter(req)).lean();
  if (!video) return res.status(404).json({ error: "Video not found." });
  return res.json(video);
});

router.delete("/:userId/:videoId", async (req, res) => {
  const video = await Video.findOne(ownerFilter(req));
  if (!video) return res.sendStatus(204);
  await s3.deleteObject({ Bucket: `user-${video.userId}`, Key: video.objectKey }).promise().catch(() => {});
  await video.deleteOne();
  return res.sendStatus(204);
});

// Trim endpoints (UC-VID-004)
router.post("/:userId/:videoId/trim", async (req, res) => {
  try {
    const { start, end, targetName, replaceOriginal, userType } = req.body;
    const video = await Video.findOne(ownerFilter(req));
    if (!video || video.status !== "ready") {
      return res.status(404).json({ error: "Video not found." });
    }

    // RN2: Formatos de vídeo suportados: MP4 (H.264) e MOV
    const ext = path.extname(video.originalName || "").toLowerCase();
    const supportedExts = [".mp4", ".mov"];
    if (!supportedExts.includes(ext) || video.metadata?.videoCodec !== "h264") {
      return res.status(400).json({
        error: "Não é possível editar este ficheiro. Certifique-se que é um formato de vídeo válido (MP4 ou MOV).",
      });
    }

    // RN2, REQ-VID-TRIM-NF04: Tamanho máximo do ficheiro de origem suportado
    const maxOriginSize = userType === "premium" ? 2000 * 1024 * 1024 : 200 * 1024 * 1024;
    if (video.size > maxOriginSize) {
      return res.status(400).json({ error: "O tamanho do vídeo original excede o limite do plano." });
    }

    // RN4, REQ-VID-TRIM-NF02: Timestamps flutuantes, start < end, end <= duration
    const numStart = Number(start);
    const numEnd = Number(end);
    const totalDuration = video.metadata?.duration || 0;
    if (
      !Number.isFinite(numStart) ||
      !Number.isFinite(numEnd) ||
      numStart < 0 ||
      numStart >= numEnd ||
      (totalDuration > 0 && numEnd > totalDuration + 0.05)
    ) {
      return res.status(400).json({ error: "Inconsistência nos timestamps de recorte." });
    }

    // RN3, REQ-VID-TRIM-NF03: Duração do fragmento a recortar
    const trimDuration = numEnd - numStart;
    const maxTrimDuration = userType === "premium" ? 3600 : 300;
    if (trimDuration > maxTrimDuration) {
      return res.status(400).json({ error: "Duração do vídeo recortado excede limites do perfil." });
    }

    // RN8, REQ-VID-TRIM-NF05: Limite de tarefas de vídeo concorrentes ativas
    const activeTasks = await VideoTask.countDocuments({
      userId: req.params.userId,
      status: { $in: ["queued", "processing"] },
    });
    const maxConcurrent = userType === "premium" ? 3 : 1;
    if (activeTasks >= maxConcurrent) {
      return res.status(429).json({ error: "Limite de tarefas de vídeo concorrentes ativas atingido." });
    }

    const defaultName = `${path.basename(video.originalName, ext)}-trim${ext}`;
    const finalTargetName = (targetName || defaultName).trim();

    const task = await VideoTask.create({
      userId: req.params.userId,
      type: "trim",
      sourceVideoId: video._id,
      targetName: finalTargetName,
      replaceOriginal: Boolean(replaceOriginal),
      start: numStart,
      end: numEnd,
      duration: trimDuration,
      status: "queued",
      chargedOperation: userType !== "premium",
    });

    enqueueTrimTask(task.id);
    return res.status(201).json({ taskId: task.id, status: "queued" });
  } catch (error) {
    console.error("Unable to create trim task", error);
    return res.status(500).json({ error: "Unable to create trim task." });
  }
});

// Frame extraction endpoints (UC-VID-003)
router.post("/:userId/:videoId/extract-frames", async (req, res) => {
  try {
    const {
      start,
      end,
      step,
      format,
      destinationType,
      targetName,
      destinationProjectId,
      userType,
    } = req.body;

    const video = await Video.findOne(ownerFilter(req));
    if (!video || video.status !== "ready") {
      return res.status(404).json({ error: "Video not found." });
    }

    // RN2, REQ-VID-FRAME-015: Formatos aceites: MP4 (H.264) e MOV
    const ext = path.extname(video.originalName || "").toLowerCase();
    const supportedExts = [".mp4", ".mov"];
    if (!supportedExts.includes(ext) || video.metadata?.videoCodec !== "h264") {
      return res.status(400).json({
        error: "Formato de vídeo não suportado. Formatos aceites: MP4 (H.264) e MOV.",
      });
    }

    // RN2, REQ-VID-FRAME-016: Tamanho máximo do ficheiro de origem
    const maxOriginSize = userType === "premium" ? 2000 * 1024 * 1024 : 200 * 1024 * 1024;
    if (video.size > maxOriginSize) {
      return res.status(400).json({
        error: `O tamanho do vídeo original excede o limite do plano (${userType === "premium" ? "2 GB" : "200 MB"}).`,
      });
    }

    // RN2, REQ-VID-FRAME-016: Resolução máxima do vídeo (1080p Registado / 4K Premium)
    const maxPixels = userType === "premium" ? 3840 * 2160 : 1920 * 1080;
    const vidPixels = (video.metadata?.width || 0) * (video.metadata?.height || 0);
    if (vidPixels > maxPixels) {
      return res.status(400).json({
        error: `A resolução do vídeo (${video.metadata?.width}x${video.metadata?.height}) excede o limite do perfil (${userType === "premium" ? "3840x2160" : "1920x1080"}).`,
      });
    }

    // RN3, REQ-VID-FRAME-005, 016: Intervalo válido e duração
    const numStart = Number(start);
    const numEnd = Number(end);
    const totalDuration = video.metadata?.duration || 0;
    if (
      !Number.isFinite(numStart) ||
      !Number.isFinite(numEnd) ||
      numStart < 0 ||
      numStart >= numEnd ||
      (totalDuration > 0 && numEnd > totalDuration + 0.05)
    ) {
      return res.status(400).json({
        error: "Intervalo inválido: o instante de início tem de ser anterior ao de fim e o de fim não pode exceder a duração do vídeo.",
      });
    }

    const intervalDuration = numEnd - numStart;
    const maxIntervalDuration = userType === "premium" ? 1800 : 120;
    if (intervalDuration > maxIntervalDuration) {
      return res.status(400).json({
        error: `A duração do intervalo selecionado (${intervalDuration.toFixed(1)} s) não pode exceder ${maxIntervalDuration} s.`,
      });
    }

    // RN4, REQ-VID-FRAME-005: Passo de amostragem inteiro entre 1 e 60 s
    const numStep = Number(step);
    if (!Number.isInteger(numStep) || numStep < 1 || numStep > 60) {
      return res.status(400).json({
        error: "O passo de amostragem tem de ser um número inteiro de segundos entre 1 e 60.",
      });
    }

    // RN5, REQ-VID-FRAME-016: Número máximo de fotogramas por extração (30 Registado, 200 Premium)
    const totalFrames = Math.floor(intervalDuration / numStep) + 1;
    const maxFrames = userType === "premium" ? 200 : 30;
    if (totalFrames > maxFrames) {
      const minStep = Math.ceil(intervalDuration / (maxFrames - 1));
      return res.status(400).json({
        error: `O número estimado de fotogramas (${totalFrames}) excede o limite do seu perfil (${maxFrames}). Sugestão: utilize um passo de pelo menos ${minStep} s.`,
      });
    }

    // RN7, REQ-VID-FRAME-035: Formato de saída (PNG ou JPEG)
    const outputFormat = (format || "png").toLowerCase();
    if (!["png", "jpeg"].includes(outputFormat)) {
      return res.status(400).json({
        error: "Formato de saída não suportado. Formatos aceites: PNG e JPEG.",
      });
    }

    // RN9, REQ-VID-FRAME-021: Limite de tarefas de extração ativas por utilizador (1 Registado, 3 Premium)
    const activeTasks = await VideoTask.countDocuments({
      userId: req.params.userId,
      type: "extract_frames",
      status: { $in: ["queued", "processing"] },
    });
    const maxConcurrent = userType === "premium" ? 3 : 1;
    if (activeTasks >= maxConcurrent) {
      return res.status(429).json({
        error: "Já existe uma tarefa de extração em curso no limite do seu perfil.",
      });
    }

    // FA2, REQ-VID-FRAME-005: Destino
    const destType = destinationType === "existing" ? "existing" : "new";
    if (destType === "existing" && !destinationProjectId) {
      return res.status(400).json({
        error: "Identificador do projeto existente de destino não fornecido.",
      });
    }

    const defaultProjectName = `${path.basename(video.originalName, ext)} - Fotogramas`;
    const finalProjectName = (targetName || defaultProjectName).trim();

    const task = await VideoTask.create({
      userId: req.params.userId,
      type: "extract_frames",
      sourceVideoId: video._id,
      targetName: finalProjectName,
      start: numStart,
      end: numEnd,
      duration: intervalDuration,
      step: numStep,
      format: outputFormat,
      destinationType: destType,
      destinationProjectId: destinationProjectId || null,
      totalFramesCount: totalFrames,
      extractedFramesCount: 0,
      status: "queued",
      chargedOperation: userType !== "premium",
    });

    enqueueExtractFramesTask(task.id);
    return res.status(201).json({ taskId: task.id, status: "queued" });
  } catch (error) {
    console.error("Unable to create extract frames task", error);
    return res.status(500).json({ error: "Unable to create extract frames task." });
  }
});

module.exports = router;
