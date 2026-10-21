// LYD-95: parseo de los eventos del webhook de TikTok (DIRECT_MESSAGE). El payload trae `content` como
// string JSON; la direccion se decide comparando to_user.id / from_user.id con el business_id del canal.
export const TIKTOK_EVENT = {
  RECEIVE: 'im_receive_msg',
  SEND: 'im_send_msg',
  MARK_READ: 'im_mark_read_msg',
} as const;

export type TiktokWebhookEnvelope = {
  event: string;
  businessId: string;
  content: Record<string, any>;
};

export type TiktokParsedMessage = {
  id: string;
  conversationId: string;
  timestampMs: number;
  type: string;
  fromMe: boolean;
  contactName?: string;
  text?: string;
  mediaId?: string;
  embedUrl?: string;
  referencedMessageId?: string;
};

export function parseTiktokEnvelope(body: any): TiktokWebhookEnvelope | null {
  if (!body || typeof body.event !== 'string' || !body.user_openid) return null;

  let content = body.content;
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (!content || typeof content !== 'object') return null;

  return { event: body.event, businessId: `${body.user_openid}`, content };
}

// Entrante si el destinatario (to_user) es el canal; saliente (eco) si el remitente (from_user) es el canal.
// Cualquier otro caso no es de este canal y se descarta.
export function parseTiktokMessage(content: Record<string, any>, businessId: string): TiktokParsedMessage | null {
  const id = content?.message_id;
  const conversationId = content?.conversation_id;
  if (!id || !conversationId) return null;

  const toId = `${content.to_user?.id ?? content.to_user_id ?? ''}`;
  const fromId = `${content.from_user?.id ?? content.from_user_id ?? ''}`;

  let fromMe: boolean;
  if (toId === businessId) fromMe = false;
  else if (fromId === businessId) fromMe = true;
  else return null;

  const timestampMs = Number(content.timestamp);

  return {
    id: `${id}`,
    conversationId: `${conversationId}`,
    timestampMs: Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : Date.now(),
    type: content.type ?? 'text',
    fromMe,
    contactName: (fromMe ? content.to : content.from) || undefined,
    text: content.text?.body ?? undefined,
    mediaId: content.image?.media_id ? `${content.image.media_id}` : undefined,
    embedUrl: content.share_post?.embed_url ?? undefined,
    referencedMessageId: content.referenced_message_info?.referenced_message_id
      ? `${content.referenced_message_info.referenced_message_id}`
      : undefined,
  };
}

export type TiktokReadReceipt = { conversationId: string; readUpToMs: number };

// im_mark_read_msg: TikTok avisa que el usuario leyo la conversacion. Si no trae marca de tiempo se asume "ahora".
export function parseTiktokReadReceipt(
  content: Record<string, any>,
  nowMs: number = Date.now(),
): TiktokReadReceipt | null {
  const conversationId = content?.conversation_id;
  if (!conversationId) return null;

  const ts = Number(content.read?.last_read_timestamp ?? content.timestamp);
  return { conversationId: `${conversationId}`, readUpToMs: Number.isFinite(ts) && ts > 0 ? ts : nowMs };
}

const JID_SUFFIX = '@tiktok';

export const tiktokJid = (conversationId: string) => `${conversationId}${JID_SUFFIX}`;

export const tiktokConversationId = (jid: string) =>
  jid.endsWith(JID_SUFFIX) ? jid.slice(0, -JID_SUFFIX.length) : jid;
