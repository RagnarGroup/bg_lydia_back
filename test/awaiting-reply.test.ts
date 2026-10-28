// LYD-118: npx tsx --test test/awaiting-reply.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AWAITING_REPLY_WINDOW_SECONDS, isAwaitingReplyCandidate } from '../src/api/services/crm-conversations.util';

const NOW = 1_800_000_000;
const message = (secondsAgo: number) => ({ messageTimestamp: NOW - secondsAgo });

describe('isAwaitingReplyCandidate', () => {
  it('chat con actividad reciente: candidato (la consulta decide si espera)', () => {
    assert.equal(isAwaitingReplyCandidate(message(60), NOW), true);
  });

  it('fuera de la ventana de 24 h: no alerta', () => {
    assert.equal(isAwaitingReplyCandidate(message(AWAITING_REPLY_WINDOW_SECONDS), NOW), true);
    assert.equal(isAwaitingReplyCandidate(message(AWAITING_REPLY_WINDOW_SECONDS + 1), NOW), false);
  });

  it('chat sin mensajes', () => {
    assert.equal(isAwaitingReplyCandidate(undefined, NOW), false);
  });
});
