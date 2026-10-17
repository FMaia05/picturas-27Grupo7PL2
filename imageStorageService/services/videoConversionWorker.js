const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');
const Task = require('../models/videoConversionTask');
const Video = require('../models/video');
const s3 = require('./s3Client');
const media = require('./videoConversionMedia');
const config = require('../config/videoConversion');
const root = path.join(os.tmpdir(), 'picturas-conversions');
const running = new Map();
let busy = false, ready = false, maintenanceBusy = false;
const active = ['queued', 'processing'];
const messages = {
  failed: 'Não foi possível converter o vídeo. Pode submeter um novo pedido',
  timeout: 'A conversão excedeu o tempo máximo. A operação não foi contabilizada',
  cancelled: 'Conversão cancelada. A operação não foi contabilizada',
  restart: 'Conversão interrompida por reinício. Pode submeter um novo pedido',
  storage: 'Não foi possível guardar o vídeo convertido. A operação não foi contabilizada',
};

// Shared by task acceptance in the router and settlement in this worker.
// The users service owns the counter and idempotent reservation receipts.
function quota(userId, taskId, action) {
  const url = new URL(`${userId}/conversion-quota/${taskId}/${action}`, process.env.USERS_URL || 'https://users:10001/');
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', rejectUnauthorized: false,
      headers: { 'x-internal-service-token': process.env.INTERNAL_SERVICE_TOKEN } }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if (res.statusCode >= 300) {
          const err = new Error(res.statusCode === 403 ? 'Quota diária atingida. Tente no próximo dia ou utilize Premium' : 'Serviço de quotas indisponível.');
          err.status = res.statusCode === 403 ? 403 : 503;
          reject(err);
        } else resolve(action === 'reserve' ? JSON.parse(body) : true);
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Serviço de quotas indisponível.')));
    req.on('error', reject); req.end();
  });
}

