import { SendMediaDto, SendTextDto } from '@api/dto/sendMessage.dto';
import * as s3Service from '@api/integrations/storage/s3/libs/minio.server';
import { PrismaRepository } from '@api/repository/repository.service';
import { chatbotController } from '@api/server.module';
import { readAgentTags, withDefaultSource } from '@api/services/agent-tags';
import { CacheService } from '@api/services/cache.service';
import { ChannelStartupService } from '@api/services/channel.service';
import { attributeInboundMessage } from '@api/services/lead-attribution.service';
import { Events, wa } from '@api/types/wa.types';
import { ConfigService, S3 } from '@config/env.config';
import { BadRequestException } from '@exceptions';
import { Prisma } from '@prisma/client';
import { status } from '@utils/renderStatus';
import axios from 'axios';
import EventEmitter2 from 'eventemitter2';
import mimeTypes from 'mime-types';
import { join } from 'path';

import { TiktokApi, TiktokApiError } from './tiktok.api';
import {
  parseTiktokMessage,
  parseTiktokReadReceipt,
  TIKTOK_EVENT,
  tiktokConversationId,
  tiktokJid,
  TiktokParsedMessage,
} from './tiktok.events';
import { KeyedQueue } from './tiktok.queue';
import { getTiktokApi, getTiktokTokenService } from './tiktok.runtime';
import { TiktokReauthRequiredError, TiktokTokenService } from './tiktok.token.service';
import { assertWithinReplyWindow, TiktokWindowClosedError } from './tiktok.window';

// Los ecos (im_send_msg) llegan casi a la vez que la respuesta de la Send API: se espera un poco para que el
// mensaje enviado desde el CRM ya este guardado y el eco se descarte por message_id en vez de duplicarse.
const ECHO_DELAY_MS = 2000;

// Un solo orden de procesamiento por (canal, conversacion), compartido por todas las instancias.
const conversationQueue = new KeyedQueue();

// LYD-95: canal TikTok (Business Messaging API). La instancia se identifica por `number` = business_id
// (open_id) de la cuenta. Los tokens OAuth viven cifrados en TiktokChannel, no en `token` (ese es la apikey
// de la instancia). El contacto es la conversacion de TikTok: jid = `<conversation_id>@tiktok`.
export class TiktokStartupService extends ChannelStartupService {
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

  private get api(): TiktokApi {
    return getTiktokApi(this.configService);
  }

  private get tokens(): TiktokTokenService {
    return getTiktokTokenService(this.configService, this.prismaRepository);
  }

  // Un reintento de auth o un rechazo de TikTok se muestra al agente tal cual (ej. conversacion cerrada).
  private tiktokError(error: any): never {
    if (error instanceof TiktokReauthRequiredError || error instanceof TiktokWindowClosedError) {
      throw new BadRequestException(error.message);
    }
    const detail = error instanceof TiktokApiError ? error.message : (error?.message ?? String(error));
    this.logger.error(`TikTok API: ${detail}`);
    throw new BadRequestException(detail);
  }

  // Mismo criterio que los canales de Meta: el inbox lista Chat y el contador de no leidos cuenta entrantes en
  // DELIVERY_ACK (el CRM los pasa a READ al abrir la conversacion).
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

  // Un chat que llega por TikTok queda con la etiqueta fuente TikTok, salvo que ya tenga otra fuente.
  private async tagSource(remoteJid: string) {
    try {
      const chat = await this.prismaRepository.chat.findUnique({
        where: { instanceId_remoteJid: { instanceId: this.instanceId, remoteJid } },
        select: { id: true, agentTags: true },
      });
      if (!chat) return;

      const next = withDefaultSource(readAgentTags(chat.agentTags), 'TikTok');
      if (next) {
        await this.prismaRepository.chat.update({
          where: { id: chat.id },
          data: { agentTags: next as Prisma.InputJsonObject },
        });
      }
    } catch (error) {
      this.logger.error(`No se pudo fijar la fuente TikTok de ${remoteJid}: ${error}`);
    }
  }

  private async messageExists(id: string) {
    const found = await this.prismaRepository.message.findFirst({
      where: { instanceId: this.instanceId, key: { path: ['id'], equals: id } },
      select: { id: true },
    });
    return !!found;
  }

