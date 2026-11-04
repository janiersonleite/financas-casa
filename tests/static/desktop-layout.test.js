// Desktop compacto: o menu lateral é um painel flutuante encostado na coluna do app; a coluna (--app-col) tem de ser a mesma de .tab-page.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

test('coluna única de 1200 px: --app-col, --wb-col e .tab-page iguais; fonte normal (100 %) no desktop', () => {
  assert.match(html, /\.tab-page \{ max-width: 1200px; \}/);
  assert.match(html, /:root \{ --app-col: 1200px; --nav-w: 84px; --nav-gap: 14px; \}/);
  assert.match(html, /@media \(min-width: 1024px\) \{ #wallet-bar \{ --wb-col: 1200px; \} \}/);
  assert.match(html, /html \{ font-size: 100%; \}/);
  assert.doesNotMatch(html, /font-size: 118%|font-size: 130%/, 'o aumento de fonte no desktop foi removido');
});

test('Início em grade (saldo 5/12 + registrar 7/12, categorias em 8 colunas, lembretes 5/12 + lançamentos 7/12) sem quebrar o .hidden das abas', () => {
  assert.match(html, /#tab-home:not\(\.hidden\) \{ display: grid;/);
  assert.match(html, /#home-header \{ grid-column: span 5;/);
  assert.match(html, /#tab-home \.home-reg \{ grid-column: span 7;/);
  assert.match(html, /#quick-cats-grid \{ grid-template-columns: repeat\(8, minmax\(0, 1fr\)\) !important; \}/);
  assert.match(html, /#tab-home \.home-rem \{ grid-column: span 5;/);
  assert.match(html, /#tab-home \.home-lan \{ grid-column: span 7;/);
  for (const c of ['home-reg', 'home-cats', 'home-rem', 'home-lan']) assert.equal((html.match(new RegExp(`class="${c}[ "]`, 'g')) || []).length, 1, c);
  assert.doesNotMatch(html, /#tab-home \{ display: grid/, 'display:grid direto em #tab-home sobrepõe .hidden e mostra a Início em todas as abas');
});

test('Resumo em 2 colunas fora do modo de reordenar; cabeçalhos de Histórico/Resumo/Investir em cartões', () => {
  assert.match(html, /#summary-sections:not\(\.editing\) \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(html, /#tab-history > \.sticky \{ position: static;/);
});

test('menu lateral flutuante: encostado na coluna, centralizado na vertical, com cantos arredondados; barra de carteira com fundo de largura total', () => {
  const m = /@media \(min-width: 1024px\) \{\s*:root \{[^}]*\}\s*#bottom-nav \{([\s\S]*?)\n            \}/.exec(html);
  assert.ok(m, 'regra do menu flutuante não encontrada');
  assert.match(m[1], /left: max\(10px, calc\(\(100vw - var\(--app-col\) - 96px\) \/ 2 \+ 96px - var\(--nav-w\) - var\(--nav-gap\)/);
  assert.match(m[1], /top: 50% !important/); assert.match(m[1], /translateY\(-50%\)/); assert.match(m[1], /border-radius: 22px/);
  assert.match(html, /#wallet-bar \{ margin-left: -96px !important; width: calc\(100% \+ 96px\) !important; padding-left: 96px !important; \}/);
});
