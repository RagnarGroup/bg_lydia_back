import { PrismaRepository } from '@api/repository/repository.service';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@exceptions';
import { LeadActivityType, LeadStage, LeadVisitStatus, Prisma } from '@prisma/client';

import {
  LANDING_DEFAULT_TAG,
  LANDING_NIVEL_LABEL,
  LANDING_PROGRAMAS,
  LANDING_PROGRAMAS_CONSULTA,
  LANDING_SEDE_CIUDAD,
  LANDING_SEDES,
  LANDING_SOURCE,
  LANDING_TIPO_CONSULTA,
  LANDING_TZ_OFFSET,
  LandingSede,
} from './landing-leads.constants';
import { nextLeadNumber } from './leads.service';

// LYD-83: leads que llegan de la landing (visitas solicitadas). Cola
// compartida: ningun lead se asigna solo, la asesora de la sede lo toma.
// Trazabilidad en LeadActivity.

const HOUR_MS = 60 * 60 * 1000;
const MAX_LIST = 500;
const MAX_NOTE = 5000;
const UNCLAIMED_STATUSES: LeadVisitStatus[] = [LeadVisitStatus.solicitada, LeadVisitStatus.reprogramada];
const CLOSING_STATUSES: LeadVisitStatus[] = [
  LeadVisitStatus.asistio,
  LeadVisitStatus.no_asistio,
  LeadVisitStatus.cancelada,
];

const MAX_TAGS = 10;
const TAG_REGEX = /^[A-Z0-9_]{1,50}$/;
const ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'referrer',
  'landing_url',
] as const;
const MAX_ATTRIBUTION_VALUE = 500;

const agentSelect = { id: true, name: true, color: true } as const;

type LeadWithList = Prisma.LeadGetPayload<{
  include: { Agent: { select: typeof agentSelect }; LeadActivity: { select: { createdAt: true } } };
}>;

export type LandingLeadCreateBody = {
  externalId?: string;
  programa: string;
  sede: string;
  nombre: string;
  whatsapp: string;
  correo?: string;
  fecha: string;
  hora: string;
  pageUrl?: string;
  // LYD-87: opcionales (campana Au Pair); el body de la landing de inscripciones no los manda.
  edad?: number;
  nivelIngles?: string;
  tags?: string[];
  attribution?: Record<string, unknown>;
};

// LYD-100: consulta sin visita (tipo: "consulta"). Sin sede, fecha ni hora;
// el correo es obligatorio porque es lo que identifica a la persona.
export type LandingConsultaBody = {
  tipo: 'consulta';
  externalId?: string;
  programa: string;
  nombre: string;
  correo: string;
  whatsapp?: string;
  pageUrl?: string;
  tags?: string[];
  attribution?: Record<string, unknown>;
  // Datos propios de la consulta: se guardan legibles en observations y
  // estructurados en el historial (LeadActivity.meta.detalle).
  detalle?: { opcion?: string; precio?: string; mesInicio?: string; pais?: string; nivel?: string };
};

// Orden y etiqueta de cada dato de la consulta en las observaciones del lead.
// La de "nivel" se reemplaza por la del programa (LANDING_NIVEL_LABEL).
const DETALLE_FIELDS: [keyof NonNullable<LandingConsultaBody['detalle']>, string, number][] = [
  ['opcion', 'Opción', 80],
  ['precio', 'Precio', 30],
  ['mesInicio', 'Mes de inicio', 30],
  ['pais', 'País', 80],
  ['nivel', 'Nivel', 30],
];

export class LandingLeadsService {
  constructor(private readonly prisma: PrismaRepository) {}

  // ---------- Publico ----------

