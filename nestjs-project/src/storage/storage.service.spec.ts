import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';
import {
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import * as presigner from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

describe('StorageService (unit)', () => {
  let service: StorageService;
  let mockSend: jest.Mock;

  beforeEach(() => {
    mockSend = jest.fn();

    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const configMap: Record<string, any> = {
          'storage.endpoint': 'http://localhost:9000',
          'storage.accessKey': 'minioadmin',
          'storage.secretKey': 'minioadmin',
          'storage.bucketVideos': 'videos-test',
          'storage.bucketThumbnails': 'thumbnails-test',
          'storage.forcePathStyle': true,
        };
        return configMap[key] ?? defaultValue;
      }),
    };

    service = new StorageService(mockConfigService as unknown as ConfigService);
    (service as any).s3Client.send = mockSend;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
    expect(service.getVideosBucketName()).toBe('videos-test');
    expect(service.getThumbnailsBucketName()).toBe('thumbnails-test');
  });

  describe('ensureBucketsExist', () => {
    it('should create buckets if HeadBucket throws NotFound', async () => {
      mockSend
        .mockRejectedValueOnce({ name: 'NotFound' })
        .mockResolvedValueOnce({}) // CreateBucket videos-test
        .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
        .mockResolvedValueOnce({}); // CreateBucket thumbnails-test

      await service.ensureBucketsExist();

      expect(mockSend).toHaveBeenCalledTimes(4);
    });

    it('should do nothing if buckets already exist', async () => {
      mockSend.mockResolvedValue({});

      await service.ensureBucketsExist();

      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('createMultipartUpload', () => {
    it('should return uploadId on success', async () => {
      mockSend.mockResolvedValueOnce({ UploadId: 'test-upload-id-123' });

      const uploadId = await service.createMultipartUpload(
        'test-video.mp4',
        'video/mp4',
      );

      expect(uploadId).toBe('test-upload-id-123');
      expect(mockSend).toHaveBeenCalledWith(
        expect.any(CreateMultipartUploadCommand),
      );
    });

    it('should throw if no UploadId is returned', async () => {
      mockSend.mockResolvedValueOnce({});

      await expect(
        service.createMultipartUpload('test-video.mp4'),
      ).rejects.toThrow('S3 did not return an UploadId');
    });
  });

  describe('getPresignedPartUrls', () => {
    it('should return signed URLs for all requested parts', async () => {
      (presigner.getSignedUrl as jest.Mock).mockImplementation((_client, cmd) =>
        Promise.resolve(`https://signed-url.com/part/${cmd.input.PartNumber}`),
      );

      const parts = await service.getPresignedPartUrls(
        'key.mp4',
        'upload123',
        3,
      );

      expect(parts).toHaveLength(3);
      expect(parts[0]).toEqual({
        partNumber: 1,
        url: 'https://signed-url.com/part/1',
      });
      expect(parts[1]).toEqual({
        partNumber: 2,
        url: 'https://signed-url.com/part/2',
      });
      expect(parts[2]).toEqual({
        partNumber: 3,
        url: 'https://signed-url.com/part/3',
      });
    });
  });

  describe('completeMultipartUpload', () => {
    it('should sort parts and quote ETags properly', async () => {
      mockSend.mockResolvedValueOnce({});

      await service.completeMultipartUpload('key.mp4', 'upload123', [
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 1, etag: 'etag-1' },
      ]);

      expect(mockSend).toHaveBeenCalledWith(
        expect.any(CompleteMultipartUploadCommand),
      );
      const sentCommand = mockSend.mock.calls[0][0];
      expect(sentCommand.input.MultipartUpload.Parts).toEqual([
        { PartNumber: 1, ETag: '"etag-1"' },
        { PartNumber: 2, ETag: '"etag-2"' },
      ]);
    });
  });

  describe('abortMultipartUpload', () => {
    it('should send AbortMultipartUploadCommand', async () => {
      mockSend.mockResolvedValueOnce({});

      await service.abortMultipartUpload('key.mp4', 'upload123');

      expect(mockSend).toHaveBeenCalledWith(
        expect.any(AbortMultipartUploadCommand),
      );
    });
  });

  describe('headVideoObject', () => {
    it('should return content length and content type', async () => {
      mockSend.mockResolvedValueOnce({
        ContentLength: 1048576,
        ContentType: 'video/mp4',
      });

      const head = await service.headVideoObject('key.mp4');

      expect(head.contentLength).toBe(1048576);
      expect(head.contentType).toBe('video/mp4');
      expect(mockSend).toHaveBeenCalledWith(expect.any(HeadObjectCommand));
    });
  });

  describe('getObjectStream', () => {
    it('should return stream and range metadata', async () => {
      const mockStream = new Readable({
        read() {
          this.push(null);
        },
      });

      mockSend.mockResolvedValueOnce({
        Body: mockStream,
        ContentLength: 500,
        ContentRange: 'bytes 0-499/1000',
        ContentType: 'video/mp4',
        AcceptRanges: 'bytes',
      });

      const result = await service.getObjectStream('key.mp4', 'bytes=0-499');

      expect(result.stream).toBe(mockStream);
      expect(result.contentLength).toBe(500);
      expect(result.contentRange).toBe('bytes 0-499/1000');
      expect(result.acceptRanges).toBe('bytes');
      expect(mockSend).toHaveBeenCalledWith(expect.any(GetObjectCommand));
    });
  });

  describe('uploadThumbnail', () => {
    it('should send PutObjectCommand with buffer to thumbnails bucket', async () => {
      mockSend.mockResolvedValueOnce({});

      const buffer = Buffer.from('test-image');
      await service.uploadThumbnail('thumb.jpg', buffer, 'image/jpeg');

      expect(mockSend).toHaveBeenCalledWith(expect.any(PutObjectCommand));
      const sentCommand = mockSend.mock.calls[0][0];
      expect(sentCommand.input.Bucket).toBe('thumbnails-test');
      expect(sentCommand.input.Key).toBe('thumb.jpg');
    });
  });
});