  // Marca de tiempo (ms) del ultimo mensaje entrante de la conversacion, base de la ventana de 48 h.
  public async lastInboundAt(remoteJid: string): Promise<number | null> {
    const rows: { ts: number | null }[] = await this.prismaRepository.$queryRaw`
      SELECT MAX("messageTimestamp")::int AS ts FROM "Message"
      WHERE "instanceId" = ${this.instanceId}
      AND "key"->>'remoteJid' = ${remoteJid}
      AND ("key"->>'fromMe')::boolean = false
    `;
    const seconds = rows[0]?.ts;
    return seconds ? seconds * 1000 : null;
  }

  // Punto de entrada desde TiktokController: `content` ya viene parseado y la instancia ya esta resuelta.
  public async connectToWhatsapp(payload?: { event: string; businessId: string; content: Record<string, any> }) {
    if (!payload) return;

    const { event, businessId, content } = payload;
    const conversationId = content?.conversation_id;
    if (!conversationId) return;

    return conversationQueue.run(`${businessId}:${conversationId}`, async () => {
      try {
        if (event === TIKTOK_EVENT.RECEIVE || event === TIKTOK_EVENT.SEND) {
          const message = parseTiktokMessage(content, businessId);
          if (!message) {
            this.logger.warn(`Evento ${event} sin direccion/ids validos para el canal ${businessId}, se ignora`);
            return;
          }
          if (message.fromMe) await new Promise((resolve) => setTimeout(resolve, ECHO_DELAY_MS));
          await this.handleMessage(message);
        } else if (event === TIKTOK_EVENT.MARK_READ) {
          await this.handleRead(content);
        }
      } catch (error) {
        this.logger.error(`Evento ${event} de TikTok fallido: ${error?.stack ?? error}`);
      }
    });
  }

  private buildContent(message: TiktokParsedMessage): { messageType: string; message: any } {
    const context = message.referencedMessageId ? { stanzaId: message.referencedMessageId } : undefined;

    switch (message.type) {
      case 'text':
        return context
          ? {
              messageType: 'extendedTextMessage',
              message: { extendedTextMessage: { text: message.text ?? '', contextInfo: context } },
            }
          : { messageType: 'conversation', message: { conversation: message.text ?? '' } };
      case 'image':
        return {
          messageType: 'imageMessage',
          message: {
            imageMessage: { mimetype: 'image/jpeg', ...(context ? { contextInfo: context } : {}) },
            tiktokMedia: { conversationId: message.conversationId, messageId: message.id, mediaId: message.mediaId },
          },
        };
      case 'share_post':
        return {
          messageType: 'conversation',
          message: { conversation: `[publicacion compartida]${message.embedUrl ? ` ${message.embedUrl}` : ''}` },
        };
      case 'sticker':
        return { messageType: 'conversation', message: { conversation: '[sticker]' } };
      default:
        return { messageType: 'conversation', message: { conversation: `[${message.type}]` } };
    }
  }

  private async handleMessage(message: TiktokParsedMessage) {
    // TikTok reintenta webhooks y devuelve como eco lo que enviamos por API (ya guardado al enviar).
    if (await this.messageExists(message.id)) return;

    const remoteJid = tiktokJid(message.conversationId);
    const { fromMe } = message;
    const built = this.buildContent(message);

    const messageRaw: any = {
      key: { id: message.id, remoteJid, fromMe },
      pushName: fromMe ? undefined : message.contactName,
      message: built.message,
      messageType: built.messageType,
      messageTimestamp: Math.round(message.timestampMs / 1000),
      source: 'unknown',
      instanceId: this.instanceId,
      // Entrantes: DELIVERY_ACK = "sin leer" para el CRM (ver markRead en crm.service).
      status: fromMe ? status[2] : status[3],
    };

    if (!fromMe) await this.upsertContact(remoteJid, message.contactName);
    const storedMedia = message.type === 'image' ? await this.attachImage(messageRaw, message) : undefined;

    this.sendDataWebhook(Events.MESSAGES_UPSERT, messageRaw);

    if (!fromMe) {
      await chatbotController.emit({
        instance: { instanceName: this.instance.name, instanceId: this.instanceId },
        remoteJid,
        msg: messageRaw,
        pushName: messageRaw.pushName,
      });
    }

    await this.saveMessage(messageRaw, storedMedia);
    await this.touchChat(remoteJid, messageRaw.pushName);
    if (!fromMe) {
      await attributeInboundMessage(this.prismaRepository, this.instanceId, remoteJid, {
        platform: 'tiktok',
        text: message.text,
      });
      await this.tagSource(remoteJid);
    }
  }

