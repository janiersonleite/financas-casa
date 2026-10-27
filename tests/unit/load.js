// Carrega os scripts globais do front (sem build) dentro de node:vm, sem alterá-los.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..', '..');

/** Executa js/<arquivo> num contexto isolado e devolve os globais pedidos. */
function loadScripts(files, globals, extra = {}) {
  const store = {};
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, Date, Math, JSON, Intl, Promise,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    window: {}, document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    navigator: { onLine: true, userAgent: 'node' }, location: { hash: '', href: 'http://localhost/', origin: 'http://localhost' },
    ...extra
  });
  ctx.window = ctx;
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f });
  // `const X = {...}` no topo de script não vira propriedade do contexto → lê via runInContext
  return Object.fromEntries(globals.map(g => [g, vm.runInContext(`typeof ${g} !== 'undefined' ? ${g} : undefined`, ctx)]));
}
module.exports = { loadScripts, ROOT };
