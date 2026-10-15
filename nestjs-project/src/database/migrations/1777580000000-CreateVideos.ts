import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1777580000000 implements MigrationInterface {
  name = 'CreateVideos1777580000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'videos_status_enum') THEN CREATE TYPE "public"."videos_status_enum" AS ENUM('DRAFT', 'PROCESSING', 'READY', 'ERROR', 'CANCELLED'); END IF; END $$;`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "channel_id" uuid NOT NULL,
        "title" character varying(150) NOT NULL,
        "description" text,
        "status" "public"."videos_status_enum" NOT NULL DEFAULT 'DRAFT',
        "original_storage_key" character varying(255),
        "thumbnail_storage_key" character varying(255),
        "duration_seconds" integer,
        "metadata" jsonb,
        "unique_url_id" character varying(20) NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_unique_url_id" UNIQUE ("unique_url_id"),
        CONSTRAINT "PK_videos_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_channel_id" ON "videos" ("channel_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_unique_url_id" ON "videos" ("unique_url_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_videos_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT IF EXISTS "FK_videos_channel_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_videos_unique_url_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_videos_channel_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "videos"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."videos_status_enum"`,
    );
  }
}
