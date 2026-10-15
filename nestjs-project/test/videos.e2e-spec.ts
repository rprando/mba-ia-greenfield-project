import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/enums/video-status.enum';
import { StorageService } from '../src/storage/storage.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let videoRepo: Repository<Video>;
  let storageService: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  const fixturePath = '/tmp/e2e-fixture.mp4';

  beforeAll(async () => {
    // Generate a valid 2s MP4 video fixture with ffmpeg
    try {
      execSync(
        `ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=1 -c:v libx264 -pix_fmt yuv420p ${fixturePath} -y`,
        { stdio: 'ignore' },
      );
    } catch {
      void 0;
    }

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    userRepo = dataSource.getRepository(User);
    videoRepo = dataSource.getRepository(Video);
    storageService = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    await storageService.ensureBucketsExist();
  }, 120000);

  afterAll(async () => {
    await app.close();
    try {
      if (fs.existsSync(fixturePath)) {
        fs.unlinkSync(fixturePath);
      }
    } catch {
      void 0;
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerAndLogin(
    email: string,
    password = 'Password123!',
  ): Promise<{ accessToken: string; userId: string; channelId: string }> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken })
      .expect(204);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    const user = await userRepo.findOne({
      where: { email },
      relations: ['channel'],
    });

    return {
      accessToken: loginRes.body.access_token,
      userId: user!.id,
      channelId: user!.channel.id,
    };
  }

  describe('Full Video Upload, Processing, Streaming and Download Lifecycle', () => {
    it('should complete the entire flow from upload to streaming and download', async () => {
      const user = await registerAndLogin('uploader@streamtube.test');
      const videoBuffer = fs.readFileSync(fixturePath);

      // 1. Start Upload
      const startRes = await request(app.getHttpServer())
        .post('/videos/uploads/start')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          title: 'My E2E Test Video',
          description: 'Testing video pipeline end-to-end',
          filename: 'e2e-fixture.mp4',
          file_size: videoBuffer.length,
          parts_count: 1,
        })
        .expect(201);

      expect(startRes.body.video_id).toBeDefined();
      expect(startRes.body.upload_id).toBeDefined();
      expect(startRes.body.unique_url_id).toBeDefined();
      expect(startRes.body.part_urls).toHaveLength(1);
      expect(startRes.body.part_urls[0].partNumber).toBe(1);
      expect(startRes.body.part_urls[0].url).toContain('minio');

      const videoId = startRes.body.video_id;
      const uploadId = startRes.body.upload_id;
      const uniqueUrlId = startRes.body.unique_url_id;
      const partUrl = startRes.body.part_urls[0].url;

      // 2. Upload video chunk directly to MinIO via Presigned URL
      const putRes = await fetch(partUrl, {
        method: 'PUT',
        body: videoBuffer,
      });
      expect(putRes.ok).toBe(true);

      const rawEtag = putRes.headers.get('etag');
      expect(rawEtag).toBeDefined();
      const etag = rawEtag!.replace(/"/g, '');

      // 3. Complete Upload
      const completeRes = await request(app.getHttpServer())
        .post(`/videos/uploads/${videoId}/complete`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          upload_id: uploadId,
          parts: [{ part_number: 1, etag }],
        })
        .expect(200);

      expect(completeRes.body.id).toBe(videoId);
      expect(completeRes.body.status).toBe(VideoStatus.PROCESSING);

      // 4. Wait for BullMQ worker to process the video (status -> READY)
      let videoRecord: Video | null = null;
      const maxRetries = 30; // 30 * 500ms = 15 seconds
      for (let i = 0; i < maxRetries; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        videoRecord = await videoRepo.findOne({ where: { id: videoId } });
        if (
          videoRecord &&
          (videoRecord.status === VideoStatus.READY ||
            videoRecord.status === VideoStatus.ERROR)
        ) {
          break;
        }
      }

      expect(videoRecord).not.toBeNull();
      expect(videoRecord!.status).toBe(VideoStatus.READY);
      expect(videoRecord!.duration_seconds).toBeGreaterThan(0);
      expect(videoRecord!.thumbnail_storage_key).toBeDefined();
      expect(videoRecord!.metadata).toBeDefined();
      expect(videoRecord!.metadata!.width).toBe(320);
      expect(videoRecord!.metadata!.height).toBe(240);

      // 5. Public GET /videos/:uniqueUrlId (no authentication needed)
      const getRes = await request(app.getHttpServer())
        .get(`/videos/${uniqueUrlId}`)
        .expect(200);

      expect(getRes.body.id).toBe(videoId);
      expect(getRes.body.title).toBe('My E2E Test Video');
      expect(getRes.body.status).toBe(VideoStatus.READY);
      expect(getRes.body.duration_seconds).toBe(videoRecord!.duration_seconds);
      expect(getRes.body.channel.id).toBe(user.channelId);

      // 6. Public GET /videos/:uniqueUrlId/stream with Range header (HTTP 206)
      const rangeRes = await request(app.getHttpServer())
        .get(`/videos/${uniqueUrlId}/stream`)
        .set('Range', 'bytes=0-49')
        .expect(206);

      expect(rangeRes.headers['accept-ranges']).toBe('bytes');
      expect(rangeRes.headers['content-range']).toMatch(/^bytes 0-49\//);
      expect(rangeRes.headers['content-length']).toBe('50');
      expect(rangeRes.headers['content-type']).toBe('video/mp4');

      // 7. Public GET /videos/:uniqueUrlId/stream without Range (HTTP 200)
      const fullStreamRes = await request(app.getHttpServer())
        .get(`/videos/${uniqueUrlId}/stream`)
        .expect(200);

      expect(fullStreamRes.headers['accept-ranges']).toBe('bytes');
      expect(fullStreamRes.headers['content-type']).toBe('video/mp4');
      expect(fullStreamRes.headers['content-length']).toBe(
        String(videoBuffer.length),
      );

      // 8. Public GET /videos/:uniqueUrlId/download
      const downloadRes = await request(app.getHttpServer())
        .get(`/videos/${uniqueUrlId}/download`)
        .expect(200);

      expect(downloadRes.headers['content-disposition']).toBe(
        'attachment; filename="e2e-fixture.mp4"',
      );
      expect(downloadRes.headers['content-length']).toBe(
        String(videoBuffer.length),
      );
    }, 60000);
  });

  describe('DRAFT Visibility and Abort Upload', () => {
    it('should enforce private access for DRAFT videos and allow owner to abort', async () => {
      const owner = await registerAndLogin('owner@streamtube.test');
      const otherUser = await registerAndLogin('viewer@streamtube.test');

      // 1. Owner starts an upload (video in DRAFT)
      const startRes = await request(app.getHttpServer())
        .post('/videos/uploads/start')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          title: 'Draft Private Video',
          filename: 'draft.mp4',
          file_size: 5000000,
          parts_count: 1,
        })
        .expect(201);

      const videoId = startRes.body.video_id;
      const uniqueUrlId = startRes.body.unique_url_id;

      // 2. Unauthenticated user cannot view DRAFT video -> 404
      await request(app.getHttpServer())
        .get(`/videos/${uniqueUrlId}`)
        .expect(404);

      // 3. Other authenticated user cannot view DRAFT video -> 404
      await request(app.getHttpServer())
        .get(`/videos/${uniqueUrlId}`)
        .set('Authorization', `Bearer ${otherUser.accessToken}`)
        .expect(404);

      // 4. Owner can view own DRAFT video -> 200
      const ownerGetRes = await request(app.getHttpServer())
        .get(`/videos/${uniqueUrlId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(ownerGetRes.body.id).toBe(videoId);
      expect(ownerGetRes.body.status).toBe(VideoStatus.DRAFT);

      // 5. Other user cannot abort owner's video -> 403
      await request(app.getHttpServer())
        .post(`/videos/uploads/${videoId}/abort`)
        .set('Authorization', `Bearer ${otherUser.accessToken}`)
        .expect(403);

      // 6. Owner aborts upload -> 200 (status CANCELLED)
      const abortRes = await request(app.getHttpServer())
        .post(`/videos/uploads/${videoId}/abort`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(abortRes.body.id).toBe(videoId);
      expect(abortRes.body.status).toBe(VideoStatus.CANCELLED);

      // 7. Attempting to complete aborted video fails -> 400
      await request(app.getHttpServer())
        .post(`/videos/uploads/${videoId}/complete`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          upload_id: 'some-upload-id',
          parts: [{ part_number: 1, etag: 'etag' }],
        })
        .expect(400);
    });
  });

  describe('Validation & Authorization Checks', () => {
    it('should reject unauthenticated upload start with 401', async () => {
      await request(app.getHttpServer())
        .post('/videos/uploads/start')
        .send({
          title: 'Unauthorized Video',
          filename: 'video.mp4',
          file_size: 1000,
          parts_count: 1,
        })
        .expect(401);
    });

    it('should reject file sizes larger than 10GB with 400', async () => {
      const user = await registerAndLogin('sizelimit@streamtube.test');
      const oversized = 10 * 1024 * 1024 * 1024 + 1; // 10 GB + 1 byte

      const res = await request(app.getHttpServer())
        .post('/videos/uploads/start')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          title: 'Too Large Video',
          filename: 'huge.mp4',
          file_size: oversized,
          parts_count: 1,
        })
        .expect(400);

      expect(res.body.message).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            'File size exceeds maximum allowed limit of 10GB',
          ),
        ]),
      );
    });

    it('should reject missing required fields with 400', async () => {
      const user = await registerAndLogin('validator@streamtube.test');

      await request(app.getHttpServer())
        .post('/videos/uploads/start')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          // missing title, filename, file_size, parts_count
        })
        .expect(400);
    });

    it('should return 404 for non-existent video', async () => {
      await request(app.getHttpServer())
        .get('/videos/non-existent-unique-id')
        .expect(404);
    });
  });
});
