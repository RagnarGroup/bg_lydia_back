import { SendAudioDto, SendMediaDto, SendTextDto } from '@api/dto/sendMessage.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import { chatbotController } from '@api/server.module';
import { CacheService } from '@api/services/cache.service';
import { ChannelStartupService } from '@api/services/channel.service';
import { attributeInboundMessage } from '@api/services/lead-attribution.service';
import { messageText, socialReferralAttribution } from '@api/services/lead-attribution.util';
import { Events, Integration, wa } from '@api/types/wa.types';
import { ConfigService, WaBusiness } from '@config/env.config';
import { BadRequestException } from '@exceptions';
import { Prisma } from '@prisma/client';
import { status } from '@utils/renderStatus';
import { sendTelemetry } from '@utils/sendTelemetry';
import axios from 'axios';
import EventEmitter2 from 'eventemitter2';
import FormData from 'form-data';
import mimeTypes from 'mime-types';

type SocialMediaType = 'image' | 'video' | 'audio' | 'file';

// LYD-26: canal para Facebook Messenger e Instagram DM (Messenger Platform / Instagram Messaging API de Meta).
// Un mismo servicio para los dos porque el webhook (entry[].messaging[]) y la Send API (POST /{id}/messages)
// tienen la misma forma. La instancia se identifica por `number` = id de la Pagina (Messenger) o de la cuenta
// profesional de Instagram, y `token` = access token de la Pagina. El contacto no tiene telefono: se usa el id
// de usuario de Meta (PSID / IGSID) como jid, con sufijo `@messenger` / `@instagram` para no chocar con WhatsApp.
export class MetaSocialStartupService extends ChannelStartupService {
  constructor(
    public readonly configService: ConfigService,
    public readonly eventEmitter: EventEmitter2,
    public readonly prismaRepository: PrismaRepository,
    public readonly cache: CacheService,
    public readonly chatwootCache: CacheService,
  ) {
    super(configService, eventEmitter, prismaRepository, chatwootCache);
  }

  public stateConnection: wa.StateConnection = { state: 'open' };

  public get connectionStatus() {
    return this.stateConnection;
  }

  public async closeClient() {
    this.stateConnection = { state: 'close' };
  }

  public get qrCode(): wa.QrCode {
    return {
      pairingCode: this.instance.qrcode?.pairingCode,
      code: this.instance.qrcode?.code,
      base64: this.instance.qrcode?.base64,
      count: this.instance.qrcode?.count,
    };
  }

  public async logoutInstance() {
    await this.closeClient();
  }

  private get isInstagram() {
    return this.integration === Integration.INSTAGRAM;
  }

  private get jidSuffix() {
    return this.isInstagram ? '@instagram' : '@messenger';
  }

  private toJid(userId: string) {
    return `${userId}${this.jidSuffix}`;
  }

  private toUserId(number: string) {
    return number.split('@')[0];
  }

  private graphUrl(path: string) {
    const { URL, VERSION } = this.configService.get<WaBusiness>('WA_BUSINESS');
    return `${URL}/${VERSION}/${path}`;
  }

  private get authHeaders() {
    return { Authorization: `Bearer ${this.token}` };
  }

  // Meta responde 4xx con `error.message`; se propaga tal cual para que el CRM lo muestre al agente
  // (ej. fuera de la ventana de 24 h no se puede responder).
  private metaError(error: any): never {
    const detail = error?.response?.data?.error?.message ?? error?.message ?? String(error);
    this.logger.error(`Meta Send API: ${detail}`);
    throw new BadRequestException(detail);
  }