  // Guarda el Message; si la imagen se subio a S3 tambien crea su registro Media (igual que el canal Cloud API).
  private async saveMessage(messageRaw: any, media?: { fullName: string; mimetype: string }) {
    const created = await this.prismaRepository.message.create({ data: messageRaw });
    if (media) {
      await this.prismaRepository.media.create({
        data: {
          messageId: created.id,
          instanceId: this.instanceId,
          type: 'image',
          fileName: media.fullName,
          mimetype: media.mimetype,
        },
      });
    }
  }

  // Descarga la imagen entrante. Con S3 se sube y se guarda su URL; sin S3 (Brittany) va en base64 dentro del
  // mensaje, que es lo que ya hace el canal de Meta con lo que se envia. Si la descarga falla, el mensaje se guarda
  // igual y getBase64FromMediaMessage reintenta al abrirlo.
  private async attachImage(
    messageRaw: any,
    message: TiktokParsedMessage,
  ): Promise<{ fullName: string; mimetype: string } | undefined> {
    if (!message.mediaId) return;

    try {
      const { buffer, mimetype } = await this.downloadMedia(message.conversationId, message.id, message.mediaId);
      messageRaw.message.imageMessage.mimetype = mimetype;

      if (this.configService.get<S3>('S3').ENABLE) {
        const extension = mimeTypes.extension(mimetype) || 'jpg';
        const fullName = join(`${this.instanceId}`, messageRaw.key.remoteJid, 'image', `${message.id}.${extension}`);
        await s3Service.uploadFile(fullName, buffer, buffer.byteLength, { 'Content-Type': mimetype });
        messageRaw.message.mediaUrl = await s3Service.getObjectUrl(fullName);
        return { fullName, mimetype };
      } else {
        messageRaw.message.base64 = buffer.toString('base64');
      }
    } catch (error) {
      this.logger.warn(`No se pudo descargar la imagen ${message.mediaId}: ${error?.message ?? error}`);
    }
  }

  private async downloadMedia(conversationId: string, messageId: string, mediaId: string) {
    const { accessToken, businessId } = await this.tokens.getAccessToken(this.instanceId);
    return this.api.downloadImage(accessToken, { businessId, conversationId, messageId, mediaId });
  }

  private async upsertContact(remoteJid: string, name?: string) {
    const pushName = name?.slice(0, 100);
    const contact = await this.prismaRepository.contact.findFirst({
      where: { instanceId: this.instanceId, remoteJid },
    });

    if (contact) {
      if (pushName && contact.pushName !== pushName) {
        await this.prismaRepository.contact.updateMany({
          where: { remoteJid, instanceId: this.instanceId },
          data: { pushName },
        });
      }
      return;
    }

    const contactRaw = { remoteJid, pushName, instanceId: this.instanceId };
    this.sendDataWebhook(Events.CONTACTS_UPSERT, contactRaw);
    await this.prismaRepository.contact.create({ data: contactRaw });
  }

  // im_mark_read_msg: el usuario leyo la conversacion, asi que lo nuestro anterior a esa marca pasa a leido.
  private async handleRead(content: Record<string, any>) {
    const receipt = parseTiktokReadReceipt(content);
    if (!receipt) return;

    const remoteJid = tiktokJid(receipt.conversationId);
    const seconds = Math.round(receipt.readUpToMs / 1000);

    await this.prismaRepository.$executeRaw`
      UPDATE "Message"
      SET "status" = ${status[4]}
      WHERE "instanceId" = ${this.instanceId}
      AND "key"->>'remoteJid' = ${remoteJid}
      AND ("key"->>'fromMe')::boolean = true
      AND "messageTimestamp" <= ${seconds}
      AND "status" IN (${Prisma.join([status[1], status[2], status[3]])})
    `;
  }