  public async createFromLanding(body: LandingLeadCreateBody | LandingConsultaBody) {
    if (body && typeof body === 'object' && (body as { tipo?: unknown }).tipo === LANDING_TIPO_CONSULTA) {
      return this.createConsulta(body as LandingConsultaBody);
    }
    const input = this.validateCreateBody(body as LandingLeadCreateBody);

    if (input.externalId) {
      const existing = await this.prisma.lead.findUnique({
        where: { externalId: input.externalId },
        select: { id: true, leadNumber: true },
      });
      if (existing) return { created: false as const, id: existing.id, leadNumber: existing.leadNumber };
    }

    try {
      const lead = await this.prisma.$transaction(async (tx) => {
        const leadNumber = await nextLeadNumber(tx);
        const created = await tx.lead.create({
          data: {
            leadNumber,
            source: LANDING_SOURCE,
            contactName: input.nombre,
            phone: input.whatsapp,
            email: input.correo,
            stage: LeadStage.contacto_inicial,
            sede: input.sede,
            programa: input.programa,
            visitAt: input.visitAt,
            visitStatus: LeadVisitStatus.solicitada,
            externalId: input.externalId,
            assignedAgentId: null,
            observations: input.observations,
            tags: input.tags,
            ...(input.attribution ? { attribution: input.attribution } : {}),
          },
          select: { id: true, leadNumber: true },
        });
        await tx.calendarEvent.create({
          data: {
            type: 'reserva',
            leadId: created.id,
            agentId: null,
            startAt: input.visitAt,
            endAt: new Date(input.visitAt.getTime() + HOUR_MS),
            note: `Visita solicitada · Sede ${input.sede} · Programa ${input.programa} · ${input.nombre}`,
          },
        });
        await tx.leadActivity.create({
          data: {
            leadId: created.id,
            type: LeadActivityType.creado,
            meta: { origen: 'landing', ...(input.tags.length ? { tags: input.tags } : {}) },
          },
        });
        return created;
      });
      return { created: true as const, id: lead.id, leadNumber: lead.leadNumber };
    } catch (err) {
      // Dos envios simultaneos con el mismo externalId: gana uno, el otro es duplicado.
      if (input.externalId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.lead.findUnique({
          where: { externalId: input.externalId },
          select: { id: true, leadNumber: true },
        });
        if (existing) return { created: false as const, id: existing.id, leadNumber: existing.leadNumber };
      }
      throw err;
    }
  }

