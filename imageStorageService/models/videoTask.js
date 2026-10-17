const mongoose = require("mongoose");

const videoTaskSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    type: { type: String, required: true, default: "trim" },
    sourceVideoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "video",
      required: true,
    },
    targetName: { type: String, required: true },
    replaceOriginal: { type: Boolean, default: false },
    start: { type: Number, required: true },
    end: { type: Number, required: true },
    duration: { type: Number, required: true },
    step: { type: Number },
    format: { type: String, enum: ["png", "jpeg"], default: "png" },
    destinationType: { type: String, enum: ["new", "existing"], default: "new" },
    destinationProjectId: { type: String },
    totalFramesCount: { type: Number, default: 0 },
    extractedFramesCount: { type: Number, default: 0 },
    resultProjectId: { type: String },
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed", "cancelled"],
      default: "queued",
      index: true,
    },
    progress: { type: Number, default: 0 },
    retries: { type: Number, default: 0 },
    resultVideoId: { type: mongoose.Schema.Types.ObjectId, ref: "video" },
    error: String,
    chargedOperation: { type: Boolean, default: false },
  },
  { timestamps: true },
);

module.exports = mongoose.model("video_task", videoTaskSchema);
