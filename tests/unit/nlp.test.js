// Testes de js/nlp.js (carregado em node:vm, sem alterar o arquivo).
// Primeiro descobre-se o comportamento real; só vira [BUG] o que contradiz o próprio código/UX.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');
const { createCollector } = require('../qa-findings');
const { NLP } = loadScripts(['utils.js', 'nlp.js'], ['NLP']);
const col = createCollector('nlp-findings.json');
test.after(() => col.flush());

const V = t => NLP.extractValue(t);

test('valores simples e com "reais"', () => {
  assert.equal(V('gastei 50 no mercado'), 50);
  assert.equal(V('20 reais em lanche'), 20);
  assert.equal(V('gastei 50 centavos'), 0.5);
  assert.equal(V('gastei 10 reais e 50 centavos'), 10.5);
  assert.equal(V('recebi 0,50'), 0.5);
});

test('formatos brasileiros com R$ e vírgula', () => {
  assert.equal(V('R$ 12,5 padaria'), 12.5);
  assert.equal(V('50,00 uber'), 50);
  assert.equal(V('R$ 2.500'), 2500);
  assert.equal(V('R$1.234,56'), 1234.56);
  assert.equal(V('gastei 1234,56'), 1234.56);
  assert.equal(V('paguei 1.500 de aluguel'), 1500);
  assert.equal(V('1.234.567,89 reais'), 1234567.89);
  assert.equal(V('comprei por 99.90'), 99.9);
});

test('frases sem valor devolvem null', () => {
  assert.equal(V('sem valor aqui'), null);
  assert.equal(V(''), null);
});

test('números por extenso e fala ("vírgula")', () => {
  assert.equal(V('cinco reais'), 5);
  assert.equal(V('vinte e cinco reais de pao'), 25);
  assert.equal(V('cento e vinte reais'), 120);
  assert.equal(V('dois mil reais'), 2000);
  assert.equal(V('mil e quinhentos reais'), 1500);
  assert.equal(V('gastei 118 vírgula 40 na farmacia'), 118.4);
});

test('"1.234,56" sem "R$"/"reais" agora é lido corretamente (NLP-01)', () => {
  assert.equal(V('gastei 1.234,56 no mercado'), 1234.56);
  assert.equal(V('R$ 1.234,56 no mercado'), 1234.56);
  assert.equal(V('1.234,56 reais no mercado'), 1234.56);
  assert.equal(V('gastei 12.345 no carro'), 12345);
  assert.equal(V('paguei 1.234.567,89 na casa'), 1234567.89);
  assert.equal(V('gastei 234,56 no mercado'), 234.56);       // sem regressão
  col.add('NLP-01', 'CORRIGIDO', 'Milhar com vírgula sem "R$"/"reais" lido corretamente', 'gastei 1.234,56 no mercado → 1234.56');
});

test('"1 mil reais" / "2 mil" / "1,5 mil" (NLP-02)', () => {
  assert.equal(V('1 mil reais'), 1000);
  assert.equal(V('gastei 2 mil no carro'), 2000);
  assert.equal(V('recebi 1,5 mil de freela'), 1500);
  assert.equal(V('dois mil reais'), 2000);      // por extenso segue funcionando
  col.add('NLP-02', 'CORRIGIDO', 'Algarismo + "mil" entendido', '1 mil reais → 1000');
});

test('limitação documentada: "3 parcelas de 100" e "5 x 100" pegam o primeiro número', () => {
  const r = [V('pagamento de 3 parcelas de 100'), V('5 x 100')];
  col.add('NLP-03', 'PARCIAL', 'Frases de parcelamento ("3 parcelas de 100", "5 x 100") usam o 1º número como valor',
    `→ ${r.join(' / ')} (esperado 100 por parcela ou 300/500 total) — o parcelamento é feito em outra etapa da UI`);
  assert.deepEqual(r, [3, 5]);
});

test('parse(): tipo, categoria e descrição de frases comuns', () => {
  const a = NLP.parse('gastei 50 no mercado');
  assert.equal(a.value, 50); assert.equal(a.type, 'saida');
  const b = NLP.parse('recebi 1500 de salario');
  assert.equal(b.value, 1500); assert.equal(b.type, 'entrada');
  const c = NLP.parse('camisa da igreja 99,90');   // regressão: não pode virar Transporte
  assert.equal(c.value, 99.9); assert.notEqual(c.category, 'Transporte');
});

test('parseCompound separa comandos compostos', () => {
  const r = NLP.parseCompound('gastei 20 no lanche e 30 no uber');
  assert.ok(Array.isArray(r) && r.length >= 1);
  col.add('NLP-04', 'INFO', 'parseCompound', `"gastei 20 no lanche e 30 no uber" → ${r.map(x => x.value).join(' + ')}`);
});

test('_parseBRNumber: casos de borda', () => {
  assert.equal(NLP._parseBRNumber('1.500,50'), 1500.5);
  assert.equal(NLP._parseBRNumber('1.500'), 1500);
  assert.equal(NLP._parseBRNumber('50.30'), 50.3);
  assert.ok(Number.isNaN(NLP._parseBRNumber('')));
  assert.ok(Number.isNaN(NLP._parseBRNumber(null)));
});
