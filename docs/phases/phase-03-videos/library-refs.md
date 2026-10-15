# Library References — Phase 03: Upload e Processamento de Vídeos

Este documento registra as bibliotecas fixadas para a Fase 03, verificadas para garantir compatibilidade com NestJS 11, TypeScript estrito e Docker Compose.

---

## 1. `@aws-sdk/client-s3` & `@aws-sdk/s3-request-presigner`

- **Versão alvo:** `^3.750.x`
- **Propósito:** Comunicação com o MinIO (Object Storage) usando a API oficial do AWS S3 v3 e geração de Presigned URLs para Multipart Upload de 10GB.
- **APIs Chave Utilizadas:**
  - `S3Client`: Inicializado com `endpoint: 'http://minio:9000'`, `region: 'us-east-1'`, `forcePathStyle: true`, credenciais do MinIO.
  - `CreateMultipartUploadCommand`: Inicia o upload multipart e retorna o `UploadId`.
  - `UploadPartCommand`: Usado em conjunto com `getSignedUrl` para gerar URLs pré-assinadas para cada chunk de upload (ex: chunks de 50MB a 100MB).
  - `CompleteMultipartUploadCommand`: Conclui o upload multipart no S3 recebendo o array de `{ PartNumber, ETag }`.
  - `AbortMultipartUploadCommand`: Limpa chunks e aborta a sessão em caso de cancelamento.
  - `GetObjectCommand`: Utilizado com Range Headers (`bytes=start-end`) para streaming parcial (`206 Partial Content`) e download do vídeo original.
  - `PutObjectCommand`: Salva thumbnails geradas pelo worker no bucket.
- **Cuidados & Invariantes:**
  - `forcePathStyle: true` é obrigatório no MinIO para evitar resolução de subdomínios `bucket.minio` no Docker.
  - O host interno do MinIO no Docker é `http://minio:9000`. Presigned URLs para o navegador do cliente no host usam `http://localhost:9000` ou passam por proxy transparente.

---

## 2. `bullmq` & `@nestjs/bullmq` & `ioredis`

- **Versões alvo:**
  - `@nestjs/bullmq: ^11.0.2`
  - `bullmq: ^5.41.x`
  - `ioredis: ^5.5.x`
- **Propósito:** Gerenciamento de fila de processamento assíncrono de vídeos entre a API NestJS (Produtora) e o Video Worker (Consumidor).
- **APIs Chave Utilizadas:**
  - `BullModule.forRootAsync`: Registra a conexão com o Redis (`host: 'redis'`, `port: 6379`).
  - `BullModule.registerQueue({ name: 'video-processing' })`: Injeta a fila de processamento nos serviços.
  - `Queue.add('process-video', jobData, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })`: Enfileira o processamento com política de retry.
  - `Worker` / `@Processor('video-processing')`: Consome jobs, reporta progresso via `job.updateProgress(percent)`.

---

## 3. `fluent-ffmpeg` & `@types/fluent-ffmpeg`

- **Versões alvo:**
  - `fluent-ffmpeg: ^2.1.3`
  - `@types/fluent-ffmpeg: ^2.1.27`
- **Propósito:** Execução de `ffprobe` para extração de metadados e duração, e `ffmpeg` para geração de imagem thumbnail de um frame chave.
- **APIs Chave Utilizadas:**
  - `ffmpeg.ffprobe(inputPath, (err, metadata) => ...)`: Extrai `format.duration`, `streams[0].codec_name`, `streams[0].width`, `streams[0].height`, `format.bit_rate`.
  - `ffmpeg(inputPath).screenshots({ timestamps: ['00:00:05.000'], filename: 'thumb.jpg', folder: tempDir, size: '1280x720' })`: Extrai o frame no segundo 5 (ou 10% da duração) como thumbnail JPEG.
- **Invariantes:**
  - O container de execução deve conter os binários `ffmpeg` e `ffprobe` instalados no path do sistema (`/usr/bin/ffmpeg`).

---

## 4. `nanoid`

- **Versão alvo:** `^3.3.8` (v3 CJS-compatível com Node/NestJS)
- **Propósito:** Geração de identificadores curtos (11 caracteres alfanuméricos URL-safe) para URLs públicas de vídeos (`unique_url_id`).
- **Uso:** `customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-', 11)()`.
