// Executado em processo filho: atalho do ícone (?action=) no jsdom. Uso: node launch-action-runner.js "<url>" "<logado: 1|0>"
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '..', '..');
const [url, logado] = [process.argv[2], process.argv[3] === '1'];
const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), { runScripts: 'outside-only', pretendToBeVisual: true, url });
const w = dom.window;
w.Chart = function () { return { destroy() {}, update() {} }; };
w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
const ctx = dom.getInternalVMContext();
new vm.Script("var IS_SUPABASE_CONFIGURED = true; var Auth = { user: null, init: () => new Promise(() => {}) }; var PushNotif = { syncSoon() {} };").runInContext(ctx);
for (const f of ['utils.js', 'storage.js', 'nlp.js', 'insights.js', 'metrics.js', 'favorites.js', 'favorites-ui.js', 'app.js']) new vm.Script(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), { filename: f }).runInContext(ctx);
const get = n => new vm.Script(n).runInContext(ctx);
const App = get('App'), Auth = get('Auth');
const chamadas = [];
App.openModal = async d => { chamadas.push(['openModal', d]); };
App.switchTab = async t => { chamadas.push(['switchTab', t]); };
const pend = () => w.sessionStorage.getItem('pending_action');
const out = { urlInicial: w.location.search };
App._captureLaunchAction();
out.guardado = pend(); out.urlAposCaptura = w.location.search;
App._financasLoaded = false; Auth.user = logado ? { id: 'me' } : null;
App.runPendingAction();
out.antesDasCarteiras = { chamadas: chamadas.length, pendente: pend() };           // carteiras ainda não carregaram: não executa
App._financasLoaded = true; App.runPendingAction();
out.depoisCarteiras = { chamadas: JSON.parse(JSON.stringify(chamadas)), pendente: pend(), urlFinal: w.location.search + w.location.hash };
if (!logado) { Auth.user = { id: 'me' }; App.runPendingAction(); out.depoisLogin = { chamadas: JSON.parse(JSON.stringify(chamadas)), pendente: pend(), urlFinal: w.location.search }; }
out.metrica = get('Metrics')._cur ? get('Metrics')._cur.method : null;
console.log(JSON.stringify(out)); process.exit(0);
