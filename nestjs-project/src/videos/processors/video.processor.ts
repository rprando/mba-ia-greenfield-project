import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import * as ffmpegModule from 'fluent-ffmpeg';
const ffmpeg: any = (ffmpegModule as any).default || ffmpegModule;
import * as fs from 'fs';
import * as path from 'path';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../enums/video-status.enum';
import { StorageService } from '../../storage/storage.service';

export interface ProcessVideoJobData {
  videoId: string;
  key: string;
}

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(
    job: Job<ProcessVideoJobData>,
  ): Promise<{ success: boolean; videoId: string }> {
    const { videoId, key } = job.data;
    this.logger.log(
      `Processing video job for video ID: ${videoId}, attempt ${job.attemptsMade + 1}`,
    );

    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: ['channel'],
    });

    if (!video) {
      this.logger.warn(
        `Video with ID ${videoId} not found in database. Skipping.`,
      );
      return { success: false, videoId };
    }

    const tempDir = path.join('/tmp', 'streamtube');
    await fs.promises.mkdir(tempDir, { recursive: true });

    const tempVideoPath = path.join(tempDir, `${videoId}.mp4`);
    const tempThumbFilename = `${videoId}-thumb.jpg`;
    const tempThumbPath = path.join(tempDir, tempThumbFilename);

    try {
      // 1. Download video from S3/MinIO to temp file
      this.logger.log(
        `Downloading video from storage key "${key}" to "${tempVideoPath}"`,
      );
      const { stream } = await this.storageService.getObjectStream(key);
      await new Promise<void>((resolve, reject) => {
        const fileWriter = fs.createWriteStream(tempVideoPath);
        stream.pipe(fileWriter);
        fileWriter.on('finish', () => resolve());
        fileWriter.on('error', (err) => reject(err));
        stream.on('error', (err) => reject(err));
      });

      // 2. Run ffprobe to extract duration and video stream info
      this.logger.log(
        `Probing video metadata with ffprobe for "${tempVideoPath}"`,
      );
      const probeData = await new Promise<any>((resolve, reject) => {
        ffmpeg.ffprobe(tempVideoPath, (err, data) => {
          if (err)
            return reject(err instanceof Error ? err : new Error(String(err)));
          resolve(data);
        });
      });

      const duration = Math.round(Number(probeData.format?.duration || 0));
      const videoStream = probeData.streams?.find(
        (s) => s.codec_type === 'video',
      );
      const width = videoStream?.width;
      const height = videoStream?.height;
      const codec = videoStream?.codec_name;
      const bitrate = probeData.format?.bit_rate
        ? parseInt(String(probeData.format.bit_rate), 10)
        : undefined;

      // 3. Generate thumbnail at 5s (or midpoint if duration < 5s)
      const timemark = duration >= 5 ? 5 : duration > 0 ? duration / 2 : 0;
      this.logger.log(
        `Extracting thumbnail at timemark ${timemark}s for video "${videoId}"`,
      );

      await new Promise<void>((resolve, reject) => {
        ffmpeg(tempVideoPath)
          .screenshots({
            timestamps: [timemark],
            filename: tempThumbFilename,
            folder: tempDir,
            size: '1280x720',
          })
          .on('end', () => resolve())
          .on('error', (err) =>
            reject(err instanceof Error ? err : new Error(String(err))),
          );
      });

      // 4. Upload thumbnail to MinIO
      const thumbBuffer = await fs.promises.readFile(tempThumbPath);
      const thumbKey = `thumbnails/${video.channel_id}/${video.unique_url_id}-thumb.jpg`;
      await this.storageService.uploadThumbnail(
        thumbKey,
        thumbBuffer,
        'image/jpeg',
      );

      // 5. Update video entity in database to READY
      video.status = VideoStatus.READY;
      video.duration_seconds = duration;
      video.thumbnail_storage_key = thumbKey;
      video.metadata = {
        ...(video.metadata as any),
        duration,
        width,
        height,
        codec,
        bitrate,
      };

      await this.videoRepository.save(video);
      this.logger.log(
        `Video "${videoId}" processed successfully. Status: READY`,
      );

      return { success: true, videoId };
    } catch (error: any) {
      this.logger.error(
        `Error processing video "${videoId}": ${error.message}`,
      );

      video.status = VideoStatus.ERROR;
      video.metadata = {
        ...(video.metadata as any),
        error_message: error.message,
      };
      await this.videoRepository.save(video);

      throw error;
    } finally {
      // Clean up temp files
      await fs.promises.unlink(tempVideoPath).catch(() => {});
      await fs.promises.unlink(tempThumbPath).catch(() => {});
    }
  }
}
