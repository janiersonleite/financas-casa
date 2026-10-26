// Prova dinâmica (jsdom) de XSS armazenado: alimenta as funções de renderização do app com
// dados "hostis" (como se viessem de outro membro da carteira / do banco) e verifica se o
// HTML gerado cria elementos com handlers (onerror). Nada é executado de verdade (sem rede).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCollector } = require('../qa-findings');
const col = createCollector('xss-dynamic-findings.json');
test.after(() => col.flush());

test('XSS dinâmico (jsdom): renderizações com dados hostis', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'xss-dynamic-runner.js')], { encoding: 'utf8', timeout: 120000 });
  const m = /@@(.*)$/s.exec(r.stdout || '');
  assert.ok(m, 'runner sem saída: ' + (r.stderr || '').slice(0, 300));
  const resultados = JSON.parse(m[1]);
  assert.ok(resultados.length >= 10);
  const problemas = [];
  for (const c of resultados) {
    if (c.erro) problemas.push(`${c.id}: não exercitado (${c.erro})`);
    else if (c.explorado) problemas.push(`${c.id}: XSS — ${c.onde}`);
    else col.add(c.id, 'CORRIGIDO', c.onde, 'payload virou texto; nenhum onerror/onmouseover no DOM');
  }
  assert.deepEqual(problemas, []);
});
