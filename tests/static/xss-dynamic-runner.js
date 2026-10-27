// Executado em processo filho (jsdom deixa timers do app vivos; assim o runner de testes não é afetado).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '..', '..');
const PAYLOAD = '<img src=x onerror=window.__pwned=1>';
const ATTR = '"><img src=x onerror=window.__pwned=1>';

function boot() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  w.Chart = function () { return { destroy() {}, update() {} }; };
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
  const ctx = dom.getInternalVMContext();
  // scripts separados no mesmo contexto: o `const App/Storage` do topo fica no escopo global compartilhado
  for (const f of ['utils.js', 'storage.js', 'nlp.js', 'insights.js', 'app.js']) new vm.Script(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), { filename: f }).runInContext(ctx);
  new vm.Script("var Auth = { user: { id: 'me', email: 'me@x.com' } };").runInContext(ctx);
  const get = n => new vm.Script(n).runInContext(ctx);
  return { w, App: get('App'), Storage: get('Storage') };
}
const alvo = (w, sel) => !!w.document.querySelector(sel);

const CASOS = [
  { id: 'XSS-D1', onde: 'Seletor de carteira (openFinancaSelectModal) — nome da carteira', run: ({ w, App }) => {
      App.financas = [{ id: 'f1', name: PAYLOAD, emoji: '💰', type: 'compartilhada' }]; App.openFinancaSelectModal(() => {});
      return alvo(w, '#financa-select-list img[onerror]'); } },
  { id: 'XSS-D2', onde: 'Botões rápidos de categoria (renderQuickButtons) — nome da categoria', run: ({ w, App }) => {
      App.categories = [{ id: 'c1', name: PAYLOAD, emoji: '📦', type: 'saida', keywords: [] }]; App.renderQuickButtons();
      return alvo(w, '#quick-cats-grid img[onerror]'); } },
  { id: 'XSS-D3', onde: 'Gerenciar categorias (renderCategoryList) — nome da categoria', run: ({ w, App }) => {
      App.categories = [{ id: 'c1', name: PAYLOAD, emoji: '📦', type: 'saida', keywords: [] }]; App.renderCategoryList();
      return alvo(w, 'img[onerror]'); } },
  { id: 'XSS-D4', onde: 'Lembretes na Home (renderRemindersHome) — nome do lembrete (criado por qualquer membro)', run: ({ w, App }) => {
      const hoje = new Date();
      App.reminders = [{ id: 'r1', name: PAYLOAD, emoji: '🔔', day: hoje.getDate(), type: 'saida', amount: 10, notify_time: null, category: 'Outros' }];
      App.renderRemindersHome(); return alvo(w, 'img[onerror]'); } },
  { id: 'XSS-D5', onde: 'Resumo por pessoa (renderPersonBreakdown) — "Inserido por" importado do Excel', run: ({ w, App, Storage }) => {
      Storage.getBehavior = () => 'subtrai'; Storage.isNoPerson = () => false;
      App.renderPersonBreakdown([{ id: 't1', type: 'saida', value: 10, category: 'Outros', description: 'x', date: '2026-10-01', inserted_by_email: ATTR }]);
      return alvo(w, '#person-breakdown img[onerror]'); } },
  { id: 'XSS-D6', onde: 'Detalhe do lançamento do lembrete (openReminderTxnModal) — observação (notes) do lançamento', run: ({ w, App }) => {
      App.openReminderTxnModal({ id: 'r1', name: 'Luz', emoji: '💡', day: 5 }, { id: 't1', value: 10, type: 'saida', category: 'Outros', description: 'd', notes: PAYLOAD, date: '2026-10-01' });
      return alvo(w, '#reminder-txn-modal img[onerror], img[onerror]'); } },
  { id: 'XSS-D7', onde: 'Lista de membros do modal (renderMembersList) — e-mail do membro', run: async ({ w, App, Storage }) => {
      Storage.getMembers = async () => [{ id: 'm1', user_id: 'u9', email: PAYLOAD, role: 'membro' }]; Storage.getPendingInvites = async () => [];
      await App.renderMembersList('f1'); return alvo(w, '#members-list img[onerror]'); } },
  { id: 'XSS-D8', onde: 'Campo emoji da categoria (renderQuickButtons)', run: ({ w, App }) => {
      App.categories = [{ id: 'c1', name: 'Ok', emoji: PAYLOAD, type: 'saida', keywords: [] }]; App.renderQuickButtons();
      return alvo(w, '#quick-cats-grid img[onerror]'); } },
  { id: 'XSS-D9', onde: 'Aspas em atributos (nome da categoria com " e \')', run: ({ w, App }) => {
      App.categories = [{ id: 'c1', name: `x" onmouseover="window.__pwned=1" '"x`, emoji: '📦', type: 'saida', keywords: [] }]; App.renderQuickButtons();
      return alvo(w, '#quick-cats-grid [onmouseover]'); } },
  { id: 'XSS-D10', onde: 'Emoji do lembrete (renderRemindersHome)', run: ({ w, App }) => {
      App.reminders = [{ id: 'r1', name: 'ok', emoji: PAYLOAD, day: new Date().getDate(), type: 'saida', amount: 10, category: 'Outros' }];
      App.renderRemindersHome(); return alvo(w, 'img[onerror]'); } },
];

(async () => {
  const out = [];
  for (const c of CASOS) {
    const env = boot();
    let explorado = false, erro = '';
    try { explorado = await c.run(env); } catch (e) { erro = e.message.split('\n')[0]; }
    out.push({ id: c.id, onde: c.onde, explorado, erro });
    env.w.close();
  }
  process.stdout.write('@@' + JSON.stringify(out));
  process.exit(0);
})();
