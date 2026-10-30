// LYD-133: rapidez de respuesta de la rubrica K01-V2.0, calculada con las
// marcas temporales reales de los mensajes (no la estima la IA). Solo cuenta
// el tiempo dentro del horario de atencion: un mensaje de las 22:00 que se
// contesta a las 8:05 del dia siguiente son 5 minutos, no 10 horas.

const LIMA_OFFSET_SECONDS = -5 * 3600;

// Horario de atencion comercial (hora de Lima): lunes a sabado de 8:00 a 21:00.
export const BUSINESS_HOURS = { open: 8, close: 21, closedWeekdays: [0] };

// Promedio de demora (minutos de atencion) para completo / parcial.
export const FAST_MINUTES = 15;
export const SLOW_MINUTES = 60;

export interface TimingLine {
  at: number;
  speaker: string;
  inWindow: boolean;
}

export interface ResponseLag {
  clientAt: number;
  // null: el cliente seguia esperando al corte.
  replyAt: number | null;
  minutes: number;
}

// Minutos de horario de atencion entre dos instantes Unix (segundos).
export function businessMinutes(from: number, to: number): number {
  if (to <= from) return 0;
  const localFrom = from + LIMA_OFFSET_SECONDS;
  const localTo = to + LIMA_OFFSET_SECONDS;
  let seconds = 0;
  for (let day = Math.floor(localFrom / 86400); day * 86400 < localTo; day++) {
    if (BUSINESS_HOURS.closedWeekdays.includes(new Date(day * 86400_000).getUTCDay())) continue;
    const open = day * 86400 + BUSINESS_HOURS.open * 3600;
    const close = day * 86400 + BUSINESS_HOURS.close * 3600;
    seconds += Math.max(0, Math.min(localTo, close) - Math.max(localFrom, open));
  }
  return Math.round(seconds / 60);
}

// Demora de la primera respuesta de la asesora evaluada a cada turno del
// cliente en la ventana. Si contesta otra persona (otra asesora, el bot), el
// cliente ya no la espera. Un turno sin respuesta al corte solo cuenta cuando
// ya pasa la demora lenta: uno de las 20:55 todavia estaba a tiempo.
export function responseLags(lines: TimingLine[], windowEnd: number): ResponseLag[] {
  const lags: ResponseLag[] = [];
  let pendingAt: number | null = null;
  for (const line of lines.filter((l) => l.inWindow)) {
    if (line.speaker === 'cliente') {
      if (pendingAt === null) pendingAt = line.at;
    } else if (pendingAt !== null) {
      if (line.speaker === 'evaluada') {
        lags.push({ clientAt: pendingAt, replyAt: line.at, minutes: businessMinutes(pendingAt, line.at) });
      }
      pendingAt = null;
    }
  }
  if (pendingAt !== null) {
    const minutes = businessMinutes(pendingAt, windowEnd);
    if (minutes > SLOW_MINUTES) lags.push({ clientAt: pendingAt, replyAt: null, minutes });
  }
  return lags;
}

export type SpeedLevel = 'completo' | 'parcial' | 'nulo' | 'no_evaluable';

export function speedLevel(lags: ResponseLag[]): { level: SpeedLevel; avgMinutes: number | null } {
  if (!lags.length) return { level: 'no_evaluable', avgMinutes: null };
  const avg = lags.reduce((sum, l) => sum + l.minutes, 0) / lags.length;
  const level = avg <= FAST_MINUTES ? 'completo' : avg <= SLOW_MINUTES ? 'parcial' : 'nulo';
  return { level, avgMinutes: Math.round(avg) };
}
