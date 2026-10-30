// LYD-133: npx tsx --test test/commercial-audit-v2.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { latestParticipation } from '../src/api/services/chat-participants.util';
import { buildPromptV2, findQuote, parseEvaluationsV2 } from '../src/api/services/commercial-audit/audit-prompt-v2';
import {
  AI_SUBCRITERIA,
  confidenceFor,
  DIMENSIONS,
  LevelV2,
  scoreV2,
  stateFor,
  SUBCRITERIA,
} from '../src/api/services/commercial-audit/audit-rubric-v2';
import { businessMinutes, responseLags, speedLevel } from '../src/api/services/commercial-audit/audit-timing';
import { parseRubricVersion, scheduledRubric } from '../src/api/services/commercial-audit/audit-version';

// Instante Unix de una hora de Lima.
const lima = (iso: string) => Date.parse(`${iso}-05:00`) / 1000;

const only = (levels: Record<string, LevelV2>) => {
  const all = Object.fromEntries(SUBCRITERIA.map((s) => [s.key, 'no_evaluable'])) as Record<string, LevelV2>;
  return { ...all, ...levels };
};

describe('rubrica K01-V2.0', () => {
  it('pesa 100 en total y cada dimension suma lo de la directiva', () => {
    assert.equal(
      SUBCRITERIA.reduce((s, c) => s + c.weight, 0),
      100,
    );
    for (const d of DIMENSIONS) {
      const sum = SUBCRITERIA.filter((s) => s.dimension === d.key).reduce((s, c) => s + c.weight, 0);
      assert.equal(sum, d.weight, d.key);
    }
  });

  it('todo completo es 100 con cobertura total', () => {
    const score = scoreV2(Object.fromEntries(SUBCRITERIA.map((s) => [s.key, 'completo'])));
    assert.equal(score.total, 100);
    assert.equal(score.coverage, 100);
  });

  it('lo no evaluable sale del denominador en vez de contar como 0', () => {
    const score = scoreV2(only({ cta_paso: 'completo', og_beneficio: 'nulo' }));
    assert.equal(score.points, 14);
    assert.equal(score.evaluable, 24);
    assert.equal(score.total, 58); // 100 * 14 / 24 = 58,3
    assert.equal(score.coverage, 24);
  });

  it('el parcial vale la mitad exacta y se redondea solo al final', () => {
    const score = scoreV2(only({ og_intencion: 'completo', og_propuesta: 'parcial' }));
    assert.equal(score.points, 11.5);
    assert.equal(score.dimensions.ogilvy.points, 11.5);
    assert.equal(score.total, 77); // 100 * 11,5 / 15 = 76,7
  });

  it('sin nada evaluable no hay nota', () => {
    const score = scoreV2(only({}));
    assert.equal(score.total, null);
    assert.equal(score.coverage, 0);
  });

  it('la rapidez no va en el prompt: la calcula el codigo', () => {
    assert.ok(!AI_SUBCRITERIA.some((s) => s.key === 'ej_rapidez'));
    assert.ok(!buildPromptV2(['### Conversacion C1']).includes('ej_rapidez'));
  });

  it('confianza por cobertura, un nivel menos con atribucion por responsable o notas de voz', () => {
    assert.equal(confidenceFor(85, { assigned: false, voiceNotes: 0 }), 'alta');
    assert.equal(confidenceFor(85, { assigned: true, voiceNotes: 0 }), 'media');
    assert.equal(confidenceFor(60, { assigned: false, voiceNotes: 0 }), 'media');
    assert.equal(confidenceFor(60, { assigned: false, voiceNotes: 2 }), 'baja');
    assert.equal(confidenceFor(40, { assigned: false, voiceNotes: 0 }), 'baja');
  });

  it('perdida y matriculado salen del embudo; riesgo o seguimiento, de la IA', () => {
    assert.equal(stateFor('venta_perdida', 'en_seguimiento'), 'perdida');
    assert.equal(stateFor('matriculado', 'en_riesgo'), 'matriculado');
    assert.equal(stateFor('negociacion', 'en_riesgo'), 'en_riesgo');
    assert.equal(stateFor(null, 'perdida'), 'en_seguimiento');
  });
});

