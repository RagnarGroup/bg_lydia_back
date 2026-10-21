import { createHmac, timingSafeEqual } from 'crypto';

// LYD-95: TikTok firma cada POST del webhook con `Tiktok-Signature: t=<unix ts>,s=<hex>`, donde
// s = HMAC-SHA256(APP_SECRET, "<t>.<body crudo>"). Se rechaza si el timestamp tiene mas de 5 s (anti-replay).
export const TIKTOK_SIGNATURE_TOLERANCE_SECONDS = 5;

export function isValidTiktokSignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  appSecret: string,
  nowSeconds: number = Date.now() / 1000,
): boolean {
  if (!rawBody || !header || !appSecret) return false;

  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }),
  );
  const timestamp = Number(parts.t);
  if (!parts.t || !parts.s || !Number.isFinite(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > TIKTOK_SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = createHmac('sha256', appSecret).update(`${parts.t}.`).update(rawBody).digest();
  const received = Buffer.from(parts.s, 'hex');

  return received.length === expected.length && timingSafeEqual(received, expected);
}
