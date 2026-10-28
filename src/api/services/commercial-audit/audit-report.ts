import { CRITERIA, CriterionKey } from './audit-rubric';

// LYD-102: HTML del reporte diario (correo). Estilos en linea porque los
// clientes de correo ignoran <style>. Todo lo que muestra ya viene anonimizado.

export interface ReportAudit {
  chatId: string;
  agentId: string | null;
  attribution: string;
  applicable: boolean;
  total: number | null;
  lossAversion: number | null;
  cta: number | null;
  diagnostico: number | null;
  valor: number | null;
  ejecucion: number | null;
  result: {
    alias: string;
    leadStage: string | null;
    stats: { avgResponseMinutes: number | null; lastFromClient: boolean; voiceNotes: number };
    niveles: Record<string, string>;
    evidencia: Record<string, string | null>;
    falto: string | null;
    respuestaSugerida: string | null;
    mejorFrase: string | null;
    motivoNoAplica: string | null;
  };
  Agent: { id: string; name: string; sedes: string[] } | null;
  // LYD-123: participacion de la asesora en el chat y peso en sus promedios.
  percent: number | null;
  weight: number;
}

interface ReportInput {
  reportDate: string;
  windowStart: number;
  windowEnd: number;
  unattributed: number;
  lowParticipation: number;
  failed: number;
  frontUrl: string;
  audits: ReportAudit[];
  previous: { agentId: string | null; total: number | null; weight: number }[];
}

const MISSED_LIMIT = 3;
const PENDING_LIMIT = 20;

const CELL = 'padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top;';
const HEAD = `${CELL}background:#1e3a8a;color:#fff;font-weight:600;`;
const H2 = 'font-size:16px;color:#1e3a8a;margin:24px 0 8px;';

export function buildAuditReportHtml(input: ReportInput): string {
  const applicable = input.audits.filter((a) => a.applicable && a.total !== null);
  const notApplicable = input.audits.length - applicable.length;
  const partial = applicable.filter((a) => a.weight < 1).length;
  const voiceNotes = input.audits.reduce((n, a) => n + (a.result.stats?.voiceNotes ?? 0), 0);

  const sections = [
    `<h1 style="font-size:20px;color:#111827;margin:0 0 4px;">Auditoría comercial META K-01 · ${escapeHtml(longDate(input.reportDate))}</h1>`,
    `<p style="color:#4b5563;margin:0 0 16px;">Conversaciones del ${escapeHtml(formatLima(input.windowStart))} al ${escapeHtml(formatLima(input.windowEnd))} (hora de Lima). ` +
      `Evaluadas: <b>${applicable.length}</b> · No comerciales: ${notApplicable}` +
      (input.failed ? ` · No se pudieron evaluar: ${input.failed}` : '') +
      `</p>`,
    applicable.length ? '' : '<p>No hubo conversaciones comerciales de asesoras en este periodo.</p>',
    applicable.length ? agentTable(applicable, input.previous) : '',
    applicable.length ? sedeTable(applicable) : '',
    applicable.length ? missedSection(applicable, input.frontUrl) : '',
    applicable.length ? pendingSection(applicable, input.frontUrl) : '',
    applicable.length ? bestSection(applicable) : '',
    notes(partial, input.lowParticipation, input.unattributed, voiceNotes),
  ];

  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;max-width:900px;margin:0 auto;padding:16px;">${sections.join('')}</body></html>`;
}

function agentTable(audits: ReportAudit[], previous: ReportInput['previous']): string {
  const byAgent = groupBy(audits, (a) => a.Agent?.id ?? 'sin-agente');
  const rows = [...byAgent.values()]
    .map((list) => {
      const agent = list[0].Agent;
      const prev = previous.filter((p) => p.agentId === agent?.id && p.total !== null);
      return {
        agent,
        list,
        avg: weightedAvg(list, (a) => a.total as number),
        prevAvg: prev.length ? weightedAvg(prev, (p) => p.total as number) : null,
      };
    })
    .sort((a, b) => b.avg - a.avg);

  const body = rows
    .map(({ agent, list, avg: total, prevAvg }) => {
      const trend =
        prevAvg === null
          ? '<span style="color:#6b7280;">sin historial</span>'
          : trendBadge(total - prevAvg) + ` <span style="color:#6b7280;">(7 días: ${Math.round(prevAvg)})</span>`;
      return `<tr>
        <td style="${CELL}"><b>${escapeHtml(agent?.name ?? 'Sin asesora')}</b><br><span style="color:#6b7280;font-size:12px;">${escapeHtml((agent?.sedes ?? []).join(', ') || 'Sin sede')}</span></td>
        <td style="${CELL}">${conversationCount(list)}</td>
        <td style="${CELL}"><b>${Math.round(total)}</b>/100</td>
        ${criteriaCells(list)}
        <td style="${CELL}">${trend}</td>
      </tr>`;
    })
    .join('');

  return `<h2 style="${H2}">Por asesora</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <tr><th style="${HEAD}">Asesora</th><th style="${HEAD}">Conv.</th><th style="${HEAD}">Nota</th>${criteriaHeads()}<th style="${HEAD}">Vs. últimos 7 días</th></tr>
      ${body}
    </table>`;
}