describe('rapidez en horario de atencion', () => {
  it('cuenta solo de lunes a sabado de 8:00 a 21:00 (Lima)', () => {
    assert.equal(businessMinutes(lima('2026-10-29T10:00:00'), lima('2026-10-29T10:30:00')), 30);
    // jueves 22:00 -> viernes 8:05
    assert.equal(businessMinutes(lima('2026-10-29T22:00:00'), lima('2026-10-30T08:05:00')), 5);
    // sabado 20:50 -> lunes 8:10 (domingo cerrado)
    assert.equal(businessMinutes(lima('2026-10-31T20:50:00'), lima('2026-11-02T08:10:00')), 20);
    assert.equal(businessMinutes(lima('2026-10-29T10:00:00'), lima('2026-10-29T09:00:00')), 0);
  });

  it('mide la primera respuesta a cada turno del cliente', () => {
    const windowEnd = lima('2026-10-29T21:00:00');
    const line = (iso: string, speaker: string, inWindow = true) => ({ at: lima(iso), speaker, inWindow });
    const lags = responseLags(
      [
        line('2026-10-28T20:00:00', 'cliente', false),
        line('2026-10-29T10:00:00', 'cliente'),
        line('2026-10-29T10:02:00', 'cliente'),
        line('2026-10-29T10:20:00', 'evaluada'),
        line('2026-10-29T10:21:00', 'evaluada'),
        line('2026-10-29T11:00:00', 'cliente'),
        line('2026-10-29T11:01:00', 'bot'),
        line('2026-10-29T15:00:00', 'cliente'),
      ],
      windowEnd,
    );
    assert.deepEqual(
      lags.map((l) => [l.minutes, l.replyAt === null]),
      [
        [20, false],
        [360, true],
      ],
    );
  });

  it('un turno reciente sin respuesta al corte no cuenta', () => {
    const windowEnd = lima('2026-10-29T21:00:00');
    assert.deepEqual(responseLags([{ at: lima('2026-10-29T20:30:00'), speaker: 'cliente', inWindow: true }], windowEnd), []);
  });

  it('nivel por promedio: hasta 15 min completo, hasta 60 parcial', () => {
    const lag = (minutes: number) => ({ clientAt: 0, replyAt: 1, minutes });
    assert.deepEqual(speedLevel([]), { level: 'no_evaluable', avgMinutes: null });
    assert.equal(speedLevel([lag(10), lag(20)]).level, 'completo');
    assert.equal(speedLevel([lag(30)]).level, 'parcial');
    assert.equal(speedLevel([lag(89), lag(97)]).level, 'nulo');
  });
});

describe('parseEvaluationsV2', () => {
  it('lo invalido o faltante queda no_evaluable, nunca nulo', () => {
    const [r] = parseEvaluationsV2(
      'Listo:\n' +
        JSON.stringify([
          {
            id: 'C1',
            aplica: true,
            criterios: { og_intencion: { nivel: 'completo', cita: ' Hola ', motivo: 'ok' }, cta_paso: { nivel: 'raro' } },
            diagnostico: [{ observacion: 'a' }, { observacion: '' }, { observacion: 'b' }, { observacion: 'c' }, { observacion: 'd' }],
            consejos: ['1', '2', '3', '4'],
            respuesta_sugerida: 'msg',
            proxima_accion: 'cena',
            estado: 'en_riesgo',
          },
        ]),
    );
    assert.equal(r.criterios.og_intencion.nivel, 'completo');
    assert.equal(r.criterios.og_intencion.cita, 'Hola');
    assert.equal(r.criterios.cta_paso.nivel, 'no_evaluable');
    assert.equal(r.criterios.ka_simplifica.nivel, 'no_evaluable');
    assert.equal(r.diagnostico.length, 3);
    assert.deepEqual(r.consejos, ['1', '2', '3']);
    assert.equal(r.proxima_accion, null);
  });

  it('sin arreglo JSON falla', () => {
    assert.throws(() => parseEvaluationsV2('no se'));
  });
});

describe('findQuote (solo evidencia verificable)', () => {
  const lines = [{ text: 'Hola, ¿desde qué ciudad nos escribes?' }, { text: '¡Tenemos clases el sábado a las 10 a. m.!' }];

  it('encuentra la cita sin importar tildes, signos ni mayusculas', () => {
    assert.equal(findQuote(lines, '"Desde que ciudad nos escribes"'), 0);
    assert.equal(findQuote(lines, 'tenemos clases... a las 10'), 1);
  });

  it('una cita inventada o vacia no se acepta', () => {
    assert.equal(findQuote(lines, 'te reservo la visita de manana'), -1);
    assert.equal(findQuote(lines, null), -1);
    assert.equal(findQuote(lines, '...'), -1);
  });
});

describe('version de rubrica', () => {
  it('acepta solo las versiones conocidas y por defecto programa la V1', () => {
    assert.equal(parseRubricVersion('K01-V2.0'), 'K01-V2.0');
    assert.equal(parseRubricVersion('V3'), null);
    const prev = process.env.COMMERCIAL_AUDIT_RUBRIC;
    delete process.env.COMMERCIAL_AUDIT_RUBRIC;
    assert.equal(scheduledRubric(), 'K01-V1');
    process.env.COMMERCIAL_AUDIT_RUBRIC = 'K01-V2.0';
    assert.equal(scheduledRubric(), 'K01-V2.0');
    if (prev === undefined) delete process.env.COMMERCIAL_AUDIT_RUBRIC;
    else process.env.COMMERCIAL_AUDIT_RUBRIC = prev;
  });
});

describe('participacion con dos corridas el mismo dia', () => {
  it('cada asesora aparece una sola vez', () => {
    const agent = { id: 'a1', name: 'Ana', email: null, color: null };
    const row = { chatId: 'c1', percent: 100, reason: null, Run: { reportDate: '2026-10-28' }, Agent: agent };
    const result = latestParticipation([row, { ...row }]);
    assert.equal(result.get('c1')?.length, 1);
  });
});
