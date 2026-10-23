import { PrismaRepository } from '@api/repository/repository.service';
import { ConfigService, Tiktok } from '@config/env.config';

import { TiktokApi } from './tiktok.api';
import { TiktokTokenService } from './tiktok.token.service';

// LYD-95: instancias compartidas del cliente de TikTok y del servicio de tokens. El servicio de tokens tiene que
// ser unico para que su bloqueo por canal valga entre todas las instancias del canal (y el controlador OAuth).
let api: TiktokApi | null = null;
let tokenService: TiktokTokenService | null = null;

export function getTiktokApi(configService: ConfigService): TiktokApi {
  if (!api) {
    const config = configService.get<Tiktok>('TIKTOK');
    api = new TiktokApi({
      appId: config.APP_ID,
      appSecret: config.APP_SECRET,
      apiUrl: config.API_URL,
      apiVersion: config.API_VERSION,
      messagingEnabled: config.MESSAGING_ENABLED,
    });
  }
  return api;
}

export function getTiktokTokenService(
  configService: ConfigService,
  prismaRepository: PrismaRepository,
): TiktokTokenService {
  if (!tokenService) {
    tokenService = new TiktokTokenService(
      prismaRepository,
      getTiktokApi(configService),
      configService.get<Tiktok>('TIKTOK').TOKEN_ENCRYPTION_KEY,
    );
  }
  return tokenService;
}
