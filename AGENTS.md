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

<<<<<<< HEAD
## Video frame extraction design (UC-VID-003)

The frame extraction use case is implemented across these layers:

1. `frontend/components/extract-frames-dialog.tsx` provides video preview, start/end range controls, sampling step (1–60s), output format (PNG/JPEG), destination (new project with editable name or existing project), dynamic calculation of frames and duration, and suggestion of minimum step if limit is exceeded (30 free / 200 premium).
2. `frontend/providers/video-task-provider.tsx` monitors active extraction tasks asynchronously, updates progress (`extractedFramesCount / totalFramesCount`), allows cancellation, and provides direct link to open the project on completion.
3. `apiGateway/routes/videos.js` enforces authentication, rejects anonymous users, provisionally charges 1 daily operation for registered users, forwards to `imageStorageService`, and refunds if task creation fails.
4. `imageStorageService/route/videos.js` validates source video format (MP4/MOV H.264), size (200MB free / 2GB premium), resolution (1080p free / 4K premium), interval duration (120s free / 1800s premium), sampling step (1–60s), frame count (30 free / 200 premium), and concurrent tasks (1 free / 3 premium), creating a `VideoTask` with `type: "extract_frames"`.
5. `imageStorageService/services/videoFrameExtractionWorker.js` downloads video from S3, extracts frames closest to $t_k = \text{start} + k \times \text{step}$ using `ffmpeg` (applying orientation from metadata and format settings), names files `<video>_<hh-mm-ss-mmm>.<ext>`, uploads images to S3 bucket `user-${userId}`, and calls `projects` service internal endpoints (`create-with-frames` or `append-frames`). Enforces 10-minute timeout, 1 internal retry, storage quota check, and cleans up temporary files on any final state.
6. `projects/routes/projects.js` exposes internal endpoints `/internal/:user/create-with-frames` and `/internal/:user/:project/append-frames` protected by `INTERNAL_SERVICE_TOKEN` to persist extracted frames directly into project models without breaking concurrency or tool pipelines.
=======
## Video conversion design (UC-VID-002)

This Phase 1 MVP follows `RAS_converter_video_revisto.md` v1.3. It converts an entire video already in the library, preserves the original and adds a new result to the same account. Reuse the existing authentication, library, MongoDB, SeaweedFS and daily operation counter; no new microservice or npm dependency is needed. The academic use-case identifier still requires confirmation by the team.

The video conversion use case is implemented across these layers:

1. `frontend/components/convert-video-dialog.tsx` displays inspected source metadata, plan limits, remaining operations and a configuration summary. Destinations are MP4/H.264/AAC and WebM/VP9/Opus; resolution options are preserve and reduce to 720p without upscaling. Conversion to the same profile is allowed.
2. `frontend/providers/video-conversion-provider.tsx` contains the frontend conversion types/API requests and polls persisted tasks every two seconds after the previous response, surviving dashboard navigation. The dialog and task list import these shared definitions directly from the provider. `video-conversion-tasks.tsx` displays progress, cancellation, errors and download. Its trash button only hides the card for the current provider lifetime: it does not cancel the task or delete the video/database record; reloading restores the card.
3. `apiGateway/routes/videoConversions.js` validates JWT ownership explicitly, even with `?share=...`, rejects anonymous users and obtains the current plan from `users`. Client plan claims are ignored.
4. `imageStorageService/route/videoConversions.js` requires `INTERNAL_SERVICE_TOKEN`, checks source ownership/readiness and inspects real content before accepting a task. Preflight results have an in-memory cache limited to 100 entries/10 minutes, keyed by account, video, object key, size and plan; the worker revalidates the downloaded input.
5. `imageStorageService/services/videoConversionMedia.js` uses ffprobe and real frame timestamps for input/output validation, including EBML DocType to distinguish WebM from renamed Matroska. FFmpeg is spawned with controlled argument arrays, without a shell. It transcodes video and optional audio, applies orientation to pixels and strips arbitrary metadata; stream copy is insufficient for this use case.
6. `imageStorageService/services/videoConversionWorker.js` serializes conversions using a persisted MongoDB queue in the existing storage service. It also contains and exports the `quota` HTTP helper used by the route for reservation and by the worker for confirmation/release; the quota rules remain in users. `models/videoConversionTask.js` stores configuration, owner, source/result IDs and keys, deadline and states: `queued`, `processing`, `completed`, `failed`, `cancelled`. Progress is estimated and reaches 100 only on completion.
7. `users/services/operationQuota.js` and `users/routes/conversionQuota.js` reserve one daily operation for free accounts on acceptance, confirm without a second debit, and release once on failure/cancellation. Premium creates an uncharged receipt. Receipts live in `conversionReservations` on the user; the shared counter remains `operations[].processed`.

