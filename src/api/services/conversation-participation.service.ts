import { PrismaRepository } from '@api/repository/repository.service';
import { NotFoundException } from '@exceptions';

import { ChatParticipant, latestParticipation } from './chat-participants.util';

// LYD-117: lectura del porcentaje de participacion que calcula la auditoria
// diaria de las 21:00. Aca no se calcula nada: solo se muestra lo guardado.
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
}
