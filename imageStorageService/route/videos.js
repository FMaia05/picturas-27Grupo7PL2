const crypto = require("crypto");
const express = require("express");
const path = require("path");
const Video = require("../models/video");
const internalAuth = require("../middleware/internalAuth");
const createBucket = require("../services/createBucket");
const { getPublicObjectUrl } = require("../services/getPresignedUrl");
const s3 = require("../services/s3Client");
const enqueueVideo = require("../services/videoWorker");

const router = express.Router();
const PART_SIZE = 8 * 1024 * 1024;
const SUPPORTED = {
  ".mp4": ["video/mp4"],
  ".mov": ["video/quicktime"],
  ".webm": ["video/webm"],
};

router.use(internalAuth);

function ownerFilter(req) {
  return { _id: req.params.videoId, userId: req.params.userId };
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

router.get("/:userId", async (req, res) => {
  const videos = await Video.find({ userId: req.params.userId, status: "ready" }).sort({ createdAt: -1 }).lean();
  const result = await Promise.all(videos.map(async (video) => ({
    ...video,
    url: await getPublicObjectUrl(video.userId, video.objectKey),
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

module.exports = router;
