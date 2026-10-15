import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor(message = 'Video not found') {
    super('VIDEO_NOT_FOUND', 404, message);
  }
}

export class InvalidUploadStateException extends DomainException {
  constructor(message = 'Invalid upload state for this operation') {
    super('INVALID_UPLOAD_STATE', 400, message);
  }
}

export class UnauthorizedChannelActionException extends DomainException {
  constructor(
    message = 'User does not own the channel associated with this video',
  ) {
    super('UNAUTHORIZED_CHANNEL_ACTION', 403, message);
  }
}

export class FileSizeExceededException extends DomainException {
  constructor(message = 'File size exceeds maximum allowed limit of 10GB') {
    super('FILE_SIZE_EXCEEDED', 400, message);
  }
}

export class VideoProcessingFailedException extends DomainException {
  constructor(message = 'Video processing failed') {
    super('VIDEO_PROCESSING_FAILED', 500, message);
  }
}
