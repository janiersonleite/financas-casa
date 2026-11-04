// Correção 1: Utils.walletChip(financa, memberCount) — a fonte da verdade é o nº de membros reais, nunca financas.type.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');
const { Utils } = loadScripts(['utils.js'], ['Utils']);

test('n = 1 → "Só você" com ícone de pessoa', () => {
  const c = Utils.walletChip({ type: 'compartilhada' }, 1);
  assert.deepEqual({ kind: c.kind, text: c.text, icon: c.icon, n: c.n }, { kind: 'solo', text: 'Só você', icon: 'person', n: 1 });
});

test('n = 2 → "Compartilhada · 2" com ícone de pessoas', () => {
  const c = Utils.walletChip({ type: 'individual' }, 2);
  assert.deepEqual({ kind: c.kind, text: c.text, icon: c.icon, n: c.n }, { kind: 'shared', text: 'Compartilhada · 2', icon: 'people', n: 2 });
});

test('n = 5 → "Compartilhada · 5"', () => {
  assert.equal(Utils.walletChip({ id: 'x' }, 5).text, 'Compartilhada · 5');
});

test('type = "individual" com 2 membros → "Compartilhada · 2" (o type é ignorado)', () => {
  assert.equal(Utils.walletChip({ type: 'individual' }, 2).text, 'Compartilhada · 2');
  assert.equal(Utils.walletChip({ type: 'compartilhada' }, 1).text, 'Só você');
  assert.equal(Utils.walletChip({ type: 'familiar' }, 1).text, 'Só você');
  for (const t of ['individual', 'compartilhada', 'familiar', undefined, null]) assert.equal(Utils.walletChip(t === undefined ? undefined : { type: t }, 3).text, 'Compartilhada · 3');
});

test('contagem ainda não carregada (undefined) → esqueleto; NUNCA "Só você" por padrão', () => {
  for (const f of [{ type: 'individual' }, { type: 'compartilhada' }, null, undefined]) {
    const c = Utils.walletChip(f, undefined);
    assert.equal(c.kind, 'loading'); assert.equal(c.text, ''); assert.equal(c.icon, null);
    assert.doesNotMatch(JSON.stringify(c), /Só você/);
  }
  assert.equal(Utils.walletChip({ type: 'individual' }).kind, 'loading', 'sem o 2º argumento também é "carregando"');
});

test('falha ao carregar (null) ou valor inválido → chip oculto, sem texto errado', () => {
  for (const v of [null, 0, -1, NaN, 1.5, 'abc', {}]) {
    const c = Utils.walletChip({ type: 'individual' }, v);
    assert.equal(c.kind, 'hidden', String(v)); assert.equal(c.text, ''); assert.equal(c.icon, null);
  }
});
