// Generates small synthetic videos with ffmpeg so worker tests exercise the real
// ffmpeg/ffprobe pipeline. Tests that need them are skipped when ffmpeg is absent
// (run them inside the img_storage container, which installs ffmpeg).
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"]).error && !spawnSync("ffprobe", ["-version"]).error;
const skipReason = hasFfmpeg ? false : "ffmpeg/ffprobe not installed (run in the img_storage container)";

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args, "-y"], { stdio: "pipe" });
}

function createFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picturas-test-"));
  const file = (name) => path.join(dir, name);
  const source = ["-f", "lavfi", "-i", "testsrc=duration=10:size=320x240:rate=25"];
  const sine = ["-f", "lavfi", "-i", "sine=frequency=440:duration=10"];

  ffmpeg([...source, ...sine, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", "-c:a", "aac", "-shortest", file("clip.mp4")]);
  ffmpeg([...source, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", file("clip.mov")]);
  ffmpeg([
    "-f", "lavfi", "-i", "testsrc=duration=2:size=160x120:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", "-shortest", file("clip.webm"),
  ]);
  ffmpeg([...source, "-c:v", "mpeg4", file("mpeg4.mp4")]);
  // Phone-style portrait clip: 320x240 pixels with a 90-degree display rotation.
  ffmpeg(["-i", file("clip.mp4"), "-c", "copy", "-metadata:s:v:0", "rotate=90", file("rotated.mp4")]);
  fs.copyFileSync(file("clip.webm"), file("spoofed-webm.mp4"));
  fs.writeFileSync(file("corrupt.mp4"), "this is not a video file");

  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Width and height from the IHDR chunk of a PNG buffer.
function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function tempEntries(prefix) {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix));
}

module.exports = { hasFfmpeg, skipReason, createFixtures, tempEntries, pngSize };
