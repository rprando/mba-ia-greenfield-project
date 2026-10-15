import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtService } from '@nestjs/jwt';
import { VideosService } from './videos.service';
import { StorageService } from '../storage/storage.service';
import { StartUploadDto } from './dto/start-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { BEARER_PREFIX } from '../auth/auth.constants';
import { VideoNotFoundException } from './exceptions/video.exceptions';

@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly jwtService: JwtService,
  ) {}

  @Post('uploads/start')
  @HttpCode(HttpStatus.CREATED)
  async startUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: StartUploadDto,
  ) {
    return this.videosService.startUpload(user.sub, dto);
  }

  @Post('uploads/:id/complete')
  @HttpCode(HttpStatus.OK)
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ) {
    return this.videosService.completeUpload(user.sub, id, dto);
  }

  @Post('uploads/:id/abort')
  @HttpCode(HttpStatus.OK)
  async abortUpload(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.videosService.abortUpload(user.sub, id);
  }

  @Public()
  @Get(':uniqueUrlId')
  async getVideo(
    @Param('uniqueUrlId') uniqueUrlId: string,
    @Req() req: Request,
  ) {
    const userId = await this.extractUserIdOptional(req);
    const video = await this.videosService.getVideoByUniqueUrlId(
      uniqueUrlId,
      userId,
    );
    return {
      id: video.id,
      unique_url_id: video.unique_url_id,
      title: video.title,
      description: video.description,
      status: video.status,
      duration_seconds: video.duration_seconds,
      thumbnail_storage_key: video.thumbnail_storage_key,
      metadata: video.metadata,
      created_at: video.created_at,
      channel: {
        id: video.channel.id,
        name: video.channel.name,
        nickname: video.channel.nickname,
      },
    };
  }

  @Public()
  @Get(':uniqueUrlId/stream')
  async streamVideo(
    @Param('uniqueUrlId') uniqueUrlId: string,
    @Headers('range') range: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const userId = await this.extractUserIdOptional(req);
    const video = await this.videosService.getVideoByUniqueUrlId(
      uniqueUrlId,
      userId,
    );

    if (!video.original_storage_key) {
      throw new VideoNotFoundException('Video storage key not found');
    }

    const streamResult = await this.storageService.getObjectStream(
      video.original_storage_key,
      range,
    );

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', streamResult.contentType || 'video/mp4');

    if (range && streamResult.contentRange) {
      res.status(HttpStatus.PARTIAL_CONTENT);
      res.setHeader('Content-Range', streamResult.contentRange);
      if (streamResult.contentLength !== undefined) {
        res.setHeader('Content-Length', streamResult.contentLength);
      }
    } else {
      res.status(HttpStatus.OK);
      if (streamResult.contentLength !== undefined) {
        res.setHeader('Content-Length', streamResult.contentLength);
      }
    }

    streamResult.stream.pipe(res);
  }

  @Public()
  @Get(':uniqueUrlId/download')
  async downloadVideo(
    @Param('uniqueUrlId') uniqueUrlId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const userId = await this.extractUserIdOptional(req);
    const video = await this.videosService.getVideoByUniqueUrlId(
      uniqueUrlId,
      userId,
    );

    if (!video.original_storage_key) {
      throw new VideoNotFoundException('Video storage key not found');
    }

    const streamResult = await this.storageService.getObjectStream(
      video.original_storage_key,
    );

    const filename =
      (video.metadata as any)?.filename || `${video.unique_url_id}.mp4`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', streamResult.contentType || 'video/mp4');
    if (streamResult.contentLength !== undefined) {
      res.setHeader('Content-Length', streamResult.contentLength);
    }

    streamResult.stream.pipe(res);
  }

  private async extractUserIdOptional(
    req: Request,
  ): Promise<string | undefined> {
    const authHeader = req.headers?.authorization;
    if (authHeader && authHeader.startsWith(BEARER_PREFIX)) {
      const token = authHeader.slice(BEARER_PREFIX.length);
      try {
        const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
        return payload?.sub;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
