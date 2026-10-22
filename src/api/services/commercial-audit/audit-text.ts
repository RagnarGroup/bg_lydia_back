import { createHash } from 'crypto';

// LYD-102: texto y anonimizacion de los mensajes que se mandan a la IA y que
// aparecen en el reporte. Nada de esto sale del servidor sin pasar por aqui.

const MAX_MESSAGE_CHARS = 1200;

// Texto legible de un mensaje crudo de Evolution. Los adjuntos quedan como
// marcador (la IA no los puede ver ni oir); las reacciones no aportan y se omiten.
export function auditMessageText(message: unknown): string {
  const body = (message ?? {}) as Record<string, any>;
  if (body.reactionMessage || body.protocolMessage) return '';

  const caption =
    body.imageMessage?.caption ?? body.videoMessage?.caption ?? body.documentMessage?.caption ?? undefined;
  const text =
    body.conversation ??
    body.extendedTextMessage?.text ??
    body.buttonsResponseMessage?.selectedDisplayText ??
    body.listResponseMessage?.title ??
    body.templateButtonReplyMessage?.selectedDisplayText ??
    body.buttonsMessage?.contentText ??
    body.interactiveMessage?.body?.text;

  let out = '';
  if (body.imageMessage) out = `[imagen]${caption ? ` ${caption}` : ''}`;
  else if (body.videoMessage) out = `[video]${caption ? ` ${caption}` : ''}`;
  else if (body.documentMessage) out = `[documento]${caption ? ` ${caption}` : ''}`;
  else if (body.audioMessage) out = '[nota de voz]';
  else if (body.stickerMessage) out = '[sticker]';
  else if (body.locationMessage) out = '[ubicacion]';
  else if (body.contactMessage || body.contactsArrayMessage) out = '[contacto]';
  else if (text) out = String(text);

  return out.slice(0, MAX_MESSAGE_CHARS);
}

export function isVoiceNote(message: unknown): boolean {
  return Boolean((message as Record<string, unknown> | null)?.audioMessage);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 7 o mas digitos (con espacios, puntos o guiones): telefonos, DNI, RUC, cuentas.
const LONG_NUMBER = /\+?\d(?:[\s.-]?\d){6,}/g;

// Palabras del nombre del cliente (pushName, nombre del chat, del lead). Se
// ignoran las de menos de 3 letras para no borrar "de", "la", etc.
export function nameTokens(names: (string | null | undefined)[]): string[] {
  const tokens = new Set<string>();
  for (const name of names) {
    for (const token of (name ?? '').split(/[^\p{L}]+/u)) {
      if (token.length >= 3) tokens.add(token.toLowerCase());
    }
  }
  return [...tokens];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function anonymize(text: string, clientNameTokens: string[]): string {
  let out = text.replace(EMAIL, '[correo]').replace(LONG_NUMBER, '[numero]');
  for (const token of clientNameTokens) {
    out = out.replace(new RegExp(`(?<!\\p{L})${escapeRegExp(token)}(?!\\p{L})`, 'giu'), 'Cliente');
  }
  return out;
}

// Alias estable del cliente para el reporte (no revela el telefono ni el id).
export function clientAlias(chatId: string): string {
  return `Cliente #${createHash('sha256').update(chatId).digest('hex').slice(0, 4).toUpperCase()}`;
}
