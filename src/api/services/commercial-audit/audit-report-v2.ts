import {
  CELL,
  chatLink,
  escapeHtml,
  formatLima,
  groupBy,
  H2,
  HEAD,
  longDate,
  trendBadge,
  weightedAvg,
} from './audit-report';
import { DimensionKey, DIMENSIONS, RUBRIC_V2_LABEL, SUBCRITERIA } from './audit-rubric-v2';
import { BUSINESS_HOURS } from './audit-timing';
import { RUBRIC_V2 } from './audit-version';

// LYD-133/LYD-134: HTML del reporte diario K01-V2.0 (correo para Direccion).
// Estilos en linea porque los clientes de correo ignoran <style>. Todo lo que
// muestra ya viene anonimizado. Cada nota va con su cantidad de conversaciones
// y su cobertura: no hay clasificaciones definitivas con muestras chicas.

export interface CriterionV2 {
  nivel: string;
  peso: number;
  puntos: number | null;
  cita: string | null;
  hora: string | null;
  motivo: string | null;
}

export interface ReportAuditV2 {
  chatId: string;
  agentId: string | null;
  attribution: string;
  applicable: boolean;
  total: number | null;
  coverage: number | null;
  confidence: string | null;
  state: string | null;
  result: {
    alias: string;
    leadStage: string | null;
    leadSede: string | null;
    stats: { avgResponseMinutes: number | null; lastFromClient: boolean; voiceNotes: number };
    rapidez: {
      promedioMinutos: number | null;
      demoras: { cliente: string; respuesta: string | null; minutos: number }[];
    };
    criterios: Record<string, CriterionV2>;
    dimensiones: Record<DimensionKey, { points: number; evaluable: number; weight: number }> | null;
    puntos: number | null;
    evaluables: number | null;
    diagnostico: { observacion: string; cita: string | null; hora: string | null }[];
    consejos: string[];
    respuestaSugerida: string | null;
    proximaAccion: string | null;
    motivoNoAplica: string | null;
  };
  Agent: { id: string; name: string; sedes: string[] } | null;
  percent: number | null;
  weight: number;
}

export interface ReportInputV2 {
  reportDate: string;
  windowStart: number;
  windowEnd: number;
  unattributed: number;
  lowParticipation: number;
  failed: number;
  frontUrl: string;
  audits: ReportAuditV2[];
  previous: { agentId: string | null; total: number | null; weight: number }[];
  // por agentId; fallback = la IA no respondio y son los consejos de su conversacion mas baja
  coaching: Record<string, { items: string[]; fallback: boolean }>;
}

// Menos conversaciones evaluables que esto: sin posicion en el ranking.
export const MIN_SAMPLE = 3;
const CRITICAL_LIMIT = 3;
const LIST_LIMIT = 20;
const LOW_COVERAGE = 50;
// Meta de Direccion: 9,5/10 sustentado en evidencia.
const GOAL = 95;

const SMALL = 'color:#6b7280;font-size:12px;';

const ACTION_LABEL: Record<string, string> = {
  visita: 'visita',
  llamada: 'llamada',
  evaluacion: 'evaluación',
  matricula: 'matrícula',
  seguimiento: 'seguimiento',
  resolver_dudas: 'resolver dudas',
};

const STATE_LABEL: Record<string, string> = {
  en_seguimiento: 'En seguimiento',
  en_riesgo: 'En riesgo',
  perdida: 'Perdida',
  matriculado: 'Matriculado',
};

export function buildAuditReportHtmlV2(input: ReportInputV2): string {
  const scored = input.audits.filter((a) => a.applicable && a.total !== null);
  const notApplicable = input.audits.filter((a) => !a.applicable).length;
  const noData = input.audits.filter((a) => a.applicable && a.total === null).length;

  const sections = [
    `<h1 style="font-size:20px;color:#111827;margin:0 0 4px;">${escapeHtml(RUBRIC_V2_LABEL)} · ${escapeHtml(longDate(input.reportDate))}</h1>`,
    `<p style="color:#4b5563;margin:0 0 4px;">Conversaciones del ${escapeHtml(formatLima(input.windowStart))} al ${escapeHtml(formatLima(input.windowEnd))} (hora de Lima). ` +
      `Evaluadas: <b>${scored.length}</b> · No comerciales: ${notApplicable}` +
      (noData ? ` · Sin datos suficientes: ${noData}` : '') +
      (input.failed ? ` · No se pudieron evaluar: ${input.failed}` : '') +
      `</p>`,
    scored.length
      ? summary(scored)
      : '<p>No hubo conversaciones comerciales evaluables de asesoras en este periodo.</p>',
    scored.length ? agentTable(scored, input.previous) : '',
    scored.length ? coachingSection(scored, input.coaching) : '',
    scored.length ? sedeTable(scored) : '',
    scored.length ? criticalSection(scored, input.frontUrl) : '',
    riskSection(input.audits, input.frontUrl),
    lostSection(input.audits, input.frontUrl),
    lowConfidenceSection(input.audits),
    notes(input),
  ];

  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;max-width:960px;margin:0 auto;padding:16px;">${sections.join('')}</body></html>`;
}

