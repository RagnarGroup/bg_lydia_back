import { PrismaRepository } from '@api/repository/repository.service';
import { BadRequestException, NotFoundException } from '@exceptions';

import { DEFAULT_AGENT_INSTRUCTIONS } from './crm-knowledge';

export const KNOWLEDGE_CATEGORIES = [
  'programas',
  'precios',
  'horarios',
  'promociones',
  'preguntas_frecuentes',
  'tono',
  'otro',
] as const;

type KnowledgeInput = { title?: string; category?: string; content?: string; active?: boolean; updatedBy?: string };

// LYD-69: conocimiento editable del agente de sugerencias de respuesta con IA
// (seccion "Agente" de Automatizaciones). Solo las entradas activas entran al
// prompt; el gateo por rol (administrador) vive en el front, igual que el
// borrado de conversaciones.
export class AgentKnowledgeService {
  constructor(private readonly prisma: PrismaRepository) {}

  public async listKnowledge() {
    return this.prisma.agentKnowledge.findMany({ orderBy: [{ category: 'asc' }, { createdAt: 'asc' }] });
  }

  public async listActiveKnowledge() {
    return this.prisma.agentKnowledge.findMany({
      where: { active: true },
      orderBy: [{ category: 'asc' }, { createdAt: 'asc' }],
    });
  }

  public async createKnowledge(data: KnowledgeInput) {
    this.validate(data, true);
    return this.prisma.agentKnowledge.create({
      data: {
        title: data.title!.trim(),
        category: data.category!,
        content: data.content!.trim(),
        active: data.active ?? true,
        updatedBy: data.updatedBy,
      },
    });
  }

  public async updateKnowledge(id: string, data: KnowledgeInput) {
    await this.assertExists(id);
    this.validate(data, false);
    return this.prisma.agentKnowledge.update({
      where: { id },
      data: {
        title: data.title?.trim(),
        category: data.category,
        content: data.content?.trim(),
        active: data.active,
        updatedBy: data.updatedBy,
      },
    });
  }

  public async deleteKnowledge(id: string) {
    await this.assertExists(id);
    await this.prisma.agentKnowledge.delete({ where: { id } });
  }

  // Instrucciones del agente (rol, estilo, reglas): la fila "default" si
  // existe, si no las del codigo.
  public async getInstructions() {
    const row = await this.prisma.agentConfig.findUnique({ where: { id: 'default' } });
    return {
      instructions: row?.instructions ?? DEFAULT_AGENT_INSTRUCTIONS,
      isDefault: !row,
      defaultInstructions: DEFAULT_AGENT_INSTRUCTIONS,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  // Texto vacio = volver a las instrucciones por defecto.
  public async setInstructions(data: { instructions?: string; updatedBy?: string }) {
    const instructions = data?.instructions?.trim();
    if (!instructions) {
      await this.prisma.agentConfig.deleteMany({ where: { id: 'default' } });
    } else {
      await this.prisma.agentConfig.upsert({
        where: { id: 'default' },
        create: { id: 'default', instructions, updatedBy: data.updatedBy },
        update: { instructions, updatedBy: data.updatedBy },
      });
    }
    return this.getInstructions();
  }

  private validate(data: KnowledgeInput, requireAll: boolean) {
    if (requireAll && (!data?.title?.trim() || !data?.content?.trim() || !data?.category)) {
      throw new BadRequestException('title, category and content are required');
    }
    if (data?.title !== undefined && !data.title.trim()) throw new BadRequestException('title cannot be empty');
    if (data?.content !== undefined && !data.content.trim()) throw new BadRequestException('content cannot be empty');
    if (data?.category !== undefined && !(KNOWLEDGE_CATEGORIES as readonly string[]).includes(data.category)) {
      throw new BadRequestException(`category must be one of: ${KNOWLEDGE_CATEGORIES.join(', ')}`);
    }
  }

  private async assertExists(id: string) {
    const entry = await this.prisma.agentKnowledge.findUnique({ where: { id } });
    if (!entry) {
      throw new NotFoundException(`Knowledge entry "${id}" not found`);
    }
    return entry;
  }
}
