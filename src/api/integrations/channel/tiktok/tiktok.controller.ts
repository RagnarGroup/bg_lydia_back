import { InstanceController } from '@api/controllers/instance.controller';
import { PrismaRepository } from '@api/repository/repository.service';
import { CacheService } from '@api/services/cache.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import { ConfigService, HttpServer, Tiktok } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException } from '@exceptions';
import { randomBytes } from 'crypto';

import { ChannelController, ChannelControllerInterface } from '../channel.controller';
import { TiktokApi } from './tiktok.api';
import { parseTiktokEnvelope } from './tiktok.events';
import { getTiktokApi, getTiktokTokenService } from './tiktok.runtime';
import { TiktokTokenService } from './tiktok.token.service';

export type TiktokAuthType = 'account' | 'advertiser';

const STATE_TTL_SECONDS = 600;
const KEEP_ALIVE_EVERY_MS = 6 * 60 * 60 * 1000;
const KEEP_ALIVE_REFRESH_WITHIN_MS = 12 * 60 * 60 * 1000;

const stateKey = (state: string) => `tiktok:oauth-state:${state}`;

const instanceSlug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

// LYD-95: OAuth, estado de canales, registro de webhook y enrutado de eventos del canal TikTok.
export class TiktokController extends ChannelController implements ChannelControllerInterface {
  private readonly logger = new Logger('TiktokController');

  constructor(
    prismaRepository: PrismaRepository,
    waMonitor: WAMonitoringService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
    private readonly instanceController: () => InstanceController,
  ) {
    super(prismaRepository, waMonitor);
  }

  integrationEnabled: boolean;

  private get config() {
    return this.configService.get<Tiktok>('TIKTOK');
  }

  private get api(): TiktokApi {
    return getTiktokApi(this.configService);
  }

  private get tokens(): TiktokTokenService {
    return getTiktokTokenService(this.configService, this.prismaRepository);
  }

  private requireAppConfig() {
    if (!this.config.APP_ID || !this.config.APP_SECRET) {
      throw new BadRequestException('TikTok no esta configurado: faltan TIKTOK_APP_ID y TIKTOK_APP_SECRET');
    }
  }

  private redirectUri(type: TiktokAuthType) {
    const base = this.configService.get<HttpServer>('SERVER').URL;
    return type === 'advertiser' ? `${base}/tiktok/advertiser/callback` : `${base}/tiktok/callback`;
  }

  public async createAuthorizationUrl(type: TiktokAuthType = 'account') {
    this.requireAppConfig();

    // `state` es un valor de un solo uso generado aca: el callback solo lo acepta si lo reconoce (CSRF).
    const state = randomBytes(24).toString('hex');
    await this.cache.set(stateKey(state), { type }, STATE_TTL_SECONDS);

    const url =
      type === 'advertiser'
        ? this.api.advertiserAuthorizeUrl(this.redirectUri(type), state)
        : this.api.authorizeUrl(this.redirectUri(type), state);
    return { url };
  }

  private async consumeState(state: unknown, type: TiktokAuthType): Promise<boolean> {
    if (typeof state !== 'string' || !state) return false;

    const stored = await this.cache.get(stateKey(state));
    if (!stored) return false;

    await this.cache.delete(stateKey(state));
    return stored.type === type;
  }

  // Resultado para el router: a donde volver al navegador y con que estado.
  public async handleCallback(
    type: TiktokAuthType,
    query: Record<string, any>,
  ): Promise<{ ok: boolean; reason?: string }> {
    try {
      this.requireAppConfig();

      if (!(await this.consumeState(query.state, type))) {
        this.logger.warn(`Callback de TikTok (${type}) con state invalido o vencido`);
        return { ok: false, reason: 'state_invalido' };
      }

      if (query.error) {
        this.logger.warn(`Autorizacion de TikTok (${type}) rechazada: ${query.error} ${query.error_description ?? ''}`);
        return { ok: false, reason: 'acceso_denegado' };
      }

      // TikTok puede devolver el codigo como `code` o `auth_code` segun el flujo.
      const code = query.code ?? query.auth_code;
      if (typeof code !== 'string' || !code) return { ok: false, reason: 'sin_codigo' };

      if (type === 'advertiser') await this.saveAdvertiser(code);
      else await this.saveAccount(code);

      return { ok: true };
    } catch (error) {
      this.logger.error(`Callback de TikTok (${type}) fallido: ${error?.stack ?? error}`);
      return { ok: false, reason: 'error_interno' };
    }
  }

