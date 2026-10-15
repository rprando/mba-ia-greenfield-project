import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { nanoid } from 'nanoid';
import { Video } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { VideoStatus } from './enums/video-status.enum';
import { StorageService } from '../storage/storage.service';
import { StartUploadDto, MAX_FILE_SIZE_BYTES } from './dto/start-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import {
  VideoNotFoundException,
  InvalidUploadStateException,
  UnauthorizedChannelActionException,
  FileSizeExceededException,
} from './exceptions/video.exceptions';

export interface StartUploadResult {
  video_id: string;
  unique_url_id: string;
  upload_id: string;
  key: string;
  part_urls: Array<{ partNumber: number; url: string }>;
}

export interface CompleteUploadResult {
  id: string;
  status: VideoStatus;
  unique_url_id: string;
  message: string;
}

export interface AbortUploadResult {
  id: string;
  status: VideoStatus;
  message: string;
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly storageService: StorageService,
    @Optional()
    @InjectQueue('video-processing')
    private readonly videoQueue?: Queue,
  ) {}

  async startUpload(
    userId: string,
    dto: StartUploadDto,
  ): Promise<StartUploadResult> {
    const channel = await this.channelRepository.findOneBy({ user_id: userId });
    if (!channel) {
      throw new UnauthorizedChannelActionException(
        'User does not have an active channel to upload videos',
      );
    }

    if (dto.file_size > MAX_FILE_SIZE_BYTES) {
      throw new FileSizeExceededException();
    }

    const uniqueUrlId = nanoid(12);
    const sanitizedFilename = dto.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageKey = `videos/${channel.id}/${uniqueUrlId}-${sanitizedFilename}`;

    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      'video/mp4',
    );

    const partUrls = await this.storageService.getPresignedPartUrls(
      storageKey,
      uploadId,
      dto.parts_count,
    );

    const video = this.videoRepository.create({
      channel_id: channel.id,
      title: dto.title,
      description: dto.description ?? null,
      status: VideoStatus.DRAFT,
      original_storage_key: storageKey,
      unique_url_id: uniqueUrlId,
      metadata: {
        filename: dto.filename,
        file_size: dto.file_size,
        parts_count: dto.parts_count,
        upload_id: uploadId,
      },
    });

    const saved = await this.videoRepository.save(video);

    return {
      video_id: saved.id,
      unique_url_id: saved.unique_url_id,
      upload_id: uploadId,
      key: storageKey,
      part_urls: partUrls,
    };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.videoRepository.findOne({
      where: [{ id: videoId }, { unique_url_id: videoId }],
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.channel.user_id !== userId) {
      throw new UnauthorizedChannelActionException();
    }

    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidUploadStateException(
        `Video upload cannot be completed from current state: ${video.status}`,
      );
    }

    await this.storageService.completeMultipartUpload(
      video.original_storage_key!,
      dto.upload_id,
      dto.parts.map((p) => ({
        partNumber: p.part_number,
        etag: p.etag,
      })),
    );

    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);

    if (this.videoQueue) {
      try {
        await this.videoQueue.add(
          'process-video',
          {
            videoId: video.id,
            key: video.original_storage_key,
          },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: true,
          },
        );
        this.logger.log(`Enqueued process-video job for video ${video.id}`);
      } catch (err: any) {
        this.logger.error(
          `Failed to enqueue video processing job: ${err.message}`,
        );
      }
    }

    return {
      id: video.id,
      status: video.status,
      unique_url_id: video.unique_url_id,
      message: 'Upload completed and queued for processing',
    };
  }

  async abortUpload(
    userId: string,
    videoId: string,
  ): Promise<AbortUploadResult> {
    const video = await this.videoRepository.findOne({
      where: [{ id: videoId }, { unique_url_id: videoId }],
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.channel.user_id !== userId) {
      throw new UnauthorizedChannelActionException();
    }

    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidUploadStateException(
        `Only DRAFT videos can be aborted. Current state: ${video.status}`,
      );
    }

    const uploadId = video.metadata?.upload_id;
    if (uploadId && video.original_storage_key) {
      try {
        await this.storageService.abortMultipartUpload(
          video.original_storage_key,
          uploadId,
        );
      } catch (err: any) {
        this.logger.warn(`S3 multipart abort warning: ${err.message}`);
      }
    }

    video.status = VideoStatus.CANCELLED;
    await this.videoRepository.save(video);

    return {
      id: video.id,
      status: video.status,
      message: 'Upload aborted',
    };
  }

  async getVideoByUniqueUrlId(
    uniqueUrlId: string,
    userId?: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { unique_url_id: uniqueUrlId },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.status === VideoStatus.READY) {
      return video;
    }

    if (userId && video.channel.user_id === userId) {
      return video;
    }

    throw new VideoNotFoundException();
  }

  async getVideoById(videoId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    return video;
  }
}
