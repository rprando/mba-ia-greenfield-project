import { DataSource, Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Video } from './video.entity';
import { VideoStatus } from '../enums/video-status.enum';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;
  let testChannel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const user = await userRepository.save(
      userRepository.create({
        email: 'creator@example.com',
        password: 'hashed_password',
        is_confirmed: true,
      }),
    );

    testChannel = await channelRepository.save(
      channelRepository.create({
        name: 'Creator Channel',
        nickname: 'creator_channel',
        user_id: user.id,
      }),
    );
  });

  it('should auto-generate uuid, timestamps, and default status to DRAFT', async () => {
    const video = videoRepository.create({
      channel_id: testChannel.id,
      title: 'First Video',
      unique_url_id: 'vid12345678',
    });

    const saved = await videoRepository.save(video);

    expect(saved.id).toBeDefined();
    expect(saved.status).toBe(VideoStatus.DRAFT);
    expect(saved.created_at).toBeInstanceOf(Date);
    expect(saved.updated_at).toBeInstanceOf(Date);
  });

  it('should enforce unique constraint on unique_url_id', async () => {
    await videoRepository.save(
      videoRepository.create({
        channel_id: testChannel.id,
        title: 'Video 1',
        unique_url_id: 'duplicate11',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: testChannel.id,
          title: 'Video 2',
          unique_url_id: 'duplicate11',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should persist and retrieve JSONB metadata and duration', async () => {
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: testChannel.id,
        title: 'Video with Metadata',
        unique_url_id: 'meta1234567',
        duration_seconds: 360,
        metadata: {
          codec: 'h264',
          resolution: '1920x1080',
          bitrate: 4500000,
        },
      }),
    );

    const found = await videoRepository.findOneBy({ id: video.id });
    expect(found).toBeDefined();
    expect(found?.duration_seconds).toBe(360);
    expect(found?.metadata).toEqual({
      codec: 'h264',
      resolution: '1920x1080',
      bitrate: 4500000,
    });
  });

  it('should cascade delete videos when channel is deleted', async () => {
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: testChannel.id,
        title: 'Video to Cascade',
        unique_url_id: 'cascade1234',
      }),
    );

    await channelRepository.delete({ id: testChannel.id });

    const found = await videoRepository.findOneBy({ id: video.id });
    expect(found).toBeNull();
  });
});
