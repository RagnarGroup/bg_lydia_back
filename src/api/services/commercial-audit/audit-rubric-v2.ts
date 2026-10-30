// LYD-133: rubrica K01-V2.0 (directiva de Direccion "LIDIA K-01 2.0",
// 2026-10-29). Cada sub-criterio se califica completo (peso entero), parcial
// (mitad), nulo (0) o no_evaluable: lo no evaluable no resta, sale del
// denominador. La nota la calcula el codigo, nunca la IA:
//   nota = 100 * puntos / puntos evaluables, cobertura = puntos evaluables.
// Se redondea solo al final para que la nota cuadre con sus componentes.

export const RUBRIC_V2_LABEL = 'Evaluación y coaching comercial K01-V2.0';

export type LevelV2 = 'completo' | 'parcial' | 'nulo' | 'no_evaluable';

export const LEVELS_V2: LevelV2[] = ['completo', 'parcial', 'nulo', 'no_evaluable'];

export type DimensionKey = 'ogilvy' | 'kahneman' | 'cialdini' | 'cierre' | 'ejecucion';

export interface Dimension {
  key: DimensionKey;
  label: string;
  // que mide, en lenguaje de Direccion
  principle: string;
  weight: number;
}

export const DIMENSIONS: Dimension[] = [
  { key: 'ogilvy', label: 'Ogilvy', principle: 'Comunicar beneficios', weight: 25 },
  { key: 'kahneman', label: 'Kahneman', principle: 'Facilitar decisiones', weight: 20 },
  { key: 'cialdini', label: 'Cialdini', principle: 'Construir confianza', weight: 15 },
  { key: 'cierre', label: 'CTA y cierre', principle: 'Avanzar al siguiente paso', weight: 30 },
  { key: 'ejecucion', label: 'Ejecución', principle: 'Rapidez, coherencia y forma', weight: 10 },
];

export interface SubCriterion {
  key: string;
  dimension: DimensionKey;
  label: string;
  weight: number;
  // la calcula el codigo (no va en el prompt)
  computed?: boolean;
  rubric?: string;
}

