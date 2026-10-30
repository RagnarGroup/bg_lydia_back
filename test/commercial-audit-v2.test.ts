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

// ---------- LYD-134: reporte diario V2 ----------

import { fallbackCoaching, parseCoaching } from '../src/api/services/commercial-audit/audit-coaching';
import {
  buildAuditReportHtmlV2,
  conversationSede,
  ReportAuditV2,
} from '../src/api/services/commercial-audit/audit-report-v2';

const agentA = { id: 'a1', name: 'Ana', sedes: ['Cayma'] };
const agentB = { id: 'a2', name: 'Bea', sedes: ['Centro', 'Cayma'] };

function audit(over: Partial<ReportAuditV2> & { chatId: string }, result: Partial<ReportAuditV2['result']> = {}) {
  const dims = Object.fromEntries(DIMENSIONS.map((d) => [d.key, { points: d.weight / 2, evaluable: d.weight, weight: d.weight }]));
  return {
    agentId: 'a1',
    attribution: 'exacta',
    applicable: true,
    total: 50,
    coverage: 100,
    confidence: 'alta',
    state: 'en_seguimiento',
    Agent: agentA,
    percent: 100,
    weight: 1,
    ...over,
    result: {
      alias: `Cliente #${over.chatId}`,
      leadStage: 'negociacion',
      leadSede: null,
      stats: { avgResponseMinutes: 5, lastFromClient: false, voiceNotes: 0 },
      rapidez: { promedioMinutos: 5, demoras: [] },
      criterios: {},
      dimensiones: dims,
      puntos: 50,
      evaluables: 100,
      diagnostico: [],
      consejos: [],
      respuestaSugerida: null,
      proximaAccion: 'visita',
      motivoNoAplica: null,
      ...result,
    },
  } as ReportAuditV2;
}

const reportInput = (audits: ReportAuditV2[]) => ({
  reportDate: '2026-10-28',
  windowStart: lima('2026-10-27T21:00:00'),
  windowEnd: lima('2026-10-28T21:00:00'),
  unattributed: 0,
  lowParticipation: 0,
  failed: 0,
  frontUrl: 'https://crm.example',
  audits,
  previous: [],
  coaching: { a1: { items: ['Proponer dos horarios de visita'], fallback: false } },
});

describe('coaching por asesora', () => {
  it('toma hasta 3 recomendaciones validas por etiqueta', () => {
    const map = parseCoaching('ok [{"id":"A","recomendaciones":["1"," 2 ","",3,"4","5"]},{"id":"B"}]');
    assert.deepEqual(map.get('A'), ['1', '2', '4']);
    assert.equal(map.has('B'), false);
  });

  it('el respaldo usa los consejos de la conversacion mas baja sin repetir', () => {
    assert.deepEqual(
      fallbackCoaching([
        { total: 80, tips: ['x', 'y'] },
        { total: 20, tips: ['a', 'x'] },
      ]),
      ['a', 'x', 'y'],
    );
  });
});

describe('sede de una conversacion (sin duplicar)', () => {
  it('sede del lead, unica sede de la asesora o multisede', () => {
    assert.equal(conversationSede([audit({ chatId: '1', Agent: agentB }, { leadSede: 'Lince' })]), 'Lince');
    assert.equal(conversationSede([audit({ chatId: '1' })]), 'Cayma');
    assert.equal(conversationSede([audit({ chatId: '1', Agent: agentB })]), 'Asesora multisede');
  });
});

describe('buildAuditReportHtmlV2', () => {
  const html = buildAuditReportHtmlV2(
    reportInput([
      audit({ chatId: 'A1', total: 90 }),
      audit({ chatId: 'A2', total: 80 }),
      audit({ chatId: 'A3', total: 30 }, { respuestaSugerida: '¿Te espero hoy o mañana?' }),
      audit({ chatId: 'B1', agentId: 'a2', Agent: agentB, total: 10, state: 'perdida' }),
      audit({ chatId: 'B2', agentId: 'a2', Agent: agentB, total: 20, confidence: 'baja', coverage: 30 }),
      audit({ chatId: 'B3', agentId: 'a2', Agent: agentB, total: 40, state: 'en_riesgo' }),
      audit({ chatId: 'N1', applicable: false, total: null, coverage: null, confidence: null, state: null }),
      audit({ chatId: 'C1', agentId: 'a3', Agent: { id: 'a3', name: 'Caro', sedes: ['Lince'] }, total: 70 }),
    ]),
  );

  it('rankea solo con muestra suficiente y avisa la insuficiente', () => {
    assert.match(html, /Ranking por asesora/);
    assert.match(html, /muestra insuficiente/);
  });

  it('las criticas excluyen perdidas y confianza baja', () => {
    const critical = html.slice(html.indexOf('críticas del día'), html.indexOf('En riesgo'));
    assert.ok(critical.includes('Cliente #A3'));
    assert.ok(critical.includes('Cliente #B3'));
    assert.ok(!critical.includes('Cliente #B1'));
    assert.ok(!critical.includes('Cliente #B2'));
    assert.ok(critical.includes('50 de 100 puntos evaluables'));
    assert.ok(critical.includes('¿Te espero hoy o mañana?'));
  });

  it('en riesgo y perdidas van separadas', () => {
    const risk = html.slice(html.indexOf('En riesgo (para'), html.indexOf('Oportunidades perdidas'));
    assert.ok(risk.includes('Cliente #B3') && !risk.includes('Cliente #B1'));
    const lost = html.slice(html.indexOf('Oportunidades perdidas'), html.indexOf('Evaluaciones incompletas'));
    assert.ok(lost.includes('Cliente #B1') && !lost.includes('Cliente #B3'));
  });

  it('muestra las evaluaciones de confianza baja, el coaching y los avisos', () => {
    const low = html.slice(html.indexOf('Evaluaciones incompletas'), html.indexOf('<h2', html.indexOf('Evaluaciones incompletas') + 5));
    assert.ok(low.includes('Cliente #B2') && low.includes('cobertura 30 %'));
    assert.ok(html.includes('Proponer dos horarios de visita'));
    assert.ok(html.includes('no es prueba suficiente para sanciones laborales'));
    assert.ok(html.includes('no son comparables'));
  });

  it('las no comerciales no entran en los promedios', () => {
    // Ana: (90+80+30)/3 = 67; la N/A no cuenta
    assert.match(html, /<b>67<\/b>\/100/);
  });
});
