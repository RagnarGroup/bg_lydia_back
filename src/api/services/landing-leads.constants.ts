// LYD-83: valores validos de la landing (brittanygroup.edu.pe/inscripciones).
// Compartido por el endpoint publico y la cola CRM.
export const LANDING_SEDE_CIUDAD = {
  Bustamante: 'Arequipa',
  Centro: 'Arequipa',
  Cayma: 'Arequipa',
  Lince: 'Lima',
  Miraflores: 'Lima',
} as const;

export type LandingSede = keyof typeof LANDING_SEDE_CIUDAD;

export const LANDING_SEDES = Object.keys(LANDING_SEDE_CIUDAD) as LandingSede[];

export const LANDING_PROGRAMAS = ['Adultos', 'Jóvenes', 'Niños', 'Au Pair'] as const;

export const LANDING_SOURCE = 'landing';

// Categoria del formulario de origen. El de brittanygroup.edu.pe/inscripciones
// no manda tags, asi que un lead sin tags es de inscripciones; Au Pair manda AUPAIR.
export const LANDING_DEFAULT_TAG = 'INSCRIPCIONES';

// La landing manda fecha y hora locales de Peru (sin DST, siempre UTC-5).
export const LANDING_TZ_OFFSET = '-05:00';

// LYD-100: consultas sin visita a sede (landings internacionales, p. ej.
// Spanish Immersion): se identifican por el email, sin sede ni fecha de visita.
// LYD-107: TEFL BrittanyGroup (tefl.brittanygroup.edu.pe; se llamaba TEFL
// England hasta LYD-109) usa el mismo tipo. LYD-108: Spanish TEFL
// (spanishteflperu.com) también. LYD-112: los formularios del sitio principal
// (brittanygroup.edu.pe), con el curso de interés y la sede que eligió la persona.
export const LANDING_TIPO_CONSULTA = 'consulta';
export const LANDING_PROGRAMAS_CONSULTA = [
  'Spanish Immersion',
  'TEFL BrittanyGroup',
  'Spanish TEFL',
  'Principal',
] as const;

// LYD-109: nombres viejos que se siguen aceptando y se guardan con el nombre
// actual (una página vieja abierta en el navegador o un backend sin actualizar
// no fallan, y la misma persona no termina en dos leads).
export const LANDING_PROGRAMA_ALIAS: Partial<Record<string, (typeof LANDING_PROGRAMAS_CONSULTA)[number]>> = {
  'TEFL England': 'TEFL BrittanyGroup',
};
export const LANDING_TAG_ALIAS: Partial<Record<string, string>> = {
  TEFL_ENGLAND: 'TEFL_BRITTANYGROUP',
};

// Etiquetas de los datos de la consulta que cambian según el programa (el resto
// usa la etiqueta por defecto del servicio): "nivel" es de español, de inglés o
// la certificación TEFL; "pais" es la nacionalidad en Spanish TEFL; "opcion" es
// el curso o servicio de interés en el sitio principal.
export const LANDING_DETALLE_LABEL: Record<
  (typeof LANDING_PROGRAMAS_CONSULTA)[number],
  Partial<Record<'nivel' | 'pais' | 'opcion', string>>
> = {
  'Spanish Immersion': { nivel: 'Nivel de español' },
  'TEFL BrittanyGroup': { nivel: 'Nivel de inglés' },
  'Spanish TEFL': { nivel: 'Certificación TEFL', pais: 'Nacionalidad' },
  Principal: { opcion: 'Interés' },
};
