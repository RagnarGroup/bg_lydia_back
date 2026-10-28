import { LeadsService } from '@api/services/leads.service';
import { LeadStage, LeadType } from '@prisma/client';

export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  public async listLeads(query: {
    stage?: LeadStage;
    leadType?: LeadType;
    assignedAgentId?: string;
    source?: string;
    chatId?: string;
  }) {
    return this.leadsService.listLeads(query);
  }

  public async getLead(id: string) {
    return this.leadsService.getLead(id);
  }

  public async createLead(data: Parameters<LeadsService['createLead']>[0]) {
    return this.leadsService.createLead(data);
  }

  public async updateLead(id: string, data: Parameters<LeadsService['updateLead']>[1]) {
    return this.leadsService.updateLead(id, data);
  }

  public async deleteLead(id: string) {
    return this.leadsService.deleteLead(id);
  }
}
