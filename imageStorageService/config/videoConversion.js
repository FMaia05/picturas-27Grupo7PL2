// UC-VID-002 / RN3–RN6: decimal MB, independent of upload/Trim limits.
module.exports = Object.freeze({
  limits: {
    free: { bytes: 200000000, seconds: 120 },
    premium: { bytes: 500000000, seconds: 300 },
  },
  timeoutMs: 900000,
  profiles: {
    mp4: { extension: '.mp4', mime: 'video/mp4', video: 'h264', audio: 'aac' },
    webm: { extension: '.webm', mime: 'video/webm', video: 'vp9', audio: 'opus' },
  },
});
