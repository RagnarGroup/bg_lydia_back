import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import { BadRequestException, NotFoundException } from '@exceptions';
import { MessageAuthorKind, Prisma } from '@prisma/client';
import cron from 'node-cron';

import { AuditMailer } from './audit-mailer';
import { buildAuditReportHtml, escapeHtml, ReportAudit } from './audit-report';
import { AuditLevel, CRITERIA, LEVELS, points } from './audit-rubric';
import { anonymize, auditMessageText, clientAlias, isVoiceNote, nameTokens } from './audit-text';

// LYD-102: auditoria comercial diaria META K-01. Solo lectura sobre las
// conversaciones: nunca envia nada a clientes.
//
// - 21:00 (Lima): evalua las conversaciones donde escribio una asesora en la
//   ventana 21:00 de ayer -> 21:00 de hoy (lo posterior entra al dia siguiente).
// - 22:00: manda el reporte a Direccion. Si la evaluacion termina despues, se
//   manda apenas termina.
// - 23:30: si todavia no salio, aviso de "reporte no generado".

const TIMEZONE = 'America/Lima';
// Peru no tiene horario de verano: UTC-5 fijo.
const LIMA_OFFSET_HOURS = -5;
const CUTOFF_HOUR = 21;
const DELIVERY_HOUR = 22;
const CONTEXT_MESSAGES = 60;
// Conversaciones por llamada al codex bridge, de a una llamada por vez: el
// bridge admite 2 ejecuciones en paralelo y las asesoras lo comparten para las
// sugerencias del inbox.
const BATCH_SIZE = 3;
const BRIDGE_TIMEOUT_MS = 180_000;
const BRIDGE_ATTEMPTS = 4;
const TREND_DAYS = 7;

type Speaker = 'cliente' | 'evaluada' | 'otra' | 'bot' | 'sin_atribuir';

interface Line {
  at: number;
  speaker: Speaker;
  text: string;
  inWindow: boolean;
  voice: boolean;
}

interface Candidate {
  ref: string;
  chatId: string;
  agentId: string;
  attribution: 'exacta' | 'asignada';
  alias: string;
  leadStage: string | null;
  // LYD-104: sedes de la asesora evaluada, para que la IA no sugiera otra ciudad
  agentSedes: string[];
  lines: Line[];
  stats: {
    avgResponseMinutes: number | null;
    unansweredClientMessages: number;
    lastFromClient: boolean;
    voiceNotes: number;
  };
}

interface AiEvaluation {
  id: string;
  aplica: boolean;
  motivo_no_aplica?: string | null;
  niveles?: Record<string, AuditLevel | null>;
  evidencia?: Record<string, string | null>;
  falto?: string | null;
  respuesta_sugerida?: string | null;
  mejor_frase?: string | null;
}

// LYD-104: ciudad de cada sede del SGA (tabla `sedes`).
const SEDE_CITY: Record<string, string> = {
  Lince: 'Lima',
  Miraflores: 'Lima',
  Bustamante: 'Arequipa',
  'Bustamante-Kids': 'Arequipa',
  Centro: 'Arequipa',
  Cayma: 'Arequipa',
  Umacollo: 'Arequipa',
  Virtual: 'virtual',
};

const SPEAKER_LABEL: Record<Speaker, string> = {
  cliente: 'Cliente',
  evaluada: 'Asesora evaluada',
  otra: 'Otra asesora',
  bot: 'Bot',
  sin_atribuir: 'Asesora (sin identificar)',
};

