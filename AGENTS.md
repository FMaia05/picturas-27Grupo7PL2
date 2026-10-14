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