  // LYD-100: una persona = un lead por programa. Si el mismo email vuelve a
  // consultar el mismo programa, no se crea otro lead: se registra la nueva
  // consulta en el historial del que ya existe y se actualizan sus datos.
  // La atribución del lead se queda con la del primer contacto (first-touch);
  // la de cada consulta nueva queda en el historial.
  private async createConsulta(body: LandingConsultaBody) {
    const input = this.validateConsultaBody(body);

    if (input.externalId) {
      // Reintento de un envío que ya creó el lead...
      const byLead = await this.prisma.lead.findUnique({
        where: { externalId: input.externalId },
        select: { id: true, leadNumber: true },
      });
      if (byLead) return { created: false as const, id: byLead.id, leadNumber: byLead.leadNumber };
      // ...o que ya se registró como consulta repetida sobre otro lead.
      const byActivity = await this.prisma.leadActivity.findFirst({
        where: { type: LeadActivityType.consulta, meta: { path: ['externalId'], equals: input.externalId } },
        select: { Lead: { select: { id: true, leadNumber: true } } },
      });
      if (byActivity?.Lead) {
        return { created: false as const, id: byActivity.Lead.id, leadNumber: byActivity.Lead.leadNumber };
      }
    }

    const existing = await this.prisma.lead.findFirst({
      where: {
        source: LANDING_SOURCE,
        programa: input.programa,
        email: { equals: input.correo, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, leadNumber: true, tags: true, phone: true },
    });

    if (existing) {
      await this.prisma.$transaction(async (tx) => {
        await tx.lead.update({
          where: { id: existing.id },
          data: {
            tags: [...new Set([...existing.tags, ...input.tags])],
            observations: input.observations,
            ...(input.whatsapp && !existing.phone ? { phone: input.whatsapp } : {}),
          },
        });
        await tx.leadActivity.create({
          data: {
            leadId: existing.id,
            type: LeadActivityType.consulta,
            meta: {
              origen: 'landing',
              tipo: LANDING_TIPO_CONSULTA,
              ...(input.externalId ? { externalId: input.externalId } : {}),
              ...(input.detalle ? { detalle: input.detalle } : {}),
              ...(input.attribution ? { attribution: input.attribution } : {}),
            },
          },
        });
      });
      return { created: false as const, id: existing.id, leadNumber: existing.leadNumber };
    }

    try {
      const lead = await this.prisma.$transaction(async (tx) => {
        const leadNumber = await nextLeadNumber(tx);
        const created = await tx.lead.create({
          data: {
            leadNumber,
            source: LANDING_SOURCE,
            contactName: input.nombre,
            phone: input.whatsapp ?? null,
            email: input.correo,
            stage: LeadStage.contacto_inicial,
            sede: null,
            programa: input.programa,
            visitAt: null,
            visitStatus: null,
            externalId: input.externalId,
            assignedAgentId: null,
            observations: input.observations,
            tags: input.tags,
            ...(input.attribution ? { attribution: input.attribution } : {}),
          },
          select: { id: true, leadNumber: true },
        });
        await tx.leadActivity.create({
          data: {
            leadId: created.id,
            type: LeadActivityType.creado,
            meta: {
              origen: 'landing',
              tipo: LANDING_TIPO_CONSULTA,
              tags: input.tags,
              ...(input.detalle ? { detalle: input.detalle } : {}),
            },
          },
        });
        return created;
      });
      return { created: true as const, id: lead.id, leadNumber: lead.leadNumber };
    } catch (err) {
      if (input.externalId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const again = await this.prisma.lead.findUnique({
          where: { externalId: input.externalId },
          select: { id: true, leadNumber: true },
        });
        if (again) return { created: false as const, id: again.id, leadNumber: again.leadNumber };
      }
      throw err;
    }
  }

  // ---------- CRM ----------

  public async list(params: {
    sede?: string;
    visitStatus?: string;
    from?: string;
    to?: string;
    unclaimed?: string;
    search?: string;
    programa?: string;
    tag?: string;
    // LYD-100: "visita" (leads con visita a sede) o "consulta" (sin visita).
    tipo?: string;
  }) {
    const { sede, visitStatus, from, to, unclaimed, search, programa, tag, tipo } = params;
    if (visitStatus) this.assertVisitStatus(visitStatus);
    if (tipo !== undefined && tipo !== 'visita' && tipo !== LANDING_TIPO_CONSULTA) {
      throw new BadRequestException('tipo must be one of: visita, consulta');
    }

    const visitAt: Prisma.DateTimeNullableFilter = {};
    if (from) visitAt.gte = this.parseRangeDate(from, 'from', false);
    if (to) visitAt.lte = this.parseRangeDate(to, 'to', true);

    const where: Prisma.LeadWhereInput = { source: LANDING_SOURCE };
    if (sede) where.sede = sede;
    if (programa) where.programa = programa;
    if (tag) where.tags = { has: tag };
    if (visitStatus) where.visitStatus = visitStatus as LeadVisitStatus;
    if (tipo === LANDING_TIPO_CONSULTA) where.visitStatus = null;
    if (tipo === 'visita' && !visitStatus) where.visitStatus = { not: null };
    if (visitAt.gte || visitAt.lte) where.visitAt = visitAt;
    const and: Prisma.LeadWhereInput[] = [];
    if (unclaimed === 'true') {
      // Misma definicion que /summary, para que el contador y la lista coincidan:
      // visitas pendientes de atender y consultas (LYD-100) sin agente.
      where.assignedAgentId = null;
      if (!visitStatus && tipo !== LANDING_TIPO_CONSULTA) and.push(this.unclaimedVisitFilter());
    }
    const term = search?.trim();
    if (term) {
      and.push({
        OR: [
          { contactName: { contains: term, mode: 'insensitive' } },
          { phone: { contains: term, mode: 'insensitive' } },
          { email: { contains: term, mode: 'insensitive' } },
          { leadNumber: { contains: term, mode: 'insensitive' } },
        ],
      });
    }
    if (and.length) where.AND = and;

    const leads = await this.prisma.lead.findMany({
      where,
      include: {
        Agent: { select: agentSelect },
        LeadActivity: { select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_LIST,
    });
    return leads.map((l) => this.toLandingLead(l));
  }

  public async summary() {
    const unclaimedWhere: Prisma.LeadWhereInput = {
      source: LANDING_SOURCE,
      assignedAgentId: null,
      ...this.unclaimedVisitFilter(),
    };
    const consultaWhere: Prisma.LeadWhereInput = { source: LANDING_SOURCE, visitStatus: null };
    const [totals, unclaimedBySede, unclaimed, consultasTotal, consultasUnclaimed] = await Promise.all([
      this.prisma.lead.groupBy({ by: ['sede'], where: { source: LANDING_SOURCE }, _count: { _all: true } }),
      this.prisma.lead.groupBy({ by: ['sede'], where: unclaimedWhere, _count: { _all: true } }),
      this.prisma.lead.count({ where: unclaimedWhere }),
      this.prisma.lead.count({ where: consultaWhere }),
      this.prisma.lead.count({ where: { ...consultaWhere, assignedAgentId: null } }),
    ]);

    const bySede: Record<string, { unclaimed: number; total: number }> = {};
    for (const s of LANDING_SEDES) bySede[s] = { unclaimed: 0, total: 0 };
    for (const t of totals) {
      if (!t.sede) continue;
      (bySede[t.sede] ??= { unclaimed: 0, total: 0 }).total = t._count._all;
    }
    for (const u of unclaimedBySede) {
      if (!u.sede) continue;
      (bySede[u.sede] ??= { unclaimed: 0, total: 0 }).unclaimed = u._count._all;
    }
    // Las consultas (LYD-100) no tienen sede: van aparte, y "unclaimed" las incluye.
    return { unclaimed, bySede, consultas: { unclaimed: consultasUnclaimed, total: consultasTotal } };
  }

  public async getDetail(id: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, source: LANDING_SOURCE },
      include: {
        Agent: { select: agentSelect },
        LeadActivity: { include: { Agent: { select: agentSelect } }, orderBy: { createdAt: 'asc' } },
        CalendarEvent: { orderBy: { startAt: 'asc' } },
      },
    });
    if (!lead) throw new NotFoundException(`Landing lead "${id}" not found`);

    const lastActivity = lead.LeadActivity[lead.LeadActivity.length - 1];
    return {
      ...this.toLandingLead({ ...lead, LeadActivity: lastActivity ? [lastActivity] : [] }),
      observations: lead.observations,
      attribution: lead.attribution,
      activities: lead.LeadActivity.map((a) => ({
        id: a.id,
        type: a.type,
        content: a.content,
        meta: a.meta,
        createdAt: a.createdAt,
        agent: a.Agent,
      })),
      calendarEvents: lead.CalendarEvent.map((e) => ({
        id: e.id,
        startAt: e.startAt,
        endAt: e.endAt,
        completed: e.completed,
        note: e.note,
      })),
    };
  }