  // Igual que el canal Cloud API: el inbox del CRM lista la tabla Chat y el contador de no leidos se recalcula
  // contando entrantes en DELIVERY_ACK (el CRM los pasa a READ al abrir la conversacion).
  private async touchChat(remoteJid: string, name?: string) {
    try {
      const unread: { count: number }[] = await this.prismaRepository.$queryRaw`
        SELECT COUNT(*)::int AS count FROM "Message"
        WHERE "instanceId" = ${this.instanceId}
        AND "key"->>'remoteJid' = ${remoteJid}
        AND ("key"->>'fromMe')::boolean = false
        AND "status" = ${status[3]}
      `;
      const unreadMessages = unread[0]?.count ?? 0;
      const chatName = name?.slice(0, 100);

      await this.prismaRepository.chat.upsert({
        where: { instanceId_remoteJid: { instanceId: this.instanceId, remoteJid } },
        create: { remoteJid, instanceId: this.instanceId, name: chatName, unreadMessages },
        update: { unreadMessages, ...(chatName ? { name: chatName } : {}) },
      });
    } catch (error) {
      this.logger.error(`No se pudo actualizar el Chat de ${remoteJid}: ${error}`);
    }
  }

  // Nombre y foto del usuario (User Profile API / Instagram user profile). Es best-effort: sin el permiso o
  // fuera de la ventana de mensajeria Meta responde error y el contacto queda sin nombre.
  private async fetchUserProfile(userId: string): Promise<{ name?: string; profilePicUrl?: string }> {
    try {
      const fields = this.isInstagram ? 'name,username,profile_pic' : 'name,profile_pic';
      const { data } = await axios.get(this.graphUrl(userId), {
        headers: this.authHeaders,
        params: { fields },
      });
      return { name: data.name ?? data.username, profilePicUrl: data.profile_pic };
    } catch (error) {
      this.logger.warn(`No se pudo leer el perfil de ${userId}: ${error?.response?.data?.error?.message ?? error}`);
      return {};
    }
  }

  // El `entry` del webhook llega sin procesar desde MetaController (ya enrutado por id de Pagina/cuenta).
  public async connectToWhatsapp(entry?: any): Promise<any> {
    if (!entry) return;

    this.loadChatwoot();

    for (const event of entry.messaging ?? []) {
      try {
        await this.handleMessagingEvent(event);
      } catch (error) {
        this.logger.error(`Evento de mensajeria fallido: ${error}`);
      }
    }
  }

  // LYD-96: `referral` de un anuncio puede llegar suelto (hilo ya abierto), dentro de un postback (boton
  // "Empezar") o dentro del propio message. Se guarda el origen del lead en el Chat; el mensaje, si lo hay,
  // sigue su curso normal.
  private async handleReferral(event: any) {
    if (event.message?.is_echo || !event.sender?.id) return;
    const referral = event.referral ?? event.postback?.referral ?? event.message?.referral;
    const attribution = socialReferralAttribution(referral, this.isInstagram ? 'instagram' : 'messenger');
    if (!attribution) return;

    await attributeInboundMessage(this.prismaRepository, this.instanceId, this.toJid(`${event.sender.id}`), {
      platform: attribution.platform,
      referral: attribution,
    });
  }

  private async handleMessagingEvent(event: any) {
    await this.handleReferral(event);

    if (event.message) return this.handleMessage(event);
    if (event.read || event.delivery) return this.handleReceipt(event);

    // postbacks, reacciones, etc.: sin soporte todavia (los referrals ya se leyeron arriba).
    this.logger.log(`Evento de mensajeria ignorado (${Object.keys(event).join(',')})`);
  }

  private attachmentToMessage(attachment: any) {
    const url = attachment?.payload?.url;

    switch (attachment?.type) {
      case 'image':
        return { messageType: 'imageMessage', message: { imageMessage: { url } } };
      case 'video':
        return { messageType: 'videoMessage', message: { videoMessage: { url } } };
      case 'audio':
        return { messageType: 'audioMessage', message: { audioMessage: { url } } };
      case 'file':
        return { messageType: 'documentMessage', message: { documentMessage: { url } } };
      default:
        // share, story_mention, reel, location, fallback...: se muestran como texto para no perderlos.
        return {
          messageType: 'conversation',
          message: { conversation: `[${attachment?.type ?? 'adjunto'}]${url ? ` ${url}` : ''}` },
        };
    }
  }

