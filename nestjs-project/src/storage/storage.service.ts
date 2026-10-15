import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';

export interface PresignedPartUrl {
  partNumber: number;
  url: string;
}

export interface CompletedPartInput {
  partNumber: number;
  etag: string;
}

export interface ObjectStreamResult {
  stream: Readable;
  contentLength?: number;
  contentRange?: string;
  contentType?: string;
  acceptRanges?: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3Client: S3Client;
  private readonly videosBucket: string;
  private readonly thumbnailsBucket: string;

  constructor(private readonly configService: ConfigService) {
    const endpoint = this.configService.get<string>(
      'storage.endpoint',
      'http://minio:9000',
    );
    const accessKeyId = this.configService.get<string>(
      'storage.accessKey',
      'minioadmin',
    );
    const secretAccessKey = this.configService.get<string>(
      'storage.secretKey',
      'minioadmin',
    );
    const forcePathStyle = this.configService.get<boolean>(
      'storage.forcePathStyle',
      true,
    );

    this.videosBucket = this.configService.get<string>(
      'storage.bucketVideos',
      'videos',
    );
    this.thumbnailsBucket = this.configService.get<string>(
      'storage.bucketThumbnails',
      'thumbnails',
    );

    this.s3Client = new S3Client({
      endpoint,
      region: 'us-east-1',
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      forcePathStyle,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucketsExist();
  }

  getVideosBucketName(): string {
    return this.videosBucket;
  }

  getThumbnailsBucketName(): string {
    return this.thumbnailsBucket;
  }

  getS3Client(): S3Client {
    return this.s3Client;
  }

  async ensureBucketsExist(): Promise<void> {
    await this.ensureBucket(this.videosBucket);
    await this.ensureBucket(this.thumbnailsBucket);
  }

  private async ensureBucket(bucket: string): Promise<void> {
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error: any) {
      const isNotFound =
        error.name === 'NotFound' ||
        error.name === 'NoSuchBucket' ||
        error.$metadata?.httpStatusCode === 404;

      if (isNotFound) {
        try {
          await this.s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
          this.logger.log(`Created bucket: "${bucket}"`);
        } catch (createErr: any) {
          if (
            createErr.name !== 'BucketAlreadyOwnedByYou' &&
            createErr.name !== 'BucketAlreadyExists'
          ) {
            throw createErr;
          }
        }
      } else {
        this.logger.warn(
          `HeadBucket check warning for bucket "${bucket}": ${error.message}`,
        );
      }
    }
  }

  async createMultipartUpload(
    key: string,
    contentType = 'video/mp4',
  ): Promise<string> {
    const command = new CreateMultipartUploadCommand({
      Bucket: this.videosBucket,
      Key: key,
      ContentType: contentType,
    });

    const response = await this.s3Client.send(command);
    if (!response.UploadId) {
      throw new Error('S3 did not return an UploadId for multipart upload');
    }
    return response.UploadId;
  }

  async getPresignedPartUrls(
    key: string,
    uploadId: string,
    partsCount: number,
    expiresIn = 3600,
  ): Promise<PresignedPartUrl[]> {
    const parts: PresignedPartUrl[] = [];

    for (let partNumber = 1; partNumber <= partsCount; partNumber++) {
      const command = new UploadPartCommand({
        Bucket: this.videosBucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });

      const url = await getSignedUrl(this.s3Client, command, { expiresIn });
      parts.push({ partNumber, url });
    }

    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPartInput[],
  ): Promise<void> {
    const sortedParts = [...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({
        PartNumber: p.partNumber,
        ETag: `"${p.etag.replace(/^"|"$/g, '')}"`,
      }));

    const command = new CompleteMultipartUploadCommand({
      Bucket: this.videosBucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: sortedParts,
      },
    });

    await this.s3Client.send(command);
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const command = new AbortMultipartUploadCommand({
      Bucket: this.videosBucket,
      Key: key,
      UploadId: uploadId,
    });

    await this.s3Client.send(command);
  }

  async headVideoObject(key: string): Promise<{
    contentLength?: number;
    contentType?: string;
  }> {
    const command = new HeadObjectCommand({
      Bucket: this.videosBucket,
      Key: key,
    });

    const response = await this.s3Client.send(command);
    return {
      contentLength: response.ContentLength,
      contentType: response.ContentType,
    };
  }

  async getObjectStream(
    key: string,
    range?: string,
  ): Promise<ObjectStreamResult> {
    const command = new GetObjectCommand({
      Bucket: this.videosBucket,
      Key: key,
      ...(range ? { Range: range } : {}),
    });

    const response = await this.s3Client.send(command);
    return {
      stream: response.Body as Readable,
      contentLength: response.ContentLength,
      contentRange: response.ContentRange,
      contentType: response.ContentType,
      acceptRanges: response.AcceptRanges,
    };
  }

  async uploadThumbnail(
    key: string,
    body: Buffer | Uint8Array | Readable,
    contentType = 'image/jpeg',
  ): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.thumbnailsBucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    });

    await this.s3Client.send(command);
  }

  async getThumbnailStream(key: string): Promise<ObjectStreamResult> {
    const command = new GetObjectCommand({
      Bucket: this.thumbnailsBucket,
      Key: key,
    });

    const response = await this.s3Client.send(command);
    return {
      stream: response.Body as Readable,
      contentLength: response.ContentLength,
      contentType: response.ContentType,
      acceptRanges: response.AcceptRanges,
    };
  }

  async deleteVideoObject(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.videosBucket,
      Key: key,
    });

    await this.s3Client.send(command);
  }

  async deleteThumbnailObject(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.thumbnailsBucket,
      Key: key,
    });

    await this.s3Client.send(command);
  }
}
