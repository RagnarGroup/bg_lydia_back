import axios from 'axios';
import FormData from 'form-data';

// LYD-95: cliente HTTP de la Business Messaging API de TikTok. Toda respuesta util es HTTP 2xx con
// `code === 0`; cualquier otro `code` es un rechazo de negocio (token invalido, fuera de ventana, etc.).
export const TIKTOK_DM_SCOPES = [
  'user.info.basic',
  'user.info.username',
  'user.info.stats',
  'user.info.profile',
  'user.account.type',
  'user.insights',
  'message.list.read',
  'message.list.send',
  'message.list.manage',
];

export type TiktokApiConfig = {
  appId: string;
  appSecret: string;
  apiUrl: string;
  apiVersion: string;
};

export type TiktokHttp = {
  get: (url: string, config?: any) => Promise<{ data: any; status?: number; headers?: any }>;
  post: (url: string, body?: any, config?: any) => Promise<{ data: any; status?: number; headers?: any }>;
};

export type TiktokTokenResponse = {
  open_id: string;
  scope: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
};

// Rechazo de la API (code != 0). Distinto de un fallo de red/5xx: un refresh rechazado por TikTok
// significa que el refresh token ya no sirve; un timeout no.
export class TiktokApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'TiktokApiError';
  }
}

export class TiktokApi {
  constructor(
    private readonly config: TiktokApiConfig,
    private readonly http: TiktokHttp = axios,
  ) {}

  private url(path: string) {
    return `${this.config.apiUrl}/${this.config.apiVersion}/${path}`;
  }

  private unwrap(response: { data: any }): any {
    const body = response?.data;
    if (!body || body.code !== 0) {
      throw new TiktokApiError(body?.message ?? 'Respuesta invalida de TikTok', body?.code);
    }
    return body.data ?? {};
  }

  private async call(request: () => Promise<{ data: any }>): Promise<any> {
    try {
      return this.unwrap(await request());
    } catch (error) {
      if (error instanceof TiktokApiError) throw error;
      // HTTP 4xx con el sobre de TikTok en el body: tambien es un rechazo de negocio.
      const body = error?.response?.data;
      if (body && typeof body.code === 'number' && body.code !== 0) throw new TiktokApiError(body.message, body.code);
      throw error;
    }
  }

  private authHeaders(accessToken: string) {
    return { 'Access-Token': accessToken, 'Content-Type': 'application/json' };
  }

  authorizeUrl(redirectUri: string, state: string): string {
    const query = new URLSearchParams({
      response_type: 'code',
      client_key: this.config.appId,
      redirect_uri: redirectUri,
      state,
      scope: TIKTOK_DM_SCOPES.join(','),
    });
    return `https://www.tiktok.com/v2/auth/authorize?${query.toString()}`;
  }

  advertiserAuthorizeUrl(redirectUri: string, state: string): string {
    const query = new URLSearchParams({ app_id: this.config.appId, state, redirect_uri: redirectUri });
    return `https://business-api.tiktok.com/portal/auth?${query.toString()}`;
  }

  exchangeCode(code: string, redirectUri: string): Promise<TiktokTokenResponse> {
    return this.call(() =>
      this.http.post(this.url('tt_user/oauth2/token/'), {
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        grant_type: 'authorization_code',
        auth_code: code,
        redirect_uri: redirectUri,
      }),
    );
  }

  refreshToken(refreshToken: string): Promise<Omit<TiktokTokenResponse, 'open_id' | 'scope'>> {
    return this.call(() =>
      this.http.post(this.url('tt_user/oauth2/refresh_token/'), {
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    );
  }

  exchangeAdvertiserCode(authCode: string): Promise<{ access_token: string; advertiser_ids: string[]; scope?: any }> {
    return this.call(() =>
      this.http.post(this.url('oauth2/access_token/'), {
        app_id: this.config.appId,
        secret: this.config.appSecret,
        auth_code: authCode,
      }),
    );
  }

  registerWebhook(callbackUrl: string) {
    return this.call(() =>
      this.http.post(this.url('business/webhook/update/'), {
        app_id: this.config.appId,
        secret: this.config.appSecret,
        event_type: 'DIRECT_MESSAGE',
        callback_url: callbackUrl,
      }),
    );
  }

  listWebhooks() {
    return this.call(() =>
      this.http.get(this.url('business/webhook/list/'), {
        params: { app_id: this.config.appId, secret: this.config.appSecret, event_type: 'DIRECT_MESSAGE' },
      }),
    );
  }

  getProfile(accessToken: string, businessId: string): Promise<{ username?: string; display_name?: string }> {
    return this.call(() =>
      this.http.get(this.url('business/get/'), {
        headers: this.authHeaders(accessToken),
        params: { business_id: businessId, fields: JSON.stringify(['username', 'display_name', 'profile_image']) },
      }),
    );
  }

  async sendMessage(
    accessToken: string,
    params: {
      businessId: string;
      conversationId: string;
      text?: string;
      mediaId?: string;
      referencedMessageId?: string;
    },
  ): Promise<{ messageId: string }> {
    const body: any = {
      business_id: params.businessId,
      recipient_type: 'CONVERSATION',
      recipient: params.conversationId,
      ...(params.mediaId
        ? { message_type: 'IMAGE', image: { media_id: params.mediaId } }
        : { message_type: 'TEXT', text: { body: params.text } }),
    };
    if (params.referencedMessageId) {
      body.referenced_message_info = { referenced_message_id: params.referencedMessageId };
    }

    const data = await this.call(() =>
      this.http.post(this.url('business/message/send/'), body, { headers: this.authHeaders(accessToken) }),
    );
    return { messageId: `${data.message?.message_id}` };
  }

  async uploadImage(
    accessToken: string,
    businessId: string,
    file: Buffer,
    fileName: string,
    contentType: string,
  ): Promise<string> {
    const form = new FormData();
    form.append('business_id', businessId);
    form.append('media_type', 'IMAGE');
    form.append('file', file, { filename: fileName, contentType });

    const data = await this.call(() =>
      this.http.post(this.url('business/message/media/upload/'), form, {
        headers: { 'Access-Token': accessToken, ...form.getHeaders() },
        maxBodyLength: Infinity,
      }),
    );
    return `${data.media_id}`;
  }

  // Imagen entrante: primero se pide una URL temporal y despues se baja con el token del usuario en `x-user`.
  async downloadImage(
    accessToken: string,
    params: { businessId: string; conversationId: string; messageId: string; mediaId: string },
  ): Promise<{ buffer: Buffer; mimetype: string }> {
    const data = await this.call(() =>
      this.http.post(
        this.url('business/message/media/download/'),
        {
          business_id: params.businessId,
          conversation_id: params.conversationId,
          message_id: params.messageId,
          media_id: params.mediaId,
          media_type: 'IMAGE',
        },
        { headers: this.authHeaders(accessToken) },
      ),
    );
    if (!data.download_url) throw new TiktokApiError('TikTok no devolvio download_url');

    const file = await this.http.get(data.download_url, {
      headers: { 'x-user': accessToken },
      responseType: 'arraybuffer',
    });
    return { buffer: Buffer.from(file.data), mimetype: file.headers?.['content-type'] ?? 'image/jpeg' };
  }
}
