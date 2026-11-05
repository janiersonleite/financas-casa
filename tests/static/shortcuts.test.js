// T3: atalhos do ícone (manifest.shortcuts + ?action=): JSON válido, máx. 4, mesma origem; allowlist; sobrevive ao login; URL limpa; SW serve as URLs.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const run = (url, logado) => JSON.parse(spawnSync(process.execPath, [path.join(__dirname, 'launch-action-runner.js'), url, logado ? '1' : '0'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 }).stdout.trim().split('\n').pop());

test('manifest.json: JSON válido, no máximo 4 shortcuts, URLs relativas ao escopo (mesma origem) e ações da allowlist', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.ok(Array.isArray(m.shortcuts) && m.shortcuts.length >= 1 && m.shortcuts.length <= 4);
  const base = new URL(m.start_url, 'https://minhascarteiras.com.br/');
  assert.deepEqual(m.shortcuts.map(s => s.name), ['Novo gasto', 'Nova entrada', 'Histórico']);
  for (const s of m.shortcuts) {
    const u = new URL(s.url, base);
    assert.equal(u.origin, base.origin, 'mesma origem: ' + s.url);
    assert.ok(u.pathname.startsWith(new URL(m.scope, base).pathname), 'dentro do escopo: ' + s.url);
    assert.ok(/^\.\/\?action=[a-z-]+$/.test(s.url), s.url);
    assert.ok(['new-expense', 'new-income', 'history'].includes(u.searchParams.get('action')), s.url);
  }
  assert.deepEqual(m.shortcuts.map(s => s.url), ['./?action=new-expense', './?action=new-income', './?action=history']);
});

test('allowlist: ações válidas executam; QUALQUER outro valor é ignorado e a URL é limpa', () => {
  for (const bad of ['qualquer-coisa', '%3Cscript%3E', 'NEW-EXPENSE', 'new-expense%20', '..%2F..', '']) {
    const r = run(`http://localhost/?action=${bad}`, true);
    assert.equal(r.guardado, null, bad); assert.deepEqual(r.depoisCarteiras.chamadas, [], bad); assert.equal(r.urlAposCaptura, '', 'URL limpa: ' + bad);
  }
  assert.deepEqual(run('http://localhost/?action=new-expense', true).depoisCarteiras.chamadas, [['openModal', { type: 'saida', focusValue: true }]]);
  assert.deepEqual(run('http://localhost/?action=new-income', true).depoisCarteiras.chamadas, [['openModal', { type: 'entrada', focusValue: true }]]);
  assert.deepEqual(run('http://localhost/?action=history', true).depoisCarteiras.chamadas, [['switchTab', 'history']]);
});

test('o parâmetro espera as carteiras carregarem, sobrevive ao login (sessionStorage) e a URL é limpa só DEPOIS de executar', () => {
  const r = run('http://localhost/?action=new-expense#ancora', true);
  assert.equal(r.antesDasCarteiras.chamadas, 0); assert.equal(r.antesDasCarteiras.pendente, 'new-expense');
  assert.equal(r.depoisCarteiras.pendente, null); assert.equal(r.depoisCarteiras.urlFinal, '#ancora', 'só o action sai; o resto da URL fica');
  const d = run('http://localhost/?action=new-income', false);
  assert.deepEqual(d.depoisCarteiras.chamadas, [], 'deslogado: não executa'); assert.equal(d.depoisCarteiras.pendente, 'new-income'); assert.equal(d.depoisCarteiras.urlFinal, '?action=new-income');
  assert.deepEqual(d.depoisLogin.chamadas, [['openModal', { type: 'entrada', focusValue: true }]]); assert.equal(d.depoisLogin.pendente, null); assert.equal(d.depoisLogin.urlFinal, '');
  assert.equal(d.metrica, 'atalho', 'a métrica local do método "atalho" é iniciada');
});

test('o login dispara a ação pendente (auth.js) e o app a chama no fim do init', () => {
  assert.match(read('js/auth.js'), /App\.loadFinancas\(\)\.then\(\(\) => App\.renderCurrentTab\(\)\)\.then\(\(\) => App\.runPendingAction\(\)\)/);
  assert.match(read('js/app.js'), /await this\.renderHome\(\);\s*this\.refreshMonthDisplay\(\);\s*this\.runPendingAction\(\);/);
});

test('service worker serve ./?action=… (navegação ignora a query no cache) e a versão do cache foi atualizada', () => {
  const sw = read('sw.js');
  assert.match(sw, /caches\.match\(event\.request, \{ ignoreSearch: event\.request\.mode === 'navigate' \}\)/);
  assert.match(sw, /app-runtime-v20261109a/);
  assert.match(read('index.html'), /<script src="js\/favorites\.js\?v=\d{8}[a-z]">/);
});
