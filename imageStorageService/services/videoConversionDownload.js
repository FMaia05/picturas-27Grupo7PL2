const AWS = require('aws-sdk');
const s3 = require('./s3Client');
const origin = new URL(process.env.FRONTEND_URL || 'https://localhost:8080');
// Nginx forwards $host (without port) and strips /s3. Sign precisely the host/path
// received by SeaweedFS, then add the browser's port and proxy prefix to the URL.
// This affects conversion results only; existing upload/Trim URL helpers are untouched.
const signer = new AWS.S3({
  endpoint: `${origin.protocol}//${origin.hostname}`,
  credentials: s3.config.credentials,
  region: s3.config.region,
  s3ForcePathStyle: true,
  signatureVersion: 'v4',
});
module.exports = async function downloadUrl(video) {
  const url = await signer.getSignedUrlPromise('getObject', {
    Bucket: `user-${video.userId}`, Key: video.objectKey, Expires: 300,
    ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(video.originalName).replace(/'/g, '%27')}`,
  });
  return url.replace(`${origin.protocol}//${origin.hostname}`, `${origin.origin}/s3`);
};