function sedeTable(audits: ReportAudit[]): string {
  // Una asesora con varias sedes cuenta en cada una de ellas.
  const bySede = new Map<string, ReportAudit[]>();
  for (const audit of audits) {
    const sedes = audit.Agent?.sedes?.length ? audit.Agent.sedes : ['Sin sede'];
    for (const sede of sedes) bySede.set(sede, [...(bySede.get(sede) ?? []), audit]);
  }
  const body = [...bySede.entries()]
    .map(([sede, list]) => ({ sede, list, avg: weightedAvg(list, (a) => a.total as number) }))
    .sort((a, b) => b.avg - a.avg)
    .map(
      ({ sede, list, avg: total }) => `<tr>
        <td style="${CELL}"><b>${escapeHtml(sede)}</b></td>
        <td style="${CELL}">${conversationCount(list)}</td>
        <td style="${CELL}"><b>${Math.round(total)}</b>/100</td>
        ${criteriaCells(list)}
      </tr>`,
    )
    .join('');
  return `<h2 style="${H2}">Por sede</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <tr><th style="${HEAD}">Sede</th><th style="${HEAD}">Conv.</th><th style="${HEAD}">Nota</th>${criteriaHeads()}</tr>
      ${body}
    </table>
    <p style="color:#6b7280;font-size:12px;margin:4px 0 0;">Una asesora con varias sedes suma en cada una.</p>`;
}

function missedSection(audits: ReportAudit[], frontUrl: string): string {
  const worst = [...audits].sort((a, b) => (a.total as number) - (b.total as number)).slice(0, MISSED_LIMIT);
  const items = worst
    .map((a) => {
      const gaps = CRITERIA.filter((c) => a.result.niveles?.[c.json] !== 'completo')
        .map((c) => `${c.label}: ${escapeHtml(a.result.evidencia?.[c.json] ?? 'sin evidencia')}`)
        .join('<br>');
      return `<div style="border:1px solid #fecaca;background:#fef2f2;border-radius:6px;padding:10px 12px;margin:0 0 10px;">
        <b>${escapeHtml(a.result.alias)}</b> · ${escapeHtml(a.Agent?.name ?? 'Sin asesora')} · <b>${a.total}/100</b> · ${chatLink(frontUrl, a.chatId)}
        <p style="margin:6px 0;"><b>Qué faltó:</b> ${escapeHtml(a.result.falto ?? '-')}</p>
        <p style="margin:6px 0;font-size:12px;color:#4b5563;">${gaps}</p>
        ${a.result.respuestaSugerida ? `<p style="margin:6px 0;"><b>Respuesta sugerida:</b> <i>${escapeHtml(a.result.respuestaSugerida)}</i></p>` : ''}
      </div>`;
    })
    .join('');
  return `<h2 style="${H2}">Las ${worst.length} oportunidades perdidas del día</h2>${items}`;
}

function pendingSection(audits: ReportAudit[], frontUrl: string): string {
  const pending = audits
    .filter((a) => a.result.niveles?.cta === 'nulo' || a.result.stats?.lastFromClient)
    .sort((a, b) => (a.total as number) - (b.total as number))
    .slice(0, PENDING_LIMIT);
  if (!pending.length) return '';
  const rows = pending
    .map(
      (a) => `<tr>
        <td style="${CELL}">${escapeHtml(a.result.alias)}</td>
        <td style="${CELL}">${escapeHtml(a.Agent?.name ?? 'Sin asesora')}</td>
        <td style="${CELL}">${a.result.stats?.lastFromClient ? 'Cliente esperando respuesta' : 'Sin CTA concreto'}</td>
        <td style="${CELL}">${chatLink(frontUrl, a.chatId)}</td>
      </tr>`,
    )
    .join('');
  return `<h2 style="${H2}">Pendientes para mañana</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <tr><th style="${HEAD}">Cliente</th><th style="${HEAD}">Asesora</th><th style="${HEAD}">Motivo</th><th style="${HEAD}">Abrir</th></tr>
      ${rows}
    </table>
    <p style="color:#6b7280;font-size:12px;margin:4px 0 0;">El enlace abre la conversación en Lydia (requiere iniciar sesión).</p>`;
}

