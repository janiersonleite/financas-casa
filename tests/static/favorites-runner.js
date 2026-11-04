// Executado em processo filho (jsdom). Cenários dos favoritos de um toque (Home, painel de valor, desfazer, gerenciar/editar, papéis, XSS).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '..', '..');
const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window, d = w.document;
w.Chart = function () { return { destroy() {}, update() {} }; };
w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
const ctx = dom.getInternalVMContext();
for (const f of ['utils.js', 'storage.js', 'nlp.js', 'insights.js', 'metrics.js', 'favorites.js', 'favorites-ui.js', 'app.js']) new vm.Script(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), { filename: f }).runInContext(ctx);
new vm.Script("var Auth = { user: { id: 'me', email: 'ana@exemplo.com' }, init: () => new Promise(() => {}) }; var PushNotif = { syncSoon() {} };").runInContext(ctx);
const get = n => new vm.Script(n).runInContext(ctx);
const App = get('App'), Storage = get('Storage'), Utils = get('Utils'), Favorites = get('Favorites'), UI = get('FavoritesUI');
const tick = ms => new Promise(r => setTimeout(r, ms));
const $ = id => d.getElementById(id);
const out = {};

// ── "banco" simulado ──
const F1 = { id: 'f1111111-0000-4000-8000-000000000001', name: 'Família', emoji: '🏠', type: 'individual', owner_id: 'other' };
const F2 = { id: 'f2222222-0000-4000-8000-000000000002', name: 'Viagem', emoji: '✈️', type: 'individual', owner_id: 'other' };
const CATS = [
  { id: 'c0000000-0000-4000-8000-0000000000a1', name: 'Alimentação', emoji: '🍔', type: 'saida' },
  { id: 'c0000000-0000-4000-8000-0000000000a2', name: 'Salário', emoji: '💰', type: 'entrada' },
  { id: 'c0000000-0000-4000-8000-0000000000a3', name: 'Outros', emoji: '📦', type: 'both' },
];
const table = []; const calls = { insert: [], update: [], delete: [], addTx: [], delTx: [] }; let seq = 1, falhaTx = false;
const fav = (o) => table.push({ id: 'fav-' + seq++, user_id: 'me', financa_id: F1.id, position: seq, created_at: '2026-11-01T00:00:00Z', category_id: null, ...o });
const TX = [];
Object.defineProperty(Storage, 'isCloud', { get: () => true });
Object.defineProperty(Storage, 'isOnline', { get: () => true });
const q = (fn) => ({ select: () => ({ single: fn }) });
const fakeDb = {
  from: () => ({
    select: () => ({ eq: (c, v) => ({ order: () => ({ order: async () => ({ data: table.filter(r => r.financa_id === v).sort((x, y) => x.position - y.position).map(r => ({ ...r })), error: null }) }) }) }),
    insert: row => q(async () => { calls.insert.push({ ...row }); const r = { id: 'fav-' + seq++, user_id: 'me', created_at: '2026-11-02T00:00:00Z', ...row }; table.push(r); return { data: { ...r }, error: null }; }),
    update: patch => ({ eq: (c, id) => q(async () => { calls.update.push({ id, ...patch }); const r = table.find(x => x.id === id); Object.assign(r, patch); return { data: { ...r }, error: null }; }) }),
    delete: () => ({ eq: async (c, id) => { calls.delete.push(id); const i = table.findIndex(x => x.id === id); if (i >= 0) table.splice(i, 1); return { error: null }; } }),
  }),
};
Object.defineProperty(Storage, 'db', { configurable: true, value: fakeDb });
Storage.userId = () => 'me';
Storage.setActiveFinanca(F1.id);
Storage.getTransactions = async () => TX.map(t => ({ ...t }));
Storage.getSummary = async () => { let inc = 0, exp = 0; for (const t of TX) { if (t.type === 'entrada') inc += t.value; else exp += t.value; } return { income: inc, expense: exp, balance: Utils.roundMoney(inc - exp) }; };
Storage.addTransaction = async t => { calls.addTx.push({ ...t }); await tick(5); if (falhaTx) throw new Error('rede caiu'); const tx = { id: 'tx' + (TX.length + 1), ...t }; TX.push(tx); return tx; };
Storage.deleteTransaction = async id => { calls.delTx.push(id); const i = TX.findIndex(t => t.id === id); if (i >= 0) TX.splice(i, 1); };
Storage.syncCustomTypesFromCloud = async () => {};
App.loadReminders = async () => {}; App._retroLearn = () => {}; App.renderQuickButtons = () => {}; App.renderRemindersHome = () => {};
App.renderCurrentTab = async () => {};
App.financas = [F1, F2]; App.activeFinanca = F1; App.categories = CATS.map(c => ({ ...c })); App._financasLoaded = true;
App._wc = { state: 'loaded', counts: { [F1.id]: 2, [F2.id]: 1 }, admin: {}, roles: { [F1.id]: 'membro', [F2.id]: 'membro' }, invites: {}, seq: 0 };
UI.init();
const sec = () => ({ oculta: $('home-fav').classList.contains('hidden'), botoes: [...d.querySelectorAll('#fav-grid [data-fav-id]')].map(b => ({ texto: b.textContent.replace(/\s+/g, ' ').trim(), aria: b.getAttribute('aria-label'), tipo: b.className.match(/t-(\w+)/)?.[1], selo: b.querySelector('.fav-badge')?.textContent.trim(), icone: !!b.querySelector('.fav-badge svg') })), vazio: !!d.querySelector('#fav-grid .fav-empty'), vazioTexto: d.querySelector('#fav-grid .fav-empty')?.textContent.replace(/\s+/g, ' ').trim() || '' });
const home = async () => { await App.renderHome(); await tick(50); };   // os favoritos carregam sem bloquear a Home
const saldo = () => $('balance').textContent.replace(/\s/g, ' ');

