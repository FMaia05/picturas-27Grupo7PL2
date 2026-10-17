const router = require('express').Router();
const axios = require('axios');
const https = require('node:https');
const auth = require('../auth/auth');
const agent = new https.Agent({ rejectUnauthorized: false });
router.use('/:user', auth.checkToken, async (req, res, next) => {
  // checkToken permits ?share for image sharing. Conversion never accepts that bypass.
  if (req.authUserId !== req.params.user) return res.sendStatus(403);
  try {
    const response = await axios.get(`https://users:10001/validate/${req.params.user}`, {
      httpsAgent: agent, headers: { Authorization: req.headers.authorization }, timeout: 5000,
    });
    if (!['free', 'premium'].includes(response.data.user.type)) return res.status(403).json({ error: 'Inicie sessão com uma conta Registada ou Premium.' });
    req.conversionUserType = response.data.user.type;
    next();
  } catch (_) { return res.status(401).json({ error: 'Sessão inválida.' }); }
});
async function forward(req, res) {
  try {
    const response = await axios({ method: req.method, url: `http://img_storage:11000/video-conversions${req.path}`,
      ...(req.method === 'POST' ? { data: { target: req.body.target, resolution: req.body.resolution, userType: req.conversionUserType } } : {}),
      headers: { 'x-internal-service-token': process.env.INTERNAL_SERVICE_TOKEN }, timeout: 130000,
    });
    return res.status(response.status).json(response.data);
  } catch (e) { return res.status(e.response?.status || 503).json(e.response?.data || { error: 'Serviço de conversão indisponível.' }); }
}
router.post('/:user/source/:videoId', forward);
router.post('/:user/source/:videoId/convert', forward);
router.get('/:user/tasks', forward);
router.get('/:user/tasks/:taskId', forward);
router.post('/:user/tasks/:taskId/cancel', forward);
router.get('/:user/tasks/:taskId/download', forward);
module.exports = router;
