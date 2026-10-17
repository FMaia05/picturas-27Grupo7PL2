const router = require('express').Router();
const quota = require('../services/operationQuota');
function internalAuth(req, res, next) {
  if (!process.env.INTERNAL_SERVICE_TOKEN || req.get('x-internal-service-token') !== process.env.INTERNAL_SERVICE_TOKEN) return res.sendStatus(403);
  next();
}
router.post('/:user/conversion-quota/:id/:action', internalAuth, async (req, res) => {
  try {
    const { user, id, action } = req.params;
    if (!/^[a-f0-9]{24}$/.test(id) || !['reserve', 'confirm', 'release'].includes(action)) return res.sendStatus(400);
    if (action === 'reserve') {
      const receipt = await quota.reserve(user, id);
      if (!receipt || receipt.state !== 'reserved') return res.status(403).json({ error: 'Quota diária atingida. Tente no próximo dia ou utilize Premium' });
      return res.json(receipt);
    }
    return res.sendStatus(await quota.settle(user, id, action) ? 200 : 409);
  } catch (err) { console.error('Conversion quota:', err.message); return res.sendStatus(503); }
});
module.exports = router;
