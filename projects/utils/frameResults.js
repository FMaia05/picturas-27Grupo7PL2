const fs = require('fs');
const path = require('path');

// Validate every file before uploading anything, and keep each video's names unique
// in the shared result ZIP. Paths must stay inside this job's output directory.
function frameFiles(output, process, appRoot = path.resolve(__dirname, '..')) {
  if (!Array.isArray(output.frames) || output.frames.length < 1 || output.frames.length > 100) {
    throw new Error('Frame extraction must return between 1 and 100 images');
  }
  const parent = fs.realpathSync(path.dirname(path.resolve(appRoot, process.new_img_uri)));
  const directory = fs.realpathSync(path.resolve(appRoot, output.imageURI));
  if (!directory.startsWith(parent + path.sep) || !fs.statSync(directory).isDirectory()) {
    throw new Error('Invalid frame output directory');
  }
  const seen = new Set();
  return output.frames.map((frame) => {
    if (typeof frame.file !== 'string' || !Number.isFinite(frame.time) || frame.time < 0) {
      throw new Error('Invalid extracted frame');
    }
    const file = fs.realpathSync(path.resolve(appRoot, frame.file));
    if (!file.startsWith(directory + path.sep) || !fs.statSync(file).isFile() ||
        !/\.(png|jpe?g)$/i.test(file) || seen.has(file)) {
      throw new Error('Invalid extracted frame path');
    }
    seen.add(file);
    return { file, name: `${process.img_id}-${path.basename(file)}` };
  });
}

async function persistFrameResults(output, process, storage, appRoot) {
  const files = frameFiles(output, process, appRoot);
  const created = [];
  let unregistered;
  try {
    for (const [index, { file, name }] of files.entries()) {
      if (storage.find && await storage.find(index)) continue;
      const key = await storage.upload(file, name);
      unregistered = key;
      const result = await storage.create({
        type: 'image', file_name: name, img_key: key, img_id: process.img_id,
        project_id: process.project_id, user_id: process.user_id, token: process.token || 0,
      }, index);
      created.push({ id: result._id, key });
      unregistered = undefined;
    }
  } catch (error) {
    // Failed outputs are never committed. Best-effort cleanup must not hide the
    // original error; the caller retains the Process record as a commit barrier.
    // With durable IDs, leave an upload whose MongoDB write outcome is unknown
    // in place so an acknowledged record cannot point at a deleted object.
    const cleanup = created.map(async ({ id, key }) => {
      await storage.removeResult(id);
      await storage.removeImage(key);
    });
    if (unregistered && !storage.find) cleanup.push(storage.removeImage(unregistered));
    await Promise.allSettled(cleanup);
    throw error;
  }
}

module.exports = { frameFiles, persistFrameResults };
