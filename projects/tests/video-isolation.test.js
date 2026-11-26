const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { videoJobOutput, isLargeVideo } = require('../utils/video');
const { videoQueue } = require('../utils/project_msg');
const { download_source } = require('../utils/imageStorage');

test('two jobs of the same video never share their output, and keep the file name', () => {
  const uri = './images/users/u/projects/p/out/clip.mp4';
  assert.notEqual(videoJobOutput(uri, 'request-1'), videoJobOutput(uri, 'request-2'));
  assert.equal(videoJobOutput(uri, 'request-1'), './images/users/u/projects/p/out/request-1/clip.mp4');
});

test('a source being read by a worker is replaced whole, never truncated', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dest = path.join(dir, 'clip.mp4');
  fs.writeFileSync(dest, 'previous');
  let whileDownloading;
  const server = http.createServer((req, res) => {
    if (req.url === '/broken') { res.write('half'); return setTimeout(() => res.destroy(), 20); }
    res.write('new ');
    setTimeout(() => { whileDownloading = fs.readFileSync(dest, 'utf8'); res.end('content'); }, 20);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;

  await download_source(url, dest);
  assert.equal(whileDownloading, 'previous');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'new content');

  await assert.rejects(download_source(`${url}/broken`, dest));
  assert.equal(fs.readFileSync(dest, 'utf8'), 'new content');
  assert.deepEqual(fs.readdirSync(dir), ['clip.mp4']);
});

test('videos above 1080p go to the worker with memory for them; 1080p stays', () => {
  const resize = (width, height) => [{ procedure: 'resize', params: { width, height } }];
  assert.equal(isLargeVideo({ width: 1920, height: 1080 }), false);
  assert.equal(isLargeVideo({ width: 1080, height: 1920 }), false);
  assert.equal(isLargeVideo({ width: 3840, height: 2160 }), true);
  assert.equal(isLargeVideo({ width: 640, height: 360 }, resize(3840, 2160)), true);
  assert.equal(isLargeVideo({ width: 640, height: 360 }, resize(1280, 720)), false);
  assert.equal(isLargeVideo(undefined), false);
  for (const preview of [true, false]) {
    assert.equal(videoQueue({ tools: [], preview, large: true }), 'video_subtitles_queue');
    assert.equal(videoQueue({ tools: [], preview, large: false }), preview ? 'video_preview_queue' : 'video_queue');
  }
});
