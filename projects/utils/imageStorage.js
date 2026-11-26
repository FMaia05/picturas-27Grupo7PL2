const axios = require("axios");
const { setTimeout: sleep } = require("node:timers/promises");

const fs = require("fs");
const { pipeline } = require("node:stream/promises");
const { randomUUID } = require("node:crypto");

const key = fs.readFileSync(__dirname + "/../certs/selfsigned.key");
const cert = fs.readFileSync(__dirname + "/../certs/selfsigned.crt");

const https = require("https");
const httpsAgent = new https.Agent({
  rejectUnauthorized: false, // (NOTE: this will disable client verification)
  cert: cert,
  key: key,
});

const img_storage_ms = "http://img_storage:11000";

async function get_image_internal_url(user, project, type, img) {
  return await axios.get(
    `${img_storage_ms}/image/internal/${user}/${project}/${type}/${img}` /* , { httpsAgent: httpsAgent } */,
  );
}

async function get_image_public_url(user, project, type, img, options) {
  return await axios.get(
    `${img_storage_ms}/image/public/${user}/${project}/${type}/${img}`, options,
  );
}

async function post_image(user, project, type, file, options) {
  return await axios.post(
    `${img_storage_ms}/upload/${user}/${project}/${type}`,
    file /* , { httpsAgent: httpsAgent } */,
    // Videos can be hundreds of MB
    { maxBodyLength: Infinity, maxContentLength: Infinity, headers: file.getHeaders ? file.getHeaders() : undefined, ...options },
  );
}

async function delete_image(user, project, type, img) {
  return await axios.delete(
    `${img_storage_ms}/delete/${user}/${project}/${type}/${img}` /* , { httpsAgent: httpsAgent } */,
  );
}

async function copy_image(userId, projectId, fromStage, toStage, fileName, options) {
  // usa o mesmo serviço interno (docker network) tal como as outras
  return axios.post(
    `${img_storage_ms}/copy/${userId}/${projectId}/${fromStage}/${toStage}/${fileName}`,
    {}, options
  );
}

// Download a source to the shared volume. The rename makes it atomic: another worker
// may be reading the same source for an edit or a preview.
async function download_source(url, dest) {
  const tmp = `${dest}.${randomUUID()}.download`;
  try {
    const response = await axios.get(url, { responseType: "stream" });
    await pipeline(response.data, fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

const transientCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE",
  "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH",
]);

async function retry_image_storage(operation, wait = sleep) {
  // Even immediate connection failures get an attempt after 55 seconds.
  const delays = [1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000, 10_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation({ timeout: 30_000 });
    } catch (error) {
      const status = error.response?.status;
      const transient = status ? status >= 500 && status < 600 : transientCodes.has(error.code);
      if (!transient || attempt === delays.length) throw error;
      await wait(delays[attempt]);
    }
  }
}

module.exports = { download_source, retry_image_storage, get_image_internal_url, get_image_public_url, post_image, delete_image, copy_image };