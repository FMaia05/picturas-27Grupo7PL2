// Used only to protect newly created conversion results on the existing library.
// Legacy upload/Trim records retain their current behaviour, including the known
// share bypass. Missing caller context fails closed for conversion results.
module.exports = function conversionVisibility(req) {
  return req.get('x-conversion-caller-id') === req.params.userId
    ? {}
    : { conversionTaskId: null };
};
