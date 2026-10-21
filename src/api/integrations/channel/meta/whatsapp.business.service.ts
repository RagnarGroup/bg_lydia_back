import { NumberBusiness } from '@api/dto/chat.dto';
import {
  ContactMessage,
  MediaMessage,
  Options,
  SendAudioDto,
  SendButtonsDto,
  SendContactDto,
  SendListDto,
  SendLocationDto,
  SendMediaDto,
  SendReactionDto,
  SendTemplateDto,
  SendTextDto,
} from '@api/dto/sendMessage.dto';
import * as s3Service from '@api/integrations/storage/s3/libs/minio.server';
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { botService, chatbotController } from '@api/server.module';
import { CacheService } from '@api/services/cache.service';
import { ChannelStartupService } from '@api/services/channel.service';
import { attributeInboundMessage } from '@api/services/lead-attribution.service';
import { messageText, whatsappReferralAttribution } from '@api/services/lead-attribution.util';
import { Events, wa } from '@api/types/wa.types';
import { AudioConverter, Chatwoot, ConfigService, Database, Openai, S3, WaBusiness } from '@config/env.config';
import { BadRequestException, InternalServerErrorException } from '@exceptions';
import { createJid, extractBsuid } from '@utils/createJid';
import { status } from '@utils/renderStatus';
import { sendTelemetry } from '@utils/sendTelemetry';
import axios from 'axios';
import { arrayUnique, isURL } from 'class-validator';
import EventEmitter2 from 'eventemitter2';
import FormData from 'form-data';
import mimeTypes from 'mime-types';
import { join } from 'path';

export class BusinessStartupService extends ChannelStartupService {
  constructor(
    public readonly configService: ConfigService,
    public readonly eventEmitter: EventEmitter2,
    public readonly prismaRepository: PrismaRepository,
    public readonly cache: CacheService,
    public readonly chatwootCache: CacheService,
    public readonly baileysCache: CacheService,
    private readonly providerFiles: ProviderFiles,
  ) {
    super(configService, eventEmitter, prismaRepository, chatwootCache);
  }

  public stateConnection: wa.StateConnection = { state: 'open' };

  public phoneNumber: string;
  public mobile: boolean;

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

  private isMediaMessage(message: any) {
    return message.document || message.image || message.audio || message.video;
  }

