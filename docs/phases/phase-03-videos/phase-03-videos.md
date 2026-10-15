---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-04-08T14:58:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-07T20:39:13-03:00"
  docs/phases/phase-03-videos/context.md: "2026-10-07T20:39:52-03:00"
  docs/phases/phase-03-videos/validation.md: "2026-10-07T20:40:26-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the complete video upload, asynchronous processing, and streaming lifecycle: 
1. Resilient upload of up to 10GB files using S3 Presigned Multipart Upload without loading binary payloads into the NestJS API memory;
2. Automatic pre-registration of videos in `DRAFT` status;
3. Asynchronous queue processing using BullMQ and Redis;
4. Dedicated Video Worker container executing FFmpeg and ffprobe to extract duration, metadata, and auto-generate thumbnail frames;
5. Collision-resistant unique short URLs (NanoID);
6. Streaming via HTTP 206 Partial Content (Range Requests) and direct file download;
7. Full Docker Compose infrastructure and test coverage with 100% green suites.

---

## Step Implementations

### SI-03.1 — Infrastructure Services & Configuration Namespaces
**Description:** Add MinIO (S3 compatible object storage), Redis (queue store), and the Video Worker container to `compose.yaml`. Install production dependencies and create `storage` and `queue` config namespaces with Joi validation in NestJS.

**Technical actions:**
- Add dependencies to `nestjs-project/package.json`: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `bullmq`, `@nestjs/bullmq`, `ioredis`, `fluent-ffmpeg`, `@types/fluent-ffmpeg`, `nanoid@^3.3.8`.
- Update `nestjs-project/compose.yaml`:
  - `minio`: image `minio/minio:RELEASE.2025-02-18T16-25-55Z`, command `server /data --console-address ":9001"`, ports `9000:9000` (API) and `9001:9001` (Console), environment `MINIO_ROOT_USER=minioadmin`, `MINIO_ROOT_PASSWORD=minioadmin`, healthcheck checking `/minio/health/live`.
  - `redis`: image `redis:7-alpine`, ports `6379:6379`, command `redis-server --appendonly yes`, healthcheck via `redis-cli ping`.
  - `video-worker`: service building with Dockerfile with ffmpeg/ffprobe installed, depends on `redis`, `minio`, `db`.
- Create `src/config/storage.config.ts`: `registerAs('storage')` reading `STORAGE_ENDPOINT` (default `'http://minio:9000'`), `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET_VIDEOS`, `STORAGE_BUCKET_THUMBNAILS`, `STORAGE_FORCE_PATH_STYLE` (default `true`).
- Create `src/config/queue.config.ts`: `registerAs('queue')` reading `REDIS_HOST` (default `'redis'`), `REDIS_PORT` (default `6379`).
- Update `src/config/env.validation.ts` with Joi schema for storage and redis variables.

**Acceptance criteria:**
- `docker compose ps` shows `minio`, `redis`, `db`, and `nestjs-api` healthy and running.
- NestJS API boots cleanly without configuration errors.

---

### SI-03.2 — Video Entity, Status Enum and Database Migration
**Description:** Define the `Video` entity, `VideoStatus` enum, establish the One-to-Many relation with `Channel`, and generate the TypeORM migration.

**Technical actions:**
- Create `src/videos/enums/video-status.enum.ts`: `DRAFT`, `PROCESSING`, `READY`, `ERROR`, `CANCELLED`.
- Create `src/videos/entities/video.entity.ts`:
  - Columns:
    - `id` (uuid, primary key)
    - `channel_id` (uuid, foreign key to `channels`)
    - `title` (varchar(150))
    - `description` (text, nullable)
    - `status` (enum `VideoStatus`, default `DRAFT`)
    - `original_storage_key` (varchar, nullable)
    - `thumbnail_storage_key` (varchar, nullable)
    - `duration_seconds` (integer, nullable)
    - `metadata` (jsonb, nullable: resolution, codec, bitrate, error_message)
    - `unique_url_id` (varchar(20), unique index)
    - `created_at`, `updated_at` (timestamps)
  - Relation: `@ManyToOne(() => Channel, channel => channel.videos)`
- Generate migration `src/database/migrations/<timestamp>-CreateVideos.ts` with table creation, unique constraint on `unique_url_id`, index on `channel_id`, and foreign key cascade rule.

**Acceptance criteria:**
- Migration runs cleanly via `npm run migration:run`.
- Table `videos` exists with all constraints and indexes in PostgreSQL.

---

