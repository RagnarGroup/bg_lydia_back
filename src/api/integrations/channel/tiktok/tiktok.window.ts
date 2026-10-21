// LYD-95: TikTok solo deja responder hasta 48 h despues del ultimo mensaje del usuario.
export const TIKTOK_REPLY_WINDOW_MS = 48 * 60 * 60 * 1000;

export class TiktokWindowClosedError extends Error {
  constructor() {
    super(
      'Fuera de la ventana de 48 h de TikTok: solo se puede responder dentro de las 48 h del ultimo mensaje del usuario',
    );
    this.name = 'TiktokWindowClosedError';
  }
}

export function replyWindowExpiresAt(lastInboundAtMs: number | null | undefined): number | null {
  return lastInboundAtMs ? lastInboundAtMs + TIKTOK_REPLY_WINDOW_MS : null;
}

export function isWithinReplyWindow(lastInboundAtMs: number | null | undefined, nowMs: number = Date.now()): boolean {
  const expires = replyWindowExpiresAt(lastInboundAtMs);
  return expires !== null && nowMs <= expires;
}

export function assertWithinReplyWindow(lastInboundAtMs: number | null | undefined, nowMs: number = Date.now()) {
  if (!isWithinReplyWindow(lastInboundAtMs, nowMs)) throw new TiktokWindowClosedError();
}