Limits are centralized in `imageStorageService/config/videoConversion.js`: **200,000,000 bytes / 120 seconds for free**, **500,000,000 bytes / 300 seconds for Premium**, inclusive, and **900 seconds total** including queueing and finalization. Conversion uses decimal MB independently of upload/Trim limits. Inputs must be MP4/MOV with H.264 and optional AAC or WebM with VP9 and optional Opus: one video track, zero/one mono or stereo audio track, no extra tracks, even dimensions, square pixels, SDR, at most 1920 on the longer side and 1080 on the shorter side, orthogonal rotation and constant frame rate up to 30 fps. Timestamp quantization tolerance is 2 ms.

The 720p option fits within 1280/720 on the longer/shorter sides, preserves orientation and aspect ratio within 1%, and never enlarges the image. Outputs preserve fps and audio channels; silent inputs stay silent. Validate a nonempty readable output, expected codecs/dimensions/orientation and duration within 0.5 seconds of the source. Current encoder settings use two threads: x264 veryfast/CRF 23 with AAC 128 kbit/s, or VP9 realtime/cpu-used 6/CRF 32 with Opus 96 kbit/s. Synchronization detection belongs only in tests with known samples, not arbitrary user videos.

Atomic state conditions decide races between cancellation, finalization and late completion. Cancellation returns 409 when finalization has already won. A result gets a new server-generated S3 key and optional `sourceVideoId`/`conversionTaskId` fields in the existing video model; the unique sparse task index prevents duplicate results. Pending conversion outputs use the existing non-public `failed` video status until publication, so upload recovery does not pick them up. This internal video status is separate from the conversion task status.

Persisted `accepted`, `finalizing`, `settled` and `cleaned` flags support compensation across MongoDB/S3, which do not share a transaction. On startup, queued/processing conversions fail and are compensated; a recorded completed decision finishes publication. Conversion requests return 503 until reconciliation finishes. Compensation/cleanup is revisited after transient errors; video processing itself is never retried or resumed. Delete temporary files and incomplete outputs, preserve originals, and do not expire published results automatically.

Public API base: `/api-gateway/video-conversions/:user`. All routes require the authenticated owner and a free/Premium account:

| Method / suffix | Contract |
| --- | --- |
| POST `source/:videoId` | Inspect the source and return metadata/limits. |
| POST `source/:videoId/convert` | Accept `{ target: "mp4" or "webm", resolution: "preserve" or "720p" }`; return 202 with `taskId` and status. |
| GET `tasks` / GET `tasks/:taskId` | Account history or task details, including terminal states. |
| POST `tasks/:taskId/cancel` | Cancel; repeated accepted cancellation is idempotent. |
| GET `tasks/:taskId/download` | Issue a signed attachment URL only for the owner's completed, ready result. |

Internal storage routes use `/video-conversions`; `users` exposes `POST /:user/conversion-quota/:id/:action` for `reserve`, `confirm`, `release`. Use the same `INTERNAL_SERVICE_TOKEN` in gateway, storage and users. Keep `FREE_DAILY_OP` (default 5), `FREE_VIDEO_QUOTA_BYTES`, `PREMIUM_VIDEO_QUOTA_BYTES` and the existing `USERS_URL` interfaces.

### Shared integration and compatibility boundaries

- Keep the conversion router registrations in `apiGateway/app.js` and `imageStorageService/server.js`, and its independent recovery listener. Preserve the existing upload/Trim startup sequence.
- Keep the conversion provider in `frontend/app/dashboard/layout.tsx` and the action/dialog/task list additions in `frontend/components/video-library.tsx`. Do not change upload/Trim workers, providers or dialogs for conversion work.
- The authorized protection in `apiGateway/routes/videos.js` sends `x-conversion-caller-id` from the validated JWT, ignoring the client header. In `imageStorageService/route/videos.js`, `videoConversionAccess.js` adds only a condition on `conversionTaskId` and must never replace existing owner/status filters. Missing or foreign caller context hides conversion results; legacy records keep their existing behavior.
- `videoConversionDownload.js` signs conversion results for the public Host without the port, matching Nginx's `$host` and stripped `/s3` path, then adds the browser port/prefix. The library selects this helper only for conversion records. **URLs remain usable capabilities for 300 seconds (five minutes), including by anyone given the URL.** The task download action obtains a fresh URL; an expired library link may require refreshing the page. Do not change this model or the upload/Trim URL helper without discussing the change.
- The authorized quota integration spans `users/app.js`, `users/models/user.js`, `users/controllers/user.js`, `users/routes/users.js` and the new quota modules. Keep atomic shared debits, identified conversion reservations and protection against stale profile/password updates overwriting quotas. Production callers of `User.update`/`User.updatePassword` were inspected: only profile/password routes remain; quota writes use `operationQuota`. Internal auth applies only to the new reservation route.
- Preserve the original day calculation: UTC date components converted to service-local midnight; the users container runs UTC. Conversion releases correct the original receipt day and charge even after a plan change. Legacy refunds retain the current-day/current-plan policy and are not made idempotent by this integration. Premium legacy debits still record usage; Premium conversion reserves no daily debit.
- Retain the compatibility fixes: zero-cost legacy operations remain allowed after a downgrade even above the free limit; PUT success is 204, insufficient quota 799, user/read error 701 and write error 704; missing-user legacy refund is 701. Hide conversion receipts in login responses as well as model JSON. `charge` rejects negative/unsafe counts: this is an explicit difference from accidental acceptance of invalid inputs in the old implementation, not equivalence for every malformed request.
- `docker-compose.yaml` only adds the shared token to users. README and `.env.example` document the integration. The compatibility review retained all 14 previously modified files; its final pass changed tests/documentation only. Do not revert whole shared files or silently expand these changes into other features.

