#!/usr/bin/env node
// Desktop compacto: menu lateral flutuante encostado na coluna do app e barra de carteira na mesma coluna.
// Chromium (Playwright), Supabase simulado (modo local), relógio fixo, rede externa bloqueada.
//   NODE_PATH=<global> LIBS_DIR=<libs> node scripts/visual/desktop-layout.js [--out docs/qa/visual/desktop-compacto]
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('out', 'docs/qa/visual/desktop-compacto'));
const LIBS = process.env.LIBS_DIR;
if (!LIBS) { console.error('defina LIBS_DIR'); process.exit(1); }
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const { chromium } = require('playwright');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]); const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(res);
});
const SIZES = [[1024, 768], [1280, 800], [1366, 768], [1440, 900], [1920, 1080], [2560, 1300], [3440, 1400]];
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const rel = { medidas: [], erros: [], hosts: new Set() };
  for (const [w, h] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    await ctx.clock.setFixedTime(new Date('2026-10-15T15:00:00-03:00'));
    await ctx.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (u.hostname === '127.0.0.1') {
        if (u.pathname === '/js/config.js') return route.fulfill({ contentType: 'application/javascript', body: "const SUPABASE_URL='SEU_PROJETO';const SUPABASE_ANON_KEY='SUA_ANON_KEY';const IS_SUPABASE_CONFIGURED=false;window.$sb=null;window.__PW_RECOVERY=false;window.__AUTH_LINK_ERROR=false;" });
        return route.continue();
      }
      if (u.hostname === 'cdn.jsdelivr.net') {
        const m = /^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.+)$/.exec(u.pathname), arq = m && path.join(LIBS, 'node_modules', m[1], m[2]);
        if (arq && fs.existsSync(arq)) return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(arq) });
      }
      rel.hosts.add(u.hostname); return route.abort();
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => rel.erros.push(`[${w}] ${e.message}`));
    await page.goto(base + '/');
    await page.waitForFunction(() => typeof App !== 'undefined' && App.categories && typeof Chart !== 'undefined', null, { timeout: 12000 });
    await page.waitForTimeout(600);
    await page.evaluate(async () => {
      Auth.user = { id: 'u1', email: 'ana@exemplo.com' };
      const d = Storage._localGet(); d.financas = [{ id: 'f1', name: 'Família', type: 'individual', emoji: '🏠', owner_id: 'local', created_at: '2026-10-01T00:00:00Z' }]; Storage._localSave(d);
      localStorage.setItem('active_financa_id', 'f1');
      App.refreshWalletMembers = async function () { this._wc = { state: 'loaded', counts: { f1: 2 }, admin: {}, invites: {}, seq: 0 }; this._walletSurfacesChanged(); };
      await App.loadFinancas(); await App.refreshWalletMembers();
      const ym = Utils.monthKeyLocal();
      await Storage.addTransaction({ type: 'saida', description: 'Aluguel', value: 6278.23, date: ym + '-06', category: 'Moradia' });
      await App.renderHome();
    });
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const R = e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) }; };
      const nav = R(document.getElementById('bottom-nav')), col = R(document.querySelector('.tab-page:not(.hidden)')), inner = R(document.querySelector('#wallet-bar .wb-inner'));
      return { vw: innerWidth, vh: innerHeight, nav, col, inner, scrollW: document.documentElement.scrollWidth };
    });
    m.navColado = m.col.l - m.nav.r;                       // folga entre o menu e a coluna
    m.navCentralizado = Math.abs((m.nav.t + m.nav.b) / 2 - m.vh / 2) <= 2;
    m.semSobreposicao = m.nav.r <= m.col.l + 1;
    m.barraNaColuna = Math.abs(m.inner.l - m.col.l) <= 1 && Math.abs(m.inner.r - m.col.r) <= 1;
    m.ok = m.semSobreposicao && m.barraNaColuna && m.navCentralizado && m.scrollW <= m.vw && m.nav.l >= 0 && (m.navColado <= 20 || m.nav.l <= 12);
    rel.medidas.push(m);
    await page.screenshot({ path: path.join(OUT, `inicio.${w}.png`), fullPage: false });
    if (w === 1366 || w === 1920) for (const t of ['history', 'summary', 'investments']) {
      await page.evaluate(tab => App.switchTab(tab), t); await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(OUT, `${t}.${w}.png`), fullPage: false });
    }
    await ctx.close();
  }
  await browser.close(); server.close();
  rel.hosts = [...rel.hosts];
  fs.writeFileSync(path.join(OUT, 'medidas.json'), JSON.stringify(rel, null, 1));
  let falhas = 0;
  for (const m of rel.medidas) { if (!m.ok) falhas++; console.log(`${m.ok ? 'OK  ' : 'FALHA'} ${m.vw}px  menu ${m.nav.l}-${m.nav.r}  coluna ${m.col.l}-${m.col.r}  folga ${m.navColado}px  barra ${m.inner.l}-${m.inner.r}  overflow=${m.scrollW > m.vw}`); }
  console.log('erros:', rel.erros.length, '| falhas:', falhas, '| hosts bloqueados:', rel.hosts.join(',') || '-');
  process.exit(falhas || rel.erros.length ? 1 : 0);
})();
