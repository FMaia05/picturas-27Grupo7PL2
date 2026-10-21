// Trim worker (UC-VID-004) with real ffmpeg/ffprobe on generated clips.
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { stubModule, createModel, createS3, waitFor } = require("./helpers/fakes");
const { skipReason, createFixtures, tempEntries } = require("./helpers/ffmpeg");
const { interceptHttps } = require("./helpers/https");

const ROOT = path.join(__dirname, "..");
process.env.USERS_URL = "https://users.test/";
delete process.env.FREE_VIDEO_QUOTA_BYTES;
delete process.env.PREMIUM_VIDEO_QUOTA_BYTES;

const Video = stubModule(path.join(ROOT, "models/video.js"), createModel({ status: "uploading" }));
const VideoTask = stubModule(path.join(ROOT, "models/videoTask.js"), createModel({ status: "queued", progress: 0, retries: 0, refunded: false }));
const s3 = stubModule(path.join(ROOT, "services/s3Client.js"), createS3());
const http = interceptHttps();
const { enqueueTrimTask, cancelTrimTask } = require(path.join(ROOT, "services/videoTrimWorker.js"));

const FINAL = ["completed", "failed", "cancelled"];
const GiB = 1024 ** 3;
let fixtures;

function sourceVideo(overrides = {}) {
  const buffer = fs.readFileSync(fixtures.file("clip.mp4"));
  s3.put("user-u1", "videos/source.mp4", buffer);
  return Video.insert({
    userId: "u1", originalName: "clip.mp4", mimeType: "video/mp4", size: buffer.length, objectKey: "videos/source.mp4",
    status: "ready", metadata: { duration: 10, width: 320, height: 240, videoCodec: "h264", audioCodec: "aac" }, ...overrides,
  });
}

function trimTask(video, overrides = {}) {
  return VideoTask.insert({
    userId: "u1", type: "trim", sourceVideoId: video._id, targetName: "clip-trim.mp4", replaceOriginal: false,
    start: 2, end: 5, duration: 3, status: "queued", progress: 0, retries: 0, chargedOperation: true, userType: "free", ...overrides,
  });
}

async function run(task) {
  enqueueTrimTask(task.id);
  await waitFor(() => FINAL.includes(task.status));
  // The worker removes temporary files in `finally`, right after the last save.
  await waitFor(() => tempEntries(`picturas-trim-in-${task.id}`).length === 0);
}

