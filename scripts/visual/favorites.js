#!/usr/bin/env node
// T4 — favoritos de um toque em Chromium (Playwright), 320/390/768 px: Home com 0, 3 e 6 favoritos (mistos), painel de valor (saída e entrada),
// gerenciar e editar. Verifica: sem overflow horizontal e alvos de toque ≥ 44 px. Supabase SIMULADO (modo local), relógio fixo, rede externa bloqueada.
//   NODE_PATH=<global> LIBS_DIR=<libs> node scripts/visual/favorites.js [--out docs/qa/visual/onda1-favoritos]
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('out', 'docs/qa/visual/onda1-favoritos'));
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
const WIDTHS = [320, 390, 768];
const CATS = [
  { id: 'c0000000-0000-4000-8000-0000000000a1', name: 'Alimentação', emoji: '🍔', type: 'saida' }, { id: 'c0000000-0000-4000-8000-0000000000a2', name: 'Salário', emoji: '💰', type: 'entrada' },
  { id: 'c0000000-0000-4000-8000-0000000000a3', name: 'Transporte', emoji: '🚗', type: 'saida' }, { id: 'c0000000-0000-4000-8000-0000000000a4', name: 'Outros', emoji: '📦', type: 'both' },
];
const FAVS = [['Mercado', 'saida', 0], ['Salário', 'entrada', 1], ['Uber', 'saida', 2], ['Freela', 'entrada', 3], ['Farmácia', 'saida', null], ['Aluguel recebido', 'entrada', 1]];

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const rel = { larguras: {}, erros: [], hosts: new Set() };
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', hasTouch: width < 768 });
    await ctx.clock.setFixedTime(new Date('2026-11-04T15:00:00-03:00'));
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
    page.on('pageerror', e => rel.erros.push(`[${width}] ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|applyUpdate|waiting/.test(m.text())) rel.erros.push(`[${width}] ${m.text().slice(0, 160)}`); });
    await page.goto(base + '/');
    await page.waitForFunction(() => typeof App !== 'undefined' && App.categories && typeof Chart !== 'undefined', null, { timeout: 12000 });
    await page.waitForTimeout(600);
    await page.evaluate(async cats => {
      Auth.user = { id: 'u1', email: 'ana@exemplo.com' };
      const d = Storage._localGet(); d.financas = [{ id: 'f-familia', name: 'Família', type: 'compartilhada', emoji: '🏠', owner_id: 'local', created_at: '2026-10-01T00:00:00Z' }]; Storage._localSave(d);
      localStorage.setItem('active_financa_id', 'f-familia');
      App.refreshWalletMembers = async function () { this._wc = { state: 'loaded', counts: { 'f-familia': 2 }, admin: {}, roles: {}, invites: {}, seq: 0 }; this._walletSurfacesChanged(); };
      await App.loadFinancas(); await App.refreshWalletMembers();
      App.categories = cats; App._financasLoaded = true;
    }, CATS);
    const medidas = [];
    const medir = async nome => {
      const m = await page.evaluate(() => {
        const alvos = [...document.querySelectorAll('#fav-grid button, #fav-edit-btn, .fav-key, #fav-cta, #fav-undo, #fav-panel-close, #fav-manage-close, #fav-manage-box button, #fav-edit-box button, #fav-edit-box input, #fav-edit-box select')]
          .filter(e => e.offsetParent !== null && !e.closest('.hidden')).map(e => { const r = e.getBoundingClientRect(); return { id: e.id || e.className.slice(0, 20) || e.tagName, w: Math.round(r.width), h: Math.round(r.height) }; });
        return { vw: innerWidth, scrollW: document.documentElement.scrollWidth, alvos, pequenos: alvos.filter(a => a.h < 44 || a.w < 44) };
      });
      m.nome = nome; m.semOverflow = m.scrollW <= m.vw; m.alvosOk = m.pequenos.length === 0; medidas.push(m); return m;
    };
    const foto = async (nome, full = false) => { await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' }); await page.waitForTimeout(150); await page.screenshot({ path: path.join(OUT, `${nome}.${width}.png`), fullPage: false }); };
    const rolar = async () => { await page.evaluate(() => document.getElementById('home-fav').scrollIntoView({ block: 'start' })); await page.evaluate(() => window.scrollBy(0, -70)); };
    const limpar = () => page.evaluate(() => { localStorage.removeItem('fav_local_f-familia'); });

    // Home com 0 favoritos
    await limpar(); await page.evaluate(() => App.renderHome()); await page.waitForTimeout(400); await rolar(); await medir('home-0'); await foto('home-0-favoritos');
    // 3 favoritos (2 saídas + 1 entrada) e 6 favoritos (3 saídas + 3 entradas)
    for (const [qtd, nome] of [[3, 'home-3'], [6, 'home-6']]) {
      await limpar();
      await page.evaluate(async ([favs, qtd, cats]) => { for (const [name, type, ci] of favs.slice(0, qtd)) await Favorites.create({ name, type, categoryId: ci === null ? null : cats[ci].id }); await App.renderHome(); }, [FAVS, qtd, CATS]);
      await page.waitForTimeout(400); await rolar(); await medir(nome); await foto(`${nome}-favoritos`);
    }
    // painel de valor — saída (R$ 15,00) e entrada (R$ 2.500,00)
    await page.click('[data-fav-id]'); await page.waitForTimeout(200);
    for (const k of ['1', '5', '0', '0']) await page.click(`[data-key="${k}"]`);
    await medir('painel-saida'); await foto('painel-saida');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    await page.evaluate(() => [...document.querySelectorAll('[data-fav-id]')].find(b => /Salário/.test(b.textContent)).click()); await page.waitForTimeout(200);
    for (const k of ['2', '5', '0', '0', '0', '0']) await page.click(`[data-key="${k}"]`);
    await medir('painel-entrada'); await foto('painel-entrada');
    // lança a entrada e mostra o toast com Desfazer
    await page.click('#fav-cta'); await page.waitForTimeout(500); await rolar(); await medir('toast'); await foto('toast-desfazer');
    // gerenciar + editor
    await page.click('#fav-undo').catch(() => {}); await page.waitForTimeout(300);
    await page.evaluate(() => { for (let i = 0; i < 4; i++) Storage._localAdd({ type: 'saida', description: 'Pão', value: 5, date: Utils.todayLocal(), category: 'Alimentação' }); });
    await page.click('#fav-edit-btn'); await page.waitForTimeout(400); await medir('gerenciar'); await foto('gerenciar');
    await page.click('#fav-manage-box [data-act="edit"]'); await page.waitForTimeout(200); await medir('editor'); await foto('editor');
    rel.larguras[width] = medidas;
    await ctx.close();
  }
  await browser.close(); server.close();
  rel.hosts = [...rel.hosts];
  fs.writeFileSync(path.join(OUT, 'medidas.json'), JSON.stringify(rel, null, 1));
  let falhas = 0;
  for (const [w, ms] of Object.entries(rel.larguras)) for (const m of ms) {
    const ok = m.semOverflow && m.alvosOk; if (!ok) falhas++;
    console.log(`${ok ? 'OK  ' : 'FALHA'} ${w}px ${m.nome.padEnd(14)} overflowH=${!m.semOverflow} alvos=${m.alvos.length} menores que 44px=${m.pequenos.length}${m.pequenos.length ? ' → ' + JSON.stringify(m.pequenos.slice(0, 3)) : ''}`);
  }
  console.log('erros:', rel.erros.length, '| falhas:', falhas, '| hosts bloqueados:', rel.hosts.join(',') || '-');
  rel.erros.slice(0, 8).forEach(e => console.log('  erro', e));
  process.exit(falhas || rel.erros.length ? 1 : 0);
})();
