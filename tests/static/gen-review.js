// Gera tests/static/xss-review.json: classificação MANUAL (feita lendo o contexto de cada ocorrência)
// dos candidatos achados pelo scanner. Rodar só quando o código mudar: node tests/static/gen-review.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { findCandidates } = require('./scan-lib');
const JS = path.resolve(__dirname, '..', '..', 'js');

// classes: VULNERAVEL | ESCAPADO | NAO_CONTROLADO
// app.js — por linha (revisão manual de 2026-10-20)
const APP = {
  ESCAPADO: { 517: '1 caractere (charAt(0)) — não carrega payload útil', 695: 'argumentos já passam por _escHtml na chamada de row()', 1660: 'dentro já usa _escHtml', 5546: 'catOptions() escapa name' },
  NAO_CONTROLADO: { 2039: 'rótulo de grupo de emojis (constante)', 2041: 'emoji da lista fixa', 2544: 'cor/rótulo de status calculado', 3143: 'comparação booleana → "selected"', 4637: 'rótulos fixos dos tiles', 6232: 'nome de campo fixo do mapeamento de colunas', 7130: 'constante', 7132: 'constante', 7271: 'constante', 7273: 'constante', 7376: 'badge de tipo (constante)', 7380: 'id de categoria (uuid/slug do banco)', 7381: 'id de categoria (uuid/slug do banco)' }
};
const EMOJI_NOTE = 'campo emoji (categories/financas = VARCHAR(10): payload curto; reminders/transaction_types sem limite conhecido)';
const rules = (file, line, expr) => {
  if (file === 'cofrinhos.js') {
    // cofrinhos.js: nome/nota/PIX passam por _esc(); `meta` já vem escapado (linha 873/1040); o resto são rótulos internos
    if (/pix_key|meta|_esc\(/.test(expr)) return { cls: 'ESCAPADO', note: 'valor passa por _esc()/já vem escapado (_pixBlockHtml, meta)' };
    return { cls: 'NAO_CONTROLADO', note: 'rótulo/cálculo interno (períodos, tiles, classes CSS)' };
  }
  if (/^(g\.label|e|typeBadge\[cat\.type\] \|\| ''|cat\.id)$/.test(expr)) return { cls: 'NAO_CONTROLADO', note: 'constante/identificador interno' };
  if (/^txn\.notes \? `/.test(expr)) return { cls: 'ESCAPADO', note: 'ternário; o valor interno passa por Utils.esc' };
  for (const k of ['ESCAPADO', 'NAO_CONTROLADO']) if (APP[k][line]) return { cls: k, note: APP[k][line] };
  if (/getCategoryIcon/.test(expr)) return { cls: 'VULNERAVEL', note: EMOJI_NOTE };
  if (/emoji/.test(expr) && !/\.name|\.description|\.notes/.test(expr)) return { cls: 'VULNERAVEL', note: EMOJI_NOTE };
  return { cls: 'VULNERAVEL', note: 'texto livre interpolado sem _escHtml em template HTML' };
};

const out = [];
for (const f of ['app.js', 'cofrinhos.js']) {
  const file = path.join(JS, f);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const c of findCandidates(file).candidates) {
    const r = rules(f, c.line, c.expr);
    out.push({ file: 'js/' + f, key: f + '|' + lines[c.line - 1].trim() + '|' + c.expr, line: c.line, expr: c.expr, ...r });
  }
}
fs.writeFileSync(path.join(__dirname, 'xss-review.json'), JSON.stringify(out, null, 1));
const cnt = out.reduce((a, x) => (a[x.cls] = (a[x.cls] || 0) + 1, a), {});
console.log(out.length, 'candidatos', cnt);
