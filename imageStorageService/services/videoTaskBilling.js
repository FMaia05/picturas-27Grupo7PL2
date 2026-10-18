const https = require("https");
const VideoTask = require("../models/videoTask");

const USERS_URL = process.env.USERS_URL || "https://users:10001/";
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function videoStorageQuota(userType) {
  return userType === "premium"
    ? Number(process.env.PREMIUM_VIDEO_QUOTA_BYTES || 20 * 1024 ** 3)
    : Number(process.env.FREE_VIDEO_QUOTA_BYTES || 1024 ** 3);
}

async function refundOperation(userId) {
  try {
    const url = new URL(`${userId}/process/refund/1`, USERS_URL);
    await new Promise((resolve) => {
      const req = https.request(
        url,
        {
          method: "POST",
          agent: httpsAgent,
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          res.resume();
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.warn(`Refund returned status ${res.statusCode} for user ${userId}`);
          }
          resolve(); // Do not crash worker on refund failure
        },
      );
      req.on("error", (err) => {
        console.error(`Refund network error for user ${userId}:`, err.message);
        resolve(); // Continue even if users service has transient error
      });
      req.end();
    });
  } catch (error) {
    console.error(`Refund failed for user ${userId}:`, error.message);
  }
}

// The cancel endpoint and the worker can both move the same task to a final
// state, so the refund is claimed atomically in MongoDB and sent at most once.
async function refundTaskOperation(task) {
  if (!task.chargedOperation) return false;
  const { modifiedCount } = await VideoTask.updateOne(
    { _id: task._id, refunded: { $ne: true } },
    { $set: { refunded: true } },
  );
  if (!modifiedCount) return false;
  await refundOperation(task.userId);
  return true;
}

module.exports = { refundTaskOperation, videoStorageQuota };
