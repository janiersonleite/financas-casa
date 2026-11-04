// O deploy publica só os arquivos montados por scripts/build-site.js (deploy.yml, passo "Montar o site"). Garante que (1) tudo que o app carrega está na lista
// e (2) nada sensível/de desenvolvimento está nela.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const yml = read('.github/workflows/deploy.yml');
// A lista agora é derivada por scripts/build-site.js (pastas/arquivos de topo)
const LISTA = [...new Set(require('../../scripts/build-site.js').referencias().map(r => r.split('/')[0]))];

test('deploy.yml publica a partir de _site (não da raiz) com lista explícita', () => {
  assert.ok(LISTA.length >= 5, 'lista de publicação não encontrada');
  assert.match(yml, /path: '_site'/);
  assert.doesNotMatch(yml, /path: '\.'/);
  assert.match(yml, /needs: test/);
});

test('a lista não inclui nada de desenvolvimento/relatório', () => {
  for (const proibido of ['tests', 'docs', 'supabase', 'scripts', 'server.js', 'package.json', 'node_modules', '.github', '.git'])
    assert.ok(!LISTA.includes(proibido), `${proibido} não deve ser publicado`);
});

test('tudo que index.html e manifest.json referenciam localmente está na lista e existe', () => {
  const html = read('index.html'), man = JSON.parse(read('manifest.json'));
  const refs = new Set();
  for (const r of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) refs.add(r[1].split('?')[0]);
  for (const i of man.icons || []) refs.add(i.src);
  for (const s of man.shortcuts || []) for (const i of s.icons || []) refs.add(i.src);
  refs.add('sw.js'); refs.add('manifest.json');
  for (const r of refs) {
    if (/^(https?:|data:|mailto:|tel:)/.test(r)) continue;
    const topo = r.replace(/^\.?\//, '').split('/')[0];
    assert.ok(fs.existsSync(path.join(ROOT, r.replace(/^\.?\//, ''))), `arquivo referenciado não existe: ${r}`);
    assert.ok(LISTA.includes(topo), `${r} não está na lista de publicação (${topo})`);
  }
});

test('service worker e js só carregam arquivos publicados', () => {
  const sw = read('sw.js');
  for (const r of sw.matchAll(/['"](\.?\/?(?:js|icons)\/[^'"]+)['"]/g)) assert.ok(fs.existsSync(path.join(ROOT, r[1].replace(/^\.?\//, ''))), r[1]);
});
