// LYD-95: npx tsx --test test/tiktok.test.ts
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { TiktokApi, TiktokApiError } from '../src/api/integrations/channel/tiktok/tiktok.api';
import { decryptSecret, encryptSecret } from '../src/api/integrations/channel/tiktok/tiktok.crypto';
import {
  parseTiktokEnvelope,
  parseTiktokMessage,
  parseTiktokReadReceipt,
  tiktokConversationId,
  tiktokJid,
} from '../src/api/integrations/channel/tiktok/tiktok.events';
import { KeyedQueue } from '../src/api/integrations/channel/tiktok/tiktok.queue';
import { isValidTiktokSignature } from '../src/api/integrations/channel/tiktok/tiktok.signature';
import {
  TIKTOK_REFRESH_MARGIN_MS,
  TiktokChannelRow,
  TiktokReauthRequiredError,
  TiktokTokenService,
} from '../src/api/integrations/channel/tiktok/tiktok.token.service';
import {
  assertWithinReplyWindow,
  isWithinReplyWindow,
  TIKTOK_REPLY_WINDOW_MS,
  TiktokWindowClosedError,
} from '../src/api/integrations/channel/tiktok/tiktok.window';
import { withDefaultSource } from '../src/api/services/agent-tags';

const SECRET = 'app-secret';
const BUSINESS_ID = 'biz-1';

