// Server-side validation of the video API (UC-VID-001 upload and library,
// UC-VID-003 frame extraction, UC-VID-004 trim). MongoDB, S3 and the workers are
// replaced by in-memory fakes; the Express router is the production module.
const { test, describe, beforeEach, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { stubModule, createModel, createS3 } = require("./helpers/fakes");
const { startServer, request } = require("./helpers/server");

const ROOT = path.join(__dirname, "..");
const TOKEN = "test-internal-token";
process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
delete process.env.FREE_VIDEO_QUOTA_BYTES;
delete process.env.PREMIUM_VIDEO_QUOTA_BYTES;

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const Video = stubModule(path.join(ROOT, "models/video.js"), createModel({ status: "uploading" }));
const VideoTask = stubModule(path.join(ROOT, "models/videoTask.js"), createModel({ status: "queued", progress: 0, retries: 0, refunded: false }));
const s3 = stubModule(path.join(ROOT, "services/s3Client.js"), createS3());
const enqueued = { metadata: [], trim: [], frames: [], cancelledTrim: [], cancelledFrames: [] };
stubModule(path.join(ROOT, "services/createBucket.js"), async () => {});
stubModule(path.join(ROOT, "services/getPresignedUrl.js"), {
  getPublicObjectUrl: async (userId, key) => `https://storage.test/user-${userId}/${key}`,
});
stubModule(path.join(ROOT, "services/videoWorker.js"), (id) => enqueued.metadata.push(String(id)));
stubModule(path.join(ROOT, "services/videoTrimWorker.js"), {
  enqueueTrimTask: (id) => enqueued.trim.push(String(id)),
  cancelTrimTask: async (id) => enqueued.cancelledTrim.push(String(id)),
});
stubModule(path.join(ROOT, "services/videoFrameExtractionWorker.js"), {
  enqueueExtractFramesTask: (id) => enqueued.frames.push(String(id)),
  cancelExtractFramesTask: async (id) => enqueued.cancelledFrames.push(String(id)),
});
const router = require(path.join(ROOT, "route/videos.js"));

let server;
const auth = { "x-internal-service-token": TOKEN };
const call = (method, url, options = {}) =>
  request(server.baseUrl, method, url, { ...options, headers: { ...auth, ...(options.headers || {}) } });

function readyVideo(overrides = {}) {
  const { metadata, ...rest } = overrides;
  return Video.insert({
    userId: "u1",
    originalName: "clip.mp4",
    mimeType: "video/mp4",
    size: 10 * MiB,
    objectKey: "videos/source.mp4",
    status: "ready",
    ...rest,
    metadata: { duration: 600, width: 1920, height: 1080, videoCodec: "h264", audioCodec: "aac", fps: 25, rotation: 0, ...metadata },
  });
}

function activeTask(overrides = {}) {
  return VideoTask.insert({ userId: "u1", type: "trim", status: "processing", ...overrides });
}

before(async () => {
  server = await startServer("/videos", router);
});
after(() => server.close());
beforeEach(() => {
  Video.docs.length = 0;
  VideoTask.docs.length = 0;
  Object.values(s3.calls).forEach((list) => (list.length = 0));
  Object.values(enqueued).forEach((list) => (list.length = 0));
  s3.headSize = null;
});

describe("internal authentication", () => {
  test("TST-SEC-01 rejects calls without the internal service token", async () => {
    const missing = await request(server.baseUrl, "GET", "/u1");
    const wrong = await request(server.baseUrl, "GET", "/u1", { headers: { "x-internal-service-token": "nope" } });
    assert.equal(missing.status, 403);
    assert.equal(wrong.status, 403);
  });
});

describe("malformed identifiers", () => {
  test("TST-SEC-02 malformed video or task ids return 404 instead of failing", async () => {
    for (const [method, url] of [
      ["GET", "/u1/not-an-id"], ["DELETE", "/u1/not-an-id"], ["POST", "/u1/x/trim"], ["POST", "/u1/x/extract-frames"],
      ["GET", "/u1/tasks/x"], ["POST", "/u1/tasks/x/cancel"], ["PUT", "/u1/uploads/x/parts/1"], ["DELETE", "/u1/uploads/x"],
    ]) {
      const response = await call(method, url, { body: method === "POST" ? {} : undefined });
      assert.equal(response.status, 404, `${method} ${url}`);
    }
  });
});

describe("upload initialisation (UC-VID-001)", () => {
  const init = (body) => call("POST", "/u1/uploads", { body: { userType: "free", size: 5 * MiB, ...body } });

  test("TST-UPLOAD-01 accepts MP4, MOV and WebM with matching MIME types", async () => {
    for (const [name, mimeType] of [["a.mp4", "video/mp4"], ["b.MOV", "video/quicktime"], ["c.webm", "video/webm"]]) {
      const response = await init({ name, mimeType });
      assert.equal(response.status, 201, name);
      assert.equal(response.body.partSize, 8 * MiB);
    }
    assert.equal(Video.docs.length, 3);
    assert.ok(Video.docs.every((video) => video.status === "uploading"));
  });

  test("TST-UPLOAD-02 generates the S3 key on the server and keeps the filename as metadata", async () => {
    const response = await init({ name: "../../etc/passwd.mp4", mimeType: "video/mp4" });
    assert.equal(response.status, 201);
    const [video] = Video.docs;
    assert.match(video.objectKey, /^videos\/[0-9a-f-]{36}\.mp4$/);
    assert.equal(video.originalName, "../../etc/passwd.mp4");
    assert.equal(s3.calls.created[0].Bucket, "user-u1");
  });

  test("TST-UPLOAD-03 rejects unsupported extensions and MIME/extension mismatches", async () => {
    for (const [name, mimeType] of [["a.avi", "video/x-msvideo"], ["a.mp4", "video/webm"], ["a.webm", "video/mp4"], ["a", "video/mp4"]]) {
      const response = await init({ name, mimeType });
      assert.equal(response.status, 400, `${name} ${mimeType}`);
    }
    assert.equal(Video.docs.length, 0);
    assert.equal(s3.calls.created.length, 0);
  });

  test("TST-UPLOAD-04 enforces the per-file limit of each plan (200 MB free, 2000 MB premium)", async () => {
    const body = { name: "a.mp4", mimeType: "video/mp4" };
    assert.equal((await init({ ...body, size: 200 * MiB })).status, 201);
    assert.equal((await init({ ...body, size: 200 * MiB + 1 })).status, 400);
    assert.equal((await init({ ...body, userType: "premium", size: 2000 * MiB })).status, 201);
    assert.equal((await init({ ...body, userType: "premium", size: 2000 * MiB + 1 })).status, 400);
    assert.equal((await init({ ...body, size: 0 })).status, 400);
    assert.equal((await init({ ...body, size: "100" })).status, 400);
  });

  test("TST-UPLOAD-05 rejects uploads that exceed the total storage quota", async () => {
    readyVideo({ size: GiB - 4 * MiB });
    Video.insert({ userId: "u1", originalName: "x.mp4", mimeType: "video/mp4", size: 100 * MiB, objectKey: "k", status: "failed" });
    readyVideo({ userId: "other", size: 5 * GiB });
    assert.equal((await init({ name: "a.mp4", mimeType: "video/mp4", size: 5 * MiB })).status, 413);
    assert.equal((await init({ name: "a.mp4", mimeType: "video/mp4", size: 4 * MiB })).status, 201);
    assert.equal((await init({ name: "a.mp4", mimeType: "video/mp4", size: 5 * MiB, userType: "premium" })).status, 201);
  });
});

describe("multipart transfer (UC-VID-001)", () => {
  function uploading() {
    return Video.insert({
      userId: "u1", originalName: "a.mp4", mimeType: "video/mp4", size: 12, objectKey: "videos/a.mp4", uploadId: "up-1", status: "uploading",
    });
  }

  test("TST-UPLOAD-06 stores a part only for the matching upload session", async () => {
    const video = uploading();
    const wrong = await call("PUT", `/u1/uploads/${video.id}/parts/1?uploadId=other`, { raw: Buffer.from("abc") });
    const otherUser = await call("PUT", `/u2/uploads/${video.id}/parts/1?uploadId=up-1`, { raw: Buffer.from("abc") });
    const ok = await call("PUT", `/u1/uploads/${video.id}/parts/1?uploadId=up-1`, { raw: Buffer.from("abc") });
    assert.equal(wrong.status, 404);
    assert.equal(otherUser.status, 404);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { etag: '"etag-1"', partNumber: 1 });
    assert.equal(s3.calls.parts.length, 1);
    assert.equal(s3.calls.parts[0].Body.toString(), "abc");
  });

  test("TST-UPLOAD-07 rejects completion without parts", async () => {
    const video = uploading();
    const response = await call("POST", `/u1/uploads/${video.id}/complete`, { body: { uploadId: "up-1", parts: [] } });
    assert.equal(response.status, 400);
  });

  test("TST-UPLOAD-08 deletes the object when the stored size differs from the declared size", async () => {
    const video = uploading();
    s3.headSize = 11;
    const response = await call("POST", `/u1/uploads/${video.id}/complete`, {
      body: { uploadId: "up-1", parts: [{ PartNumber: 1, ETag: "x" }] },
    });
    assert.equal(response.status, 422);
    assert.equal(video.status, "failed");
    assert.deepEqual(s3.calls.deleted, ["user-u1/videos/a.mp4"]);
    assert.equal(enqueued.metadata.length, 0);
  });

  test("TST-UPLOAD-09 completes the session, sorts parts and queues metadata inspection", async () => {
    const video = uploading();
    s3.headSize = 12;
    const response = await call("POST", `/u1/uploads/${video.id}/complete`, {
      body: { uploadId: "up-1", parts: [{ PartNumber: 2, ETag: "b" }, { PartNumber: 1, ETag: "a" }] },
    });
    assert.equal(response.status, 202);
    assert.equal(video.status, "processing");
    assert.deepEqual(s3.calls.completed[0].MultipartUpload.Parts.map((part) => part.PartNumber), [1, 2]);
    assert.deepEqual(enqueued.metadata, [video.id]);
  });

  test("TST-UPLOAD-10 cancelling an active upload aborts the S3 multipart session", async () => {
    const video = uploading();
    const response = await call("DELETE", `/u1/uploads/${video.id}`);
    assert.equal(response.status, 204);
    assert.equal(s3.calls.aborted.length, 1);
    assert.equal(s3.calls.aborted[0].UploadId, "up-1");
    assert.equal(Video.docs.length, 0);
  });
});

