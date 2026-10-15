import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../enums/video-status.enum';
import { VideoProcessor } from './video.processor';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { UploadPartCommand } from '@aws-sdk/client-s3';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessor (integration with real FFmpeg & MinIO)', () => {
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let channelRepo: Repository<Channel>;
  let userRepo: Repository<User>;
  let storageService: StorageService;
  let processor: VideoProcessor;
  let testChannel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videoRepo = dataSource.getRepository(Video);
    channelRepo = dataSource.getRepository(Channel);
    userRepo = dataSource.getRepository(User);

    const configService = new ConfigService({
      storage: {
        endpoint: process.env.STORAGE_ENDPOINT ?? 'http://minio:9000',
        accessKey: process.env.STORAGE_ACCESS_KEY ?? 'minioadmin',
        secretKey: process.env.STORAGE_SECRET_KEY ?? 'minioadmin',
        bucketVideos: 'test-videos',
        bucketThumbnails: 'test-thumbnails',
        forcePathStyle: true,
      },
    });

    storageService = new StorageService(configService);
    await storageService.ensureBucketsExist();

    processor = new VideoProcessor(videoRepo, storageService);

    // Generate real 2-second valid MP4 fixture via ffmpeg CLI in container
    try {
      execSync(
        'ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=1 -c:v libx264 -pix_fmt yuv420p /tmp/fixture.mp4 -y',
        { stdio: 'ignore' },
      );
    } catch {
      void 0;
    }
  });

  afterAll(async () => {
    await dataSource.destroy();
    try {
      fs.unlinkSync('/tmp/fixture.mp4');
    } catch {
      void 0;
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const user = await userRepo.save(
      userRepo.create({
        email: 'worker_tester@example.com',
        password: 'hashed_password',
        is_confirmed: true,
      }),
    );

    testChannel = await channelRepo.save(
      channelRepo.create({
        name: 'Worker Test Channel',
        nickname: 'worker_tester',
        user_id: user.id,
      }),
    );
  });

  async function uploadFileToMinIO(
    key: string,
    filePathOrBuffer: string | Buffer,
  ): Promise<void> {
    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );
    const body = Buffer.isBuffer(filePathOrBuffer)
      ? filePathOrBuffer
      : fs.readFileSync(filePathOrBuffer);

    const s3 = storageService.getS3Client();
    const partRes = await s3.send(
      new UploadPartCommand({
        Bucket: storageService.getVideosBucketName(),
        Key: key,
        UploadId: uploadId,
        PartNumber: 1,
        Body: body,
      }),
    );

    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: partRes.ETag! },
    ]);
  }

  it('should process a valid MP4 video: extract metadata, generate thumbnail, and set status to READY', async () => {
    const storageKey = `videos/${testChannel.id}/test-valid-${Date.now()}.mp4`;
    await uploadFileToMinIO(storageKey, '/tmp/fixture.mp4');

    const video = await videoRepo.save(
      videoRepo.create({
        channel_id: testChannel.id,
        title: 'Valid Video Process Test',
        status: VideoStatus.PROCESSING,
        original_storage_key: storageKey,
        unique_url_id: `vld${Date.now()}`.slice(0, 12),
      }),
    );

    const jobMock = {
      data: { videoId: video.id, key: storageKey },
      attemptsMade: 0,
    } as any;

    const result = await processor.process(jobMock);
    expect(result.success).toBe(true);

    const updated = await videoRepo.findOneBy({ id: video.id });
    expect(updated).toBeDefined();
    expect(updated?.status).toBe(VideoStatus.READY);
    expect(updated?.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(updated?.thumbnail_storage_key).toBeDefined();
    expect(updated?.metadata).toEqual(
      expect.objectContaining({
        codec: 'h264',
        width: 320,
        height: 240,
      }),
    );

    // Verify thumbnail exists in MinIO
    const thumbStream = await storageService.getThumbnailStream(
      updated!.thumbnail_storage_key!,
    );
    expect(thumbStream).toBeDefined();

    // Cleanup
    await storageService.deleteVideoObject(storageKey);
    await storageService.deleteThumbnailObject(updated!.thumbnail_storage_key!);
  });

  it('should gracefully handle corrupt video file by transitioning to ERROR status', async () => {
    const corruptKey = `videos/${testChannel.id}/corrupt-${Date.now()}.mp4`;
    await uploadFileToMinIO(
      corruptKey,
      Buffer.from('NOT_A_VALID_MP4_HEADER_GARBAGE'),
    );

    const video = await videoRepo.save(
      videoRepo.create({
        channel_id: testChannel.id,
        title: 'Corrupt Video Test',
        status: VideoStatus.PROCESSING,
        original_storage_key: corruptKey,
        unique_url_id: `crp${Date.now()}`.slice(0, 12),
      }),
    );

    const jobMock = {
      data: { videoId: video.id, key: corruptKey },
      attemptsMade: 0,
    } as any;

    await expect(processor.process(jobMock)).rejects.toThrow();

    const updated = await videoRepo.findOneBy({ id: video.id });
    expect(updated?.status).toBe(VideoStatus.ERROR);
    expect((updated?.metadata as any)?.error_message).toBeDefined();

    // Cleanup
    await storageService.deleteVideoObject(corruptKey);
  });
});
