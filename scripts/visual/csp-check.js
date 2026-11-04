#!/usr/bin/env node
// Validação da CSP (G4) em Chromium com Supabase SIMULADO: percorre os fluxos do app escutando `securitypolicyviolation`
// e o console. Nenhuma requisição sai da máquina (tudo fora de 127.0.0.1 é bloqueado/mockado; libs de CDN servidas de LIBS_DIR).
//   node scripts/visual/csp-check.js [--out docs/qa/csp-validacao.json] [--policy "<CSP de teste>"]   (--policy = controle negativo)
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('out', 'docs/qa/csp-validacao.json')), POLICY_OVERRIDE = arg('policy', null);
const LIBS = process.env.LIBS_DIR;
if (!LIBS) { console.error('defina LIBS_DIR'); process.exit(1); }
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';   // faz o route() valer também para as requisições do service worker (senão ele vazaria para a rede)
const { chromium } = require('playwright');
const XLSX = require(path.join(LIBS, 'node_modules/xlsx'));
const HOST = /https:\/\/([a-z0-9]+\.supabase\.co)/.exec(fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8'))[1];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const FAKE_UID = '11111111-1111-4111-8111-111111111111';   // fictício
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: FAKE_UID, role: 'authenticated', exp: 4102444800, email: 'ana@exemplo.com' })}.assinatura-falsa`;
const SESSION = { access_token: JWT, token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, refresh_token: 'rt-falso', user: { id: FAKE_UID, aud: 'authenticated', role: 'authenticated', email: 'ana@exemplo.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]); const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(f);
  if (POLICY_OVERRIDE && p === '/') body = Buffer.from(body.toString().replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]+/, `$1${POLICY_OVERRIDE}`));
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body);
});

const resultado = { politica: null, fluxos: [], violacoes: [], consoleErros: [], hostsBloqueados: [] };
const passos = [];
async function passo(nome, fn) {
  const antes = resultado.violacoes.length;
  try { await fn(); passos.push({ nome, ok: true, violacoes: resultado.violacoes.length - antes }); }
  catch (e) { passos.push({ nome, ok: false, erro: e.message.split('\n')[0], violacoes: resultado.violacoes.length - antes }); }
}

async function novaPagina(browser, base, { nuvem }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow', acceptDownloads: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  await ctx.grantPermissions(['notifications'], { origin: base });
  const page = await ctx.newPage();
  const tag = nuvem ? 'nuvem' : 'local';
  await page.exposeFunction('__cspReport', v => resultado.violacoes.push({ pass: tag, ...v }));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => window.__cspReport({ diretiva: e.violatedDirective, bloqueado: String(e.blockedURI).slice(0, 120), amostra: (e.sample || '').slice(0, 80), arquivo: String(e.sourceFile || '').split('/').slice(-2).join('/'), linha: e.lineNumber })));
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(t)) resultado.consoleErros.push({ pass: tag, tipo: m.type(), texto: t.slice(0, 220) }); });
  page.on('pageerror', e => {
    // pré-existente (não é CSP): o ✕ do modal #person-detail-modal chama App.closePersonDetail, que não existe (modal sem uso); o erro prova que o handler inline EXECUTOU
    if (/closePersonDetail is not a function/.test(e.message)) return (resultado.preExistentes ||= []).push('person-detail-modal: ' + e.message);
    resultado.consoleErros.push({ pass: tag, tipo: 'pageerror', texto: e.message.slice(0, 220) });
  });
  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url()), req = route.request();
    if (u.hostname === '127.0.0.1') {
      if (!nuvem && u.pathname === '/js/config.js') return route.fulfill({ contentType: 'application/javascript', body: "const SUPABASE_URL='SEU_PROJETO';const SUPABASE_ANON_KEY='SUA_ANON_KEY';const IS_SUPABASE_CONFIGURED=false;window.$sb=null;window.__PW_RECOVERY=false;window.__AUTH_LINK_ERROR=false;" });
      return route.continue();
    }
    if (u.hostname === 'cdn.jsdelivr.net') {
      const m = /^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.+)$/.exec(u.pathname), arq = m && path.join(LIBS, 'node_modules', m[1], m[2]);
      if (arq && fs.existsSync(arq)) return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(arq) });
    }
    if (nuvem && u.hostname === HOST) {                       // Supabase SIMULADO
      const json = (b, s = 200) => route.fulfill({ status: s, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' }, body: JSON.stringify(b) });
      if (req.method() === 'OPTIONS') return json({});
      if (u.pathname.startsWith('/auth/v1/token')) return json(SESSION);
      if (u.pathname.startsWith('/auth/v1/user')) return json(SESSION.user);
      if (u.pathname.startsWith('/auth/v1')) return json({});
      if (u.pathname.startsWith('/functions/v1')) return json({ ok: true });
      if (u.pathname.startsWith('/rest/v1/rpc')) return json(null);
      const obj = /object\+json/.test(req.headers()['accept'] || '');
      if (req.method() === 'GET' || req.method() === 'HEAD') return obj ? json({ message: 'sem linhas' }, 406) : json([]);
      let corpo = {}; try { corpo = JSON.parse(req.postData() || '{}'); } catch (_) {}
      const linhas = (Array.isArray(corpo) ? corpo : [corpo]).map((r, i) => ({ id: 'cccccccc-0000-4000-8000-00000000000' + (i % 10), created_at: '2026-10-15T15:00:00Z', ...r }));
      return json(obj ? linhas[0] : linhas, req.method() === 'POST' ? 201 : 200);
    }
    resultado.hostsBloqueados.push(u.hostname);
    return route.abort();
  });
  if (nuvem) await page.routeWebSocket(new RegExp(`wss://${HOST.replace(/\./g, '\\.')}/`), ws => { /* realtime simulado: aceita e não envia nada */ });
  return { ctx, page };
}