function sign(body: string, t: number, secret = SECRET) {
  const s = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},s=${s}`;
}

describe('isValidTiktokSignature', () => {
  const body = JSON.stringify({ event: 'im_receive_msg', content: '{}' });
  const raw = Buffer.from(body);
  const now = 1_800_000_000;

  it('acepta una firma correcta y reciente', () => {
    assert.equal(isValidTiktokSignature(raw, sign(body, now), SECRET, now), true);
    assert.equal(isValidTiktokSignature(raw, sign(body, now - 4), SECRET, now), true);
  });

  it('rechaza si el body crudo cambia aunque el JSON sea equivalente', () => {
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body), null, 2));
    assert.equal(isValidTiktokSignature(reformatted, sign(body, now), SECRET, now), false);
  });

  it('rechaza secreto equivocado, header ausente o malformado', () => {
    assert.equal(isValidTiktokSignature(raw, sign(body, now, 'otro'), SECRET, now), false);
    assert.equal(isValidTiktokSignature(raw, undefined, SECRET, now), false);
    assert.equal(isValidTiktokSignature(raw, 'basura', SECRET, now), false);
    assert.equal(isValidTiktokSignature(raw, `t=${now}`, SECRET, now), false);
    assert.equal(isValidTiktokSignature(raw, `t=${now},s=zz`, SECRET, now), false);
  });

  it('rechaza si no hay body crudo o falta el secreto configurado', () => {
    assert.equal(isValidTiktokSignature(undefined, sign(body, now), SECRET, now), false);
    assert.equal(isValidTiktokSignature(raw, sign(body, now), '', now), false);
  });

  it('rechaza un timestamp con mas de 5 s de diferencia (replay)', () => {
    assert.equal(isValidTiktokSignature(raw, sign(body, now - 6), SECRET, now), false);
    assert.equal(isValidTiktokSignature(raw, sign(body, now + 6), SECRET, now), false);
  });
});

describe('parseTiktokEnvelope', () => {
  it('parsea content cuando llega como string JSON', () => {
    const envelope = parseTiktokEnvelope({
      event: 'im_receive_msg',
      user_openid: BUSINESS_ID,
      content: JSON.stringify({ message_id: 'm1' }),
    });
    assert.deepEqual(envelope, { event: 'im_receive_msg', businessId: BUSINESS_ID, content: { message_id: 'm1' } });
  });

  it('descarta payloads sin evento, sin user_openid o con content roto', () => {
    assert.equal(parseTiktokEnvelope(null), null);
    assert.equal(parseTiktokEnvelope({ user_openid: BUSINESS_ID, content: '{}' }), null);
    assert.equal(parseTiktokEnvelope({ event: 'x', content: '{}' }), null);
    assert.equal(parseTiktokEnvelope({ event: 'x', user_openid: BUSINESS_ID, content: '{no json' }), null);
  });
});

describe('parseTiktokMessage (direccion y contenido)', () => {
  const inbound = {
    type: 'text',
    message_id: 'm1',
    conversation_id: 'conv-1',
    timestamp: 1_700_000_000_000,
    from: 'Maria',
    from_user: { id: 'user-9' },
    to: 'Brittany',
    to_user: { id: BUSINESS_ID },
    text: { body: 'Hola' },
  };

  it('es entrante cuando to_user.id es el canal', () => {
    const message = parseTiktokMessage(inbound, BUSINESS_ID);
    assert.equal(message?.fromMe, false);
    assert.equal(message?.contactName, 'Maria');
    assert.equal(message?.text, 'Hola');
    assert.equal(message?.conversationId, 'conv-1');
    assert.equal(message?.timestampMs, 1_700_000_000_000);
  });

  it('es saliente (eco) cuando from_user.id es el canal, y el contacto es el destinatario', () => {
    const echo = {
      ...inbound,
      from_user: { id: BUSINESS_ID },
      to_user: { id: 'user-9' },
      from: 'Brittany',
      to: 'Maria',
    };
    const message = parseTiktokMessage(echo, BUSINESS_ID);
    assert.equal(message?.fromMe, true);
    assert.equal(message?.contactName, 'Maria');
  });

  it('descarta mensajes ajenos al canal o sin ids', () => {
    assert.equal(parseTiktokMessage({ ...inbound, to_user: { id: 'otro' } }, BUSINESS_ID), null);
    assert.equal(parseTiktokMessage({ ...inbound, message_id: undefined }, BUSINESS_ID), null);
    assert.equal(parseTiktokMessage({ ...inbound, conversation_id: undefined }, BUSINESS_ID), null);
  });

  it('extrae imagen, publicacion compartida y respuesta a otro mensaje', () => {
    const image = parseTiktokMessage({ ...inbound, type: 'image', image: { media_id: 'media-1' } }, BUSINESS_ID);
    assert.equal(image?.type, 'image');
    assert.equal(image?.mediaId, 'media-1');

    const share = parseTiktokMessage(
      { ...inbound, type: 'share_post', share_post: { embed_url: 'https://tiktok.com/v/1' } },
      BUSINESS_ID,
    );
    assert.equal(share?.embedUrl, 'https://tiktok.com/v/1');

    const reply = parseTiktokMessage(
      { ...inbound, referenced_message_info: { referenced_message_id: 'm0' } },
      BUSINESS_ID,
    );
    assert.equal(reply?.referencedMessageId, 'm0');
  });
});

describe('parseTiktokReadReceipt', () => {
  it('toma la marca de lectura o cae a "ahora"', () => {
    assert.deepEqual(parseTiktokReadReceipt({ conversation_id: 'c', read: { last_read_timestamp: 5000 } }), {
      conversationId: 'c',
      readUpToMs: 5000,
    });
    assert.equal(parseTiktokReadReceipt({ conversation_id: 'c' }, 123)?.readUpToMs, 123);
    assert.equal(parseTiktokReadReceipt({}), null);
  });
});

describe('jid de TikTok', () => {
  it('ida y vuelta conversation_id <-> jid', () => {
    assert.equal(tiktokJid('conv-1'), 'conv-1@tiktok');
    assert.equal(tiktokConversationId('conv-1@tiktok'), 'conv-1');
    assert.equal(tiktokConversationId('conv-1'), 'conv-1');
  });
});

describe('ventana de 48 h', () => {
  const lastInbound = 1_700_000_000_000;

  it('permite responder hasta 48 h despues del ultimo mensaje del usuario', () => {
    assert.equal(isWithinReplyWindow(lastInbound, lastInbound + 1000), true);
    assert.equal(isWithinReplyWindow(lastInbound, lastInbound + TIKTOK_REPLY_WINDOW_MS), true);
  });

  it('bloquea pasadas las 48 h o sin ningun mensaje del usuario', () => {
    assert.equal(isWithinReplyWindow(lastInbound, lastInbound + TIKTOK_REPLY_WINDOW_MS + 1), false);
    assert.equal(isWithinReplyWindow(null), false);
    assert.equal(isWithinReplyWindow(undefined), false);
  });

  it('assertWithinReplyWindow lanza un error claro fuera de ventana', () => {
    assert.doesNotThrow(() => assertWithinReplyWindow(lastInbound, lastInbound + 1000));
    assert.throws(
      () => assertWithinReplyWindow(lastInbound, lastInbound + TIKTOK_REPLY_WINDOW_MS + 1),
      (error: Error) => error instanceof TiktokWindowClosedError && /48 h/.test(error.message),
    );
  });
});

describe('cifrado de tokens', () => {
  it('descifra lo cifrado y no repite el texto cifrado (iv aleatorio)', () => {
    const a = encryptSecret('token-123', 'clave-larga');
    const b = encryptSecret('token-123', 'clave-larga');
    assert.notEqual(a, b);
    assert.ok(!a.includes('token-123'));
    assert.equal(decryptSecret(a, 'clave-larga'), 'token-123');
  });

  it('falla con otra clave, texto alterado o sin clave', () => {
    const payload = encryptSecret('token-123', 'clave-larga');
    assert.throws(() => decryptSecret(payload, 'otra-clave'));
    assert.throws(() => decryptSecret(payload.slice(0, -2) + 'AA', 'clave-larga'));
    assert.throws(() => encryptSecret('x', ''));
  });
});

describe('TiktokApi', () => {
  const config = { appId: 'app', appSecret: 'sec', apiUrl: 'https://api.test/open_api', apiVersion: 'v1.3' };

  it('arma la URL de autorizacion con los scopes de DMs', () => {
    const api = new TiktokApi(config, {} as any);
    const url = new URL(api.authorizeUrl('https://x/tiktok/callback', 'st'));
    assert.equal(url.origin + url.pathname, 'https://www.tiktok.com/v2/auth/authorize');
    assert.equal(url.searchParams.get('client_key'), 'app');
    assert.equal(url.searchParams.get('state'), 'st');
    assert.ok(url.searchParams.get('scope')?.includes('message.list.send'));
  });

  it('convierte code != 0 en TiktokApiError, tambien cuando viene en un 4xx', async () => {
    const okButRejected = new TiktokApi(config, {
      post: async () => ({ data: { code: 40002, message: 'bad token' } }),
      get: async () => ({ data: {} }),
    });
    await assert.rejects(
      () => okButRejected.refreshToken('r'),
      (error: TiktokApiError) => error instanceof TiktokApiError && error.code === 40002,
    );

    const httpError = new TiktokApi(config, {
      post: async () => {
        throw { response: { data: { code: 40100, message: 'nope' } } };
      },
      get: async () => ({ data: {} }),
    });
    await assert.rejects(() => httpError.refreshToken('r'), TiktokApiError);
  });

  it('un fallo de red no es un TiktokApiError', async () => {
    const api = new TiktokApi(config, {
      post: async () => {
        throw new Error('ETIMEDOUT');
      },
      get: async () => ({ data: {} }),
    });
    await assert.rejects(
      () => api.refreshToken('r'),
      (error: Error) => !(error instanceof TiktokApiError) && error.message === 'ETIMEDOUT',
    );
  });

  it('envia texto con el sobre esperado y devuelve el message_id', async () => {
    const calls: any[] = [];
    const api = new TiktokApi(config, {
      post: async (url: string, body: any, cfg: any) => {
        calls.push({ url, body, cfg });
        return { data: { code: 0, data: { message: { message_id: 'out-1' } } } };
      },
      get: async () => ({ data: {} }),
    });
    const result = await api.sendMessage('tok', { businessId: BUSINESS_ID, conversationId: 'c1', text: 'hola' });
    assert.equal(result.messageId, 'out-1');
    assert.equal(calls[0].url, 'https://api.test/open_api/v1.3/business/message/send/');
    assert.equal(calls[0].cfg.headers['Access-Token'], 'tok');
    assert.deepEqual(calls[0].body, {
      business_id: BUSINESS_ID,
      recipient_type: 'CONVERSATION',
      recipient: 'c1',
      message_type: 'TEXT',
      text: { body: 'hola' },
    });
  });
});

// Store en memoria con la misma forma que usa TiktokTokenService.
function makeStore(initial: Partial<TiktokChannelRow> = {}) {
  const now = 1_800_000_000_000;
  const row: TiktokChannelRow = {
    id: 'ch1',
    instanceId: 'inst1',
    businessId: BUSINESS_ID,
    accessTokenEnc: encryptSecret('access-old', 'k'),
    refreshTokenEnc: encryptSecret('refresh-old', 'k'),
    accessTokenExpiresAt: new Date(now + 3_600_000),
    refreshTokenExpiresAt: new Date(now + 20 * 86_400_000),
    status: 'connected',
    ...initial,
  };
  return {
    row,
    now,
    store: {
      tiktokChannel: {
        findUnique: async () => ({ ...row }),
        findMany: async () => [{ ...row }],
        update: async ({ data }: any) => Object.assign(row, data),
      },
    },
  };
}

describe('TiktokTokenService', () => {
  it('no refresca si el access token vence en mas de 5 min', async () => {
    const { store, now } = makeStore();
    let refreshes = 0;
    const api = { refreshToken: async () => (refreshes++, {}) } as any;
    const service = new TiktokTokenService(store, api, 'k', () => now);

    const result = await service.getAccessToken('inst1');
    assert.equal(result.accessToken, 'access-old');
    assert.equal(refreshes, 0);
  });

  it('refresca (y guarda cifrado) si vence en menos de 5 min', async () => {
    const { store, row, now } = makeStore();
    row.accessTokenExpiresAt = new Date(now + TIKTOK_REFRESH_MARGIN_MS - 1000);
    const api = {
      refreshToken: async (token: string) => {
        assert.equal(token, 'refresh-old');
        return {
          access_token: 'access-new',
          refresh_token: 'refresh-new',
          expires_in: 86400,
          refresh_token_expires_in: 2_592_000,
        };
      },
    } as any;
    const service = new TiktokTokenService(store, api, 'k', () => now);

    const result = await service.getAccessToken('inst1');
    assert.equal(result.accessToken, 'access-new');
    assert.ok(!row.accessTokenEnc.includes('access-new'));
    assert.equal(decryptSecret(row.refreshTokenEnc, 'k'), 'refresh-new');
    assert.equal(row.accessTokenExpiresAt.getTime(), now + 86_400_000);
    assert.equal(row.refreshTokenExpiresAt.getTime(), now + 2_592_000_000);
  });

  it('refrescos concurrentes del mismo canal hacen una sola llamada a TikTok', async () => {
    const { store, row, now } = makeStore();
    row.accessTokenExpiresAt = new Date(now + 1000);
    let refreshes = 0;
    const api = {
      refreshToken: async () => {
        refreshes++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          access_token: 'access-new',
          refresh_token: 'refresh-new',
          expires_in: 86400,
          refresh_token_expires_in: 2_592_000,
        };
      },
    } as any;
    const service = new TiktokTokenService(store, api, 'k', () => now);

    const results = await Promise.all([
      service.getAccessToken('inst1'),
      service.getAccessToken('inst1'),
      service.getAccessToken('inst1'),
    ]);
    assert.equal(refreshes, 1);
    assert.ok(results.every((r) => r.accessToken === 'access-new'));
  });

  it('si el refresh token ya vencio marca reautorizacion sin llamar a TikTok', async () => {
    const { store, row, now } = makeStore();
    row.accessTokenExpiresAt = new Date(now - 1000);
    row.refreshTokenExpiresAt = new Date(now - 1000);
    let calls = 0;
    const service = new TiktokTokenService(store, { refreshToken: async () => (calls++, {}) } as any, 'k', () => now);

    await assert.rejects(() => service.getAccessToken('inst1'), TiktokReauthRequiredError);
    assert.equal(calls, 0);
    assert.equal(row.status, 'reauth_required');
  });

  it('si TikTok rechaza el refresh marca reautorizacion; despues falla rapido', async () => {
    const { store, row, now } = makeStore();
    row.accessTokenExpiresAt = new Date(now - 1000);
    let calls = 0;
    const api = {
      refreshToken: async () => {
        calls++;
        throw new TiktokApiError('refresh token expired', 40105);
      },
    } as any;
    const service = new TiktokTokenService(store, api, 'k', () => now);

    await assert.rejects(() => service.getAccessToken('inst1'), TiktokReauthRequiredError);
    assert.equal(row.status, 'reauth_required');
    await assert.rejects(() => service.getAccessToken('inst1'), TiktokReauthRequiredError);
    assert.equal(calls, 1);
  });

  it('un fallo de red en el refresh no invalida el canal', async () => {
    const { store, row, now } = makeStore();
    row.accessTokenExpiresAt = new Date(now - 1000);
    const api = {
      refreshToken: async () => {
        throw new Error('ETIMEDOUT');
      },
    } as any;
    const service = new TiktokTokenService(store, api, 'k', () => now);

    await assert.rejects(() => service.getAccessToken('inst1'), /ETIMEDOUT/);
    assert.equal(row.status, 'connected');
  });

  it('channelStatus expone reauth_required por estado o por refresh vencido', () => {
    const future = new Date(Date.now() + 100_000);
    assert.equal(TiktokTokenService.channelStatus({ status: 'connected', refreshTokenExpiresAt: future }), 'connected');
    assert.equal(
      TiktokTokenService.channelStatus({ status: 'reauth_required', refreshTokenExpiresAt: future }),
      'reauth_required',
    );
    assert.equal(
      TiktokTokenService.channelStatus({ status: 'connected', refreshTokenExpiresAt: new Date(Date.now() - 1) }),
      'reauth_required',
    );
  });
});

describe('KeyedQueue', () => {
  it('serializa tareas de la misma clave y deja pasar otras claves', async () => {
    const queue = new KeyedQueue();
    const order: string[] = [];

    const a1 = queue.run('a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('a1');
    });
    const a2 = queue.run('a', async () => {
      order.push('a2');
    });
    const b1 = queue.run('b', async () => {
      order.push('b1');
    });
    await Promise.all([a1, a2, b1]);

    assert.deepEqual(order, ['b1', 'a1', 'a2']);
  });

  it('una tarea fallida no bloquea las siguientes', async () => {
    const queue = new KeyedQueue();
    const failing = queue.run('a', async () => {
      throw new Error('boom');
    });
    await assert.rejects(() => failing, /boom/);
    assert.equal(await queue.run('a', async () => 'ok'), 'ok');
  });
});

describe('withDefaultSource', () => {
  it('fija TikTok solo si la conversacion no tiene fuente', () => {
    assert.deepEqual(withDefaultSource({ intencion: 'Interesado' }, 'TikTok'), {
      intencion: 'Interesado',
      fuente: 'TikTok',
    });
    assert.equal(withDefaultSource({ fuente: 'Meta' }, 'TikTok'), null);
  });
});
