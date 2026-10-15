import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';
import { UploadPartCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

describe('StorageService (integration with MinIO)', () => {
  let service: StorageService;

  beforeAll(async () => {
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

    service = new StorageService(configService);
    await service.ensureBucketsExist();
  });

  async function streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  it('should ensure both buckets are created in MinIO', async () => {
    await expect(service.ensureBucketsExist()).resolves.not.toThrow();
  });

  it('should generate presigned part URLs with valid parameters', async () => {
    const uploadId = await service.createMultipartUpload('presigned-test.mp4');
    expect(uploadId).toBeDefined();

    const partUrls = await service.getPresignedPartUrls(
      'presigned-test.mp4',
      uploadId,
      3,
    );
    expect(partUrls).toHaveLength(3);
    expect(partUrls[0].partNumber).toBe(1);
    expect(partUrls[0].url).toContain('uploadId=');
    expect(partUrls[0].url).toContain('partNumber=1');

    await service.abortMultipartUpload('presigned-test.mp4', uploadId);
  });

  it('should complete multipart upload and retrieve stream with Range requests', async () => {
    const testKey = `integration-multipart-${Date.now()}.bin`;
    const uploadId = await service.createMultipartUpload(
      testKey,
      'application/octet-stream',
    );

    // Part 1: 5MB + Part 2: 1KB
    const part1Data = Buffer.alloc(5 * 1024 * 1024, 65); // 'A'
    const part2Data = Buffer.alloc(1024, 66); // 'B'

    const s3 = service.getS3Client();

    const part1Res = await s3.send(
      new UploadPartCommand({
        Bucket: service.getVideosBucketName(),
        Key: testKey,
        UploadId: uploadId,
        PartNumber: 1,
        Body: part1Data,
      }),
    );

    const part2Res = await s3.send(
      new UploadPartCommand({
        Bucket: service.getVideosBucketName(),
        Key: testKey,
        UploadId: uploadId,
        PartNumber: 2,
        Body: part2Data,
      }),
    );

    expect(part1Res.ETag).toBeDefined();
    expect(part2Res.ETag).toBeDefined();

    await service.completeMultipartUpload(testKey, uploadId, [
      { partNumber: 1, etag: part1Res.ETag! },
      { partNumber: 2, etag: part2Res.ETag! },
    ]);

    // Head check
    const head = await service.headVideoObject(testKey);
    expect(head.contentLength).toBe(5 * 1024 * 1024 + 1024);

    // Range check (first 10 bytes)
    const rangeResult = await service.getObjectStream(testKey, 'bytes=0-9');
    const rangeBuf = await streamToBuffer(rangeResult.stream);
    expect(rangeBuf.length).toBe(10);
    expect(rangeBuf.toString('utf-8')).toBe('AAAAAAAAAA');

    // Cleanup
    await service.deleteVideoObject(testKey);
  });

  it('should upload thumbnail and retrieve its stream', async () => {
    const thumbKey = `test-thumb-${Date.now()}.jpg`;
    const thumbData = Buffer.from('FAKE-JPEG-BINARY-DATA');

    await service.uploadThumbnail(thumbKey, thumbData, 'image/jpeg');

    const result = await service.getThumbnailStream(thumbKey);
    const downloadedBuf = await streamToBuffer(result.stream);
    expect(downloadedBuf.toString()).toBe('FAKE-JPEG-BINARY-DATA');
    expect(result.contentType).toBe('image/jpeg');

    await service.deleteThumbnailObject(thumbKey);
  });
});
