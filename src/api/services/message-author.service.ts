import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import { BadRequestException, NotFoundException } from '@exceptions';
import { MessageAuthorKind, Prisma } from '@prisma/client';

import { ChatParticipant, groupParticipants, ParticipantRow } from './chat-participants.util';

// LYD-101: autoria de los mensajes salientes. Evolution guarda todo lo que
// sale como fromMe=true, sin distinguir asesora, bot o bienvenida; esta tabla
// lo agrega sin tocar Message. La auditoria comercial diaria (LYD-102) la
// cruza con Message por instanceId + key.id.
export class MessageAuthorService {
  private readonly logger = new Logger('MessageAuthorService');

  constructor(private readonly prisma: PrismaRepository) {}

  // Envio desde el inbox de Lydia: el front manda el agentId de la sesion y
  // el key.id que devolvio el envio.
  public async recordAgentMessage(data: { instanceName?: string; messageKeyId?: string; agentId?: string }) {
    const { instanceName, messageKeyId, agentId } = data ?? {};
    if (!instanceName || !messageKeyId || !agentId) {
      throw new BadRequestException('instanceName, messageKeyId y agentId son requeridos');
    }

    const instance = await this.prisma.instance.findUnique({ where: { name: instanceName }, select: { id: true } });
    if (!instance) {
      throw new NotFoundException(`Instancia ${instanceName} no encontrada`);
    }

    const agent = await this.prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } });
    if (!agent) {
      throw new NotFoundException(`Agente ${agentId} no encontrado`);
    }

    return this.upsert(instance.id, messageKeyId, MessageAuthorKind.asesora, agentId);
  }

  // Envios automaticos (bot, bienvenida) desde los canales. `sent` es lo que
  // devuelve textMessage/buttonMessage (el messageRaw con su key). Best-effort:
  // el mensaje ya salio, un fallo aca no debe romper el flujo del canal.
  public async recordAutomatic(instanceId: string, sent: unknown, kind: MessageAuthorKind): Promise<void> {
    const messageKeyId = (sent as { key?: { id?: unknown } } | null)?.key?.id;
    if (typeof messageKeyId !== 'string' || !messageKeyId) {
      return;
    }

    try {
      await this.upsert(instanceId, messageKeyId, kind, null);
    } catch (error) {
      this.logger.error(`No se pudo registrar la autoria (${kind}) de ${messageKeyId}: ${error}`);
    }
  }

  // LYD-105: "Ver detalles" de un mensaje en el inbox: quien lo envio (segun
  // esta tabla) y hasta donde llego. `messageId` es Message.id, el mismo id
  // que usa el front para cada burbuja.
  public async getMessageDetails(messageId: string) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        instanceId: true,
        key: true,
        status: true,
        messageTimestamp: true,
        MessageUpdate: { select: { status: true } },
      },
    });
    if (!message) {
      throw new NotFoundException(`Mensaje ${messageId} no encontrado`);
    }

    const key = message.key as { id?: string; fromMe?: boolean };
    const fromMe = key?.fromMe === true;
    const author =
      fromMe && key?.id
        ? await this.prisma.messageAuthor.findUnique({
            where: { instanceId_messageKeyId: { instanceId: message.instanceId, messageKeyId: key.id } },
            select: { kind: true, createdAt: true, Agent: { select: { name: true, email: true } } },
          })
        : null;

    return {
      messageId,
      fromMe,
      sentAt: new Date(message.messageTimestamp * 1000).toISOString(),
      sender: !fromMe ? 'cliente' : (author?.kind ?? 'sin_registro'),
      agent: author?.Agent ?? null,
      delivery: fromMe ? deliveryStatus([message.status, ...message.MessageUpdate.map((u) => u.status)]) : null,
    };
  }

  // LYD-117: asesoras que enviaron mensajes en cada chat. Parte de Chat (pocos
  // ids) y usa el indice (instanceId, remoteJid, messageTimestamp) de Message
  // y el unico (instanceId, messageKeyId) de MessageAuthor. Lo enviado antes
  // de LYD-101 o desde el celular no tiene autora y no cuenta.
  public async listChatParticipants(chatIds: string[]): Promise<Map<string, ChatParticipant[]>> {
    const ids = [...new Set(chatIds.filter(Boolean))];
    if (ids.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<ParticipantRow[]>`
      SELECT c.id AS "chatId", ma."agentId", COUNT(*)::int AS messages,
        MIN(m."messageTimestamp")::int AS "firstAt", MAX(m."messageTimestamp")::int AS "lastAt"
      FROM "Chat" c
      JOIN "Message" m ON m."instanceId" = c."instanceId" AND m.key->>'remoteJid' = c."remoteJid"
      JOIN "MessageAuthor" ma ON ma."instanceId" = m."instanceId" AND ma."messageKeyId" = m.key->>'id'
      WHERE c.id IN (${Prisma.join(ids)})
        AND m.key->>'fromMe' = 'true'
        AND ma.kind = 'asesora'::"MessageAuthorKind"
        AND ma."agentId" IS NOT NULL
      GROUP BY 1, 2
    `;
    if (rows.length === 0) return new Map();

    const agents = await this.prisma.agent.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.agentId))] } },
      select: { id: true, name: true, email: true, color: true },
    });
    return groupParticipants(rows, agents);
  }

  public async getChatParticipants(chatId: string) {
    const chat = await this.prisma.chat.findUnique({ where: { id: chatId }, select: { id: true } });
    if (!chat) {
      throw new NotFoundException(`Conversation "${chatId}" not found`);
    }
    return (await this.listChatParticipants([chatId])).get(chatId) ?? [];
  }

  // Idempotente: reintentar el registro de un mismo mensaje no duplica ni
  // cambia el autor ya guardado.
  private upsert(instanceId: string, messageKeyId: string, kind: MessageAuthorKind, agentId: string | null) {
    return this.prisma.messageAuthor.upsert({
      where: { instanceId_messageKeyId: { instanceId, messageKeyId } },
      create: { instanceId, messageKeyId, kind, agentId },
      update: {},
    });
  }
}

// LYD-105: estado de entrega mas avanzado entre el del mensaje y sus updates.
// Baileys los guarda en mayusculas (SERVER_ACK, DELIVERY_ACK, READ...) y
// Cloud API en minusculas (sent, delivered, read).
const DELIVERY_RANK: Record<string, { rank: number; label: string }> = {
  error: { rank: 0, label: 'error' },
  failed: { rank: 0, label: 'error' },
  pending: { rank: 1, label: 'pendiente' },
  server_ack: { rank: 2, label: 'enviado' },
  sent: { rank: 2, label: 'enviado' },
  delivery_ack: { rank: 3, label: 'entregado' },
  delivered: { rank: 3, label: 'entregado' },
  read: { rank: 4, label: 'leido' },
  played: { rank: 4, label: 'leido' },
};

function deliveryStatus(statuses: (string | null)[]): string | null {
  let best: { rank: number; label: string } | null = null;
  for (const status of statuses) {
    const entry = status ? DELIVERY_RANK[status.toLowerCase()] : undefined;
    if (entry && (!best || entry.rank > best.rank)) best = entry;
  }
  return best?.label ?? null;
}