export const SUBCRITERIA: SubCriterion[] = [
  {
    key: 'og_intencion',
    dimension: 'ogilvy',
    label: 'Responde a la intención',
    weight: 8,
    rubric:
      'Identifica y responde correctamente a lo que el prospecto pidio o quiere lograr. completo = responde justo a eso; parcial = responde a medias o generico; nulo = ignora lo que pidio o contesta otra cosa. no_evaluable = el prospecto todavia no expreso ninguna intencion.',
  },
  {
    key: 'og_beneficio',
    dimension: 'ogilvy',
    label: 'Beneficio relevante',
    weight: 10,
    rubric:
      'Comunica un beneficio relevante para ESE cliente, no solo caracteristicas del programa. completo = beneficio concreto ligado a lo que dijo el cliente; parcial = beneficios genericos de catalogo; nulo = solo caracteristicas o precio habiendo oportunidad de mostrar el beneficio. no_evaluable = la conversacion no llego a presentar el programa.',
  },
  {
    key: 'og_propuesta',
    dimension: 'ogilvy',
    label: 'Propuesta clara',
    weight: 7,
    rubric:
      'Presenta una propuesta clara, especifica y comprensible (programa, precio real, horario, inicio). completo = clara y especifica; parcial = incompleta o algo confusa; nulo = confusa, contradictoria o ausente cuando el cliente la pidio. no_evaluable = todavia no correspondia presentarla.',
  },
  {
    key: 'ka_sin_repetir',
    dimension: 'kahneman',
    label: 'Usa lo que ya sabe',
    weight: 8,
    rubric:
      'Usa la informacion que el cliente ya dio sin repetir preguntas. completo = aprovecha lo dicho; parcial = repite una pregunta menor; nulo = vuelve a pedir datos que ya estaban (edad, ciudad, horario) o hace preguntas innecesarias. no_evaluable = no habia informacion previa que aprovechar.',
  },
  {
    key: 'ka_simplifica',
    dimension: 'kahneman',
    label: 'Simplifica la elección',
    weight: 7,
    rubric:
      'Simplifica la conversacion y facilita una eleccion. completo = reduce la decision a pocos pasos u opciones; parcial = algo de ruido; nulo = la complica (listas largas, varias preguntas a la vez, informacion irrelevante).',
  },
  {
    key: 'ka_oportunidad',
    dimension: 'kahneman',
    label: 'Ventaja de actuar a tiempo',
    weight: 5,
    rubric:
      'Presenta la ventaja de actuar oportunamente o el costo real de postergar ligado a la meta del cliente. completo = ventaja autentica y concreta (por ejemplo, inicio de clases o la promocion vigente) o costo real de esperar; parcial = urgencia generica pero verdadera; nulo = urgencia falsa o inventada (plazos, cupos, perdidas). no_evaluable = no habia una razon autentica de urgencia. NUNCA es nulo por simple ausencia: la aversion a la perdida no es obligatoria.',
  },
  {
    key: 'ci_verificable',
    dimension: 'cialdini',
    label: 'Afirmaciones verificables',
    weight: 6,
    rubric:
      'Usa argumentos y afirmaciones verificables y correctos. completo = datos reales y correctos; parcial = vagos o imprecisos; nulo = datos inventados o que no corresponden a la oferta vigente. no_evaluable = no hizo afirmaciones comerciales.',
  },
  {
    key: 'ci_principios',
    dimension: 'cialdini',
    label: 'Autoridad, prueba social o reciprocidad',
    weight: 5,
    rubric:
      'Aplica autoridad, prueba social, reciprocidad o escasez REAL cuando es pertinente. completo = pertinente y natural; parcial = forzado o poco pertinente; nulo = escasez falsa o presion. no_evaluable = no habia ocasion pertinente. No se exige de forma mecanica: su ausencia es no_evaluable, no nulo.',
  },
  {
    key: 'ci_confianza',
    dimension: 'cialdini',
    label: 'Trato que genera confianza',
    weight: 4,
    rubric:
      'Trato respetuoso, empatico y profesional. completo = cordial y empatico; parcial = seco o impersonal; nulo = descortes o presiona.',
  },
  {
    key: 'cta_paso',
    dimension: 'cierre',
    label: 'Siguiente paso correcto',
    weight: 14,
    rubric:
      'Propone el siguiente paso correcto segun la etapa: visita presencial, llamada, evaluacion o matricula (priorizar visitas y llamadas cuando corresponden). Si antes hay una duda de fondo, resolverla ES el paso correcto. completo = paso concreto y adecuado; parcial = vago ("cualquier duda me escribes") o no es el adecuado; nulo = deja la conversacion abierta habiendo oportunidad razonable de avanzar. no_evaluable = el cliente cerro la conversacion o no habia oportunidad razonable.',
  },
  {
    key: 'cta_opciones',
    dimension: 'cierre',
    label: 'Opciones concretas',
    weight: 9,
    rubric:
      'Facilita una decision concreta con opciones pertinentes (hoy o manana, dos horarios). completo = opciones concretas; parcial = una sola opcion abierta; nulo = ninguna opcion concreta. no_evaluable = no correspondia proponer un paso o el cliente ya eligio.',
  },
  {
    key: 'cta_esfuerzo',
    dimension: 'cierre',
    label: 'Fácil de confirmar',
    weight: 7,
    rubric:
      'Reduce el esfuerzo del cliente para confirmar y avanzar (responder si, elegir una opcion, direccion o enlace listos). completo = confirmar es inmediato; parcial = requiere algo de esfuerzo; nulo = exige pasos innecesarios. no_evaluable = no correspondia proponer un paso.',
  },
  {
    key: 'ej_rapidez',
    dimension: 'ejecucion',
    label: 'Rapidez de atención',
    weight: 4,
    computed: true,
  },
  {
    key: 'ej_coherencia',
    dimension: 'ejecucion',
    label: 'Coherencia con el prospecto',
    weight: 3,
    rubric:
      'Coherencia con el prospecto, la sede, el producto y la etapa comercial. completo = todo coherente; parcial = un descuido menor; nulo = otra sede o ciudad, otro producto o etapa equivocada.',
  },
  {
    key: 'ej_formato',
    dimension: 'ejecucion',
    label: 'Breve y fácil de responder',
    weight: 3,
    rubric:
      'Comunicacion breve, comprensible, cordial y adaptada a WhatsApp: mensaje compacto y facil de responder. completo = asi; parcial = largo o con errores; nulo = extenso, confuso o desordenado.',
  },
];

