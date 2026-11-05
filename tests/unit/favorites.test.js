// T1: normalização, sugestões (limiar, favoritas, categoria mais usada, descrição × tipo), teclado de centavos, validação e métricas.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');
const { Favorites, Utils } = loadScripts(['utils.js', 'favorites.js'], ['Favorites', 'Utils']);
const { Metrics } = loadScripts(['metrics.js'], ['Metrics'], { document: { addEventListener() {} } });

const J = x => JSON.parse(JSON.stringify(x));   // resultados vêm de outro realm (node:vm): normaliza para deepEqual
const HOJE = '2026-11-04';
const tx = (description, type, date, category = 'Outros') => ({ description, type, date, category });
const rep = (n, ...a) => Array.from({ length: n }, () => tx(...a));

test('normalizeDesc: minúsculas, sem acento, espaços colapsados, sem sufixo de parcela', () => {
  assert.equal(Favorites.normalizeDesc('  Mercado   DA  Praça '), 'mercado da praca');
  assert.equal(Favorites.normalizeDesc('Salário'), 'salario');
  assert.equal(Favorites.normalizeDesc('Notebook (2/4)'), 'notebook');
  assert.equal(Favorites.normalizeDesc(null), '');
  assert.equal(Favorites.cleanName('  a   b  '), 'a b');
  assert.equal(Favorites.cleanName('x'.repeat(60)).length, 40);
});

test('sugestões: limiar de 3 ocorrências nos últimos 60 dias, ordenadas por frequência, sem valor', () => {
  const s = Favorites.suggest([...rep(3, 'Mercado', 'saida', '2026-10-20'), ...rep(2, 'Padaria', 'saida', '2026-10-20'), ...rep(5, 'Uber', 'saida', '2026-11-01')], [], { today: HOJE });
  assert.deepEqual(J(s.map(x => [x.name, x.type, x.count])), [['Uber', 'saida', 5], ['Mercado', 'saida', 3]]);
  for (const x of s) assert.deepEqual(J(Object.keys(x).sort()), ['category', 'count', 'name', 'type']);   // nunca valor
});

test('sugestões: janela de 60 dias (mais antigo ou futuro não conta)', () => {
  const s = Favorites.suggest([...rep(2, 'Aluguel', 'saida', '2026-10-01'), tx('Aluguel', 'saida', '2026-08-01'), tx('Aluguel', 'saida', '2026-12-01')], [], { today: HOJE });
  assert.deepEqual(J(s), [], 'só 2 dentro da janela');
  const s2 = Favorites.suggest([...rep(3, 'Aluguel', 'saida', '2026-09-06')], [], { today: HOJE });   // exatamente 59 dias
  assert.equal(s2.length, 1);
  assert.equal(Favorites.suggest(rep(3, 'Aluguel', 'saida', '2026-09-05'), [], { today: HOJE }).length, 1, 'exatamente 60 dias atrás: dentro (limite inclusivo)');
  assert.equal(Favorites.suggest(rep(3, 'Aluguel', 'saida', '2026-09-04'), [], { today: HOJE }).length, 0, '61 dias atrás fica de fora');
});

test('sugestões: agrupa por (descrição normalizada, TIPO) — mesmo nome em tipos diferentes gera 2 sugestões', () => {
  const s = Favorites.suggest([...rep(3, 'Mercado', 'saida', '2026-10-20'), ...rep(3, 'mercado', 'entrada', '2026-10-21')], [], { today: HOJE });
  assert.equal(s.length, 2);
  assert.deepEqual(J(s.map(x => x.type).sort()), ['entrada', 'saida']);
});

test('sugestões: ignora as já favoritas do MESMO tipo (e só desse tipo)', () => {
  const t = [...rep(3, 'Mercado', 'saida', '2026-10-20'), ...rep(3, 'Salário', 'entrada', '2026-10-05')];
  const s = Favorites.suggest(t, [{ name: ' mercado ', type: 'saida' }], { today: HOJE });
  assert.deepEqual(J(s.map(x => x.name)), ['Salário']);
  const s2 = Favorites.suggest(t, [{ name: 'Mercado', type: 'entrada' }], { today: HOJE });      // favorita de OUTRO tipo não esconde
  assert.deepEqual(J(s2.map(x => x.name).sort()), ['Mercado', 'Salário']);
});

test('sugestões: categoria sugerida = a mais usada do grupo; agrupa "Notebook (1/3)" e "Notebook (2/3)"', () => {
  const s = Favorites.suggest([tx('Mercado', 'saida', '2026-10-20', 'Alimentação'), tx('Mercado', 'saida', '2026-10-21', 'Lazer'), tx('Mercado', 'saida', '2026-10-22', 'Alimentação'),
    tx('Notebook (1/3)', 'saida', '2026-09-20'), tx('Notebook (2/3)', 'saida', '2026-10-20'), tx('Notebook (3/3)', 'saida', '2026-11-01')], [], { today: HOJE });
  assert.equal(s.find(x => x.name === 'Mercado').category, 'Alimentação');
  assert.equal(s.find(x => x.name === 'Notebook').count, 3);
  assert.deepEqual(J(Favorites.suggest([{ description: 'x', type: 'xpto', date: '2026-10-20' }, { description: '', type: 'saida', date: '2026-10-20' }], [], { today: HOJE })), []);
});

