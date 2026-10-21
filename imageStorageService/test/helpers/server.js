const express = require("express");

async function startServer(mountPath, router) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, router);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}${mountPath}`;
  return { baseUrl, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function request(baseUrl, method, path, { body, headers = {}, raw } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(raw ? { "content-type": "application/octet-stream" } : body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {}
  return { status: response.status, body: data };
}

module.exports = { startServer, request };
