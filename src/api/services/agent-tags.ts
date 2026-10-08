// LYD-74: etiquetas comerciales del agente IA, una por grupo. Mismos valores
// que TAG_GROUPS en lydia_bg_front (AgentAssistantPanel.tsx): si se cambia
// uno, cambiar el otro.
export const AGENT_TAG_OPTIONS = {
  intencion: ['Frío', 'Interesado', 'Alta intención', 'Objeción', 'Postergado', 'Cerrado', 'Perdido'],
  decisor: ['Alumno', 'Mamá', 'Papá', 'Esposo/a', 'Tercero'],
  accion: ['Visita', 'Llamada', 'Horario', 'Evaluación', 'Matrícula', 'Pago', 'Follow-up'],
  fuente: ['Meta', 'TikTok', 'Volanteo', 'Banner', 'Referido', 'Walk-in', 'Otro'],
} as const;

export type AgentTagGroup = keyof typeof AGENT_TAG_OPTIONS;
export type AgentTags = Partial<Record<AgentTagGroup, string>>;

const GROUPS = Object.keys(AGENT_TAG_OPTIONS) as AgentTagGroup[];

const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// Devuelve el valor canonico (con tildes) o undefined si no es una opcion
// valida del grupo -- la IA a veces escribe sin tildes o en minusculas.
function canonical(group: AgentTagGroup, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const wanted = normalize(value);
  return AGENT_TAG_OPTIONS[group].find((option) => normalize(option) === wanted);
}

// Entrada de la asesora (PATCH): un grupo con null o "" se borra; un valor
// que no es opcion valida se ignora.
export function applyTagPatch(current: AgentTags, patch: unknown): AgentTags {
  const next: AgentTags = { ...current };
  if (!patch || typeof patch !== 'object') return next;
  for (const group of GROUPS) {
    if (!(group in patch)) continue;
    const raw = (patch as Record<string, unknown>)[group];
    if (raw === null || raw === '') {
      delete next[group];
      continue;
    }
    const value = canonical(group, raw);
    if (value) next[group] = value;
  }
  return next;
}

// Lo que propone la IA: solo pisa los grupos donde trae un valor valido; un
// null suyo significa "sin evidencia" y no borra lo que ya habia.
export function mergeAiTags(current: AgentTags, proposed: unknown): AgentTags {
  const next: AgentTags = { ...current };
  if (!proposed || typeof proposed !== 'object') return next;
  for (const group of GROUPS) {
    const value = canonical(group, (proposed as Record<string, unknown>)[group]);
    if (value) next[group] = value;
  }
  return next;
}

export function readAgentTags(stored: unknown): AgentTags {
  return applyTagPatch({}, stored);
}
