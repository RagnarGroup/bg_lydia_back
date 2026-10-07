import { AgentKnowledgeService } from '@api/services/agent-knowledge.service';
import { CrmSuggestReplyService } from '@api/services/crm-suggest-reply.service';

// LYD-69: seccion "Agente" de Automatizaciones (conocimiento editable +
// instrucciones + prueba de sugerencia sin chat).
export class AgentController {
  constructor(
    private readonly knowledgeService: AgentKnowledgeService,
    private readonly suggestReplyService: CrmSuggestReplyService,
  ) {}

  public listKnowledge() {
    return this.knowledgeService.listKnowledge();
  }

  public createKnowledge(data: Parameters<AgentKnowledgeService['createKnowledge']>[0]) {
    return this.knowledgeService.createKnowledge(data);
  }

  public updateKnowledge(id: string, data: Parameters<AgentKnowledgeService['updateKnowledge']>[1]) {
    return this.knowledgeService.updateKnowledge(id, data);
  }

  public deleteKnowledge(id: string) {
    return this.knowledgeService.deleteKnowledge(id);
  }

  public getInstructions() {
    return this.knowledgeService.getInstructions();
  }

  public setInstructions(data: { instructions?: string; updatedBy?: string }) {
    return this.knowledgeService.setInstructions(data);
  }

  public testSuggestion(message: string) {
    return this.suggestReplyService.suggestForMessage(message);
  }
}
