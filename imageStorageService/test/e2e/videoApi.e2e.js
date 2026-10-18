// End-to-end system tests of the video features through the public entry point
// (nginx -> api_gateway -> users / img_storage / SeaweedFS / projects).
// Run inside the img_storage image so ffmpeg and the S3 credentials are available:
//   docker compose run --rm --no-deps img_storage npm run test:e2e
// The stack must be up (`docker compose up -d`).
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createFixtures } = require("../helpers/ffmpeg");
const { execFileSync } = require("child_process");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // self-signed development certificate
const BASE = (process.env.E2E_BASE_URL || "https://nginx/api-gateway").replace(/\/$/, "");
const MiB = 1024 * 1024;
const s3 = require("../../services/s3Client");

async function api(method, url, { token, body, raw } = {}) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(raw ? { "content-type": "application/octet-stream" } : body ? { "content-type": "application/json" } : {}),
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {}
  return { status: response.status, body: data };
}

async function register(type) {
  const email = type === "anonymous" ? undefined : `e2e-${type}-${crypto.randomUUID()}@picturas.test`;
  const response = await api("POST", "/users", { body: { name: `E2E ${type}`, email, password: "e2e-password-123", type } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { id: response.body.user._id, token: response.body.jwt, type };
}

async function poll(fn, done, { timeout = 120000, interval = 500 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() - startedAt > timeout) throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

const mimeOf = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

async function startUpload(user, name, size) {
  return api("POST", `/videos/${user.id}/uploads`, {
    token: user.token,
    body: { name, size, mimeType: mimeOf[path.extname(name).toLowerCase()] },
  });
}

async function uploadFile(user, filePath, name = path.basename(filePath)) {
  const data = fs.readFileSync(filePath);
  const init = await startUpload(user, name, data.length);
  assert.equal(init.status, 201, JSON.stringify(init.body));
  const { videoId, uploadId, partSize } = init.body;
  const parts = [];
  for (let offset = 0, number = 1; offset < data.length; offset += partSize, number += 1) {
    const part = await api("PUT", `/videos/${user.id}/uploads/${videoId}/parts/${number}?uploadId=${encodeURIComponent(uploadId)}`, {
      token: user.token,
      raw: data.subarray(offset, offset + partSize),
    });
    assert.equal(part.status, 200, JSON.stringify(part.body));
    parts.push({ PartNumber: number, ETag: part.body.etag });
  }
  const complete = await api("POST", `/videos/${user.id}/uploads/${videoId}/complete`, { token: user.token, body: { uploadId, parts } });
  return { videoId, complete };
}

async function videoStatus(user, videoId) {
  return poll(
    () => api("GET", `/videos/${user.id}/${videoId}`, { token: user.token }),
    (response) => response.status !== 200 || !["uploading", "processing"].includes(response.body.status),
  );
}

async function taskResult(user, taskId) {
  return poll(
    () => api("GET", `/videos/${user.id}/tasks/${taskId}`, { token: user.token }),
    (response) => ["completed", "failed", "cancelled"].includes(response.body?.status),
  );
}

const remainingOps = async (user) => (await api("GET", `/users/${user.id}`)).body.remaining_operations;
const objectExists = (user, key) =>
  s3.headObject({ Bucket: `user-${user.id}`, Key: key }).promise().then(() => true, () => false);

describe("video API end to end", () => {
  let fixtures;
  let free;
  let premium;
  let sourceVideoId;

  before(async () => {
    fixtures = createFixtures();
    // A longer 720p clip so that a task can be cancelled while it is still running.
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=120:size=1280x720:rate=30",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "30", "-y", fixtures.file("long.mp4"),
    ]);
    free = await register("free");
    premium = await register("premium");
  });

  test("TST-E2E-01 anonymous users cannot upload, trim or extract", async () => {
    const anonymous = await register("anonymous");
    assert.equal((await startUpload(anonymous, "a.mp4", 10)).status, 403);
    assert.equal((await api("POST", `/videos/${anonymous.id}/x/trim`, { token: anonymous.token, body: {} })).status, 403);
    assert.equal((await api("POST", `/videos/${anonymous.id}/x/extract-frames`, { token: anonymous.token, body: {} })).status, 403);
  });

  test("TST-E2E-02 valid MP4, MOV and WebM uploads become ready with ffprobe metadata", async () => {
    for (const name of ["clip.mp4", "clip.mov", "clip.webm"]) {
      const { videoId, complete } = await uploadFile(free, fixtures.file(name));
      assert.equal(complete.status, 202, `${name}: ${JSON.stringify(complete.body)}`);
      const video = await videoStatus(free, videoId);
      assert.equal(video.body.status, "ready", name);
      assert.ok(video.body.metadata.duration > 1, name);
      assert.ok(video.body.metadata.width > 0, name);
      if (name === "clip.mp4") sourceVideoId = videoId;
    }
    const library = await api("GET", `/videos/${free.id}`, { token: free.token });
    assert.equal(library.body.length, 3);
    assert.ok(library.body.every((video) => video.url));
    assert.equal(await remainingOps(free), 5, "uploads do not consume daily operations");
  });

  test("TST-E2E-03 a corrupt file renamed to .mp4 is rejected and its object deleted", async () => {
    const { videoId, complete } = await uploadFile(free, fixtures.file("corrupt.mp4"));
    assert.equal(complete.status, 202);
    const video = await videoStatus(free, videoId);
    assert.equal(video.body.status, "failed");
    assert.equal(await objectExists(free, video.body.objectKey), false);
    const library = await api("GET", `/videos/${free.id}`, { token: free.token });
    assert.ok(library.body.every((item) => item._id !== videoId));
  });

  test("TST-E2E-04 an unsupported codec and a spoofed container are rejected", async () => {
    for (const name of ["mpeg4.mp4", "spoofed-webm.mp4"]) {
      const { videoId } = await uploadFile(free, fixtures.file(name));
      const video = await videoStatus(free, videoId);
      assert.equal(video.body.status, "failed", name);
      assert.equal(await objectExists(free, video.body.objectKey), false, name);
    }
  });

  test("TST-E2E-05 a file over the plan limit is refused before any byte is sent", async () => {
    assert.equal((await startUpload(free, "big.mp4", 200 * MiB + 1)).status, 400);
    const premiumInit = await startUpload(premium, "big.mp4", 200 * MiB + 1);
    assert.equal(premiumInit.status, 201);
    await api("DELETE", `/videos/${premium.id}/uploads/${premiumInit.body.videoId}`, { token: premium.token });
  });

  test("TST-E2E-06 cancelling after one part aborts the multipart upload", async () => {
    const init = await startUpload(free, "cancel.mp4", 12 * MiB);
    assert.equal(init.status, 201);
    const { videoId, uploadId } = init.body;
    const part = await api("PUT", `/videos/${free.id}/uploads/${videoId}/parts/1?uploadId=${encodeURIComponent(uploadId)}`, {
      token: free.token,
      raw: crypto.randomBytes(8 * MiB),
    });
    assert.equal(part.status, 200);
    const record = (await api("GET", `/videos/${free.id}/${videoId}`, { token: free.token })).body;
    assert.equal((await api("DELETE", `/videos/${free.id}/uploads/${videoId}`, { token: free.token })).status, 204);
    assert.equal((await api("GET", `/videos/${free.id}/${videoId}`, { token: free.token })).status, 404);
    const sessions = await s3.listMultipartUploads({ Bucket: `user-${free.id}` }).promise();
    assert.ok(!(sessions.Uploads || []).some((upload) => upload.Key === record.objectKey), "multipart session aborted");
  });

  test("TST-E2E-07 a batch of six files uploaded in parallel all succeed", async () => {
    const uploads = await Promise.all(
      Array.from({ length: 6 }, (_, index) => uploadFile(premium, fixtures.file("clip.mp4"), `batch-${index}.mp4`)),
    );
    const results = await Promise.all(uploads.map(({ videoId }) => videoStatus(premium, videoId)));
    assert.deepEqual(results.map((video) => video.body.status), Array(6).fill("ready"));
  });

  test("TST-E2E-08 the total storage quota blocks new uploads (1 GiB free)", async () => {
    const sessions = [];
    for (let index = 0; index < 5; index += 1) {
      const init = await startUpload(free, `reserve-${index}.mp4`, 200 * MiB);
      assert.equal(init.status, 201);
      sessions.push(init.body.videoId);
    }
    const full = await startUpload(free, "one-more.mp4", 200 * MiB);
    assert.equal(full.status, 413);
    for (const videoId of sessions) await api("DELETE", `/videos/${free.id}/uploads/${videoId}`, { token: free.token });
    assert.equal((await startUpload(free, "after-cleanup.mp4", 1 * MiB)).status, 201);
  });

  test("TST-E2E-09 trim produces a new video and consumes one daily operation", async () => {
    const before = await remainingOps(free);
    const create = await api("POST", `/videos/${free.id}/${sourceVideoId}/trim`, {
      token: free.token,
      body: { start: 2, end: 5, targetName: "e2e-trim.mp4" },
    });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const task = await taskResult(free, create.body.taskId);
    assert.equal(task.body.status, "completed", task.body.error);
    const trimmed = await api("GET", `/videos/${free.id}/${task.body.resultVideoId}`, { token: free.token });
    assert.equal(trimmed.body.originalName, "e2e-trim.mp4");
    const { duration } = trimmed.body.metadata; // stream copy: up to ~0.5 s longer (L-01)
    assert.ok(duration >= 2.95 && duration <= 3.5, `duration ${duration}`);
    assert.equal(await remainingOps(free), before - 1);
  });

  test("TST-E2E-10 frame extraction creates a project with the sampled frames", async () => {
    const before = await remainingOps(free);
    const create = await api("POST", `/videos/${free.id}/${sourceVideoId}/extract-frames`, {
      token: free.token,
      body: { start: 0, end: 4, step: 2, format: "png", destinationType: "new", targetName: "E2E frames" },
    });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const task = await taskResult(free, create.body.taskId);
    assert.equal(task.body.status, "completed", task.body.error);
    assert.equal(task.body.extractedFramesCount, 3);
    const project = await api("GET", `/projects/${free.id}/${task.body.resultProjectId}`, { token: free.token });
    assert.equal(project.status, 200, JSON.stringify(project.body));
    assert.equal(project.body.name, "E2E frames");
    assert.equal(project.body.imgs.length, 3);
    assert.equal(await remainingOps(free), before - 1);
  });

  test("TST-E2E-11 cancelling a queued trim refunds the daily operation exactly once", async () => {
    // Premium trims of a longer clip keep the serial trim worker busy, so the free
    // user's task is still waiting when it is cancelled.
    const { videoId: longVideoId } = await uploadFile(premium, fixtures.file("long.mp4"));
    assert.equal((await videoStatus(premium, longVideoId)).body.status, "ready");
    const busy = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await api("POST", `/videos/${premium.id}/${longVideoId}/trim`, {
        token: premium.token,
        body: { start: 0, end: 110, targetName: `busy-${index}.mp4` },
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      busy.push(response.body.taskId);
    }

    const before = await remainingOps(free);
    const create = await api("POST", `/videos/${free.id}/${sourceVideoId}/trim`, { token: free.token, body: { start: 0, end: 5 } });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const cancel = await api("POST", `/videos/${free.id}/tasks/${create.body.taskId}/cancel`, { token: free.token });
    assert.equal(cancel.status, 200);

    const task = await taskResult(free, create.body.taskId);
    for (const taskId of busy) await taskResult(premium, taskId);
    assert.equal(task.body.status, "cancelled");
    assert.equal(task.body.resultVideoId, undefined);
    assert.equal(await remainingOps(free), before, "the provisional charge was refunded exactly once");
  });

  test("TST-E2E-12 the daily operation quota blocks the sixth operation of a free user", async () => {
    let remaining = await remainingOps(free);
    while (remaining > 0) {
      const create = await api("POST", `/videos/${free.id}/${sourceVideoId}/trim`, { token: free.token, body: { start: 0, end: 1 } });
      assert.equal(create.status, 201, JSON.stringify(create.body));
      await taskResult(free, create.body.taskId);
      remaining = await remainingOps(free);
    }
    const blocked = await api("POST", `/videos/${free.id}/${sourceVideoId}/trim`, { token: free.token, body: { start: 0, end: 1 } });
    assert.equal(blocked.status, 403);
    const blockedFrames = await api("POST", `/videos/${free.id}/${sourceVideoId}/extract-frames`, {
      token: free.token,
      body: { start: 0, end: 1, step: 1, format: "png" },
    });
    assert.equal(blockedFrames.status, 403);
    const premiumTrim = await api("POST", `/videos/${premium.id}/x/trim`, { token: premium.token, body: { start: 0, end: 1 } });
    assert.equal(premiumTrim.status, 404, "premium users are not limited by the daily quota");
  });

  test("TST-E2E-13 users cannot read or change another user's videos", async () => {
    assert.equal((await api("GET", `/videos/${free.id}/${sourceVideoId}`, { token: premium.token })).status, 401);
    assert.equal((await api("GET", `/videos/${premium.id}/${sourceVideoId}`, { token: premium.token })).status, 404);
    assert.equal((await api("DELETE", `/videos/${premium.id}/${sourceVideoId}`, { token: premium.token })).status, 204);
    assert.equal((await api("GET", `/videos/${free.id}/${sourceVideoId}`, { token: free.token })).body.status, "ready");
  });
});