  private async handleMessage(event: any) {
    const msg = event.message;
    // Los ecos son los mensajes que la propia Pagina/cuenta envio (por API o desde su bandeja de Meta).
    const fromMe = !!msg.is_echo;
    const contactId = `${fromMe ? event.recipient?.id : event.sender?.id}`;

    if (!contactId || contactId === 'undefined') {
      this.logger.warn('Evento de mensajeria sin id de contacto, se ignora');
      return;
    }

    const remoteJid = this.toJid(contactId);
    // `timestamp` de Meta viene en milisegundos.
    const messageTimestamp = Math.round((event.timestamp ?? Date.now()) / 1000);

    const parts: { id: string; messageType: string; message: any }[] = [];
    if (msg.text) parts.push({ id: msg.mid, messageType: 'conversation', message: { conversation: msg.text } });
    (msg.attachments ?? []).forEach((attachment: any) => {
      // El primer fragmento conserva el mid de Meta; los demas (varios adjuntos por evento) lo sufijan.
      const id = parts.length ? `${msg.mid}:${parts.length}` : msg.mid;
      parts.push({ id, ...this.attachmentToMessage(attachment) });
    });
    if (msg.is_deleted)
      parts.push({ id: msg.mid, messageType: 'conversation', message: { conversation: '[mensaje eliminado]' } });

    if (!parts.length) {
      this.logger.log(`Mensaje ${msg.mid} sin contenido soportado, se ignora`);
      return;
    }

    let pushName: string | undefined;
    if (!fromMe) {
      pushName = await this.upsertContact(remoteJid, contactId);
    }

    for (const part of parts) {
      // Meta reintenta webhooks y devuelve como eco lo que enviamos por API (ya guardado al enviar).
      if (await this.messageExists(part.id)) continue;

      const messageRaw: any = {
        key: { id: part.id, remoteJid, fromMe },
        pushName,
        message: part.message,
        messageType: part.messageType,
        messageTimestamp,
        source: 'unknown',
        instanceId: this.instanceId,
        // Entrantes: DELIVERY_ACK = "sin leer" para el CRM (ver markRead en crm.service).
        status: fromMe ? status[2] : status[3],
      };

      sendTelemetry(`received.message.${messageRaw.messageType}`);

      this.sendDataWebhook(Events.MESSAGES_UPSERT, messageRaw);

      if (!fromMe) {
        await chatbotController.emit({
          instance: { instanceName: this.instance.name, instanceId: this.instanceId },
          remoteJid,
          msg: messageRaw,
          pushName,
        });
      }

      await this.prismaRepository.message.create({ data: messageRaw });
    }

    await this.touchChat(remoteJid, pushName);

    // LYD-96: codigo [TT-...] en el primer mensaje entrante (el referral de anuncios ya se guardo antes).
    if (!fromMe) {
      await attributeInboundMessage(this.prismaRepository, this.instanceId, remoteJid, {
        platform: this.isInstagram ? 'instagram' : 'messenger',
        text: messageText(parts[0]?.message),
      });
    }
  }

  private async messageExists(id: string) {
    const found = await this.prismaRepository.message.findFirst({
      where: { instanceId: this.instanceId, key: { path: ['id'], equals: id } },
      select: { id: true },
    });
    return !!found;
  }

  // Crea el contacto la primera vez que escribe (con nombre/foto si Meta los da) y devuelve su nombre.
  private async upsertContact(remoteJid: string, userId: string): Promise<string | undefined> {
    const contact = await this.prismaRepository.contact.findFirst({
      where: { instanceId: this.instanceId, remoteJid },
    });
    if (contact?.pushName) return contact.pushName;

    const profile = await this.fetchUserProfile(userId);
    const contactRaw = {
      remoteJid,
      pushName: profile.name?.slice(0, 100),
      profilePicUrl: profile.profilePicUrl?.slice(0, 500),
      instanceId: this.instanceId,
    };

    if (contact) {
      if (contactRaw.pushName || contactRaw.profilePicUrl) {
        this.sendDataWebhook(Events.CONTACTS_UPDATE, contactRaw);
        await this.prismaRepository.contact.updateMany({
          where: { remoteJid, instanceId: this.instanceId },
          data: contactRaw,
        });
      }
    } else {
      this.sendDataWebhook(Events.CONTACTS_UPSERT, contactRaw);
      await this.prismaRepository.contact.create({ data: contactRaw });
    }

    return contactRaw.pushName;
  }

