const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const timers = require('node:timers/promises');
const { createRabbitClient } = require('../utils/rabbit_mq');
const { persistFrameResults } = require('../utils/frameResults');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function broker() {
  const connections = [];
  const connect = async () => {
    const connection = new EventEmitter();
    const channel = new EventEmitter();
    const events = [];
    const confirmed = [];
    channel.assertExchange = async () => {};
    channel.checkQueue = async queue => { events.push(['check', queue]); };
    channel.prefetch = async count => { events.push(['prefetch', count]); };
    channel.consume = async (queue, deliver, options) => {
      events.push(['consume', queue, options]);
      channel.deliver = deliver;
    };
    channel.ack = msg => { events.push(['ack', msg]); };
    channel.nack = (...args) => { events.push(['nack', ...args]); };
    channel.publish = (exchange, queue, body, options, confirm) => {
      events.push(['publish', exchange, queue, JSON.parse(body), options]);
      confirmed.push(confirm);
    };
    connection.close = async () => connection.emit('close');
    connection.createChannel = connection.createConfirmChannel = async () => channel;
    connections.push({ connection, channel, events, confirmed });
    return connection;
  };
  return { connections, connect };
}

test('publication shares one confirm channel and requests persistence after reconnect', async () => {
  const { connections, connect } = broker();
  const { send_rabbit_msg } = createRabbitClient(connect);
  const first = send_rabbit_msg({ id: 1 }, 'video_queue');
  const second = send_rabbit_msg({ id: 2 }, 'video_preview_queue');
  await timers.setImmediate();
  assert.equal(connections.length, 1);
  assert.deepEqual(connections[0].events, [
    ['publish', 'picturas', 'video_queue', { id: 1 }, { persistent: true }],
    ['publish', 'picturas', 'video_preview_queue', { id: 2 }, { persistent: true }],
  ]);
  connections[0].confirmed.forEach(confirm => confirm());
  await Promise.all([first, second]);
  connections[0].connection.emit('close');
  const third = send_rabbit_msg({ id: 3 }, 'project_queue');
  await timers.setImmediate();
  assert.equal(connections.length, 2);
  assert.deepEqual(connections[1].events[0],
    ['publish', 'picturas', 'project_queue', { id: 3 }, { persistent: true }]);
  connections[1].confirmed[0]();
  await third;
});

test('consumer waits for the callback and rejects a failed delivery to the DLQ', async () => {
  const { connections, connect } = broker();
  const gate = deferred();
  const { read_rabbit_msg } = createRabbitClient(connect);
  read_rabbit_msg('project_queue', async msg => {
    await gate.promise;
    if (msg.fail) throw new Error('irrecoverable reply');
  });
  await timers.setImmediate();
  const { channel, events } = connections[0];
  const ok = { id: 1 };
  channel.deliver(ok);
  await timers.setImmediate();
  assert.equal(events.length, 3);
  gate.resolve();
  await timers.setImmediate();
  assert.deepEqual(events.at(-1), ['ack', ok]);
  const failed = { fail: true };
  channel.deliver(failed);
  await timers.setImmediate();
  assert.deepEqual(events.at(-1), ['nack', failed, false, false]);
});

test('consumer recovers after channel close and connection error with backoff', async () => {
  const { connections, connect } = broker();
  const delays = [];
  let failConnect = false;
  const { read_rabbit_msg } = createRabbitClient(async () => {
    if (failConnect) {
      failConnect = false;
      throw new Error('broker is starting');
    }
    return connect();
  }, async delay => { delays.push(delay); });
  read_rabbit_msg('project_queue', async () => {});
  await timers.setImmediate();
  failConnect = true;
  connections[0].channel.emit('close');
  await timers.setImmediate();
  connections[1].connection.emit('error', new Error('connection lost'));
  await timers.setImmediate();
  assert.deepEqual(delays, [1000, 2000, 1000]);
  assert.equal(connections.length, 3);
  for (const { events } of connections) {
    assert.deepEqual(events.at(-1), ['consume', 'project_queue', { noAck: false }]);
  }
});

test('redelivery waits for the previous channel to finish handling the reply', async () => {
  const { connections, connect } = broker();
  const gate = deferred();
  const calls = [];
  const { read_rabbit_msg } = createRabbitClient(connect, async () => {});
  read_rabbit_msg('project_queue', async msg => {
    calls.push(msg);
    if (calls.length === 1) await gate.promise;
  });
  const msg = { id: 1 };
  await timers.setImmediate();
  connections[0].channel.deliver(msg);
  await timers.setImmediate();
  connections[0].connection.emit('close');
  await timers.setImmediate();
  connections[1].channel.deliver(msg);
  await timers.setImmediate();
  assert.equal(calls.length, 1);
  gate.resolve();
  await timers.setImmediate();
  assert.equal(calls.length, 2);
  assert.ok(!connections[0].events.some(([event]) => event === 'ack'));
  assert.deepEqual(connections[1].events.at(-1), ['ack', msg]);
});

