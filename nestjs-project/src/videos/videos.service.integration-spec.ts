import { DataSource, Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './enums/video-status.enum';
import { VideosService } from './videos.service';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  UnauthorizedChannelActionException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let channelRepo: Repository<Channel>;
  let userRepo: Repository<User>;
  let service: VideosService;
  let mockStorageService: Partial<Record<keyof StorageService, jest.Mock>>;
  let mockQueue: Partial<Record<keyof Queue, jest.Mock>>;

  let userA: User;
  let channelA: Channel;
  let userB: User;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videoRepo = dataSource.getRepository(Video);
    channelRepo = dataSource.getRepository(Channel);
    userRepo = dataSource.getRepository(User);

    mockStorageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('test-upload-id-123'),
      getPresignedPartUrls: jest
        .fn()
        .mockResolvedValue([{ partNumber: 1, url: 'http://minio:9000/part1' }]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };

    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    service = new VideosService(
      videoRepo,
      channelRepo,
      mockStorageService as unknown as StorageService,
      mockQueue as unknown as Queue,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    userA = await userRepo.save(
      userRepo.create({
        email: 'creator_a@example.com',
        password: 'hashed_password',
        is_confirmed: true,
      }),
    );

    channelA = await channelRepo.save(
      channelRepo.create({
        name: 'Channel A',
        nickname: 'channel_a',
        user_id: userA.id,
      }),
    );

    userB = await userRepo.save(
      userRepo.create({
        email: 'creator_b@example.com',
        password: 'hashed_password',
        is_confirmed: true,
      }),
    );

    await channelRepo.save(
      channelRepo.create({
        name: 'Channel B',
        nickname: 'channel_b',
        user_id: userB.id,
      }),
    );
  });

  it('should start upload and persist DRAFT video in database', async () => {
    const startResult = await service.startUpload(userA.id, {
      title: 'Database Persistence Test',
      description: 'Testing video creation in DB',
      filename: 'sample.mp4',
      file_size: 1048576,
      parts_count: 1,
    });

    expect(startResult.video_id).toBeDefined();
    expect(startResult.unique_url_id).toHaveLength(12);

    const persisted = await videoRepo.findOneBy({ id: startResult.video_id });
    expect(persisted).toBeDefined();
    expect(persisted?.title).toBe('Database Persistence Test');
    expect(persisted?.status).toBe(VideoStatus.DRAFT);
    expect(persisted?.channel_id).toBe(channelA.id);
  });

  it('should complete upload, update status to PROCESSING and enqueue job', async () => {
    const startResult = await service.startUpload(userA.id, {
      title: 'Upload to Complete',
      filename: 'complete.mp4',
      file_size: 2048,
      parts_count: 1,
    });

    const completeResult = await service.completeUpload(
      userA.id,
      startResult.video_id,
      {
        upload_id: startResult.upload_id,
        parts: [{ part_number: 1, etag: 'etag123' }],
      },
    );

    expect(completeResult.status).toBe(VideoStatus.PROCESSING);

    const updated = await videoRepo.findOneBy({ id: startResult.video_id });
    expect(updated?.status).toBe(VideoStatus.PROCESSING);
    expect(mockQueue.add).toHaveBeenCalledWith(
      'process-video',
      expect.objectContaining({ videoId: startResult.video_id }),
      expect.any(Object),
    );
  });

  it('should reject complete upload if attempted by a different user', async () => {
    const startResult = await service.startUpload(userA.id, {
      title: 'A’s Video',
      filename: 'video.mp4',
      file_size: 2048,
      parts_count: 1,
    });

    await expect(
      service.completeUpload(userB.id, startResult.video_id, {
        upload_id: startResult.upload_id,
        parts: [{ part_number: 1, etag: 'etag123' }],
      }),
    ).rejects.toThrow(UnauthorizedChannelActionException);

    // Status remains DRAFT
    const video = await videoRepo.findOneBy({ id: startResult.video_id });
    expect(video?.status).toBe(VideoStatus.DRAFT);
  });

  it('should abort upload and transition status to CANCELLED', async () => {
    const startResult = await service.startUpload(userA.id, {
      title: 'To Abort',
      filename: 'abort.mp4',
      file_size: 2048,
      parts_count: 1,
    });

    const abortResult = await service.abortUpload(
      userA.id,
      startResult.video_id,
    );
    expect(abortResult.status).toBe(VideoStatus.CANCELLED);

    const video = await videoRepo.findOneBy({ id: startResult.video_id });
    expect(video?.status).toBe(VideoStatus.CANCELLED);
  });

  it('should allow channel owner to view DRAFT video but forbid other users', async () => {
    const startResult = await service.startUpload(userA.id, {
      title: 'Draft Visibility Test',
      filename: 'draft.mp4',
      file_size: 2048,
      parts_count: 1,
    });

    // Owner can view
    const ownerView = await service.getVideoByUniqueUrlId(
      startResult.unique_url_id,
      userA.id,
    );
    expect(ownerView.id).toBe(startResult.video_id);

    // Non-owner gets 404
    await expect(
      service.getVideoByUniqueUrlId(startResult.unique_url_id, userB.id),
    ).rejects.toThrow(VideoNotFoundException);

    // Anonymous gets 404
    await expect(
      service.getVideoByUniqueUrlId(startResult.unique_url_id),
    ).rejects.toThrow(VideoNotFoundException);
  });
});
