const mongoose = require("mongoose");

const metadataSchema = new mongoose.Schema(
  {
    duration: Number,
    width: Number,
    height: Number,
    videoCodec: String,
    audioCodec: String,
    fps: Number,
    rotation: Number,
  },
  { _id: false },
);

const videoSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    objectKey: { type: String, required: true },
    uploadId: String,
    sourceVideoId: { type: mongoose.Schema.Types.ObjectId, ref: "video" },
    conversionTaskId: { type: mongoose.Schema.Types.ObjectId, index: true, unique: true, sparse: true },
    status: {
      type: String,
      enum: ["uploading", "processing", "ready", "failed"],
      default: "uploading",
      index: true,
    },
    metadata: metadataSchema,
    error: String,
  },
  { timestamps: true },
);

module.exports = mongoose.model("video", videoSchema);
