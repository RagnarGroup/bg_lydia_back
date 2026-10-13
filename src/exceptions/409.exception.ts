import { HttpStatus } from '@api/routes/index.router';

export class ConflictException {
  constructor(...objectError: any[]) {
    throw {
      status: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: objectError.length > 0 ? objectError : undefined,
    };
  }
}
