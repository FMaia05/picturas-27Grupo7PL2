// Metadata job after upload completion (UC-VID-001): a valid file becomes visible
// in the library, an invalid one is deleted from storage and marked failed.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { stubModule, createModel, createS3, waitFor } = require("./helpers/fakes");

const ROOT = path.join(__dirname, "..");
const Video = stubModule(path.join(ROOT, "models/video.js"), createModel({ status: "uploading" }));
const s3 = stubModule(path.join(ROOT, "services/s3Client.js"), createS3());
const inspected = [];
let nextResult;
stubModule(path.join(ROOT, "services/videoMetadata.js"), async (bucket, key, extension) => {
  inspected.push({ bucket, key, extension });
  if (nextResult instanceof Error) throw nextResult;
  return nextResult;
});
const enqueueVideo = require(path.join(ROOT, "services/videoWorker.js"));

function processingVideo(name = "Clip.MP4") {
  return Video.insert({
    userId: "u1", originalName: name, mimeType: "video/mp4", size: 100, objectKey: "videos/k.mp4", uploadId: "up-1", status: "processing",
  });
}

beforeEach(() => {
  Video.docs.length = 0;
  inspected.length = 0;
  s3.calls.deleted.length = 0;
});

test("TST-UPLOAD-11 persists duration, resolution, codecs, FPS and rotation of a valid upload", async () => {
  nextResult = { duration: 12.5, width: 1920, height: 1080, videoCodec: "h264", audioCodec: "aac", fps: 30, rotation: 90 };
  const video = processingVideo();
  enqueueVideo(video._id);
  await waitFor(() => video.status !== "processing");

  assert.equal(video.status, "ready");
  assert.deepEqual(video.metadata, nextResult);
  assert.equal(video.uploadId, undefined);
  assert.deepEqual(inspected, [{ bucket: "user-u1", key: "videos/k.mp4", extension: ".mp4" }]);
  assert.deepEqual(s3.calls.deleted, []);
});

test("TST-UPLOAD-12 deletes the stored object and hides the video when inspection fails", async () => {
  nextResult = new Error("Unsupported video or audio codec");
  const video = processingVideo();
  enqueueVideo(video._id);
  await waitFor(() => video.status !== "processing");

  assert.equal(video.status, "failed");
  assert.match(video.error, /corrupt or has an invalid video format/);
  assert.deepEqual(s3.calls.deleted, ["user-u1/videos/k.mp4"]);
});

test("TST-UPLOAD-13 processes queued uploads one at a time in order", async () => {
  nextResult = { duration: 1, width: 1, height: 1, videoCodec: "h264", audioCodec: "none", fps: 1, rotation: 0 };
  const videos = [processingVideo("a.mp4"), processingVideo("b.mov"), processingVideo("c.webm")];
  videos.forEach((video) => enqueueVideo(video._id));
  await waitFor(() => videos.every((video) => video.status === "ready"));
  assert.deepEqual(inspected.map((entry) => entry.extension), [".mp4", ".mov", ".webm"]);
});
