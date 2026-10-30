// LYD-134: tres recomendaciones de coaching por asesora para el reporte
// diario K01-V2.0. La IA las sintetiza a partir de las evaluaciones del dia
// (ya anonimizadas); no ve el nombre de las asesoras, solo una etiqueta.
// Helpers puros: prompt, parseo y respaldo.

export interface CoachingCase {
  label: string;
  conversations: number;
  // "Ogilvy 60 %", "Kahneman n/e", ...
  dimensions: string[];
  observations: string[];
  tips: string[];
}

const MAX_ITEMS = 12;

export function buildCoachingPrompt(cases: CoachingCase[]): string {
  const example = JSON.stringify([{ id: 'A', recomendaciones: ['accion 1', 'accion 2', 'accion 3'] }]);
  const blocks = cases.map((c) =>
    [
      `### Asesora ${c.label} (${c.conversations} conversaciones evaluadas)`,
      `Logro por dimension: ${c.dimensions.join(' · ')}`,
      'Observaciones del dia:',
      ...c.observations.slice(0, MAX_ITEMS).map((o) => `- ${o}`),
      'Consejos por conversacion:',
      ...c.tips.slice(0, MAX_ITEMS).map((t) => `- ${t}`),
    ].join('\n'),
  );
  return [
    'Eres Coach de Ventas Senior de Brittany Group, academia de ingles. Con las evaluaciones del dia de cada asesora, ' +
      'escribe exactamente 3 recomendaciones de coaching: acciones concretas, personalizadas y aplicables desde manana, ' +
      'enfocadas en lo que mas le haria subir visitas, llamadas y matriculas (priorizando sus dimensiones mas bajas). ' +
      'Nada generico, nada que no se desprenda de sus evaluaciones. Maximo 30 palabras cada una. Escribe en espanol.',
    `Responde UNICAMENTE con un arreglo JSON valido, un objeto por asesora, con este formato:\n${example}`,
    '## Asesoras',
    blocks.join('\n\n'),
  ].join('\n\n');
}

export function parseCoaching(text: string): Map<string, string[]> {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('la IA no devolvio un arreglo JSON');
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error('la IA no devolvio un arreglo JSON');
  const out = new Map<string, string[]>();
  for (const r of parsed) {
    if (typeof r?.id !== 'string' || !Array.isArray(r.recomendaciones)) continue;
    const recs = r.recomendaciones
      .filter((x: unknown): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x: string) => x.trim().slice(0, 400))
      .slice(0, 3);
    if (recs.length) out.set(r.id, recs);
  }
  return out;
}

// Respaldo si la IA no responde: los consejos de la conversacion mas baja,
// completados con los de las siguientes, sin repetir.
export function fallbackCoaching(byScore: { total: number; tips: string[] }[]): string[] {
  const out: string[] = [];
  for (const item of [...byScore].sort((a, b) => a.total - b.total)) {
    for (const tip of item.tips) {
      if (out.length < 3 && !out.includes(tip)) out.push(tip);
    }
  }
  return out;
}
