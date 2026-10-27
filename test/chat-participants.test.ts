// LYD-117: npx tsx --test test/chat-participants.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { groupParticipants } from '../src/api/services/chat-participants.util';

const ana = { id: 'a1', name: 'Ana', email: 'ana@x.pe', color: '#f00' };
const bea = { id: 'a2', name: 'Bea', email: null, color: null };

describe('groupParticipants', () => {
  it('agrupa por chat y ordena por quien escribio primero', () => {
    const result = groupParticipants(
      [
        { chatId: 'c1', agentId: 'a1', messages: 3, firstAt: 200, lastAt: 500 },
        { chatId: 'c1', agentId: 'a2', messages: 1, firstAt: 100, lastAt: 100 },
        { chatId: 'c2', agentId: 'a1', messages: 2, firstAt: 50, lastAt: 60 },
      ],
      [ana, bea],
    );

    assert.deepEqual(
      result.get('c1')?.map((p) => [p.agent.name, p.messages]),
      [
        ['Bea', 1],
        ['Ana', 3],
      ],
    );
    assert.equal(result.get('c2')?.length, 1);
    assert.equal(result.get('c1')?.[1].lastMessageAt, new Date(500_000).toISOString());
  });

  it('descarta asesoras que ya no existen', () => {
    const result = groupParticipants([{ chatId: 'c1', agentId: 'borrada', messages: 4, firstAt: 1, lastAt: 2 }], [ana]);
    assert.equal(result.has('c1'), false);
  });
});