### SI-03.3 — Storage Module & S3 Presigned Multipart Service
**Description:** Implement `StorageModule` and `StorageService` integrating with MinIO/S3 using `@aws-sdk/client-s3`.

**Technical actions:**
- Create `src/storage/storage.service.ts`:
  - `ensureBucketsExist()`: Automatically creates `videos` and `thumbnails` buckets if they do not exist at startup.
  - `createMultipartUpload(key, mimeType)`: Calls `CreateMultipartUploadCommand` returning `uploadId`.
  - `getPresignedPartUrls(key, uploadId, partsCount)`: Generates presigned `UploadPartCommand` URLs for each chunk.
  - `completeMultipartUpload(key, uploadId, parts)`: Finalizes the multipart upload on S3.
  - `abortMultipartUpload(key, uploadId)`: Aborts multipart upload and frees temporary storage.
  - `getObjectStream(key, range?)`: Calls `GetObjectCommand` passing optional `Range` header for partial streaming.
  - `uploadThumbnail(key, buffer, mimeType)`: Saves generated thumbnails into storage.

**Acceptance criteria:**
- Unit tests verify presigned URL generation and parameter validation.
- Integration tests verify bucket creation and object upload/download against MinIO in Docker.

---

### SI-03.4 — Videos Module: Upload Lifecycle (Start, Parts, Complete, Abort)
**Description:** Build the `VideosModule`, `VideosService`, and `VideosController` for managing upload sessions and video drafts.

**Technical actions:**
- DTOs:
  - `StartUploadDto`: `title` (string, max 150), `description` (optional), `filename` (string), `file_size` (number, max 10737418240 - 10GB), `parts_count` (number, min 1).
  - `CompleteUploadDto`: `upload_id` (string), `parts` (array of `{ part_number: number, etag: string }`).
- Endpoints:
  - `POST /videos/uploads/start` (Authenticated, Creator Guard): Creates video in `DRAFT` status with a unique NanoID, initializes S3 multipart upload, returns `{ videoId, uniqueUrlId, uploadId, partUrls }`.
  - `POST /videos/uploads/:id/complete` (Authenticated): Verifies channel ownership, calls `completeMultipartUpload`, updates video status to `PROCESSING`, enqueues processing job in BullMQ.
  - `POST /videos/uploads/:id/abort` (Authenticated): Aborts multipart upload, marks status `CANCELLED`.
  - `GET /videos/:uniqueUrlId` (Public): Returns video details (if status `READY`, or if authenticated user is the video owner).

**Acceptance criteria:**
- Initiating an upload for a file returns valid presigned URLs and creates a `DRAFT` record.
- Completing upload switches status to `PROCESSING` and publishes a job to the queue.
- Unauthorized users cannot complete or abort videos belonging to other channels.

---

### SI-03.5 — BullMQ Processing Queue & Dedicated Video Worker
**Description:** Implement the processing queue in NestJS and the Video Worker consuming jobs with FFmpeg and ffprobe.

**Technical actions:**
- Queue setup: `BullModule.registerQueue({ name: 'video-processing' })`.
- Worker implementation:
  - Consumes job `process-video`:
    1. Downloads video from storage or streams to local temporary container path.
    2. Runs `ffprobe` to extract duration, width, height, codec, and bitrate.
    3. Runs `ffmpeg` to capture a thumbnail frame at second 5 (or midpoint if duration < 5s).
    4. Uploads thumbnail to `thumbnails` bucket via storage service.
    5. Updates `Video` entity in PostgreSQL: status $\rightarrow$ `READY`, `duration_seconds`, `thumbnail_storage_key`, and `metadata`.
  - Failure handler: If FFmpeg fails after 3 retries, status $\rightarrow$ `ERROR` with error description in `metadata.error_message`.

**Acceptance criteria:**
- Processing a sample MP4 video successfully updates status to `READY`, sets duration, and stores a thumbnail.
- A corrupt file gracefully transitions status to `ERROR` without crashing the worker.

---

### SI-03.6 — Streaming (HTTP 206 Range Requests) & Download Endpoints
**Description:** Implement streaming and download endpoints in `VideosController`.

**Technical actions:**
- `GET /videos/:uniqueUrlId/stream`:
  - Inspects HTTP `Range` header (e.g., `bytes=0-1048575`).
  - Calls `storageService.getObjectStream(key, range)`.
  - Returns HTTP `206 Partial Content` with `Content-Range`, `Accept-Ranges: bytes`, `Content-Length`, and `Content-Type: video/mp4`.
  - If no `Range` header is passed, streams from byte 0.
