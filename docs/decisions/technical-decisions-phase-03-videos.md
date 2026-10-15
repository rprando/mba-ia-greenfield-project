---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-07
scope_description: "Backend and infrastructure foundation for video upload, asynchronous processing queue, worker with FFmpeg, unique URL generation, streaming, and download."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers video entity management, upload session lifecycle, S3 presigned multipart upload generation, processing queue publisher, video streaming via HTTP 206 Range Requests, and secure download.
- `Worker & Infrastructure` — Docker Compose infrastructure additions: MinIO (S3-compatible object storage), Redis (queue store), and dedicated Video Worker executing FFmpeg/ffprobe.

---

## TD-01: Message Queue Technology

**Scope:** Backend / Infrastructure

**Capability:** Fila de processamento em segundo plano e worker que a consome

**Context:** Video processing (probing metadata, transcoding, extracting thumbnail frames) is computationally intensive (CPU/RAM-heavy). It must not execute synchronously in HTTP request threads. The project plan leaves queue technology as "TBD". The choice impacts developer velocity, NestJS integration, operational complexity in Docker, and monitoring capabilities.

**Options:**

### Option A: RabbitMQ (AMQP)
- Traditional message broker. Erlang-based image. Supports exchanges, bindings, routing keys, and consumer acknowledgments.
- **Pros:** Enterprise-grade AMQP 0-9-1 standard, durable queues, flexible topic routing, built-in management UI (port 15672).
- **Cons:** Heavy footprint in local Docker Compose (~150MB+ RAM base). Complex configuration in NestJS microservices without strong out-of-the-box job scheduling/retry semantics compared to BullMQ. Lacks native job progress percentage tracking.

### Option B: BullMQ with Redis
- Modern Redis-backed queue system built specifically for Node.js/TypeScript environments. Uses Redis 7+ streams and atomic Lua scripts.
- **Pros:**
  - First-class support in NestJS via `@nestjs/bullmq` / `bullmq` with strict TypeScript typings.
  - Built-in exponential backoff retries, delayed jobs, job progress tracking (`job.updateProgress(percent)`), and Dead Letter Queue (DLQ) pattern for failed jobs.
  - Lightweight Docker container (Redis requires <30MB RAM base).
  - Can double as cache or session store if needed later.
- **Cons:** Requires Redis as a dependent infrastructure service. In-memory data store requires proper persistence configuration (`appendonly yes`) in Docker.

### Option C: AWS SQS (Simulated via LocalStack)
- Cloud-native managed queue service.
- **Pros:** 1:1 parity with AWS production deployments.
- **Cons:** Heavy LocalStack container required in local development. High startup latency. Polling architecture instead of push-based event loops.

**Recommendation:** **BullMQ with Redis** — It provides native TypeScript integration, job progress reporting, automatic retry policies with backoff, and minimal resource overhead in Docker Compose. It aligns perfectly with NestJS patterns and avoids the operational weight of RabbitMQ or LocalStack.

**Decision:** B (BullMQ with Redis)

---

## TD-02: 10GB Upload Strategy without API Memory Bottlenecks

**Scope:** Backend / Storage

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The challenge explicitly requires handling video files up to 10GB without holding or crashing the NestJS API server. If 10GB files are streamed or buffered directly through NestJS, Node.js memory limits (`max-old-space-size`), event loop saturation, and socket timeouts will degrade or crash the service.

**Options:**

### Option A: Chunked Upload proxied through NestJS API (Multer / Busboy Stream)
- The frontend breaks the file into chunks and posts each chunk to NestJS endpoints (`/videos/upload/chunk`), which pipes them into MinIO.
- **Pros:** All authentication and validation occur on every chunk without presigned signatures.
- **Cons:** The API server acts as an I/O bottleneck. Network traffic is doubled (Client $\rightarrow$ API $\rightarrow$ MinIO). CPU and network I/O in the API container are tied up for large files, violating the requirement of "upload sem segurar a API durante o envio".

### Option B: S3 Presigned Multipart Upload (Direct Client-to-Storage)
- The client requests an upload session from NestJS (`POST /videos/uploads/start`). The API validates permissions, pre-creates a `Video` entity in `DRAFT` status, initiates an S3 Multipart Upload, and returns presigned URLs for each part (e.g., 100MB chunks).
- The client uploads each chunk directly to MinIO/S3 using HTTP `PUT` to the presigned URLs.
- Once all chunks are uploaded, the client calls `POST /videos/uploads/complete` with the part ETags. NestJS completes the multipart upload on S3 and enqueues the processing job.
- **Pros:**
  - Zero binary payload passes through the NestJS process. The API only handles lightweight JSON control messages (<1KB).
  - High throughput: Uploads scale with the object storage network bandwidth, not API server RAM/CPU.
  - Native resumability: If an upload fails on part 42 of 100, only part 42 needs to be retried.
  - Works with standard S3 API (MinIO in development, AWS S3 in production).
- **Cons:** Requires client-side awareness of multipart coordination (standard in YouTube-style video platforms). Presigned URLs must have strict expiration times (e.g., 2 hours).

**Recommendation:** **S3 Presigned Multipart Upload (Option B)** — This is the only production-grade architectural pattern that satisfies the requirement of handling 10GB uploads without tying up API resources.