  public async claim(id: string, agentId: unknown) {
    const agent = await this.requireActiveAgent(agentId);
    await this.prisma.$transaction(async (tx) => {
      const lead = await this.requireLandingLead(tx, id);
      if (lead.assignedAgentId === agent.id) return;
      if (lead.assignedAgentId) {
        const owner = await tx.agent.findUnique({ where: { id: lead.assignedAgentId }, select: { name: true } });
        throw new ConflictException(`Lead ya tomado por ${owner?.name ?? 'otro agente'}`);
      }
      // Condicion en el UPDATE: si dos asesoras lo toman a la vez, solo una lo consigue.
      const { count } = await tx.lead.updateMany({
        where: { id, assignedAgentId: null },
        data: { assignedAgentId: agent.id },
      });
      if (count === 0) {
        const current = await tx.lead.findUnique({ where: { id }, include: { Agent: true } });
        if (current?.assignedAgentId === agent.id) return;
        throw new ConflictException(`Lead ya tomado por ${current?.Agent?.name ?? 'otro agente'}`);
      }
      await tx.calendarEvent.updateMany({ where: { leadId: id, type: 'reserva' }, data: { agentId: agent.id } });
      await tx.leadActivity.create({ data: { leadId: id, agentId: agent.id, type: LeadActivityType.tomado } });
    });
    return this.getDetail(id);
  }

