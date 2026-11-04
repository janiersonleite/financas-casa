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

  // carteiras A (individual) e B (compartilhada, 3 membros) + C (compartilhada, 1 membro) + D (nome malicioso)
  const A = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Pessoal', emoji: '💼', type: 'individual', owner_id: 'me' };
  const B = { id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'Família', emoji: '🏠', type: 'compartilhada', owner_id: 'me' };
  const C = { id: 'cccccccc-0000-4000-8000-000000000003', name: 'Viagem', emoji: '✈️', type: 'compartilhada', owner_id: 'me' };
  const D = { id: 'dddddddd-0000-4000-8000-000000000004', name: '<img src=x onerror=window.__pwned=1>', emoji: '📦', type: 'individual', owner_id: 'me' };
  const L = { id: 'eeeeeeee-0000-4000-8000-000000000005', name: 'Carteira com um nome extremamente longo que não cabe em nenhuma tela de celular pequena', emoji: '📚', type: 'individual', owner_id: 'me' };
  App.financas = [A, B, C, D, L];
  App._walletMembers[B.id] = 3; App._walletMembers[C.id] = 1;
  Object.defineProperty(Storage, 'isCloud', { get: () => true });
  Storage.getMembers = async fid => Array.from({ length: fid === B.id ? 3 : 1 }, (_, i) => ({ id: 'm' + i, user_id: 'u' + i, email: `u${i}@exemplo.com`, role: 'membro' }));
  Storage.getPendingInvites = async () => [];
  Storage.syncCustomTypesFromCloud = async () => {};
  App.loadCategories = async () => {}; App.loadReminders = async () => {}; App.loadTransactionTypes = async () => {};
  App._warmOfflineCache = () => {}; App.renderHome = async () => {};
  const renders = [];
  App.renderCurrentTab = async () => { renders.push({ aba: App.currentTab, mes: App.currentMonth }); };

  App.activeFinanca = A; App.renderFinancaSwitcher();
  out.individual = { ...snap(), corEsperada: Utils.walletColor(A.id) };

  // barra visível em todas as abas
  out.abas = [];
  for (const t of ['home', 'history', 'summary', 'investments']) {
    await App.switchTab(t);
    let el = bar(), oculto = false; while (el && el.id !== 'main-app') { if (el.classList?.contains('hidden')) oculto = true; el = el.parentElement; }   // (o #main-app fica oculto no jsdom por não haver login)
    out.abas.push({ aba: t, abaVisivel: !d.getElementById('tab-' + t).classList.contains('hidden'), barraOculta: oculto });
  }

  // trocar de carteira pela lista (mês mantido)
  App.currentMonth = '2026-03'; App.currentTab = 'history'; renders.length = 0;
  App.openFinancaModal();
  const linhas = [...d.querySelectorAll('#financa-list [data-financa-select]')];
  out.lista = {
    titulo: txt('financa-modal-title'), linhas: linhas.length,
    ativa: linhas.filter(l => l.querySelector('.wallet-badge-active')).map(l => l.dataset.financaSelect),
    botoes: { fechar: d.getElementById('financa-modal-close').textContent.trim(), nova: d.getElementById('financa-create-btn').textContent.trim() },
    corLinhaB: linhas[1].style.getPropertyValue('--wallet-accent'), chipB: linhas[1].querySelector('.wallet-chip').textContent.trim(),
    imgs: d.querySelectorAll('#financa-list img[onerror]').length,
  };
  linhas[1].click(); await tick(60);
  out.troca = { ...snap(), corEsperada: Utils.walletColor(B.id), mes: App.currentMonth, renders, ativa: App.activeFinanca.id === B.id, modalFechado: d.getElementById('financa-modal').classList.contains('hidden'),
    toast: { texto: txt('wallet-toast-text'), role: d.getElementById('wallet-toast').getAttribute('role'), visivel: !d.getElementById('wallet-toast').classList.contains('hidden'), ponto: d.getElementById('wallet-toast').style.getPropertyValue('--wallet-accent') } };
  await tick(2950);
  out.troca.toastSumiu = d.getElementById('wallet-toast').classList.contains('hidden');

  // 1 membro => "Só você"
  App.activeFinanca = C; App.renderFinancaSwitcher(); out.umMembro = snap();

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
