import { escapeHtml } from './audit-report';
import { DimensionKey, RUBRIC_V2_LABEL } from './audit-rubric-v2';

// LYD-133: HTML del reporte K01-V2.0. Version minima (una fila por
// conversacion) para probar el motor; el reporte diario completo es LYD-134.

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
}

const CELL = 'padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top;';
const HEAD = `${CELL}background:#1e3a8a;color:#fff;font-weight:600;`;

export function buildAuditReportHtmlV2(input: ReportInputV2): string {
  const rows = input.audits
    .map(
      (a) => `<tr>
        <td style="${CELL}">${escapeHtml(a.result.alias)}</td>
        <td style="${CELL}">${escapeHtml(a.Agent?.name ?? 'Sin asesora')}</td>
        <td style="${CELL}">${a.applicable ? (a.total === null ? 'sin datos' : `${a.total}/100`) : 'N/A'}</td>
        <td style="${CELL}">${a.coverage === null ? '-' : `${a.coverage} %`}</td>
        <td style="${CELL}">${escapeHtml(a.confidence ?? '-')}</td>
        <td style="${CELL}">${escapeHtml(a.state ?? a.result.motivoNoAplica ?? '-')}</td>
      </tr>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;max-width:900px;margin:0 auto;padding:16px;">
    <h1 style="font-size:20px;margin:0 0 12px;">${escapeHtml(RUBRIC_V2_LABEL)} · ${escapeHtml(input.reportDate)}</h1>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <tr><th style="${HEAD}">Cliente</th><th style="${HEAD}">Asesora</th><th style="${HEAD}">Nota</th><th style="${HEAD}">Cobertura</th><th style="${HEAD}">Confianza</th><th style="${HEAD}">Estado</th></tr>
      ${rows}
    </table></body></html>`;
}
