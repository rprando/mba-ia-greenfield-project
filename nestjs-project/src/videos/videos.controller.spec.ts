import { Response } from 'express';
import { Readable, PassThrough } from 'stream';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { StorageService } from '../storage/storage.service';
import { JwtService } from '@nestjs/jwt';
import { VideoStatus } from './enums/video-status.enum';
import { Video } from './entities/video.entity';

describe('VideosController (unit)', () => {
  let controller: VideosController;
  let videosService: Partial<Record<keyof VideosService, jest.Mock>>;
  let storageService: Partial<Record<keyof StorageService, jest.Mock>>;
  let jwtService: Partial<Record<keyof JwtService, jest.Mock>>;

  const mockVideo = {
    id: 'vid-123',
    unique_url_id: 'url-123',
    title: 'Stream Test',
    description: 'Desc',
    status: VideoStatus.READY,
    original_storage_key: 'videos/chan/vid.mp4',
    duration_seconds: 60,
    metadata: { filename: 'test.mp4' },
    created_at: new Date(),
    channel: { id: 'chan-1', name: 'Chan', nickname: 'chan' },
  } as unknown as Video;

  beforeEach(() => {
    videosService = {
      startUpload: jest.fn(),
      completeUpload: jest.fn(),
      abortUpload: jest.fn(),
      getVideoByUniqueUrlId: jest.fn().mockResolvedValue(mockVideo),
    };

    storageService = {
      getObjectStream: jest.fn(),
    };

    jwtService = {
      verifyAsync: jest.fn(),
    };

    controller = new VideosController(
      videosService as unknown as VideosService,
      storageService as unknown as StorageService,
      jwtService as unknown as JwtService,
    );
  });

  function createMockResponse(): Response {
    const res = new PassThrough() as any;
    res.setHeader = jest.fn();
    res.status = jest.fn().mockReturnValue(res);
    return res as Response;
  }

  describe('streamVideo', () => {
    it('should respond with HTTP 206 and Content-Range when Range header is provided', async () => {
      const mockStream = new Readable({
        read() {
          this.push(Buffer.from('chunk'));
          this.push(null);
        },
      });

      storageService.getObjectStream!.mockResolvedValue({
        stream: mockStream,
        contentLength: 100,
        contentRange: 'bytes 0-99/1000',
        contentType: 'video/mp4',
      });

      const res = createMockResponse();
      const req = { headers: {} } as any;

      await controller.streamVideo('url-123', 'bytes=0-99', req, res);

      expect(storageService.getObjectStream).toHaveBeenCalledWith(
        'videos/chan/vid.mp4',
        'bytes=0-99',
      );
      expect(res.setHeader).toHaveBeenCalledWith('Accept-Ranges', 'bytes');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'video/mp4');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Range',
        'bytes 0-99/1000',
      );
      expect(res.setHeader).toHaveBeenCalledWith('Content-Length', 100);
      expect(res.status).toHaveBeenCalledWith(206);
    });

    it('should respond with HTTP 200 when no Range header is provided', async () => {
      const mockStream = new Readable({
        read() {
          this.push(Buffer.from('full-video'));
          this.push(null);
        },
      });

      storageService.getObjectStream!.mockResolvedValue({
        stream: mockStream,
        contentLength: 1000,
        contentType: 'video/mp4',
      });

      const res = createMockResponse();
      const req = { headers: {} } as any;

      await controller.streamVideo('url-123', undefined, req, res);

      expect(storageService.getObjectStream).toHaveBeenCalledWith(
        'videos/chan/vid.mp4',
        undefined,
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Length', 1000);
    });
  });

  describe('downloadVideo', () => {
    it('should set Content-Disposition attachment and stream file', async () => {
      const mockStream = new Readable({
        read() {
          this.push(Buffer.from('video-file-download'));
          this.push(null);
        },
      });

      storageService.getObjectStream!.mockResolvedValue({
        stream: mockStream,
        contentLength: 5000,
        contentType: 'video/mp4',
      });

      const res = createMockResponse();
      const req = { headers: {} } as any;

      await controller.downloadVideo('url-123', req, res);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="test.mp4"',
      );
      expect(res.setHeader).toHaveBeenCalledWith('Content-Length', 5000);
    });
  });
});
