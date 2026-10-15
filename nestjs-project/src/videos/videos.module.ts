import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Video } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { StorageModule } from '../storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { VideoProcessor } from './processors/video.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, Channel]),
    BullModule.registerQueue({
      name: 'video-processing',
    }),
    StorageModule,
    AuthModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoProcessor],
  exports: [VideosService, VideoProcessor],
})
export class VideosModule {}