  private async post(message: any, params: string) {
    try {
      let urlServer = this.configService.get<WaBusiness>('WA_BUSINESS').URL;
      const version = this.configService.get<WaBusiness>('WA_BUSINESS').VERSION;
      urlServer = `${urlServer}/${version}/${this.number}/${params}`;
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` };
      const result = await axios.post(urlServer, message, { headers, timeout: 30000 });
      return result.data;
    } catch (e) {
      // Meta responde { error: {...} }; ante un corte de red, timeout o un 5xx sin
      // ese cuerpo no hay e.response.data.error, y devolver undefined escondia el fallo real.
      const metaError = e.response?.data?.error;
      if (metaError) {
        this.logger.error(`Meta API error en ${params}: ${JSON.stringify(metaError)}`);
        return metaError;
      }
      const detail = {
        message: e.message || 'Error desconocido al llamar a la API de Meta',
        code: e.code,
        status: e.response?.status,
      };
      this.logger.error(`Fallo la llamada a Meta API en ${params}: ${JSON.stringify(detail)}`);
      return { ...detail, error_data: detail };
    }
  }

  public async profilePicture(number: string) {
    const jid = createJid(number);

    return {
      wuid: jid,
      profilePictureUrl: null,
    };
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

  public async setWhatsappBusinessProfile(data: NumberBusiness): Promise<any> {
    const content = {
      messaging_product: 'whatsapp',
      about: data.about,
      address: data.address,
      description: data.description,
      vertical: data.vertical,
      email: data.email,
      websites: data.websites,
      profile_picture_handle: data.profilehandle,
    };
    return await this.post(content, 'whatsapp_business_profile');
  }

  // Contacto de un webhook. Meta omite el telefono (`from`, `recipient_id`) cuando el usuario tiene
  // username y solo manda el BSUID (`from_user_id`, `recipient_user_id`, `contacts[].user_id`).
  private resolveRemoteJid(content: any): string | undefined {
    const message = content.messages?.[0];
    const status = content.statuses?.[0];

    const id = message ? (message.from ?? message.from_user_id) : (status?.recipient_id ?? status?.recipient_user_id);

    const contactId = id ?? content.contacts?.[0]?.wa_id ?? content.contacts?.[0]?.user_id;

    return contactId ? createJid(contactId) : undefined;
  }

  // Meta acepta `to` (telefono) o `recipient` (BSUID) segun lo que se conozca del contacto.
  private recipientField(number: string): { to: string } | { recipient: string } {
    const bsuid = extractBsuid(number);

    return bsuid ? { recipient: bsuid } : { to: number.replace(/\D/g, '') };
  }

  // El inbox del CRM (/crm/conversations) lista la tabla Chat, que solo creaban Baileys y el canal Evolution:
  // sin esto las conversaciones de Cloud API no aparecian (LYD-28). El contador de no leidos se recalcula como
  // en Baileys: entrantes en DELIVERY_ACK (el CRM los pasa a READ al abrir la conversacion).
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

  public async connectToWhatsapp(data?: any): Promise<any> {
    if (!data) return;

    const content = data.entry[0].changes[0].value;

    try {
      this.loadChatwoot();

      const remoteJid = this.resolveRemoteJid(content);

      if (!remoteJid) {
        this.logger.warn('Webhook de Meta sin identificador de contacto (ni telefono ni BSUID), se ignora');
        return;
      }

      // El contacto viaja como parametro: el campo de instancia lo pisaria otro webhook concurrente
      // (o quedaria con el valor del evento anterior si este no trae contacto).
      this.phoneNumber = remoteJid;

      this.eventHandler(content, remoteJid);
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(error?.toString());
    }
  }

  private async downloadMediaMessage(message: any) {
    try {
      const id = message[message.type].id;
      let urlServer = this.configService.get<WaBusiness>('WA_BUSINESS').URL;
      const version = this.configService.get<WaBusiness>('WA_BUSINESS').VERSION;
      urlServer = `${urlServer}/${version}/${id}`;
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` };

      // Primeiro, obtenha a URL do arquivo
      let result = await axios.get(urlServer, { headers });

      // Depois, baixe o arquivo usando a URL retornada
      result = await axios.get(result.data.url, {
        headers: { Authorization: `Bearer ${this.token}` }, // Use apenas o token de autorização para download
        responseType: 'arraybuffer',
      });

      return result.data;
    } catch (e) {
      this.logger.error(`Error downloading media: ${e}`);
      throw e;
    }
  }

  private messageMediaJson(received: any) {
    const message = received.messages[0];
    let content: any = message.type + 'Message';
    content = { [content]: message[message.type] };
    if (message.context) {
      content = { ...content, contextInfo: { stanzaId: message.context.id } };
    }
    return content;
  }

  private messageAudioJson(received: any) {
    const message = received.messages[0];
    let content: any = {
      audioMessage: {
        ...message.audio,
        ptt: message.audio.voice || false, // Define se é mensagem de voz
      },
    };
    if (message.context) {
      content = { ...content, contextInfo: { stanzaId: message.context.id } };
    }
    return content;
  }

  private messageInteractiveJson(received: any) {
    const message = received.messages[0];
    let content: any = { conversation: message.interactive[message.interactive.type].title };
    message.context ? (content = { ...content, contextInfo: { stanzaId: message.context.id } }) : content;
    return content;
  }

  private messageButtonJson(received: any) {
    const message = received.messages[0];
    let content: any = { conversation: received.messages[0].button?.text };
    message.context ? (content = { ...content, contextInfo: { stanzaId: message.context.id } }) : content;
    return content;
  }

  private messageReactionJson(received: any) {
    const message = received.messages[0];
    let content: any = {
      reactionMessage: {
        key: {
          id: message.reaction.message_id,
        },
        text: message.reaction.emoji,
      },
    };
    message.context ? (content = { ...content, contextInfo: { stanzaId: message.context.id } }) : content;
    return content;
  }

  private messageTextJson(received: any) {
    // Verificar que received y received.messages existen
    if (!received || !received.messages || received.messages.length === 0) {
      this.logger.error('Error: received object or messages array is undefined or empty');
      return null;
    }

    const message = received.messages[0];
    let content: any;

    // Verificar si es un mensaje de tipo sticker, location u otro tipo que no tiene text
    if (!message.text) {
      // Si no hay texto, manejamos diferente según el tipo de mensaje
      if (message.type === 'sticker') {
        content = { stickerMessage: {} };
      } else if (message.type === 'location') {
        content = {
          locationMessage: {
            degreesLatitude: message.location?.latitude,
            degreesLongitude: message.location?.longitude,
            name: message.location?.name,
            address: message.location?.address,
          },
        };
      } else {
        // Para otros tipos de mensajes sin texto, creamos un contenido genérico
        this.logger.log(`Mensaje de tipo ${message.type} sin campo text`);
        content = { [message.type + 'Message']: message[message.type] || {} };
      }

      // Añadir contexto si existe
      if (message.context) {
        content = { ...content, contextInfo: { stanzaId: message.context.id } };
      }

      return content;
    }

    // Si el mensaje tiene texto, procesamos normalmente
    if (!received.metadata || !received.metadata.phone_number_id) {
      this.logger.error('Error: metadata or phone_number_id is undefined');
      return null;
    }

    if (message.from === received.metadata.phone_number_id) {
      content = {
        extendedTextMessage: { text: message.text.body },
      };
      if (message.context) {
        content = { ...content, contextInfo: { stanzaId: message.context.id } };
      }
    } else {
      content = { conversation: message.text.body };
      if (message.context) {
        content = { ...content, contextInfo: { stanzaId: message.context.id } };
      }
    }

    return content;
  }

  private messageLocationJson(received: any) {
    const message = received.messages[0];
    let content: any = {
      locationMessage: {
        degreesLatitude: message.location.latitude,
        degreesLongitude: message.location.longitude,
        name: message.location?.name,
        address: message.location?.address,
      },
    };
    message.context ? (content = { ...content, contextInfo: { stanzaId: message.context.id } }) : content;
    return content;
  }

  private messageContactsJson(received: any) {
    const message = received.messages[0];
    let content: any = {};

    const vcard = (contact: any) => {
      let result =
        'BEGIN:VCARD\n' +
        'VERSION:3.0\n' +
        `N:${contact.name.formatted_name}\n` +
        `FN:${contact.name.formatted_name}\n`;

      if (contact.org) {
        result += `ORG:${contact.org.company};\n`;
      }

      if (contact.emails) {
        result += `EMAIL:${contact.emails[0].email}\n`;
      }

      if (contact.urls) {
        result += `URL:${contact.urls[0].url}\n`;
      }

      if (!contact.phones[0]?.wa_id) {
        contact.phones[0].wa_id = createJid(contact.phones[0].phone);
      }

      result +=
        `item1.TEL;waid=${contact.phones[0]?.wa_id}:${contact.phones[0].phone}\n` +
        'item1.X-ABLabel:Celular\n' +
        'END:VCARD';

      return result;
    };

    if (message.contacts.length === 1) {
      content.contactMessage = {
        displayName: message.contacts[0].name.formatted_name,
        vcard: vcard(message.contacts[0]),
      };
    } else {
      content.contactsArrayMessage = {
        displayName: `${message.length} contacts`,
        contacts: message.map((contact) => {
          return {
            displayName: contact.name.formatted_name,
            vcard: vcard(contact),
          };
        }),
      };
    }
    message.context ? (content = { ...content, contextInfo: { stanzaId: message.context.id } }) : content;
    return content;
  }

  private renderMessageType(type: string) {
    let messageType: string;

    switch (type) {
      case 'text':
        messageType = 'conversation';
        break;
      case 'image':
        messageType = 'imageMessage';
        break;
      case 'video':
        messageType = 'videoMessage';
        break;
      case 'audio':
        messageType = 'audioMessage';
        break;
      case 'document':
        messageType = 'documentMessage';
        break;
      case 'template':
        messageType = 'conversation';
        break;
      case 'location':
        messageType = 'locationMessage';
        break;
      case 'sticker':
        messageType = 'stickerMessage';
        break;
      default:
        messageType = 'conversation';
        break;
    }

    return messageType;
  }

  protected async messageHandle(received: any, database: Database, settings: any, remoteJid?: string) {
    try {
      let messageRaw: any;
      // LYD-53: el branch de S3 (mas abajo) es el UNICO lugar que hoy graba
      // el Message de un adjunto entrante -- sin S3 configurado (como en
      // Brittany), un audio/imagen/video/documento/sticker que manda un
      // cliente nunca llegaba a la base, y por eso nunca aparecia en el
      // inbox (ni con error: directamente no existia el registro). Este
      // flag asegura que se cree igual mas abajo cuando el branch de S3 no
      // corrio (o no tenia media valida).
      let mediaMessageCreated = false;

      // Los contactos de estados y los usuarios con username pueden venir sin `profile` o sin `name`.
      const profile = received.contacts?.[0]?.profile;
      const pushName: any = profile?.name ?? profile?.username;

      if (received.messages) {
        const message = received.messages[0]; // Añadir esta línea para definir message

        const key = {
          id: message.id,
          remoteJid,
          fromMe: message.from === received.metadata.phone_number_id,
        };

        if (message.type === 'sticker') {
          this.logger.log('Procesando mensaje de tipo sticker');
          messageRaw = {
            key,
            pushName,
            message: {
              stickerMessage: message.sticker || {},
            },
            messageType: 'stickerMessage',
            messageTimestamp: parseInt(message.timestamp) as number,
            source: 'unknown',
            instanceId: this.instanceId,
          };
        } else if (this.isMediaMessage(message)) {
          const messageContent =
            message.type === 'audio' ? this.messageAudioJson(received) : this.messageMediaJson(received);

          messageRaw = {
            key,
            pushName,
            message: messageContent,
            contextInfo: messageContent?.contextInfo,
            messageType: this.renderMessageType(received.messages[0].type),
            messageTimestamp: parseInt(received.messages[0].timestamp) as number,
            source: 'unknown',
            instanceId: this.instanceId,
          };

          if (this.configService.get<S3>('S3').ENABLE) {
            try {
              const message: any = received;

              // Verificação adicional para garantir que há conteúdo de mídia real
              const hasRealMedia = this.hasValidMediaContent(messageRaw);

              if (!hasRealMedia) {
                this.logger.warn('Message detected as media but contains no valid media content');
              } else {
                const id = message.messages[0][message.messages[0].type].id;
                let urlServer = this.configService.get<WaBusiness>('WA_BUSINESS').URL;
                const version = this.configService.get<WaBusiness>('WA_BUSINESS').VERSION;
                urlServer = `${urlServer}/${version}/${id}`;
                const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` };
                const result = await axios.get(urlServer, { headers });

                const buffer = await axios.get(result.data.url, {
                  headers: { Authorization: `Bearer ${this.token}` }, // Use apenas o token de autorização para download
                  responseType: 'arraybuffer',
                });

                let mediaType;

                if (message.messages[0].document) {
                  mediaType = 'document';
                } else if (message.messages[0].image) {
                  mediaType = 'image';
                } else if (message.messages[0].audio) {
                  mediaType = 'audio';
                } else {
                  mediaType = 'video';
                }

                if (mediaType == 'video' && !this.configService.get<S3>('S3').SAVE_VIDEO) {
                  this.logger?.info?.('Video upload attempted but is disabled by configuration.');
                  return {
                    success: false,
                    message:
                      'Video upload is currently disabled. Please contact support if you need this feature enabled.',
                  };
                }

                const mimetype = result.data?.mime_type || result.headers['content-type'];

                const contentDisposition = result.headers['content-disposition'];
                let fileName = `${message.messages[0].id}.${mimetype.split('/')[1]}`;
                if (contentDisposition) {
                  const match = contentDisposition.match(/filename="(.+?)"/);
                  if (match) {
                    fileName = match[1];
                  }
                }

                // Para áudio, garantir extensão correta baseada no mimetype
                if (mediaType === 'audio') {
                  if (mimetype.includes('ogg')) {
                    fileName = `${message.messages[0].id}.ogg`;
                  } else if (mimetype.includes('mp3')) {
                    fileName = `${message.messages[0].id}.mp3`;
                  } else if (mimetype.includes('m4a')) {
                    fileName = `${message.messages[0].id}.m4a`;
                  }
                }

                const size = result.headers['content-length'] || buffer.data.byteLength;

                const fullName = join(`${this.instance.id}`, key.remoteJid, mediaType, fileName);

                await s3Service.uploadFile(fullName, buffer.data, size, {
                  'Content-Type': mimetype,
                });

                const createdMessage = await this.prismaRepository.message.create({
                  data: messageRaw,
                });
                mediaMessageCreated = true;

                await this.prismaRepository.media.create({
                  data: {
                    messageId: createdMessage.id,
                    instanceId: this.instanceId,
                    type: mediaType,
                    fileName: fullName,
                    mimetype,
                  },
                });

                const mediaUrl = await s3Service.getObjectUrl(fullName);

                messageRaw.message.mediaUrl = mediaUrl;
                if (this.localWebhook.enabled && this.localWebhook.webhookBase64) {
                  messageRaw.message.base64 = buffer.data.toString('base64');
                }

                // Processar OpenAI speech-to-text para áudio após o mediaUrl estar disponível
                if (this.configService.get<Openai>('OPENAI').ENABLED && mediaType === 'audio') {
                  const openAiDefaultSettings = await this.prismaRepository.openaiSetting.findFirst({
                    where: {
                      instanceId: this.instanceId,
                    },
                    include: {
                      OpenaiCreds: true,
                    },
                  });

                  if (
                    openAiDefaultSettings &&
                    openAiDefaultSettings.openaiCredsId &&
                    openAiDefaultSettings.speechToText
                  ) {
                    try {
                      messageRaw.message.speechToText = `[audio] ${await this.openaiService.speechToText(
                        openAiDefaultSettings.OpenaiCreds,
                        {
                          message: {
                            mediaUrl: messageRaw.message.mediaUrl,
                            ...messageRaw,
                          },
                        },
                      )}`;
                    } catch (speechError) {
                      this.logger.error(`Error processing speech-to-text: ${speechError}`);
                    }
                  }
                }
              }
            } catch (error) {
              this.logger.error(['Error on upload file to minio', error?.message, error?.stack]);
            }
          } else {
            if (this.localWebhook.enabled && this.localWebhook.webhookBase64) {
              const buffer = await this.downloadMediaMessage(received?.messages[0]);
              messageRaw.message.base64 = buffer.toString('base64');
            }

            // Processar OpenAI speech-to-text para áudio mesmo sem S3
            if (this.configService.get<Openai>('OPENAI').ENABLED && message.type === 'audio') {
              let openAiBase64 = messageRaw.message.base64;
              if (!openAiBase64) {
                const buffer = await this.downloadMediaMessage(received?.messages[0]);
                openAiBase64 = buffer.toString('base64');
              }

              const openAiDefaultSettings = await this.prismaRepository.openaiSetting.findFirst({
                where: {
                  instanceId: this.instanceId,
                },
                include: {
                  OpenaiCreds: true,
                },
              });

              if (openAiDefaultSettings && openAiDefaultSettings.openaiCredsId && openAiDefaultSettings.speechToText) {
                try {
                  messageRaw.message.speechToText = `[audio] ${await this.openaiService.speechToText(
                    openAiDefaultSettings.OpenaiCreds,
                    {
                      message: {
                        base64: openAiBase64,
                        ...messageRaw,
                      },
                    },
                  )}`;
                } catch (speechError) {
                  this.logger.error(`Error processing speech-to-text: ${speechError}`);
                }
              }
            }
          }
        } else if (received?.messages[0].interactive) {
          messageRaw = {
            key,
            pushName,
            message: {
              ...this.messageInteractiveJson(received),
            },
            contextInfo: this.messageInteractiveJson(received)?.contextInfo,
            messageType: 'interactiveMessage',
            messageTimestamp: parseInt(received.messages[0].timestamp) as number,
            source: 'unknown',
            instanceId: this.instanceId,
          };
        } else if (received?.messages[0].button) {
          messageRaw = {
            key,
            pushName,
            message: {
              ...this.messageButtonJson(received),
            },
            contextInfo: this.messageButtonJson(received)?.contextInfo,
            messageType: 'buttonMessage',
            messageTimestamp: parseInt(received.messages[0].timestamp) as number,
            source: 'unknown',
            instanceId: this.instanceId,
          };
        } else if (received?.messages[0].reaction) {
          messageRaw = {
            key,
            pushName,
            message: {
              ...this.messageReactionJson(received),
            },
            contextInfo: this.messageReactionJson(received)?.contextInfo,
            messageType: 'reactionMessage',
            messageTimestamp: parseInt(received.messages[0].timestamp) as number,
            source: 'unknown',
            instanceId: this.instanceId,
          };
        } else if (received?.messages[0].contacts) {
          messageRaw = {
            key,
            pushName,
            message: {
              ...this.messageContactsJson(received),
            },
            contextInfo: this.messageContactsJson(received)?.contextInfo,
            messageType: 'contactMessage',
            messageTimestamp: parseInt(received.messages[0].timestamp) as number,
            source: 'unknown',
            instanceId: this.instanceId,
          };
        } else {
          messageRaw = {
            key,
            pushName,
            message: this.messageTextJson(received),
            contextInfo: this.messageTextJson(received)?.contextInfo,
            messageType: this.renderMessageType(received.messages[0].type),
            messageTimestamp: parseInt(received.messages[0].timestamp) as number,
            source: 'unknown',
            instanceId: this.instanceId,
          };
        }

        if (this.localSettings.readMessages) {
          // await this.client.readMessages([received.key]);
        }

        // Entrantes: DELIVERY_ACK = "sin leer" para el CRM (igual que Baileys; ver markRead en crm.service).
        if (!key.fromMe) messageRaw.status = status[3];

        this.logger.log(messageRaw);

        sendTelemetry(`received.message.${messageRaw.messageType ?? 'unknown'}`);

        this.sendDataWebhook(Events.MESSAGES_UPSERT, messageRaw);

        await chatbotController.emit({
          instance: { instanceName: this.instance.name, instanceId: this.instanceId },
          remoteJid: messageRaw.key.remoteJid,
          msg: messageRaw,
          pushName: messageRaw.pushName,
        });

        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
          const chatwootSentMessage = await this.chatwootService.eventWhatsapp(
            Events.MESSAGES_UPSERT,
            { instanceName: this.instance.name, instanceId: this.instanceId },
            messageRaw,
          );

          if (chatwootSentMessage?.id) {
            messageRaw.chatwootMessageId = chatwootSentMessage.id;
            messageRaw.chatwootInboxId = chatwootSentMessage.id;
            messageRaw.chatwootConversationId = chatwootSentMessage.id;
          }
        }

        // LYD-53: antes esto excluia media/sticker asumiendo que el branch de
        // S3 ya los habia creado -- sin S3 configurado (Brittany) o sin media
        // valida ahi, `mediaMessageCreated` sigue en false y el mensaje se
        // crea aca, como cualquier otro tipo.
        if (!mediaMessageCreated) {
          await this.prismaRepository.message.create({
            data: messageRaw,
          });
        }

        // LYD-35: hay que mirar si el Chat existia ANTES de touchChat -- ese
        // metodo lo crea/actualiza siempre, asi que despues de llamarlo
        // "existingChat" ya no serviria para distinguir un numero nuevo.
        const existingChatForWelcome = await this.prismaRepository.chat.findFirst({
          where: { instanceId: this.instanceId, remoteJid: key.remoteJid },
          select: { id: true },
        });

        await this.touchChat(key.remoteJid, pushName);

        // LYD-96: origen del lead -- referral de anuncio click-to-WhatsApp o codigo [TT-...] en el primer mensaje.
        if (!key.fromMe && message.type !== 'reaction') {
          await attributeInboundMessage(this.prismaRepository, this.instanceId, key.remoteJid, {
            platform: 'whatsapp',
            text: messageText(messageRaw.message),
            referral: whatsappReferralAttribution(message.referral),
          });
        }

        // LYD-35: numero sin Chat previo -- candidato a mensaje de
        // bienvenida automatico. Este es el canal WhatsApp real de Brittany
        // Group (WHATSAPP-BUSINESS via Cloud API) -- no confundir con
        // whatsapp.baileys.service.ts (WHATSAPP-BAILEYS), que tiene su
        // propia copia de esta misma logica para el canal QR/no oficial.
        if (!existingChatForWelcome && !key.fromMe && message.type !== 'reaction') {
          await this.sendWelcomeMessageIfEnabled(key.remoteJid, pushName);
        } else if (existingChatForWelcome && !key.fromMe && message.type !== 'reaction') {
          // LYD-47: el cliente contesta a un bot ya iniciado (boton) o escribe
          // texto libre (el bot se calla).
          await this.botHandleInbound(existingChatForWelcome.id, key.remoteJid, message);
        }

        const contact = await this.prismaRepository.contact.findFirst({
          where: { instanceId: this.instanceId, remoteJid: key.remoteJid },
        });

        // `profile.phone` no existe en los webhooks de Meta (el contacto se identifica con el jid ya resuelto).
        const contactRaw: any = {
          remoteJid: key.remoteJid,
          pushName,
          // profilePicUrl: '',
          instanceId: this.instanceId,
        };

        if (contactRaw.remoteJid === 'status@broadcast') {
          return;
        }

        if (contact) {
          const contactRaw: any = {
            remoteJid: key.remoteJid,
            pushName,
            // profilePicUrl: '',
            instanceId: this.instanceId,
          };

          this.sendDataWebhook(Events.CONTACTS_UPDATE, contactRaw);

          if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
            await this.chatwootService.eventWhatsapp(
              Events.CONTACTS_UPDATE,
              { instanceName: this.instance.name, instanceId: this.instanceId },
              contactRaw,
            );
          }

          // Acotado a la instancia: un mismo cliente puede escribirle a mas de un numero de la empresa.
          await this.prismaRepository.contact.updateMany({
            where: { remoteJid: contact.remoteJid, instanceId: this.instanceId },
            data: contactRaw,
          });
          return;
        }

        this.sendDataWebhook(Events.CONTACTS_UPSERT, contactRaw);

        await this.prismaRepository.contact.create({
          data: contactRaw,
        });
      }
      if (received.statuses) {
        for await (const item of received.statuses) {
          const key = {
            id: item.id,
            remoteJid,
            fromMe: remoteJid === received.metadata.phone_number_id,
          };
          if (settings?.groups_ignore && key.remoteJid.includes('@g.us')) {
            return;
          }
          if (key.remoteJid !== 'status@broadcast' && !key?.remoteJid?.match(/(:\d+)/)) {
            const findMessage = await this.prismaRepository.message.findFirst({
              where: {
                instanceId: this.instanceId,
                key: {
                  path: ['id'],
                  equals: key.id,
                },
              },
            });

            if (!findMessage) {
              return;
            }

            if (item.message === null && item.status === undefined) {
              this.sendDataWebhook(Events.MESSAGES_DELETE, key);

              const message: any = {
                messageId: findMessage.id,
                keyId: key.id,
                remoteJid: key.remoteJid,
                fromMe: key.fromMe,
                participant: key?.remoteJid,
                status: 'DELETED',
                instanceId: this.instanceId,
              };

              await this.prismaRepository.messageUpdate.create({
                data: message,
              });

              if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
                this.chatwootService.eventWhatsapp(
                  Events.MESSAGES_DELETE,
                  { instanceName: this.instance.name, instanceId: this.instanceId },
                  { key: key },
                );
              }

              return;
            }

            const message: any = {
              messageId: findMessage.id,
              keyId: key.id,
              remoteJid: key.remoteJid,
              fromMe: key.fromMe,
              participant: key?.remoteJid,
              status: item.status.toUpperCase(),
              instanceId: this.instanceId,
            };

            // Meta puede reenviar el mismo estado (LYD-24): cada (mensaje, estado) se registra y notifica una sola vez.
            const alreadyRecorded = await this.prismaRepository.messageUpdate.findFirst({
              where: { messageId: message.messageId, instanceId: this.instanceId, status: message.status },
              select: { id: true },
            });

            if (alreadyRecorded) {
              this.logger.log(`Estado ${message.status} repetido para ${key.id}, se ignora`);
              continue;
            }

            await this.prismaRepository.messageUpdate.create({
              data: message,
            });

            this.sendDataWebhook(Events.MESSAGES_UPDATE, message);

            if (findMessage.webhookUrl) {
              await axios.post(findMessage.webhookUrl, message);
            }
          }
        }
      }
    } catch (error) {
      this.logger.error(error);
    }
  }

  private convertMessageToRaw(message: any, content: any) {
    let convertMessage: any;

    if (message?.conversation) {
      if (content?.context?.message_id) {
        convertMessage = {
          ...message,
          contextInfo: { stanzaId: content.context.message_id },
        };
        return convertMessage;
      }
      convertMessage = message;
      return convertMessage;
    }

    if (message?.mediaType === 'image') {
      if (content?.context?.message_id) {
        convertMessage = {
          imageMessage: message,
          contextInfo: { stanzaId: content.context.message_id },
        };
        return convertMessage;
      }
      return {
        imageMessage: message,
      };
    }

    if (message?.mediaType === 'video') {
      if (content?.context?.message_id) {
        convertMessage = {
          videoMessage: message,
          contextInfo: { stanzaId: content.context.message_id },
        };
        return convertMessage;
      }
      return {
        videoMessage: message,
      };
    }

    if (message?.mediaType === 'audio') {
      if (content?.context?.message_id) {
        convertMessage = {
          audioMessage: message,
          contextInfo: { stanzaId: content.context.message_id },
        };
        return convertMessage;
      }
      return {
        audioMessage: message,
      };
    }

    if (message?.mediaType === 'document') {
      if (content?.context?.message_id) {
        convertMessage = {
          documentMessage: message,
          contextInfo: { stanzaId: content.context.message_id },
        };
        return convertMessage;
      }
      return {
        documentMessage: message,
      };
    }

    return message;
  }

  protected async eventHandler(content: any, remoteJid?: string) {
    try {
      // Registro para depuración
      this.logger.log('Contenido recibido en eventHandler:');
      this.logger.log(JSON.stringify(content, null, 2));

      const database = this.configService.get<Database>('DATABASE');
      const settings = await this.findSettings();

      // Si hay mensajes, verificar primero el tipo
      if (content.messages && content.messages.length > 0) {
        const message = content.messages[0];
        this.logger.log(`Tipo de mensaje recibido: ${message.type}`);

        // Verificamos el tipo de mensaje antes de procesarlo
        if (
          message.type === 'text' ||
          message.type === 'image' ||
          message.type === 'video' ||
          message.type === 'audio' ||
          message.type === 'document' ||
          message.type === 'sticker' ||
          message.type === 'location' ||
          message.type === 'contacts' ||
          message.type === 'interactive' ||
          message.type === 'button' ||
          message.type === 'reaction'
        ) {
          // Procesar el mensaje normalmente
          this.messageHandle(content, database, settings, remoteJid);
        } else {
          this.logger.warn(`Tipo de mensaje no reconocido: ${message.type}`);
        }
      } else if (content.statuses) {
        // Procesar actualizaciones de estado
        this.messageHandle(content, database, settings, remoteJid);
      } else {
        this.logger.warn('No se encontraron mensajes ni estados en el contenido recibido');
      }
    } catch (error) {
      this.logger.error('Error en eventHandler:');
      this.logger.error(error);
    }
  }

  protected async sendMessageWithTyping(number: string, message: any, options?: Options, isIntegration = false) {
    try {
      let quoted: any;
      let webhookUrl: any;
      if (options?.quoted) {
        const m = options?.quoted;

        const msg = m?.key;

        if (!msg) {
          throw 'Message not found';
        }

        quoted = msg;
      }
      if (options?.webhookUrl) {
        webhookUrl = options.webhookUrl;
      }

      let content: any;
      const messageSent = await (async () => {
        if (message['reactionMessage']) {
          content = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            type: 'reaction',
            ...this.recipientField(number),
            reaction: {
              message_id: message['reactionMessage']['key']['id'],
              emoji: message['reactionMessage']['text'],
            },
          };
          quoted ? (content.context = { message_id: quoted.id }) : content;
          return await this.post(content, 'messages');
        }
        if (message['locationMessage']) {
          content = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            type: 'location',
            ...this.recipientField(number),
            location: {
              longitude: message['locationMessage']['degreesLongitude'],
              latitude: message['locationMessage']['degreesLatitude'],
              name: message['locationMessage']['name'],
              address: message['locationMessage']['address'],
            },
          };
          quoted ? (content.context = { message_id: quoted.id }) : content;
          return await this.post(content, 'messages');
        }
        if (message['contacts']) {
          content = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            type: 'contacts',
            ...this.recipientField(number),
            contacts: message['contacts'],
          };
          quoted ? (content.context = { message_id: quoted.id }) : content;
          message = message['message'];
          return await this.post(content, 'messages');
        }
        if (message['conversation']) {
          content = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            type: 'text',
            ...this.recipientField(number),
            text: {
              body: message['conversation'],
              preview_url: Boolean(options?.linkPreview),
            },
          };
          quoted ? (content.context = { message_id: quoted.id }) : content;
          return await this.post(content, 'messages');
        }
        if (message['media']) {
          const isImage = message['mimetype']?.startsWith('image/');

          content = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            type: message['mediaType'],
            ...this.recipientField(number),
            [message['mediaType']]: {
              [message['type']]: message['id'],
              ...(message['mediaType'] !== 'audio' &&
                message['mediaType'] !== 'video' &&
                message['fileName'] &&
                !isImage && { filename: message['fileName'] }),
              ...(message['mediaType'] !== 'audio' && message['caption'] && { caption: message['caption'] }),
            },
          };
          quoted ? (content.context = { message_id: quoted.id }) : content;
          return await this.post(content, 'messages');
        }
        if (message['audio']) {
          content = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            type: 'audio',
            ...this.recipientField(number),
            audio: {
              [message['type']]: message['id'],
            },
          };
          quoted ? (content.context = { message_id: quoted.id }) : content;
          return await this.post(content, 'messages');
        }
        if (message['buttons']) {
          content = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            ...this.recipientField(number),
            type: 'interactive',
            interactive: {
              type: 'button',
              body: {
                text: message['text'] || 'Select',
              },
              action: {
                buttons: message['buttons'],
              },
            },
          };
          quoted ? (content.context = { message_id: quoted.id }) : content;
          let formattedText = '';
          for (const item of message['buttons']) {
            formattedText += `▶️ ${item.reply?.title}\n`;
          }
          message = { conversation: `${message['text'] || 'Select'}\n` + formattedText };
          return await this.post(content, 'messages');
        }
        if (message['listMessage']) {
          content = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            ...this.recipientField(number),
            type: 'interactive',
            interactive: {
              type: 'list',
              header: {
                type: 'text',
                text: message['listMessage']['title'],
              },
              body: {
                text: message['listMessage']['description'],
              },
              footer: {
                text: message['listMessage']['footerText'],
              },
              action: {
                button: message['listMessage']['buttonText'],
                sections: message['listMessage']['sections'],
              },
            },
          };
          quoted ? (content.context = { message_id: quoted.id }) : content;
          let formattedText = '';
          for (const section of message['listMessage']['sections']) {
            formattedText += `${section?.title}\n`;
            for (const row of section.rows) {
              formattedText += `${row?.title}\n`;
            }
          }
          message = { conversation: `${message['listMessage']['title']}\n` + formattedText };
          return await this.post(content, 'messages');
        }
        if (message['template']) {
          content = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            ...this.recipientField(number),
            type: 'template',
            template: {
              name: message['template']['name'],
              language: {
                code: message['template']['language'] || 'en_US',
              },
              components: message['template']['components'],
            },
          };
          quoted ? (content.context = { message_id: quoted.id }) : content;
          message = { conversation: `▶️${message['template']['name']}◀️` };
          return await this.post(content, 'messages');
        }
      })();

      if (!messageSent || messageSent.error_data || messageSent.message) {
        // Antes se devolvia el error como si fuera un envio exitoso y el cliente
        // no se enteraba de que el mensaje no salio.
        const reason = messageSent?.message || 'la API de Meta no devolvio respuesta';
        const code = messageSent?.code ? ` (codigo ${messageSent.code})` : '';
        throw `No se pudo enviar el mensaje a Meta: ${reason}${code}`;
      }

      const messageRaw: any = {
        key: { fromMe: true, id: messageSent?.messages[0]?.id, remoteJid: createJid(number) },
        message: this.convertMessageToRaw(message, content),
        messageType: this.renderMessageType(content.type),
        messageTimestamp: (messageSent?.messages[0]?.timestamp as number) || Math.round(new Date().getTime() / 1000),
        instanceId: this.instanceId,
        webhookUrl,
        status: status[1],
        source: 'unknown',
      };

      this.logger.log(messageRaw);

      this.sendDataWebhook(Events.SEND_MESSAGE, messageRaw);

      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled && !isIntegration) {
        this.chatwootService.eventWhatsapp(
          Events.SEND_MESSAGE,
          { instanceName: this.instance.name, instanceId: this.instanceId },
          messageRaw,
        );
      }

      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled && isIntegration)
        await chatbotController.emit({
          instance: { instanceName: this.instance.name, instanceId: this.instanceId },
          remoteJid: messageRaw.key.remoteJid,
          msg: messageRaw,
          pushName: messageRaw.pushName,
        });

      await this.prismaRepository.message.create({
        data: messageRaw,
      });

      await this.touchChat(messageRaw.key.remoteJid);

      return messageRaw;
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  // Send Message Controller
  // LYD-35: mensaje de bienvenida automatico, v1 -- misma logica que
  // whatsapp.baileys.service.ts (duplicada a proposito, mismo criterio que
  // touchChat: cada canal reimplementa su manejo de Chat, no se comparte).
  // LYD-47: sender del bot por este canal. Los botones son "reply buttons" de
  // Cloud API (maximo 3, ya validado al guardar el flujo).
  private botSender(remoteJid: string) {
    return {
      sendText: async (text: string) => {
        await this.textMessage({ number: remoteJid, text }, false);
      },
      sendButtons: async (body: string, buttons: { id: string; title: string }[]) => {
        await this.buttonMessage({
          number: remoteJid,
          title: body,
          buttons: buttons.map((b) => ({ type: 'reply', displayText: b.title, id: b.id })),
        } as SendButtonsDto);
      },
    };
  }

  private async botHandleInbound(chatId: string, remoteJid: string, message: any) {
    try {
      const buttonId = message?.type === 'interactive' ? message.interactive?.button_reply?.id : undefined;
      await botService.handleInbound(
        chatId,
        typeof buttonId === 'string' ? { kind: 'button', buttonId } : { kind: 'other' },
        this.botSender(remoteJid),
      );
    } catch (error) {
      this.logger.error(`Bot inbound failed for ${remoteJid} - ${this.instanceId}: ${error}`);
    }
  }

  // LYD-35 / LYD-47: primer mensaje de un numero nuevo. Si la instancia tiene
  // un flujo de bot, arranca el flujo; si no, cae al mensaje de bienvenida
  // simple de siempre (WelcomeMessageConfig).
  private async sendWelcomeMessageIfEnabled(remoteJid: string, pushName?: string | null): Promise<void> {
    try {
      const flow = await this.prismaRepository.botFlow.findUnique({ where: { instanceId: this.instanceId } });

      const config = flow
        ? null
        : await this.prismaRepository.welcomeMessageConfig.findUnique({ where: { instanceId: this.instanceId } });
      const message = config?.message?.trim();

      if (flow ? !flow.enabled : !config?.enabled || !message) {
        return;
      }

      // Se le pasa el pushName para que, si chats.upsert corre despues en el
      // mismo lote, encuentre la fila ya creada y no la pise.
      const chat = await this.prismaRepository.chat.upsert({
        where: { instanceId_remoteJid: { instanceId: this.instanceId, remoteJid } },
        create: { instanceId: this.instanceId, remoteJid, name: pushName ?? null },
        update: {},
        select: { id: true },
      });

      // Reclamo atomico: dos eventos casi simultaneos del mismo remoteJid
      // nunca lo arrancan dos veces.
      const claim = await this.prismaRepository.chat.updateMany({
        where: { instanceId: this.instanceId, remoteJid, welcomeMessageSentAt: null },
        data: { welcomeMessageSentAt: new Date() },
      });

      if (claim.count === 0) {
        return;
      }

      if (flow) {
        await botService.startFlow(this.instanceId, chat.id, this.botSender(remoteJid));
        return;
      }

      // Si textMessage falla no se reintenta en un mensaje siguiente:
      // aceptado para v1 -- mejor perder una bienvenida que mandarla dos veces.
      await this.textMessage({ number: remoteJid, text: message as string }, false);
    } catch (error) {
      this.logger.error(`Welcome message failed for ${remoteJid} - ${this.instanceId}: ${error}`);
    }
  }

  public async textMessage(data: SendTextDto, isIntegration = false) {
    const res = await this.sendMessageWithTyping(
      data.number,
      {
        conversation: data.text,
      },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        linkPreview: data?.linkPreview,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
      isIntegration,
    );
    return res;
  }

  private async getIdMedia(mediaMessage: any, isFile = false) {
    try {
      const formData = new FormData();

      if (isFile === false) {
        if (isURL(mediaMessage.media)) {
          const response = await axios.get(mediaMessage.media, { responseType: 'arraybuffer' });
          const buffer = Buffer.from(response.data, 'base64');
          formData.append('file', buffer, {
            filename: mediaMessage.fileName || 'media',
            contentType: mediaMessage.mimetype,
          });
        } else {
          const buffer = Buffer.from(mediaMessage.media, 'base64');
          formData.append('file', buffer, {
            filename: mediaMessage.fileName || 'media',
            contentType: mediaMessage.mimetype,
          });
        }
      } else {
        formData.append('file', mediaMessage.media.buffer, {
          filename: mediaMessage.media.originalname,
          contentType: mediaMessage.media.mimetype,
        });
      }

      const mimetype = mediaMessage.mimetype || mediaMessage.media.mimetype;

      formData.append('typeFile', mimetype);
      formData.append('messaging_product', 'whatsapp');

      const token = this.token;

      const headers = { Authorization: `Bearer ${token}` };
      const url = `${this.configService.get<WaBusiness>('WA_BUSINESS').URL}/${
        this.configService.get<WaBusiness>('WA_BUSINESS').VERSION
      }/${this.number}/media`;

      const res = await axios.post(url, formData, { headers });
      return res.data.id;
    } catch (error) {
      this.logger.error(error.response.data);
      throw new InternalServerErrorException(error?.toString() || error);
    }
  }

  protected async prepareMediaMessage(mediaMessage: MediaMessage) {
    try {
      if (mediaMessage.mediatype === 'document' && !mediaMessage.fileName) {
        const regex = new RegExp(/.*\/(.+?)\./);
        const arrayMatch = regex.exec(mediaMessage.media);
        mediaMessage.fileName = arrayMatch[1];
      }

      if (mediaMessage.mediatype === 'image' && !mediaMessage.fileName) {
        mediaMessage.fileName = 'image.png';
      }

      if (mediaMessage.mediatype === 'video' && !mediaMessage.fileName) {
        mediaMessage.fileName = 'video.mp4';
      }

      let mimetype: string | false;

      const prepareMedia: any = {
        caption: mediaMessage?.caption,
        fileName: mediaMessage.fileName,
        mediaType: mediaMessage.mediatype,
        media: mediaMessage.media,
        gifPlayback: false,
      };

      if (isURL(mediaMessage.media)) {
        mimetype = mimeTypes.lookup(mediaMessage.media);
        prepareMedia.id = mediaMessage.media;
        prepareMedia.type = 'link';
      } else {
        mimetype = mimeTypes.lookup(mediaMessage.fileName);
        const id = await this.getIdMedia(prepareMedia);
        prepareMedia.id = id;
        prepareMedia.type = 'id';
      }

      prepareMedia.mimetype = mimetype;

      return prepareMedia;
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(error?.toString() || error);
    }
  }

  public async mediaMessage(data: SendMediaDto, file?: any, isIntegration = false) {
    const mediaData: SendMediaDto = { ...data };

    if (file) mediaData.media = file.buffer.toString('base64');

    const message = await this.prepareMediaMessage(mediaData);

    const mediaSent = await this.sendMessageWithTyping(
      data.number,
      { ...message },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        linkPreview: data?.linkPreview,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
      isIntegration,
    );

    return mediaSent;
  }

  public async processAudio(audio: string, number: string, file: any) {
    number = number.replace(/\D/g, '');
    const hash = `${number}-${new Date().getTime()}`;

    const audioConverterConfig = this.configService.get<AudioConverter>('AUDIO_CONVERTER');
    if (audioConverterConfig.API_URL) {
      this.logger.verbose('Using audio converter API');
      const formData = new FormData();

      if (file) {
        formData.append('file', file.buffer, {
          filename: file.originalname,
          contentType: file.mimetype,
        });
      } else if (isURL(audio)) {
        formData.append('url', audio);
      } else {
        formData.append('base64', audio);
      }

      // LYD-53: ogg/opus, no mp3 -- es el unico formato que WhatsApp muestra
      // como nota de voz real (burbuja compacta con forma de onda). Un mp3
      // sigue siendo un audio valido para Meta, pero se ve como adjunto de
      // archivo generico (con nombre y extension visibles), no como nota de
      // voz -- confirmado en produccion (LYD-53).
      formData.append('format', 'ogg');

      const response = await axios.post(audioConverterConfig.API_URL, formData, {
        headers: {
          ...formData.getHeaders(),
          apikey: audioConverterConfig.API_KEY,
        },
      });

      const audioConverter = response?.data?.audio || response?.data?.url;

      if (!audioConverter) {
        throw new InternalServerErrorException('Failed to convert audio');
      }

      const prepareMedia: any = {
        fileName: `${hash}.ogg`,
        mediaType: 'audio',
        media: audioConverter,
        // Sin espacio: este string tambien termina armando un data: URI del
        // lado del front (data:<mimetype>;base64,...) -- un espacio crudo ahi
        // es invalido/ambiguo (RFC 2397).
        mimetype: 'audio/ogg;codecs=opus',
      };

      const id = await this.getIdMedia(prepareMedia);
      prepareMedia.id = id;
      prepareMedia.type = 'id';

      this.logger.verbose('Audio converted');
      return prepareMedia;
    } else {
      let mimetype: string | false;

      const prepareMedia: any = {
        fileName: `${hash}.mp3`,
        mediaType: 'audio',
        media: audio,
      };

      if (isURL(audio)) {
        mimetype = mimeTypes.lookup(audio);
        prepareMedia.id = audio;
        prepareMedia.type = 'link';
      } else if (audio && !file) {
        mimetype = mimeTypes.lookup(prepareMedia.fileName);
        const id = await this.getIdMedia(prepareMedia);
        prepareMedia.id = id;
        prepareMedia.type = 'id';
      } else if (file) {
        prepareMedia.media = file;
        const id = await this.getIdMedia(prepareMedia, true);
        prepareMedia.id = id;
        prepareMedia.type = 'id';
        mimetype = file.mimetype;
      }

      prepareMedia.mimetype = mimetype;

      return prepareMedia;
    }
  }

  public async audioWhatsapp(data: SendAudioDto, file?: any, isIntegration = false) {
    const message = await this.processAudio(data.audio, data.number, file);

    const audioSent = await this.sendMessageWithTyping(
      data.number,
      { ...message },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        linkPreview: data?.linkPreview,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
      isIntegration,
    );

    return audioSent;
  }

  public async buttonMessage(data: SendButtonsDto) {
    const embeddedMedia: any = {};

    const btnItems = {
      text: data.buttons.map((btn) => btn.displayText),
      ids: data.buttons.map((btn) => btn.id),
    };

    if (!arrayUnique(btnItems.text) || !arrayUnique(btnItems.ids)) {
      throw new BadRequestException('Button texts cannot be repeated', 'Button IDs cannot be repeated.');
    }

    return await this.sendMessageWithTyping(
      data.number,
      {
        text: !embeddedMedia?.mediaKey ? data.title : undefined,
        buttons: data.buttons.map((button) => {
          return {
            type: 'reply',
            reply: {
              title: button.displayText,
              id: button.id,
            },
          };
        }),
        [embeddedMedia?.mediaKey]: embeddedMedia?.message,
      },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        linkPreview: data?.linkPreview,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
    );
  }

  public async locationMessage(data: SendLocationDto) {
    return await this.sendMessageWithTyping(
      data.number,
      {
        locationMessage: {
          degreesLatitude: data.latitude,
          degreesLongitude: data.longitude,
          name: data?.name,
          address: data?.address,
        },
      },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        linkPreview: data?.linkPreview,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
    );
  }

  public async listMessage(data: SendListDto) {
    const sectionsItems = {
      title: data.sections.map((list) => list.title),
    };

    if (!arrayUnique(sectionsItems.title)) {
      throw new BadRequestException('Section tiles cannot be repeated');
    }

    const sendData: any = {
      listMessage: {
        title: data.title,
        description: data.description,
        footerText: data?.footerText,
        buttonText: data?.buttonText,
        sections: data.sections.map((section) => {
          return {
            title: section.title,
            rows: section.rows.map((row) => {
              return {
                title: row.title,
                description: row.description.substring(0, 72),
                id: row.rowId,
              };
            }),
          };
        }),
      },
    };

    return await this.sendMessageWithTyping(data.number, sendData, {
      delay: data?.delay,
      presence: 'composing',
      quoted: data?.quoted,
      linkPreview: data?.linkPreview,
      mentionsEveryOne: data?.mentionsEveryOne,
      mentioned: data?.mentioned,
    });
  }

  public async templateMessage(data: SendTemplateDto, isIntegration = false) {
    const res = await this.sendMessageWithTyping(
      data.number,
      {
        template: {
          name: data.name,
          language: data.language,
          components: data.components,
        },
      },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        linkPreview: data?.linkPreview,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
        webhookUrl: data?.webhookUrl,
      },
      isIntegration,
    );
    return res;
  }

  public async contactMessage(data: SendContactDto) {
    const message: any = {};

    const vcard = (contact: ContactMessage) => {
      let result = 'BEGIN:VCARD\n' + 'VERSION:3.0\n' + `N:${contact.fullName}\n` + `FN:${contact.fullName}\n`;

      if (contact.organization) {
        result += `ORG:${contact.organization};\n`;
      }

      if (contact.email) {
        result += `EMAIL:${contact.email}\n`;
      }

      if (contact.url) {
        result += `URL:${contact.url}\n`;
      }

      if (!contact.wuid) {
        contact.wuid = createJid(contact.phoneNumber);
      }

      result += `item1.TEL;waid=${contact.wuid}:${contact.phoneNumber}\n` + 'item1.X-ABLabel:Celular\n' + 'END:VCARD';

      return result;
    };

    if (data.contact.length === 1) {
      message.contact = {
        displayName: data.contact[0].fullName,
        vcard: vcard(data.contact[0]),
      };
    } else {
      message.contactsArrayMessage = {
        displayName: `${data.contact.length} contacts`,
        contacts: data.contact.map((contact) => {
          return {
            displayName: contact.fullName,
            vcard: vcard(contact),
          };
        }),
      };
    }
    return await this.sendMessageWithTyping(
      data.number,
      {
        contacts: data.contact.map((contact) => {
          return {
            name: { formatted_name: contact.fullName, first_name: contact.fullName },
            phones: [{ phone: contact.phoneNumber }],
            urls: [{ url: contact.url }],
            emails: [{ email: contact.email }],
            org: { company: contact.organization },
          };
        }),
        message,
      },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        linkPreview: data?.linkPreview,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
    );
  }

  public async reactionMessage(data: SendReactionDto) {
    return await this.sendMessageWithTyping(data.key.remoteJid, {
      reactionMessage: {
        key: data.key,
        text: data.reaction,
      },
    });
  }

  public async getBase64FromMediaMessage(data: any) {
    try {
      const msg = data.message;
      const messageType = msg.messageType.includes('Message') ? msg.messageType : msg.messageType + 'Message';
      const mediaMessage = msg.message[messageType];

      if (!msg.message?.base64) {
        const buffer = await this.downloadMediaMessage({ type: messageType, ...msg.message });
        msg.message.base64 = buffer.toString('base64');
      }

      return {
        mediaType: msg.messageType,
        fileName: mediaMessage?.fileName || mediaMessage?.filename,
        caption: mediaMessage?.caption,
        size: {
          fileLength: mediaMessage?.fileLength,
          height: mediaMessage?.fileLength,
          width: mediaMessage?.width,
        },
        // LYD-53 fix: `mime_type` es como llega un adjunto ENTRANTE (asi lo
        // manda el webhook de Meta, ver messageAudioJson/messageMediaJson),
        // pero un adjunto SALIENTE armado por nosotros (processAudio(),
        // mediaMessage()) usa `mimetype` -- mismo patron que ya tenia
        // fileName/filename arriba, pero le faltaba a este campo. Sin el
        // fallback, un audio/imagen que mandamos nosotros llegaba al front
        // con mimetype undefined -- el navegador no podia reproducirlo.
        mimetype: mediaMessage?.mime_type ?? mediaMessage?.mimetype,
        base64: msg.message.base64,
      };
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  public async deleteMessage() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }

  // methods not available on WhatsApp Business API
  public async mediaSticker() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async pollMessage() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async statusMessage() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async reloadConnection() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async whatsappNumber() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async markMessageAsRead() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async archiveChat() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async markChatUnread() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async fetchProfile() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async offerCall() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async sendPresence() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async setPresence() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async fetchPrivacySettings() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async updatePrivacySettings() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async fetchBusinessProfile() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async updateProfileName() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async updateProfileStatus() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async updateProfilePicture() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async removeProfilePicture() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async blockUser() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async updateMessage() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async createGroup() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async updateGroupPicture() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async updateGroupSubject() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async updateGroupDescription() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async findGroup() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async fetchAllGroups() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async inviteCode() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async inviteInfo() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async sendInvite() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async acceptInviteCode() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async revokeInviteCode() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async findParticipants() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async updateGParticipant() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async updateGSetting() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async toggleEphemeral() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async leaveGroup() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async fetchLabels() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async handleLabel() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async receiveMobileCode() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async fakeCall() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
}
