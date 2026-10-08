import { PrismaRepository } from '@api/repository/repository.service';
import { BadRequestException, NotFoundException } from '@exceptions';
import { LeadStage } from '@prisma/client';

// LYD-8: pipeline de ventas de Lydia. Lead es su propia entidad (no una
// extension de Chat) porque puede existir sin conversacion de WhatsApp
// todavia (carga manual, ver Lead.chatId opcional en el schema).
export class LeadsService {
  constructor(private readonly prisma: PrismaRepository) {}

  public async listLeads(params: { stage?: LeadStage; assignedAgentId?: string; source?: string; chatId?: string }) {
    const { stage, assignedAgentId, source, chatId } = params;
    return this.prisma.lead.findMany({
      where: {
        ...(stage ? { stage } : {}),
        ...(assignedAgentId ? { assignedAgentId } : {}),
        ...(source ? { source } : {}),
        // LYD-20: Lead.chatId es @unique -- a lo sumo un resultado, sirve
        // para saber si esta conversacion ya tiene un lead de pipeline.
        ...(chatId ? { chatId } : {}),
      },
      include: { Agent: true, Chat: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  public async getLead(id: string) {
    return this.assertLeadExists(id);
  }

  public async createLead(data: {
    contactName: string;
    company?: string;
    phone?: string;
    email?: string;
    position?: string;
    source: string;
    budget?: string;
    budgetAmount?: number;
    stage?: LeadStage;
    observations?: string;
    chatId?: string;
    assignedAgentId?: string;
  }) {
    return this.insertLead(data);
  }

  // LYD-12: bypass para cargas historicas (ej. migracion de Kommo) -- sin
  // esto Prisma pone NOW() en el create y se pierde la fecha real. A
  // proposito NO esta expuesto en createLead/POST /crm/leads (ahi solo
  // llega el apikey compartido como guarda, cualquier caller podria
  // backdatear un lead) -- es para uso directo de un futuro script de
  // migracion contra este service, nunca por HTTP.
  public async createHistoricalLead(
    data: Parameters<LeadsService['createLead']>[0] & { createdAt: Date; updatedAt: Date },
  ) {
    return this.insertLead(data, { createdAt: data.createdAt, updatedAt: data.updatedAt });
  }

  private async insertLead(
    data: {
      contactName: string;
      company?: string;
      phone?: string;
      email?: string;
      position?: string;
      source: string;
      budget?: string;
      budgetAmount?: number;
      stage?: LeadStage;
      observations?: string;
      chatId?: string;
      assignedAgentId?: string;
    },
    historicalDates?: { createdAt: Date; updatedAt: Date },
  ) {
    if (!data?.contactName?.trim()) {
      throw new BadRequestException('contactName is required');
    }
    if (!data?.source?.trim()) {
      throw new BadRequestException('source is required');
    }
    this.assertValidStage(data.stage);

    if (data.assignedAgentId) {
      const agent = await this.prisma.agent.findUnique({ where: { id: data.assignedAgentId } });
      if (!agent) {
        throw new BadRequestException(`Agent "${data.assignedAgentId}" not found`);
      }
    }
    if (data.chatId) {
      const chat = await this.prisma.chat.findUnique({ where: { id: data.chatId } });
      if (!chat) {
        throw new BadRequestException(`Chat "${data.chatId}" not found`);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // No hay secuencia nativa para un id de texto (cuid) -- generamos el
      // consecutivo dentro de la misma transaccion que el insert para
      // evitar que dos creaciones concurrentes pisen el mismo numero.
      // LYD-72: se parte del mayor numero usado, no de count() -- al borrar
      // un lead el count baja y LD-{count+1} chocaba con uno existente.
      const existing = await tx.lead.findMany({ select: { leadNumber: true } });
      const lastNumber = existing.reduce((max, { leadNumber }) => {
        const n = Number(leadNumber.replace(/^LD-/, ''));
        return Number.isInteger(n) && n > max ? n : max;
      }, 0);
      return tx.lead.create({
        data: {
          contactName: data.contactName,
          company: data.company,
          phone: data.phone,
          email: data.email,
          position: data.position,
          source: data.source,
          budget: data.budget,
          budgetAmount: data.budgetAmount ?? 0,
          // LYD-71: antes se ignoraba y todo lead nuevo quedaba en
          // contacto_inicial, aunque el panel del chat lo creara al elegir
          // otro estado.
          stage: data.stage,
          observations: data.observations,
          chatId: data.chatId ?? null,
          assignedAgentId: data.assignedAgentId ?? null,
          leadNumber: `LD-${lastNumber + 1}`,
          ...(historicalDates ?? {}),
        },
        include: { Agent: true, Chat: true },
      });
    });
  }

  public async updateLead(
    id: string,
    data: {
      stage?: LeadStage;
      assignedAgentId?: string | null;
      contactName?: string;
      company?: string;
      phone?: string;
      email?: string;
      position?: string;
      source?: string;
      budget?: string;
      budgetAmount?: number;
      observations?: string;
      hasPendingTasks?: boolean;
      chatId?: string | null;
    },
  ) {
    await this.assertLeadExists(id);
    this.assertValidStage(data.stage);

    if (data.assignedAgentId) {
      const agent = await this.prisma.agent.findUnique({ where: { id: data.assignedAgentId } });
      if (!agent) {
        throw new BadRequestException(`Agent "${data.assignedAgentId}" not found`);
      }
    }

    return this.prisma.lead.update({
      where: { id },
      data,
      include: { Agent: true, Chat: true },
    });
  }

  public async deleteLead(id: string) {
    await this.assertLeadExists(id);
    await this.prisma.lead.delete({ where: { id } });
  }

  private assertValidStage(stage?: LeadStage) {
    if (stage !== undefined && !Object.values(LeadStage).includes(stage)) {
      throw new BadRequestException(`Invalid stage "${stage}"`);
    }
  }

  private async assertLeadExists(id: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id }, include: { Agent: true, Chat: true } });
    if (!lead) {
      throw new NotFoundException(`Lead "${id}" not found`);
    }
    return lead;
  }
}