test('teclado de centavos: 1,5,0,0 = 1500; 00; apagar; teto; nunca negativo', () => {
  let c = 0; for (const k of ['1', '5', '0', '0']) c = Favorites.keypadPress(c, k);
  assert.equal(c, 1500); assert.equal(Favorites.formatCents(c), 'R$ 15,00');
  assert.equal(Favorites.keypadPress(5, '00'), 500);
  assert.equal(Favorites.keypadPress(0, '00'), 0);
  assert.equal(Favorites.keypadPress(0, '0'), 0);
  assert.equal(Favorites.keypadPress(1500, 'del'), 150);
  assert.equal(Favorites.keypadPress(5, 'del'), 0); assert.equal(Favorites.keypadPress(0, 'del'), 0);
  assert.equal(Favorites.keypadPress(999999999, '1'), 999999999, 'teto R$ 9.999.999,99');
  assert.equal(Favorites.keypadPress(99999999, '9'), 999999999);
  assert.equal(Favorites.keypadPress(99999999, '00'), 99999999, '00 estouraria o teto: ignora');
  for (const bad of ['x', '', null, '-', '1.5']) assert.equal(Favorites.keypadPress(100, bad), 100);
  for (const c0 of [-5, NaN, 1.5, undefined, null]) assert.ok(Favorites.keypadPress(c0, '1') >= 0);
  assert.equal(Favorites.formatCents(123456), 'R$ 1.234,56'); assert.equal(Favorites.formatCents(7), 'R$ 0,07'); assert.equal(Favorites.formatCents(-3), 'R$ 0,00');
});

test('centavos → valor sem float: 1999 → 19.99, 1 → 0.01, 10 → 0.1', () => {
  assert.equal(Favorites.centsToValue(1999), 19.99); assert.equal(Favorites.centsToValue(1), 0.01); assert.equal(Favorites.centsToValue(10), 0.1);
  assert.equal(Favorites.centsToValue(1500), 15); assert.equal(Favorites.centsToValue(999999999), 9999999.99);
});

test('validação: nome, tipo, duplicado no mesmo tipo, limite de 6 total, categoria compatível', () => {
  const cats = [{ id: 'c1', name: 'Mercado', type: 'saida' }, { id: 'c2', name: 'Salário', type: 'entrada' }, { id: 'c3', name: 'Outros', type: 'both' }, { id: 'd-food', name: 'Alimentação', type: 'saida' }];
  const v = (list, f) => Favorites.validate(list, f, cats);
  assert.match(v([], { name: '  ', type: 'saida' }), /nome/i);
  assert.match(v([], { name: 'x', type: 'xpto' }), /Saída ou Entrada/);
  assert.equal(v([], { name: 'Mercado', type: 'saida', categoryId: 'c1' }), null);
  assert.match(v([{ id: 'a', name: 'mercado', type: 'saida' }], { name: 'Mercado ', type: 'saida' }), /Já existe/);
  assert.equal(v([{ id: 'a', name: 'Mercado', type: 'saida' }], { name: 'Mercado', type: 'entrada', categoryId: 'c2' }), null, 'mesmo nome em outro tipo é aceito');
  assert.equal(v([{ id: 'a', name: 'Mercado', type: 'saida' }], { id: 'a', name: 'Mercado', type: 'saida' }), null, 'editar o próprio não conta como duplicado');
  const seis = Array.from({ length: 6 }, (_, i) => ({ id: 'f' + i, name: 'F' + i, type: i % 2 ? 'entrada' : 'saida' }));
  assert.match(v(seis, { name: 'Sétimo', type: 'entrada' }), /6 favoritos.*dividem/);
  assert.equal(v(seis, { id: 'f0', name: 'Renomeado', type: 'saida' }), null, 'editar com 6 é permitido');
  assert.match(v([], { name: 'x', type: 'entrada', categoryId: 'c1' }), /não combina/);
  assert.equal(v([], { name: 'x', type: 'entrada', categoryId: 'c3' }), null, 'both serve aos dois');
  assert.match(v([], { name: 'x', type: 'saida', categoryId: 'd-food' }), /não pode ser usada/, 'categoria padrão (sem linha no banco) não vale');
  assert.match(v([], { name: 'x', type: 'saida', categoryId: 'inexistente' }), /não pode ser usada/);
});

test('Metrics: contagem, mediana de toques e de segundos por método; nada além de agregados em localStorage', () => {
  const store = {};
  const { Metrics: M } = loadScripts(['metrics.js'], ['Metrics'], { document: { addEventListener() {} }, localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } } });
  M.reset();
  for (const taps of [3, 5, 7]) { M.begin('favorito', 1); for (let i = 1; i < taps; i++) M.tap(); M.end(); }
  M.begin('formulario', 1); M.tap(); M.end();
  M.begin('xpto'); assert.equal(M.end(), null, 'método desconhecido é ignorado');
  const s = M.summary();
  assert.equal(s.favorito.count, 3); assert.equal(s.favorito.medianTaps, 5); assert.equal(s.formulario.count, 1); assert.equal(s.texto.count, 0); assert.equal(s.texto.medianTaps, null);
  assert.deepEqual(Object.keys(JSON.parse(store.metrics_v1)).sort(), ['favorito', 'formulario']);
  assert.doesNotMatch(store.metrics_v1, /@|nome|descri/i);
  M.begin('favorito'); M.cancel(); assert.equal(M.end(), null, 'cancelado não registra');
  assert.equal(M.median([1, 2, 3, 4]), 2.5); assert.equal(M.median([]), null);
  for (let i = 0; i < 150; i++) { M.begin('atalho', 0); M.end(); }
  assert.equal(JSON.parse(store.metrics_v1).atalho.taps.length, 100, 'guarda só as últimas 100 amostras');
});
