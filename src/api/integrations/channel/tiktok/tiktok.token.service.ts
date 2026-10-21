import { TiktokApi, TiktokApiError } from './tiktok.api';
import { decryptSecret, encryptSecret } from './tiktok.crypto';

// LYD-95: ciclo de vida de los tokens de TikTok. El access token dura ~24 h y el refresh ~30 dias.
export const TIKTOK_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type TiktokChannelStatus = 'connected' | 'reauth_required';

export class TiktokReauthRequiredError extends Error {
  constructor() {
    super('La cuenta de TikTok requiere reautorizacion: el acceso vencio, hay que volver a conectarla desde el CRM');
    this.name = 'TiktokReauthRequiredError';
  }
}

export type TiktokChannelRow = {
  id: string;
  instanceId: string;
  businessId: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  status: string;
};

// Solo lo que el servicio usa de Prisma, para poder simularlo en los tests.
export type TiktokChannelStore = {
  tiktokChannel: {
    findUnique: (args: any) => Promise<TiktokChannelRow | null>;
    findMany: (args?: any) => Promise<TiktokChannelRow[]>;
    update: (args: any) => Promise<any>;
  };
};

export class TiktokTokenService {
  // Un refresco a la vez por canal (un solo proceso del backend): los demas esperan el mismo resultado.
  private readonly refreshing = new Map<string, Promise<TiktokChannelRow>>();

  constructor(
    private readonly store: TiktokChannelStore,
    private readonly api: TiktokApi,
    private readonly encryptionKey: string,
    private readonly now: () => number = Date.now,
  ) {}

  encrypt(plain: string) {
    return encryptSecret(plain, this.encryptionKey);
  }

  decrypt(payload: string) {
    return decryptSecret(payload, this.encryptionKey);
  }

  async getAccessToken(instanceId: string): Promise<{ accessToken: string; businessId: string }> {
    let row = await this.store.tiktokChannel.findUnique({ where: { instanceId } });
    if (!row) throw new Error(`No hay credenciales de TikTok para la instancia ${instanceId}`);
    if (row.status === 'reauth_required') throw new TiktokReauthRequiredError();

    if (row.accessTokenExpiresAt.getTime() - this.now() < TIKTOK_REFRESH_MARGIN_MS) {
      row = await this.refresh(row);
    }

    return { accessToken: this.decrypt(row.accessTokenEnc), businessId: row.businessId };
  }

  private refresh(row: TiktokChannelRow): Promise<TiktokChannelRow> {
    const inFlight = this.refreshing.get(row.id);
    if (inFlight) return inFlight;

    const task = this.doRefresh(row.id).finally(() => this.refreshing.delete(row.id));
    this.refreshing.set(row.id, task);
    return task;
  }

  private async doRefresh(id: string): Promise<TiktokChannelRow> {
    // Se relee por si otro refresco ya lo renovo mientras se esperaba el turno.
    const row = await this.store.tiktokChannel.findUnique({ where: { id } });
    if (!row) throw new Error('Canal de TikTok inexistente');
    if (row.status === 'reauth_required') throw new TiktokReauthRequiredError();
    if (row.accessTokenExpiresAt.getTime() - this.now() >= TIKTOK_REFRESH_MARGIN_MS) return row;

    if (row.refreshTokenExpiresAt.getTime() <= this.now()) {
      await this.markReauthRequired(row.id);
      throw new TiktokReauthRequiredError();
    }

    let tokens: Awaited<ReturnType<TiktokApi['refreshToken']>>;
    try {
      tokens = await this.api.refreshToken(this.decrypt(row.refreshTokenEnc));
    } catch (error) {
      // Solo un rechazo explicito de TikTok invalida el canal; un timeout/5xx se reintenta en el proximo uso.
      if (error instanceof TiktokApiError) {
        await this.markReauthRequired(row.id);
        throw new TiktokReauthRequiredError();
      }
      throw error;
    }

    const now = this.now();
    return this.store.tiktokChannel.update({
      where: { id: row.id },
      data: {
        accessTokenEnc: this.encrypt(tokens.access_token),
        refreshTokenEnc: this.encrypt(tokens.refresh_token),
        accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000),
        refreshTokenExpiresAt: new Date(now + tokens.refresh_token_expires_in * 1000),
        status: 'connected',
      },
    });
  }

  private async markReauthRequired(id: string) {
    await this.store.tiktokChannel.update({ where: { id }, data: { status: 'reauth_required' } });
  }

  // Renueva los canales cuyo access token vence pronto, para que el refresh token (30 dias) no caduque por falta
  // de uso. Lo dispara un timer del servidor; devuelve cuantos refrescos intento.
  async refreshDueChannels(withinMs: number): Promise<number> {
    const rows = await this.store.tiktokChannel.findMany({ where: { status: 'connected' } });
    let attempted = 0;

    for (const row of rows) {
      if (row.accessTokenExpiresAt.getTime() - this.now() >= withinMs) continue;
      attempted++;
      try {
        await this.refresh(row);
      } catch {
        // El motivo ya quedo reflejado en el estado del canal; el resto de canales sigue.
      }
    }
    return attempted;
  }

  static channelStatus(row: Pick<TiktokChannelRow, 'status' | 'refreshTokenExpiresAt'>, nowMs: number = Date.now()) {
    if (row.status === 'reauth_required' || row.refreshTokenExpiresAt.getTime() <= nowMs) return 'reauth_required';
    return 'connected';
  }
}