  private async saveAdvertiser(authCode: string) {
    const data = await this.api.exchangeAdvertiserCode(authCode);
    await this.prismaRepository.tiktokAdvertiser.create({
      data: {
        advertiserIds: data.advertiser_ids ?? [],
        scope: data.scope ?? undefined,
        accessTokenEnc: this.tokens.encrypt(data.access_token),
      },
    });
  }

  private async saveAccount(code: string) {
    const tokens = await this.api.exchangeCode(code, this.redirectUri('account'));
    const businessId = `${tokens.open_id}`;
    const now = Date.now();

    // Nombre de la cuenta: best-effort, no impide conectarla.
    const profile = await this.api.getProfile(tokens.access_token, businessId).catch((error) => {
      this.logger.warn(`No se pudo leer el perfil de TikTok: ${error?.message ?? error}`);
      return {} as { username?: string; display_name?: string };
    });

    const credentials = {
      username: profile.username?.slice(0, 100),
      displayName: profile.display_name?.slice(0, 100),
      scope: tokens.scope,
      accessTokenEnc: this.tokens.encrypt(tokens.access_token),
      refreshTokenEnc: this.tokens.encrypt(tokens.refresh_token),
      accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000),
      refreshTokenExpiresAt: new Date(now + tokens.refresh_token_expires_in * 1000),
      status: 'connected',
    };

    // Reautorizar una cuenta ya conectada solo renueva sus credenciales; la instancia y su historial quedan.
    const existing = await this.prismaRepository.tiktokChannel.findUnique({ where: { businessId } });
    if (existing) {
      await this.prismaRepository.tiktokChannel.update({ where: { id: existing.id }, data: credentials });
      return;
    }

    const instanceName = await this.freeInstanceName(profile.username || businessId);
    const created = await this.instanceController().createInstance({
      instanceName,
      integration: Integration.TIKTOK,
      number: businessId,
    });

    try {
      await this.prismaRepository.tiktokChannel.create({
        data: { instanceId: created.instance.instanceId, businessId, ...credentials },
      });
    } catch (error) {
      await this.prismaRepository.instance.delete({ where: { id: created.instance.instanceId } }).catch(() => null);
      throw error;
    }
  }

  private async freeInstanceName(seed: string) {
    const base = `tiktok-${instanceSlug(seed) || 'cuenta'}`;
    let name = base;
    for (let attempt = 2; await this.prismaRepository.instance.findUnique({ where: { name } }); attempt++) {
      name = `${base}-${attempt}`;
    }
    return name;
  }

  // Estado de los canales para el front; nunca expone tokens.
  public async listChannels() {
    const rows = await this.prismaRepository.tiktokChannel.findMany({
      include: { Instance: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => ({
      instanceName: row.Instance.name,
      businessId: row.businessId,
      username: row.username,
      displayName: row.displayName,
      status: TiktokTokenService.channelStatus(row),
      accessTokenExpiresAt: row.accessTokenExpiresAt,
      refreshTokenExpiresAt: row.refreshTokenExpiresAt,
    }));
  }

  public async registerWebhook(callbackUrl?: string) {
    this.requireAppConfig();
    const url = callbackUrl || `${this.configService.get<HttpServer>('SERVER').URL}/webhooks/tiktok`;
    const result = await this.api.registerWebhook(url);
    return { callbackUrl: url, result };
  }

  public async webhookStatus() {
    this.requireAppConfig();
    return this.api.listWebhooks();
  }

  // Evento ya verificado (firma) y respondido con 200: se enruta por `user_openid` (business_id) a su instancia.
  public async receiveWebhook(body: any) {
    const envelope = parseTiktokEnvelope(body);
    if (!envelope) {
      this.logger.warn('Webhook de TikTok con forma invalida, se ignora');
      return;
    }

    const instance = await this.prismaRepository.instance.findFirst({
      where: { number: envelope.businessId, integration: Integration.TIKTOK },
    });
    const channel = instance && this.waMonitor.waInstances[instance.name];

    if (!channel) {
      this.logger.warn(`Webhook de TikTok para ${envelope.businessId}: no hay instancia TikTok registrada`);
      return;
    }

    await channel.connectToWhatsapp(envelope);
  }

  // Renueva periodicamente los tokens que vencen pronto, para que el refresh token no caduque por falta de uso.
  public startTokenKeepAlive() {
    const timer = setInterval(() => {
      this.tokens
        .refreshDueChannels(KEEP_ALIVE_REFRESH_WITHIN_MS)
        .catch((error) => this.logger.error(`Refresco periodico de tokens de TikTok fallido: ${error}`));
    }, KEEP_ALIVE_EVERY_MS);
    timer.unref();
  }
}
