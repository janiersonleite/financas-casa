// Executado em processo filho (jsdom). Tela inicial com "ocultar valores" ligado/desligado.
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
for (const f of ['utils.js', 'storage.js', 'nlp.js', 'insights.js', 'app.js']) new vm.Script(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), { filename: f }).runInContext(ctx);
new vm.Script("var Auth = { user: { id: 'me', email: 'ana@exemplo.com' }, init: () => new Promise(() => {}) }; var PushNotif = { syncSoon() {} };").runInContext(ctx);
const App = new vm.Script('App').runInContext(ctx), Storage = new vm.Script('Storage').runInContext(ctx);

const TX = [
  { id: 't1', type: 'saida', value: 6278.23, category: 'Moradia', description: 'Aluguel', date: '2026-10-06', created_at: '2026-10-06T10:00:00Z' },
  { id: 't2', type: 'saida', value: 100, category: 'Lazer', description: 'Notebook (1/3)', date: '2026-10-07', created_at: '2026-10-07T10:00:00Z', installment_group_id: 'g1', installment_current: 1, installment_total: 3 },
];
Storage.getSummary = async () => ({ balance: -6378.23, income: 0, expense: 6378.23 });
Storage.getTransactions = async () => TX.map(t => ({ ...t }));
App.loadReminders = async () => {}; App._retroLearn = () => {}; App.renderQuickButtons = () => {};
App.reminders = [{ id: 'r1', name: 'Luz', emoji: '💡', day: 20, amount: 210.5, type: 'saida', active: true, category: 'Moradia' }];
const out = {};
const home = () => ({ saldo: d.getElementById('balance').textContent, saldoClasse: d.getElementById('balance').className, entradas: d.getElementById('total-income').textContent, saidas: d.getElementById('total-expense').textContent,
  lista: d.getElementById('home-transactions').textContent, lembretes: (d.getElementById('reminders-home-section') || d.body).textContent });
const btn = () => d.getElementById('hide-values-btn');
const ico = () => btn().innerHTML.includes('M1 1l22 22') ? 'olho-cortado' : 'olho';

(async () => {
  App.bindFinancaUI();
  out.botao = { existe: !!btn(), ehButton: btn().tagName === 'BUTTON', naHome: !!d.getElementById('tab-home').contains(btn()), pertoDoSaldo: /Saldo do mês/.test(btn().parentElement.textContent) };
  await App.renderHome();
  out.visivel = { ...home(), pressed: btn().getAttribute('aria-pressed'), rotulo: btn().getAttribute('aria-label'), icone: ico() };
  btn().click(); await new Promise(r => setTimeout(r, 50));
  out.oculto = { ...home(), pressed: btn().getAttribute('aria-pressed'), rotulo: btn().getAttribute('aria-label'), icone: ico(), guardado: w.localStorage.getItem('hide_values') };
  // outras telas não são afetadas: a lista do Histórico continua com os valores
  d.getElementById('history-transactions') && App.renderTransactionList('history-transactions', TX.map(t => ({ ...t })));
  out.historico = d.getElementById('history-transactions')?.textContent || '';
  // mudar de mês / recarregar a Home mantém oculto
  await App.renderHome(); out.apósRerender = home();
  btn().click(); await new Promise(r => setTimeout(r, 50));
  out.denovoVisivel = { ...home(), pressed: btn().getAttribute('aria-pressed'), guardado: w.localStorage.getItem('hide_values') };
  console.log(JSON.stringify(out)); process.exit(0);
})().catch(e => { console.log(JSON.stringify({ erro: String(e && e.stack || e) })); process.exit(1); });
