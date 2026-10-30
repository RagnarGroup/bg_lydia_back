// LYD-133: version de la rubrica de cada corrida. Las corridas son unicas por
// (fecha, version): reprocesar un dia con la V2 no borra la evaluacion V1.
// La corrida automatica de las 21:00 usa COMMERCIAL_AUDIT_RUBRIC (por defecto
// la V1 hasta validar la V2, LYD-135); solo esa version se envia a Direccion.

export const RUBRIC_V1 = 'K01-V1';
export const RUBRIC_V2 = 'K01-V2.0';

export type RubricVersion = typeof RUBRIC_V1 | typeof RUBRIC_V2;

const VERSIONS: RubricVersion[] = [RUBRIC_V1, RUBRIC_V2];

export function parseRubricVersion(value: unknown): RubricVersion | null {
  return VERSIONS.find((v) => v === value) ?? null;
}

export function scheduledRubric(): RubricVersion {
  return parseRubricVersion(process.env.COMMERCIAL_AUDIT_RUBRIC) ?? RUBRIC_V1;
}
