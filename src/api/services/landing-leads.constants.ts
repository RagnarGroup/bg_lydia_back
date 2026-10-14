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

// La landing manda fecha y hora locales de Peru (sin DST, siempre UTC-5).
export const LANDING_TZ_OFFSET = '-05:00';