(async () => {
  // A) 0 favoritos → cartão de criação
  await home();
  out.vazio = { ...sec(), temAdicionar: !!d.querySelector('#fav-grid [data-fav-new]') };

  // B) favoritos mistos (3 saídas + 2 entradas) — nenhum valor aparece nos botões
  fav({ name: 'Mercado', type: 'saida', category_id: CATS[0].id, position: 1 });
  fav({ name: 'Salário', type: 'entrada', category_id: CATS[1].id, position: 2 });
  fav({ name: 'Uber', type: 'saida', position: 3 });
  fav({ name: 'Freela', type: 'entrada', category_id: CATS[2].id, position: 4 });
  fav({ name: 'Farmácia', type: 'saida', position: 5 });
  fav({ name: 'De outra carteira', type: 'saida', financa_id: F2.id, position: 1 });
  await home();
  out.misto = sec();

  // C) tocar abre o painel
  const btnMercado = d.querySelector('[data-fav-id]'); btnMercado.focus();
  btnMercado.click(); await tick(60);
  const painel = () => ({ aberto: !$('fav-panel').classList.contains('hidden'), titulo: $('fav-panel-title').textContent, cat: $('fav-panel-cat').textContent, carteira: $('fav-panel-wallet').textContent, cor: $('fav-panel-wallet').style.getPropertyValue('--wallet-accent'),
    valor: $('fav-amount').textContent.replace(/\s/g, ' '), cta: $('fav-cta').textContent, ctaDesab: $('fav-cta').disabled, ariaTeclas: [...d.querySelectorAll('#fav-keypad button')].map(b => b.getAttribute('aria-label')), foco: d.activeElement?.id });
  out.painelSaida = { ...painel(), corEsperada: Utils.walletColor(F1.id) };
  for (const k of ['1', '5', '0', '0']) d.querySelector(`[data-key="${k}"]`).click();
  out.painelSaidaValor = painel();
  d.querySelector('[data-key="del"]').click(); const aposApagar = painel().valor;
  d.querySelector('[data-key="00"]').click(); out.teclado = { aposApagar, aposDoisZeros: painel().valor };
  d.querySelector('[data-key="del"]').click();   // 15000 → 1500: volta a R$ 15,00

  // D) lançar: payload exato, duplo toque = 1 insert, saldo subtrai
  const saldoAntes = saldo();
  const cta = $('fav-cta'); cta.click(); cta.click(); cta.click();
  await tick(400);
  out.lancarSaida = { payload: calls.addTx.map(x => ({ ...x })), chamadas: calls.addTx.length, hoje: Utils.todayLocal(), painelFechado: $('fav-panel').classList.contains('hidden'), saldoAntes, saldoDepois: saldo(),
    toast: { texto: $('fav-toast-text').textContent, role: $('fav-toast').getAttribute('role'), visivel: !$('fav-toast').classList.contains('hidden'), desfazer: $('fav-undo').textContent, desfazerMin: $('fav-undo').style.minHeight },
    foco: d.activeElement?.dataset?.favId === btnMercado.dataset.favId };

  // E) desfazer remove SÓ o id criado
  TX.push({ id: 'tx-antigo', type: 'saida', value: 10, description: 'Antigo', date: Utils.todayLocal(), category: 'Outros' });
  $('fav-undo').click(); await tick(60);
  out.desfazer = { apagou: calls.delTx.slice(), restou: TX.map(t => t.id), toastEscondido: $('fav-toast').classList.contains('hidden'), saldo: saldo() };

  // F) favorito de ENTRADA: título com tipo, prefixo +, CTA, grava o tipo e SOMA
  const btnSal = [...d.querySelectorAll('[data-fav-id]')].find(b => /Salário/.test(b.textContent)); btnSal.click(); await tick(40);
  for (const k of ['2', '5', '0', '0', '0', '0']) d.querySelector(`[data-key="${k}"]`).click();
  out.painelEntrada = painel();
  const sAntesEntrada = saldo(); $('fav-cta').click(); await tick(80);
  out.lancarEntrada = { payload: { ...calls.addTx[calls.addTx.length - 1] }, saldoAntes: sAntesEntrada, saldoDepois: saldo(), toast: $('fav-toast-text').textContent };

  // G) falha no insert: painel continua aberto, valor mantido, erro claro
  falhaTx = true;
  d.querySelector('[data-fav-id]').click(); await tick(40);
  for (const k of ['9', '9', '0', '0']) d.querySelector(`[data-key="${k}"]`).click();
  $('fav-cta').click(); await tick(80);
  out.falha = { aberto: !$('fav-panel').classList.contains('hidden'), valor: $('fav-amount').textContent.replace(/\s/g, ' '), erro: $('fav-error').textContent, erroVisivel: !$('fav-error').classList.contains('hidden'), ctaHabilitado: !$('fav-cta').disabled, txs: TX.length };
  falhaTx = false;
  // Esc fecha e devolve o foco
  const origem = d.querySelector('[data-fav-id]'); 
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(60);
  out.esc = { fechou: $('fav-panel').classList.contains('hidden') };
  // valor zero desabilita
  d.querySelector('[data-fav-id]').click(); await tick(30); out.zero = { ctaDesab: $('fav-cta').disabled }; UI.closePanel(); await tick(30);

  // H) trocar de carteira troca os favoritos
  App.activeFinanca = F2; Storage.setActiveFinanca(F2.id); await home();
  out.outraCarteira = sec();
  App.activeFinanca = F1; Storage.setActiveFinanca(F1.id);

  // I) visualizador não vê a seção; membro/admin veem
  App._wc.roles[F1.id] = 'visualizador'; await home(); out.visualizador = sec().oculta;
  App._wc.roles[F1.id] = 'admin'; await home(); out.admin = !sec().oculta;
  App._wc.roles[F1.id] = 'membro'; App._wc.state = 'idle'; delete App._wc.roles[F1.id]; await home(); out.papelDesconhecido = sec().oculta;   // espera carregar: não pisca
  App._wc.state = 'loaded'; App._wc.roles[F1.id] = 'membro'; await home();

  // J) gerenciar: contador, selos, ajuda; criar/editar; troca de tipo limpa categoria; 7º bloqueado
  d.getElementById('fav-edit-btn').click(); await tick(80);
  const lista = () => [...d.querySelectorAll('#fav-manage-list .fav-row')].map(r => ({ nome: r.querySelector('.font-semibold').textContent, selo: r.querySelector('.fav-badge').textContent.trim(), cat: r.querySelector('.text-xs').textContent.trim() }));
  out.gerenciar = { contador: $('fav-counter').textContent, ajuda: $('fav-manage-box').textContent.includes('Entradas e saídas dividem as 6 vagas'), lista: lista(), addDesab: $('fav-add').disabled };
  // editor: escolhe categoria de SAÍDA e troca o tipo para ENTRADA → limpa e pede nova
  fav.length; // (noop)
  d.querySelector('[data-act="del"]').click(); await tick(30);
  out.confirmar = { texto: d.querySelector('[data-act="del"]').textContent.trim(), aindaTem: table.filter(r => r.financa_id === F1.id).length };
  d.querySelector('[data-row]').querySelector('[data-act="del"]').click(); await tick(60);    // 2º toque confirma
  out.removeu = { calls: calls.delete.length, restam: table.filter(r => r.financa_id === F1.id).length, contador: $('fav-counter').textContent };
  $('fav-add').click(); await tick(60);
  $('fav-name').value = '  Padaria   do Zé '; 
  $('fav-cat').value = CATS[0].id; $('fav-cat').dispatchEvent(new w.Event('change'));
  d.querySelector('[data-fav-type="entrada"]').click();
  out.trocaTipo = { categoriaLimpa: $('fav-cat').value === '', dica: $('fav-cat-hint').textContent, dicaVisivel: !$('fav-cat-hint').classList.contains('hidden'), opcoes: [...$('fav-cat').options].map(o => o.textContent.trim()) };
  d.querySelector('[data-fav-type="saida"]').click();
  $('fav-cat').value = CATS[0].id; $('fav-cat').dispatchEvent(new w.Event('change'));
  $('fav-edit-save').click(); await tick(80);
  out.criou = { insert: calls.insert[calls.insert.length - 1], contador: $('fav-counter').textContent };

  // 7º favorito (misto) bloqueado na UI com mensagem
  fav({ name: 'Extra 1', type: 'entrada', position: 9 });
  await UI.openManage(); await tick(40);
  out.cheio = { contador: $('fav-counter').textContent, addDesab: $('fav-add').disabled, ajuda: $('fav-add-help').textContent, ajudaVisivel: !$('fav-add-help').classList.contains('hidden') };
  const antesInserts = calls.insert.length;
  UI.openEdit(); $('fav-name').value = 'Sétimo'; $('fav-edit-save').click(); await tick(60);
  out.setimo = { erro: $('fav-edit-error').textContent, inseriu: calls.insert.length > antesInserts };
  UI.edit = null; UI._close('fav-edit'); 

  // K) sugestões: 3+ ocorrências em 60 dias (entrada e saída), ignora favoritas
  const hoje = Utils.todayLocal();
  for (let i = 0; i < 3; i++) TX.push({ id: 'sg' + i, type: 'saida', value: 5, description: 'Pão', category: 'Alimentação', date: hoje });
  for (let i = 0; i < 3; i++) TX.push({ id: 'sh' + i, type: 'entrada', value: 5, description: 'Pão', category: 'Outros', date: hoje });
  table.splice(0, table.length, ...table.filter(r => r.financa_id === F1.id).slice(0, 4)); await UI.openManage(); await tick(60);
  out.sugestoes = [...d.querySelectorAll('#fav-sugg-list .fav-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim());

  // L) XSS: nome/categoria maliciosos viram texto
  const XSS = '<img src=x onerror=window.__pwned=1>';
  table.splice(0, table.length); fav({ name: XSS, type: 'saida', category_id: CATS[0].id, position: 1 });
  App.categories[0].name = XSS;
  UI._close('fav-manage'); await home();
  d.querySelector('[data-fav-id]').click(); await tick(40);
  await UI.openManage(); await tick(40);
  UI._toast(`Lançado: ${XSS} x`, 'tx9');
  out.xss = { imgs: d.querySelectorAll('img[onerror]').length, pwned: !!w.__pwned, titulo: $('fav-panel-title').textContent };

  // M) métricas locais: favorito registrado
  out.metricas = get('Metrics').summary();
  console.log(JSON.stringify(out)); process.exit(0);
})().catch(e => { console.log(JSON.stringify({ erro: String(e && e.stack || e) })); process.exit(1); });
