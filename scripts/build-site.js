#!/usr/bin/env node
// Monta _site/ com SÓ os arquivos que o app carrega. A lista é derivada das referências de index.html,
// manifest.json e sw.js (+ js/*.js, que o index.html carrega); referência a arquivo inexistente é erro de build.
// A versão (APP_VERSION em js/app.js e nome do cache no sw.js) é injetada nas CÓPIAS dentro de _site.
//   node scripts/build-site.js [--out _site]      (BUILD_TIMESTAMP="AAAA-MM-DD HH:MM" fixa a hora, p/ testes)
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const EXTERNA = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;   // http:, data:, mailto:, //cdn…

const norm = r => path.posix.normalize(r.split(/[?#]/)[0].replace(/^\.?\//, ''));

function referencias() {
  const refs = new Set(['index.html', 'manifest.json', 'sw.js']);
  const html = read('index.html');
  for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) refs.add(m[1]);
  const man = JSON.parse(read('manifest.json'));
  for (const i of man.icons || []) refs.add(i.src);
  for (const s of man.shortcuts || []) for (const i of s.icons || []) refs.add(i.src);
  const sw = read('sw.js');
  for (const m of sw.matchAll(/(?:icon|badge|image)\s*:\s*['"]([^'"]+)['"]/g)) refs.add(m[1]);
  for (const m of sw.matchAll(/importScripts\(\s*['"]([^'"]+)['"]/g)) refs.add(m[1]);
  // ícones usados nas notificações montadas em js/*.js
  for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter(n => n.endsWith('.js')))
    for (const m of read('js/' + f).matchAll(/(?:icon|badge)\s*:\s*['"](icons\/[^'"]+)['"]/g)) refs.add(m[1]);
  return [...refs].filter(r => r && !EXTERNA.test(r) && r !== './' && r !== '.' && !r.startsWith('#')).map(norm);
}

function agoraBrasilia() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function build(out) {
  const lista = [...new Set(referencias())].sort();
  const faltando = lista.filter(f => !fs.existsSync(path.join(ROOT, f)) || !fs.statSync(path.join(ROOT, f)).isFile());
  if (faltando.length) throw new Error('arquivo(s) referenciado(s) não existe(m): ' + faltando.join(', ')
    + (faltando.some(f => f.startsWith('css/')) ? ' (rode "npm run build:css" antes)' : ''));

  fs.rmSync(out, { recursive: true, force: true });
  for (const f of lista) {
    fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(out, f));
  }

  // Injeção de versão — mesma regra do passo antigo do deploy.yml (sed), aplicada nas cópias.
  const ts = process.env.BUILD_TIMESTAMP || agoraBrasilia();
  const cacheVer = ts.replace(/\D/g, '');
  const app = path.join(out, 'js/app.js'), sw = path.join(out, 'sw.js');
  fs.writeFileSync(app, fs.readFileSync(app, 'utf8').replace(/const APP_VERSION = '[^']*'/g, `const APP_VERSION = '${ts}'`));
  fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace(/app-runtime-v[^']*/g, `app-runtime-v${cacheVer}`));
  return { lista, ts };
}

module.exports = { build, referencias };

if (require.main === module) {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(ROOT, i > 0 ? process.argv[i + 1] : '_site');
  try {
    const { lista, ts } = build(out);
    console.log(`_site montado: ${lista.length} arquivos | versão ${ts}`);
    for (const f of lista) console.log('  ' + f);
  } catch (e) { console.error('ERRO de build:', e.message); process.exit(1); }
}
