import 'express-async-errors';

import { RouterBroker } from '@api/abstract/abstract.router';
import { tiktokController } from '@api/server.module';
import { ConfigService, Tiktok } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { Request, Response, Router } from 'express';

import { TiktokAuthType } from './tiktok.controller';
import { isValidTiktokSignature } from './tiktok.signature';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// LYD-95: rutas del canal TikTok. Publicas (TikTok las llama): /tiktok/callback, /tiktok/advertiser/callback y
// /webhooks/tiktok (esta ultima solo con firma valida). Con apikey global: el resto.
export class TiktokRouter extends RouterBroker {
  private readonly logger = new Logger('TiktokRouter');

  constructor(
    readonly configService: ConfigService,
    apikeyGuard: any,
  ) {
    super();

    if (!configService.get<Tiktok>('TIKTOK').APP_SECRET) {
      this.logger.warn('TIKTOK_APP_SECRET no definido: POST /webhooks/tiktok rechaza todos los eventos (401)');
    }

    this.router
      .get('/tiktok/callback', (req, res) => this.callback('account', req, res))
      .get('/tiktok/advertiser/callback', (req, res) => this.callback('advertiser', req, res))
      .get('/tiktok/authorize-url', apikeyGuard, async (req, res) => {
        const type: TiktokAuthType = req.query.type === 'advertiser' ? 'advertiser' : 'account';
        return res.json(await tiktokController.createAuthorizationUrl(type));
      })
      .get('/tiktok/channels', apikeyGuard, async (_req, res) => {
        return res.json(await tiktokController.listChannels());
      })
      .post('/tiktok/webhook/register', apikeyGuard, async (req, res) => {
        return res.json(await tiktokController.registerWebhook(req.body?.callbackUrl));
      })
      .get('/tiktok/webhook/status', apikeyGuard, async (_req, res) => {
        return res.json(await tiktokController.webhookStatus());
      })
      .post('/webhooks/tiktok', (req, res) => {
        const appSecret = this.configService.get<Tiktok>('TIKTOK').APP_SECRET;
        const signature = req.get('tiktok-signature');

        if (!isValidTiktokSignature((req as any).rawBody, signature, appSecret)) {
          this.logger.warn('POST /webhooks/tiktok rechazado: firma Tiktok-Signature ausente, vencida o invalida');
          return res.status(401).json({ status: 'error', message: 'Invalid signature' });
        }

        // 200 de inmediato; el procesamiento sigue por detras (TikTok reintenta lo que no recibe como 2xx).
        res.status(200).json({ status: 'success' });
        void tiktokController
          .receiveWebhook(req.body)
          .catch((error) => this.logger.error(`Procesamiento del webhook de TikTok fallido: ${error?.stack ?? error}`));
      });
  }

  // Vuelve al front (con ?tiktok=connected|error) o, sin TIKTOK_POST_AUTH_REDIRECT, muestra una pagina simple.
  private async callback(type: TiktokAuthType, req: Request, res: Response) {
    const result = await tiktokController.handleCallback(type, req.query);
    const target = this.configService.get<Tiktok>('TIKTOK').POST_AUTH_REDIRECT;

    if (target) {
      const url = new URL(target);
      url.searchParams.set('tiktok', result.ok ? 'connected' : 'error');
      if (!result.ok && result.reason) url.searchParams.set('reason', result.reason);
      return res.redirect(url.toString());
    }

    const message = result.ok
      ? 'Cuenta de TikTok conectada. Ya puedes cerrar esta ventana.'
      : `No se pudo conectar la cuenta de TikTok (${result.reason}).`;
    return res
      .status(result.ok ? 200 : 400)
      .type('html')
      .send(`<p>${escapeHtml(message)}</p>`);
  }

  public readonly router: Router = Router();
}
