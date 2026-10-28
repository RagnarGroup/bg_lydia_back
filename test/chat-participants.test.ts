// LYD-117: npx tsx --test test/chat-participants.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildParticipationPrompt,
  normalizePercents,
  parseParticipation,
} from '../src/api/services/commercial-audit/audit-participation';
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