describe("video library (UC-VID-001)", () => {
  test("TST-LIB-01 lists only the owner's ready videos with a playback URL", async () => {
    readyVideo({ originalName: "mine.mp4" });
    readyVideo({ userId: "u2", originalName: "theirs.mp4" });
    Video.insert({ userId: "u1", originalName: "pending.mp4", mimeType: "video/mp4", size: 1, objectKey: "p", status: "processing" });
    const response = await call("GET", "/u1");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.map((video) => video.originalName), ["mine.mp4"]);
    assert.match(response.body[0].url, /user-u1\/videos\/source\.mp4$/);
  });

  test("TST-LIB-02 deleting a video removes the object and the record, scoped to the owner", async () => {
    const video = readyVideo();
    assert.equal((await call("DELETE", `/u2/${video.id}`)).status, 204);
    assert.equal(Video.docs.length, 1);
    assert.equal((await call("DELETE", `/u1/${video.id}`)).status, 204);
    assert.equal(Video.docs.length, 0);
    assert.deepEqual(s3.calls.deleted, ["user-u1/videos/source.mp4"]);
  });
});

describe("trim request validation (UC-VID-004)", () => {
  const trim = (video, body, userType = "free", user = "u1") =>
    call("POST", `/${user}/${video.id}/trim`, { body: { start: 0, end: 10, userType, ...body } });

  test("TST-TRIM-01 accepts only MP4/MOV sources encoded with H.264", async () => {
    const webm = readyVideo({ originalName: "a.webm", metadata: { videoCodec: "vp9" } });
    const hevc = readyVideo({ originalName: "a.mp4", metadata: { videoCodec: "hevc" } });
    const mov = readyVideo({ originalName: "a.mov" });
    assert.equal((await trim(webm)).status, 400);
    assert.equal((await trim(hevc)).status, 400);
    assert.equal((await trim(mov)).status, 201);
  });

  test("TST-TRIM-02 rejects videos that are not ready or belong to another user", async () => {
    const video = readyVideo();
    const processing = readyVideo({ status: "processing" });
    assert.equal((await trim(video, {}, "free", "u2")).status, 404);
    assert.equal((await trim(processing)).status, 404);
  });

  test("TST-TRIM-03 enforces the source size limit of the plan (REQ-VID-TRIM-NF04)", async () => {
    const large = readyVideo({ size: 200 * MiB + 1 });
    assert.equal((await trim(large)).status, 400);
    assert.equal((await trim(large, {}, "premium")).status, 201);
  });

  test("TST-TRIM-04 validates 0 <= start < end <= duration (REQ-VID-TRIM-NF02)", async () => {
    const video = readyVideo({ metadata: { duration: 60 } });
    for (const body of [{ start: -1 }, { start: 10, end: 10 }, { start: 20, end: 10 }, { end: 60.1 }, { start: "abc" }, { end: null }]) {
      assert.equal((await trim(video, body)).status, 400, JSON.stringify(body));
    }
    VideoTask.docs.length = 0;
    assert.equal((await trim(video, { start: 30.5, end: 60 })).status, 201);
  });

  test("TST-TRIM-05 enforces the segment duration limit (300 s free, 3600 s premium; REQ-VID-TRIM-NF03)", async () => {
    const video = readyVideo({ metadata: { duration: 5000 } });
    assert.equal((await trim(video, { end: 300.5 })).status, 400);
    assert.equal((await trim(video, { end: 300 })).status, 201);
    VideoTask.docs.length = 0;
    assert.equal((await trim(video, { end: 3600 }, "premium")).status, 201);
    assert.equal((await trim(video, { end: 3601 }, "premium")).status, 400);
  });

  test("TST-TRIM-06 limits concurrent active tasks (1 free, 3 premium; REQ-VID-TRIM-NF05)", async () => {
    const video = readyVideo();
    activeTask({ type: "extract_frames", status: "queued" });
    activeTask({ userId: "u2" });
    activeTask({ status: "completed" });
    assert.equal((await trim(video)).status, 429);
    assert.equal((await trim(video, {}, "premium")).status, 201);
    assert.equal((await trim(video, {}, "premium")).status, 201);
    assert.equal((await trim(video, {}, "premium")).status, 429);
  });

  test("TST-TRIM-07 creates a queued task with the default name and charge flag", async () => {
    const video = readyVideo({ originalName: "holiday.mp4" });
    const free = await trim(video, { start: 1.5, end: 4 });
    assert.equal(free.status, 201);
    const task = VideoTask.docs[0];
    assert.equal(task.targetName, "holiday-trim.mp4");
    assert.equal(task.duration, 2.5);
    assert.equal(task.chargedOperation, true);
    assert.equal(task.replaceOriginal, false);
    assert.deepEqual(enqueued.trim, [free.body.taskId]);

    VideoTask.docs.length = 0;
    await trim(video, { targetName: "  short.mp4 ", replaceOriginal: true }, "premium");
    assert.equal(VideoTask.docs[0].targetName, "short.mp4");
    assert.equal(VideoTask.docs[0].replaceOriginal, true);
    assert.equal(VideoTask.docs[0].chargedOperation, false);
  });
});

