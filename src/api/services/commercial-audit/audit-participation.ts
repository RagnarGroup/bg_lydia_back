// LYD-117: porcentaje de participacion de cada asesora en una conversacion.
// Lo asigna la IA en la auditoria diaria segun el aporte real al avance del
// lead, no por cantidad de mensajes o palabras (eso se puede inflar partiendo
// un texto en muchos mensajes). Helpers puros: prompt, parseo y normalizacion.

export type ParticipationSpeaker = 'cliente' | 'bot' | 'asesora' | 'sin_atribuir';

export interface ParticipationLine {
  at: string;
  speaker: ParticipationSpeaker;
  // Etiqueta de la asesora ("A", "B"...) cuando speaker es 'asesora'.
  label?: string;
  text: string;
}

export interface ParticipationCase {
  ref: string;
  labels: string[];
  lines: ParticipationLine[];
}

export interface ParticipationResult {
  id: string;
  porcentajes: Record<string, number>;
  motivo: string | null;
}

// Etiquetas anonimas para el prompt: la IA no ve el nombre de las asesoras.
export function participantLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

// Reparte exactamente 100 entre `labels` respetando la proporcion que dio la
// IA (resto mayor). Etiquetas desconocidas se ignoran, faltantes o invalidas
// valen 0; si todo es 0, se reparte en partes iguales.
export function normalizePercents(
  labels: string[],
  raw: Record<string, unknown> | null | undefined,
): Record<string, number> {
  const values = labels.map((label) => {
    const n = Number(raw?.[label]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const total = values.reduce((a, b) => a + b, 0);
  const shares = total > 0 ? values.map((v) => (v / total) * 100) : labels.map(() => 100 / labels.length);

  const floors = shares.map(Math.floor);
  let remaining = 100 - floors.reduce((a, b) => a + b, 0);
  const order = shares.map((share, i) => ({ i, frac: share - floors[i] })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remaining <= 0) break;
    floors[i]++;
    remaining--;
  }
  return Object.fromEntries(labels.map((label, i) => [label, floors[i]]));
}

const SPEAKER_TEXT: Record<Exclude<ParticipationSpeaker, 'asesora'>, string> = {
  cliente: 'Cliente',
  bot: 'Bot (automatico)',
  sin_atribuir: 'Asesora (sin identificar)',
};

export function buildParticipationPrompt(cases: ParticipationCase[]): string {
  const example = JSON.stringify([
    {
      id: 'P1',
      porcentajes: { A: 70, B: 30 },
      motivo: 'A hizo el diagnostico y cerro la visita; B solo confirmo el horario.',
    },
  ]);
  const conversations = cases.map((c) => {
    const transcript = c.lines
      .map((l) => `[${l.at}] ${l.speaker === 'asesora' ? `Asesora ${l.label}` : SPEAKER_TEXT[l.speaker]}: ${l.text}`)
      .join('\n');
    return `### Conversacion ${c.ref} (asesoras: ${c.labels.join(', ')})\n${transcript}`;
  });

  return [
    'Eres auditor comercial de Brittany Group, academia de ingles. En cada conversacion de WhatsApp con un prospecto intervino mas de una asesora. Reparte el 100% del merito del avance de ese lead entre las asesoras indicadas. Los datos del cliente estan anonimizados.',
    '## Reglas',
    [
      '- Mide el aporte real: diagnostico de la necesidad, informacion util (programa, horarios, precios), manejo de objeciones, compromiso conseguido (visita, pago, matricula) y seguimiento oportuno.',
      '- NO midas cantidad de mensajes ni de palabras: partir un texto en muchos mensajes cortos o saludar y despedirse no suma.',
      '- Los mensajes del Bot y de "Asesora (sin identificar)" no son de ninguna asesora: no los asignes a nadie, son solo contexto.',
      '- Si una asesora solo envio mensajes sin aporte comercial, puede quedar con 0.',
      '- porcentajes: un numero entero por cada asesora indicada en la conversacion (A, B, ...), que sumen 100.',
      '- motivo: una frase en espanol, sin nombres ni datos del cliente.',
    ].join('\n'),
    '## Formato de respuesta',
    `Responde UNICAMENTE con un arreglo JSON valido, un objeto por conversacion:\n${example}`,
    '## Conversaciones',
    conversations.join('\n\n'),
  ].join('\n\n');
}

export function parseParticipation(text: string): ParticipationResult[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('la IA no devolvio un arreglo JSON');
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error('la IA no devolvio un arreglo JSON');
  return parsed
    .filter((r) => typeof r?.id === 'string' && r?.porcentajes && typeof r.porcentajes === 'object')
    .map((r) => ({ id: r.id, porcentajes: r.porcentajes, motivo: typeof r.motivo === 'string' ? r.motivo : null }));
}
