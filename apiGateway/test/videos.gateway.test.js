// Gateway rules for the video API: JWT ownership, anonymous users blocked,
// authoritative account type from `users`, and provisional charge/refund of the
// daily operation for trim (UC-VID-004) and frame extraction (UC-VID-003).
const { test, describe, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const axios = require("axios");

process.env.JWT_SECRET_KEY = "test-secret";
process.env.INTERNAL_SERVICE_TOKEN = "test-internal-token";
const router = require(path.join(__dirname, "..", "routes", "videos.js"));

const calls = [];
let accountType;
let quotaAvailable;
let storageFailure;

function fail(status, data) {
  const error = new Error(`status ${status}`);
  error.response = { status, data };
  return error;
}

async function fakeAxios(method, url, second, third) {
  const config = method === "get" || method === "delete" ? second : third;
  const body = method === "get" || method === "delete" ? undefined : second;
  calls.push({ method, url, body, headers: config?.headers || {} });
  if (url.startsWith("https://users:10001/validate/")) return { status: 200, data: { user: { _id: "u1", type: accountType } } };
  if (url === "https://users:10001/u1/process/1") {
    if (!quotaAvailable) throw fail(403, "limit reached");
    return { status: 200, data: {} };
  }
  if (url === "https://users:10001/u1/process/refund/1") return { status: 200, data: {} };
  if (url.startsWith("http://img_storage:11000/videos/")) {
    if (storageFailure) throw fail(storageFailure.status, storageFailure.data);
    return { status: method === "post" ? 201 : 200, data: { ok: true, forwarded: body } };
  }
  throw new Error(`unexpected ${method} ${url}`);
}
for (const method of ["get", "post", "put", "delete"]) {
  mock.method(axios, method, (...args) => fakeAxios(method, ...args));
}

let server;
let baseUrl;
const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET_KEY, { expiresIn: "1h" });

async function send(method, url, { body, token = tokenFor("u1") } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch (_) {}
  return { status: response.status, body: data };
}

const storageCalls = () => calls.filter((call) => call.url.startsWith("http://img_storage"));
const chargeCalls = () => calls.filter((call) => call.url.endsWith("/process/1"));
const refundCalls = () => calls.filter((call) => call.url.endsWith("/process/refund/1"));

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/videos", router);
  server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/videos`;
});
after(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  calls.length = 0;
  accountType = "free";
  quotaAvailable = true;
  storageFailure = null;
});

describe("authentication and ownership", () => {
  test("TST-GW-01 rejects requests without a JWT, with an invalid JWT or for another user", async () => {
    assert.equal((await send("GET", "/u1", { token: null })).status, 401);
    assert.equal((await send("GET", "/u1", { token: "not-a-jwt" })).status, 401);
    assert.equal((await send("GET", "/u1", { token: tokenFor("u2") })).status, 401);
    assert.equal((await send("POST", "/u1/v1/trim", { token: tokenFor("u2"), body: {} })).status, 401);
    assert.equal(calls.length, 0);
  });

  test("TST-GW-02 forwards library calls with the internal service token", async () => {
    const response = await send("GET", "/u1");
    assert.equal(response.status, 200);
    assert.equal(storageCalls()[0].url, "http://img_storage:11000/videos/u1");
    assert.equal(storageCalls()[0].headers["x-internal-service-token"], "test-internal-token");
  });
});

describe("upload (UC-VID-001)", () => {
  test("TST-GW-03 blocks anonymous users before reaching storage", async () => {
    accountType = "anonymous";
    const response = await send("POST", "/u1/uploads", { body: { name: "a.mp4", size: 1, mimeType: "video/mp4" } });
    assert.equal(response.status, 403);
    assert.equal(storageCalls().length, 0);
  });

  test("TST-GW-04 sends the account type from the users service, ignoring the client's claim", async () => {
    const response = await send("POST", "/u1/uploads", {
      body: { name: "a.mp4", size: 1, mimeType: "video/mp4", userType: "premium" },
    });
    assert.equal(response.status, 201);
    assert.equal(storageCalls()[0].body.userType, "free");
  });

  test("TST-GW-05 video uploads never consume the daily operation quota", async () => {
    await send("POST", "/u1/uploads", { body: { name: "a.mp4", size: 1, mimeType: "video/mp4" } });
    await send("POST", "/u1/uploads/v1/complete", { body: { uploadId: "x", parts: [] } });
    await send("DELETE", "/u1/uploads/v1");
    assert.equal(chargeCalls().length, 0);
    assert.equal(refundCalls().length, 0);
  });

  test("TST-GW-06 forwards storage errors with their status code", async () => {
    storageFailure = { status: 413, data: { error: "Cloud storage is full." } };
    const response = await send("POST", "/u1/uploads", { body: { name: "a.mp4", size: 1, mimeType: "video/mp4" } });
    assert.equal(response.status, 413);
    assert.deepEqual(response.body, { error: "Cloud storage is full." });
  });
});

for (const [operation, useCase] of [["trim", "UC-VID-004"], ["extract-frames", "UC-VID-003"]]) {
  const id = operation === "trim" ? "TRIM" : "FRAME";
  describe(`${operation} (${useCase})`, () => {
    const start = (body = { start: 0, end: 5 }) => send("POST", `/u1/v1/${operation}`, { body });

    test(`TST-GW-${id}-01 blocks anonymous users without charging an operation`, async () => {
      accountType = "anonymous";
      assert.equal((await start()).status, 403);
      assert.equal(chargeCalls().length, 0);
      assert.equal(storageCalls().length, 0);
    });

    test(`TST-GW-${id}-02 charges one daily operation for registered users before creating the task`, async () => {
      const response = await start({ start: 0, end: 5, userType: "premium" });
      assert.equal(response.status, 201);
      assert.equal(chargeCalls().length, 1);
      assert.ok(calls.indexOf(chargeCalls()[0]) < calls.indexOf(storageCalls()[0]));
      assert.equal(storageCalls()[0].url, `http://img_storage:11000/videos/u1/v1/${operation}`);
      assert.equal(storageCalls()[0].body.userType, "free");
      assert.equal(refundCalls().length, 0);
    });

    test(`TST-GW-${id}-03 refuses the request when the daily quota is exhausted`, async () => {
      quotaAvailable = false;
      const response = await start();
      assert.equal(response.status, 403);
      assert.match(response.body.error, /quota|Quota/);
      assert.equal(storageCalls().length, 0);
    });

    test(`TST-GW-${id}-04 refunds the operation when the task cannot be created`, async () => {
      storageFailure = { status: 400, data: { error: "invalid" } };
      const response = await start();
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { error: "invalid" });
      assert.equal(chargeCalls().length, 1);
      assert.equal(refundCalls().length, 1);
    });

    test(`TST-GW-${id}-05 premium users are never charged`, async () => {
      accountType = "premium";
      storageFailure = { status: 429, data: { error: "busy" } };
      const response = await start();
      assert.equal(response.status, 429);
      assert.equal(chargeCalls().length, 0);
      assert.equal(refundCalls().length, 0);
    });
  });
}
