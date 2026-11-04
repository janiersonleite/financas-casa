// U2/T1: cor estável por carteira (hash do id), 8 cores, nunca verde nem vermelho (verde/vermelho = entrada/saída).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadScripts } = require('./load');
const { Utils } = loadScripts(['utils.js'], ['Utils']);

const hue = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };

test('walletColor: estável para o mesmo id e só devolve cores da paleta de 8', () => {
  assert.equal(Utils.WALLET_COLORS.length, 8);
  const id = crypto.randomUUID();
  assert.equal(Utils.walletColor(id), Utils.walletColor(id));
  assert.equal(Utils.walletColor(id), Utils.walletColor(String(id)));
  for (let i = 0; i < 200; i++) assert.ok(Utils.WALLET_COLORS.includes(Utils.walletColor(crypto.randomUUID())));
  assert.ok(Utils.WALLET_COLORS.includes(Utils.walletColor(null)) && Utils.WALLET_COLORS.includes(Utils.walletColor(undefined)));
});

test('walletColor: nunca verde (≈75°–165°) nem vermelho (≈345°–15°) — checado em toda a paleta', () => {
  for (const c of Utils.WALLET_COLORS) {
    const h = hue(c);
    assert.ok(!(h >= 75 && h <= 165), `${c} é verde (matiz ${h.toFixed(0)}°)`);
    assert.ok(!(h >= 345 || h <= 15), `${c} é vermelho (matiz ${h.toFixed(0)}°)`);
  }
  assert.equal(new Set(Utils.WALLET_COLORS).size, 8, 'cores repetidas na paleta');
});

test('walletColor: distribui nas 8 cores (1000 ids, nenhuma cor fica de fora nem domina)', () => {
  const cont = Object.fromEntries(Utils.WALLET_COLORS.map(c => [c, 0]));
  for (let i = 0; i < 1000; i++) cont[Utils.walletColor(crypto.randomUUID())]++;
  for (const [c, n] of Object.entries(cont)) assert.ok(n > 60 && n < 200, `${c}: ${n}/1000`);
});

test('paleta tem contraste AA (≥3:1 para elementos gráficos) sobre o fundo #06241a', () => {
  const L = lum('#06241a');
  for (const c of Utils.WALLET_COLORS) assert.ok((lum(c) + 0.05) / (L + 0.05) >= 3, `${c} contraste baixo`);
});
