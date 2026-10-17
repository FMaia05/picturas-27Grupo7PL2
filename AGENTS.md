# PictuRAS repository guide

## Scope and priorities

This file applies to the whole repository. Preserve the existing microservice boundaries and make focused changes. Do not rewrite unrelated student work while implementing a feature. The repository is used for the University of Minho RAS course, so keep requirements traceable in code, configuration, tests, and documentation.

Before editing, inspect `git status` and preserve any user changes. Prefer the service-local package manager and conventions. Do not commit generated files, `node_modules`, database dumps, media uploads, secrets, or local certificates.

## Architecture

- `frontend/`: Next.js 15, React 19, TypeScript, Tailwind and TanStack Query. Browser API calls must use the relative `/api-gateway/` base through `frontend/lib/axios.ts`.
- `apiGateway/`: Express entry point. Browser-facing protected routes validate the JWT here and proxy to an internal service.
- `users/`: authentication and account profiles (`anonymous`, `free`, `premium`). JWTs currently contain the user ID; fetch the validated user when a route needs current profile data.
- `projects/`: projects, image pipelines and RabbitMQ tool orchestration. It owns the project MongoDB deployment on port 27018.
- `subscriptions/`: payment and membership data. Do not confuse it with WebSocket subscriptions.
- `imageStorageService/`: S3 facade backed by SeaweedFS. It handles image objects and the user video library. Video records use the separate `video_library` database in the existing projects MongoDB deployment.
- `wsGateway/`: consumes RabbitMQ events and emits Socket.IO updates.
- `Tools/`: one Python image-processing worker per operation. Reuse shared code in `Tools/utils/`.
- `docker-compose.yaml`: source of truth for service topology, dependencies, environment variables, ports and volumes.
- `nginx/nginx.conf`: the only public application entry point, at `https://localhost:8080`.

Internal services use self-signed HTTPS certificates with verification disabled. SeaweedFS and some development ports are published for debugging. Do not expose a new unauthenticated mutation endpoint merely because the service is normally behind the gateway.

## Video upload design

The video upload use case is implemented across these layers:

1. `frontend/providers/video-upload-provider.tsx` validates files, queues batches, uploads 8 MiB parts, reports progress/rate/ETA, retries transient failures and cancels sessions.
2. `apiGateway/routes/videos.js` verifies JWT ownership, rejects anonymous users and obtains the authoritative account type from `users` before initialization.
3. `imageStorageService/route/videos.js` enforces format, size and storage quota again, manages S3 multipart sessions, checks final object size and exposes library/status operations. These routes require `INTERNAL_SERVICE_TOKEN`.
4. `imageStorageService/services/videoWorker.js` serializes metadata jobs. `videoMetadata.js` downloads the completed object to a temporary file and runs `ffprobe`; invalid or spoofed files are deleted.
5. `imageStorageService/models/video.js` persists ownership, status and duration, resolution, codecs, FPS and rotation.

Supported combinations are MP4 or MOV with H.264 and optional AAC audio, and WebM with VP9 and optional Opus audio. Per-file limits use the requirement's decimal labels represented as `200 * 1024 * 1024` bytes for free users and `2000 * 1024 * 1024` bytes for Premium. Total defaults are 1 GiB and 20 GiB and can be changed through `FREE_VIDEO_QUOTA_BYTES` and `PREMIUM_VIDEO_QUOTA_BYTES`.

Keep multipart parts at least 5 MiB except the final part. Cancellation must abort the S3 multipart upload. Metadata failure must delete the completed object and must not make it visible in the library. Video uploads never call the daily image-operation quota endpoints.

## Video trim design (UC-VID-004)

The video trim use case is implemented across these layers:

1. `frontend/components/trim-video-dialog.tsx` provides video preview, start/end sliders with dynamic duration calculation, plan duration limit validation (300s free / 3600s premium), remaining daily operations counter, target name and "Replace original" option (FA2).
2. `frontend/providers/video-task-provider.tsx` monitors active trim tasks asynchronously without blocking the UI, shows progress and allows cancellation.
3. `apiGateway/routes/videos.js` checks authentication, blocks anonymous users, provisionally charges 1 daily operation on `users:10001` for registered users, proxies to `imageStorageService`, and refunds the operation if job creation fails.
4. `imageStorageService/route/videos.js` validates source format (MP4/MOV with H.264), origin size limits (200MB free / 2GB premium), timestamps (`0 <= start < end <= duration`), segment duration, concurrent active task limits (1 free / 3 premium), and creates a `VideoTask`.
5. `imageStorageService/services/videoTrimWorker.js` executes lossless stream copy (`ffmpeg -ss ... -to ... -c copy -avoid_negative_ts make_zero`), enforces 10-minute timeout, implements 1 automatic internal retry on failure, performs cleanup on fail/cancel, validates storage quota, updates or creates library video, and refunds the operation in `users:10001` on cancellation or failure.
6. `imageStorageService/models/videoTask.js` persists task status (`queued`, `processing`, `completed`, `failed`, `cancelled`), progress, retries and result video ID.