describe("trim worker", { skip: skipReason }, () => {
  before(() => {
    fixtures = createFixtures();
  });
  after(() => fixtures?.cleanup());
  beforeEach(() => {
    Video.docs.length = 0;
    VideoTask.docs.length = 0;
    s3.objects.clear();
    Object.values(s3.calls).forEach((list) => (list.length = 0));
    http.calls.length = 0;
  });

  test("TST-TRIM-08 lossless trim creates a new library video with the requested segment", async () => {
    const original = sourceVideo();
    const task = trimTask(original);
    await run(task);

    assert.equal(task.status, "completed", task.error);
    assert.equal(task.progress, 100);
    assert.equal(Video.docs.length, 2);
    const created = Video.docs.find((video) => String(video._id) === String(task.resultVideoId));
    assert.equal(created.status, "ready");
    assert.equal(created.originalName, "clip-trim.mp4");
    assert.match(created.objectKey, /^videos\/[0-9a-f-]{36}\.mp4$/);
    // Stream copy cuts on packet boundaries and keeps the H.264 B-frame offset, so the
    // container may be a few hundred ms longer than requested (known limitation L-01).
    assert.ok(created.metadata.duration >= 2.95 && created.metadata.duration <= 3.5, `duration ${created.metadata.duration}`);
    assert.equal(created.metadata.videoCodec, "h264");
    assert.equal(created.metadata.audioCodec, "aac");
    assert.equal(created.size, s3.objects.get(`user-u1/${created.objectKey}`).length);
    assert.ok(s3.objects.has("user-u1/videos/source.mp4"), "original is kept");
    assert.equal(http.refunds().length, 0, "successful operations are not refunded");
    assert.equal(tempEntries(`picturas-trim-out-${task.id}`).length, 0);
  });

  test("TST-TRIM-09 'replace original' updates the existing record and deletes the old object (FA2)", async () => {
    const original = sourceVideo();
    const task = trimTask(original, { replaceOriginal: true, targetName: "short.mp4", start: 0, end: 4, duration: 4 });
    await run(task);

    assert.equal(task.status, "completed", task.error);
    assert.equal(Video.docs.length, 1);
    assert.equal(String(task.resultVideoId), String(original._id));
    assert.equal(original.originalName, "short.mp4");
    assert.notEqual(original.objectKey, "videos/source.mp4");
    assert.ok(original.metadata.duration >= 3.95 && original.metadata.duration <= 4.5, `duration ${original.metadata.duration}`);
    assert.deepEqual(s3.calls.deleted, ["user-u1/videos/source.mp4"]);
  });

  test("TST-TRIM-10 cancelling a running trim stops it and refunds the operation exactly once", async () => {
    const original = sourceVideo();
    const buffer = s3.objects.get("user-u1/videos/source.mp4");
    const getObject = s3.getObject;
    s3.getObject = () => ({
      createReadStream: () => Readable.from((async function* slow() {
        await new Promise((resolve) => setTimeout(resolve, 400));
        yield buffer;
      })()),
    });
    try {
      const task = trimTask(original);
      enqueueTrimTask(task.id);
      await waitFor(() => task.status === "processing");
      await cancelTrimTask(task.id);
      await waitFor(() => tempEntries(`picturas-trim-in-${task.id}`).length === 0 && task.error);
      await new Promise((resolve) => setTimeout(resolve, 600));

      assert.equal(task.status, "cancelled");
      assert.equal(Video.docs.length, 1, "no video is created");
      assert.equal(http.refunds().length, 1);
      assert.equal(http.refunds()[0].url, "https://users.test/u1/process/refund/1");
    } finally {
      s3.getObject = getObject;
    }
  });

  test("TST-TRIM-11 cancelling a queued trim refunds once and never runs ffmpeg", async () => {
    const original = sourceVideo();
    const task = trimTask(original);
    enqueueTrimTask(task.id);
    await cancelTrimTask(task.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(task.status, "cancelled");
    assert.equal(task.progress, 0);
    assert.equal(http.refunds().length, 1);
  });

  test("TST-TRIM-12 a failing worker retries once, then fails, refunds and cleans up (REQ-VID-TRIM-NF12)", async () => {
    const original = sourceVideo();
    s3.objects.clear(); // the source object disappeared from storage
    const task = trimTask(original);
    await run(task);

    assert.equal(task.status, "failed");
    assert.equal(task.retries, 1);
    assert.match(task.error, /Nenhuma operação foi contabilizada/);
    assert.equal(http.refunds().length, 1);
    assert.equal(Video.docs.length, 1);
    assert.equal(tempEntries(`picturas-trim-out-${task.id}`).length, 0);
  });

  test("TST-TRIM-13 the result must fit the storage quota of the user's plan", async () => {
    const free = sourceVideo();
    Video.insert({ userId: "u1", originalName: "big.mp4", mimeType: "video/mp4", size: GiB, objectKey: "videos/big.mp4", status: "ready" });
    const freeTask = trimTask(free);
    await run(freeTask);
    assert.equal(freeTask.status, "failed");
    assert.match(freeTask.error, /Armazenamento insuficiente/);
    assert.equal(s3.calls.uploaded.length, 0);
    assert.equal(http.refunds().length, 1);

    const premiumTask = trimTask(free, { userType: "premium", chargedOperation: false });
    await run(premiumTask);
    assert.equal(premiumTask.status, "completed", premiumTask.error);
    assert.equal(http.refunds().length, 1, "premium operations are never refunded");
  });

  test("TST-TRIM-14 the time limit kills ffmpeg; the task fails with one refund and no leftovers (REQ-VID-TRIM-NF10)", async () => {
    process.env.VIDEO_TASK_TIMEOUT_MS = "1";
    try {
      const original = sourceVideo();
      const task = trimTask(original);
      await run(task);
      assert.equal(task.status, "failed");
      assert.equal(Video.docs.length, 1, "no video is created");
      assert.equal(s3.calls.uploaded.length, 0);
      assert.equal(http.refunds().length, 1);
      assert.equal(tempEntries(`picturas-trim-out-${task.id}`).length, 0);
      // Current behaviour: a timeout counts as a worker failure and is retried once.
      assert.equal(task.retries, 1);
    } finally {
      delete process.env.VIDEO_TASK_TIMEOUT_MS;
    }
  });
});
