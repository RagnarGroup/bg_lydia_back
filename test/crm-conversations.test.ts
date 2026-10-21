// LYD-79: npx tsx --test test/crm-conversations.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeCursor,
  encodeCursor,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  messagePreview,
  normalizeListLimit,
  parseChannel,
} from '../src/api/services/crm-conversations.util';

describe('normalizeListLimit', () => {
  it('sin limit no pagina', () => {
    assert.equal(normalizeListLimit(undefined), undefined);
    assert.equal(normalizeListLimit(''), undefined);
  });

  it('usa el default si es invalido', () => {
    assert.equal(normalizeListLimit('abc'), LIST_DEFAULT_LIMIT);
    assert.equal(normalizeListLimit('0'), LIST_DEFAULT_LIMIT);
    assert.equal(normalizeListLimit('-3'), LIST_DEFAULT_LIMIT);
  });

  it('respeta el valor pedido con tope', () => {
    assert.equal(normalizeListLimit('25'), 25);
    assert.equal(normalizeListLimit('5000'), LIST_MAX_LIMIT);
  });
});

describe('cursor', () => {
  it('ida y vuelta', () => {
    const cursor = { sortKey: 1760140800, id: 'cmg1abc:raro' };
    assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  });

  it('rechaza cursores mal formados', () => {
    assert.equal(decodeCursor(undefined), null);
    assert.equal(decodeCursor(''), null);
    assert.equal(decodeCursor(Buffer.from('sin-separador').toString('base64url')), null);
    assert.equal(decodeCursor(Buffer.from('abc:id').toString('base64url')), null);
    assert.equal(decodeCursor(Buffer.from('123:').toString('base64url')), null);
  });
});

describe('parseChannel', () => {
  it('acepta solo los canales conocidos', () => {
    assert.equal(parseChannel('instagram'), 'instagram');
    assert.equal(parseChannel('tiktok'), 'tiktok');
    assert.equal(parseChannel('telegram'), undefined);
    assert.equal(parseChannel(undefined), undefined);
  });
});

describe('messagePreview', () => {
  it('texto plano y extendido', () => {
    assert.equal(messagePreview({ conversation: 'hola' }), 'hola');
    assert.equal(messagePreview({ extendedTextMessage: { text: 'link' } }), 'link');
  });

  it('adjuntos: caption o tipo', () => {
    assert.equal(messagePreview({ imageMessage: {} }), 'Foto');
    assert.equal(messagePreview({ imageMessage: { caption: 'mi voucher' } }), 'mi voucher');
    assert.equal(messagePreview({ documentMessage: { fileName: 'ficha.pdf' } }), 'ficha.pdf');
    assert.equal(messagePreview({ audioMessage: {} }), 'Audio');
  });

  it('desconocido o nulo queda vacio', () => {
    assert.equal(messagePreview(null), '');
    assert.equal(messagePreview({ reactionMessage: {} }), '');
  });
});
