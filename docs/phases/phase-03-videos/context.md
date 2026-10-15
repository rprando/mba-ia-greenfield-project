---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-04-08T14:58:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-07T20:39:13-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-05-12T12:23:19-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails) via MinIO/S3
- Serviço de processamento em segundo plano (filas com BullMQ + Redis)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance (Presigned Multipart Upload)
- Pré-cadastro automático do vídeo como rascunho (status `DRAFT`) ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados via ffprobe)
- Geração automática de thumbnail a partir de um frame do vídeo via ffmpeg
- URL única por vídeo gerada via NanoID, sem conflito com outros vídeos
- Reprodução via streaming com suporte a Range Requests (`206 Partial Content`)
- Download seguro do arquivo original de vídeo pelo usuário

**Out of scope:** Interface visual no Next.js (frontend de vídeo fica para fases subsequentes), comentários, likes/dislikes (Fase 06), edição de metadados avançada e painel do criador (Fase 04).

**Deliverables:** Upload de até 10GB funcional, processamento automático com extração de metadados e thumbnail, streaming e download funcionais, URLs curtas únicas geradas, infraestrutura completa no Docker Compose (MinIO, Redis, Worker) e suíte de testes 100% verde.

**Affected subprojects:** `nestjs-project/`, Docker Compose (`compose.yaml`).

**Deferred subprojects:** `next-frontend/` (Player UI e Upload form diferidos para fases posteriores).

**Sequencing notes:** Depende estritamente da Fase 01 (Configuração Base) e Fase 02 (Autenticação, Usuários e Canais 1:1).

**Neighbors:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend / Infra | Message Queue Technology | decided | B (BullMQ with Redis) | bullmq@^5.x, ioredis@^5.x, @nestjs/bullmq@^11.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend / Storage | 10GB Upload Strategy without API Memory Bottlenecks | decided | B (S3 Presigned Multipart Upload) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Worker / Infra | Video Worker Execution Architecture | decided | B (Dedicated Video Worker Container with FFmpeg) | fluent-ffmpeg@^2.1.x, @types/fluent-ffmpeg |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend / API | Streaming and Unique URL Strategy | decided | B (HTTP Range Requests 206 + NanoID 11 chars) | nanoid@^3.x |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend / Domain | Video Status Lifecycle & Error Resilience | decided | B (State Machine: DRAFT, PROCESSING, READY, ERROR, CANCELLED) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covering Decisions |
| :--- | :--- |
| Armazenamento de arquivos (vídeos e thumbnails) | TD-02 (MinIO / S3 buckets e client SDK) |
| Fila de processamento em segundo plano e worker | TD-01 (BullMQ + Redis), TD-03 (Worker FFmpeg dedicado) |
| Upload de até 10GB sem travar o sistema | TD-02 (S3 Presigned Multipart Upload) |
| Pré-cadastro automático do vídeo como rascunho | TD-05 (Status `DRAFT` na inicialização do upload) |
| Processamento automático (duração e metadados) | TD-03 (ffprobe no Worker) |
| Geração automática de thumbnail de frame do vídeo | TD-03 (ffmpeg extraindo frame no segundo 5) |
| URL única por vídeo sem conflito | TD-04 (NanoID 11 caracteres com índice único no banco) |
| Reprodução via streaming | TD-04 (HTTP 206 Range Requests direto do Storage Stream) |
| Download do vídeo | TD-04 (HTTP 200 Stream com Content-Disposition) |

---
*Contexto da Fase 03 estruturado e validado contra o plano do projeto.*
