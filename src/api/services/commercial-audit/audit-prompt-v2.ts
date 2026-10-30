import { AI_SUBCRITERIA, DIMENSIONS, LEVELS_V2, LevelV2, NEXT_ACTIONS, NextAction } from './audit-rubric-v2';

// LYD-133: prompt y parseo de la evaluacion K01-V2.0 (coach comercial). Helpers
// puros, sin Prisma, para testearlos. La IA califica niveles y redacta el
// coaching; los puntos, la rapidez, el estado y la confianza los pone el codigo.

// Oferta vigente confirmada por Direccion (2026-10-29). La IA no puede
// inventar otra: precios, plazos, cupos ni beneficios.
export const CURRENT_OFFER =
  'Campana vigente: NOVIEMBRE + DICIEMBRE POR S/490, pago conjunto de los dos meses, sujeto a las condiciones del programa Standard; ' +
  'precio regular S/678, ahorro S/188; inicio de clases 4 de noviembre. Matricula y materiales se cobran por separado. ' +
  'No existen otros descuentos, cupos ni vencimientos aprobados.';

export interface CriterionResult {
  nivel: LevelV2;
  cita: string | null;
  motivo: string | null;
}

export interface AiEvaluationV2 {
  id: string;
  aplica: boolean;
  motivo_no_aplica?: string | null;
  criterios: Record<string, CriterionResult>;
  diagnostico: { observacion: string; cita: string | null }[];
  consejos: string[];
  respuesta_sugerida: string | null;
  proxima_accion: NextAction | null;
  estado: string | null;
}