  private async sendMessage(
    number: string,
    message: any,
    content: { text?: string; mediaId?: string },
    quotedId?: string,
  ) {
    const conversationId = tiktokConversationId(number);
    const remoteJid = tiktokJid(conversationId);

    let messageId: string;
    try {
      // Fuera de la ventana de 48 h no se llama a TikTok: seria rechazado igual.
      assertWithinReplyWindow(await this.lastInboundAt(remoteJid));

      const { accessToken, businessId } = await this.tokens.getAccessToken(this.instanceId);
      ({ messageId } = await this.api.sendMessage(accessToken, {
        businessId,
        conversationId,
        referencedMessageId: quotedId,
        ...content,
      }));
    } catch (error) {
      this.tiktokError(error);
    }

    const messageRaw: any = {
      key: { fromMe: true, id: messageId, remoteJid },
      message,
      messageType: Object.keys(message)[0],
      messageTimestamp: Math.round(Date.now() / 1000),
      instanceId: this.instanceId,
      status: status[1],
      source: 'unknown',
    };

    this.sendDataWebhook(Events.SEND_MESSAGE, messageRaw);

    // El eco del webhook puede ganarle a este insert: si ya lo guardo, no se duplica.
    if (!(await this.messageExists(messageId))) {
      await this.prismaRepository.message.create({ data: messageRaw });
    }
    await this.touchChat(remoteJid);

    return messageRaw;
  }

  public async textMessage(data: SendTextDto) {
    return this.sendMessage(data.number, { conversation: data.text }, { text: data.text }, data?.quoted?.key?.id);
  }

  public async mediaMessage(data: SendMediaDto, file?: any) {
    if (data.mediatype !== 'image') {
      throw new BadRequestException('TikTok solo permite enviar texto o una imagen');
    }

    const media = file ? file.buffer : data.media;
    let buffer: Buffer;
    let mimetype = data.mimetype;
    if (Buffer.isBuffer(media)) {
      buffer = media;
    } else if (/^https?:\/\//i.test(media)) {
      const response = await axios.get(media, { responseType: 'arraybuffer' });
      buffer = Buffer.from(response.data);
      mimetype = mimetype ?? response.headers['content-type'];
    } else {
      buffer = Buffer.from(media.replace(/^data:[^;]+;base64,/, ''), 'base64');
    }
    mimetype = mimetype ?? (mimeTypes.lookup(data.fileName ?? '') || 'image/jpeg');
    const fileName = data.fileName ?? `image.${mimeTypes.extension(mimetype) || 'jpg'}`;

    // La ventana se valida antes de subir la imagen para no gastar una subida que no se va a poder enviar.
    try {
      assertWithinReplyWindow(await this.lastInboundAt(tiktokJid(tiktokConversationId(data.number))));
    } catch (error) {
      this.tiktokError(error);
    }

    let mediaId: string;
    try {
      const { accessToken, businessId } = await this.tokens.getAccessToken(this.instanceId);
      mediaId = await this.api.uploadImage(accessToken, businessId, buffer, fileName, mimetype);
    } catch (error) {
      this.tiktokError(error);
    }

    const sent = await this.sendMessage(
      data.number,
      { imageMessage: { mimetype, fileName }, base64: buffer.toString('base64') },
      { mediaId },
      data.quoted?.key?.id,
    );

    // TikTok no admite texto junto a la imagen: el pie de foto va como mensaje de texto aparte.
    if (data.caption) await this.textMessage({ number: data.number, text: data.caption } as SendTextDto);

    return sent;
  }

  public async audioWhatsapp(): Promise<any> {
    throw new BadRequestException('TikTok solo permite enviar texto o una imagen');
  }

  // La imagen entrante ya viene en base64 dentro del mensaje (o en S3); si la descarga inicial fallo se reintenta aca.
  public async getBase64FromMediaMessage(data: any) {
    try {
      const msg = data.message;
      const messageType = msg.messageType.includes('Message') ? msg.messageType : msg.messageType + 'Message';
      const mediaMessage = msg.message[messageType];

      let mimetype = mediaMessage?.mimetype;
      let base64 = msg.message?.base64;

      if (!base64 && msg.message?.mediaUrl) {
        const response = await axios.get(msg.message.mediaUrl, { responseType: 'arraybuffer' });
        base64 = Buffer.from(response.data).toString('base64');
        mimetype = mimetype ?? response.headers['content-type'];
      }

      if (!base64 && msg.message?.tiktokMedia?.mediaId) {
        const { conversationId, messageId, mediaId } = msg.message.tiktokMedia;
        const downloaded = await this.downloadMedia(conversationId, messageId, mediaId);
        base64 = downloaded.buffer.toString('base64');
        mimetype = downloaded.mimetype;
      }

      if (!base64) throw new Error('El mensaje no tiene imagen disponible');

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
    return { wuid: number, profilePictureUrl: null };
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