- `GET /videos/:uniqueUrlId/download`:
  - Returns stream with `Content-Disposition: attachment; filename="..."` allowing full video download.

**Acceptance criteria:**
- Streaming endpoint responds with status 206 and correct byte chunks when requested with a Range header.
- Download endpoint sets attachment headers and delivers complete stream.

---

### SI-03.7 — Comprehensive Test Coverage (Unit, Integration, E2E)
**Description:** Write and verify 100% of the test suite across unit, integration, and E2E layers.

**Technical actions:**
- Unit tests (`*.spec.ts`):
  - `storage.service.spec.ts`: Mocks S3Client commands.
  - `videos.service.spec.ts`: Mocks repositories, storage, and queue.
  - `video-processor.spec.ts`: Mocks ffmpeg/ffprobe execution.
- Integration tests (`*.integration-spec.ts`):
  - `video.entity.integration-spec.ts`: TypeORM constraints, FK, unique url index.
  - `storage.service.integration-spec.ts`: Real MinIO bucket operations.
  - `videos.service.integration-spec.ts`: Real PostgreSQL transaction and channel linkage.
- E2E tests (`test/videos.e2e-spec.ts`):
  - Full flow: Register user $\rightarrow$ confirm $\rightarrow$ login $\rightarrow$ start upload $\rightarrow$ complete upload $\rightarrow$ worker process $\rightarrow$ stream video with Range header $\rightarrow$ download video.

**Acceptance criteria:**
- All unit, integration, and E2E tests pass cleanly (`npm test` and `npm run test:e2e`).
- `npx tsc --noEmit` exits with 0 errors.

---

### SI-03.8 — Documentation & Progress Tracking
**Description:** Update `docs/phases/phase-03-videos/progress.md`, `CLAUDE.md`, and verify all Acceptance Criteria.

---

## Technical Specifications

### Data Model (`videos` table)

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | uuid | PRIMARY KEY, default uuid_generate_v4() | Internal ID |
| `channel_id` | uuid | NOT NULL, REFERENCES channels(id) ON DELETE CASCADE | Owner Channel |
| `title` | varchar(150) | NOT NULL | Video title |
| `description` | text | NULLABLE | Video description |
| `status` | varchar(20) | NOT NULL, DEFAULT 'DRAFT' | DRAFT, PROCESSING, READY, ERROR, CANCELLED |
| `original_storage_key` | varchar(255) | NULLABLE | S3 object key in videos bucket |
| `thumbnail_storage_key`| varchar(255) | NULLABLE | S3 object key in thumbnails bucket |
| `duration_seconds` | integer | NULLABLE | Video length in seconds |
| `metadata` | jsonb | NULLABLE | Codec, resolution, bitrate, error info |
| `unique_url_id` | varchar(20) | NOT NULL, UNIQUE INDEX | Collision-resistant NanoID |
| `created_at` | timestamp | NOT NULL, DEFAULT now() | Creation timestamp |
| `updated_at` | timestamp | NOT NULL, DEFAULT now() | Last update timestamp |

### API Contracts

| Method | Endpoint | Auth | Description | Status Codes |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/videos/uploads/start` | Bearer JWT | Initiates draft and generates presigned multipart URLs | 201, 400, 401 |
| `POST` | `/videos/uploads/:id/complete` | Bearer JWT | Finalizes upload and enqueues processing | 200, 400, 401, 403, 404 |
| `POST` | `/videos/uploads/:id/abort` | Bearer JWT | Aborts upload session and cancels video | 200, 401, 403, 404 |
| `GET` | `/videos/:uniqueUrlId` | Optional | Retrieves video metadata | 200, 404 |
| `GET` | `/videos/:uniqueUrlId/stream` | Public | Streams video with HTTP 206 Range Requests | 206, 200, 404, 416 |
| `GET` | `/videos/:uniqueUrlId/download` | Public | Downloads raw video file | 200, 404 |

### Error Catalog

| Error Code | HTTP Status | Meaning |
| :--- | :--- | :--- |
| `VIDEO_NOT_FOUND` | 404 | Video not found by ID or unique URL |
| `INVALID_UPLOAD_STATE` | 400 | Attempted action invalid for current status (e.g. completing already completed video) |
| `UNAUTHORIZED_CHANNEL_ACTION` | 403 | User does not own the channel associated with the video |
| `FILE_SIZE_EXCEEDED` | 400 | Declared file size exceeds the 10GB limit |
| `VIDEO_PROCESSING_FAILED` | 500 | FFmpeg failed to process video metadata |

---
*Executable plan for Phase 03 generated and ready for SI-by-SI implementation.*