describe("frame extraction request validation (UC-VID-003)", () => {
  const extract = (video, body, userType = "free", user = "u1") =>
    call("POST", `/${user}/${video.id}/extract-frames`, { body: { start: 0, end: 10, step: 1, format: "png", userType, ...body } });

  test("TST-FRAME-01 accepts only MP4/MOV H.264 sources (REQ-VID-FRAME-015)", async () => {
    const webm = readyVideo({ originalName: "a.webm", metadata: { videoCodec: "vp9" } });
    assert.equal((await extract(webm)).status, 400);
    assert.equal((await extract(readyVideo())).status, 201);
  });

  test("TST-FRAME-02 enforces source size and resolution limits per plan (REQ-VID-FRAME-016)", async () => {
    const big = readyVideo({ size: 200 * MiB + 1 });
    const uhd = readyVideo({ metadata: { width: 3840, height: 2160 } });
    const eightK = readyVideo({ metadata: { width: 7680, height: 4320 } });
    assert.equal((await extract(big)).status, 400);
    assert.equal((await extract(uhd)).status, 400);
    assert.equal((await extract(eightK, {}, "premium")).status, 400);
    assert.equal((await extract(uhd, {}, "premium")).status, 201);
    assert.equal((await extract(big, {}, "premium")).status, 201);
  });

  test("TST-FRAME-03 validates the interval and its maximum duration (120 s free, 1800 s premium)", async () => {
    const video = readyVideo({ metadata: { duration: 4000 } });
    assert.equal((await extract(video, { start: 5, end: 5 })).status, 400);
    assert.equal((await extract(video, { end: 4001 })).status, 400);
    assert.equal((await extract(video, { end: 121, step: 10 })).status, 400);
    assert.equal((await extract(video, { end: 120, step: 10 })).status, 201);
    VideoTask.docs.length = 0;
    assert.equal((await extract(video, { end: 1800, step: 60 }, "premium")).status, 201);
    assert.equal((await extract(video, { end: 1801, step: 60 }, "premium")).status, 400);
  });

  test("TST-FRAME-04 requires an integer sampling step between 1 and 60 s (REQ-VID-FRAME-005)", async () => {
    const video = readyVideo();
    for (const step of [0, 61, 1.5, "x"]) {
      assert.equal((await extract(video, { step })).status, 400, String(step));
    }
    assert.equal((await extract(video, { step: 60 })).status, 201);
  });

  test("TST-FRAME-05 limits the frame count and suggests the minimum step (30 free, 200 premium)", async () => {
    const video = readyVideo();
    const tooMany = await extract(video, { end: 60, step: 2 });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error, /\(31\).*\(30\).*pelo menos 3 s/);
    assert.equal((await extract(video, { end: 58, step: 2 })).status, 201);
    VideoTask.docs.length = 0;
    assert.equal((await extract(video, { end: 199, step: 1 }, "premium")).status, 201);
    assert.equal((await extract(video, { end: 200, step: 1 }, "premium")).status, 400);
  });

  test("TST-FRAME-06 accepts PNG or JPEG output only (REQ-VID-FRAME-035)", async () => {
    const video = readyVideo();
    assert.equal((await extract(video, { format: "gif" })).status, 400);
    assert.equal((await extract(video, { format: "JPEG" })).status, 201);
    assert.equal(VideoTask.docs[0].format, "jpeg");
  });

  test("TST-FRAME-07 limits concurrent extraction tasks (1 free, 3 premium; REQ-VID-FRAME-021)", async () => {
    const video = readyVideo();
    activeTask({ type: "trim" });
    assert.equal((await extract(video)).status, 201);
    assert.equal((await extract(video)).status, 429);
    assert.equal((await extract(video, {}, "premium")).status, 201);
    assert.equal((await extract(video, {}, "premium")).status, 201);
    assert.equal((await extract(video, {}, "premium")).status, 429);
  });

  test("TST-FRAME-08 requires a project id when the destination is an existing project", async () => {
    const video = readyVideo();
    assert.equal((await extract(video, { destinationType: "existing" })).status, 400);
    const ok = await extract(video, { destinationType: "existing", destinationProjectId: "p1" });
    assert.equal(ok.status, 201);
    assert.equal(VideoTask.docs[0].destinationProjectId, "p1");
  });

  test("TST-FRAME-09 creates a queued task with the computed frame count and default project name", async () => {
    const video = readyVideo({ originalName: "match.mov" });
    const response = await extract(video, { start: 2, end: 22, step: 5 });
    assert.equal(response.status, 201);
    const task = VideoTask.docs[0];
    assert.equal(task.type, "extract_frames");
    assert.equal(task.totalFramesCount, 5);
    assert.equal(task.targetName, "match - Fotogramas");
    assert.equal(task.destinationType, "new");
    assert.equal(task.chargedOperation, true);
    assert.deepEqual(enqueued.frames, [response.body.taskId]);
  });
});

