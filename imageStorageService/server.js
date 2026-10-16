const express = require("express");
const uploadRoutes = require("./route/upload");
const imageRoutes = require("./route/images");
const deleteRoutes = require("./route/delete");
const copyRoutes = require("./route/copy"); 
const videoRoutes = require("./route/videos");
const mongoose = require("mongoose");
const Video = require("./models/video");
const VideoTask = require("./models/videoTask");
const enqueueVideo = require("./services/videoWorker");
const { enqueueTrimTask } = require("./services/videoTrimWorker");
const s3 = require("./services/s3Client");

const app = express();
const videoMongoDB = "mongodb://projects_mongoDB:27018/video_library";

app.use(express.json());
app.use("/upload", uploadRoutes);
app.use("/image", imageRoutes);
app.use("/delete", deleteRoutes);
app.use("/copy", copyRoutes); 
app.use("/videos", videoRoutes);

mongoose
  .connect(videoMongoDB)
  .then(async () => {
    console.log("Video library database connected");
    const interrupted = await Video.find({ status: "processing" }).select("_id");
    interrupted.forEach((video) => enqueueVideo(video._id));

    const interruptedTasks = await VideoTask.find({ status: { $in: ["queued", "processing"] } }).select("_id");
    interruptedTasks.forEach((task) => enqueueTrimTask(task._id));

    const staleBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stale = await Video.find({ status: "uploading", updatedAt: { $lt: staleBefore } });
    for (const video of stale) {
      await s3.abortMultipartUpload({
        Bucket: `user-${video.userId}`,
        Key: video.objectKey,
        UploadId: video.uploadId,
      }).promise().catch(() => {});
      await video.deleteOne();
    }
  })
  .catch((error) => console.error("Video library database connection failed", error));

const PORT = process.env.PORT || 11000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