export function buildPromptV2(conversations: string[]): string {
  const rubric = DIMENSIONS.map((d) => {
    const subs = AI_SUBCRITERIA.filter((s) => s.dimension === d.key)
      .map((s) => `  - ${s.key} (${s.weight} pts): ${s.rubric}`)
      .join('\n');
    return `- ${d.label.toUpperCase()} | ${d.principle}\n${subs}`;
  }).join('\n');

  const example = JSON.stringify([
    {
      id: 'C1',
      aplica: true,
      motivo_no_aplica: null,
      criterios: Object.fromEntries(
        AI_SUBCRITERIA.map((s) => [
          s.key,
          { nivel: 'parcial', cita: 'texto copiado tal cual de un mensaje, o null', motivo: 'por que, en una frase' },
        ]),
      ),
      diagnostico: [{ observacion: 'observacion especifica y sustentada', cita: 'texto copiado tal cual, o null' }],
      consejos: ['accion concreta 1', 'accion concreta 2', 'accion concreta 3'],
      respuesta_sugerida: 'un unico mensaje de WhatsApp listo para copiar',
      proxima_accion: 'visita',
      estado: 'en_seguimiento',
    },
  ]);

  return [
    'Eres Coach de Ventas Senior de Brittany Group, academia de ingles con profesores extranjeros y sedes en Arequipa y Lima. ' +
      'Analizas conversaciones reales de WhatsApp entre asesoras y prospectos para que cada asesora mejore: no eres un fiscalizador. ' +
      'Evaluas si cada intervencion ayuda de verdad al cliente a avanzar hacia su objetivo y a una decision comercial, no si aparecen ciertas palabras o tecnicas. ' +
      'Los datos del cliente estan anonimizados ("Cliente", [numero], [correo]).',
    '## Rubrica K01-V2.0 (cada sub-criterio: "completo", "parcial", "nulo" o "no_evaluable")',
    rubric,
    '## Reglas',
    [
      '- Lee la conversacion completa antes de calificar e identifica que datos ya dio el prospecto. Califica SOLO los mensajes marcados [HOY ...] de "Asesora evaluada"; el resto es contexto.',
      '- no_evaluable NO es nulo: si no hay datos suficientes o el criterio no correspondia en esta conversacion, usa no_evaluable. Nulo es solo un incumplimiento verificable.',
      '- No exijas preguntas de diagnostico si el cliente ya dio la informacion. No exijas urgencia, testimonios ni escasez de forma mecanica.',
      '- Jamas premies presion artificial, datos inventados, preguntas innecesarias ni mensajes que compliquen la decision.',
      '- La nota refleja la calidad de la atencion, no el resultado: no premies porque el cliente compro ni castigues porque no compro.',
      `- ${CURRENT_OFFER} Una afirmacion de precio o condiciones distinta es nulo en ci_verificable. Antes de premiar un ahorro comparativo, comprueba que compara las mismas condiciones.`,
      '- cita: texto copiado TAL CUAL de un mensaje de la conversacion (maximo 20 palabras), sin parafrasear; si lo que hay que senalar es una ausencia, cita=null y explicala en motivo. Nunca inventes mensajes, tiempos ni datos.',
      '- diagnostico: maximo 3 observaciones especificas y sustentadas en la conversacion.',
      '- consejos: exactamente 3 acciones concretas, personalizadas y aplicables de inmediato por esta asesora.',
      '- respuesta_sugerida: UN solo mensaje de WhatsApp, compacto, listo para copiar, con la informacion y el CTA adecuados a la etapa (priorizar visita o llamada cuando corresponda, con dos opciones concretas). Firma como "[tu nombre]". Si mencionas precio, agrega "Matricula y materiales por separado." Usa la sede de interes del prospecto si la conversacion la indica; si no, la sede de la asesora; nunca otra ciudad salvo que el cliente la pida. Si la sede es "sin dato", no menciones ciudad.',
      `- proxima_accion: una de ${NEXT_ACTIONS.join(', ')}.`,
      '- estado: "en_riesgo" solo con senales verificables de estancamiento (el cliente dejo de responder tras una propuesta, posterga sin fecha, objecion sin resolver); si no, "en_seguimiento". Una conversacion sin matricula no es por eso una oportunidad perdida.',
      '- aplica=false si la conversacion no es comercial (alumno actual, tramite administrativo, pago de un alumno ya matriculado, proveedor, tema personal) o si la asesora solo envio un mensaje operativo sin oportunidad de venta. En ese caso criterios={} y explica en motivo_no_aplica.',
      '- [nota de voz], [imagen], [video] y [documento] no se pueden ver ni oir: no los premies ni los castigues por su contenido.',
      '- La rapidez de respuesta la calcula el sistema: no la califiques.',
      '- Escribe en espanol.',
    ].join('\n'),
    '## Formato de respuesta',
    `Responde UNICAMENTE con un arreglo JSON valido, un objeto por conversacion, con este formato:\n${example}`,
    '## Conversaciones',
    conversations.join('\n\n'),
  ].join('\n\n');
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

// Tolera respuestas a medias: lo que falte o venga invalido queda como
// no_evaluable / null, nunca como nulo (no se castiga un error de la IA).
export function parseEvaluationsV2(raw: string): AiEvaluationV2[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('la IA no devolvio un arreglo JSON');
  const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error('la IA no devolvio un arreglo JSON');

  return parsed
    .filter((r) => typeof r?.id === 'string' && typeof r?.aplica === 'boolean')
    .map((r: Record<string, any>) => {
      const criterios: Record<string, CriterionResult> = {};
      for (const sub of AI_SUBCRITERIA) {
        const c = r.criterios?.[sub.key] ?? {};
        criterios[sub.key] = {
          nivel: LEVELS_V2.includes(c.nivel) ? c.nivel : 'no_evaluable',
          cita: text(c.cita, 300),
          motivo: text(c.motivo, 400),
        };
      }
      const diagnostico = (Array.isArray(r.diagnostico) ? r.diagnostico : [])
        .map((d: any) => ({ observacion: text(d?.observacion, 400), cita: text(d?.cita, 300) }))
        .filter((d: { observacion: string | null }) => d.observacion)
        .slice(0, 3);
      const consejos = (Array.isArray(r.consejos) ? r.consejos : [])
        .map((c: unknown) => text(c, 400))
        .filter(Boolean)
        .slice(0, 3);
      return {
        id: r.id,
        aplica: r.aplica,
        motivo_no_aplica: text(r.motivo_no_aplica, 400),
        criterios,
        diagnostico,
        consejos,
        respuesta_sugerida: text(r.respuesta_sugerida, 1200),
        proxima_accion: NEXT_ACTIONS.includes(r.proxima_accion) ? r.proxima_accion : null,
        estado: text(r.estado, 20),
      };
    });
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Regla 2 de la directiva (solo evidencia verificable): la cita tiene que
// estar en un mensaje real. Devuelve el indice de la linea que la contiene o
// -1. Admite "..." para citas recortadas: cada tramo debe estar en la misma linea.
export function findQuote(lines: { text: string }[], quote: string | null): number {
  if (!quote) return -1;
  const parts = quote
    .split(/\.{3}|…/)
    .map(normalize)
    .filter((p) => p.length >= 3);
  if (!parts.length) return -1;
  return lines.findIndex((line) => {
    const haystack = normalize(line.text);
    return parts.every((p) => haystack.includes(p));
  });
}
