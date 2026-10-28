import { PrismaRepository } from '@api/repository/repository.service';
import { BadRequestException } from '@exceptions';
import { LeadActivityType, LeadStage, LeadType, Prisma } from '@prisma/client';

// LYD-11: agregados de solo lectura sobre Chat/Lead/CalendarEvent para el
// dashboard personal (PersonalDashboard.tsx). No incluye mensajesEntrantes
// por canal, lapsoMedioRespuesta ni deltasPorSemana -- esos necesitan
// calcularse sobre Message (LYD-94).
//
// LYD-93: from/to (ISO) filtran solo las metricas de flujo -- leads
// ganados/perdidos (cuando llegaron a esa etapa), fuentes (leads creados) y
// tareas (startAt). Dialogos vigentes/sin replica, leads activos y leads sin
// tareas son estado actual y no dependen del periodo.
export class InsightsService {
  constructor(private readonly prisma: PrismaRepository) {}

  public async getPersonalInsights(params: { agentId?: string; from?: string; to?: string }) {
    const { agentId } = params;
    const from = this.parseDate(params.from, 'from');
    const to = this.parseDate(params.to, 'to');
    const dateRange =
      from || to
        ? {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          }
        : undefined;
    const byAgent = agentId ? { assignedAgentId: agentId } : {};
    // LYD-115: las metricas de leads cuentan solo oportunidades de matricula
    // (no postulantes laborales, alumnos actuales ni otros).
    const leadsByAgent = { ...byAgent, leadType: LeadType.matricula };

    const [
      dialogosVigentes,
      dialogosSinReplica,
      leadsGanados,
      leadsActivos,
      leadsPerdidos,
      leadsSinTareas,
      fuentes,
      tareas,
    ] = await Promise.all([
      this.prisma.chat.count({
        where: { status: { not: 'resolved' }, ...byAgent },
      }),
      this.prisma.chat.count({
        where: { status: 'pending', ...byAgent },
      }),
      this.prisma.lead.count({
        where: { ...this.reachedStageWhere(LeadStage.matriculado, dateRange), ...leadsByAgent },
      }),
      this.prisma.lead.count({
        where: { stage: { notIn: [LeadStage.matriculado, LeadStage.venta_perdida] }, ...leadsByAgent },
      }),
      this.prisma.lead.count({
        where: { ...this.reachedStageWhere(LeadStage.venta_perdida, dateRange), ...leadsByAgent },
      }),
      this.prisma.lead.count({
        where: { hasPendingTasks: false, ...leadsByAgent },
      }),
      this.prisma.lead.groupBy({
        by: ['source'],
        where: { ...leadsByAgent, ...(dateRange ? { createdAt: dateRange } : {}) },
        _count: true,
      }),
      this.prisma.calendarEvent.count({
        where: { ...(agentId ? { agentId } : {}), ...(dateRange ? { startAt: dateRange } : {}) },
      }),
    ]);

    return {
      dialogosVigentes,
      dialogosSinReplica,
      leadsGanados: { count: leadsGanados },
      leadsActivos: { count: leadsActivos },
      leadsPerdidos: { count: leadsPerdidos },
      leadsSinTareas: { count: leadsSinTareas },
      fuentes: Object.fromEntries(fuentes.map((f) => [f.source, f._count])),
      tareas: { count: tareas },
    };
  }

  // Lead que hoy esta en `stage` y llego a ella dentro del rango. La fecha
  // sale del LeadActivity 'etapa' que la registro; los leads sin ningun
  // registro de etapa (anteriores a LYD-93, o creados directo en esa etapa)
  // caen a updatedAt como aproximacion.
  private reachedStageWhere(stage: LeadStage, dateRange?: Prisma.DateTimeFilter): Prisma.LeadWhereInput {
    if (!dateRange) return { stage };
    return {
      stage,
      OR: [
        {
          LeadActivity: {
            some: {
              type: LeadActivityType.etapa,
              createdAt: dateRange,
              meta: { path: ['to'], equals: stage },
            },
          },
        },
        {
          LeadActivity: { none: { type: LeadActivityType.etapa } },
          updatedAt: dateRange,
        },
      ],
    };
  }

  private parseDate(value: string | undefined, name: string): Date | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`Invalid "${name}" date`);
    }
    return date;
  }
}
