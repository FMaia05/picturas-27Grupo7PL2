const path = require("path");
const Video = require("../models/video");
const s3 = require("./s3Client");
const inspectVideo = require("./videoMetadata");

const pending = [];
let running = false;

async function processVideo(videoId) {
  const video = await Video.findById(videoId);
  if (!video || video.status !== "processing") return;

  const bucket = `user-${video.userId}`;
  try {
    const metadata = await inspectVideo(bucket, video.objectKey, path.extname(video.originalName).toLowerCase());
    video.metadata = metadata;
    video.status = "ready";
    video.uploadId = undefined;
    await video.save();
  } catch (error) {
    await s3.deleteObject({ Bucket: bucket, Key: video.objectKey }).promise().catch(() => {});
    video.status = "failed";
    video.error = "The uploaded file is corrupt or has an invalid video format.";
    video.uploadId = undefined;
    await video.save();
    console.error("Video metadata extraction failed", videoId, error.message);
  }
}

async function drain() {
  if (running) return;
  running = true;
  while (pending.length) await processVideo(pending.shift());
  running = false;
}

function enqueueVideo(videoId) {
  pending.push(videoId.toString());
  setImmediate(drain);
}

module.exports = enqueueVideo;