async function download(video, file, signal) {
  await pipeline(s3.getObject({ Bucket: `user-${video.userId}`, Key: video.objectKey }).createReadStream(), fs.createWriteStream(file), { signal });
}
async function cleanup(task) {
  if (task.status === 'completed') {
    await Video.updateOne({ _id: task.resultVideoId, userId: task.userId, conversionTaskId: task._id }, { $set: { status: 'ready' }, $unset: { error: 1 } });
  } else {
    await s3.deleteObject({ Bucket: `user-${task.userId}`, Key: task.resultKey }).promise();
    await Video.deleteOne({ _id: task.resultVideoId, userId: task.userId, conversionTaskId: task._id });
  }
  await fs.promises.rm(path.join(root, String(task._id)), { recursive: true, force: true });
  await Task.updateOne({ _id: task._id }, { $set: { cleaned: true } });
}
async function settle(task) {
  if (!task.settled) {
    await quota(task.userId, String(task._id), task.status === 'completed' ? 'confirm' : 'release');
    await Task.updateOne({ _id: task._id }, { $set: { settled: true } });
  }
  if (!task.cleaned && !running.has(String(task._id))) await cleanup(task);
}
async function terminate(id, userId, status, message, allowFinalizing = false) {
  const task = await Task.findOneAndUpdate({ _id: id, userId, status: { $in: active }, ...(allowFinalizing ? {} : { finalizing: false }) },
    { $set: { status, error: message } }, { new: true });
  if (task) {
    running.get(String(id))?.abort(new Error(message));
    await settle(task);
  }
  return task;
}
async function execute(task) {
  const id = String(task._id), controller = new AbortController(), signal = controller.signal;
  running.set(id, controller);
  const timeout = setTimeout(() => {
    controller.abort(new Error(messages.timeout));
    terminate(id, task.userId, 'failed', messages.timeout, true).catch(console.error);
  }, Math.max(1, task.deadline.getTime() - Date.now()));
  const directory = path.join(root, id), input = path.join(directory, 'input'), output = path.join(directory, `output.${task.target}`);
  let lastProgress = 0, stage = 'processing';
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    const sourceVideo = await Video.findOne({ _id: task.sourceVideoId, userId: task.userId, status: 'ready', objectKey: task.sourceKey });
    if (!sourceVideo) throw new Error(messages.failed);
    await download(sourceVideo, input, signal);
    const stat = await fs.promises.stat(input);
    if (stat.size !== sourceVideo.size) throw media.invalid();
    const source = media.inspect(await media.probe(input, signal), stat.size, task.userType);
    await media.run('ffmpeg', media.argumentsFor(input, output, source, task.target, task.resolution), { signal, onProgress: seconds => {
      if (Date.now() - lastProgress < 1000) return;
      lastProgress = Date.now();
      Task.updateOne({ _id: task._id, status: 'processing' }, { $max: { progress: Math.min(94, Math.round(seconds / source.duration * 90) + 4) } }).catch(console.error);
    } });
    const resultSize = (await fs.promises.stat(output)).size;
    let metadata;
    try { metadata = media.validateOutput(await media.probe(output, signal), source, task.target, task.resolution, resultSize); }
    catch (_) { throw new Error('O vídeo convertido não passou a validação'); }
    signal.throwIfAborted();
    stage = 'storage';
    const usage = await Video.aggregate([
      { $match: { userId: task.userId, status: { $in: ['uploading', 'processing', 'ready'] } } },
      { $group: { _id: null, total: { $sum: '$size' } } },
    ]);
    const storageLimit = task.userType === 'premium' ? Number(process.env.PREMIUM_VIDEO_QUOTA_BYTES || 20 * 1024 ** 3) : Number(process.env.FREE_VIDEO_QUOTA_BYTES || 1024 ** 3);
    if ((usage[0]?.total || 0) + resultSize > storageLimit) throw new Error(messages.storage);
    const stream = fs.createReadStream(output);
    const upload = s3.upload({ Bucket: `user-${task.userId}`, Key: task.resultKey, Body: stream, ContentType: config.profiles[task.target].mime });
    const abortUpload = () => { upload.abort(); stream.destroy(); };
    signal.addEventListener('abort', abortUpload, { once: true });
    try { await upload.promise(); } finally { signal.removeEventListener('abort', abortUpload); stream.destroy(); }
    signal.throwIfAborted();
    // Pending outputs use an existing non-public status; upload recovery never picks them up.
    await Video.create({ _id: task.resultVideoId, userId: task.userId, originalName: task.targetName,
      mimeType: config.profiles[task.target].mime, size: resultSize, objectKey: task.resultKey,
      metadata, status: 'failed', sourceVideoId: task.sourceVideoId, conversionTaskId: task._id });
    const locked = await Task.findOneAndUpdate({ _id: task._id, status: 'processing', finalizing: false, deadline: { $gt: new Date() } },
      { $set: { finalizing: true, progress: 98 } }, { new: true });
    if (!locked) throw new Error(messages.failed);
    await quota(task.userId, id, 'confirm');
    signal.throwIfAborted();
    const completed = await Task.findOneAndUpdate({ _id: task._id, status: 'processing', finalizing: true, deadline: { $gt: new Date() } },
      { $set: { status: 'completed', progress: 100, settled: true } }, { new: true });
    if (!completed) throw new Error(messages.timeout);
  } catch (error) {
    const reason = signal.aborted ? signal.reason.message : error.message;
    await terminate(id, task.userId, 'failed', error.status === 400 || Object.values(messages).includes(reason) || reason === 'O vídeo convertido não passou a validação' ? reason : (stage === 'storage' ? messages.storage : messages.failed), true);
  } finally {
    clearTimeout(timeout);
    running.delete(id);
    const finalTask = await Task.findById(task._id);
    if (finalTask && !active.includes(finalTask.status)) await settle(finalTask);
  }
}
async function drain() {
  if (!ready || busy) return;
  busy = true;
  try {
    let task;
    while ((task = await Task.findOneAndUpdate({ status: 'queued', accepted: true, deadline: { $gt: new Date() } },
      { $set: { status: 'processing', progress: 1 } }, { sort: { createdAt: 1 }, new: true }))) {
      await execute(task);
    }
  } catch (err) { console.error('Conversion worker:', err); }
  finally { busy = false; }
}
async function maintain() {
  if (!ready || maintenanceBusy) return;
  maintenanceBusy = true;
  try {
    for (const task of await Task.find({ status: { $in: active }, deadline: { $lte: new Date() } })) {
      await terminate(task._id, task.userId, 'failed', messages.timeout, true);
    }
    for (const task of await Task.find({ status: { $nin: active }, $or: [{ settled: false }, { cleaned: false }] })) await settle(task);
    setImmediate(drain);
  } catch (err) { console.error('Conversion reconciliation:', err.message); }
  finally { maintenanceBusy = false; }
}
async function start() {
  await fs.promises.mkdir(root, { recursive: true });
  // Single img_storage instance, as in Compose. No resumption/retry of interrupted work.
  await Task.updateMany({ status: { $in: active } }, { $set: { status: 'failed', error: messages.restart } });
  for (const task of await Task.find({ status: { $nin: active }, $or: [{ settled: false }, { cleaned: false }] })) await settle(task);
  // Preflight files have no published result and are safe to remove after a crash.
  for (const name of await fs.promises.readdir(root)) {
    if (name.startsWith('preflight-')) await fs.promises.rm(path.join(root, name), { recursive: true, force: true });
  }
  ready = true;
  setInterval(() => { maintain().catch(console.error); }, 2000).unref();
}
module.exports = { start, drain, terminate, isReady: () => ready, download, root, messages, quota };