  // `read`/`delivery`: el usuario vio o recibio nuestros mensajes. Messenger manda `watermark` (ms, todo lo
  // anterior); Instagram manda el `mid` del mensaje leido.
  private async handleReceipt(event: any) {
    const contactId = event.sender?.id;
    if (!contactId) return;

    const remoteJid = this.toJid(contactId);
    const receipt = event.read ?? event.delivery;
    const newStatus = event.read ? status[4] : status[3];
    // No degradar: un DELIVERY_ACK tardio no debe pisar un READ.
    const replaces = event.read ? [status[1], status[2], status[3]] : [status[1], status[2]];

    if (receipt.watermark) {
      const seconds = Math.round(receipt.watermark / 1000);
      await this.prismaRepository.$executeRaw`
        UPDATE "Message"
        SET "status" = ${newStatus}
        WHERE "instanceId" = ${this.instanceId}
        AND "key"->>'remoteJid' = ${remoteJid}
        AND ("key"->>'fromMe')::boolean = true
        AND "messageTimestamp" <= ${seconds}
        AND "status" IN (${Prisma.join(replaces)})
      `;
      return;
    }

    const mids: string[] = receipt.mids ?? (receipt.mid ? [receipt.mid] : []);
    for (const mid of mids) {
      await this.prismaRepository.$executeRaw`
        UPDATE "Message"
        SET "status" = ${newStatus}
        WHERE "instanceId" = ${this.instanceId}
        AND "key"->>'id' = ${mid}
        AND "status" IN (${Prisma.join(replaces)})
      `;
    }
  }

  private async sendMessage(number: string, message: any, content: any, quotedId?: string) {
    const recipientId = this.toUserId(number);
    const payload: any = { recipient: { id: recipientId }, message: content };
    // Messenger exige messaging_type; con Instagram no aplica.
    if (!this.isInstagram) payload.messaging_type = 'RESPONSE';
    if (quotedId) payload.message.reply_to = { mid: quotedId };

    let sent: any;
    try {
      ({ data: sent } = await axios.post(this.graphUrl(`${this.number}/messages`), payload, {
        headers: { 'Content-Type': 'application/json', ...this.authHeaders },
      }));
    } catch (error) {
      this.metaError(error);
    }

    const messageRaw: any = {
      key: { fromMe: true, id: sent.message_id, remoteJid: this.toJid(recipientId) },
      message,
      messageType: Object.keys(message)[0],
      messageTimestamp: Math.round(Date.now() / 1000),
      instanceId: this.instanceId,
      status: status[1],
      source: 'unknown',
    };

    this.sendDataWebhook(Events.SEND_MESSAGE, messageRaw);

    // El eco del webhook puede ganarle a este insert: si ya lo guardo, no se duplica.
    if (!(await this.messageExists(sent.message_id))) {
      await this.prismaRepository.message.create({ data: messageRaw });
    }
    await this.touchChat(messageRaw.key.remoteJid);

    return messageRaw;
  }

  public async textMessage(data: SendTextDto) {
    return this.sendMessage(data.number, { conversation: data.text }, { text: data.text }, data?.quoted?.key?.id);
  }

  private socialMediaType(mediatype: string): SocialMediaType {
    if (mediatype === 'document') return 'file';
    if (mediatype === 'image' || mediatype === 'video' || mediatype === 'audio') return mediatype;
    throw new BadRequestException(`Tipo de media no soportado: ${mediatype}`);
  }

  private isPublicUrl(value: string) {
    return /^https?:\/\//i.test(value);
  }

  // Messenger acepta el archivo subido (Attachment Upload API, devuelve attachment_id); Instagram solo acepta
  // una URL publica, no tiene API de subida.
  private async uploadAttachment(type: SocialMediaType, base64: string, mimetype: string, fileName: string) {
    if (this.isInstagram) {
      throw new BadRequestException(
        'Instagram solo permite enviar adjuntos como URL publica (no soporta subir archivos)',
      );
    }

    const form = new FormData();
    form.append('message', JSON.stringify({ attachment: { type, payload: { is_reusable: true } } }));
    form.append('filedata', Buffer.from(base64, 'base64'), { filename: fileName, contentType: mimetype });

    try {
      const { data } = await axios.post(this.graphUrl(`${this.number}/message_attachments`), form, {
        headers: { ...form.getHeaders(), ...this.authHeaders },
        maxBodyLength: Infinity,
      });
      return data.attachment_id as string;
    } catch (error) {
      this.metaError(error);
    }
  }

