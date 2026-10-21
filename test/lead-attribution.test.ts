// LYD-96: npx tsx --test test/lead-attribution.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { attributeInboundMessage } from '../src/api/services/lead-attribution.service';
import {
  extractTikTokCode,
  messageText,
  socialReferralAttribution,
  tikTokAttribution,
  whatsappReferralAttribution,
} from '../src/api/services/lead-attribution.util';

describe('extractTikTokCode', () => {
  it('detecta el codigo y lo normaliza a mayusculas', () => {
    assert.equal(extractTikTokCode('Hola, quiero info del curso de inglés [TT-ING01]'), 'TT-ING01');
    assert.equal(extractTikTokCode('hola [tt-ing01]'), 'TT-ING01');
    assert.equal(extractTikTokCode('[Tt-Ing-Adultos-02] info'), 'TT-ING-ADULTOS-02');
    assert.equal(extractTikTokCode('[ TT-ING01 ]'), 'TT-ING01');
  });

  it('devuelve undefined sin codigo o con el codigo borrado', () => {
    assert.equal(extractTikTokCode('Hola, quiero info del curso de inglés'), undefined);
    assert.equal(extractTikTokCode('Hola, quiero info del curso de inglés []'), undefined);
    assert.equal(extractTikTokCode('TT-ING01 sin corchetes'), undefined);
    assert.equal(extractTikTokCode('[TT-]'), undefined);
    assert.equal(extractTikTokCode(undefined), undefined);
  });
});

describe('messageText', () => {
  it('lee texto plano, extendido y caption', () => {
    assert.equal(messageText({ conversation: 'a [TT-X1]' }), 'a [TT-X1]');
    assert.equal(messageText({ extendedTextMessage: { text: 'b' } }), 'b');
    assert.equal(messageText({ imageMessage: { caption: 'c' } }), 'c');
    assert.equal(messageText({ imageMessage: {} }), undefined);
  });
});

describe('whatsappReferralAttribution', () => {
  it('mapea el referral de un anuncio click-to-WhatsApp', () => {
    const result = whatsappReferralAttribution({
      source_url: 'https://fb.me/abc',
      source_id: '120210000000',
      source_type: 'ad',
      headline: 'Aprende inglés',
      body: 'texto',
      ctwa_clid: 'AfX123',
    });
    assert.equal(result?.source, 'Meta');
    assert.equal(result?.platform, 'whatsapp');
    assert.equal(result?.campaign, '120210000000');
    assert.equal(result?.adId, '120210000000');
    assert.equal(result?.headline, 'Aprende inglés');
    assert.equal(result?.ctwaClid, 'AfX123');
    assert.equal(result?.sourceUrl, 'https://fb.me/abc');
  });

  it('sin referral o sin ids no hay atribucion', () => {
    assert.equal(whatsappReferralAttribution(undefined), undefined);
    assert.equal(whatsappReferralAttribution({ headline: 'x' }), undefined);
  });
});

describe('socialReferralAttribution', () => {
  it('mapea un referral de anuncio de Messenger', () => {
    const result = socialReferralAttribution(
      { ref: 'promo', source: 'ADS', type: 'OPEN_THREAD', ad_id: '6001', ads_context_data: { ad_title: 'Matrícula' } },
      'messenger',
    );
    assert.equal(result?.source, 'Meta');
    assert.equal(result?.platform, 'messenger');
    assert.equal(result?.campaign, '6001');
    assert.equal(result?.headline, 'Matrícula');
    assert.equal(result?.ref, 'promo');
  });

  it('Instagram con ad_id', () => {
    const result = socialReferralAttribution({ ad_id: '77', source: 'ADS' }, 'instagram');
    assert.equal(result?.platform, 'instagram');
    assert.equal(result?.campaign, '77');
  });

  it('un link m.me comun no es anuncio, salvo que el ref sea un codigo TT', () => {
    assert.equal(socialReferralAttribution({ ref: 'web', source: 'SHORTLINK' }, 'messenger'), undefined);
    const tt = socialReferralAttribution({ ref: 'tt-ing01', source: 'SHORTLINK' }, 'messenger');
    assert.equal(tt?.source, 'TikTok');
    assert.equal(tt?.campaign, 'TT-ING01');
  });
});

