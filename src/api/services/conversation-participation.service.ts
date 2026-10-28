import { PrismaRepository } from '@api/repository/repository.service';
import { FULL_PARTICIPATION } from '@api/services/commercial-audit/audit-participation';
import { NotFoundException } from '@exceptions';
import { Prisma } from '@prisma/client';

import { ChatParticipant, latestParticipation } from './chat-participants.util';

// LYD-117: lectura del porcentaje de participacion que calcula la auditoria
// diaria de las 21:00. Aca no se calcula nada: solo se muestra lo guardado.
// LYD-123: reemplaza al responsable del chat. Para lo que necesita estar al
// dia (inbox, avisos) se usa quien escribio, segun la autoria de mensajes.
export class ConversationParticipationService {
  constructor(private readonly prisma: PrismaRepository) {}

  public async listByChat(chatIds: string[]): Promise<Map<string, ChatParticipant[]>> {
    const ids = [...new Set(chatIds.filter(Boolean))];
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.conversationParticipation.findMany({
      where: { chatId: { in: ids } },
      select: {
        chatId: true,
        percent: true,
        reason: true,
        Run: { select: { reportDate: true } },
        Agent: { select: { id: true, name: true, email: true, color: true } },
      },
    });
    return latestParticipation(rows);
  }

  public async getForChat(chatId: string): Promise<ChatParticipant[]> {
    const chat = await this.prisma.chat.findUnique({ where: { id: chatId }, select: { id: true } });
    if (!chat) {
      throw new NotFoundException(`Conversation "${chatId}" not found`);
    }
    return (await this.listByChat([chatId])).get(chatId) ?? [];
  }

  // Asesoras que escribieron en cada chat (MessageAuthor), en tiempo real.
  public async writersByChat(chatIds: string[]): Promise<Map<string, string[]>> {
    const ids = [...new Set(chatIds.filter(Boolean))];
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ chatId: string; agentIds: string[] }[]>`
      SELECT c."id" AS "chatId", ARRAY_AGG(DISTINCT a."agentId") AS "agentIds"
      FROM "Chat" c
      JOIN "Message" m ON m."instanceId" = c."instanceId" AND m."key"->>'remoteJid' = c."remoteJid"
      JOIN "MessageAuthor" a ON a."instanceId" = m."instanceId" AND a."messageKeyId" = m."key"->>'id'
      WHERE c."id" IN (${Prisma.join(ids)})
        AND a."kind" = 'asesora'::"MessageAuthorKind"
        AND a."agentId" IS NOT NULL
      GROUP BY c."id"
    `;
    return new Map(rows.map((r) => [r.chatId, r.agentIds]));
  }

  // Chats donde escribio la asesora.
  public async chatIdsWrittenBy(agentId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ chatId: string }[]>`
      SELECT DISTINCT c."id" AS "chatId"
      FROM "MessageAuthor" a
      JOIN "Message" m ON m."instanceId" = a."instanceId" AND m."key"->>'id' = a."messageKeyId"
      JOIN "Chat" c ON c."instanceId" = m."instanceId" AND c."remoteJid" = m."key"->>'remoteJid'
      WHERE a."agentId" = ${agentId} AND a."kind" = 'asesora'::"MessageAuthorKind"
    `;
    return rows.map((r) => r.chatId);
  }

  // Chats que cuentan para la asesora en las metricas: en la ultima auditoria
  // del chat tiene FULL_PARTICIPATION% o mas.
  public async chatIdsCreditedTo(agentId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ chatId: string }[]>`
      SELECT p."chatId"
      FROM "ConversationParticipation" p
      JOIN "CommercialAuditRun" r ON r."id" = p."runId"
      WHERE p."agentId" = ${agentId}
        AND p."percent" >= ${FULL_PARTICIPATION}
        AND r."reportDate" = (
          SELECT MAX(r2."reportDate")
          FROM "ConversationParticipation" p2
          JOIN "CommercialAuditRun" r2 ON r2."id" = p2."runId"
          WHERE p2."chatId" = p."chatId"
        )
    `;
    return rows.map((r) => r.chatId);
  }
}
