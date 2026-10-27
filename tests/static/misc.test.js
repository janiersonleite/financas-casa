// Verificações estáticas rápidas: CDNs/SRI/CSP, server.js (path traversal / bind) e marca inconsistente.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createCollector } = require('../qa-findings');
const ROOT = path.resolve(__dirname, '..', '..');
const col = createCollector('misc-findings.json');
test.after(() => col.flush());
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('index.html: CDNs com versão exata + SRI (Tailwind agora compilado, G3); CSP (E1/E2, G4)', () => {
  const html = read('index.html');
  const tags = [...html.matchAll(/<script\b[^>]*\bsrc="(https?:[^"]+)"[^>]*>/g)].map(m => ({ url: m[1], tag: m[0] }));
  assert.ok(tags.length >= 5, 'scripts de CDN não encontrados');
  const tailwind = tags.filter(t => /cdn\.tailwindcss\.com/.test(t.url));
  const outros = tags.filter(t => !/cdn\.tailwindcss\.com/.test(t.url));
  assert.equal(tailwind.length, 0, 'o CDN do Tailwind foi removido (G3): CSS vem de css/app.css');
  for (const t of outros) {
    assert.ok(/@\d+\.\d+\.\d+\//.test(t.url), 'versão não fixada: ' + t.url);
    assert.match(t.tag, /integrity="sha384-[A-Za-z0-9+/]{64}"/, 'sem SRI sha384: ' + t.url);
    assert.match(t.tag, /crossorigin="anonymous"/, 'sem crossorigin: ' + t.url);
  }
  // o app inteiro depende de scripts de CDN: SRI errado = app quebrado → existe verificação na rede (CI)
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'verify-sri.js')));
  col.add('SUP-01', 'CORRIGIDO', `${outros.length} scripts de CDN com SRI sha384 + crossorigin`, 'hashes calculados do pacote npm (2 hosts de registry idênticos); conferência contra o CDN real: npm run verify:sri (CI)');
  col.add('SUP-02', 'CORRIGIDO', 'supabase-js (2.118.0) e chart.js (4.5.1) com versão exata', outros.map(t => t.url.replace('https://cdn.jsdelivr.net/npm/', '')).join(' , '));
  col.add('SUP-03', 'CORRIGIDO', 'cdn.tailwindcss.com removido: Tailwind 3.4.19 compilado no build (css/app.css)', 'Fase 3 / G3 — ver DECISOES.md (D9)');
  const csp = /Content-Security-Policy/i.test(html);
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'qa', 'csp-proposta.md')));
  col.add('SUP-04', csp ? 'CORRIGIDO' : 'PARCIAL', csp ? 'CSP ativa via <meta> (G4, Fase 3b): validada em Chromium, 0 violações' : 'CSP entregue como PROPOSTA (docs/qa/csp-proposta.md), não ativada', csp ? 'ver DECISOES.md D10 e docs/qa/csp-validacao.json' : 'ativação na branch qa/fase-3b-csp');
});

test('server.js: bloqueia path traversal e dotfiles; escuta só em 127.0.0.1 (SRV-01/02)', async () => {
  const segredoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-secret-'));
  fs.writeFileSync(path.join(segredoDir, 'segredo.txt'), 'SEGREDO-FORA-DA-PASTA');
  const rel = path.relative(ROOT, path.join(segredoDir, 'segredo.txt')).split(path.sep).join('/');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const port = await new Promise((res, rej) => { child.stdout.on('data', d => { const m = /localhost:(\d+)/.exec(String(d)); if (m) res(+m[1]); }); setTimeout(() => rej(new Error('servidor não subiu')), 5000); });
    const raw = (p, host = '127.0.0.1') => new Promise(res => { const s = net.connect(port, host, () => s.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)); let b = ''; s.on('data', d => b += d); s.on('close', () => res(b)); s.on('error', () => res('ERRO')); });
    const status = r => (/HTTP\/1\.1 (\d+)/.exec(r) || [])[1];
    // legítimos continuam funcionando
    assert.equal(status(await raw('/')), '200'); assert.equal(status(await raw('/index.html')), '200');
    assert.equal(status(await raw('/js/app.js')), '200'); assert.equal(status(await raw('/manifest.json')), '200');
    // traversal (cru e codificado) e arquivos ocultos
    for (const p of ['/' + rel, '/..%2f..%2f..%2f..%2fetc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..\\..\\etc\\passwd', '/js/../../etc/passwd',
                     '/.git/config', '/.env', '/.claude/settings.json', '/node_modules/pg/package.json', '/%00', '/js/%E0%A4%A']) {
      const r = await raw(p);
      assert.ok(!/SEGREDO-FORA-DA-PASTA|root:/.test(r), 'vazou conteúdo em ' + p);
      assert.notEqual(status(r), '200', 'deveria negar ' + p);
    }
    // bind: só loopback
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(src, /const HOST = '127\.0\.0\.1'/); assert.match(src, /server\.listen\(PORT, HOST/);
    const outraInterface = Object.values(os.networkInterfaces()).flat().find(i => i && !i.internal && i.family === 'IPv4');
    if (outraInterface) assert.equal(await raw('/', outraInterface.address), 'ERRO', 'respondeu em ' + outraInterface.address);
    col.add('SRV-01', 'CORRIGIDO', 'server.js bloqueia traversal (raw e codificado) e dotfiles/node_modules');
    col.add('SRV-02', 'CORRIGIDO', 'server.js escuta só em 127.0.0.1', outraInterface ? 'conexão pela interface ' + outraInterface.address + ' recusada' : 'sem interface externa neste ambiente (verificado no código)');
  } finally { child.kill(); fs.rmSync(segredoDir, { recursive: true, force: true }); }
});

test('marca padronizada "Minhas Carteiras" e cores do manifest (E4)', () => {
  const ocorr = [];
  for (const f of ['sw.js', 'manifest.json', 'index.html', 'package.json', 'server.js', 'js/app.js', 'js/push.js', 'js/auth.js', 'js/config.js']) {
    read(f).split('\n').forEach((l, i) => { if (/Finan[cç]as[ -]?Casa|financas-casa/i.test(l.normalize('NFC'))) ocorr.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(ocorr, [], 'nome antigo ainda presente: ' + ocorr.join(', '));
  const man = JSON.parse(read('manifest.json')), html = read('index.html');
  const themeMeta = /name="theme-color" content="([^"]+)"/.exec(html)?.[1];
  assert.equal(man.theme_color.toLowerCase(), themeMeta.toLowerCase());
  assert.equal(man.name, 'Minhas Carteiras');
  assert.match(read('sw.js').split('\n')[0], /Minhas Carteiras/);
  assert.match(read('sw.js'), /const RUNTIME_CACHE = 'app-runtime-v[^']*';/, 'o workflow reescreve este nome: o formato não pode mudar');
  col.add('BRD-01', 'CORRIGIDO', 'Nome antigo removido (sw.js comentário, package.json); formato de RUNTIME_CACHE preservado para o workflow');
  col.add('BRD-02', 'CORRIGIDO', 'theme_color do manifest = meta theme-color do index.html', themeMeta);
});