  private async sendAttachment(
    number: string,
    mediatype: string,
    media: string,
    options: { mimetype?: string; fileName?: string; caption?: string; quoted?: any },
  ) {
    const type = this.socialMediaType(mediatype);
    const mimetype = options.mimetype ?? (mimeTypes.lookup(options.fileName ?? '') || 'application/octet-stream');
    const fileName = options.fileName ?? `${type}.${mimeTypes.extension(mimetype) || 'bin'}`;

    let payload: any;
    let storedMedia: any;
    if (this.isPublicUrl(media)) {
      payload = { url: media, is_reusable: true };
      storedMedia = { url: media };
    } else {
      const base64 = media.replace(/^data:[^;]+;base64,/, '');
      payload = { attachment_id: await this.uploadAttachment(type, base64, mimetype, fileName) };
      // Sin URL propia que servir despues: se guarda el archivo para poder mostrarlo en el CRM.
      storedMedia = { base64 };
    }

    // El base64 va al nivel del mensaje (getBase64FromMediaMessage lo busca ahi); el pie de foto se manda
    // aparte como texto porque Meta no lo admite en adjuntos, asi que no se guarda dentro del adjunto.
    const key = type === 'file' ? 'documentMessage' : `${type}Message`;
    const message = { [key]: { url: storedMedia.url, mimetype, fileName }, base64: storedMedia.base64 };

    const sent = await this.sendMessage(number, message, { attachment: { type, payload } }, options.quoted?.key?.id);

    // Meta no admite pie de foto en adjuntos: el caption va como mensaje de texto aparte.
    if (options.caption) await this.textMessage({ number, text: options.caption } as SendTextDto);

    return sent;
  }

  public async mediaMessage(data: SendMediaDto, file?: any) {
    const media = file ? file.buffer.toString('base64') : data.media;
    return this.sendAttachment(data.number, data.mediatype, media, {
      mimetype: data.mimetype,
      fileName: data.fileName,
      caption: data.caption,
      quoted: data.quoted,
    });
  }

  public async audioWhatsapp(data: SendAudioDto, file?: any) {
    const audio = file ? file.buffer.toString('base64') : data.audio;
    return this.sendAttachment(data.number, 'audio', audio, { mimetype: 'audio/mpeg', quoted: data.quoted });
  }

  // Los adjuntos entrantes traen una URL de la CDN de Meta; se baja al pedirlos (el front pide el base64).
  public async getBase64FromMediaMessage(data: any) {
    try {
      const msg = data.message;
      const messageType = msg.messageType.includes('Message') ? msg.messageType : msg.messageType + 'Message';
      const mediaMessage = msg.message[messageType];

      let mimetype = mediaMessage?.mimetype;
      let base64 = msg.message?.base64;

      if (!base64) {
        if (!mediaMessage?.url) throw new Error('El mensaje no tiene URL de adjunto');
        const response = await axios.get(mediaMessage.url, { responseType: 'arraybuffer' });
        base64 = Buffer.from(response.data).toString('base64');
        mimetype = mimetype ?? response.headers['content-type'];
      }

      return {
        mediaType: msg.messageType,
        fileName: mediaMessage?.fileName,
        caption: mediaMessage?.caption,
        size: { fileLength: mediaMessage?.fileLength, height: mediaMessage?.height, width: mediaMessage?.width },
        mimetype,
        base64,
      };
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  public async profilePicture(number: string) {
    const profile = await this.fetchUserProfile(this.toUserId(number));
    return { wuid: number, profilePictureUrl: profile.profilePicUrl ?? null };
  }

  public async getProfileName() {
    return null;
  }

  public async profilePictureUrl() {
    return null;
  }

  public async getProfileStatus() {
    return null;
  }
}
