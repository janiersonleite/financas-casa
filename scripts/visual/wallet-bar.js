#!/usr/bin/env node
// T3 — barra de carteira ativa em Chromium (Playwright), 320/360/390/768 px, 4 abas + nome longo + toast + lista de carteiras.
// Supabase SIMULADO (modo local do app), relógio fixo, requisições externas bloqueadas (libs de CDN servidas de LIBS_DIR).
//   NODE_PATH=<global> LIBS_DIR=<pasta com node_modules das libs> node scripts/visual/wallet-bar.js [--out docs/qa/visual/barra-carteira]
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('out', 'docs/qa/visual/barra-carteira'));
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
const LONGO = 'Carteira da família Silva e Souza — viagens, reformas e imprevistos de 2026';
const WIDTHS = [320, 360, 390, 768, 1280];   // 1280 = desktop (verificação extra)
const TABS = [['home', 'inicio'], ['history', 'historico'], ['summary', 'resumo'], ['investments', 'investir']];
const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const rel = { larguras: {}, erros: [], hostsBloqueados: new Set(), contraste: {} };
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 1, serviceWorkers: 'block', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', hasTouch: width < 768 });
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
      rel.hostsBloqueados.add(u.hostname); return route.abort();
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => rel.erros.push(`[${width}] ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|applyUpdate|waiting/.test(m.text())) rel.erros.push(`[${width}] ${m.text().slice(0, 160)}`); });
    await page.goto(base + '/');
    await page.waitForFunction(() => typeof App !== 'undefined' && App.categories && typeof Chart !== 'undefined', null, { timeout: 12000 });
    await page.waitForTimeout(700);
    // 3 carteiras: individual, compartilhada (3 membros) e uma de nome longo
    await page.evaluate(async longo => {
      Auth.user = { id: 'u1', email: 'ana@exemplo.com' };
      // ids explícitos: com o relógio fixo, o id local (Date.now()) seria igual para todas
      const mk = (id, name, type, emoji) => ({ id, name, type, emoji, owner_id: 'local', created_at: '2026-10-01T00:00:00Z' });
      const a = mk('f-pessoal', 'Pessoal', 'individual', '💼'), b = mk('f-familia', 'Família', 'compartilhada', '🏠'), c = mk('f-longo', longo, 'compartilhada', '📚');
      const d = Storage._localGet(); d.financas = [a, b, c]; Storage._localSave(d);
      App._walletMembers[b.id] = 3; App._walletMembers[c.id] = 2;
      localStorage.setItem('active_financa_id', b.id);   // loadFinancas() restaura a carteira ativa daqui
      await App.loadFinancas();
      App.activeFinanca = App.financas.find(f => f.id === b.id); Storage.setActiveFinanca(b.id); App.renderFinancaSwitcher();
      const ym = Utils.monthKeyLocal();
      for (const [type, description, value, day, category] of [['entrada', 'Salário', 5200, 5, 'Salário'], ['saida', 'Aluguel', 1450, 6, 'Moradia'], ['saida', 'Mercado', 389.9, 8, 'Alimentação']])
        await Storage.addTransaction({ type, description, value, date: `${ym}-${String(day).padStart(2, '0')}`, category, inserted_by_email: 'ana@exemplo.com' });
      await App.renderHome();
    }, LONGO);
    const medidas = [];
    const medir = async nome => {
      const m = await page.evaluate(() => {
        const bar = document.getElementById('wallet-bar'), r = bar.getBoundingClientRect(), chip = document.getElementById('wallet-bar-chip').getBoundingClientRect();
        const nm = document.getElementById('wallet-bar-name'), cs = getComputedStyle(nm), bs = getComputedStyle(bar);
        return { barraAltura: Math.round(r.height), barraTop: Math.round(r.top), barraDireita: Math.round(r.right), vw: innerWidth, scrollW: document.documentElement.scrollWidth, bodyScrollW: document.body.scrollWidth,
          chipDireita: Math.round(chip.right), chipVisivel: chip.width > 0, nomeTruncado: nm.scrollWidth > nm.clientWidth, nomeEllipsis: cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap' && cs.overflow === 'hidden',
          bordaInferior: bs.borderBottomWidth, corBorda: bs.borderBottomColor, fundo: bs.backgroundColor, chipTexto: document.getElementById('wallet-bar-chip').innerText.trim(), ativa: App.activeFinanca && App.activeFinanca.name, membros: JSON.stringify(App._walletMembers), tipos: JSON.stringify(App.financas.map(f => f.type)), nomeFonte: cs.fontSize };
      });
      m.nome = nome; m.semOverflowHorizontal = m.scrollW <= m.vw && m.bodyScrollW <= m.vw; m.alvoOk = m.barraAltura >= 44; m.chipDentro = m.chipDireita <= m.barraDireita;
      medidas.push(m); return m;
    };
    const foto = async nome => { await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' }); await page.waitForTimeout(150); await page.screenshot({ path: path.join(OUT, `${nome}.${width}.png`), clip: { x: 0, y: 0, width, height: 420 } }); };
    for (const [aba, rotulo] of TABS) {
      await page.evaluate(t => App.switchTab(t), aba); await page.waitForTimeout(500); await page.evaluate(() => window.scrollTo(0, 0));
      await medir(rotulo); await foto(`barra-${rotulo}`);
    }
    // nome longo
    await page.evaluate(() => { const c = App.financas.find(f => f.name.length > 40); App.activeFinanca = c; Storage.setActiveFinanca(c.id); App.renderFinancaSwitcher(); App.switchTab('home'); });
    await page.waitForTimeout(400); await medir('nome-longo'); await foto('barra-nome-longo');
    // painel "Trocar de carteira" + toast
    await page.evaluate(() => App.openFinancaModal()); await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `trocar-carteira.${width}.png`), clip: { x: 0, y: 0, width, height: 800 } });
    await page.evaluate(() => { const a = App.financas.find(f => f.name === 'Pessoal'); document.querySelector(`[data-financa-select="${a.id}"]`).click(); });
    await page.waitForTimeout(500); await medir('apos-trocar');
    await page.screenshot({ path: path.join(OUT, `barra-apos-trocar-toast.${width}.png`), clip: { x: 0, y: 0, width, height: 800 } });   // tela cheia: mostra o toast "Agora vendo"
    const toast = await page.evaluate(() => { const t = document.getElementById('wallet-toast'); const r = t.getBoundingClientRect(); return { texto: t.innerText, dentro: r.left >= 0 && r.right <= innerWidth, role: t.getAttribute('role') }; });
    rel.larguras[width] = { medidas, toast };
    await ctx.close();
  }
  await browser.close(); server.close();
  rel.hostsBloqueados = [...rel.hostsBloqueados];
  for (const c of ['#ffffff']) rel.contraste = { 'nome (branco sobre #06241a)': +ratio(c, '#06241a').toFixed(1), 'rótulo (branco 78% sobre #06241a)': +ratio('#b3bcb8', '#06241a').toFixed(1), 'chip ofline (#451a03 sobre #fbbf24)': +ratio('#451a03', '#fbbf24').toFixed(1) };
  fs.writeFileSync(path.join(OUT, 'medidas.json'), JSON.stringify(rel, null, 1));
  let falhas = 0;
  for (const [w, v] of Object.entries(rel.larguras)) for (const m of v.medidas) {
    const ok = m.semOverflowHorizontal && m.alvoOk && m.chipDentro && m.chipVisivel; if (!ok) falhas++;
    console.log(`${ok ? "OK  " : "FALHA"} ${w}px ${m.nome.padEnd(12)} barra=${m.barraAltura}px chip="${m.chipTexto.replace(/\s+/g, ' ')}" overflowH=${!m.semOverflowHorizontal} truncado=${m.nomeTruncado}`);
  }
  console.log('contraste:', JSON.stringify(rel.contraste), '| erros:', rel.erros.length, '| falhas:', falhas, '| hosts bloqueados:', rel.hostsBloqueados.join(',') || '-');
  rel.erros.slice(0, 8).forEach(e => console.log('  erro', e));
  process.exit(falhas || rel.erros.length ? 1 : 0);
})();