## Video frame extraction design (UC-VID-003)

The frame extraction use case is implemented across these layers:

1. `frontend/components/extract-frames-dialog.tsx` provides video preview, start/end range controls, sampling step (1–60s), output format (PNG/JPEG), destination (new project with editable name or existing project), dynamic calculation of frames and duration, and suggestion of minimum step if limit is exceeded (30 free / 200 premium).
2. `frontend/providers/video-task-provider.tsx` monitors active extraction tasks asynchronously, updates progress (`extractedFramesCount / totalFramesCount`), allows cancellation, and provides direct link to open the project on completion.
3. `apiGateway/routes/videos.js` enforces authentication, rejects anonymous users, provisionally charges 1 daily operation for registered users, forwards to `imageStorageService`, and refunds if task creation fails.
4. `imageStorageService/route/videos.js` validates source video format (MP4/MOV H.264), size (200MB free / 2GB premium), resolution (1080p free / 4K premium), interval duration (120s free / 1800s premium), sampling step (1–60s), frame count (30 free / 200 premium), and concurrent tasks (1 free / 3 premium), creating a `VideoTask` with `type: "extract_frames"`.
5. `imageStorageService/services/videoFrameExtractionWorker.js` downloads video from S3, extracts frames closest to $t_k = \text{start} + k \times \text{step}$ using `ffmpeg` (applying orientation from metadata and format settings), names files `<video>_<hh-mm-ss-mmm>.<ext>`, uploads images to S3 bucket `user-${userId}`, and calls `projects` service internal endpoints (`create-with-frames` or `append-frames`). Enforces 10-minute timeout, 1 internal retry, storage quota check, and cleans up temporary files on any final state.
6. `projects/routes/projects.js` exposes internal endpoints `/internal/:user/create-with-frames` and `/internal/:user/:project/append-frames` protected by `INTERNAL_SERVICE_TOKEN` to persist extracted frames directly into project models without breaking concurrency or tool pipelines.

## Development and validation

Run the smallest relevant checks first:

```bash
cd frontend
npm run build
```

The frontend's `lint` script may be unavailable with the pinned Next.js version; use the production build as the TypeScript and framework check. For Node services, check changed JavaScript with:

```bash
node --check path/to/file.js
```

Validate Compose after topology changes:

```bash
docker compose config --quiet
```

For integration work, build only affected services first:

```bash
docker compose build api_gateway img_storage frontend
docker compose up -d api_gateway img_storage frontend
docker compose logs -f api_gateway img_storage frontend
```

The full application is at `https://localhost:8080`; accept the local certificate warning. Direct frontend port 3000 is not the supported route. Keep `NEXT_PUBLIC_API_BASE_URL=/api-gateway/` to avoid mixed-content and proxy failures.

When changing video ingestion, verify at least one valid file for each supported container, a renamed/corrupt file, an unsupported codec, a file over the plan limit, cancellation after one part, a six-file batch, anonymous access, quota exhaustion, successful metadata persistence, and object cleanup after failure.

## Implementation conventions

- Keep authorization checks at the gateway and ownership filters in the data-owning service.
- Treat client MIME type, extension, size and plan claims as untrusted. Revalidate server-side and inspect completed video content with `ffprobe`.
- Avoid buffering a complete large video in Express memory. Only one multipart chunk may be buffered per request.
- Use S3 object keys generated by the server; retain the original filename only as metadata/display data.
- Send large payload limits only on the narrow route that needs them. Do not raise the global Nginx or Express body limit to 2 GB.
- Delete temporary files in `finally` blocks and tolerate cleanup of already-removed S3 sessions.
- UI uploads should live in a provider above dashboard pages so navigation does not destroy active transfers.
- Prefer existing UI primitives in `frontend/components/ui/` and report user-visible failures with the shared toast hook.
- Add environment defaults to Compose and document values that affect business rules. Never hard-code a new secret in source code.
- Keep README architecture and feature descriptions accurate when adding services, routes or infrastructure.
