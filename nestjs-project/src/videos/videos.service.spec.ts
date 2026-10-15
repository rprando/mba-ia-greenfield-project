import { Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { VideosService } from './videos.service';
import { Video } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from './enums/video-status.enum';
import {
  VideoNotFoundException,
  InvalidUploadStateException,
  UnauthorizedChannelActionException,
  FileSizeExceededException,
} from './exceptions/video.exceptions';

describe('VideosService (unit)', () => {
  let service: VideosService;
  let videoRepo: Partial<Record<keyof Repository<Video>, jest.Mock>>;
  let channelRepo: Partial<Record<keyof Repository<Channel>, jest.Mock>>;
  let storageService: Partial<Record<keyof StorageService, jest.Mock>>;
  let videoQueue: Partial<Record<keyof Queue, jest.Mock>>;

  const mockChannel = {
    id: 'channel-uuid-1',
    name: 'My Channel',
    nickname: 'mychannel',
    user_id: 'user-uuid-1',
  } as Channel;

  beforeEach(() => {
    videoRepo = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      create: jest.fn((entity) => ({ id: 'video-uuid-1', ...entity })),
      save: jest.fn(async (entity) => entity),
    };

    channelRepo = {
      findOneBy: jest.fn(),
    };

    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('s3-upload-id-999'),
      getPresignedPartUrls: jest.fn().mockResolvedValue([
        { partNumber: 1, url: 'http://s3/part1' },
        { partNumber: 2, url: 'http://s3/part2' },
      ]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };

    videoQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    service = new VideosService(
      videoRepo as unknown as Repository<Video>,
      channelRepo as unknown as Repository<Channel>,
      storageService as unknown as StorageService,
      videoQueue as unknown as Queue,
    );
  });

  describe('startUpload', () => {
    it('should successfully initiate multipart upload and create DRAFT video', async () => {
      channelRepo.findOneBy!.mockResolvedValue(mockChannel);

      const result = await service.startUpload('user-uuid-1', {
        title: 'Awesome Video',
        description: 'Test description',
        filename: 'my_video.mp4',
        file_size: 50 * 1024 * 1024,
        parts_count: 2,
      });

      expect(result.upload_id).toBe('s3-upload-id-999');
      expect(result.unique_url_id).toHaveLength(12);
      expect(result.part_urls).toHaveLength(2);
      expect(videoRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'channel-uuid-1',
          title: 'Awesome Video',
          status: VideoStatus.DRAFT,
        }),
      );
      expect(videoRepo.save).toHaveBeenCalled();
    });

    it('should throw UnauthorizedChannelActionException if channel does not exist', async () => {
      channelRepo.findOneBy!.mockResolvedValue(null);

      await expect(
        service.startUpload('user-no-channel', {
          title: 'Video',
          filename: 'video.mp4',
          file_size: 1000,
          parts_count: 1,
        }),
      ).rejects.toThrow(UnauthorizedChannelActionException);
    });

    it('should throw FileSizeExceededException if file_size exceeds 10GB', async () => {
      channelRepo.findOneBy!.mockResolvedValue(mockChannel);

      await expect(
        service.startUpload('user-uuid-1', {
          title: 'Huge Video',
          filename: 'huge.mp4',
          file_size: 11 * 1024 * 1024 * 1024, // 11 GB
          parts_count: 10,
        }),
      ).rejects.toThrow(FileSizeExceededException);
    });
  });

  describe('completeUpload', () => {
    it('should complete S3 multipart, transition status to PROCESSING and enqueue job', async () => {
      const draftVideo = {
        id: 'video-uuid-1',
        channel_id: 'channel-uuid-1',
        unique_url_id: 'abc123456789',
        status: VideoStatus.DRAFT,
        original_storage_key: 'videos/channel-1/video.mp4',
        channel: mockChannel,
      } as Video;

      videoRepo.findOne!.mockResolvedValue(draftVideo);

      const result = await service.completeUpload(
        'user-uuid-1',
        'video-uuid-1',
        {
          upload_id: 's3-upload-id-999',
          parts: [
            { part_number: 1, etag: 'etag-1' },
            { part_number: 2, etag: 'etag-2' },
          ],
        },
      );

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/channel-1/video.mp4',
        's3-upload-id-999',
        [
          { partNumber: 1, etag: 'etag-1' },
          { partNumber: 2, etag: 'etag-2' },
        ],
      );
      expect(draftVideo.status).toBe(VideoStatus.PROCESSING);
      expect(videoRepo.save).toHaveBeenCalledWith(draftVideo);
      expect(videoQueue.add).toHaveBeenCalledWith(
        'process-video',
        expect.objectContaining({ videoId: 'video-uuid-1' }),
        expect.any(Object),
      );
      expect(result.status).toBe(VideoStatus.PROCESSING);
    });

    it('should throw VideoNotFoundException if video does not exist', async () => {
      videoRepo.findOne!.mockResolvedValue(null);

      await expect(
        service.completeUpload('user-uuid-1', 'nonexistent', {
          upload_id: 'up-1',
          parts: [{ part_number: 1, etag: 'etag-1' }],
        }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should throw UnauthorizedChannelActionException if user is not the owner', async () => {
      const draftVideo = {
        id: 'video-uuid-1',
        channel: { user_id: 'other-user' },
        status: VideoStatus.DRAFT,
      } as unknown as Video;

      videoRepo.findOne!.mockResolvedValue(draftVideo);

      await expect(
        service.completeUpload('user-uuid-1', 'video-uuid-1', {
          upload_id: 'up-1',
          parts: [{ part_number: 1, etag: 'etag-1' }],
        }),
      ).rejects.toThrow(UnauthorizedChannelActionException);
    });

    it('should throw InvalidUploadStateException if video is not in DRAFT status', async () => {
      const readyVideo = {
        id: 'video-uuid-1',
        channel: mockChannel,
        status: VideoStatus.READY,
      } as unknown as Video;

      videoRepo.findOne!.mockResolvedValue(readyVideo);

      await expect(
        service.completeUpload('user-uuid-1', 'video-uuid-1', {
          upload_id: 'up-1',
          parts: [{ part_number: 1, etag: 'etag-1' }],
        }),
      ).rejects.toThrow(InvalidUploadStateException);
    });
  });

  describe('abortUpload', () => {
    it('should abort S3 multipart and transition to CANCELLED', async () => {
      const draftVideo = {
        id: 'video-uuid-1',
        channel: mockChannel,
        status: VideoStatus.DRAFT,
        original_storage_key: 'videos/channel-1/video.mp4',
        metadata: { upload_id: 's3-upload-id-999' },
      } as unknown as Video;

      videoRepo.findOne!.mockResolvedValue(draftVideo);

      const result = await service.abortUpload('user-uuid-1', 'video-uuid-1');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/channel-1/video.mp4',
        's3-upload-id-999',
      );
      expect(draftVideo.status).toBe(VideoStatus.CANCELLED);
      expect(result.status).toBe(VideoStatus.CANCELLED);
    });

    it('should throw UnauthorizedChannelActionException if not owner', async () => {
      const draftVideo = {
        id: 'video-uuid-1',
        channel: { user_id: 'other-user' },
        status: VideoStatus.DRAFT,
      } as unknown as Video;

      videoRepo.findOne!.mockResolvedValue(draftVideo);

      await expect(
        service.abortUpload('user-uuid-1', 'video-uuid-1'),
      ).rejects.toThrow(UnauthorizedChannelActionException);
    });

    it('should throw InvalidUploadStateException if not DRAFT', async () => {
      const processingVideo = {
        id: 'video-uuid-1',
        channel: mockChannel,
        status: VideoStatus.PROCESSING,
      } as unknown as Video;

      videoRepo.findOne!.mockResolvedValue(processingVideo);

      await expect(
        service.abortUpload('user-uuid-1', 'video-uuid-1'),
      ).rejects.toThrow(InvalidUploadStateException);
    });
  });

  describe('getVideoByUniqueUrlId', () => {
    it('should return video if status is READY for any user or anonymous', async () => {
      const readyVideo = {
        id: 'video-1',
        unique_url_id: 'url-1',
        status: VideoStatus.READY,
        channel: mockChannel,
      } as Video;

      videoRepo.findOne!.mockResolvedValue(readyVideo);

      const res = await service.getVideoByUniqueUrlId('url-1');
      expect(res).toBe(readyVideo);
    });

    it('should return video if status is DRAFT and user is channel owner', async () => {
      const draftVideo = {
        id: 'video-1',
        unique_url_id: 'url-1',
        status: VideoStatus.DRAFT,
        channel: mockChannel,
      } as Video;

      videoRepo.findOne!.mockResolvedValue(draftVideo);

      const res = await service.getVideoByUniqueUrlId('url-1', 'user-uuid-1');
      expect(res).toBe(draftVideo);
    });

    it('should throw VideoNotFoundException if status is DRAFT and user is NOT owner', async () => {
      const draftVideo = {
        id: 'video-1',
        unique_url_id: 'url-1',
        status: VideoStatus.DRAFT,
        channel: mockChannel,
      } as Video;

      videoRepo.findOne!.mockResolvedValue(draftVideo);

      await expect(
        service.getVideoByUniqueUrlId('url-1', 'other-user'),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });
});
