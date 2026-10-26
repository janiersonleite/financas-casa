// Dinheiro: máscara de moeda, formatação, soma, parcelamento, importação e datas (app.js/storage.js em node:vm).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadScripts, ROOT } = require('./load');
const { Utils } = loadScripts(['utils.js'], ['Utils']);
const { createCollector } = require('../qa-findings');
const { App, Storage } = loadScripts(['utils.js', 'storage.js', 'app.js'], ['App', 'Storage']);
const col = createCollector('money-findings.json');
test.after(() => col.flush());
const norm = s => s.replace(/\s+/g, ' ');

test('máscara de moeda: ida e volta', () => {
  assert.equal(App._toMaskedCurrency(1234.5), '1.234,50');
  assert.equal(App._toMaskedCurrency(0), '0,00');
  assert.equal(App._toMaskedCurrency(1000000), '1.000.000,00');
  assert.equal(App._parseMaskedCurrency('1.234,56'), 1234.56);
  assert.equal(App._parseMaskedCurrency('0,10'), 0.1);
  assert.equal(App._parseMaskedCurrency(''), 0);
  for (const v of [0.01, 9.99, 123.45, 99999.99]) assert.equal(App._parseMaskedCurrency(App._toMaskedCurrency(v)), v);
});

test('formatCurrency: pt-BR, negativo, 0.1+0.2', () => {
  assert.equal(norm(App.formatCurrency(1234.5)), 'R$ 1.234,50');
  assert.equal(norm(App.formatCurrency(0.1 + 0.2)), 'R$ 0,30');
  assert.equal(norm(App.formatCurrency(null)), 'R$ 0,00');
  assert.equal(norm(App.formatCurrency(-5)), '-R$ 5,00');
});

test('arredondamento consistente: máscara e formatCurrency concordam (MON-01)', () => {
  for (const v of [1.005, 2.675, 0.285, 1.255, 33.335, 0.1 + 0.2, 10.005]) {
    const m = App._toMaskedCurrency(v), f = norm(App.formatCurrency(v)).replace('R$ ', '');
    assert.equal(m, f, `divergência em ${v}: máscara=${m} formatCurrency=${f}`);
  }
  col.add('MON-01', 'CORRIGIDO', 'Máscara e formatCurrency usam o mesmo arredondamento (Utils.roundMoney)');
});

test('somas de lançamentos em centavos inteiros (MON-02)', () => {
  Storage.getBehavior = t => (t === 'in' ? 'soma' : 'subtrai');
  const s = Storage.summarizeList([{ value: 0.1, type: 'in' }, { value: 0.2, type: 'in' }]);
  assert.equal(s.income, 0.3); assert.equal(s.balance, 0.3);
  const t = Storage.summarizeList([{ value: 0.3, type: 'in' }, { value: 0.1, type: 'out' }, { value: 0.2, type: 'out' }]);
  assert.equal(t.balance, 0); assert.equal(t.expense, 0.3);
  assert.equal(Storage.summarizeList([]).balance, 0);
  col.add('MON-02', 'CORRIGIDO', 'summarizeList soma em centavos (0.1+0.2 = 0.3 exato; saldo 0 exato)');
});

test('parcelamento por valor total: soma das parcelas === total (MON-03)', () => {
  assert.deepEqual(Array.from(Utils.splitMoney(100, 3)), [33.34, 33.33, 33.33]);
  const casos = [[100, 3], [0.1, 3], [1000, 7], [1, 3], [0.01, 1], [99.99, 12], [1234.56, 5], [10, 4], [0.07, 7], [5000, 60], [19.9, 2], [0.3, 3]];
  for (const [total, n] of casos) {
    const p = Utils.splitMoney(total, n);
    assert.equal(p.length, n);
    assert.equal(p.reduce((a, v) => a + Math.round(v * 100), 0), Math.round(total * 100), `soma errada para ${total}/${n}`);
    assert.ok(Math.max(...p) - Math.min(...p) <= 0.01 + 1e-9, 'diferença entre parcelas > 1 centavo');
    assert.ok(p.every((v, i) => i === 0 || v <= p[i - 1]), 'sobra deve ficar nas primeiras parcelas');
  }
  // propriedade com valores aleatórios (semente fixa)
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 500; k++) {
    const n = 1 + Math.floor(rnd() * 24), cents = n + Math.floor(rnd() * 500000), total = cents / 100;
    const p = Utils.splitMoney(total, n);
    assert.equal(p.reduce((a, v) => a + Math.round(v * 100), 0), cents);
    assert.ok(p.every(v => v > 0));
  }
  // o saveModal usa o helper (e não a divisão antiga)
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.ok(/Utils\.splitMoney\(value, installQty\)/.test(src), 'saveModal deve usar Utils.splitMoney');
  assert.ok(!/Math\.round\(\(value \/ installQty\) \* 100\) \/ 100/.test(src), 'divisão antiga ainda presente');
  col.add('MON-03', 'CORRIGIDO', 'Parcelamento em centavos inteiros: 100 em 3x = 33,34 + 33,33 + 33,33', '500 casos aleatórios + 12 fixos: soma === total');
});