const SEED = async () => {
  Auth.user = Auth.user || { id: 'u1', email: 'ana@exemplo.com' };
  const ym = Utils.monthKeyLocal(), d = n => `${ym}-${String(n).padStart(2, '0')}`;
  for (const [type, description, value, date, category] of [['entrada', 'Salário', 5200, d(5), 'Salário'], ['saida', 'Aluguel', 1450, d(6), 'Moradia'], ['saida', 'Mercado', 389.9, d(8), 'Alimentação']])
    await Storage.addTransaction({ type, description, value, date, category, inserted_by_email: 'ana@exemplo.com' });
};

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  resultado.politica = POLICY_OVERRIDE || (/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html) || [])[1] || null;
  const tmpXlsx = path.join(require('node:os').tmpdir(), `csp-import-${process.pid}.xlsx`);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Data', 'Descrição', 'Valor', 'Tipo'], ['05/10/2026', 'Teste importação', 12.5, 'Saída']]), 'Planilha1');
  XLSX.writeFile(wb, tmpXlsx);

  // ───────── Passo A: modo local (sem Supabase) ─────────
  { const { ctx, page } = await novaPagina(browser, base, { nuvem: false });
    await passo('A1 carregar o app (scripts CDN com SRI, CSS, manifest, ícones)', async () => { await page.goto(base + '/'); await page.waitForFunction(() => typeof App !== 'undefined' && App.categories && typeof Chart !== 'undefined', null, { timeout: 12000 }); await page.waitForTimeout(600); });
    await passo('A2 abas Início/Histórico/Resumo/Investir', async () => { await page.evaluate(SEED); for (const t of ['home', 'history', 'summary', 'investments']) { await page.evaluate(t => App.switchTab(t), t); await page.waitForTimeout(250); } });
    await passo('A3 gráficos (Chart.js) desenhados no Resumo', async () => { await page.evaluate(() => App.switchTab('summary')); await page.waitForTimeout(500); const n = await page.evaluate(() => Object.keys(Chart.instances || {}).length); if (!n) throw new Error('nenhum gráfico criado'); });
    await passo('A4 criar lançamento pelo formulário (UI)', async () => { await page.evaluate(() => App.switchTab('home')); await page.click('#quick-send'); await page.fill('#modal-description', 'Teste CSP'); await page.fill('#modal-value', '1234'); await page.click('#modal-save'); await page.waitForTimeout(500); const ok = await page.evaluate(async () => (await Storage.getTransactions({})).some(t => t.description === 'Teste CSP')); if (!ok) throw new Error('lançamento não foi salvo'); });
    await passo('A5 exportar Excel', async () => { await page.evaluate(() => App.switchTab('summary')); const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.evaluate(() => document.getElementById('export-excel-btn').click())]); if (!/\.xlsx$/.test(dl.suggestedFilename())) throw new Error('arquivo inesperado: ' + dl.suggestedFilename()); });
    await passo('A6 exportar PDF', async () => { const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.evaluate(() => document.getElementById('export-pdf-btn').click())]); if (!/\.pdf$/.test(dl.suggestedFilename())) throw new Error('arquivo inesperado: ' + dl.suggestedFilename()); });
    await passo('A7 importar planilha (xlsx)', async () => { await page.evaluate(() => App.openImportModal()); await page.setInputFiles('#import-file', tmpXlsx); await page.waitForTimeout(900); });
    await passo('A8 cofrinho: criar (UI) e depositar', async () => { await page.evaluate(() => { document.querySelectorAll('[id$="-modal"]').forEach(e => e.classList.add('hidden')); Cofrinhos.setView('cofrinhos'); App.switchTab('investments'); }); await page.waitForTimeout(400); await page.evaluate(() => Cofrinhos.openForm()); await page.waitForSelector('#cof-name', { state: 'visible', timeout: 4000 }); await page.fill('#cof-name', 'Viagem CSP'); await page.fill('#cof-target', '600000'); await page.click('#cof-form-save'); await page.waitForTimeout(500); const c = await page.evaluate(() => (Storage._localGet().cofrinhos || []).length); if (!c) throw new Error('cofrinho não criado'); await page.evaluate(() => Cofrinhos.openMov(Storage._localGet().cofrinhos[0].id, 'deposito')); await page.fill('#cof-mov-amount', '10000'); await page.click('#cof-mov-save'); await page.waitForTimeout(400); });
    await passo('A9 lembretes: criar e listar', async () => { await page.evaluate(async () => { await Storage.createReminder({ name: 'Conta de luz', day: 20, amount: 210, category: 'Moradia', type: 'saida', emoji: '💡' }); await App.loadReminders(); App.openRemindersModal(); }); await page.waitForTimeout(300); await page.evaluate(() => App.openReminderForm()); await page.waitForTimeout(300); });
    await passo('A10 modais com onclick inline (fechar por clique no fundo e no ✕)', async () => { await page.evaluate(() => { document.querySelectorAll('[id$="-modal"],#modal-overlay').forEach(e => e.classList.add('hidden')); for (const id of ['cat-detail-modal', 'reminder-txn-modal', 'person-detail-modal']) document.getElementById(id).classList.remove('hidden'); }); await page.evaluate(() => { for (const id of ['cat-detail-modal', 'reminder-txn-modal', 'person-detail-modal']) document.querySelector('#' + id + ' button[onclick]').click(); }); const aindaAbertos = await page.evaluate(() => ['cat-detail-modal', 'reminder-txn-modal'].filter(id => !document.getElementById(id).classList.contains('hidden'))); if (aindaAbertos.length) throw new Error('onclick inline bloqueado: ' + aindaAbertos.join(',')); await page.evaluate(() => document.getElementById('cat-detail-modal').classList.remove('hidden')); await page.evaluate(() => document.getElementById('cat-detail-modal').click()); const fechou = await page.evaluate(() => document.getElementById('cat-detail-modal').classList.contains('hidden')); if (!fechou) throw new Error('onclick do fundo do modal bloqueado'); });
    await passo('A11 service worker registra, ativa e controla a página', async () => { await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then(r => !!r?.active), null, { timeout: 10000 }); await page.waitForTimeout(800); const ctrl = await page.evaluate(() => navigator.serviceWorker.controller ? 'controlada' : 'sem controller'); if (ctrl !== 'controlada') { await page.reload(); await page.waitForTimeout(800); } });
    await passo('A12 push: cartão de notificações e (re)sincronização', async () => { await page.evaluate(async () => { await PushNotif?.renderCard?.(); await PushNotif?.sync?.(true); }); });
    await ctx.close(); }

  // ───────── Passo B: modo nuvem com Supabase simulado ─────────
  { const { ctx, page } = await novaPagina(browser, base, { nuvem: true });
    await passo('B1 tela de login (cliente Supabase real, rede simulada)', async () => { await page.goto(base + '/'); await page.waitForSelector('#auth-email', { state: 'visible', timeout: 12000 }); });
    await passo('B2 login pela interface (REST/Auth em connect-src)', async () => { await page.fill('#auth-email', 'ana@exemplo.com'); await page.fill('#auth-password', 'senha-falsa-123'); await page.click('#auth-login-btn'); await page.waitForFunction(() => document.getElementById('auth-screen')?.classList.contains('hidden') || !document.getElementById('auth-screen'), null, { timeout: 10000 }); await page.waitForTimeout(1200); });
    await passo('B3 abas e lançamento na nuvem (POST simulado)', async () => { for (const t of ['home', 'history', 'summary', 'investments']) { await page.evaluate(t => App.switchTab(t), t); await page.waitForTimeout(250); } await page.evaluate(() => App.switchTab('home')); await page.click('#quick-send'); await page.fill('#modal-description', 'Teste nuvem'); await page.fill('#modal-value', '5000'); await page.click('#modal-save'); await page.waitForTimeout(800); });
    await passo('B4 Realtime (WebSocket wss) e Edge Function (convite) permitidos', async () => { await page.evaluate(async () => { try { await Storage.db.channel('csp-teste').subscribe(); } catch (_) {} try { await Storage.db.functions.invoke('send-invite', { body: {} }); } catch (_) {} }); await page.waitForTimeout(800); });
    await ctx.close(); }

  await browser.close(); server.close(); fs.rmSync(tmpXlsx, { force: true });
  resultado.fluxos = passos; resultado.hostsBloqueados = [...new Set(resultado.hostsBloqueados)];
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(resultado, null, 1));
  for (const p of passos) console.log(`${p.ok ? 'OK  ' : 'FALHA'} ${p.nome}${p.erro ? '  → ' + p.erro : ''}${p.violacoes ? `  [${p.violacoes} violação(ões)]` : ''}`);
  console.log(`\nviolações CSP: ${resultado.violacoes.length} | erros de console: ${resultado.consoleErros.length} | hosts bloqueados pelo teste: ${resultado.hostsBloqueados.join(',') || '-'}`);
  for (const v of resultado.violacoes.slice(0, 10)) console.log('  VIOLAÇÃO', JSON.stringify(v));
  for (const c of resultado.consoleErros.slice(0, 10)) console.log('  console', JSON.stringify(c));
})();
