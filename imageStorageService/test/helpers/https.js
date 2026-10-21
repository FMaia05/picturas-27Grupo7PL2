// Intercepts outgoing https.request calls (refunds to users, fallback calls to
// projects) and records them. `respond(url)` returns { status, body }.
const { EventEmitter } = require("events");
const https = require("https");
const { PassThrough } = require("stream");
const { mock } = require("node:test");

function interceptHttps(respond = () => ({ status: 200, body: "" })) {
  const calls = [];
  mock.method(https, "request", (url, options, callback) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      calls.push({ url: String(url), method: options?.method });
      const { status, body = "" } = respond(String(url));
      setImmediate(() => {
        const res = new PassThrough();
        res.statusCode = status;
        callback(res);
        res.end(body);
      });
    };
    return req;
  });
  return {
    calls,
    refunds: () => calls.filter((entry) => entry.url.includes("/process/refund/1")),
  };
}

module.exports = { interceptHttps };