function summary(scored: ReportAuditV2[]): string {
  const team = weightedAvg(scored, (a) => a.total as number);
  const coverage = weightedAvg(scored, (a) => a.coverage ?? 0);
  const actions = new Map<string, number>();
  for (const a of dedupeByChat(scored)) {
    if (a.result.proximaAccion) actions.set(a.result.proximaAccion, (actions.get(a.result.proximaAccion) ?? 0) + 1);
  }
  const actionText = [...actions.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${escapeHtml(ACTION_LABEL[k] ?? k)} ${n}`)
    .join(' · ');
  return (
    `<p style="margin:0 0 4px;">Nota del equipo: <b>${Math.round(team)}/100</b> (meta ${GOAL}/100) · cobertura promedio ${Math.round(coverage)} %</p>` +
    (actionText ? `<p style="${SMALL}margin:0 0 8px;">Próxima acción recomendada: ${actionText}</p>` : '')
  );
}

// ---------- Por asesora ----------

interface AgentRow {
  agent: ReportAuditV2['Agent'];
  list: ReportAuditV2[];
  avg: number;
  enough: boolean;
}

function agentRows(scored: ReportAuditV2[]): AgentRow[] {
  const rows = [...groupBy(scored, (a) => a.Agent?.id ?? 'sin-agente').values()].map((list) => ({
    agent: list[0].Agent,
    list,
    avg: weightedAvg(list, (a) => a.total as number),
    enough: list.length >= MIN_SAMPLE,
  }));
  return rows.sort((a, b) => Number(b.enough) - Number(a.enough) || b.avg - a.avg);
}

function agentTable(scored: ReportAuditV2[], previous: ReportInputV2['previous']): string {
  let position = 0;
  const body = agentRows(scored)
    .map(({ agent, list, avg, enough }) => {
      const prev = previous.filter((p) => p.agentId === agent?.id && p.total !== null);
      const prevAvg = prev.length ? weightedAvg(prev, (p) => p.total as number) : null;
      const trend =
        prevAvg === null
          ? `<span style="color:#6b7280;">sin historial V2</span>`
          : trendBadge(avg - prevAvg) + ` <span style="color:#6b7280;">(7 días: ${Math.round(prevAvg)})</span>`;
      const low = list.filter(isLowConfidence).length;
      return `<tr>
        <td style="${CELL}">${enough ? ++position : '—'}</td>
        <td style="${CELL}"><b>${escapeHtml(agent?.name ?? 'Sin asesora')}</b><br><span style="${SMALL}">${escapeHtml((agent?.sedes ?? []).join(', ') || 'Sin sede')}</span></td>
        <td style="${CELL}">${conversationCount(list)}${enough ? '' : `<br><span style="color:#92400e;font-size:12px;">muestra insuficiente</span>`}</td>
        <td style="${CELL}"><b>${Math.round(avg)}</b>/100</td>
        <td style="${CELL}">${Math.round(weightedAvg(list, (a) => a.coverage ?? 0))} %</td>
        ${dimensionCells(list)}
        <td style="${CELL}${low ? 'color:#991b1b;' : ''}">${low || '-'}</td>
        <td style="${CELL}">${trend}</td>
      </tr>`;
    })
    .join('');

  return `<h2 style="${H2}">Ranking por asesora</h2>
    <table style="border-collapse:collapse;width:100%;font-size:12px;">
      <tr><th style="${HEAD}">#</th><th style="${HEAD}">Asesora</th><th style="${HEAD}">Conv.</th><th style="${HEAD}">Nota</th><th style="${HEAD}">Cobertura</th>${dimensionHeads()}<th style="${HEAD}">Confianza baja</th><th style="${HEAD}">Vs. últimos 7 días</th></tr>
      ${body}
    </table>
    <p style="${SMALL}margin:4px 0 0;">Cada dimensión es el porcentaje logrado de sus puntos evaluables (n/e: no se pudo evaluar). Con menos de ${MIN_SAMPLE} conversaciones evaluables la asesora no tiene posición en el ranking.</p>`;
}

function dimensionHeads(): string {
  return DIMENSIONS.map(
    (d) =>
      `<th style="${HEAD}">${escapeHtml(d.label)}<br><span style="font-weight:400;">${escapeHtml(d.principle)}</span></th>`,
  ).join('');
}

// Porcentaje logrado de los puntos evaluables de cada dimension, ponderado por
// participacion.
function dimensionCells(list: ReportAuditV2[]): string {
  return DIMENSIONS.map((d) => {
    let points = 0;
    let evaluable = 0;
    for (const a of list) {
      const dim = a.result.dimensiones?.[d.key];
      if (!dim) continue;
      points += a.weight * dim.points;
      evaluable += a.weight * dim.evaluable;
    }
    if (!evaluable) return `<td style="${CELL}color:#6b7280;">n/e</td>`;
    const ratio = points / evaluable;
    const color = ratio >= 0.75 ? '#166534' : ratio >= 0.4 ? '#92400e' : '#991b1b';
    return `<td style="${CELL}color:${color};">${Math.round(ratio * 100)} %</td>`;
  }).join('');
}

function conversationCount(list: ReportAuditV2[]): string {
  const half = list.filter((a) => a.weight < 1).length;
  return half ? `${list.length} <span style="color:#6b7280;">(${half} a mitad)</span>` : String(list.length);
}

// ---------- Coaching ----------

function coachingSection(scored: ReportAuditV2[], coaching: ReportInputV2['coaching']): string {
  const blocks = agentRows(scored)
    .map(({ agent }) => {
      const entry = agent ? coaching[agent.id] : undefined;
      if (!entry?.items.length) return '';
      return `<div style="margin:0 0 10px;">
        <b>${escapeHtml(agent?.name ?? 'Sin asesora')}</b>${entry.fallback ? ` <span style="${SMALL}">(consejos de su conversación más baja)</span>` : ''}
        <ol style="margin:4px 0 0;padding-left:20px;">${entry.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ol>
      </div>`;
    })
    .join('');
  return blocks ? `<h2 style="${H2}">Coaching para cada asesora</h2>${blocks}` : '';
}

// ---------- Por sede ----------

// Cada conversacion cuenta una sola vez y en una sola sede: la sede de interes
// del lead si la tiene; si no, la unica sede de la asesora con mas peso; si
// atiende varias sedes, "Asesora multisede".
export function conversationSede(list: ReportAuditV2[]): string {
  const leadSede = list.find((a) => a.result.leadSede)?.result.leadSede;
  if (leadSede) return leadSede;
  const main = [...list].sort((a, b) => b.weight - a.weight)[0];
  const sedes = main?.Agent?.sedes ?? [];
  if (sedes.length === 1) return sedes[0];
  return sedes.length > 1 ? 'Asesora multisede' : 'Sin sede';
}

function sedeTable(scored: ReportAuditV2[]): string {
  const chats = [...groupBy(scored, (a) => a.chatId).values()].map((list) => ({
    sede: conversationSede(list),
    total: weightedAvg(list, (a) => a.total as number),
    coverage: weightedAvg(list, (a) => a.coverage ?? 0),
  }));
  const body = [...groupBy(chats, (c) => c.sede).entries()]
    .map(([sede, list]) => ({
      sede,
      n: list.length,
      avg: list.reduce((s, c) => s + c.total, 0) / list.length,
      coverage: list.reduce((s, c) => s + c.coverage, 0) / list.length,
    }))
    .sort((a, b) => b.avg - a.avg)
    .map(
      (r) => `<tr>
        <td style="${CELL}"><b>${escapeHtml(r.sede)}</b></td>
        <td style="${CELL}">${r.n}</td>
        <td style="${CELL}"><b>${Math.round(r.avg)}</b>/100</td>
        <td style="${CELL}">${Math.round(r.coverage)} %</td>
      </tr>`,
    )
    .join('');
  return `<h2 style="${H2}">Por sede</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <tr><th style="${HEAD}">Sede</th><th style="${HEAD}">Conv.</th><th style="${HEAD}">Nota</th><th style="${HEAD}">Cobertura</th></tr>
      ${body}
    </table>
    <p style="${SMALL}margin:4px 0 0;">Cada conversación cuenta una sola vez, en la sede de interés del prospecto si se conoce o en la sede de la asesora. Las de asesoras con varias sedes van aparte.</p>`;
}

// ---------- Conversaciones criticas ----------

function criticalSection(scored: ReportAuditV2[], frontUrl: string): string {
  const critical = dedupeByChat(
    scored
      .filter((a) => a.state !== 'perdida' && a.state !== 'matriculado' && a.confidence !== 'baja')
      .sort((a, b) => (a.total as number) - (b.total as number)),
  ).slice(0, CRITICAL_LIMIT);
  if (!critical.length) return '';
  const cards = critical.map((a) => criticalCard(a, frontUrl)).join('');
  const title =
    critical.length === 1
      ? 'La conversación crítica del día'
      : `Las ${critical.length} conversaciones críticas del día`;
  return `<h2 style="${H2}">${title}</h2>
    <p style="${SMALL}margin:0 0 8px;">Notas más bajas con confianza media o alta, sin contar las perdidas. Cada una con su evidencia y una propuesta de recuperación.</p>${cards}`;
}

function criticalCard(a: ReportAuditV2, frontUrl: string): string {
  const r = a.result;
  const dims = DIMENSIONS.map((d) => {
    const dim = r.dimensiones?.[d.key];
    if (!dim?.evaluable) return `${escapeHtml(d.label)} n/e`;
    return `${escapeHtml(d.label)} ${fmt(dim.points)}/${dim.evaluable}${dim.evaluable < dim.weight ? ` (de ${dim.weight})` : ''}`;
  }).join(' · ');

  const gaps = SUBCRITERIA.filter((s) => ['nulo', 'parcial'].includes(r.criterios?.[s.key]?.nivel))
    .map((s) => {
      const c = r.criterios[s.key];
      return `<li>${escapeHtml(s.label)} (${escapeHtml(c.nivel)}, ${fmt(c.puntos ?? 0)}/${c.peso}): ${escapeHtml(c.motivo ?? '-')}${quote(c.cita, c.hora)}</li>`;
    })
    .join('');
  const diagnosis = (r.diagnostico ?? [])
    .map((d) => `<li>${escapeHtml(d.observacion)}${quote(d.cita, d.hora)}</li>`)
    .join('');
  const lags = r.rapidez?.demoras ?? [];

  return `<div style="border:1px solid #fecaca;background:#fef2f2;border-radius:6px;padding:10px 12px;margin:0 0 10px;">
    <b>${escapeHtml(r.alias)}</b> · ${escapeHtml(a.Agent?.name ?? 'Sin asesora')} · <b>${a.total}/100</b> · ${escapeHtml(STATE_LABEL[a.state ?? ''] ?? '-')} · ${chatLink(frontUrl, a.chatId)}
    <p style="${SMALL}margin:4px 0;">${fmt(r.puntos ?? 0)} de ${r.evaluables} puntos evaluables → ${a.total}/100 · cobertura ${a.coverage} % · confianza ${escapeHtml(a.confidence ?? '-')}<br>${dims}</p>
    ${diagnosis ? `<p style="margin:6px 0 2px;"><b>Diagnóstico</b></p><ul style="margin:0;padding-left:18px;">${diagnosis}</ul>` : ''}
    ${gaps ? `<p style="margin:6px 0 2px;"><b>Evidencia</b></p><ul style="margin:0;padding-left:18px;font-size:13px;">${gaps}</ul>` : ''}
    ${lags.length ? `<p style="${SMALL}margin:6px 0;">Demoras (horario de atención): ${lags.map((l) => `${escapeHtml(l.cliente)} → ${l.respuesta ? escapeHtml(l.respuesta) : 'sin respuesta al corte'} (${l.minutos} min)`).join(' · ')}</p>` : ''}
    ${r.respuestaSugerida ? `<p style="margin:6px 0 2px;"><b>Respuesta sugerida</b></p><div style="background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:8px;white-space:pre-wrap;">${escapeHtml(r.respuestaSugerida)}</div>` : ''}
    ${r.proximaAccion ? `<p style="margin:6px 0 0;"><b>Próxima acción:</b> ${escapeHtml(ACTION_LABEL[r.proximaAccion] ?? r.proximaAccion)}</p>` : ''}
  </div>`;
}

function quote(cita: string | null, hora: string | null): string {
  if (!cita) return '';
  return ` <i>«${escapeHtml(cita)}»</i>${hora ? ` <span style="color:#6b7280;">(${escapeHtml(hora)})</span>` : ''}`;
}

// ---------- En riesgo / perdidas ----------

function riskSection(audits: ReportAuditV2[], frontUrl: string): string {
  const risk = dedupeByChat(
    audits
      .filter((a) => a.applicable && a.state !== 'perdida' && a.state !== 'matriculado')
      .filter((a) => a.state === 'en_riesgo' || waitingSince(a) || a.result.stats?.lastFromClient)
      .sort((a, b) => (a.total ?? 0) - (b.total ?? 0)),
  ).slice(0, LIST_LIMIT);
  if (!risk.length) return '';
  const rows = risk
    .map((a) => {
      const since = waitingSince(a);
      const reason = since
        ? `Cliente esperando respuesta desde ${escapeHtml(since)}`
        : a.result.stats?.lastFromClient
          ? 'El último mensaje es del cliente'
          : 'Señales de estancamiento';
      return `<tr>
        <td style="${CELL}">${escapeHtml(a.result.alias)}</td>
        <td style="${CELL}">${escapeHtml(a.Agent?.name ?? 'Sin asesora')}</td>
        <td style="${CELL}">${reason}</td>
        <td style="${CELL}">${escapeHtml(ACTION_LABEL[a.result.proximaAccion ?? ''] ?? '-')}</td>
        <td style="${CELL}">${chatLink(frontUrl, a.chatId)}</td>
      </tr>`;
    })
    .join('');
  return `<h2 style="${H2}">En riesgo (para mañana)</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <tr><th style="${HEAD}">Cliente</th><th style="${HEAD}">Asesora</th><th style="${HEAD}">Motivo</th><th style="${HEAD}">Próxima acción</th><th style="${HEAD}">Abrir</th></tr>
      ${rows}
    </table>
    <p style="${SMALL}margin:4px 0 0;">En riesgo no es perdida: siguen abiertas y se pueden recuperar. El enlace abre la conversación en Lydia (requiere iniciar sesión).</p>`;
}

function waitingSince(a: ReportAuditV2): string | null {
  return a.result.rapidez?.demoras?.find((d) => d.respuesta === null)?.cliente ?? null;
}

function lostSection(audits: ReportAuditV2[], frontUrl: string): string {
  const lost = dedupeByChat(audits.filter((a) => a.state === 'perdida')).slice(0, LIST_LIMIT);
  if (!lost.length) return '';
  const rows = lost
    .map(
      (a) => `<tr>
        <td style="${CELL}">${escapeHtml(a.result.alias)}</td>
        <td style="${CELL}">${escapeHtml(a.Agent?.name ?? 'Sin asesora')}</td>
        <td style="${CELL}">${a.total === null ? '-' : `${a.total}/100`}</td>
        <td style="${CELL}">${chatLink(frontUrl, a.chatId)}</td>
      </tr>`,
    )
    .join('');
  return `<h2 style="${H2}">Oportunidades perdidas</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <tr><th style="${HEAD}">Cliente</th><th style="${HEAD}">Asesora</th><th style="${HEAD}">Nota</th><th style="${HEAD}">Abrir</th></tr>
      ${rows}
    </table>
    <p style="${SMALL}margin:4px 0 0;">Solo las que la asesora marcó como venta perdida en el embudo.</p>`;
}

// ---------- Confianza baja ----------

function isLowConfidence(a: ReportAuditV2): boolean {
  return a.applicable && (a.confidence === 'baja' || (a.coverage ?? 0) < LOW_COVERAGE);
}

function lowConfidenceSection(audits: ReportAuditV2[]): string {
  const low = audits.filter(isLowConfidence);
  if (!low.length) return '';
  const rows = low
    .map((a) => {
      const reasons = [
        a.total === null ? 'nada evaluable' : (a.coverage ?? 0) < LOW_COVERAGE ? `cobertura ${a.coverage} %` : '',
        a.attribution === 'asignada' ? 'mensajes sin autor (atribuidos al responsable)' : '',
        a.result.stats?.voiceNotes ? `${a.result.stats.voiceNotes} nota(s) de voz sin evaluar` : '',
      ].filter(Boolean);
      return `<tr>
        <td style="${CELL}">${escapeHtml(a.result.alias)}</td>
        <td style="${CELL}">${escapeHtml(a.Agent?.name ?? 'Sin asesora')}</td>
        <td style="${CELL}">${a.total === null ? '-' : `${a.total}/100`}</td>
        <td style="${CELL}">${escapeHtml(reasons.join('; ') || 'confianza baja')}</td>
      </tr>`;
    })
    .join('');
  return `<h2 style="${H2}">Evaluaciones incompletas o con confianza baja</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <tr><th style="${HEAD}">Cliente</th><th style="${HEAD}">Asesora</th><th style="${HEAD}">Nota</th><th style="${HEAD}">Por qué</th></tr>
      ${rows}
    </table>
    <p style="${SMALL}margin:4px 0 0;">Estas notas son orientativas: revisar la conversación antes de sacar conclusiones.</p>`;
}

// ---------- Notas ----------

function notes(input: ReportInputV2): string {
  const approx = input.audits.filter((a) => a.attribution === 'asignada').length;
  const partial = input.audits.filter((a) => a.applicable && a.weight < 1).length;
  const voiceNotes = input.audits.reduce((n, a) => n + (a.result.stats?.voiceNotes ?? 0), 0);
  const weights = DIMENSIONS.map((d) => `${d.label} ${d.weight}`).join(' · ');
  const lines = [
    `Rúbrica ${RUBRIC_V2}: ${weights}. Cada sub-criterio puntúa completo (100 %), parcial (50 %), nulo (0) o no evaluable.`,
    'Lo no evaluable no resta: nota = 100 × puntos obtenidos ÷ puntos evaluables. La cobertura es el porcentaje de los 100 puntos que se pudo evaluar.',
    `La rapidez se calcula con la hora real de los mensajes, contando solo el horario de atención (lunes a sábado de ${BUSINESS_HOURS.open}:00 a ${BUSINESS_HOURS.close}:00): hasta 15 min en promedio es completo y hasta 60 min, parcial.`,
    'Las citas de evidencia están verificadas contra la conversación; las que la IA no pudo sustentar se descartan.',
    'Los datos de los clientes están anonimizados. Las conversaciones no comerciales no cuentan en los promedios.',
    'Cada conversación pesa en el promedio de la asesora según su participación: hasta 20 % no se evalúa, de 21 % a 39 % pesa la mitad y desde 40 % pesa completa.',
    'Las notas de esta rúbrica no son comparables con las de la META K-01 anterior: la comparación con los últimos 7 días usa solo días evaluados con esta misma rúbrica.',
    'La nota automática orienta el coaching: no es prueba suficiente para sanciones laborales.',
  ];
  if (approx) {
    lines.push(
      `${approx} evaluaciones se atribuyeron a la asesora responsable del chat porque los mensajes no tenían autor registrado (enviados desde el celular).`,
    );
  }
  if (partial) lines.push(`${partial} evaluaciones pesaron la mitad por participación de 21 % a 39 %.`);
  if (input.lowParticipation) lines.push(`${input.lowParticipation} participaciones de 20 % o menos no se evaluaron.`);
  if (input.unattributed) {
    lines.push(`${input.unattributed} conversaciones con mensajes sin autor ni responsable quedaron fuera.`);
  }
  if (voiceNotes) lines.push(`${voiceNotes} notas de voz de asesoras no se evaluaron (todavía no se transcriben).`);
  return `<h2 style="${H2}">Notas</h2><ul style="color:#4b5563;font-size:12px;padding-left:18px;">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`;
}

// ---------- Utilidades ----------

// Una conversacion evaluada para dos asesoras aparece una sola vez en las listas.
function dedupeByChat(audits: ReportAuditV2[]): ReportAuditV2[] {
  const seen = new Set<string>();
  return audits.filter((a) => (seen.has(a.chatId) ? false : (seen.add(a.chatId), true)));
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',');
}