export const AI_SUBCRITERIA = SUBCRITERIA.filter((s) => !s.computed);

export type NextAction = 'visita' | 'llamada' | 'evaluacion' | 'matricula' | 'seguimiento' | 'resolver_dudas';
export const NEXT_ACTIONS: NextAction[] = [
  'visita',
  'llamada',
  'evaluacion',
  'matricula',
  'seguimiento',
  'resolver_dudas',
];

// perdida y matriculado salen de la etapa del embudo; en_riesgo/en_seguimiento, de la IA.
export type ConversationState = 'en_seguimiento' | 'en_riesgo' | 'perdida' | 'matriculado';

export type Confidence = 'alta' | 'media' | 'baja';

export function subPoints(weight: number, level: LevelV2): number {
  if (level === 'completo') return weight;
  if (level === 'parcial') return weight / 2;
  return 0;
}

export interface ScoreV2 {
  dimensions: Record<DimensionKey, { points: number; evaluable: number; weight: number }>;
  points: number;
  evaluable: number;
  // null si nada fue evaluable
  total: number | null;
  // porcentaje de los 100 puntos que se pudieron evaluar
  coverage: number;
}

export function scoreV2(levels: Record<string, LevelV2>): ScoreV2 {
  const dimensions = Object.fromEntries(
    DIMENSIONS.map((d) => [d.key, { points: 0, evaluable: 0, weight: d.weight }]),
  ) as ScoreV2['dimensions'];
  for (const sub of SUBCRITERIA) {
    const level = levels[sub.key] ?? 'no_evaluable';
    if (level === 'no_evaluable') continue;
    dimensions[sub.dimension].points += subPoints(sub.weight, level);
    dimensions[sub.dimension].evaluable += sub.weight;
  }
  const points = Object.values(dimensions).reduce((sum, d) => sum + d.points, 0);
  const evaluable = Object.values(dimensions).reduce((sum, d) => sum + d.evaluable, 0);
  return {
    dimensions,
    points,
    evaluable,
    total: evaluable ? Math.round((100 * points) / evaluable) : null,
    coverage: evaluable,
  };
}

// Alta desde 80 % de cobertura, media desde 50 %. Baja un nivel si los
// mensajes se atribuyeron por responsable (sin autor) o hubo notas de voz que
// la IA no pudo oir.
export function confidenceFor(coverage: number, opts: { assigned: boolean; voiceNotes: number }): Confidence {
  let level = coverage >= 80 ? 2 : coverage >= 50 ? 1 : 0;
  if (opts.assigned || opts.voiceNotes > 0) level = Math.max(0, level - 1);
  return (['baja', 'media', 'alta'] as Confidence[])[level];
}

export function stateFor(leadStage: string | null, aiState: unknown): ConversationState {
  if (leadStage === 'venta_perdida') return 'perdida';
  if (leadStage === 'matriculado') return 'matriculado';
  return aiState === 'en_riesgo' ? 'en_riesgo' : 'en_seguimiento';
}
