import { CrmService } from '@api/services/crm.service';
import { CrmSuggestReplyService } from '@api/services/crm-suggest-reply.service';
import { AgentRole, ChatStatus } from '@prisma/client';

export class CrmController {
  constructor(
    private readonly crmService: CrmService,
    private readonly suggestReplyService: CrmSuggestReplyService,
  ) {}

  public async listAgents() {
    return this.crmService.listAgents();
  }

  public async createAgent(data: { name: string; email?: string; color?: string; role?: AgentRole }) {
    return this.crmService.createAgent(data);
  }

  public async listConversations(query: { instanceName?: string; status?: ChatStatus; assignedAgentId?: string }) {
    return this.crmService.listConversations(query);
  }

  public async searchMessages(query: { q?: string; instanceName?: string; limit?: string }) {
    return this.crmService.searchMessages(query);
  }

  // LYD-68: sugerencia de respuesta con IA (no envia nada, solo devuelve texto).
  public async suggestReply(chatId: string) {
    return this.suggestReplyService.suggestReply(chatId);
  }

  public async getConversation(chatId: string) {
    return this.crmService.getConversation(chatId);
  }

  public async updateConversation(
    chatId: string,
    data: {
      status?: ChatStatus;
      assignedAgentId?: string | null;
      unreadMessages?: number;
      contactNameOverride?: string | null;
      contactPhoneOverride?: string | null;
      archived?: boolean;
      agentTags?: unknown;
    },
  ) {
    return this.crmService.updateConversation(chatId, data);
  }

  // LYD-74: chat de la asesora con el agente IA del panel derecho.
  public async agentChat(chatId: string, body: { messages?: unknown }) {
    return this.suggestReplyService.agentChat(chatId, body);
  }

  public async deleteConversation(chatId: string) {
    return this.crmService.deleteConversation(chatId);
  }

  public async claimConversation(chatId: string, body: { agentId?: string }) {
    return this.crmService.claimConversation(chatId, body.agentId);
  }

  public async listNotes(chatId: string) {
    return this.crmService.listNotes(chatId);
  }

  public async addNote(chatId: string, data: { content: string; agentId?: string }) {
    return this.crmService.addNote(chatId, data);
  }
}
