// Scanner estático de XSS (templates HTML com texto livre sem _escHtml) em js/app.js e js/cofrinhos.js.
// Cada ocorrência foi classificada à mão em xss-review.json (VULNERAVEL / ESCAPADO / NAO_CONTROLADO).
// O teste falha se surgir uma ocorrência NOVA não revisada (guarda de regressão para a Fase 2).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findCandidates } = require('./scan-lib');
const { loadScripts } = require('../unit/load');
const { createCollector } = require('../qa-findings');
const JS = path.resolve(__dirname, '..', '..', 'js');
const col = createCollector('xss-static-findings.json');
test.after(() => col.flush());
const review = JSON.parse(fs.readFileSync(path.join(__dirname, 'xss-review.json'), 'utf8'));
const byKey = new Map(review.map(r => [r.key, r]));

function scanAll() {
  const found = [];
  let templates = 0;
  for (const f of ['app.js', 'cofrinhos.js']) {
    const file = path.join(JS, f);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const r = findCandidates(file); templates += r.templates;
    for (const c of r.candidates) found.push({ ...c, f, key: f + '|' + lines[c.line - 1].trim() + '|' + c.expr });
  }
  return { found, templates };
}

test('o scanner percorre os arquivos inteiros (sanidade do tokenizer)', () => {
  const { templates } = scanAll();
  assert.ok(templates > 300, 'poucos template literals encontrados: ' + templates + ' (tokenizer dessincronizou?)');
});

test('toda ocorrência candidata foi revisada manualmente', () => {
  const { found } = scanAll();
  const novas = found.filter(c => !byKey.has(c.key));
  assert.equal(novas.length, 0, 'ocorrências NOVAS sem revisão:\n' + novas.map(c => `${c.f}:${c.line}  ${c.expr}`).join('\n'));
});

test('nenhuma ocorrência VULNERÁVEL em app.js/cofrinhos.js (texto livre e emoji sempre escapados)', () => {
  const { found } = scanAll();
  const vul = found.filter(c => byKey.get(c.key)?.cls === 'VULNERAVEL').map(c => `${c.f}:${c.line} ${c.expr}`);
  assert.deepEqual(vul, []);
  assert.equal(review.filter(r => r.cls === 'VULNERAVEL').length, 0, 'xss-review.json ainda lista VULNERAVEL');
  col.add('XSS-S1', 'CORRIGIDO', 'Nenhuma interpolação de texto livre/emoji sem escape em templates HTML', `${found.length} candidatos revisados (todos ESCAPADO ou NAO_CONTROLADO)`);
});

test('guarda de regressão: o scanner detecta interpolação nova sem escape (e aceita Utils.esc)', () => {
  const fs2 = require('node:fs'), os = require('node:os');
  const tmp = path.join(fs2.mkdtempSync(path.join(os.tmpdir(), 'xss-')), 'x.js');
  fs2.writeFileSync(tmp, 'const a = c => `<div title="${c.name}">${c.description}</div>`;\nconst b = c => `<div>${Utils.esc(c.name)}</div>`;\n');
  const r = findCandidates(tmp).candidates;
  assert.deepEqual(r.map(x => x.line), [1, 1], 'deveria acusar as duas interpolações cruas da linha 1 e nenhuma da linha 2');
});

test('Utils.esc: escapa & < > " \' e aceita não-string sem lançar erro', () => {
  const { Utils } = loadScripts(['utils.js'], ['Utils']);
  assert.equal(Utils.esc(`a'b"c<d>&`), 'a&#39;b&quot;c&lt;d&gt;&amp;');
  assert.equal(Utils.esc(5), '5'); assert.equal(Utils.esc(0), '0'); assert.equal(Utils.esc(null), ''); assert.equal(Utils.esc(undefined), '');
  assert.equal(Utils.esc({ toString() { return '<x>'; } }), '&lt;x&gt;');
  const { App } = loadScripts(['utils.js', 'storage.js', 'app.js'], ['App']);
  assert.equal(App._escHtml("a'b"), 'a&#39;b'); assert.equal(App._escHtml(5), '5');
  col.add('XSS-S3', 'CORRIGIDO', '_escHtml escapa aspa simples e aceita número/null/objeto', '');
  col.add('XSS-S4', 'CORRIGIDO', 'Utils.esc usa String(v ?? "")', '');
});

test('Utils.cleanEmoji: aceita emoji (1–2 grafemas) e descarta texto/HTML', () => {
  const { Utils } = loadScripts(['utils.js'], ['Utils']);
  assert.equal(Utils.cleanEmoji('🍔'), '🍔');
  assert.equal(Utils.cleanEmoji('👨‍👩‍👧'), '👨‍👩‍👧');          // ZWJ = 1 grafema
  assert.equal(Utils.cleanEmoji('🍔🚗🎮'), '🍔🚗');          // no máximo 2
  assert.equal(Utils.cleanEmoji('🇧🇷'), '🇧🇷');
  assert.equal(Utils.cleanEmoji('❤️'), '❤️');
  assert.equal(Utils.cleanEmoji('<img src=x onerror=1>', '📦'), '📦');
  assert.equal(Utils.cleanEmoji('abc', '🔔'), '🔔');
  assert.equal(Utils.cleanEmoji('', '💰'), '💰'); assert.equal(Utils.cleanEmoji(null, '💰'), '💰');
  assert.equal(Utils.cleanEmoji('a🍔<b>', '📦'), '🍔');   // só o pictográfico sobrevive
});
