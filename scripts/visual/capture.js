#!/usr/bin/env node
// Validação visual do G3 (Fase 3): captura as telas principais em Chromium com Supabase SIMULADO (modo local do app
// + login com cliente sem rede) e relógio fixo. NUNCA acessa a internet: toda requisição fora de localhost é bloqueada
// (as libs de CDN são servidas de uma pasta local instalada via npm — LIBS_DIR).
//   modo "cdn"   : equivalente ao cdn.tailwindcss.com — o CSS é gerado do DOM renderizado (como o Play CDN faz no navegador),
//                  com a MESMA versão do Tailwind e configuração padrão, acumulando as classes vistas.
//   modo "build" : usa o css/app.css gerado por `npm run build:css`.
//   node scripts/visual/capture.js --mode cdn|build --out docs/qa/visual/<mode>
// Requer: playwright (global), LIBS_DIR com chart.js, xlsx, jspdf, jspdf-autotable, @supabase/supabase-js instalados.
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const MODE = arg('mode', 'build'), OUT = path.resolve(arg('out', `docs/qa/visual/${MODE}`));
const LIBS = process.env.LIBS_DIR;
if (!LIBS) { console.error('defina LIBS_DIR (pasta com node_modules das libs de CDN)'); process.exit(1); }
const { chromium } = require('playwright');
const postcss = require(path.join(ROOT, 'node_modules/postcss'));
const tailwind = require(path.join(ROOT, 'node_modules/tailwindcss'));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]); const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});

const classesAcumuladas = new Set();
const baseCss = fs.readFileSync(path.join(ROOT, 'css/input.css'), 'utf8');
async function cssDoCdn(html) {
  for (const m of html.matchAll(/class(?:Name)?="([^"]*)"/g)) for (const t of m[1].split(/\s+/)) if (t) classesAcumuladas.add(t);
  const cfg = require(path.join(ROOT, 'tailwind.config.js'));
  const r = await postcss([tailwind({ ...cfg, safelist: [], content: [{ raw: [...classesAcumuladas].join(' '), extension: 'html' }] })]).process(baseCss, { from: undefined });
  return r.css;
}

const SEED = async () => {
  const hoje = Utils.todayLocal(), ym = Utils.monthKeyLocal();
  const dia = n => `${ym}-${String(n).padStart(2, '0')}`;
  const txs = [
    ['entrada', 'Salário', 5200, dia(5), 'Salário'], ['saida', 'Aluguel', 1450, dia(6), 'Moradia'], ['saida', 'Mercado Semanal', 389.9, dia(8), 'Alimentação'],
    ['saida', 'Uber', 28.5, dia(9), 'Transporte'], ['saida', 'Netflix', 55.9, dia(10), 'Lazer'], ['saida', 'Farmácia', 87.3, dia(12), 'Saúde'],
    ['saida', 'Restaurante', 142, dia(13), 'Alimentação'], ['entrada', 'Freela', 800, dia(14), 'Outros'], ['saida', 'Academia', 119.9, hoje, 'Saúde'],
  ];
  Auth.user = { id: 'u1', email: 'ana@exemplo.com' };   // fictício (no modo local o app não tem e-mail; o painel por pessoa exige um)
  let i = 0;
  for (const [type, description, value, date, category] of txs) await Storage.addTransaction({ type, description, value, date, category, inserted_by_email: i++ % 3 === 2 ? 'bruno@exemplo.com' : 'ana@exemplo.com' });
  await Storage.createReminder({ name: 'Conta de luz', day: 20, amount: 210, category: 'Moradia', type: 'saida', emoji: '💡', duration_months: 0 });
  await Storage.createReminder({ name: 'Internet', day: 28, amount: 99.9, category: 'Moradia', type: 'saida', emoji: '🌐', duration_months: 6, notify_time: '09:00' });
  await Cofrinhos.createCofrinho({ name: 'Viagem', emoji: '✈️', color: 'emerald', target: 6000, start: dia(1), targetDate: `${ym.slice(0, 4)}-12-20` });
  await Cofrinhos.createCofrinho({ name: 'Reserva de emergência', emoji: '🛟', color: 'blue', target: 15000, start: dia(1), targetDate: null });
};

