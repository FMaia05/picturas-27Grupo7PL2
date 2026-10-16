const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const s3 = require("./s3Client");

const execFileAsync = promisify(execFile);

function parseFps(value) {
  if (!value) return 0;
  const [numerator, denominator = "1"] = value.split("/").map(Number);
  return denominator ? numerator / denominator : 0;
}

function rotationOf(stream) {
  const sideData = (stream.side_data_list || []).find((entry) => entry.rotation !== undefined);
  return Number(sideData?.rotation ?? stream.tags?.rotate ?? 0);
}

async function inspectVideo(bucket, key, extension, localFilePath = null) {
  const isLocal = Boolean(localFilePath);
  const targetPath = isLocal
    ? localFilePath
    : path.join(
        os.tmpdir(),
        `picturas-video-${process.pid}-${Date.now()}${extension}`,
      );

  try {
    if (!isLocal) {
      await new Promise((resolve, reject) => {
        const input = s3.getObject({ Bucket: bucket, Key: key }).createReadStream();
        const output = fs.createWriteStream(targetPath);
        input.on("error", reject);
        output.on("error", reject);
        output.on("finish", resolve);
        input.pipe(output);
      });
    }

    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_format", "-show_streams", "-of", "json", targetPath],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const probe = JSON.parse(stdout);
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
    if (!video || !Number(probe.format?.duration)) throw new Error("No valid video stream");

    const isWebm = extension === ".webm";
    const validVideoCodec = isWebm ? video.codec_name === "vp9" : video.codec_name === "h264";
    const validAudioCodec = !audio || (isWebm ? audio.codec_name === "opus" : audio.codec_name === "aac");
    if (!validVideoCodec || !validAudioCodec) throw new Error("Unsupported video or audio codec");

    return {
      duration: Number(probe.format.duration),
      width: video.width,
      height: video.height,
      videoCodec: video.codec_name,
      audioCodec: audio?.codec_name || "none",
      fps: parseFps(video.avg_frame_rate || video.r_frame_rate),
      rotation: rotationOf(video),
    };
  } finally {
    if (!isLocal) {
      await fs.promises.rm(targetPath, { force: true }).catch(() => {});
    }
  }
}

module.exports = inspectVideo;