Preexisting findings for the team, not conversion fixes: the image-sharing JWT middleware permits an owner mismatch with `?share=...` on old video records; generic `GET /:user/:videoId` routes precede and can shadow the old Trim task-list route; legacy refunds lack an operation identifier. The conversion has its own ownership protection, but this does not certify the entire old library. Ask before changing shared functional rules.

The MVP assumes one `img_storage` instance. Total space is checked through the existing library data; cross-feature storage-quota races with upload/Trim are not solved transactionally. Multiple replicas, high availability, batch/chained conversion, advanced codec options, automatic retry/resume, emails and stricter future production performance/TLS targets are outside this MVP.
>>>>>>> origin/feature/converter-video

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

### Video conversion validation

To use the feature, sign in at `https://localhost:8080` as free/Premium, upload a supported video and wait for metadata, choose **Converter vídeo**, review the source/configuration and confirm. Follow the persisted task in **Conversões de vídeo**, cancel while allowed or download after completion. The original remains in the library.

With the existing infrastructure already running, rebuild the affected services from the repository root:

```bash
docker compose build api_gateway users img_storage frontend
docker compose up -d --no-deps users api_gateway img_storage frontend
docker compose logs --tail=100 users api_gateway img_storage frontend
```

For a first installation, follow the README Quick Start first. Do not delete volumes to install or test. If the existing anonymous `.next` volume still contains an old frontend build, run `docker compose exec -T frontend npm run build` and restart only frontend. If Nginx retains an old service IP after recreation, restart Nginx.

The seven automated test files added for conversion were removed at the author's request. They were development checks and are not runtime dependencies. The results below record executions before removal; those suites are no longer available to rerun from this working tree. Use the build/syntax checks above and the manual validation scenarios below with dedicated test accounts and files. Never delete existing accounts or volumes to validate the feature.

Recorded evidence from 2026-10-17 (historical results, not new executions whenever this guide is edited):

| Verification | Recorded result and scope |
| --- | --- |
| Final compatibility review: quota integration | 11/11 including the parent test; legacy contracts, profiles/password, accounts without receipts, previous days, mixed concurrent debits/reservations and single release. |
| Final review: gateway auth | 6/6 including parent; real JWT, simulated service transport, ownership, anonymous rejection, authoritative plan, `share` and forged headers. |
| Final review: video integration | 14/14 including parent; real MongoDB/S3/FFmpeg, both conversion destinations with/without audio, ownership, originals, duplicates, failures, cancellation, deadline and reconciliation, existing MP4/MOV upload and successful Trim worker. |
| Final review: static checks | TypeScript without emitting files, syntax checks on 15 JavaScript files, Compose validation and diff whitespace checks passed. |
| Earlier implementation checks | Media validation 6/6; complete FFmpeg suite 6/6 including parent, with later additional renamed-MKV/corrupt-input cases passing. Frontend production build and public HTTPS upload/conversion/download/Trim smoke test passed. These were not rerun in the final review. |

The final review's five 30-second 1280x720/30-fps reference conversions took 9.058, 8.354, 8.257, 8.877 and 8.444 seconds, including persistence/validation after cached preflight. Twenty cached internal API submissions took 0.036–0.113 seconds. These are local measurements, not browser latency or guarantees for all videos/hardware. Earlier known flash/sound samples measured 0 ms change in A/V offset for both targets; arbitrary-video sync detection is not part of the product.

State test coverage precisely: deadline tests move the stored deadline into the past rather than waiting 900 seconds; restart tests seed interrupted states and call recovery rather than killing the real service at every instruction. The final integration test charges quota directly before invoking the storage Trim route and checks refund separately; it does not cover the complete public Trim route, cancellation/retry/replacement. Do not claim absence of all regressions from these checks.

Still pending: real-browser navigation/reload/progress/accessibility and downloads, physical files near 200/500 MB, real service interruption during conversion, complete upload/Trim UI scenarios and a real image pipeline. The removed image compatibility test was prepared but never executed because its execution was declined; the historical quota-contract checks do not replace that pipeline. No cryptographic audit of the existing storage volume/TLS setup was performed. Coordinate these checks with the team using only dedicated test data.

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
