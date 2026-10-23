# PictuRAS

**Your personal, intuitive and powerful image editor.**

PictuRAS is a web-based image editing platform that combines traditional image processing with AI-powered tools. It is built as a **microservices architecture** orchestrated with Docker Compose, and it is the code base for the group project of the curricular unit _Requisitos e Arquitetura de Software_ (RAS), University of Minho.

This repository is the **2026/2027 continuation by Group PL2-G7**. We kept the PictuRAS code
base built over the two previous academic years (see [Authors](#-authors)) and, in Phase 1,
extended it with a **video extension**: a per-account video library and four video use cases
(upload, conversion, frame extraction and trim) that reuse the existing authentication, plan
tiers, daily-operation counter, MongoDB and object storage. See
[Video Extension](#-video-extension-20262027) for the summary and [`AGENTS.md`](AGENTS.md) for
the detailed design of each use case.

> **Inherited code base.** The image editor, the AI tools and the infrastructure come from the
> previous groups and still carry their known limitations and technical debt. The findings we
> identified in the base solution are recorded in the Phase 1 report
> ([`docs/relatorio/`](docs/relatorio/)) and in [`AGENTS.md`](AGENTS.md).

---

## 📑 Table of Contents

- [Features](#-features)
- [Video Extension (2026/2027)](#-video-extension-20262027)
- [Architecture](#-architecture)
- [Quick Start](#-quick-start)
- [Ports and Endpoints](#-ports-and-endpoints)
- [HTTPS and Certificates](#-https-and-certificates)
- [Configuration](#-configuration)
- [Project Structure](#-project-structure)
- [Development Workflow](#-development-workflow)
- [Troubleshooting](#-troubleshooting)
- [Authors](#-authors)
- [License](#-license)
- [Contributing](#-contributing)

---

## 🚀 Features

### Core Image Processing

- **Basic Editing**: brightness, contrast, saturation adjustments
- **Geometric Operations**: resize, rotate, crop
- **Filters and Effects**: binarization, borders, watermark
- **Bulk Processing**: apply a pipeline of tools to multiple images

### AI-Powered Tools

- **Background Removal** (`bg_remove_ai`): AI-powered background removal for clean cutouts
- **Smart Cropping** (`cut_ai`): saliency-based intelligent cropping
- **Object Detection** (`obj_ai`): object detection and classification with YOLO
- **People Detection** (`people_ai`): person detection and counting
- **Text Recognition** (`text_ai`): OCR for text extraction from images
- **Image Enhancement** (`upgrade_ai`): AI-driven quality improvement and upscaling
- **Generative Expand** (`expand_ai`): outpainting / canvas expansion, backed by a generative
  image API (a local **mock** of the Stable Diffusion WebUI API ships with the project, so no
  GPU or external API key is required)

### User Management and Platform

- **Authentication**: user registration and login with JWT
- **Field-level encryption**: sensitive user fields are encrypted at rest in MongoDB
- **Subscription Plans**: free and premium tiers with different daily usage limits
- **Project Management**: organise images and editing pipelines into projects
- **Real-time Processing**: WebSocket-based progress updates while tools run
- **Video library and video tools** _(new in 2026/2027)_: upload, conversion, frame extraction
  and trim — see [Video Extension](#-video-extension-20262027)
- **Automated backups**: periodic `mongodump` of all three databases

---

## 🎬 Video Extension (2026/2027)

Phase 1 of the 2026/2027 project added video support to the existing image editor. It is
available to **free** and **Premium** accounts from the dashboard; anonymous users are
rejected by the API Gateway.

| Use case | Feature | What it does |
| -------- | ------- | ------------ |
| **UC-VID-001** | Video upload | Batches of MP4/MOV (H.264, optional AAC) or WebM (VP9, optional Opus) files sent in 8 MiB multipart parts, with progress, rate, ETA, retry and cancellation. Content is re-checked with `ffprobe`; spoofed or corrupt files are deleted. |
| **UC-VID-002** | Video conversion | Converts a whole library video to MP4/H.264/AAC or WebM/VP9/Opus, preserving the resolution or reducing it to 720p. The original is kept and the result is added to the library. |
| **UC-VID-003** | Frame extraction | Samples frames every 1–60 s from a time range, as PNG or JPEG, into a new or existing project, so they can go straight into the image pipeline. |
| **UC-VID-004** | Video trim | Lossless temporal cut (`ffmpeg -c copy`) saved as a new video or replacing the original. |

All video tools run as **persistent background tasks** in `imageStorageService`: the dashboard
shows their progress, they can be cancelled and they survive page navigation. Each accepted
trim, extraction or conversion uses **one daily operation** of the existing counter (only free
accounts have a daily limit), and the operation is given back when the task fails or is
cancelled. Uploads do not count as operations.

### Plan limits

| Limit | Free | Premium |
| ----- | ---- | ------- |
| Upload — size per file | 200 MB | 2000 MB |
| Upload — total video storage | 1 GiB | 20 GiB |
| Trim — source size / segment length | 200 MB / 300 s | 2 GB / 3600 s |
| Frame extraction — interval / frames / resolution | 120 s / 30 / 1080p | 1800 s / 200 / 4K |
| Conversion — source size / duration | 200,000,000 bytes / 120 s | 500,000,000 bytes / 300 s |
| Concurrent trim or extraction tasks | 1 | 3 |
| Daily operations (`FREE_DAILY_OP`) | 5 | not limited |

Trim and frame-extraction tasks time out after 10 minutes (`VIDEO_TASK_TIMEOUT_MS`) with one
internal retry; conversions have a 900-second total deadline and are never retried. Conversion
limits live in `imageStorageService/config/videoConversion.js`; the storage quotas are set in
[Configuration](#-configuration).

### Where the code is

| Layer | Files |
| ----- | ----- |
| Frontend | `frontend/components/video-library.tsx`, `*-video-dialog.tsx`, `extract-frames-dialog.tsx`; upload, task and conversion providers in `frontend/providers/` |
| API Gateway | `apiGateway/routes/videos.js` (`/api-gateway/videos/...`) and `videoConversions.js` (`/api-gateway/video-conversions/...`) |
| Storage and workers | `imageStorageService/route/`, `services/` (metadata, trim, frame-extraction and conversion workers), `models/` (`Video`, `VideoTask`, `VideoConversionTask`) |
| Quotas | `users/services/operationQuota.js` and `users/routes/conversionQuota.js` (conversion reservations) |
| Projects | internal `create-with-frames` / `append-frames` endpoints in `projects/routes/projects.js` |

Calls between the gateway, `img_storage`, `users` and `projects` for these features use the
shared `INTERNAL_SERVICE_TOKEN`. Video records and tasks are stored in the `video_library`
database of the existing projects MongoDB; the video files are SeaweedFS objects. The
`img_storage` image now installs **FFmpeg**.

---

## 🏗️ Architecture

All traffic enters the system through a single **HTTPS reverse proxy (Nginx)**. Internal services
are **not** published to the host unless noted otherwise — they talk to each other over the
`elk` Docker bridge network.

```
                          https://localhost:8080
                                    │
                           ┌────────▼────────┐
                           │ Nginx (443/TLS) │
                           └────────┬────────┘
              ┌─────────────┬───────┴───────┬────────────────┐
              │             │               │                │
        / (frontend)  /api-gateway/     /socket.io       /s3[-console]/
              │             │               │                │
         ┌────▼────┐   ┌────▼────┐     ┌────▼────┐      ┌─────▼─────┐
         │ Next.js │   │   API   │     │   WS    │      │ SeaweedFS │
         │  :3000  │   │ Gateway │     │ Gateway │      │   :9000   │
         └─────────┘   │  :8000  │     │  :4000  │      └───────────┘
                       └────┬────┘     └────▲────┘
                            │               │ consumes ws_queue
        ┌───────────┬───────┴───────┐       │
        │           │               │       │
  ┌─────▼─────┐ ┌───▼───────┐ ┌─────▼─────┐ │
  │   users   │ │ projects  │ │ subscrip. │ │
  │  :10001   │ │   :9001   │ │  :11001   │ │
  └─────┬─────┘ └──┬─────┬──┘ └─────┬─────┘ │
        │          │     │          │       │
   ┌────▼───┐ ┌────▼───┐ │     ┌────▼───┐   │
   │MongoDB │ │MongoDB │ │     │MongoDB │   │
   │ :27019 │ │ :27018 │ │     │ :27017 │   │
   └────────┘ └────────┘ │     └────────┘   │
                         │                  │
                    ┌────▼──────────────────┴────┐
                    │      RabbitMQ  :5672       │◄─── 16 tool microservices
                    │    exchange "picturas"     │     (one queue per tool)
                    └────────────────────────────┘
```

The **WS Gateway talks only to RabbitMQ**: it consumes `ws_queue` and pushes progress events to
the browser over Socket.IO, authenticating the connection with the shared `JWT_SECRET_KEY`. It
has no link to any other microservice. Note that **`subscriptions` means paid memberships**
(plans, cards, billing status) — it is unrelated to WebSocket/event subscriptions.

The diagram leaves out the **Image Storage Service** (`img_storage`, port 11000), which sits
between the API Gateway and SeaweedFS. It was an S3 façade for images and now also runs the
video extension:

```
API Gateway ──► img_storage ──► SeaweedFS (video objects)
  (JWT, plan,        │    └───► MongoDB :27018, database video_library (videos, tasks)
   daily op)         ├────────► users    (plan, daily-operation charge/refund/reservation)
                     └────────► projects (internal endpoints that receive extracted frames)
```

Video work does not go through RabbitMQ: the trim, frame-extraction, conversion and metadata
workers run inside `img_storage` and call FFmpeg/ffprobe directly. The browser polls the task
endpoints for progress.

### Frontend

- **Technology**: Next.js 15 with React 19, TypeScript and Tailwind CSS
- **Container port**: 3000 — **not published**, reachable only through Nginx
- Talks to the backend through the relative base URL `/api-gateway/`

### Backend Services

| Service                   | Container port | Responsibility                                  |
| ------------------------- | -------------- | ----------------------------------------------- |
| **API Gateway**           | 8000           | Single entry point for the REST API, JWT checks |
| **User Service**          | 10001          | Registration, authentication, user profile      |
| **Project Service**       | 9001           | Projects, image pipelines, tool orchestration   |
| **Subscription Service**  | 11001          | Plans, payments (mock), usage limits            |
| **Image Storage Service** | 11000          | S3 façade, video library, video task workers     |
| **WebSocket Gateway**     | 4000           | Real-time progress events to the browser        |

### Processing Tools

Each tool is an independent Python microservice that consumes a RabbitMQ queue, processes the
image from the shared `image_data` volume, and publishes the result back to the `picturas`
exchange:

`binarization` · `border` · `brightness` · `contrast` · `cut` · `resize` · `rotate` ·
`saturation` · `watermark` · `bg_remove_ai` · `cut_ai` · `expand_ai` · `obj_ai` · `people_ai` ·
`text_ai` · `upgrade_ai`

> The `watermark` tool runs from a pre-built public image
> (`prcsousa/picturas-watermark-tool-ms`) instead of being built from this repository — it is a
> deliberate example of integrating a third-party service.

### Infrastructure

- **Message Queue**: RabbitMQ (asynchronous tool invocation)
- **Databases**: three independent MongoDB 4.4 instances (users, projects, subscriptions); the
  projects instance also holds the `video_library` database
- **Object Storage**: SeaweedFS (S3-compatible) with encryption at rest, for images and videos
- **Media processing**: FFmpeg/ffprobe installed in the `img_storage` image

> **Why SeaweedFS?** The project originally used MinIO, whose container images were withdrawn
> from Docker Hub and quay.io in 2026, breaking every fresh build. SeaweedFS is S3-compatible,
> so only the endpoint and credentials changed — the application code still speaks plain S3 via
> `aws-sdk`. Encryption at rest is preserved through `-s3.encryptVolumeData`, which replaces
> MinIO's `MINIO_KMS_AUTO_ENCRYPTION`.

- **Reverse Proxy / TLS termination**: Nginx
- **Backups**: `mongo-backup` sidecar running `mongodump` every 24h into `./backups/mongo`
- **Monitoring**: ELK stack (Elasticsearch, Logstash, Kibana) — present but **commented out**
  in `docker-compose.yaml` and `nginx/nginx.conf`

---

## 🛠️ Quick Start

### Prerequisites

| Requirement        | Minimum                   | Notes                                                        |
| ------------------ | ------------------------- | ------------------------------------------------------------ |
| **Docker Engine**  | 24+                       | Docker Desktop on Windows/macOS                              |
| **Docker Compose** | v2 (`docker compose`)     | The old `docker-compose` (v1) hyphenated command is not used |
| **RAM**            | 8 GB free (16 GB advised) | ~25 containers, several with AI models loaded                |
| **Disk**           | ~15 GB free               | AI base images (PyTorch, OpenCV) are large                   |
| **Browser**        | Any modern browser        | Must accept a self-signed certificate                        |

On Docker Desktop, raise the memory limit in **Settings → Resources** if the AI tools get
OOM-killed.

### Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/FMaia05/picturas-27Grupo7PL2
   cd picturas-27Grupo7PL2
   ```

   The base code base we started from is <https://github.com/picturas-um/picturas-27>
   (configured as the `upstream` remote in our clones).

2. **Build and start the whole stack**

   ```bash
   docker compose up --build
   ```

   The **first** build downloads several GB of images and installs the Python AI dependencies —
   expect **15–30 minutes** depending on your connection. Later starts take seconds:

   ```bash
   docker compose up -d      # detached
   docker compose logs -f    # follow the logs
   ```

3. **Open the application**

   👉 **<https://localhost:8080>** — note the **`https`** and the port **`8080`**.

   Your browser will warn you about the self-signed certificate. Accept it
   (Chrome: _Advanced → Proceed to localhost (unsafe)_; Firefox: _Advanced → Accept the Risk_).
   See [HTTPS and Certificates](#-https-and-certificates) if the site does not load at all.

4. **Stop the stack**

   ```bash
   docker compose down          # stop and remove containers
   docker compose down -v       # ...and wipe all data (databases, images, objects)
   ```

### First Steps

1. Open <https://localhost:8080> and accept the certificate.
2. Register an account, or use the anonymous mode.
3. Create a project and upload an image.
4. Build a pipeline with the toolbar (filters, geometry, AI tools) and run it.
5. Watch the progress arrive live over the WebSocket, then download the results.
6. With a free or Premium account, open the video library in the dashboard, upload an MP4,
   MOV or WebM video and wait for its metadata. Its actions convert, trim or extract frames
   from it; the task monitor shows progress and lets you cancel.

---

## 🔌 Ports and Endpoints

Everything a user needs is behind **one** address: `https://localhost:8080`. The remaining
ports are published only for **development and debugging**.

### Through the reverse proxy (HTTPS)

| URL                                   | Target                  |
| ------------------------------------- | ----------------------- |
| `https://localhost:8080/`             | Frontend (Next.js)      |
| `https://localhost:8080/api-gateway/` | REST API (API Gateway)  |
| `https://localhost:8080/socket.io`    | WebSocket Gateway       |
| `https://localhost:8080/s3/`          | Object storage (S3 API) |
| `https://localhost:8080/s3-console/`  | SeaweedFS filer web UI  |

### Published directly on the host

| Port    | Service              | URL / Credentials                               |
| ------- | -------------------- | ----------------------------------------------- |
| `8080`  | Nginx (HTTPS)        | <https://localhost:8080>                        |
| `9000`  | SeaweedFS S3 API     | <http://localhost:9000> — `admin` / `admin123`  |
| `9090`  | SeaweedFS filer UI   | <http://localhost:9090>                         |
| `11000` | Image Storage        | <http://localhost:11000>                        |
| `15672` | RabbitMQ Management  | <http://localhost:15672> — `user` / `password`  |
| `5672`  | RabbitMQ AMQP        | broker endpoint used by the tools               |
| `10001` | User Service         | <http://localhost:10001>                        |
| `11001` | Subscription Service | <http://localhost:11001>                        |
| `9002`  | Project Service      | <http://localhost:9002> (container port `9001`) |
| `4000`  | WebSocket Gateway    | <http://localhost:4000>                         |
| `7860`  | Generative mock API  | <http://localhost:7860> (used by `expand_ai`)   |
| `27018` | MongoDB (projects)   | `mongodb://localhost:27018`                     |
| `27019` | MongoDB (users)      | `mongodb://localhost:27019`                     |

Make sure the ports above are free before starting; see [Troubleshooting](#-troubleshooting).

---

## 🔐 HTTPS and Certificates

Nginx terminates TLS on container port `443`, published on host port `8080`. A **self-signed**
certificate pair is committed to the repository so the stack works out of the box:

```
certs/selfsigned.crt      # used by Nginx — the only certificate the browser sees
certs/selfsigned.key
```

Five further self-signed pairs are committed under `apiGateway/`, `users/`, `projects/`,
`subscriptions/` and `frontend/`. The internal services use them to speak HTTPS to each other
(`https://users:10001`, `https://projects:9001`, ...).

The bundled certificate is issued to `CN=localhost` and is valid until **14 September 2027**, so
it covers the whole academic year. To regenerate it (for a different hostname, or after it
expires):

```bash
openssl req -x509 -nodes -days 365 \
  -newkey rsa:2048 \
  -keyout certs/selfsigned.key \
  -out certs/selfsigned.crt \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

docker compose restart nginx
```

> ⚠️ **The internal certificates are expired, and that is why nothing breaks.**
> All five service-to-service pairs expired in **January 2026**. The stack keeps working
> because every client is built as `https.Agent({ rejectUnauthorized: false })`, so expiry —
> and in fact the whole certificate chain — is never checked. Internal traffic is encrypted
> but **not authenticated**, and the client certificates passed to those agents are never
> requested by any server. Treat this as a finding to analyse, not a pattern to copy: fixing
> it (proper validation, or dropping internal TLS in favour of a trusted network boundary) is
> a legitimate architectural improvement. Only `certs/`, used by Nginx, is still valid.

**Why HTTPS matters here:** the browser refuses to open a secure WebSocket (`wss://`) from a
page served over plain HTTP, and several browser APIs used by the editor require a secure
context. Always use `https://localhost:8080` — **not** `http://`, and **not** `localhost:3000`.

**Overriding with a `.env` file.** The object-storage variables are read from the environment,
with the defaults above applied when unset, so the stack runs with no setup. To use your own
credentials, copy `.env.example` to `.env` and edit it — `.env` is git-ignored, and a single
entry there updates both the storage server and the client that talks to it:

```bash
cp .env.example .env     # then edit, and: docker compose up -d
```

The video variables `INTERNAL_SERVICE_TOKEN`, `FREE_VIDEO_QUOTA_BYTES`,
`PREMIUM_VIDEO_QUOTA_BYTES` and `VIDEO_TASK_TIMEOUT_MS` are read the same way and can also be
set in `.env` (see [Configuration](#-configuration)).

> 🔎 **Committed secrets are a known issue.** Private keys, JWT secrets and database passwords
> are hard-coded in this repository for convenience. That is acceptable for a local
> setup but _unacceptable in production_ — moving them to a `.env` file (git-ignored) or a secrets
> manager is a good first improvement.

---

## 🔧 Configuration

All configuration currently lives as `environment:` entries in `docker-compose.yaml`.

| Variable                                      | Default                       | Service(s)             | Purpose                                      |
| --------------------------------------------- | ----------------------------- | ---------------------- | -------------------------------------------- |
| `JWT_SECRET_KEY`                              | `lisan_al_gaib`               | users, gateway, ws     | JWT signing key — **must match everywhere**  |
| `FIELD_ENCRYPTION_KEY`                        | `uma-frase-secreta-...`       | users                  | Key for field-level encryption in MongoDB    |
| `FREE_DAILY_OP`                               | `5`                           | users                  | Daily operation limit for free accounts      |
| `SECRET_KEY`                                  | `card_secret_key`             | subscriptions          | Payment-data encryption key                  |
| `S3_ENDPOINT`                                 | `seaweedfs:9000`              | img_storage            | Object storage endpoint                      |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY`             | `admin` / `admin123`          | seaweedfs, img_storage | Object storage credentials                   |
| `S3_KEK_PASSPHRASE`                           | `picturas-kek-...`            | seaweedfs              | Protects the key used for encryption at rest |
| `INTERNAL_SERVICE_TOKEN`                       | `picturas-internal-video-token` | gateway, img_storage, users, projects | Authenticates internal video, frame and conversion-quota calls — **must match everywhere** |
| `FREE_VIDEO_QUOTA_BYTES`                       | `1073741824` (1 GiB)          | img_storage            | Total video storage for free accounts        |
| `PREMIUM_VIDEO_QUOTA_BYTES`                    | `21474836480` (20 GiB)        | img_storage            | Total video storage for Premium accounts     |
| `VIDEO_TASK_TIMEOUT_MS`                        | `600000` (10 min)             | img_storage            | Time limit of a trim or frame-extraction task |
| `RABBITMQ_DEFAULT_USER` / `_PASS`             | `user` / `password`           | rabbitmq               | Broker credentials                           |
| `RABBITMQ_HOST` / `_PORT` / `_USER` / `_PASS` | `rabbitmq` / `5672` / ...     | tools, projects, ws    | Broker connection                            |
| `USERS_URL` / `PROJECTS_URL`                  | `https://users:10001/` / `https://projects:9001/` | img_storage | Internal calls for quotas and extracted frames |
| `FRONTEND_URL`                                | `https://localhost:8080`      | img_storage            | CORS / redirect origin                       |
| `NEXT_PUBLIC_API_BASE_URL`                    | `/api-gateway/`               | frontend               | Relative API base (keep it relative!)        |
| `GEN_EXPAND_URL`                              | `http://generative-mock:7860` | expand_ai              | Generative image API endpoint                |

⚠️ If you change `JWT_SECRET_KEY`, change it in **all three** services (`users`, `api_gateway`,
`ws_gateway`) or authentication silently breaks.

### Persistent data

Named Docker volumes: `user_data`, `project_data`, `subscription_data`, `image_data`,
`seaweedfs_data`, `rabbitmq_data`. Video records and tasks live in `project_data` (database
`video_library`) and the video files in `seaweedfs_data`. Database dumps are written to the
host at `./backups/mongo` (git-ignored); the projects dump includes `video_library`, but the
SeaweedFS objects are not backed up. `docker compose down -v` deletes every volume — the dumps
survive.

### Scaling

- Run more instances of a busy tool: `docker compose up -d --scale brightness_tool=3`
- Watch queue depth in the RabbitMQ management UI (<http://localhost:15672>)
- Tune per-container CPU/memory limits in `docker-compose.yaml` to match your machine

Containers are named `picturas-<service>-<n>` (from `name: picturas` in `docker-compose.yaml`),
independently of the directory you cloned into. Use `docker compose -p <other-name>` to run a
second, separate stack.

### Enabling the ELK stack (optional)

The Elasticsearch / Logstash / Kibana services are commented out at the top of
`docker-compose.yaml`, together with the matching `location` blocks in `nginx/nginx.conf`.
Uncomment both to enable centralised logging — budget an extra ~4 GB of RAM.

---

## 📁 Project Structure

```
picturas-27Grupo7PL2/
├── frontend/                 # Next.js 15 + React 19 frontend (video library, dialogs, providers)
├── apiGateway/               # REST API gateway (Express), incl. video and conversion routes + tests
├── users/                    # User management service (Express + MongoDB), daily-operation quotas
├── projects/                 # Project & pipeline orchestration service
├── subscriptions/            # Subscription / payment service
├── imageStorageService/      # S3 façade in front of SeaweedFS + video library and workers
│   ├── route/  services/  models/  config/  middleware/
│   └── test/                 #   node:test suites, fakes and E2E test
├── wsGateway/                # WebSocket gateway (Socket.IO)
├── generative-mock/          # Mock of the Stable Diffusion WebUI API (for expand_ai)
├── Tools/                    # Image processing microservices
│   ├── utils/                #   shared helpers (RabbitMQ, image I/O, messages)
│   ├── models/               #   pre-downloaded ML weights (e.g. yolov5su.pt)
│   ├── bg_remove_ai/  cut_ai/  expand_ai/  obj_ai/  people_ai/  text_ai/  upgrade_ai/
│   └── binarization/  border/  brightness/  contrast/  cut/  resize/  rotate/  saturation/
├── rabbitMQ/                 # Broker image with queue/exchange definitions
├── nginx/nginx.conf          # Reverse proxy, TLS, CORS, WebSocket routing
├── certs/                    # Self-signed TLS certificate for Nginx
├── backups/mongo/            # Generated database dumps (git-ignored)
├── logstash.conf, kibana.yml # ELK configuration (stack currently disabled)
├── docker-compose.yaml       # Service orchestration — the single source of truth
├── docs/
│   ├── testes-fase1.md       # How to run the tests and the latest results
│   ├── relatorio/            # Phase 1 report chapters (tests and validation, AI agents)
│   └── ia/registo-ia.md      # Log of AI agent usage during Phase 1
├── .claude/skills/           # AI agent skills used to build and test the video features
├── AGENTS.md                 # Instructions for AI coding agents working on this repository
└── LICENSE                   # CC BY-NC-SA 4.0
```

---

## 💻 Development Workflow

### Rebuilding a single service

```bash
docker compose up -d --build users        # rebuild + restart one service
docker compose restart nginx              # config-only change, no rebuild needed
docker compose logs -f projects           # follow one service's logs
docker compose ps                         # what is running, and is it healthy?
```

### Live code reloading

`users`, `subscriptions`, `apiGateway` and `frontend` bind-mount their source directory into
the container, so edits on the host are visible inside it. The Node services run under
`nodemon` and reload automatically.

The **frontend image is built for production** (`bun run build` / `bun start`), so a source edit
will **not** hot-reload. For frontend development either rebuild:

```bash
docker compose up -d --build -V frontend
```

The `-V` (`--renew-anon-volumes`) flag is required: `node_modules` and `.next` are anonymous
volumes, and without it Compose reattaches the old ones, so the container keeps serving the
**previous** build even though the image was rebuilt.

...or switch `frontend/Dockerfile` to the dev command already prepared there
(`CMD ["bun", "dev"]`, commented out at the bottom of the file).

Python tools, `img_storage` and `projects` have no bind mount — rebuild them after every
change:

```bash
docker compose up -d --build border_tool
docker compose up -d --build --no-deps img_storage
```

### Adding a new tool

1. Create `Tools/<your_tool>/` with `<your_tool>.py`, `requirements.txt` and a `Dockerfile`
   (copy an existing simple tool such as `border` as a template).
2. Reuse `Tools/utils/` for RabbitMQ connection, image handling and message schemas.
3. Register the queue in `rabbitMQ/`.
4. Add the service to `docker-compose.yaml` with `depends_on: rabbitmq (service_healthy)` and
   the `image_data` volume.
5. Expose it in the project service and in the frontend toolbar.

### Running the tests

The video features have automated tests written with the Node.js built-in test runner (no
extra dependencies). MongoDB, SeaweedFS and the other services are replaced by in-memory fakes;
the trim, frame-extraction and metadata workers run the real `ffmpeg`/`ffprobe` on small
generated clips.

```bash
# API Gateway: JWT ownership, anonymous users, daily-operation charge and refund
cd apiGateway && npm install && npm test

# Image Storage Service: routes and workers (ffmpeg suites are skipped if ffmpeg is missing)
cd imageStorageService && npm install && npm test

# Full storage suite including ffmpeg, inside the service image (no other service needed)
docker compose build img_storage
docker compose run --rm --no-deps img_storage npm test

# End-to-end video API test against the running stack
docker compose up -d
docker compose run --rm --no-deps img_storage npm run test:e2e

# Frontend type and framework check
cd frontend && npm run build
```

Each test name starts with its identifier (`TST-TRIM-04`, `TST-GW-FRAME-02`, ...). How to run
them and the latest results are in [`docs/testes-fase1.md`](docs/testes-fase1.md); the full
catalogue, with the requirement each test verifies, and the manual interface scenarios are in
[`docs/relatorio/cap10-testes-validacao.md`](docs/relatorio/cap10-testes-validacao.md).

The development tests written for video conversion were removed from the working tree; the
conversion is checked with the build/syntax checks and the manual scenarios in
[`AGENTS.md`](AGENTS.md#video-conversion-validation).

### Inspecting data

```bash
docker compose exec users_mongoDB mongo --port 27019
docker compose exec projects_mongoDB mongo --port 27018
docker compose exec projects_mongoDB mongo --port 27018 video_library   # videos and video tasks
```

Stored objects: <http://localhost:9090> (SeaweedFS filer UI).
Queues and message rates: <http://localhost:15672> (`user` / `password`).

---

## 🩹 Troubleshooting

**The page does not load / `ERR_CONNECTION_REFUSED`**
You are probably using `http://` instead of `https://`, or port `3000` instead of `8080`. The
only correct address is <https://localhost:8080>.

**"Your connection is not private" / `NET::ERR_CERT_AUTHORITY_INVALID`**
Expected — the certificate is self-signed. Accept the warning once per browser profile. If
Chrome refuses outright, type `thisisunsafe` with the warning page focused.

**Uploads or live updates fail although the page loads**
The browser blocks mixed content and insecure WebSockets. Make sure every request goes through
`https://localhost:8080` and that `NEXT_PUBLIC_API_BASE_URL` stays the **relative** value
`/api-gateway/`.

**`Bind for 0.0.0.0:8080 failed: port is already allocated`**
Another process holds the port. Find it with `lsof -i :8080` (macOS/Linux) or
`netstat -ano | findstr :8080` (Windows) and stop it. Do not remap Nginx to another host
port: `FRONTEND_URL` and the frontend's WebSocket URL both assume `8080`, so the page would
load while presigned image URLs and live updates kept pointing at the old port.

**A tool container keeps restarting**
Check `docker compose logs <tool>_tool`. The usual causes are RabbitMQ not being healthy yet
(it recovers on its own) or the container being OOM-killed — increase Docker's memory limit.

**AI tools are very slow the first time**
Some models are downloaded or warmed up on first use. `Tools/models/yolov5su.pt` is committed,
but other weights are fetched at runtime — the first request needs network access.

**`expand_ai` fails**
It depends on `generative-mock` being healthy. Check <http://localhost:7860> and
`docker compose logs generative-mock`.

**Login works, then every request returns 401**
`JWT_SECRET_KEY` differs between `users`, `api_gateway` and `ws_gateway`.

**Video actions fail with 403 `Forbidden`, or extracted frames never reach the project**
`INTERNAL_SERVICE_TOKEN` must have the same value in `api_gateway`, `img_storage`, `users` and
`projects`.

**Starting a conversion returns 503 right after a restart**
`img_storage` reconciles interrupted conversions on startup and refuses new ones until it
finishes. Wait a few seconds and try again; `docker compose logs img_storage` shows the progress.

**A frontend change does not show up after rebuilding**
Recreate it with `docker compose up -d -V frontend` (see
[Live code reloading](#live-code-reloading)). If Nginx answers 502 after a service was
recreated, it may still hold the old container IP: `docker compose restart nginx`.

**Everything is broken after pulling new code**
First try rebuilding the affected services. As a last resort, rebuild from a clean slate —
`down -v` **deletes all accounts, projects and videos**:

```bash
docker compose down -v
docker compose build --no-cache
docker compose up
```

**Out of disk space**
`docker system prune -a --volumes` reclaims unused images and volumes — it also **deletes your
local data**, so use it deliberately.

---

## 👥 Authors

PictuRAS is a cumulative effort of several generations of students of _Requisitos e Arquitetura
de Software_ at the **University of Minho**. Please keep this section growing rather than
replacing it.

### Original authors — Group A, 2024/2025

The initial design and implementation:

- **PG55926** — Carlos Alberto Ribeiro
- **PG55932** — Diogo Cardoso Ferreira
- **PG55934** — Diogo Gomes Matos
- **PG55946** — Guilherme João Fernandes Barbosa
- **PG57558** — João Henrique Costa Ferreira
- **PG55958** — João Manuel Matos Fernandes
- **PG55969** — José Filipe Ribeiro Rodrigues
- **PG55973** — Juciano Gomes Farias Junior
- **PG55989** — Nuno Ricardo Silva Gomes

### Evolution — Group PL3-G, 2025/2026

Contributed HTTPS/TLS termination, encryption at rest and field-level encryption, automated
database backups, the generative expand tool with its local mock, third-party watermark tool
integration, and assorted frontend and service improvements:

- **PG60259** — Gabriel Veloso Antunes
- **PG60263** — Guilherme Pinto Pinho
- **PG60284** — Miguel Freixo Machado
- **PG61515** — Diogo Miguel Pinto
- **PG61534** — Mariana Miguel Pinto

### Continuation — Group PL2-G7, 2026/2027

Contributed the video extension: the user video library with multipart upload and ffprobe
metadata validation, lossless temporal trimming (Trim), frame extraction into projects and
full-video conversion to MP4/H.264/AAC or WebM/VP9/Opus, with per-plan limits, daily-operation
billing and persistent background tasks:

- **PG65400** — André Pinto
- **PG63956** — Fábio Magalhães
- **PG63991** — José Silva
- **PG63929** — Carlos Cunha
- **PG65408** — Francisco Maia

_Note: minor improvements and adjustments have also been introduced by the course lecturers._

---

## 📄 License

This project is licensed under the **Creative Commons
Attribution-NonCommercial-ShareAlike 4.0 International License** (CC BY-NC-SA 4.0).
See [LICENSE](LICENSE).

### What this means

- ✅ **Share** — copy and redistribute the material in any medium or format
- ✅ **Adapt** — remix, transform and build upon the material
- ✅ **Attribution** — you must give appropriate credit to the original authors
- ❌ **Commercial Use** — not permitted without explicit consent from all authors
- ✅ **Share Alike** — derivative works must be distributed under the same license

### For contributors

- New students and contributors are welcome.
- All contributions must maintain the same license terms.
- Commercial use requires explicit consent from all original authors.
- Any derivative work must be shared under the same license.

---

## 🤝 Contributing

1. Fork or branch from `main`.
2. Create a feature branch: `git checkout -b feature/<short-description>`.
3. Make your changes and keep the commits small and descriptive.
4. Test locally with `docker compose up --build` before pushing.
5. Open a pull request describing **what** changed and **why**.

Please do **not** commit `node_modules/`, generated images, database dumps or new secrets —
`.gitignore` already covers most of these.

---

## 📞 Support

- Open an issue in this repository for bugs and questions about the code base.
- Use the official university channels for anything related to the curricular unit.
- Follow the academic guidelines for collaborative work and attribution.

---

**PictuRAS** — Empowering creativity through intelligent image editing.
