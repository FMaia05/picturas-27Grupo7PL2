const mongoose = require('mongoose');
// Separate lifecycle: no changes to Trim's required fields, retries or worker.
const schema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  userType: { type: String, enum: ['free', 'premium'], required: true },
  sourceVideoId: { type: mongoose.Schema.Types.ObjectId, ref: 'video', required: true },
  sourceKey: { type: String, required: true },
  source: { type: mongoose.Schema.Types.Mixed, required: true },
  target: { type: String, enum: ['mp4', 'webm'], required: true },
  resolution: { type: String, enum: ['preserve', '720p'], required: true },
  targetName: String,
  status: { type: String, enum: ['queued', 'processing', 'completed', 'failed', 'cancelled'], default: 'queued', index: true },
  accepted: { type: Boolean, default: false },
  finalizing: { type: Boolean, default: false },
  progress: { type: Number, default: 0 },
  deadline: { type: Date, required: true },
  resultVideoId: { type: mongoose.Schema.Types.ObjectId, ref: 'video', required: true },
  resultKey: { type: String, required: true },
  settled: { type: Boolean, default: false },
  cleaned: { type: Boolean, default: false },
  error: String,
}, { timestamps: true });
module.exports = mongoose.model('video_conversion_task', schema);