  public async release(id: string, agentId: unknown) {
    const agent = await this.requireActiveAgent(agentId);
    await this.prisma.$transaction(async (tx) => {
      const lead = await this.requireLandingLead(tx, id);
      if (!lead.assignedAgentId) return; // ya libre
      if (lead.assignedAgentId !== agent.id && agent.role !== 'administrador') {
        throw new ForbiddenException('Solo el agente asignado o un administrador puede liberar el lead');
      }
      await tx.lead.update({ where: { id }, data: { assignedAgentId: null } });
      await tx.calendarEvent.updateMany({ where: { leadId: id, type: 'reserva' }, data: { agentId: null } });
      await tx.leadActivity.create({
        data: {
          leadId: id,
          agentId: agent.id,
          type: LeadActivityType.liberado,
          meta: { previousAgentId: lead.assignedAgentId },
        },
      });
    });
    return this.getDetail(id);
  }

  public async updateVisit(
    id: string,
    body: { agentId?: unknown; status?: unknown; visitAt?: unknown; note?: unknown },
  ) {
    const agent = await this.requireActiveAgent(body?.agentId);
    const status = this.assertVisitStatus(body?.status);
    let newVisitAt: Date | null = null;
    if (body?.visitAt !== undefined && body?.visitAt !== null && body?.visitAt !== '') {
      newVisitAt = this.parseIsoInstant(body.visitAt, 'visitAt');
    }
    if (status === LeadVisitStatus.reprogramada && !newVisitAt) {
      throw new BadRequestException('visitAt is required when status is "reprogramada"');
    }
    const note = this.optionalText(body?.note, 'note', MAX_NOTE);

    await this.prisma.$transaction(async (tx) => {
      const lead = await this.requireLandingLead(tx, id);
      if (!lead.visitStatus) {
        throw new BadRequestException('Este lead es una consulta sin visita a sede: no tiene visita que cambiar');
      }

      if (!lead.assignedAgentId) {
        await tx.lead.update({ where: { id }, data: { assignedAgentId: agent.id } });
        await tx.calendarEvent.updateMany({ where: { leadId: id, type: 'reserva' }, data: { agentId: agent.id } });
        await tx.leadActivity.create({
          data: { leadId: id, agentId: agent.id, type: LeadActivityType.tomado, meta: { auto: true } },
        });
      }

      // Solo reprogramada y confirmada pueden cambiar la fecha.
      const moveTo =
        newVisitAt && (status === LeadVisitStatus.reprogramada || status === LeadVisitStatus.confirmada)
          ? newVisitAt
          : null;
      await tx.lead.update({
        where: { id },
        data: { visitStatus: status, ...(moveTo ? { visitAt: moveTo } : {}) },
      });
      await tx.calendarEvent.updateMany({
        where: { leadId: id, type: 'reserva' },
        data: {
          completed: CLOSING_STATUSES.includes(status),
          ...(moveTo ? { startAt: moveTo, endAt: new Date(moveTo.getTime() + HOUR_MS) } : {}),
        },
      });

      const fromAt = lead.visitAt ? lead.visitAt.toISOString() : null;
      if (status === LeadVisitStatus.reprogramada && moveTo) {
        await tx.leadActivity.create({
          data: {
            leadId: id,
            agentId: agent.id,
            type: LeadActivityType.reprogramada,
            content: note,
            meta: { from: fromAt, to: moveTo.toISOString() },
          },
        });
      } else {
        await tx.leadActivity.create({
          data: {
            leadId: id,
            agentId: agent.id,
            type: LeadActivityType.estado_visita,
            content: note,
            meta: {
              from: lead.visitStatus,
              to: status,
              ...(moveTo ? { visitAtFrom: fromAt, visitAtTo: moveTo.toISOString() } : {}),
            },
          },
        });
      }
    });
    return this.getDetail(id);
  }

