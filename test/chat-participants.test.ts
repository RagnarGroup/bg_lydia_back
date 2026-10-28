// LYD-117: npx tsx --test test/chat-participants.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildParticipationPrompt,
  normalizePercents,
  parseParticipation,
  participationWeight,
} from '../src/api/services/commercial-audit/audit-participation';
import { buildAuditReportHtml, ReportAudit } from '../src/api/services/commercial-audit/audit-report';
import { latestParticipation } from '../src/api/services/chat-participants.util';

const ana = { id: 'a1', name: 'Ana', email: 'ana@x.pe', color: '#f00' };
const bea = { id: 'a2', name: 'Bea', email: null, color: null };

describe('normalizePercents', () => {
  it('ajusta a 100 respetando la proporcion', () => {
    assert.deepEqual(normalizePercents(['A', 'B'], { A: 60, B: 30 }), { A: 67, B: 33 });
    assert.deepEqual(normalizePercents(['A', 'B', 'C'], { A: 1, B: 1, C: 1 }), { A: 34, B: 33, C: 33 });
  });

  it('ignora etiquetas desconocidas y valores invalidos', () => {
    assert.deepEqual(normalizePercents(['A', 'B'], { A: 80, B: 'x', Z: 50 }), { A: 100, B: 0 });
  });

  it('sin datos reparte en partes iguales', () => {
    assert.deepEqual(normalizePercents(['A', 'B'], null), { A: 50, B: 50 });
    assert.deepEqual(normalizePercents(['A', 'B'], { A: 0, B: -5 }), { A: 50, B: 50 });
  });
});

describe('parseParticipation', () => {
  it('extrae el arreglo aunque venga con texto alrededor', () => {
    const [r] = parseParticipation(
      'Listo:\n[{"id":"P1","porcentajes":{"A":70,"B":30},"aportes":{"A":"Cerro la visita.","B":"","C":3}}]\n',
    );
    assert.deepEqual(r, { id: 'P1', porcentajes: { A: 70, B: 30 }, aportes: { A: 'Cerro la visita.' } });
  });

  it('descarta objetos sin porcentajes', () => {
    assert.equal(parseParticipation('[{"id":"P1"}]').length, 0);
    assert.throws(() => parseParticipation('sin json'));
  });
});

describe('buildParticipationPrompt', () => {
  it('etiqueta asesoras y no las identifica por nombre', () => {
    const prompt = buildParticipationPrompt([
      {
        ref: 'P1',
        labels: ['A', 'B'],
        lines: [
          { at: '26/10 10:00', speaker: 'bot', text: 'Hola, bienvenido' },
          { at: '26/10 10:05', speaker: 'asesora', label: 'B', text: 'Te cuento del programa' },
        ],
      },
    ]);
    assert.match(prompt, /Bot \(automatico\): Hola/);
    assert.match(prompt, /Asesora B: Te cuento/);
    assert.match(prompt, /NO midas cantidad de mensajes/);
  });
});

describe('latestParticipation', () => {
  it('usa la corrida mas reciente de cada chat y ordena por porcentaje', () => {
    const result = latestParticipation([
      { chatId: 'c1', percent: 100, reason: null, Run: { reportDate: '2026-10-23' }, Agent: ana },
      { chatId: 'c1', percent: 40, reason: 'r', Run: { reportDate: '2026-10-26' }, Agent: ana },
      { chatId: 'c1', percent: 60, reason: 'r', Run: { reportDate: '2026-10-26' }, Agent: bea },
      { chatId: 'c2', percent: 100, reason: null, Run: { reportDate: '2026-10-24' }, Agent: bea },
    ]);
    assert.deepEqual(
      result.get('c1')?.map((p) => [p.agent.name, p.percent, p.reportDate]),
      [
        ['Bea', 60, '2026-10-26'],
        ['Ana', 40, '2026-10-26'],
      ],
    );
    assert.equal(result.get('c2')?.[0].percent, 100);
  });
});

describe('participationWeight (LYD-123)', () => {
  it('hasta 20 no cuenta, 21-39 la mitad, desde 40 completa', () => {
    assert.deepEqual([0, 20, 21, 39, 40, 100].map(participationWeight), [0, 0, 0.5, 0.5, 1, 1]);
  });

  it('sin participacion calculada cuenta completa', () => {
    assert.equal(participationWeight(null), 1);
    assert.equal(participationWeight(undefined), 1);
  });
});

describe('buildAuditReportHtml ponderado (LYD-123)', () => {
  const audit = (chatId: string, total: number, weight: number): ReportAudit => ({
    chatId,
    agentId: 'a1',
    attribution: 'exacta',
    applicable: true,
    total,
    lossAversion: 0,
    cta: 0,
    diagnostico: 0,
    valor: 0,
    ejecucion: 0,
    result: {
      alias: chatId,
      leadStage: null,
      stats: { avgResponseMinutes: null, lastFromClient: false, voiceNotes: 0 },
      niveles: {},
      evidencia: {},
      falto: null,
      respuestaSugerida: null,
      mejorFrase: null,
      motivoNoAplica: null,
    },
    Agent: { id: 'a1', name: 'Ana', sedes: ['Lince'] },
    percent: weight === 1 ? 100 : 30,
    weight,
  });

  it('la conversacion con participacion parcial pesa la mitad en el promedio', () => {
    const html = buildAuditReportHtml({
      reportDate: '2026-10-27',
      windowStart: 0,
      windowEnd: 86400,
      unattributed: 0,
      lowParticipation: 2,
      failed: 0,
      frontUrl: 'https://x',
      audits: [audit('c1', 80, 1), audit('c2', 20, 0.5)],
      previous: [],
    });
    assert.match(html, /<b>60<\/b>\/100/);
    assert.match(html, /\(1 a mitad\)/);
    assert.match(html, /2 participaciones de 20 % o menos no se evaluaron/);
  });
});
