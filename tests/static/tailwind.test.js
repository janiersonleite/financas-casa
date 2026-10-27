// G3: Tailwind compilado no build (sem cdn.tailwindcss.com). Toda classe usada no código existe no CSS gerado.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const JS = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const bin = path.join(ROOT, 'node_modules', '.bin', 'tailwindcss');
function compilar(configExtra, out) {
  const cfg = path.join(tmp, out + '.config.js');
  fs.writeFileSync(cfg, `const base = require(${JSON.stringify(path.join(ROOT, 'tailwind.config.js'))}); module.exports = { ...base, content: ${JSON.stringify(configExtra.content)}, safelist: ${configExtra.useSafelist ? 'base.safelist' : '[]'} };`);
  const o = path.join(tmp, out + '.css');
  execFileSync(bin, ['-c', cfg, '-i', path.join(ROOT, 'css/input.css'), '-o', o, '--minify'], { cwd: ROOT, stdio: 'pipe' });
  return fs.readFileSync(o, 'utf8');
}
const classesDe = css => new Set([...css.matchAll(/\.((?:\\.|[\w-])+)/g)].map(m => m[1].replace(/\\(.)/g, '$1')));

test('package.json: tailwindcss em versão EXATA 3.x e scripts de build', () => {
  const v = pkg.devDependencies.tailwindcss;
  assert.match(v, /^3\.\d+\.\d+$/, 'versão deve ser exata e 3.x (sem ^ ou ~): ' + v);
  assert.match(pkg.scripts['build:css'], /tailwindcss .*-o css\/app\.css .*--minify/);
  assert.match(pkg.scripts.prestart, /build:css/);
  assert.match(read('.gitignore'), /^css\/app\.css$/m, 'css/app.css gerado não deve ser commitado');
});

test('index.html usa css/app.css (depois do <style> inline) e não carrega mais o CDN do Tailwind', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com/);
  assert.doesNotMatch(html, /tailwind\.config\s*=/, 'configuração inline deve ir para tailwind.config.js');
  const m = /<link rel="stylesheet" href="css\/app\.css\?v=[\w.-]+">/.exec(html);
  assert.ok(m, 'link para css/app.css?v=… ausente');
  assert.ok(m.index > html.indexOf('</style>'), 'o CSS gerado deve vir DEPOIS do <style> inline (mesma ordem do CDN, que anexava o <style> ao fim do <head>)');
  for (const f of ['sw.js', ...JS]) assert.doesNotMatch(read(f), /cdn\.tailwindcss\.com/, f);
});

test('toda classe Tailwind usada em index.html e js/*.js (estáticas + safelist) existe no CSS gerado', () => {
  const real = compilar({ content: [path.join(ROOT, 'index.html'), path.join(ROOT, 'js/**/*.js')], useSafelist: true }, 'real');
  const reais = classesDe(real);
  // candidatos: tudo que aparece dentro de class="…", className = '…' e classList.*('…')
  const textos = ['index.html', ...JS].map(read).join('\n');
  const attrs = [...textos.matchAll(/class(?:Name)?\s*[=:]\s*["'`]([^"'`]*(?:\$\{[^}]*\}[^"'`]*)*)["'`]/g)].map(m => m[1]);
  const lists = [...textos.matchAll(/classList\.(?:add|remove|toggle|contains|replace)\(([^)]*)\)/g)].map(m => m[1]);
  const quoted = [...textos.matchAll(/['"`]([a-z0-9:\[\]\/._%#!-]+(?: [a-z0-9:\[\]\/._%#!-]+)+)['"`]/g)].map(m => m[1]);   // 'a b c' (ternários, className = cond ? '…' : '…')
  const candidatos = new Set();
  for (const s of [...attrs, ...lists, ...quoted])
    for (const t of s.replace(/\$\{|\}|['"`?:,()]\s/g, ' ').split(/\s+/)) if (/^[a-z0-9:\[\]\/._%#!-]+$/.test(t) && !/\$/.test(t)) candidatos.add(t);
  // mais classes isoladas entre aspas em classList.add('x')
  for (const l of lists) for (const m of l.matchAll(/['"`]([^'"`]+)['"`]/g)) for (const t of m[1].split(/\s+/)) if (t) candidatos.add(t);
  const esperado = classesDe(compilar({ content: [{ raw: [...candidatos].join(' ') }], useSafelist: false }, 'esperado'));
  const faltando = [...esperado].filter(c => !reais.has(c));
  assert.ok(esperado.size > 150, 'poucas classes reconhecidas: ' + esperado.size);
  assert.deepEqual(faltando, [], 'classes usadas e ausentes do CSS gerado: ' + faltando.join(', '));
});

test('classes montadas dinamicamente (`prefixo-${var}-…`) estão no safelist', () => {
  const conhecidas = [];   // [arquivo, trecho] já cobertos pelo safelist
  for (const f of JS) {
    read(f).split('\n').forEach((l, i) => {
      // só interpolação DENTRO de um token de classe Tailwind (borda/cor/tamanho…), não ids, datas ou textos
      for (const m of l.matchAll(/\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|shadow|outline|w|h|p|m|px|py|gap|grid-cols|col-span)-\$\{/g)) conhecidas.push(`${f}:${i + 1}`);
    });
  }
  const safelist = JSON.stringify(require(path.join(ROOT, 'tailwind.config.js')).safelist.map(x => String(x.pattern || x)));
  for (const c of conhecidas) assert.match(safelist, /border-\(red\|green\|blue\)-400/, `classe dinâmica em ${c} sem safelist`);
  assert.ok(conhecidas.length >= 3, 'esperava achar os 3 prefixos dinâmicos de js/app.js (border/bg/text-${c}-…)');
});
