// Frame extraction worker (UC-VID-003) with real ffmpeg on a generated clip.
// The projects service is replaced by a mocked axios.post.
const { test, describe, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const axios = require("axios");
const { stubModule, createModel, createS3, waitFor } = require("./helpers/fakes");
const { skipReason, createFixtures, tempEntries, pngSize } = require("./helpers/ffmpeg");
const { interceptHttps } = require("./helpers/https");

const ROOT = path.join(__dirname, "..");
process.env.USERS_URL = "https://users.test/";
process.env.PROJECTS_URL = "https://projects.test/";
process.env.INTERNAL_SERVICE_TOKEN = "test-internal-token";

const Video = stubModule(path.join(ROOT, "models/video.js"), createModel({ status: "uploading" }));
const VideoTask = stubModule(path.join(ROOT, "models/videoTask.js"), createModel({ status: "queued", progress: 0, retries: 0, refunded: false }));
const s3 = stubModule(path.join(ROOT, "services/s3Client.js"), createS3());
const http = interceptHttps((url) => (url.includes("projects.test") ? { status: 500, body: "down" } : { status: 200 }));
const projectCalls = [];
let projectsAvailable = true;
mock.method(axios, "post", async (url, payload, config) => {
  projectCalls.push({ url, payload, headers: config.headers });
  if (!projectsAvailable) throw new Error("connect ECONNREFUSED projects");
  return { data: { _id: payload._id || url.split("/").at(-2) } };
});
const { enqueueExtractFramesTask, cancelExtractFramesTask } = require(path.join(ROOT, "services/videoFrameExtractionWorker.js"));

const FINAL = ["completed", "failed", "cancelled"];
let fixtures;

function sourceVideo(fixture = "clip.mp4") {
  const buffer = fs.readFileSync(fixtures.file(fixture));
  s3.put("user-u1", "videos/source.mp4", buffer);
  return Video.insert({
    userId: "u1", originalName: "clip.mp4", mimeType: "video/mp4", size: buffer.length, objectKey: "videos/source.mp4",
    status: "ready", metadata: { duration: 10, width: 320, height: 240, videoCodec: "h264" },
  });
}

function extractTask(video, overrides = {}) {
  return VideoTask.insert({
    userId: "u1", type: "extract_frames", sourceVideoId: video._id, targetName: "clip - Fotogramas", start: 0, end: 4,
    duration: 4, step: 2, format: "png", destinationType: "new", destinationProjectId: null, totalFramesCount: 3,
    extractedFramesCount: 0, status: "queued", progress: 0, retries: 0, chargedOperation: true, userType: "free", ...overrides,
  });
}

async function run(task) {
  enqueueExtractFramesTask(task.id);
  await waitFor(() => FINAL.includes(task.status));
  await waitFor(() => tempEntries(`picturas-extract-frames-${task.id}`).length === 0);
}

const frameKeys = () => [...s3.objects.keys()].filter((key) => !key.endsWith("videos/source.mp4"));

describe("frame extraction worker", { skip: skipReason }, () => {
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
    projectCalls.length = 0;
    projectsAvailable = true;
    delete process.env.VIDEO_TASK_TIMEOUT_MS;
  });

  test("TST-FRAME-10 extracts frames at t_k = start + k*step into a new project (REQ-VID-FRAME-032/040)", async () => {
    const task = extractTask(sourceVideo());
    await run(task);

    assert.equal(task.status, "completed", task.error);
    assert.equal(task.extractedFramesCount, 3);
    assert.equal(task.totalFramesCount, 3);
    assert.equal(projectCalls.length, 1);
    const [call] = projectCalls;
    assert.equal(call.url, "https://projects.test/internal/u1/create-with-frames");
    assert.equal(call.headers["x-internal-service-token"], "test-internal-token");
    assert.equal(call.payload.name, "clip - Fotogramas");
    assert.equal(task.resultProjectId, call.payload._id);
    assert.deepEqual(
      call.payload.imgs.map((img) => path.basename(img.og_uri)),
      ["clip_00-00-00-000.png", "clip_00-00-02-000.png", "clip_00-00-04-000.png"],
    );
    assert.equal(frameKeys().length, 3);
    for (const key of frameKeys()) {
      assert.match(key, new RegExp(`^user-u1/${call.payload._id}/src/[0-9a-f-]{36}\\.png$`));
      assert.deepEqual([...s3.objects.get(key).subarray(1, 4)].map((byte) => String.fromCharCode(byte)).join(""), "PNG");
    }
    assert.ok(call.payload.imgs.every((img) => /^[0-9a-f]{64}$/.test(img.og_sha256)));
    assert.equal(http.refunds().length, 0);
    assert.equal(tempEntries(`picturas-extract-in-${task.id}`).length, 0);
  });

  test("TST-FRAME-11 appends JPEG frames with millisecond names to an existing project (FA2)", async () => {
    const task = extractTask(sourceVideo(), {
      start: 1.5, end: 3.5, step: 1, format: "jpeg", destinationType: "existing", destinationProjectId: "project-7",
    });
    await run(task);

    assert.equal(task.status, "completed", task.error);
    assert.equal(projectCalls[0].url, "https://projects.test/internal/u1/project-7/append-frames");
    assert.deepEqual(
      projectCalls[0].payload.imgs.map((img) => path.basename(img.og_uri)),
      ["clip_00-00-01-500.jpg", "clip_00-00-02-500.jpg", "clip_00-00-03-500.jpg"],
    );
    assert.ok(s3.calls.uploaded.every((upload) => upload.contentType === "image/jpeg"));
    assert.ok(frameKeys().every((key) => key.startsWith("user-u1/project-7/src/")));
    assert.equal(task.resultProjectId, "project-7");
  });

  test("TST-FRAME-12 a projects failure retries once, removes uploaded frames and refunds once (REQ-VID-FRAME-046/050)", async () => {
    projectsAvailable = false;
    const task = extractTask(sourceVideo());
    await run(task);

    assert.equal(task.status, "failed");
    assert.equal(task.retries, 1);
    assert.equal(projectCalls.length, 2, "one attempt plus one automatic retry");
    assert.deepEqual(frameKeys(), [], "uploaded frames are deleted");
    assert.equal(s3.calls.deleted.length, 6);
    assert.equal(http.refunds().length, 1);
  });

  test("TST-FRAME-13 cancelling a running extraction refunds exactly once and creates no project", async () => {
    const video = sourceVideo();
    const buffer = s3.objects.get("user-u1/videos/source.mp4");
    const getObject = s3.getObject;
    s3.getObject = () => ({
      createReadStream: () => Readable.from((async function* slow() {
        await new Promise((resolve) => setTimeout(resolve, 400));
        yield buffer;
      })()),
    });
    try {
      const task = extractTask(video);
      enqueueExtractFramesTask(task.id);
      await waitFor(() => task.status === "processing");
      await cancelExtractFramesTask(task.id);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await waitFor(() => tempEntries(`picturas-extract-frames-${task.id}`).length === 0);

      assert.equal(task.status, "cancelled");
      assert.equal(projectCalls.length, 0);
      assert.deepEqual(frameKeys(), []);
      assert.equal(http.refunds().length, 1);
    } finally {
      s3.getObject = getObject;
    }
  });

  test("TST-FRAME-14 frames must fit the storage quota of the user's plan (REQ-VID-FRAME-051)", async () => {
    const video = sourceVideo();
    Video.insert({ userId: "u1", originalName: "big.mp4", mimeType: "video/mp4", size: 1024 ** 3, objectKey: "k", status: "ready" });
    const freeTask = extractTask(video);
    await run(freeTask);
    assert.equal(freeTask.status, "failed");
    assert.match(freeTask.error, /Armazenamento insuficiente/);
    assert.equal(projectCalls.length, 0);

    const premiumTask = extractTask(video, { userType: "premium", chargedOperation: false });
    await run(premiumTask);
    assert.equal(premiumTask.status, "completed", premiumTask.error);
  });

  test("TST-FRAME-15 the time limit stops the extraction: no project, no frames left, one refund (REQ-VID-FRAME-052)", async () => {
    // The limit expires while the first frame is being uploaded, outside ffmpeg.
    process.env.VIDEO_TASK_TIMEOUT_MS = "2500";
    const upload = s3.upload;
    let firstUpload = true;
    s3.upload = (params) => ({
      promise: async () => {
        if (firstUpload) {
          firstUpload = false;
          await new Promise((resolve) => setTimeout(resolve, 4000));
        }
        return upload.call(s3, params).promise();
      },
    });
    try {
      const task = extractTask(sourceVideo());
      await run(task);
      assert.equal(task.status, "failed");
      assert.match(task.error, /demorou mais do que o permitido/);
      // Give a background continuation time to show up before checking side effects.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      assert.equal(task.status, "failed", "the task must stay failed");
      assert.equal(task.retries, 0, "a timeout is not retried");
      assert.equal(projectCalls.length, 0, "no project is created after the time limit");
      assert.deepEqual(frameKeys(), [], "no frame is left in storage");
      assert.equal(http.refunds().length, 1);
    } finally {
      s3.upload = upload;
    }
  });

  test("TST-FRAME-16 frames of a rotated (portrait) recording are extracted upright", async () => {
    const task = extractTask(sourceVideo("rotated.mp4"), { start: 1, end: 1, step: 1, totalFramesCount: 1 });
    await run(task);
    assert.equal(task.status, "completed", task.error);
    const [key] = frameKeys();
    assert.deepEqual(pngSize(s3.objects.get(key)), { width: 240, height: 320 });
  });
});
