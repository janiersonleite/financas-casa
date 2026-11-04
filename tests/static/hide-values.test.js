// Botão "ocultar valores" da tela inicial (jsdom): máscara em saldo, entradas, saídas e lembretes (NÃO nos lançamentos); preferência persistida.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const r = spawnSync(process.execPath, [path.join(__dirname, 'hide-values-runner.js')], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
const o = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}');
const n = t => t.replace(/\s/g, ' ');   // formatCurrency usa espaço não separável após "R$"
const temValor = t => /R\$\s*\d|\d+,\d{2}/.test(t);
const todos = h => [h.saldo, h.entradas, h.saidas, h.lembretes];   // os lançamentos ficam de fora de propósito

test('o runner jsdom terminou sem erro', () => { assert.equal(r.status, 0, r.stderr + (o.erro || '')); });

test('botão na tela inicial, ao lado do "Saldo do mês", com aria-pressed e rótulo; começa mostrando os valores', () => {
  assert.ok(o.botao.existe && o.botao.ehButton && o.botao.naHome);
  assert.equal(o.botao.pertoDoSaldo, true, 'o botão deve ficar na mesma linha do rótulo "Saldo do mês"');
  assert.equal(o.visivel.pressed, 'false'); assert.equal(o.visivel.rotulo, 'Ocultar valores'); assert.equal(o.visivel.icone, 'olho');
  assert.equal(n(o.visivel.saldo), '-R$ 6.378,23'); assert.equal(n(o.visivel.saidas), 'R$ 6.378,23');
  assert.ok(temValor(o.visivel.lista) && temValor(o.visivel.lembretes));
});

test('ligado: saldo, entradas, saídas e valores dos lembretes viram •••••; nenhum número vaza deles', () => {
  assert.equal(o.oculto.saldo, 'R$ •••••'); assert.equal(o.oculto.entradas, '•••••'); assert.equal(o.oculto.saidas, '•••••');
  for (const t of todos(o.oculto)) assert.equal(temValor(t), false, 'valor vazou: ' + t.replace(/\s+/g, ' ').slice(0, 120));
  assert.equal(o.oculto.pressed, 'true'); assert.equal(o.oculto.rotulo, 'Mostrar valores'); assert.equal(o.oculto.icone, 'olho-cortado');
});

test('saldo negativo oculto não usa a cor vermelha (a cor entregaria o sinal)', () => {
  assert.match(o.visivel.saldoClasse, /text-red-300/); assert.doesNotMatch(o.oculto.saldoClasse, /text-red-300/);
});

test('preferência guardada no aparelho (localStorage) e mantida ao redesenhar a Home; desligar volta a mostrar', () => {
  assert.equal(o.oculto.guardado, '1'); assert.equal(o['apósRerender'].saldo, 'R$ •••••');
  assert.equal(o.denovoVisivel.guardado, '0'); assert.equal(o.denovoVisivel.pressed, 'false'); assert.equal(n(o.denovoVisivel.saldo), '-R$ 6.378,23');
});

test('os lançamentos NÃO são ocultados (valor e "Total" do parcelamento continuam visíveis na Início); o Histórico também', () => {
  assert.ok(temValor(o.oculto.lista) && /Total R\$/.test(n(o.oculto.lista)), 'lançamentos ocultados: ' + o.oculto.lista.replace(/\s+/g, ' ').slice(0, 120));
  assert.equal(n(o.oculto.lista), n(o.visivel.lista));
  assert.ok(temValor(o.historico), 'histórico: ' + o.historico.slice(0, 80));
});
