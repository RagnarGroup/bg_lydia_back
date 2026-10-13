import { HttpStatus } from '@api/routes/index.router';

export class ServiceUnavailableException {
  constructor(...objectError: any[]) {
    throw {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      error: 'Service Unavailable',
      message: objectError.length > 0 ? objectError : undefined,
    };
  }
}
