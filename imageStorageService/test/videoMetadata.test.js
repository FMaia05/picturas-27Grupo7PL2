// Content inspection with ffprobe (UC-VID-001): client MIME type and extension
// are untrusted, so the codec/container combination is checked on the bytes.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { stubModule, createS3 } = require("./helpers/fakes");
const { skipReason, createFixtures, tempEntries } = require("./helpers/ffmpeg");

const ROOT = path.join(__dirname, "..");
const s3 = stubModule(path.join(ROOT, "services/s3Client.js"), createS3());
const inspectVideo = require(path.join(ROOT, "services/videoMetadata.js"));

describe("ffprobe inspection", { skip: skipReason }, () => {
  let fixtures;
  before(() => {
    fixtures = createFixtures();
  });
  after(() => fixtures?.cleanup());

  test("TST-META-01 accepts MP4 with H.264 and AAC and extracts the metadata", async () => {
    const metadata = await inspectVideo(null, null, ".mp4", fixtures.file("clip.mp4"));
    assert.ok(Math.abs(metadata.duration - 10) < 0.2);
    assert.equal(metadata.width, 320);
    assert.equal(metadata.height, 240);
    assert.equal(metadata.videoCodec, "h264");
    assert.equal(metadata.audioCodec, "aac");
    assert.equal(metadata.fps, 25);
    assert.equal(metadata.rotation, 0);
  });

  test("TST-META-02 accepts MOV with H.264 and no audio track", async () => {
    const metadata = await inspectVideo(null, null, ".mov", fixtures.file("clip.mov"));
    assert.equal(metadata.videoCodec, "h264");
    assert.equal(metadata.audioCodec, "none");
  });

  test("TST-META-03 accepts WebM with VP9 and Opus", async () => {
    const metadata = await inspectVideo(null, null, ".webm", fixtures.file("clip.webm"));
    assert.equal(metadata.videoCodec, "vp9");
    assert.equal(metadata.audioCodec, "opus");
  });

  test("TST-META-04 rejects an unsupported codec inside a supported container", async () => {
    await assert.rejects(inspectVideo(null, null, ".mp4", fixtures.file("mpeg4.mp4")), /Unsupported/);
  });

  test("TST-META-05 rejects a WebM file renamed to .mp4 (spoofed extension)", async () => {
    await assert.rejects(inspectVideo(null, null, ".mp4", fixtures.file("spoofed-webm.mp4")), /Unsupported/);
  });

  test("TST-META-06 rejects a corrupt file", async () => {
    await assert.rejects(inspectVideo(null, null, ".mp4", fixtures.file("corrupt.mp4")));
  });

  test("TST-META-07 downloads the stored object to a temporary file and always deletes it", async () => {
    s3.put("user-u1", "videos/a.mp4", fs.readFileSync(fixtures.file("clip.mp4")));
    s3.put("user-u1", "videos/bad.mp4", fs.readFileSync(fixtures.file("corrupt.mp4")));
    const prefix = `picturas-video-${process.pid}-`;
    const metadata = await inspectVideo("user-u1", "videos/a.mp4", ".mp4");
    assert.equal(metadata.videoCodec, "h264");
    await assert.rejects(inspectVideo("user-u1", "videos/bad.mp4", ".mp4"));
    assert.deepEqual(tempEntries(prefix), []);
  });
});
