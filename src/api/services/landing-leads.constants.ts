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
export const LANDING_TIPO_CONSULTA = 'consulta';
export const LANDING_PROGRAMAS_CONSULTA = ['Spanish Immersion'] as const;
