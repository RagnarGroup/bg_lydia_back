// LYD-79: helpers puros de la lista paginada de conversaciones del inbox --
// separados de crm.service.ts para poder testearlos sin Prisma ni base de datos.

export const LIST_DEFAULT_LIMIT = 30;
export const LIST_MAX_LIMIT = 100;

// Canales tal como los nombra el front (InboxChannel). WhatsApp agrupa todas
// las integraciones que no son Messenger ni Instagram (Baileys, Cloud API...),
// igual que channelFromIntegration en lydia_bg_front.
export const NON_WHATSAPP_INTEGRATIONS = ['FACEBOOK-MESSENGER', 'INSTAGRAM', 'TIKTOK'] as const;
export type ConversationChannel = 'whatsapp' | 'messenger' | 'instagram' | 'tiktok';

export function parseChannel(raw: unknown): ConversationChannel | undefined {
  return raw === 'whatsapp' || raw === 'messenger' || raw === 'instagram' || raw === 'tiktok' ? raw : undefined;
}

// undefined = sin paginar (array completo, como antes de LYD-79).
export function normalizeListLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return LIST_DEFAULT_LIMIT;
  return Math.min(n, LIST_MAX_LIMIT);
}

// Cursor opaco = clave de orden (hora del ultimo mensaje) + id del chat, para
// desempatar chats con la misma hora. Keyset en vez de offset: si entra un
// mensaje nuevo mientras la asesora baja por la lista, no se saltea ni repite
// conversaciones.
export interface ConversationCursor {
  sortKey: number;
  id: string;
}

export function encodeCursor(cursor: ConversationCursor): string {
  return Buffer.from(`${cursor.sortKey}:${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): ConversationCursor | null {
  if (typeof raw !== 'string' || !raw) return null;
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep <= 0) return null;
  const sortKey = Number(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (!Number.isInteger(sortKey) || !id) return null;
  return { sortKey, id };
}

// Texto corto del ultimo mensaje para la lista. LYD-15: un mensaje que es
// solo una foto/audio/documento (sin texto) muestra el tipo en vez de quedar vacio.
export function messagePreview(message: unknown): string {
  const body = message as Record<string, any> | null;
  const text = body?.conversation ?? body?.extendedTextMessage?.text;
  if (text) return text;
  if (body?.imageMessage) return body.imageMessage.caption || 'Foto';
  if (body?.videoMessage) return body.videoMessage.caption || 'Video';
  if (body?.audioMessage) return 'Audio';
  if (body?.documentMessage) return body.documentMessage.caption || body.documentMessage.fileName || 'Documento';
  if (body?.stickerMessage) return 'Sticker';
  return '';
}

// LYD-118: alertas de "lead sin respuesta" (5 y 10 min, las pinta el front).
// Solo se calcula para chats con algun mensaje en esta ventana: sin ella, los
// chats viejos que terminan en un "ok, gracias" del cliente quedarian en rojo
// para siempre (en prod son la mayoria). Que el chat realmente espere
// respuesta lo decide la consulta (crm.service awaitingReplySince): el ultimo
// mensaje puede ser nuestro y aun asi esperar, si lo mando el bot.
export const AWAITING_REPLY_WINDOW_SECONDS = 24 * 60 * 60;

// Mensajes entrantes que no son algo que haya que contestar: no arrancan el reloj.
export const AWAITING_REPLY_IGNORED_TYPES = ['reactionMessage', 'protocolMessage', 'editedMessage'] as const;

export function isAwaitingReplyCandidate(
  lastMessage: { messageTimestamp: number } | undefined,
  nowSeconds: number,
): boolean {
  if (!lastMessage) return false;
  return nowSeconds - lastMessage.messageTimestamp <= AWAITING_REPLY_WINDOW_SECONDS;
}
