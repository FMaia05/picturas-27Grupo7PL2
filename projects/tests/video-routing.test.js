const test = require('node:test');
const assert = require('node:assert/strict');
const { videoQueue } = require('../utils/project_msg');

const effect = procedure => ({ procedure, params: {} });

test('subtitles take precedence for Apply and Preview, including a terminal extractor', () => {
  const tools = [effect('brightness'), effect('subtitles'), effect('extract_frames')];
  assert.equal(videoQueue({ tools, preview: false }), 'video_subtitles_queue');
  assert.equal(videoQueue({ tools, preview: true }), 'video_subtitles_queue');
});

test('ordinary previews and extraction contact sheets go to the preview queue', () => {
  for (const tools of [[], [effect('brightness')], [effect('extract_frames')]]) {
    assert.equal(videoQueue({ tools, preview: true }), 'video_preview_queue');
  }
});

test('ordinary Apply and full extraction go to the editing queue', () => {
  for (const tools of [[], [effect('brightness')], [effect('extract_frames')]]) {
    assert.equal(videoQueue({ tools, preview: false }), 'video_queue');
  }
});
