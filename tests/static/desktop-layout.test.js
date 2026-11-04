// Desktop compacto: o menu lateral é um painel flutuante encostado na coluna do app; a coluna (--app-col) tem de ser a mesma de .tab-page.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

test('--app-col acompanha o max-width de .tab-page (1120 px ≥1024, 1280 px ≥1440) — se um mudar, o menu e a barra desalinham', () => {
  assert.match(html, /@media \(min-width: 1024px\) \{ html \{ font-size: 118%; \} \.tab-page \{ max-width: 1120px; \} \}/);
  assert.match(html, /@media \(min-width: 1440px\) \{ html \{ font-size: 130%; \} \.tab-page \{ max-width: 1280px; \} \}/);
  assert.match(html, /:root \{ --app-col: 1120px; --nav-w: 84px; --nav-gap: 14px; \}/);
  assert.match(html, /@media \(min-width: 1440px\) \{ :root \{ --app-col: 1280px; \} \}/);
  assert.match(html, /#wallet-bar \{ --wb-col: 1120px; \}/); assert.match(html, /#wallet-bar \{ --wb-col: 1280px; \}/);
});

test('menu lateral flutuante: encostado na coluna, centralizado na vertical, com cantos arredondados; barra de carteira com fundo de largura total', () => {
  const m = /@media \(min-width: 1024px\) \{\s*:root \{[^}]*\}\s*#bottom-nav \{([\s\S]*?)\n            \}/.exec(html);
  assert.ok(m, 'regra do menu flutuante não encontrada');
  assert.match(m[1], /left: max\(10px, calc\(\(100vw - var\(--app-col\) - 96px\) \/ 2 \+ 96px - var\(--nav-w\) - var\(--nav-gap\)/);
  assert.match(m[1], /top: 50% !important/); assert.match(m[1], /translateY\(-50%\)/); assert.match(m[1], /border-radius: 22px/);
  assert.match(html, /#wallet-bar \{ margin-left: -96px !important; width: calc\(100% \+ 96px\) !important; padding-left: 96px !important; \}/);
});