describe("task status and cancellation (UC-VID-003/004)", () => {
  test("TST-STATUS-01 lists only the user's queued or processing tasks", async () => {
    activeTask({ status: "queued" });
    activeTask({ status: "processing", type: "extract_frames" });
    activeTask({ status: "completed" });
    activeTask({ userId: "u2" });
    const response = await call("GET", "/u1/tasks");
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 2);
  });

  test("TST-STATUS-02 returns one task only to its owner", async () => {
    const task = activeTask();
    assert.equal((await call("GET", `/u1/tasks/${task.id}`)).status, 200);
    assert.equal((await call("GET", `/u2/tasks/${task.id}`)).status, 404);
  });

  test("TST-STATUS-03 routes cancellation to the worker of the task type", async () => {
    const trimTask = activeTask();
    const framesTask = activeTask({ type: "extract_frames" });
    assert.equal((await call("POST", `/u2/tasks/${trimTask.id}/cancel`)).status, 404);
    assert.equal((await call("POST", `/u1/tasks/${trimTask.id}/cancel`)).status, 200);
    assert.equal((await call("POST", `/u1/tasks/${framesTask.id}/cancel`)).status, 200);
    assert.deepEqual(enqueued.cancelledTrim, [trimTask.id]);
    assert.deepEqual(enqueued.cancelledFrames, [framesTask.id]);
  });
});