  public async addNote(id: string, body: { agentId?: unknown; content?: unknown }) {
    const agent = await this.requireActiveAgent(body?.agentId);
    if (typeof body?.content !== 'string' || !body.content.trim()) {
      throw new BadRequestException('content is required');
    }
    if (body.content.length > MAX_NOTE) {
      throw new BadRequestException(`content must be at most ${MAX_NOTE} characters`);
    }
    await this.requireLandingLead(this.prisma, id);
    const activity = await this.prisma.leadActivity.create({
      data: { leadId: id, agentId: agent.id, type: LeadActivityType.nota, content: body.content.trim() },
      include: { Agent: { select: agentSelect } },
    });
    return {
      id: activity.id,
      type: activity.type,
      content: activity.content,
      meta: activity.meta,
      createdAt: activity.createdAt,
      agent: activity.Agent,
    };
  }

  public async changeStage(id: string, body: { agentId?: unknown; stage?: unknown }) {
    const agent = await this.requireActiveAgent(body?.agentId);
    if (typeof body?.stage !== 'string' || !Object.values(LeadStage).includes(body.stage as LeadStage)) {
      throw new BadRequestException(`stage must be one of: ${Object.values(LeadStage).join(', ')}`);
    }
    const stage = body.stage as LeadStage;
    await this.prisma.$transaction(async (tx) => {
      const lead = await this.requireLandingLead(tx, id);
      if (lead.stage === stage) return;
      await tx.lead.update({ where: { id }, data: { stage } });
      await tx.leadActivity.create({
        data: { leadId: id, agentId: agent.id, type: LeadActivityType.etapa, meta: { from: lead.stage, to: stage } },
      });
    });
    return this.getDetail(id);
  }

  // ---------- Helpers ----------

  private toLandingLead(l: LeadWithList) {
    return {
      id: l.id,
      leadNumber: l.leadNumber,
      contactName: l.contactName,
      phone: l.phone,
      email: l.email,
      sede: l.sede,
      ciudad: l.sede ? ((LANDING_SEDE_CIUDAD as Record<string, string>)[l.sede] ?? null) : null,
      programa: l.programa,
      // LYD-100: las consultas no tienen visita (visitStatus null).
      tipo: l.visitStatus ? 'visita' : LANDING_TIPO_CONSULTA,
      tags: l.tags,
      visitAt: l.visitAt ? l.visitAt.toISOString() : null,
      visitStatus: l.visitStatus,
      stage: l.stage,
      assignedAgent: l.Agent ? { id: l.Agent.id, name: l.Agent.name, color: l.Agent.color } : null,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      lastActivityAt: l.LeadActivity[0]?.createdAt ?? l.updatedAt,
    };
  }

  // Sin agente y pendiente de atender: visita solicitada o reprogramada, o
  // consulta sin visita (LYD-100).
  private unclaimedVisitFilter(): Prisma.LeadWhereInput {
    return { OR: [{ visitStatus: { in: UNCLAIMED_STATUSES } }, { visitStatus: null }] };
  }