test('parseMoneyBR: tabela de regras (C1)', () => {
  const ok = { '1.234,56': 1234.56, 'R$ 1.234,56': 1234.56, 'R$1.234,56': 1234.56, '12,5': 12.5, '1.500': 1500, '1500.50': 1500.5, '1,234.56': 1234.56,
    '1.234.567': 1234567, '50.30': 50.3, '50,30': 50.3, '1.5': 1.5, '0,10': 0.1, '1500': 1500, '-50,30': -50.3, ' 99 ': 99, '1.234.567,89': 1234567.89, '0.5': 0.5 };
  for (const [k, v] of Object.entries(ok)) assert.equal(Utils.parseMoneyBR(k), v, k);
  for (const bad of ['abc', '', '  ', null, undefined, '0.500', '1,234', '1,5,3', '12.3.4', '.5', ',5', 'R$', '1.23.456', '12a', '--5', '1.2345,6']) assert.equal(Utils.parseMoneyBR(bad), null, 'deveria ser null: ' + JSON.stringify(bad));
  assert.equal(Utils.parseMoneyBR(12.5), 12.5);
});

test('importação: _parseImportValue com formatos BR/US', () => {
  assert.equal(App._parseImportValue(1234.5), 1234.5);
  assert.equal(App._parseImportValue('R$ 1.234,56'), 1234.56);
  assert.equal(App._parseImportValue('1,234.56'), 1234.56);
  assert.equal(App._parseImportValue('50,30'), 50.3);
  assert.equal(App._parseImportValue(''), 0);
  assert.equal(App._parseImportValue('abc'), 0);
  assert.equal(App._parseImportValue('1.500'), 1500);
  assert.equal(App._parseImportValue('2.000'), 2000);
  assert.equal(App._parseImportValue('1.500,75'), 1500.75);
  assert.equal(App._parseImportValue('R$ 1.234,56'), 1234.56);
  assert.equal(App._parseImportValue('1,234.56'), 1234.56);
  assert.equal(App._parseImportValue('1500.5'), 1500.5);
  assert.equal(App._parseImportValue('-150,00'), -150);
  assert.equal(App._parseImportValue('0.500'), 0);           // ambíguo → 0 (linha acusará valor inválido)
  col.add('MON-04', 'CORRIGIDO', 'Importação lê "1.500" como 1500 (regra única parseMoneyBR)');
});

test('_addMonths: fim de mês e virada de ano', () => {
  assert.equal(App._addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(App._addMonths('2026-03-31', 1), '2026-04-30');
  assert.equal(App._addMonths('2026-11-15', 3), '2027-02-15');
  assert.equal(App._addMonths('2024-01-31', 1), '2024-02-29');
});

test('[BUG-FUSO] _addMonths usa toISOString(): em fuso à frente do UTC o dia recua', () => {
  const script = `
    const { loadScripts } = require(${JSON.stringify(path.join(ROOT, 'tests', 'unit', 'load.js'))});
    const { App } = loadScripts(['storage.js','app.js'], ['App']);
    console.log(JSON.stringify({ a: App._addMonths('2026-01-15', 1), b: App._addMonths('2026-03-10', 2), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }));`;
  const out = {};
  for (const tz of ['America/Sao_Paulo', 'Europe/Lisbon', 'Asia/Tokyo']) {
    const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    out[tz] = r.status === 0 ? JSON.parse(r.stdout) : { erro: r.stderr.slice(0, 200) };
  }
  const brOk = out['America/Sao_Paulo'].a === '2026-02-15' && out['America/Sao_Paulo'].b === '2026-05-10';
  const errados = Object.entries(out).filter(([, v]) => v.a !== '2026-02-15' || v.b !== '2026-05-10').map(([z, v]) => `${z}: ${v.a}/${v.b}`);
  col.add('MON-05', errados.length ? 'PARCIAL' : 'NAO CONFIRMADO', 'Datas de parcelas/recorrências calculadas com toISOString() (UTC) dependem do fuso do aparelho',
    `Sao_Paulo ok=${brOk}; fusos com erro: ${errados.join(' | ') || 'nenhum'} (usuários no Brasil não são afetados; viajantes/expatriados em UTC+ sim)`);
});
