// LYD-102: rubrica META K-01 tal como la acepto Direccion (2026-10-21). Cada
// criterio se califica en tres niveles para que la IA sea consistente:
// completo (100 % del peso), parcial (50 %) o nulo (0).

export type AuditLevel = 'completo' | 'parcial' | 'nulo';

export type CriterionKey = 'lossAversion' | 'cta' | 'diagnostico' | 'valor' | 'ejecucion';

export interface Criterion {
  key: CriterionKey;
  // clave en el JSON que devuelve la IA
  json: string;
  label: string;
  weight: number;
  rubric: string;
}

export const CRITERIA: Criterion[] = [
  {
    key: 'lossAversion',
    json: 'loss_aversion',
    label: 'Loss Aversion',
    weight: 30,
    rubric:
      'Muestra el costo REAL de postergar, ligado a la meta del prospecto (Kahneman: una perdida pesa mas que una ganancia equivalente). ' +
      'completo = costo concreto atado a SU meta (p. ej. "si empiezas en enero no llegas al B2 antes de tu postulacion de junio"); ' +
      'parcial = urgencia generica o sin relacion con su meta ("la promo vence pronto"); ' +
      'nulo = no aparece, o la urgencia es falsa o inventada (escasez sin sustento).',
  },
  {
    key: 'cta',
    json: 'cta',
    label: 'CTA',
    weight: 30,
    rubric:
      'Cierra con un siguiente paso concreto. ' +
      'completo = accion + fecha/hora + lugar o canal ("¿te reservo el examen de clasificacion el sabado 10 a. m. en Cayma?"); ' +
      'parcial = invitacion vaga ("¿te animas?", "cualquier duda me escribes"); ' +
      'nulo = sin CTA, o la conversacion queda con el cliente sin respuesta.',
  },
  {
    key: 'diagnostico',
    json: 'diagnostico',
    label: 'Diagnóstico',
    weight: 15,
    rubric:
      'Identifica la META del prospecto antes de ofrecer. ' +
      'completo = pregunta y confirma para que quiere el ingles, plazo, edad/nivel, horario y quien decide; ' +
      'parcial = tiene datos operativos (horario, edad) pero no la meta; ' +
      'nulo = manda precios o brochure de entrada, sin preguntar.',
  },
  {
    key: 'valor',
    json: 'valor',
    label: 'Valor',
    weight: 15,
    rubric:
      'Conecta el programa con esa meta. ' +
      'completo = beneficio especifico a lo que dijo el prospecto, antes o junto con el precio; ' +
      'parcial = beneficios genericos de catalogo; ' +
      'nulo = solo precio.',
  },
  {
    key: 'ejecucion',
    json: 'ejecucion',
    label: 'Ejecución',
    weight: 10,
    rubric:
      'Forma y disciplina: responde rapido, claro, sin errores, contesta todas las preguntas y hace seguimiento si el cliente se enfria. ' +
      'Usa los "Datos de ejecucion" calculados que acompanan a cada conversacion. ' +
      'completo = cumple todo; parcial = falla en uno o dos puntos; nulo = respuestas tardias, desordenadas o preguntas sin contestar.',
  },
];

export const LEVELS: AuditLevel[] = ['completo', 'parcial', 'nulo'];

export function points(weight: number, level: AuditLevel): number {
  if (level === 'completo') return weight;
  if (level === 'parcial') return Math.round(weight / 2);
  return 0;
}
