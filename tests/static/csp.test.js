// G4: CSP ativa via <meta> no index.html. Garante diretivas obrigatórias, ausência de 'unsafe-eval'/'unsafe-inline' em script-src,
// hashes em dia com os scripts/handlers inline e hosts de conexão iguais aos do app.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inventario } = require('../../scripts/csp-hashes.js');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('index.html');

const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
const dir = {};
if (meta) for (const d of meta[1].split(';').map(x => x.trim()).filter(Boolean)) { const [k, ...v] = d.split(/\s+/); dir[k] = v; }

test('index.html tem <meta> CSP antes de qualquer <script> e <meta name="referrer">', () => {
  assert.ok(meta, '<meta http-equiv="Content-Security-Policy"> ausente');
  assert.ok(meta.index < html.search(/<script\b/i), 'a CSP precisa vir antes de qualquer <script>');
  assert.match(html, /<meta name="referrer" content="strict-origin-when-cross-origin">/);
  assert.ok(!('frame-ancestors' in dir) && !('report-uri' in dir) && !('sandbox' in dir), 'frame-ancestors/report-uri/sandbox não funcionam via <meta>');
});

test('diretivas exigidas', () => {
  assert.deepEqual(dir['object-src'], ["'none'"]);
  assert.deepEqual(dir['base-uri'], ["'self'"]);
  assert.deepEqual(dir['form-action'], ["'self'"]);
  assert.deepEqual(dir['manifest-src'], ["'self'"]);
  assert.deepEqual(dir['worker-src'], ["'self'"]);
  assert.deepEqual(dir['img-src'], ["'self'", 'data:', 'blob:']);
  assert.deepEqual(dir['default-src'], ["'none'"], 'o que não for listado é bloqueado');
});

test("script-src: 'self' + CDNs usados + hashes; sem 'unsafe-eval' e sem 'unsafe-inline'", () => {
  const s = dir['script-src'];
  assert.ok(s.includes("'self'"));
  assert.ok(!s.includes("'unsafe-eval'") && !s.includes("'unsafe-inline'") && !s.includes('*') && !s.includes('https:'));
  const hosts = s.filter(x => /^https:/.test(x));
  const usados = new Set([...html.matchAll(/<script\b[^>]*\bsrc="(https:\/\/[^/"]+)/g)].map(m => m[1]));
  assert.deepEqual(new Set(hosts), usados, 'hosts de script-src devem ser exatamente os CDNs usados');
  for (const h of hosts) assert.ok(!/tailwind/.test(h), 'Tailwind não é mais CDN');
});

test('hashes de <script>/onclick inline em dia (qualquer mudança no inline exige atualizar a CSP)', () => {
  const inv = inventario(html);
  const s = dir['script-src'];
  for (const h of [...inv.hashesScripts, ...inv.hashesHandlers]) assert.ok(s.includes(h), 'hash ausente da CSP: ' + h);
  const hashesNaCsp = s.filter(x => /^'sha256-/.test(x));
  assert.equal(hashesNaCsp.length, inv.hashesScripts.length + inv.hashesHandlers.length, 'há hash sobrando na CSP (inline removido?)');
  if (inv.handlers.length) assert.ok(s.includes("'unsafe-hashes'"), "handlers on*= exigem 'unsafe-hashes'");
  // JS não pode gerar handlers/blocos inline (seriam bloqueados)
  for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter(n => n.endsWith('.js')))
    assert.doesNotMatch(read('js/' + f), /\son(?:click|change|input|submit|keydown|keyup|focus|blur|error|load)=["'\\]/, `${f}: handler inline gerado por JS`);
});

test('connect-src: só o domínio do Supabase (https e wss) + self', () => {
  const host = /https:\/\/([a-z0-9]+\.supabase\.co)/.exec(read('js/config.js'))[1];
  assert.deepEqual([...dir['connect-src']].sort(), ["'self'", `https://${host}`, `wss://${host}`].sort());
});

test("style-src: concessão registrada ('unsafe-inline' por causa do <style> e de atributos style=)", () => {
  assert.deepEqual(dir['style-src'], ["'self'", "'unsafe-inline'"]);
  assert.match(read('docs/qa/DECISOES.md'), /D10/);
  assert.match(read('docs/qa/DECISOES.md'), /frame-ancestors/);
});

test('o app não carrega nada fora da CSP (sem img/iframe/link externos nem eval)', () => {
  assert.doesNotMatch(html, /<(?:img|iframe|audio|video|embed|object)\b[^>]*\b(?:src|data)="https?:/i);
  assert.doesNotMatch(html, /<link[^>]*rel="stylesheet"[^>]*href="https?:/i);
  for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter(n => n.endsWith('.js'))) {
    const t = read('js/' + f);
    assert.doesNotMatch(t, /\beval\s*\(|new Function\s*\(|setTimeout\(\s*['"`]|setInterval\(\s*['"`]/, `${f}: eval/new Function/setTimeout(string)`);
  }
});