describe('tikTokAttribution', () => {
  it('arma la atribucion TikTok con el canal de entrada', () => {
    const result = tikTokAttribution('Hola [TT-ING01]', 'whatsapp');
    assert.equal(result?.source, 'TikTok');
    assert.equal(result?.platform, 'whatsapp');
    assert.equal(result?.campaign, 'TT-ING01');
    assert.equal(tikTokAttribution('Hola', 'whatsapp'), undefined);
  });
});

// Prisma falso: un Chat en memoria y el conteo de entrantes.
function fakePrisma(initial: { attribution?: unknown; agentTags?: unknown } | null, inbound: number) {
  const state: { chat: any } = { chat: initial ? { id: 'c1', attribution: null, agentTags: null, ...initial } : null };
  const prisma: any = {
    chat: {
      findUnique: async () => state.chat,
      upsert: async ({ create, update }: any) => {
        state.chat = state.chat ? { ...state.chat, ...update } : { id: 'c1', ...create };
        return state.chat;
      },
    },
    $queryRaw: async () => [{ count: inbound }],
  };
  return { prisma, state };
}

describe('attributeInboundMessage', () => {
  it('primer mensaje con codigo TT fija fuente TikTok y guarda la campana', async () => {
    const db = fakePrisma({}, 1);
    const result = await attributeInboundMessage(db.prisma, 'i1', 'j1', {
      platform: 'whatsapp',
      text: 'Hola [tt-ing01]',
    });
    assert.equal(result?.campaign, 'TT-ING01');
    assert.equal(db.state.chat.agentTags.fuente, 'TikTok');
    assert.equal(db.state.chat.attribution.campaign, 'TT-ING01');
  });

  it('crea el chat si todavia no existe', async () => {
    const db = fakePrisma(null, 1);
    await attributeInboundMessage(db.prisma, 'i1', 'j1', { platform: 'whatsapp', text: '[TT-A1]' });
    assert.equal(db.state.chat.attribution.campaign, 'TT-A1');
  });

  it('ignora el codigo si no es el primer mensaje entrante', async () => {
    const db = fakePrisma({}, 3);
    const result = await attributeInboundMessage(db.prisma, 'i1', 'j1', { platform: 'whatsapp', text: '[TT-ING01]' });
    assert.equal(result, undefined);
    assert.equal(db.state.chat.attribution, null);
  });

  it('sin codigo no hace nada', async () => {
    const db = fakePrisma({}, 1);
    const result = await attributeInboundMessage(db.prisma, 'i1', 'j1', { platform: 'whatsapp', text: 'Hola' });
    assert.equal(result, undefined);
    assert.equal(db.state.chat.attribution, null);
  });

  it('no pisa una fuente puesta a mano, pero guarda la campana', async () => {
    const db = fakePrisma({ agentTags: { fuente: 'Volanteo', intencion: 'Interesado' } }, 1);
    await attributeInboundMessage(db.prisma, 'i1', 'j1', { platform: 'whatsapp', text: '[TT-ING01]' });
    assert.equal(db.state.chat.agentTags.fuente, 'Volanteo');
    assert.equal(db.state.chat.agentTags.intencion, 'Interesado');
    assert.equal(db.state.chat.attribution.campaign, 'TT-ING01');
  });

  it('primer toque gana: no reescribe una atribucion existente', async () => {
    const db = fakePrisma(
      { attribution: { source: 'Meta', campaign: '999', platform: 'whatsapp', capturedAt: 'x' } },
      1,
    );
    const referral = whatsappReferralAttribution({ source_id: '111' });
    const result = await attributeInboundMessage(db.prisma, 'i1', 'j1', { platform: 'whatsapp', referral });
    assert.equal(result, undefined);
    assert.equal(db.state.chat.attribution.campaign, '999');
  });

  it('el referral de Meta no exige ser el primer mensaje y fija fuente Meta', async () => {
    const db = fakePrisma({}, 5);
    const referral = whatsappReferralAttribution({ source_id: '111', headline: 'H', ctwa_clid: 'C' });
    await attributeInboundMessage(db.prisma, 'i1', 'j1', { platform: 'whatsapp', referral });
    assert.equal(db.state.chat.agentTags.fuente, 'Meta');
    assert.equal(db.state.chat.attribution.ctwaClid, 'C');
  });
});