  private async requireLandingLead(db: Pick<Prisma.TransactionClient, 'lead'>, id: string) {
    const lead = await db.lead.findFirst({ where: { id, source: LANDING_SOURCE } });
    if (!lead) throw new NotFoundException(`Landing lead "${id}" not found`);
    return lead;
  }

  private async requireActiveAgent(agentId: unknown) {
    if (typeof agentId !== 'string' || !agentId.trim()) throw new BadRequestException('agentId is required');
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new BadRequestException(`Agent "${agentId}" not found`);
    if (!agent.active) throw new BadRequestException(`Agent "${agentId}" is not active`);
    return agent;
  }

  private assertVisitStatus(status: unknown): LeadVisitStatus {
    if (typeof status !== 'string' || !Object.values(LeadVisitStatus).includes(status as LeadVisitStatus)) {
      throw new BadRequestException(`status must be one of: ${Object.values(LeadVisitStatus).join(', ')}`);
    }
    return status as LeadVisitStatus;
  }

  private optionalText(value: unknown, field: string, max: number): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') throw new BadRequestException(`${field} must be a string`);
    if (value.length > max) throw new BadRequestException(`${field} must be at most ${max} characters`);
    return value.trim() || undefined;
  }

  private parseIsoInstant(value: unknown, field: string): Date {
    const d = typeof value === 'string' ? new Date(value) : new Date(NaN);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} must be a valid ISO date`);
    return d;
  }

  // YYYY-MM-DD se interpreta en hora de Lima (inicio o fin del dia); un ISO completo se respeta tal cual.
  private parseRangeDate(value: string, field: string, endOfDay: boolean): Date {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const d = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}${LANDING_TZ_OFFSET}`);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return this.parseIsoInstant(value, field);
  }

  private requiredString(value: unknown, field: string, max: number): string {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required`);
    const v = value.trim();
    if (v.length > max) throw new BadRequestException(`${field} must be at most ${max} characters`);
    return v;
  }

  private validateCreateBody(body: LandingLeadCreateBody) {
    if (!body || typeof body !== 'object') throw new BadRequestException('body is required');

    const programa = this.requiredString(body.programa, 'programa', 30);
    if (!(LANDING_PROGRAMAS as readonly string[]).includes(programa)) {
      throw new BadRequestException(`programa must be one of: ${LANDING_PROGRAMAS.join(', ')}`);
    }
    const sede = this.requiredString(body.sede, 'sede', 50) as LandingSede;
    if (!LANDING_SEDES.includes(sede)) {
      throw new BadRequestException(`sede must be one of: ${LANDING_SEDES.join(', ')}`);
    }
    const nombre = this.requiredString(body.nombre, 'nombre', 100);
    const whatsapp = this.requiredString(body.whatsapp, 'whatsapp', 50);
    const correo = this.optionalText(body.correo, 'correo', 255);
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
      throw new BadRequestException('correo is not a valid email');
    }
    const externalId = this.optionalText(body.externalId, 'externalId', 120);
    const pageUrl = this.optionalText(body.pageUrl, 'pageUrl', 500);

    const fecha = this.requiredString(body.fecha, 'fecha', 10);
    const hora = this.requiredString(body.hora, 'hora', 5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new BadRequestException('fecha must be YYYY-MM-DD');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) throw new BadRequestException('hora must be HH:MM (24h)');
    const visitAt = new Date(`${fecha}T${hora}:00${LANDING_TZ_OFFSET}`);
    // Rechaza fechas imposibles (2026-02-31 se desborda a marzo en vez de dar NaN).
    if (
      Number.isNaN(visitAt.getTime()) ||
      new Date(visitAt.getTime() - 5 * HOUR_MS).toISOString().slice(0, 10) !== fecha
    ) {
      throw new BadRequestException('fecha is not a valid date');
    }

    const edad = this.optionalAge(body.edad);
    const nivelIngles = this.optionalText(body.nivelIngles, 'nivelIngles', 30);
    const explicitTags = this.optionalTags(body.tags);
    const tags = explicitTags.length ? explicitTags : [LANDING_DEFAULT_TAG];
    const attribution = this.optionalAttribution(body.attribution);
    const observations =
      [
        edad !== undefined ? `Edad: ${edad}` : null,
        nivelIngles ? `Nivel de inglés: ${nivelIngles}` : null,
        pageUrl ? `Origen: ${pageUrl}` : null,
      ]
        .filter(Boolean)
        .join(' · ') || null;

    return { programa, sede, nombre, whatsapp, correo, externalId, pageUrl, visitAt, tags, attribution, observations };
  }

  private validateConsultaBody(body: LandingConsultaBody) {
    const programa = this.requiredString(body.programa, 'programa', 30);
    if (!(LANDING_PROGRAMAS_CONSULTA as readonly string[]).includes(programa)) {
      throw new BadRequestException(`programa must be one of: ${LANDING_PROGRAMAS_CONSULTA.join(', ')}`);
    }
    const nombre = this.requiredString(body.nombre, 'nombre', 100);
    const correo = this.requiredString(body.correo, 'correo', 255).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) throw new BadRequestException('correo is not a valid email');
    const whatsapp = this.optionalText(body.whatsapp, 'whatsapp', 50);
    const externalId = this.optionalText(body.externalId, 'externalId', 120);
    const pageUrl = this.optionalText(body.pageUrl, 'pageUrl', 500);
    const tags = this.optionalTags(body.tags);
    const attribution = this.optionalAttribution(body.attribution);
    const detalle = this.optionalDetalle(body.detalle);
    const nivelLabel = LANDING_NIVEL_LABEL[programa as keyof typeof LANDING_NIVEL_LABEL];
    const observations =
      [
        ...DETALLE_FIELDS.map(([key, label]) =>
          detalle?.[key] ? `${key === 'nivel' ? nivelLabel : label}: ${detalle[key]}` : null,
        ),
        pageUrl ? `Origen: ${pageUrl}` : null,
      ]
        .filter(Boolean)
        .join(' · ') || null;

    return { programa, nombre, correo, whatsapp, externalId, tags, attribution, detalle, observations };
  }

  // Solo los campos conocidos de la consulta, como texto acotado; el resto se ignora.
  private optionalDetalle(value: unknown): Record<string, string> | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('detalle must be an object');
    const src = value as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, , max] of DETALLE_FIELDS) {
      const v = this.optionalText(src[key], `detalle.${key}`, max);
      if (v) out[key] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }

  private optionalAge(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 17 || value > 99) {
      throw new BadRequestException('edad must be an integer between 17 and 99');
    }
    return value;
  }

  private optionalTags(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new BadRequestException('tags must be an array');
    if (value.length > MAX_TAGS) throw new BadRequestException(`tags must have at most ${MAX_TAGS} items`);
    for (const t of value) {
      if (typeof t !== 'string' || !TAG_REGEX.test(t)) {
        throw new BadRequestException('each tag must match /^[A-Z0-9_]{1,50}$/');
      }
    }
    return [...new Set(value as string[])];
  }

  // Solo las keys conocidas; el resto se ignora. Sin ninguna key valida no se guarda nada.
  private optionalAttribution(value: unknown): Record<string, string> | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value))
      throw new BadRequestException('attribution must be an object');
    const src = value as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const key of ATTRIBUTION_KEYS) {
      const v = src[key];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v !== 'string') throw new BadRequestException(`attribution.${key} must be a string`);
      if (v.length > MAX_ATTRIBUTION_VALUE) {
        throw new BadRequestException(`attribution.${key} must be at most ${MAX_ATTRIBUTION_VALUE} characters`);
      }
      const t = v.trim();
      if (t) out[key] = t;
    }
    return Object.keys(out).length ? out : undefined;
  }
}
