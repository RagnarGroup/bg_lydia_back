// LYD-96: helpers puros de atribucion de origen de leads -- codigo [TT-...] del
// primer mensaje (anuncios de TikTok con destino WhatsApp) y `referral` de los
// anuncios de Meta (Cloud API, Messenger e Instagram). Separados del servicio
// para poder testearlos sin Prisma ni base de datos.

export type AttributionSource = 'Meta' | 'TikTok';

export interface LeadAttribution {
  source: AttributionSource;
  // Canal por el que entro: whatsapp, messenger, instagram, tiktok...
  platform: string;
  // Clave unica para filtrar/agrupar: codigo TT-XXX o id del anuncio de Meta.
  campaign: string;
  adId?: string;
  headline?: string;
  ctwaClid?: string;
  sourceUrl?: string;
  ref?: string;
  capturedAt: string;
}

const MAX_VALUE = 500;

// [TT-ING01], [tt-ing-01], [ TT-ING01 ]: alfanumerico con guiones, sin importar mayusculas.
const TIKTOK_CODE = /\[\s*(TT-[A-Z0-9]+(?:-[A-Z0-9]+)*)\s*\]/i;

function clean(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_VALUE) : undefined;
}

export function extractTikTokCode(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const match = TIKTOK_CODE.exec(text);
  return match ? match[1].toUpperCase() : undefined;
}

// Texto del mensaje tal como se guarda en Message.message (texto plano,
// texto extendido o caption de adjunto).
export function messageText(message: any): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  return (
    clean(message.conversation) ??
    clean(message.extendedTextMessage?.text) ??
    clean(message.imageMessage?.caption) ??
    clean(message.videoMessage?.caption) ??
    clean(message.documentMessage?.caption)
  );
}

export function tikTokAttribution(text: unknown, platform: string, now = new Date()): LeadAttribution | undefined {
  const code = extractTikTokCode(text);
  if (!code) return undefined;
  return { source: 'TikTok', platform, campaign: code, capturedAt: now.toISOString() };
}

// WhatsApp Cloud API: messages[].referral de un anuncio click-to-WhatsApp
// (source_id = id del anuncio o publicacion, source_type = ad|post).
export function whatsappReferralAttribution(referral: any, now = new Date()): LeadAttribution | undefined {
  if (!referral || typeof referral !== 'object') return undefined;
  const adId = clean(referral.source_id);
  const ctwaClid = clean(referral.ctwa_clid);
  const headline = clean(referral.headline);
  const sourceUrl = clean(referral.source_url);
  if (!adId && !ctwaClid) return undefined;
  return {
    source: 'Meta',
    platform: 'whatsapp',
    campaign: adId ?? `ctwa:${ctwaClid}`.slice(0, MAX_VALUE),
    ...(adId ? { adId } : {}),
    ...(headline ? { headline } : {}),
    ...(ctwaClid ? { ctwaClid } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    capturedAt: now.toISOString(),
  };
}

// Messenger / Instagram: `referral` en messaging (tambien dentro de postback o
// de message). Un anuncio trae ad_id / source=ADS; un link m.me con ?ref= no es
// anuncio y solo cuenta si el ref es un codigo TT-.
export function socialReferralAttribution(
  referral: any,
  platform: 'messenger' | 'instagram',
  now = new Date(),
): LeadAttribution | undefined {
  if (!referral || typeof referral !== 'object') return undefined;
  const adId = clean(referral.ad_id) ?? clean(referral.ads_context_data?.ad_id);
  const ref = clean(referral.ref);
  const isAd = !!adId || `${referral.source ?? ''}`.toUpperCase() === 'ADS';

  if (!isAd) {
    const code = extractTikTokCode(ref ? `[${ref}]` : undefined);
    return code ? { source: 'TikTok', platform, campaign: code, ref, capturedAt: now.toISOString() } : undefined;
  }

  const headline = clean(referral.ads_context_data?.ad_title) ?? clean(referral.headline);
  return {
    source: 'Meta',
    platform,
    campaign: adId ?? ref ?? 'ads',
    ...(adId ? { adId } : {}),
    ...(headline ? { headline } : {}),
    ...(ref ? { ref } : {}),
    capturedAt: now.toISOString(),
  };
}

// Valor guardado en Chat.attribution -> objeto tipado, o undefined si no es valido.
export function readAttribution(stored: unknown): LeadAttribution | undefined {
  if (!stored || typeof stored !== 'object') return undefined;
  const value = stored as Record<string, unknown>;
  if (value.source !== 'Meta' && value.source !== 'TikTok') return undefined;
  if (typeof value.campaign !== 'string' || !value.campaign) return undefined;
  return stored as LeadAttribution;
}
