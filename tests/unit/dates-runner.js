// Executado em processo filho com TZ=<fuso> pelo dates.test.js. Imprime JSON com os resultados dos cenários.
// Relógio simulado: Date() sem argumento devolve o instante em que o RELÓGIO DE PAREDE LOCAL é o pedido.
'use strict';
const { loadScripts } = require('./load');

const [y, mo, d, hh, mm] = process.argv[2].split(/\D+/).map(Number);   // "AAAA-MM-DD HH:MM" local
const FIXED = new Date(y, mo - 1, d, hh, mm, 0, 0).getTime();
class FakeDate extends Date {
  constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
  static now() { return FIXED; }
}
const { Utils, Storage, App } = loadScripts(['utils.js', 'storage.js', 'app.js'], ['Utils', 'Storage', 'App'], { Date: FakeDate });
const out = {};
const tent = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = 'ERRO: ' + e.message; } };

tent('todayLocal', () => Utils.todayLocal());
tent('monthKeyLocal', () => Utils.monthKeyLocal());
tent('localDateStr', () => Utils.localDateStr(new Date(2028, 1, 29, 23, 59)));
tent('parseDateLocal', () => { const p = Utils.parseDateLocal('2026-10-27'); return [p.getFullYear(), p.getMonth() + 1, p.getDate(), p.getHours()]; });
tent('monthEnd_bissexto', () => Utils.monthEndLocal('2028-02'));
tent('monthEnd_nao_bissexto', () => Utils.monthEndLocal('2027-02'));
tent('monthEnd_dez', () => Utils.monthEndLocal('2026-12'));
tent('appCurrentMonth', () => App.currentMonth);
tent('localAddDefaultDate', () => { const t = {}; Storage._localGet = () => ({ transactions: [], financas: [] }); Storage._localSave = () => {}; Storage._localAdd(t); return t.date; });
tent('formatHoje', () => App.formatDateGroup(Utils.todayLocal()));
tent('formatOntem', () => App.formatDateGroup(Utils.localDateStr(new Date(y, mo - 1, d - 1))));
tent('addMonths_31jan', () => App._addMonths('2026-01-31', 1));
tent('addMonths_bissexto', () => App._addMonths('2028-01-31', 1));
tent('addMonths_virada_ano', () => App._addMonths('2026-12-15', 1));
tent('parseImport_vazio', () => App._parseImportDate(''));
console.log(JSON.stringify(out));