export class CommercialAuditService {
  private readonly logger = new Logger('CommercialAuditService');
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaRepository,
    private readonly mailer: AuditMailer,
  ) {}

  public schedule(): void {
    if (process.env.COMMERCIAL_AUDIT_ENABLED !== 'true') {
      this.logger.info('Auditoria comercial diaria desactivada (COMMERCIAL_AUDIT_ENABLED != true)');
      return;
    }
    cron.schedule(`0 ${CUTOFF_HOUR} * * *`, () => this.runInBackground(todayInLima(), { scheduled: true }), {
      timezone: TIMEZONE,
    });
    cron.schedule(`0 ${DELIVERY_HOUR} * * *`, () => void this.deliverScheduled(todayInLima()), { timezone: TIMEZONE });
    cron.schedule(`30 ${DELIVERY_HOUR + 1} * * *`, () => void this.alertIfNotSent(todayInLima()), {
      timezone: TIMEZONE,
    });
    this.logger.info('Auditoria comercial diaria programada: corte 21:00, envio 22:00 (America/Lima)');
    void this.resumeIfInterrupted().catch((error) => this.logger.error(`No se pudo reanudar la auditoria: ${error}`));
  }

  // LYD-104: si el proceso se reinicio despues del corte (deploy, caida) y el
  // reporte de hoy no salio, se vuelve a correr. Al terminar se envia solo si
  // ya paso la hora de envio; si no, lo manda el cron de las 22:00.
  private async resumeIfInterrupted(): Promise<void> {
    const hour = nowInLimaHour();
    if (hour < CUTOFF_HOUR) return;
    const reportDate = todayInLima();
    const run = await this.prisma.commercialAuditRun.findUnique({ where: { reportDate }, select: { status: true } });
    if (run?.status === 'sent') return;
    if (run?.status === 'evaluated') {
      if (hour >= DELIVERY_HOUR) await this.deliverScheduled(reportDate);
      return;
    }
    this.logger.info(`Reanudando la auditoria ${reportDate} (estado: ${run?.status ?? 'sin corrida'})`);
    this.runInBackground(reportDate, { scheduled: true });
  }

  // Corrida manual (piloto, reproceso). No envia: el envio es aparte.
  public startRun(date?: string) {
    const reportDate = date ?? todayInLima();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
      throw new BadRequestException('date debe tener formato YYYY-MM-DD');
    }
    if (this.inFlight.has(reportDate)) {
      throw new BadRequestException(`Ya hay una corrida en curso para ${reportDate}`);
    }
    this.runInBackground(reportDate, { scheduled: false });
    return { reportDate, status: 'running' };
  }

  public async getRun(reportDate: string) {
    const run = await this.prisma.commercialAuditRun.findUnique({
      where: { reportDate },
      select: {
        reportDate: true,
        status: true,
        windowStart: true,
        windowEnd: true,
        conversations: true,
        unattributed: true,
        error: true,
        sentAt: true,
        updatedAt: true,
        _count: { select: { Audits: true } },
      },
    });
    if (!run) throw new NotFoundException(`No hay corrida para ${reportDate}`);
    return { ...run, inFlight: this.inFlight.has(reportDate) };
  }

  public async getRunHtml(reportDate: string): Promise<string> {
    const run = await this.prisma.commercialAuditRun.findUnique({ where: { reportDate }, select: { html: true } });
    if (!run?.html) throw new NotFoundException(`El reporte de ${reportDate} todavia no esta listo`);
    return run.html;
  }

  // Envio manual. `to` permite mandar el piloto solo a desarrollo antes de
  // abrirlo a Direccion; en ese caso no marca la corrida como enviada.
  public async sendRun(reportDate: string, to?: unknown) {
    const override = Array.isArray(to) ? to.filter((t): t is string => typeof t === 'string' && t.includes('@')) : [];
    const run = await this.prisma.commercialAuditRun.findUnique({ where: { reportDate } });
    if (!run?.html) throw new NotFoundException(`El reporte de ${reportDate} todavia no esta listo`);
    await this.mailer.send(override.length ? override : this.mailer.recipients(), subjectFor(reportDate), run.html);
    if (!override.length) {
      await this.prisma.commercialAuditRun.update({
        where: { reportDate },
        data: { status: 'sent', sentAt: new Date() },
      });
    }
    return { reportDate, sentTo: override.length ? override : this.mailer.recipients() };
  }

  private runInBackground(reportDate: string, opts: { scheduled: boolean }): void {
    this.run(reportDate, opts).catch((error) => this.logger.error(`Auditoria ${reportDate} fallo: ${error}`));
  }

  private async run(reportDate: string, opts: { scheduled: boolean }): Promise<void> {
    if (this.inFlight.has(reportDate)) return;
    this.inFlight.add(reportDate);

    const windowEnd = limaTimestamp(reportDate, CUTOFF_HOUR);
    const windowStart = windowEnd - 24 * 3600;
    const run = await this.prisma.commercialAuditRun.upsert({
      where: { reportDate },
      create: { reportDate, windowStart, windowEnd },
      update: { status: 'running', windowStart, windowEnd, error: null, html: null },
    });

    try {
      await this.prisma.conversationAudit.deleteMany({ where: { runId: run.id } });
      const { candidates, unattributed } = await this.collect(windowStart, windowEnd);
      this.logger.info(`Auditoria ${reportDate}: ${candidates.length} conversaciones a evaluar`);

      let evaluated = 0;
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const results = await this.evaluateBatch(batch);
        for (const candidate of batch) {
          const result = results.get(candidate.ref);
          if (!result) continue;
          await this.saveAudit(run.id, candidate, result);
          evaluated++;
        }
      }

      const html = await this.buildReport(
        run.id,
        reportDate,
        windowStart,
        windowEnd,
        unattributed,
        candidates.length - evaluated,
      );
      await this.prisma.commercialAuditRun.update({
        where: { id: run.id },
        data: { status: 'evaluated', conversations: evaluated, unattributed, html },
      });

      if (opts.scheduled && nowInLimaHour() >= DELIVERY_HOUR) {
        await this.deliverScheduled(reportDate);
      }
    } catch (error) {
      await this.prisma.commercialAuditRun.update({
        where: { id: run.id },
        data: { status: 'failed', error: String(error).slice(0, 2000) },
      });
      throw error;
    } finally {
      this.inFlight.delete(reportDate);
    }
  }

  private async deliverScheduled(reportDate: string): Promise<void> {
    const run = await this.prisma.commercialAuditRun.findUnique({ where: { reportDate } });
    if (run?.status === 'sent') return;
    if (run?.status === 'running' && this.inFlight.has(reportDate)) return; // sale al terminar
    if (run?.status !== 'evaluated') {
      await this.alert(reportDate, run?.error ?? 'La evaluacion no corrio o se interrumpio.');
      return;
    }
    try {
      await this.sendRun(reportDate);
    } catch (error) {
      this.logger.error(`No se pudo enviar el reporte ${reportDate}: ${error}`);
      await this.alert(reportDate, `El envio del correo fallo: ${error}`);
    }
  }

  private async alertIfNotSent(reportDate: string): Promise<void> {
    const run = await this.prisma.commercialAuditRun.findUnique({ where: { reportDate } });
    if (run?.status === 'sent') return;
    await this.alert(
      reportDate,
      `A las 23:30 el reporte seguia sin enviarse (estado: ${run?.status ?? 'sin corrida'}).`,
    );
  }

  private async alert(reportDate: string, reason: string): Promise<void> {
    try {
      await this.mailer.send(
        this.mailer.alertRecipients(),
        `[Lydia] Reporte comercial NO generado - ${reportDate}`,
        `<p>El reporte de auditoria comercial K-01 del ${escapeHtml(reportDate)} no se genero.</p><p>${escapeHtml(reason)}</p>`,
      );
    } catch (error) {
      this.logger.error(`No se pudo enviar la alerta de ${reportDate}: ${error}`);
    }
  }

  // ---------- Extraccion ----------

  private async collect(windowStart: number, windowEnd: number) {
    const rows = await this.prisma.$queryRaw<
      { instanceId: string; remoteJid: string; agentId: string | null; kind: MessageAuthorKind | null; n: number }[]
    >`
      SELECT m."instanceId", m.key->>'remoteJid' AS "remoteJid", ma."agentId", ma.kind, COUNT(*)::int AS n
      FROM "Message" m
      LEFT JOIN "MessageAuthor" ma
        ON ma."instanceId" = m."instanceId" AND ma."messageKeyId" = m.key->>'id'
      WHERE m."messageTimestamp" >= ${windowStart} AND m."messageTimestamp" < ${windowEnd}
        AND m.key->>'fromMe' = 'true'
        AND m.key->>'remoteJid' NOT LIKE '%@g.us'
        AND m.key->>'remoteJid' <> 'status@broadcast'
      GROUP BY 1, 2, 3, 4
    `;

    const chats = new Map<string, { instanceId: string; remoteJid: string; agents: Set<string>; unknown: number }>();
    for (const row of rows) {
      const key = `${row.instanceId}|${row.remoteJid}`;
      const entry = chats.get(key) ?? {
        instanceId: row.instanceId,
        remoteJid: row.remoteJid,
        agents: new Set(),
        unknown: 0,
      };
      if (row.kind === MessageAuthorKind.asesora && row.agentId) entry.agents.add(row.agentId);
      else if (!row.kind) entry.unknown += row.n;
      chats.set(key, entry);
    }

    const candidates: Candidate[] = [];
    let unattributed = 0;
    const agentSedes = new Map(
      (await this.prisma.agent.findMany({ select: { id: true, sedes: true } })).map((a) => [a.id, a.sedes]),
    );
    for (const { instanceId, remoteJid, agents, unknown } of chats.values()) {
      const chat = await this.prisma.chat.findUnique({
        where: { instanceId_remoteJid: { instanceId, remoteJid } },
        select: {
          id: true,
          name: true,
          contactNameOverride: true,
          assignedAgentId: true,
          Lead: { select: { stage: true, contactName: true } },
        },
      });
      if (!chat) continue;

      // Sin autor registrado (enviado antes de LYD-101 o desde el celular):
      // se atribuye al responsable del chat, marcado como "asignada".
      const targets: { agentId: string; attribution: Candidate['attribution'] }[] = [...agents].map((agentId) => ({
        agentId,
        attribution: 'exacta',
      }));
      if (!targets.length && unknown > 0) {
        if (chat.assignedAgentId) targets.push({ agentId: chat.assignedAgentId, attribution: 'asignada' });
        else unattributed++;
      }
      if (!targets.length) continue;

      const contact = await this.prisma.contact.findFirst({
        where: { instanceId, remoteJid },
        select: { pushName: true },
      });
      const history = await this.loadHistory(instanceId, remoteJid, windowEnd);
      const tokens = nameTokens([
        chat.name,
        chat.contactNameOverride,
        chat.Lead?.contactName,
        contact?.pushName,
        ...history.clientPushNames,
      ]);

      for (const target of targets) {
        const lines = history.messages.map((m) => ({
          at: m.at,
          inWindow: m.at >= windowStart,
          voice: m.voice,
          text: anonymize(m.text, tokens),
          speaker: speakerFor(m, target),
        }));
        if (!lines.some((l) => l.inWindow && l.speaker === 'evaluada')) continue;
        candidates.push({
          ref: `C${candidates.length + 1}`,
          chatId: chat.id,
          agentId: target.agentId,
          attribution: target.attribution,
          alias: clientAlias(chat.id),
          leadStage: chat.Lead?.stage ?? null,
          agentSedes: agentSedes.get(target.agentId) ?? [],
          lines,
          stats: executionStats(lines),
        });
      }
    }
    return { candidates, unattributed };
  }

  private async loadHistory(instanceId: string, remoteJid: string, windowEnd: number) {
    const rows = await this.prisma.message.findMany({
      where: { instanceId, key: { path: ['remoteJid'], equals: remoteJid }, messageTimestamp: { lt: windowEnd } },
      orderBy: { messageTimestamp: 'desc' },
      take: CONTEXT_MESSAGES,
      select: { key: true, message: true, messageTimestamp: true, pushName: true, status: true },
    });
    const ordered = rows.reverse().filter((m) => m.status !== 'DELETED');

    const ids = ordered.map((m) => (m.key as { id?: string })?.id).filter((id): id is string => Boolean(id));
    const authors = await this.prisma.messageAuthor.findMany({
      where: { instanceId, messageKeyId: { in: ids } },
      select: { messageKeyId: true, agentId: true, kind: true },
    });
    const byKey = new Map(authors.map((a) => [a.messageKeyId, a]));

    const clientPushNames: string[] = [];
    const messages = ordered
      .map((m) => {
        const key = m.key as { id?: string; fromMe?: boolean };
        const fromMe = key?.fromMe === true;
        if (!fromMe && m.pushName) clientPushNames.push(m.pushName);
        const author = key?.id ? byKey.get(key.id) : undefined;
        return {
          at: m.messageTimestamp,
          fromMe,
          authorKind: author?.kind ?? null,
          authorAgentId: author?.agentId ?? null,
          text: auditMessageText(m.message),
          voice: isVoiceNote(m.message),
        };
      })
      .filter((m) => m.text);
    return { messages, clientPushNames };
  }

  // ---------- Evaluacion ----------

  private async evaluateBatch(batch: Candidate[]): Promise<Map<string, AiEvaluation>> {
    const results = new Map<string, AiEvaluation>();
    try {
      for (const r of parseEvaluations(await this.askBridge(buildPrompt(batch)))) results.set(r.id, r);
    } catch (error) {
      this.logger.error(`Lote de auditoria fallo (${batch.map((c) => c.ref).join(', ')}): ${error}`);
    }
    // Lo que el lote no devolvio bien se reintenta de a una conversacion.
    for (const candidate of batch.filter((c) => !results.has(c.ref))) {
      try {
        const [single] = parseEvaluations(await this.askBridge(buildPrompt([candidate])));
        if (single) results.set(candidate.ref, { ...single, id: candidate.ref });
      } catch (error) {
        this.logger.error(`No se pudo evaluar ${candidate.ref} (chat ${candidate.chatId}): ${error}`);
      }
    }
    return results;
  }

  private async askBridge(prompt: string): Promise<string> {
    const url = process.env.CODEX_BRIDGE_URL;
    const token = process.env.CODEX_BRIDGE_TOKEN;
    if (!url || !token) throw new Error('Falta configurar CODEX_BRIDGE_URL y CODEX_BRIDGE_TOKEN');

    let lastError = '';
    for (let attempt = 1; attempt <= BRIDGE_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`${url.replace(/\/$/, '')}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ prompt }),
          signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
        });
        const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        if (res.ok && body.text) return body.text;
        lastError = body.error ?? `HTTP ${res.status}`;
      } catch (error) {
        lastError = String(error);
      }
      // Ocupado (las asesoras lo estan usando) o caida puntual: esperar y reintentar.
      await sleep(15_000 * attempt);
    }
    throw new Error(`codex bridge: ${lastError}`);
  }

  private async saveAudit(runId: string, candidate: Candidate, ai: AiEvaluation): Promise<void> {
    const applicable = ai.aplica !== false;
    const scores: Partial<Record<string, number>> = {};
    const niveles: Record<string, AuditLevel> = {};
    if (applicable) {
      for (const c of CRITERIA) {
        const raw = ai.niveles?.[c.json];
        const level: AuditLevel = LEVELS.includes(raw as AuditLevel) ? (raw as AuditLevel) : 'nulo';
        niveles[c.json] = level;
        scores[c.key] = points(c.weight, level);
      }
    }
    const total = applicable ? Object.values(scores).reduce((a, b) => a + (b ?? 0), 0) : null;

    await this.prisma.conversationAudit.create({
      data: {
        runId,
        chatId: candidate.chatId,
        agentId: candidate.agentId,
        attribution: candidate.attribution,
        applicable,
        total,
        lossAversion: scores.lossAversion ?? null,
        cta: scores.cta ?? null,
        diagnostico: scores.diagnostico ?? null,
        valor: scores.valor ?? null,
        ejecucion: scores.ejecucion ?? null,
        result: {
          alias: candidate.alias,
          leadStage: candidate.leadStage,
          stats: candidate.stats,
          niveles,
          evidencia: ai.evidencia ?? {},
          falto: ai.falto ?? null,
          respuestaSugerida: ai.respuesta_sugerida ?? null,
          mejorFrase: ai.mejor_frase ?? null,
          motivoNoAplica: applicable ? null : (ai.motivo_no_aplica ?? null),
        } as Prisma.InputJsonValue,
      },
    });
  }

  // ---------- Reporte ----------

  private async buildReport(
    runId: string,
    reportDate: string,
    windowStart: number,
    windowEnd: number,
    unattributed: number,
    failed: number,
  ): Promise<string> {
    const audits = await this.prisma.conversationAudit.findMany({
      where: { runId },
      include: { Agent: { select: { id: true, name: true, sedes: true } } },
    });

    const trendFrom = shiftDate(reportDate, -TREND_DAYS);
    const previous = await this.prisma.conversationAudit.findMany({
      where: {
        applicable: true,
        Run: { reportDate: { gte: trendFrom, lt: reportDate } },
      },
      select: { agentId: true, total: true },
    });

    return buildAuditReportHtml({
      reportDate,
      windowStart,
      windowEnd,
      unattributed,
      failed,
      frontUrl: (process.env.LYDIA_FRONT_URL || 'https://crm.brittanygroup.edu.pe').replace(/\/$/, ''),
      audits: audits as unknown as ReportAudit[],
      previous,
    });
  }
}

// ---------- Utilidades ----------

function speakerFor(
  m: { fromMe: boolean; authorKind: MessageAuthorKind | null; authorAgentId: string | null },
  target: { agentId: string; attribution: Candidate['attribution'] },
): Speaker {
  if (!m.fromMe) return 'cliente';
  if (m.authorKind === MessageAuthorKind.bot || m.authorKind === MessageAuthorKind.bienvenida) return 'bot';
  if (m.authorKind === MessageAuthorKind.asesora) return m.authorAgentId === target.agentId ? 'evaluada' : 'otra';
  return target.attribution === 'asignada' ? 'evaluada' : 'sin_atribuir';
}

function executionStats(lines: Line[]): Candidate['stats'] {
  const lags: number[] = [];
  let pendingClientAt: number | null = null;
  let unanswered = 0;
  for (const line of lines.filter((l) => l.inWindow)) {
    if (line.speaker === 'cliente') {
      if (pendingClientAt === null) pendingClientAt = line.at;
    } else if (line.speaker === 'evaluada' && pendingClientAt !== null) {
      lags.push((line.at - pendingClientAt) / 60);
      pendingClientAt = null;
    } else {
      // respondio otra persona (otra asesora, bot): el cliente ya no espera
      pendingClientAt = null;
    }
  }
  if (pendingClientAt !== null) unanswered++;
  const last = lines[lines.length - 1];
  return {
    avgResponseMinutes: lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null,
    unansweredClientMessages: unanswered,
    lastFromClient: last?.speaker === 'cliente',
    voiceNotes: lines.filter((l) => l.inWindow && l.voice && l.speaker === 'evaluada').length,
  };
}

function buildPrompt(batch: Candidate[]): string {
  const rubric = CRITERIA.map((c) => `- ${c.json} (${c.label}, peso ${c.weight}): ${c.rubric}`).join('\n');
  const example = JSON.stringify([
    {
      id: 'C1',
      aplica: true,
      motivo_no_aplica: null,
      niveles: Object.fromEntries(CRITERIA.map((c) => [c.json, 'parcial'])),
      evidencia: Object.fromEntries(CRITERIA.map((c) => [c.json, 'cita textual corta o que falto'])),
      falto: 'que le falto a la asesora, en 1 o 2 frases',
      respuesta_sugerida: 'mensaje que debio enviar segun K-01, maximo 60 palabras',
      mejor_frase: 'frase de la asesora digna de replicar, o null',
    },
  ]);

  const conversations = batch.map((c) => {
    const stats = [
      `tiempo de respuesta promedio hoy: ${c.stats.avgResponseMinutes ?? 'sin datos'} min`,
      `el cliente quedo esperando respuesta al corte: ${c.stats.unansweredClientMessages ? 'si' : 'no'}`,
      `el ultimo mensaje es del cliente: ${c.stats.lastFromClient ? 'si' : 'no'}`,
    ].join('; ');
    const transcript = c.lines
      .map((l) => `[${l.inWindow ? 'HOY ' : ''}${formatLima(l.at)}] ${SPEAKER_LABEL[l.speaker]}: ${l.text}`)
      .join('\n');
    const context = [
      `sede de la asesora: ${describeSedes(c.agentSedes) ?? 'sin dato'}`,
      c.leadStage ? `etapa del lead: ${c.leadStage}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    return `### Conversacion ${c.ref} (${context})\nDatos de ejecucion: ${stats}\n${transcript}`;
  });

  return [
    'Eres auditor comercial de Brittany Group, academia de ingles con sedes en Arequipa y Lima. Evaluas conversaciones reales de WhatsApp entre asesoras y prospectos con el METODO META K-01 (Loss Aversion, Daniel Kahneman). Los datos del cliente estan anonimizados ("Cliente", [numero], [correo]).',
    '## Rubrica (cada criterio: "completo", "parcial" o "nulo")',
    rubric,
    '## Reglas',
    [
      '- Califica SOLO los mensajes marcados [HOY ...] de "Asesora evaluada". El resto es contexto.',
      '- La urgencia falsa o inventada es "nulo" en loss_aversion.',
      '- aplica=false si la conversacion no es comercial (alumno actual, tramite administrativo, pago de un alumno ya matriculado, proveedor, tema personal) o si la asesora solo envio un mensaje operativo sin oportunidad de venta. En ese caso niveles=null y explica en motivo_no_aplica.',
      '- [nota de voz], [imagen], [video] y [documento] no se pueden ver ni oir: no los premies ni los castigues por su contenido.',
      '- evidencia: cita textual corta (maximo 20 palabras) de la asesora; si el nivel es nulo, di que falto.',
      '- respuesta_sugerida: si mencionas sede, ciudad, horarios o precios, usa la sede de la asesora evaluada indicada en la conversacion; nunca otra ciudad salvo que el cliente la pida. Si la sede es "sin dato", no menciones ciudad.',
      '- Escribe en espanol. No inventes datos del cliente.',
    ].join('\n'),
    '## Formato de respuesta',
    `Responde UNICAMENTE con un arreglo JSON valido, un objeto por conversacion, con este formato:\n${example}`,
    '## Conversaciones',
    conversations.join('\n\n'),
  ].join('\n\n');
}

function parseEvaluations(text: string): AiEvaluation[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('la IA no devolvio un arreglo JSON');
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error('la IA no devolvio un arreglo JSON');
  return parsed.filter((r): r is AiEvaluation => typeof r?.id === 'string' && typeof r?.aplica === 'boolean');
}

function describeSedes(sedes: string[]): string | null {
  if (!sedes.length) return null;
  return sedes.map((s) => (SEDE_CITY[s] ? `${s} (${SEDE_CITY[s]})` : s)).join(', ');
}

function todayInLima(): string {
  return new Date(Date.now() + LIMA_OFFSET_HOURS * 3600_000).toISOString().slice(0, 10);
}

function nowInLimaHour(): number {
  return new Date(Date.now() + LIMA_OFFSET_HOURS * 3600_000).getUTCHours();
}

// Unix (segundos) de `date` a la hora `hour` de Lima.
function limaTimestamp(date: string, hour: number): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) + (hour - LIMA_OFFSET_HOURS) * 3600;
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
}

function formatLima(unix: number): string {
  const d = new Date((unix + LIMA_OFFSET_HOURS * 3600) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function subjectFor(reportDate: string): string {
  return `Auditoria comercial K-01 - ${reportDate}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
