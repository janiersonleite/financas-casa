// G1: o artefato publicado (_site, montado por scripts/build-site.js) contém só o app e tudo que ele referencia.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const TS = '2026-10-27 22:30';

function montar() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
  execFileSync('node', ['scripts/build-site.js', '--out', out], { cwd: ROOT, env: { ...process.env, BUILD_TIMESTAMP: TS }, stdio: 'pipe' });
  return out;
}
function listar(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? listar(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]);
}
const site = montar();
const arquivos = listar(site);
test.after(() => fs.rmSync(site, { recursive: true, force: true }));

test('_site NÃO contém arquivos de desenvolvimento, relatórios nem backend', () => {
  const proibidos = [/^docs\//, /^tests\//, /^supabase\//, /^scripts\//, /^\.github\//, /^node_modules\//, /^server\.js$/, /^package(-lock)?\.json$/,
    /^iniciar\.bat$/, /^Ideias - Requisitos \.txt$/, /^tailwind\.config\.js$/, /^\.git/, /\.sql$/, /\.md$/, /\.env/];
  for (const f of arquivos) for (const p of proibidos) assert.ok(!p.test(f), `não deveria ser publicado: ${f}`);
});

test('_site contém tudo que index.html, sw.js e manifest.json referenciam', () => {
  const refs = new Set(['sw.js', 'manifest.json']);
  for (const m of read('index.html').matchAll(/\b(?:src|href)="([^"]+)"/g)) refs.add(m[1]);
  const man = JSON.parse(read('manifest.json'));
  for (const i of man.icons || []) refs.add(i.src);
  for (const m of read('sw.js').matchAll(/(?:icon|badge)\s*:\s*['"]([^'"]+)['"]/g)) refs.add(m[1]);
  let n = 0;
  for (const r of refs) {
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(r) || r === './') continue;
    const f = r.split(/[?#]/)[0].replace(/^\.?\//, '');
    assert.ok(fs.existsSync(path.join(site, f)), `referenciado e ausente em _site: ${f}`); n++;
  }
  assert.ok(n >= 12, 'poucas referências conferidas: ' + n);
});

test('só arquivos do app: nenhum arquivo extra além do referenciado', () => {
  assert.deepEqual(arquivos.filter(f => !/^(index\.html|sw\.js|manifest\.json|icon\.svg|icons\/.+|js\/.+|css\/app\.css)$/.test(f)), []);
});

test('referência a arquivo inexistente quebra o build', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  try {
    fs.cpSync(ROOT, tmp, { recursive: true, filter: s => !/node_modules|\.git$|\.git\/|tests|docs|supabase/.test(s) });
    fs.writeFileSync(path.join(tmp, 'index.html'), read('index.html').replace('</head>', '<script src="js/nao-existe.js"></script></head>'));
    assert.throws(() => execFileSync('node', ['scripts/build-site.js', '--out', path.join(tmp, '_s')], { cwd: tmp, stdio: 'pipe' }), /nao-existe/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('injeção de versão idêntica à do fluxo antigo (sed do deploy.yml)', () => {
  const cache = TS.replace(/\D/g, '');
  const app = read('js/app.js').replace(/const APP_VERSION = '[^']*'/g, `const APP_VERSION = '${TS}'`);
  const sw = read('sw.js').replace(/app-runtime-v[^']*/g, `app-runtime-v${cache}`);
  // referência independente: o próprio sed (GNU)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sed-'));
  try {
    fs.copyFileSync(path.join(ROOT, 'js/app.js'), path.join(tmp, 'app.js')); fs.copyFileSync(path.join(ROOT, 'sw.js'), path.join(tmp, 'sw.js'));
    execFileSync('sed', ['-i', `s/const APP_VERSION = '[^']*'/const APP_VERSION = '${TS}'/`, path.join(tmp, 'app.js')]);
    execFileSync('sed', ['-i', `s/app-runtime-v[^']*/app-runtime-v${cache}/g`, path.join(tmp, 'sw.js')]);
    assert.equal(fs.readFileSync(path.join(site, 'js/app.js'), 'utf8'), fs.readFileSync(path.join(tmp, 'app.js'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(site, 'sw.js'), 'utf8'), fs.readFileSync(path.join(tmp, 'sw.js'), 'utf8'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  assert.equal(fs.readFileSync(path.join(site, 'js/app.js'), 'utf8'), app);
  assert.equal(fs.readFileSync(path.join(site, 'sw.js'), 'utf8'), sw);
  assert.match(read('js/app.js'), /const APP_VERSION = '(?!2026-10-27 22:30)/, 'a fonte não pode ser alterada pelo build');
});

test('deploy.yml: needs test, roda o build e publica _site', () => {
  const yml = read('.github/workflows/deploy.yml');
  assert.match(yml, /needs: test/);
  assert.match(yml, /node scripts\/build-site\.js/);
  assert.match(yml, /path: '_site'/);
  assert.doesNotMatch(yml, /path: '\.'/);
});
