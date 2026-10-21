// Test doubles for the video storage service. They replace Mongoose models and
// the S3 client through the CommonJS module cache, so routes and workers run
// unchanged without MongoDB or SeaweedFS.
const crypto = require("crypto");
const { Readable } = require("stream");

function stubModule(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
  return exports;
}

function objectId() {
  return crypto.randomBytes(12).toString("hex");
}

function asDoc(collection, data) {
  const doc = { _id: data._id || objectId(), ...data };
  Object.defineProperty(doc, "id", { get: () => String(doc._id), enumerable: false });
  doc.save = async () => doc;
  doc.deleteOne = async () => {
    const index = collection.indexOf(doc);
    if (index >= 0) collection.splice(index, 1);
  };
  return doc;
}

function plain(doc) {
  if (!doc) return doc;
  const { save, deleteOne, ...rest } = doc;
  return { ...rest, _id: String(doc._id) };
}

function query(resolveValue) {
  const chain = {
    sort: () => chain,
    select: () => chain,
    lean: async () => {
      const value = await resolveValue();
      return Array.isArray(value) ? value.map(plain) : plain(value);
    },
    then: (onFulfilled, onRejected) => Promise.resolve(resolveValue()).then(onFulfilled, onRejected),
  };
  return chain;
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = doc[key];
    // MongoDB: { field: null } matches documents where the field is null or missing.
    if (expected === null) return actual === null || actual === undefined;
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$in" in expected) return expected.$in.includes(actual);
      if ("$ne" in expected) return actual !== expected.$ne;
      if ("$lt" in expected) return actual < expected.$lt;
    }
    return String(actual) === String(expected);
  });
}

// `defaults` mirrors the Mongoose schema defaults of the replaced model.
function createModel(defaults = {}) {
  const docs = [];
  return {
    docs,
    insert(data) {
      const doc = asDoc(docs, { ...defaults, ...data });
      docs.push(doc);
      return doc;
    },
    async create(data) {
      return this.insert(data);
    },
    findOne(filter) {
      return query(() => docs.find((doc) => matches(doc, filter)) || null);
    },
    find(filter = {}) {
      return query(() => docs.filter((doc) => matches(doc, filter)));
    },
    findById(id) {
      return query(() => docs.find((doc) => String(doc._id) === String(id)) || null);
    },
    async countDocuments(filter) {
      return docs.filter((doc) => matches(doc, filter)).length;
    },
    async updateOne(filter, update) {
      const doc = docs.find((candidate) => matches(candidate, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(doc, update.$set || {});
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async aggregate(pipeline) {
      const match = pipeline.find((stage) => stage.$match)?.$match || {};
      const selected = docs.filter((doc) => matches(doc, match));
      if (!selected.length) return [];
      return [{ _id: null, total: selected.reduce((sum, doc) => sum + (doc.size || 0), 0) }];
    },
  };
}

async function streamToBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function createS3() {
  const objects = new Map();
  const calls = { deleted: [], aborted: [], uploaded: [], parts: [], completed: [], created: [] };
  const done = (value) => ({ promise: async () => value });
  const keyOf = ({ Bucket, Key }) => `${Bucket}/${Key}`;

  return {
    objects,
    calls,
    headSize: null,
    put(bucket, key, buffer) {
      objects.set(`${bucket}/${key}`, buffer);
    },
    createMultipartUpload(params) {
      calls.created.push(params);
      return done({ UploadId: `upload-${calls.created.length}` });
    },
    uploadPart(params) {
      calls.parts.push(params);
      return done({ ETag: `"etag-${params.PartNumber}"` });
    },
    completeMultipartUpload(params) {
      calls.completed.push(params);
      return done({});
    },
    abortMultipartUpload(params) {
      calls.aborted.push(params);
      return done({});
    },
    headObject(params) {
      return done({ ContentLength: this.headSize ?? objects.get(keyOf(params))?.length ?? 0 });
    },
    deleteObject(params) {
      calls.deleted.push(keyOf(params));
      objects.delete(keyOf(params));
      return done({});
    },
    getObject(params) {
      return {
        createReadStream: () => {
          const data = objects.get(keyOf(params));
          if (!data) {
            const stream = new Readable({ read() {} });
            process.nextTick(() => stream.destroy(new Error("NoSuchKey")));
            return stream;
          }
          return Readable.from([data]);
        },
      };
    },
    upload(params) {
      return {
        promise: async () => {
          const buffer = await streamToBuffer(params.Body);
          objects.set(keyOf(params), buffer);
          calls.uploaded.push({ key: keyOf(params), contentType: params.ContentType, size: buffer.length });
          return { Key: params.Key };
        },
      };
    },
  };
}

async function waitFor(predicate, { timeout = 20000, interval = 25 } = {}) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

module.exports = { stubModule, createModel, createS3, objectId, waitFor };
