const router = require('express').Router();
const mongoose = require('mongoose');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const Video = require('../models/video');
const Task = require('../models/videoConversionTask');
const auth = require('../middleware/internalAuth');
const worker = require('../services/videoConversionWorker');
const media = require('../services/videoConversionMedia');
const { quota } = worker;
const config = require('../config/videoConversion');
const downloadUrl = require('../services/videoConversionDownload');
const inspections = new Map();
router.use(auth);
router.use((req, res, next) => {
  if (!worker.isReady()) return res.status(503).json({ error: 'Não foi possível iniciar a conversão. Reconciliação em curso.' });
  next();
});
router.param('videoId', (req, res, next, id) => mongoose.isValidObjectId(id) ? next() : res.sendStatus(404));
router.param('taskId', (req, res, next, id) => mongoose.isValidObjectId(id) ? next() : res.sendStatus(404));
function respondError(res, error) {
  console.error('Conversion request:', error.message);
  return res.status(error.status || 503).json({ error: error.status ? error.message : 'Não foi possível iniciar a conversão' });
}
async function sourceFor(req) {
  const video = await Video.findOne({ _id: req.params.videoId, userId: req.params.userId, status: 'ready' });
  if (!video) { const e = new Error('Vídeo não encontrado.'); e.status = 404; throw e; }
  media.validateSize(video.size, req.body.userType);
  const key = `${video.userId}/${video._id}/${video.objectKey}/${video.size}/${req.body.userType}`;
  const cached = inspections.get(key);
  if (cached && cached.expires > Date.now()) return { video, source: cached.source };
  const directory = await fs.mkdtemp(path.join(worker.root, 'preflight-'));
  const file = path.join(directory, 'input');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Não foi possível ler este vídeo.')), 120000);
  try {
    await worker.download(video, file, controller.signal);
    const size = (await fs.stat(file)).size;
    if (size !== video.size) throw media.invalid();
    const source = media.inspect(await media.probe(file, controller.signal), size, req.body.userType);
    if (inspections.size >= 100) inspections.delete(inspections.keys().next().value);
    inspections.set(key, { source, expires: Date.now() + 600000 });
    return { video, source };
  } catch (error) {
    throw error.status ? error : media.invalid();
  } finally { clearTimeout(timeout); await fs.rm(directory, { recursive: true, force: true }); }
}
// Configuration is POST so the authoritative plan travels in the internal request body.
router.post('/:userId/source/:videoId', async (req, res) => {
  try {
    const { video, source } = await sourceFor(req);
    return res.json({ source, name: video.originalName, size: video.size, limits: config.limits[req.body.userType] });
  } catch (e) { return respondError(res, e); }
});
router.post('/:userId/source/:videoId/convert', async (req, res) => {
  let task;
  try {
    const { target, resolution, userType } = req.body;
    if (!config.profiles[target]) throw media.invalid('Perfil de destino inválido.');
    const { video, source } = await sourceFor(req);
    media.dimensions(source.width, source.height, resolution);
    const id = new mongoose.Types.ObjectId();
    task = await Task.create({ _id: id, userId: req.params.userId, userType, sourceVideoId: video._id, sourceKey: video.objectKey,
      source, target, resolution, targetName: `${path.parse(video.originalName).name}-convertido.${target}`,
      resultVideoId: new mongoose.Types.ObjectId(), resultKey: `videos/${crypto.randomUUID()}.${target}`,
      deadline: new Date(Date.now() + config.timeoutMs) });
    const receipt = await quota(task.userId, String(id), 'reserve');
    // A plan change between gateway validation and reservation must not grant stale limits.
    if (receipt.userType !== userType) throw media.invalid('O perfil foi alterado. Atualize a página e confirme novamente.');
    const accepted = await Task.findOneAndUpdate({ _id: id, status: 'queued', deadline: { $gt: new Date() } }, { $set: { accepted: true } }, { new: true });
    if (!accepted) throw new Error('Não foi possível iniciar a conversão');
    setImmediate(worker.drain);
    return res.status(202).json({ taskId: String(id), status: 'queued' });
  } catch (e) {
    if (task) {
      await worker.terminate(task._id, task.userId, 'failed', 'Não foi possível iniciar a conversão', true).catch(console.error);
      // Rejected requests leave no visible/executable task once their compensations succeed.
      await Task.deleteOne({ _id: task._id, accepted: false, status: 'failed', settled: true, cleaned: true });
    }
    return respondError(res, e);
  }
});
router.get('/:userId/tasks', async (req, res) => {
  try { return res.json(await Task.find({ userId: req.params.userId }).sort({ createdAt: -1 }).lean()); }
  catch (e) { return respondError(res, e); }
});
router.get('/:userId/tasks/:taskId', async (req, res) => {
  try {
    const task = await Task.findOne({ _id: req.params.taskId, userId: req.params.userId }).lean();
    return task ? res.json(task) : res.sendStatus(404);
  } catch (e) { return respondError(res, e); }
});
router.post('/:userId/tasks/:taskId/cancel', async (req, res) => {
  try {
    const task = await Task.findOne({ _id: req.params.taskId, userId: req.params.userId });
    if (!task) return res.sendStatus(404);
    if (task.status === 'cancelled') return res.json(task);
    const cancelled = await worker.terminate(task._id, task.userId, 'cancelled', worker.messages.cancelled);
    if (!cancelled) return res.status(409).json({ error: 'A conversão já terminou ou a finalização já prevaleceu.' });
    return res.json(cancelled);
  } catch (e) { return respondError(res, e); }
});
router.get('/:userId/tasks/:taskId/download', async (req, res) => {
  try {
    const task = await Task.findOne({ _id: req.params.taskId, userId: req.params.userId, status: 'completed' });
    if (!task) return res.sendStatus(404);
    const result = await Video.findOne({ _id: task.resultVideoId, userId: req.params.userId, status: 'ready', conversionTaskId: task._id });
    if (!result) return res.sendStatus(404);
    return res.json({ url: await downloadUrl(result) });
  } catch (e) { return respondError(res, e); }
});
module.exports = router;