function bestSection(audits: ReportAudit[]): string {
  const best = [...audits]
    .filter((a) => a.result.mejorFrase)
    .sort((a, b) => (b.total as number) - (a.total as number))[0];
  if (!best) return '';
  return `<h2 style="${H2}">La mejor respuesta del día</h2>
    <div style="border:1px solid #bbf7d0;background:#f0fdf4;border-radius:6px;padding:10px 12px;">
      <b>${escapeHtml(best.Agent?.name ?? 'Sin asesora')}</b> · ${best.total}/100
      <p style="margin:6px 0;"><i>"${escapeHtml(best.result.mejorFrase as string)}"</i></p>
    </div>`;
}

function notes(partial: number, lowParticipation: number, unattributed: number, voiceNotes: number): string {
  const lines = [
    'Rúbrica META K-01: Loss Aversion 30 · CTA 30 · Diagnóstico 15 · Valor 15 · Ejecución 10. Cada criterio puntúa completo (100 %), parcial (50 %) o nulo (0).',
    'Los datos de los clientes están anonimizados. Las conversaciones no comerciales no cuentan en los promedios.',
    'Cada conversación pesa en el promedio de la asesora según su participación: hasta 20 % no se evalúa, de 21 % a 39 % pesa la mitad y desde 40 % pesa completa.',
  ];
  if (partial) lines.push(`${partial} evaluaciones pesaron la mitad por participación de 21 % a 39 %.`);
  if (lowParticipation) {
    lines.push(`${lowParticipation} participaciones de 20 % o menos no se evaluaron.`);
  }
  if (unattributed) lines.push(`${unattributed} conversaciones con mensajes sin autor registrado quedaron fuera.`);
  if (voiceNotes) lines.push(`${voiceNotes} notas de voz de asesoras no se evaluaron (todavía no se transcriben).`);
  return `<h2 style="${H2}">Notas</h2><ul style="color:#4b5563;font-size:12px;padding-left:18px;">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`;
}

function criteriaHeads(): string {
  return CRITERIA.map(
    (c) => `<th style="${HEAD}">${escapeHtml(c.label)}<br><span style="font-weight:400;">/${c.weight}</span></th>`,
  ).join('');
}

function criteriaCells(list: ReportAudit[]): string {
  return CRITERIA.map((c) => {
    const value = weightedAvg(list, (a) => (a[c.key as CriterionKey] as number | null) ?? 0);
    const ratio = value / c.weight;
    const color = ratio >= 0.75 ? '#166534' : ratio >= 0.4 ? '#92400e' : '#991b1b';
    return `<td style="${CELL}color:${color};">${Math.round(value)}</td>`;
  }).join('');
}

function trendBadge(delta: number): string {
  const rounded = Math.round(delta);
  if (rounded > 0) return `<span style="color:#166534;font-weight:600;">▲ +${rounded}</span>`;
  if (rounded < 0) return `<span style="color:#991b1b;font-weight:600;">▼ ${rounded}</span>`;
  return '<span style="color:#6b7280;">= 0</span>';
}

function chatLink(frontUrl: string, chatId: string): string {
  return `<a href="${escapeHtml(`${frontUrl}/comunicaciones/inbox-chat?chat=${encodeURIComponent(chatId)}`)}" style="color:#1d4ed8;">Abrir en Lydia</a>`;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

function weightedAvg<T extends { weight: number }>(items: T[], value: (item: T) => number): number {
  const weights = items.reduce((sum, item) => sum + item.weight, 0);
  return weights ? items.reduce((sum, item) => sum + item.weight * value(item), 0) / weights : 0;
}

// "5" o "5 (2 a mitad)" si alguna pesa la mitad por participacion parcial.
function conversationCount(list: ReportAudit[]): string {
  const half = list.filter((a) => a.weight < 1).length;
  return half ? `${list.length} <span style="color:#6b7280;">(${half} a mitad)</span>` : String(list.length);
}

function formatLima(unix: number): string {
  const d = new Date((unix - 5 * 3600) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function longDate(date: string): string {
  const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const d = new Date(`${date}T12:00:00Z`);
  return `${days[d.getUTCDay()]} ${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
