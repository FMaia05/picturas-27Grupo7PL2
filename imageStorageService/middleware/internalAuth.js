module.exports = function internalAuth(req, res, next) {
  const expected = process.env.INTERNAL_SERVICE_TOKEN;
  if (!expected || req.get("x-internal-service-token") !== expected) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
};