const TELAS = [
  ['01-login', null],   // tratado à parte
  ['02-inicio', async p => { await p.evaluate(() => App.switchTab('home')); }],
  ['03-lancamentos', async p => { await p.evaluate(() => App.switchTab('history')); }],
  ['04-resumo', async p => { const e = await p.evaluate(async () => { try { await App.switchTab('summary'); } catch (x) { return x.stack; } }); if (e) throw new Error(e.split('\n').slice(0, 3).join(' | ')); }],
  ['05-investir-carteira', async p => { await p.evaluate(async () => { Cofrinhos.view = 'carteira'; await App.switchTab('investments'); }); }],
  ['06-cofrinhos', async p => { await p.evaluate(async () => { Cofrinhos.setView ? Cofrinhos.setView('cofrinhos') : (Cofrinhos.view = 'cofrinhos'); await App.switchTab('investments'); }); }],
  ['07-cofrinho-detalhe', async p => { await p.evaluate(() => { const c = Storage._localGet().cofrinhos[0]; Cofrinhos.openDetail(c.id); }); }],
  ['08-cofrinho-form', async p => { await p.evaluate(() => Cofrinhos.openForm()); }],
  ['09-cofrinho-mov', async p => { await p.evaluate(() => { const c = Storage._localGet().cofrinhos[0]; Cofrinhos.openMov(c.id, 'deposito'); }); }],
  ['10-lembretes', async p => { await p.evaluate(() => App.openRemindersModal()); }],
  ['11-lembrete-form', async p => { await p.evaluate(() => App.openReminderForm()); }],
  ['12-lancamento-novo', async p => { await p.evaluate(() => App.openModal({ focusValue: false })); }],
  ['13-lancamento-parcelado', async p => { await p.evaluate(() => App.openModal({ description: 'Notebook', value: 3000, installments: 6, focusValue: false })); }],
  ['14-lancamento-editar', async p => { await p.evaluate(async () => { const t = (await Storage.getTransactions({})).find(x => x.description === 'Aluguel'); App.editingId = t.id; App.openModal({ ...t, focusValue: false }); }); }],
  ['15-carteiras', async p => { await p.evaluate(() => App.openFinancaModal()); }],
  ['16-carteira-nova', async p => { await p.evaluate(() => App.openCreateFinancaModal()); }],
  ['17-categorias', async p => { await p.evaluate(() => App.openCategoryModal()); }],
  ['18-categoria-form', async p => { await p.evaluate(() => App.openCategoryForm()); }],
  ['19-tipos', async p => { await p.evaluate(() => App.openTypesModal()); }],
  ['20-metas', async p => { await p.evaluate(() => App.openGoalsModal()); }],
  ['21-importar', async p => { await p.evaluate(() => App.openImportModal()); }],
];
const VIEWPORTS = { mobile: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const relatorio = { modo: MODE, telas: {}, erros: [], requisicoesBloqueadas: [] };
  async function novaPagina(vp, { loginMode }) {
    const ctx = await browser.newContext({ viewport: VIEWPORTS[vp], deviceScaleFactor: 1, serviceWorkers: 'block', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    await ctx.clock.setFixedTime(new Date('2026-10-15T15:00:00-03:00'));
    const page = await ctx.newPage();
    page.on('pageerror', e => relatorio.erros.push(`[${vp}] pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/waiting|ERR_FAILED|applyUpdate/.test(m.text())) relatorio.erros.push(`[${vp}] console: ${m.text().slice(0, 200)}`); });
    await page.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (u.hostname === '127.0.0.1') {
        if (u.pathname === '/js/config.js' && !loginMode) return route.fulfill({ contentType: 'application/javascript', body: "const SUPABASE_URL='SEU_PROJETO';const SUPABASE_ANON_KEY='SUA_ANON_KEY';const IS_SUPABASE_CONFIGURED=false;window.$sb=null;window.__PW_RECOVERY=false;window.__AUTH_LINK_ERROR=false;" });
        return route.continue();
      }
      if (u.hostname === 'cdn.jsdelivr.net') {
        const m = /^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.+)$/.exec(u.pathname);   // /npm/<pacote>@<versão>/<arquivo>
        const arq = m && path.join(LIBS, 'node_modules', m[1], m[2]);
        if (arq && fs.existsSync(arq)) return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(arq) });
      }
      relatorio.requisicoesBloqueadas.push(u.hostname);   // nada sai da máquina (inclui *.supabase.co)
      return route.abort();
    });
    // o index.html de produção carrega o SRI das libs do npm: as cópias locais são byte a byte as mesmas, então o SRI confere
    return { ctx, page };
  }
  async function cssCdnInject(page) {
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const css = await cssDoCdn(html);
    await page.evaluate(c => { let s = document.getElementById('tw-play'); if (!s) { s = document.createElement('style'); s.id = 'tw-play'; document.head.appendChild(s); } s.textContent = c; }, css);
  }
  async function fechaTudo(page) {
    await page.evaluate(() => { document.querySelectorAll('[id$="-modal"],[id$="-overlay"]').forEach(e => e.classList.add('hidden')); });
  }
  async function foto(page, nome, vp) {
    if (MODE === 'cdn') await cssCdnInject(page);
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, `${nome}.${vp}.png`), fullPage: false });
    // classes presentes no DOM nesse estado (para conferir contra o CSS gerado)
    const cls = await page.evaluate(() => [...new Set([...document.querySelectorAll('[class]')].flatMap(e => (typeof e.className === 'string' ? e.className : '').split(/\s+/)).filter(Boolean))]);
    (relatorio.telas[nome] ||= {})[vp] = cls.length;
    relatorio.classesDom = [...new Set([...(relatorio.classesDom || []), ...cls])];
  }

  for (const vp of Object.keys(VIEWPORTS)) {
    // login (cliente Supabase real do app, sem rede: getSession lê só o armazenamento local)
    { const { ctx, page } = await novaPagina(vp, { loginMode: true });
      if (MODE === 'cdn') await page.route('https://cdn.tailwindcss.com/**', r => r.fulfill({ contentType: 'application/javascript', body: '' }));
      await page.goto(base + '/'); await page.waitForSelector('#tab-auth-login', { state: 'visible', timeout: 8000 }).catch(() => {});
      await foto(page, '01-login', vp); await ctx.close(); }
    const { ctx, page } = await novaPagina(vp, { loginMode: false });
    if (MODE === 'cdn') await page.route('https://cdn.tailwindcss.com/**', r => r.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(base + '/'); await page.waitForFunction(() => window.App && App.categories, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);
    try { await page.evaluate(SEED); await page.evaluate(async () => { await App.loadReminders(); await App.loadCategories(); await Cofrinhos.load?.(); await App.renderHome(); }); }
    catch (e) { relatorio.erros.push('seed: ' + e.message); }
    for (const [nome, abrir] of TELAS) {
      if (!abrir) continue;
      try { await fechaTudo(page); await abrir(page); await page.waitForTimeout(400); await foto(page, nome, vp); }
      catch (e) { relatorio.erros.push(`${nome}/${vp}: ${e.message.split('\n')[0]}`); }
    }
    await ctx.close();
  }
  await browser.close(); server.close();
  relatorio.requisicoesBloqueadas = [...new Set(relatorio.requisicoesBloqueadas)];
  fs.writeFileSync(path.join(OUT, 'relatorio.json'), JSON.stringify(relatorio, null, 1));
  console.log(`modo=${MODE}: ${Object.keys(relatorio.telas).length} telas | erros=${relatorio.erros.length} | hosts bloqueados: ${relatorio.requisicoesBloqueadas.join(',') || '-'}`);
  relatorio.erros.slice(0, 15).forEach(e => console.log('  ' + e));
})();