**Decision:** B (S3 Presigned Multipart Upload)

---

## TD-03: Video Worker Execution Architecture

**Scope:** Worker / Infrastructure

**Capability:** Processamento automático do vídeo após upload e geração automática de thumbnail

**Context:** After upload completion, the video must be processed: duration and metadata (codec, resolution, bitrate) extracted, and a representative thumbnail image generated at a specific frame (e.g., at second 5 or 10% of total duration). FFmpeg is a native binary that consumes high CPU and memory during execution.

**Options:**

### Option A: Worker running inside the main NestJS API container
- A BullMQ `@Processor()` registered directly inside `nestjs-project/src/videos/`.
- **Pros:** Single codebase and single container process. Shared database connections and services.
- **Cons:** CPU spikes during FFmpeg execution compete with HTTP request handling, degrading API response latency. Requires installing FFmpeg binaries into the API Docker image.

### Option B: Dedicated Video Worker Container
- A separate container running in Docker Compose with FFmpeg installed.
- Consumes jobs from the BullMQ Redis queue, downloads the video from MinIO, invokes `ffprobe` for metadata and `ffmpeg` for thumbnail extraction, uploads the generated thumbnail to MinIO, and updates the database record.
- **Pros:**
  - Process and resource isolation: FFmpeg CPU utilization does not affect HTTP request latency.
  - Can scale independently in production (e.g., multiple worker replicas for high upload volume).
  - API image remains lean without native video processing dependencies.
- **Cons:** Requires defining an additional service in `compose.yaml`.

**Recommendation:** **Dedicated Video Worker Container (Option B)** — Guarantees resource isolation and adheres to the C4 Architecture diagram (`docs/diagrams/software-arch.mermaid`), which explicitly depicts the Video Worker as a distinct container.

**Decision:** B (Dedicated Video Worker Container)

---

## TD-04: Streaming and Unique URL Strategy

**Scope:** Backend / API

**Capability:** URL única por vídeo e reprodução via streaming

**Context:** Each video requires a collision-resistant, short, human-friendly unique URL identifier (e.g., YouTube's `watch?v=dQw4w9WgXcQ`). Furthermore, users must be able to watch videos without downloading the entire file upfront.

**Options:**

### Unique URL Identifier:
- **Option 1: Sequential integer / UUID v4:** Predictable or excessively long (36 characters).
- **Option 2: NanoID (URL-safe, 11 characters):** Generates collision-resistant, URL-safe 11-character strings (e.g., `c8A9zX-1kL2`) with over $10^{16}$ combinations, identical to YouTube video IDs.
- **Decision:** **NanoID (11 chars, url-safe)** — indexed uniquely in the `videos` table (`unique_url_id`).

### Streaming Strategy:
- **Option 1: HLS (HTTP Live Streaming) Transcoding:**
  - Segments video into `.ts` chunks with `.m3u8` playlists.
  - *Pros:* Adaptive bitrate streaming across fluctuating networks.
  - *Cons:* Full transcode takes minutes to hours for 10GB files before the video can even begin playing. High storage multiplication.
- **Option 2: HTTP Range Requests (`206 Partial Content`):**
  - The client requests specific byte ranges (e.g., `bytes=0-1048575`). The server streams byte ranges directly from the storage service. HTML5 `<video>` natively buffers chunks on demand.
  - *Pros:* Instant playback availability right after initial metadata extraction. No lengthy transcode wait time. Low storage overhead. Standard HTTP specification.
  - *Cons:* Fixed bitrate (does not adapt resolution dynamically).
- **Decision:** **HTTP Range Requests (`206 Partial Content`)** — Enables immediate, seekable streaming playback without requiring multi-bitrate HLS pre-encoding in Phase 03.

---

## TD-05: Video Status Lifecycle & Error Resilience

**Scope:** Backend / Domain Model

**Capability:** Ciclo de status do vídeo e resiliência a falhas

**Context:** The video upload and processing lifecycle has multiple asynchronous stages: user initiates upload $\rightarrow$ chunks are uploaded $\rightarrow$ upload completed $\rightarrow$ worker extracts metadata and thumbnail $\rightarrow$ video ready for viewing. Unexpected failures (network interruption, corrupt video file, unsupported codec) must be handled gracefully.

**Lifecycle State Machine:**
```
[DRAFT] ──(upload completed)──> [PROCESSING] ──(ffmpeg success)──> [READY]
   │                                   │
   └──(aborted / timeout)──> [CANCELLED]└──(ffmpeg failure)──> [ERROR]
```

**Decisions:**
1. **Status Enum:** `DRAFT` | `PROCESSING` | `READY` | `ERROR` | `CANCELLED`.
2. **Draft Expiration:** Upload sessions that remain in `DRAFT` beyond 24 hours can be cleaned up.
3. **Worker Error Handling:** BullMQ job is configured with 3 retries and exponential backoff. If all retries fail (e.g., corrupted file), the worker sets status to `ERROR` and persists the failure reason in `video.metadata.error_message`.
4. **Access Control:** Only the channel owner can view/manage videos in `DRAFT`, `PROCESSING`, or `ERROR` status. Videos in `READY` status are publicly accessible via their `unique_url_id`.

---
*Technical Decisions for Phase 03 decided and documented.*
