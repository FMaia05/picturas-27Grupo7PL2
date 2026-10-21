---
name: picturas-video-tests
description: Write and run automated tests for PictuRAS video features (imageStorageService routes and workers, apiGateway video routes) using the Node built-in test runner, in-memory fakes and real ffmpeg, and record results with TST IDs traceable to requirements. Use when asked to test a video feature, verify a requirement, reproduce a video bug or update the test report.
---

# Testing PictuRAS video features

## Tooling

- Runner: Node built-in `node:test` + `node:assert/strict`. No extra dependencies.
- `npm test` in `imageStorageService/` and `apiGateway/` runs `test/*.test.js` serially.
- ffmpeg/ffprobe suites skip automatically when the binaries are missing. The `img_storage`
  image installs ffmpeg, so the complete run is:
  `docker compose build img_storage && docker compose run --rm --no-deps img_storage npm test`.

## How the fakes work (`imageStorageService/test/helpers/`)

- `fakes.js` – `stubModule(absPath, exports)` places a fake in the CommonJS cache **before** the
  module under test is required. `createModel(defaults)` imitates the Mongoose calls used in the
  service (`findOne/find/findById` with `.sort().lean()`, `create`, `countDocuments`,
  `updateOne` with `$ne`, `aggregate` sum of `size`). Pass the schema defaults so documents look
  like real ones. `createS3()` keeps objects in a `Map` and records calls
  (`deleted`, `aborted`, `uploaded`, `parts`, `completed`, `created`).
- `server.js` – mounts a router on an ephemeral port and calls it with `fetch`.
- `ffmpeg.js` – `createFixtures()` generates MP4 (H.264+AAC, keyframe each second), MOV, WebM
  (VP9+Opus), MPEG-4 Part 2, a WebM renamed to `.mp4` and a corrupt file.
- `https.js` – `interceptHttps(respond)` records refund calls to `users` and fallback calls to
  `projects`.
- Gateway tests mock `axios.get/post/put/delete` with `mock.method` and sign JWTs with
  `JWT_SECRET_KEY`.

Each test file runs in its own process, so module-cache stubs do not leak between files.
Workers keep a module-level queue: wait for a final task status with `waitFor`, then wait for
the temporary files of that task to disappear before asserting.

## What to cover for each operation

1. Every validation branch of the route, at the exact boundary (limit passes, limit + 1 fails)
   for both plans.
2. Ownership: another user's video or task returns 404 and is not modified.
3. Worker happy path with real ffmpeg, checking the produced media with ffprobe.
4. Retry once then fail; cancellation while queued and while processing; storage quota.
5. Exactly one refund for every charged task that fails or is cancelled; none on success or
   for premium.
6. Cleanup: no temporary files, no orphan S3 objects, no visible library entry after failure.

## Naming and recording

- Test names start with the ID: `TST-{FUNC}-nn` (`UPLOAD`, `LIB`, `TRIM`, `FRAME`, `META`,
  `STATUS`, `SEC`, `GW`). Never reuse an ID.
- Put the requirement in the name or a comment (`REQ-VID-TRIM-NF03`, `UC-VID-003/RN5`).
- After a run, update `docs/testes-fase1.md` with the result (pass/fail, date, environment).
  When a test exposes a defect, record it in the defects table with the fixing commit.
