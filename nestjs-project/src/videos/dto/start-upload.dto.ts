import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB

export class StartUploadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsNotEmpty()
  filename: string;

  @IsNumber()
  @Min(1)
  @Max(MAX_FILE_SIZE_BYTES, {
    message: 'File size exceeds maximum allowed limit of 10GB',
  })
  file_size: number;

  @IsInt()
  @Min(1)
  parts_count: number;
}