test('an extracted frame kept after a failed rollback stays usable on redelivery', async t => {
  const root = mkdtempSync(join(tmpdir(), 'picturas-frames-retry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = mkdtempSync(join(root, 'frames-'));
  const frames = [0, 1].map(time => {
    const file = join(dir, `frame-${time}.png`);
    writeFileSync(file, 'mock frame');
    return { file, time };
  });
  const output = { type: 'frames', imageURI: dir, frames };
  const process = { img_id: 'video', token: 3, new_img_uri: join(root, 'video.mp4') };
  const rows = new Map();
  const uploads = [];
  const removed = [];
  let failure = true;
  const storage = {
    find: async index => rows.get(index),
    upload: async (_, name) => { uploads.push(name); return name; },
    create: async (data, index) => {
      if (failure && index === 1) throw new Error('second write failed');
      const result = { ...data, _id: index };
      rows.set(index, result);
      return result;
    },
    removeResult: async () => { throw new Error('rollback unavailable'); },
    removeImage: async key => { removed.push(key); },
  };
  await assert.rejects(persistFrameResults(output, process, storage), /second write failed/);
  assert.equal(rows.size, 1);
  assert.deepEqual(removed, []);
  failure = false;
  await persistFrameResults(output, process, storage);
  assert.equal(rows.size, 2);
  assert.deepEqual(uploads, ['video-frame-0.png', 'video-frame-1.png', 'video-frame-1.png']);
});

test('storage outage retries the real reply handler before persisting and removing Process', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'picturas-reply-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const file = join(temp, 'out.mp4');
  writeFileSync(file, 'mock video');

  const Process = require('../controllers/process');
  const Result = require('../controllers/result');
  const Project = require('../controllers/project');
  const messages = require('../utils/project_msg');
  const axios = require('axios');
  const process = { _id: 'job', user_id: 'owner', project_id: 'project', img_id: 'video', token: 3, cur_pos: 0 };
  const project = { activeToken: 3, imgs: [{ _id: 'video', media_type: 'video' }], tools: [{ procedure: 'brightness' }] };
  const steps = [];
  const rows = new Map();
  let elapsed = 0;
  let pending = true;
  const forms = new Set();
  t.mock.method(timers, 'setTimeout', async delay => { elapsed += delay; });
  t.mock.method(Process, 'getOneByMsgId', async () => pending ? process : null);
  t.mock.method(Process, 'update', async (_, __, ___, update) => {
    Object.assign(process, update);
    steps.push('completed');
  });
  t.mock.method(Process, 'countByProjectAndToken', async () => process.completed ? 0 : 1);
  t.mock.method(Process, 'delete', async () => { pending = false; steps.push('delete'); });
  t.mock.method(Project, 'getOne', async () => project);
  t.mock.method(Project, 'commitRunIfActive', async (_, __, token, tools) => {
    steps.push('commit');
    Object.assign(project, { committedToken: token, committedTools: tools });
    return project;
  });
  t.mock.method(Result, 'findByDelivery', async id => rows.get(id));
  t.mock.method(Result, 'createOnce', async (id, data) => {
    steps.push('result');
    rows.set(id, data);
    throw new Error('response to the acknowledged MongoDB write was lost');
  });
  t.mock.method(messages, 'send_msg_client', async () => { steps.push('notify'); });
  t.mock.method(messages, 'send_msg_client_error', async () => { steps.push('error'); });
  t.mock.method(axios, 'post', async (url, form, options) => {
    assert.match(url, /\/upload\/owner\/project\/out$/);
    assert.equal(options.timeout, 30_000);
    assert.equal(pending, true);
    assert.ok(!forms.has(form), 'multipart upload must be rebuilt');
    forms.add(form);
    if (elapsed < 40_000) {
      const error = elapsed % 2_000 ? { response: { status: 503 } } : { code: 'ECONNREFUSED' };
      throw Object.assign(new Error('storage down'), error);
    }
    steps.push('upload');
    return { data: { data: { imageKey: 'project/out/key.mp4' } } };
  });

  const { handleProcessMessage } = require('../routes/projects');
  const msg = { content: Buffer.from(JSON.stringify({
    correlationId: 'request-job', status: 'success', output: { type: 'video', imageURI: file },
  })) };
  await assert.rejects(handleProcessMessage(msg), /MongoDB write was lost/);
  assert.equal(elapsed, 45_000);
  assert.equal(pending, true);
  assert.equal(rows.size, 1);
  assert.deepEqual(steps, ['upload', 'result', 'error']);
  await handleProcessMessage(msg);
  await handleProcessMessage(msg);
  assert.deepEqual(steps, ['upload', 'result', 'error', 'completed', 'commit', 'notify', 'delete']);
  assert.equal(rows.size, 1);
  assert.equal(project.committedToken, 3);
});
