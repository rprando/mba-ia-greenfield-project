import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { VideoProcessor, ProcessVideoJobData } from './video.processor';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../enums/video-status.enum';
import { StorageService } from '../../storage/storage.service';
import { Readable } from 'stream';
import * as ffmpeg from 'fluent-ffmpeg';

jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  const { PassThrough } = require('stream');
  return {
    ...actualFs,
    promises: {
      ...actualFs.promises,
      mkdir: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockResolvedValue(Buffer.from('fake-jpeg-data')),
      unlink: jest.fn().mockResolvedValue(undefined),
    },
    createWriteStream: jest.fn().mockImplementation(() => {
      const pt = new PassThrough();
      setTimeout(() => pt.emit('finish'), 5);
      return pt;
    }),
  };
});

jest.mock('fluent-ffmpeg', () => {
  const mockFfmpeg: any = jest.fn(() => ({
    screenshots: jest.fn().mockReturnValue({
      on: jest.fn(function (this: any, event: string, cb: () => void) {
        if (event === 'end') setTimeout(cb, 1);
        return this;
      }),
    }),
  }));
  mockFfmpeg.default = mockFfmpeg;
  mockFfmpeg.ffprobe = jest.fn((_file, cb) => {
    cb(null, {
      format: {
        duration: 120,
        bit_rate: 2500000,
      },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
        },
      ],
    });
  });
  return mockFfmpeg;
});

describe('VideoProcessor (unit)', () => {
  let processor: VideoProcessor;
  let videoRepo: Partial<Record<keyof Repository<Video>, jest.Mock>>;
  let storageService: Partial<Record<keyof StorageService, jest.Mock>>;

  beforeEach(() => {
    videoRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (entity) => entity),
    };

    storageService = {
      getObjectStream: jest.fn().mockResolvedValue({
        stream: new Readable({
          read() {
            this.push(Buffer.from('video-data'));
            this.push(null);
          },
        }),
      }),
      uploadThumbnail: jest.fn().mockResolvedValue(undefined),
    };

    processor = new VideoProcessor(
      videoRepo as unknown as Repository<Video>,
      storageService as unknown as StorageService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should process video, extract metadata and thumbnail, and set status to READY', async () => {
    const mockVideo = {
      id: 'vid-123',
      channel_id: 'chan-456',
      unique_url_id: 'url-789',
      status: VideoStatus.PROCESSING,
      metadata: { original_name: 'clip.mp4' },
    } as unknown as Video;

    videoRepo.findOne!.mockResolvedValue(mockVideo);

    const job = {
      data: { videoId: 'vid-123', key: 'videos/chan-456/url-789-clip.mp4' },
      attemptsMade: 0,
    } as unknown as Job<ProcessVideoJobData>;

    const result = await processor.process(job);

    expect(result).toEqual({ success: true, videoId: 'vid-123' });
    expect(videoRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: VideoStatus.READY,
        duration_seconds: 120,
        thumbnail_storage_key: 'thumbnails/chan-456/url-789-thumb.jpg',
        metadata: expect.objectContaining({
          duration: 120,
          width: 1920,
          height: 1080,
          codec: 'h264',
          bitrate: 2500000,
        }),
      }),
    );
    expect(storageService.uploadThumbnail).toHaveBeenCalled();
  });

  it('should transition video to ERROR state when ffmpeg extraction fails', async () => {
    const mockVideo = {
      id: 'vid-corrupt',
      channel_id: 'chan-456',
      unique_url_id: 'url-corrupt',
      status: VideoStatus.PROCESSING,
      metadata: {},
    } as unknown as Video;

    videoRepo.findOne!.mockResolvedValue(mockVideo);

    // Make ffprobe fail
    (ffmpeg.ffprobe as unknown as jest.Mock).mockImplementationOnce(
      (_file, cb) => {
        cb(new Error('Invalid data found when processing input'), null);
      },
    );

    const job = {
      data: { videoId: 'vid-corrupt', key: 'videos/chan-456/corrupt.mp4' },
      attemptsMade: 0,
    } as unknown as Job<ProcessVideoJobData>;

    await expect(processor.process(job)).rejects.toThrow('Invalid data found');

    expect(videoRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: VideoStatus.ERROR,
        metadata: expect.objectContaining({
          error_message: 'Invalid data found when processing input',
        }),
      }),
    );
  });

  it('should skip processing if video is not found in database', async () => {
    videoRepo.findOne!.mockResolvedValue(null);

    const job = {
      data: { videoId: 'nonexistent', key: 'videos/key.mp4' },
      attemptsMade: 0,
    } as unknown as Job<ProcessVideoJobData>;

    const result = await processor.process(job);

    expect(result).toEqual({ success: false, videoId: 'nonexistent' });
    expect(videoRepo.save).not.toHaveBeenCalled();
  });
});
