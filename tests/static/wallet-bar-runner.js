// Executado em processo filho (jsdom deixa timers do app vivos). Imprime JSON com os resultados dos cenários da barra de carteira.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '..', '..');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window, d = w.document;
w.Chart = function () { return { destroy() {}, update() {} }; };
w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
const ctx = dom.getInternalVMContext();
for (const f of ['utils.js', 'storage.js', 'nlp.js', 'insights.js', 'app.js']) new vm.Script(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), { filename: f }).runInContext(ctx);
new vm.Script("var Auth = { user: { id: 'me', email: 'ana@exemplo.com' }, init: () => new Promise(() => {}) };   // App.init (DOMContentLoaded) fica parado aqui").runInContext(ctx);
const get = n => new vm.Script(n).runInContext(ctx);
const App = get('App'), Storage = get('Storage'), Utils = get('Utils');

const out = {};
const txt = id => d.getElementById(id).textContent;
const bar = () => d.getElementById('wallet-bar');
const snap = () => ({ state: bar().dataset.state, nome: txt('wallet-bar-name'), label: txt('wallet-bar-label'), chip: d.getElementById('wallet-bar-chip').textContent.trim(), chipKind: d.getElementById('wallet-bar-chip').dataset.kind, cor: bar().style.getPropertyValue('--wallet-accent'), aria: bar().getAttribute('aria-label'), titulo: d.title });
const tick = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // estrutura
  const abas = [...d.querySelectorAll('.tab-page')].map(e => e.id);
  out.estrutura = {
    barras: d.querySelectorAll('#wallet-bar').length,
    ehButton: bar().tagName === 'BUTTON',
    pilulaAntiga: !!d.getElementById('financa-switcher'),
    primeiroFilhoDoApp: d.getElementById('main-app').firstElementChild.id,
    dentroDeAba: !!bar().closest('.tab-page'),
    abas,
    antesDasAbas: abas.every(id => bar().compareDocumentPosition(d.getElementById(id)) & w.Node.DOCUMENT_POSITION_FOLLOWING),
    toggleInvest: d.getElementById('inv-seg-carteira').textContent.trim(), toggleCofrinhos: d.getElementById('inv-seg-cofrinhos').textContent.trim(),
  };

  // carregando (antes de loadFinancas)
  const sk = d.querySelector('#wallet-bar .wb-skel');
  App.renderFinancaSwitcher();
  out.carregando = { ...snap(), skelRole: sk.getAttribute('role'), skelAria: sk.getAttribute('aria-label') };

  // nenhuma carteira
  App._financasLoaded = true; App.activeFinanca = null; App.renderFinancaSwitcher();
  out.vazio = snap();

  // carteiras: A individual (1 membro) · B "Família" criada como INDIVIDUAL que recebeu membros (2) · C compartilhada com 1 · D nome malicioso · L nome longo
  const A = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Pessoal', emoji: '💼', type: 'individual', owner_id: 'me' };
  const B = { id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'Família', emoji: '🏠', type: 'individual', owner_id: 'me' };
  const C = { id: 'cccccccc-0000-4000-8000-000000000003', name: 'Viagem', emoji: '✈️', type: 'compartilhada', owner_id: 'me' };
  const D = { id: 'dddddddd-0000-4000-8000-000000000004', name: '<img src=x onerror=window.__pwned=1>', emoji: '📦', type: 'individual', owner_id: 'me' };
  const L = { id: 'eeeeeeee-0000-4000-8000-000000000005', name: 'Carteira com um nome extremamente longo que não cabe em nenhuma tela de celular pequena', emoji: '📚', type: 'individual', owner_id: 'me' };
  App.financas = [A, B, C, D, L];
  Object.defineProperty(Storage, 'isCloud', { get: () => true });
  // "banco" simulado: linhas de financa_members e convites; Storage.db responde às consultas reais do Storage
  const membros = [[A, 'me', 'admin'], [B, 'me', 'admin'], [B, 'kaira', 'membro'], [C, 'me', 'admin'], [D, 'me', 'admin'], [L, 'me', 'admin']].map(([f, u, r], i) => ({ id: 'm' + i, financa_id: f.id, user_id: u, role: r }));
  let convites = [{ financa_id: B.id }];
  let falhar = false, gate = null, consultasMembros = 0;
  Object.defineProperty(Storage, 'db', { configurable: true, value: { from: tab => ({
    select: () => ({ limit: async () => {
        if (tab === 'financa_members') { consultasMembros++; if (gate) await gate; if (falhar) return { data: null, error: { message: 'boom' } }; return { data: membros.map(m => ({ ...m })), error: null }; }
        return { data: convites, error: null };
      }, is: () => ({ limit: async () => ({ data: convites, error: null }) }) }),
    delete: () => ({ eq: (c1, v1) => ({ eq: async (c2, v2) => { const i = membros.findIndex(m => m.id === v1 && m.financa_id === v2); if (i >= 0) membros.splice(i, 1); return { error: null }; } }) }),
  }) } });
  Storage.userId = () => 'me';
  Storage.getMembers = async fid => membros.filter(m => m.financa_id === fid).map(m => ({ ...m, email: `${m.user_id}@exemplo.com` }));
  Storage.getPendingInvites = async () => [];
  Storage.syncCustomTypesFromCloud = async () => {};
  App.loadCategories = async () => {}; App.loadReminders = async () => {}; App.loadTransactionTypes = async () => {};
  App._warmOfflineCache = () => {}; App.renderHome = async () => {};
  const renders = [];
  App.renderCurrentTab = async () => { renders.push({ aba: App.currentTab, mes: App.currentMonth }); };
  const chipTxt = () => d.getElementById('wallet-bar-chip').textContent.replace(/\s+/g, ' ').trim();
  const linhasLista = () => Object.fromEntries([...d.querySelectorAll('#financa-list [data-financa-select]')].map(l => [l.dataset.financaSelect, { chip: l.querySelector('.wallet-chip')?.textContent.replace(/\s+/g, ' ').trim() || '', skel: !!l.querySelector('.wallet-skel'), convite: l.querySelector('.wallet-invite')?.textContent.trim() || '' }]));

  // ── contagem AINDA NÃO carregada: esqueleto; nunca "Só você" por padrão (mesmo sendo type=individual)
  let abrir; gate = new Promise(r => { abrir = r; });
  App.activeFinanca = B; App._wc = { state: 'idle', counts: {}, admin: {}, invites: {}, seq: 0 };
  App.renderFinancaSwitcher();                       // dispara a 1ª consulta (parada no gate)
  App.openFinancaModal();
  out.carregandoContagem = { barra: snap(), chipTexto: chipTxt(), lista: linhasLista()[B.id], consultas: consultasMembros };
  abrir(); gate = null; await tick(30);
  out.contagemCarregada = { barra: snap(), lista: linhasLista(), consultas: consultasMembros, select: (() => { App.openFinancaSelectModal(() => {}); return [...d.querySelectorAll('#financa-select-list .financa-select-item')].map(b => b.querySelector('p.text-xs').textContent.trim()); })() };
  App.closeFinancaSelectModal(); App.closeFinancaModal();
  App._modalFinancaId = B.id; App._renderModalFinancaPicker();
  out.tipoNosRotulos = { novoLancamento: txt('modal-financa-type'), importar: (App.activeFinanca = B, App._renderImportFinancaBanner(), txt('import-financa-type')) };

  // ── "Só você" para 1 membro; individual
  App.activeFinanca = A; App.renderFinancaSwitcher(); out.individual = { ...snap(), corEsperada: Utils.walletColor(A.id) };
  App.activeFinanca = C; App.renderFinancaSwitcher(); out.umMembro = snap();     // type=compartilhada com 1 membro → "Só você"
  App.activeFinanca = B; App.renderFinancaSwitcher(); out.doisMembros = { ...snap(), corEsperada: Utils.walletColor(B.id) };

  // barra visível em todas as abas
  out.abas = [];
  for (const t of ['home', 'history', 'summary', 'investments']) {
    await App.switchTab(t);
    let el = bar(), oculto = false; while (el && el.id !== 'main-app') { if (el.classList?.contains('hidden')) oculto = true; el = el.parentElement; }   // (o #main-app fica oculto no jsdom por não haver login)
    out.abas.push({ aba: t, abaVisivel: !d.getElementById('tab-' + t).classList.contains('hidden'), barraOculta: oculto });
  }

  // ── convites pendentes: "· 1 convite" só no painel de troca (admin), nunca na barra; não contam como membros
  App.activeFinanca = B; App.renderFinancaSwitcher(); App.openFinancaModal();
  out.convites = { lista: linhasLista()[B.id], barra: chipTxt(), outraCarteira: linhasLista()[A.id].convite };
  App.closeFinancaModal();

  // ── trocar de carteira pela lista (mês mantido; recarrega a contagem)
  App.activeFinanca = A; App.renderFinancaSwitcher();
  App.currentMonth = '2026-03'; App.currentTab = 'history'; renders.length = 0;
  const consultasAntes = consultasMembros;
  App.openFinancaModal();
  const linhas = [...d.querySelectorAll('#financa-list [data-financa-select]')];
  out.lista = {
    titulo: txt('financa-modal-title'), linhas: linhas.length,
    ativa: linhas.filter(l => l.querySelector('.wallet-badge-active')).map(l => l.dataset.financaSelect),
    botoes: { fechar: d.getElementById('financa-modal-close').textContent.trim(), nova: d.getElementById('financa-create-btn').textContent.trim() },
    corLinhaB: linhas[1].style.getPropertyValue('--wallet-accent'), chipB: linhasLista()[B.id].chip,
    imgs: d.querySelectorAll('#financa-list img[onerror]').length,
  };
  linhas[1].click(); await tick(60);
  out.troca = { ...snap(), corEsperada: Utils.walletColor(B.id), mes: App.currentMonth, renders, ativa: App.activeFinanca.id === B.id, modalFechado: d.getElementById('financa-modal').classList.contains('hidden'),
    recarregouContagem: consultasMembros > consultasAntes,
    toast: { texto: txt('wallet-toast-text'), role: d.getElementById('wallet-toast').getAttribute('role'), visivel: !d.getElementById('wallet-toast').classList.contains('hidden'), ponto: d.getElementById('wallet-toast').style.getPropertyValue('--wallet-accent') } };
  await tick(2950);
  out.troca.toastSumiu = d.getElementById('wallet-toast').classList.contains('hidden');

  // ── remover um membro (Storage.removeMember real) → o chip passa a "Só você" SEM recarregar a página, na barra e na lista
  App.openFinancaModal();
  const antes = { barra: chipTxt(), lista: linhasLista()[B.id].chip };
  await Storage.removeMember(B.id, 'm2'); await tick(40);
  out.removerMembro = { antes, depois: { barra: chipTxt(), lista: linhasLista()[B.id].chip, kind: d.getElementById('wallet-bar-chip').dataset.kind } };
  // adicionar de volta (convite aceito → Storage.acceptInvite real) → volta a "Compartilhada · 2"
  Storage.db.rpc = async () => { membros.push({ id: 'm9', financa_id: B.id, user_id: 'kaira', role: 'membro' }); return { error: null }; };
  await Storage.acceptInvite('i1', B.id); await tick(40);
  out.aceitarConvite = { barra: chipTxt(), lista: linhasLista()[B.id].chip };
  App.closeFinancaModal();

  // ── falha ao carregar a contagem: chip OCULTO, sem texto errado
  falhar = true; await App.invalidateWalletMembers(); App.activeFinanca = B; App.renderFinancaSwitcher(); App.openFinancaModal();
  out.falha = { chipKind: d.getElementById('wallet-bar-chip').dataset.kind, chipTexto: chipTxt(), barra: snap().aria, lista: linhasLista()[B.id].chip };
  App.closeFinancaModal(); falhar = false; await App.invalidateWalletMembers();

  // ── uma única consulta de financa_members por carga (e contagem correta)
  const antesC = consultasMembros; const r = await Storage.getMemberCounts();
  out.consultaUnica = { consultas: consultasMembros - antesC, contagem: r.counts, admin: r.admin };

  // offline
  Object.defineProperty(w.navigator, 'onLine', { value: false, configurable: true });
  App.activeFinanca = A; App.renderFinancaSwitcher(); out.offline = snap();
  Object.defineProperty(w.navigator, 'onLine', { value: true, configurable: true });

  // nome malicioso e nome longo
  App.activeFinanca = D; App.renderFinancaSwitcher(); App.announceWallet(D); App.openFinancaModal();
  out.xss = { barra: snap(), imgs: d.querySelectorAll('img[onerror]').length, pwned: !!w.__pwned, toast: txt('wallet-toast-text') };
  App.activeFinanca = L; App.renderFinancaSwitcher();
  out.longo = snap();
  out.arquivo = { slug: Utils.slugFile('Família 2026 ✈️'), vazio: Utils.slugFile('✈️'), longo: Utils.slugFile(L.name).length };
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch(e => { console.log(JSON.stringify({ erro: String(e && e.stack || e) })); process.exit(1); });
