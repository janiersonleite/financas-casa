#!/usr/bin/env node
// Compara capturas "cdn" (antes) × "build" (depois) por diferença de pixels e monta imagens lado a lado (antes | depois | diferença).
//   node scripts/visual/compare.js <dir-cdn> <dir-build> <dir-saida>      (LIBS_DIR com pixelmatch e pngjs)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const LIBS = process.env.LIBS_DIR;
const { PNG } = require(path.join(LIBS, 'node_modules/pngjs'));
const pixelmatch = require(path.join(LIBS, 'node_modules/pixelmatch'));
const [A, B, OUT] = process.argv.slice(2).map(p => path.resolve(p));
const TOL_PCT = Number(process.env.TOL_PCT || 0.05);   // % de pixels diferentes tolerado por captura
fs.mkdirSync(OUT, { recursive: true });
const rd = f => PNG.sync.read(fs.readFileSync(f));
const rows = []; let reprovadas = 0;
for (const f of fs.readdirSync(A).filter(n => n.endsWith('.png')).sort()) {
  if (!fs.existsSync(path.join(B, f))) { rows.push({ f, erro: 'sem captura "depois"' }); reprovadas++; continue; }
  const a = rd(path.join(A, f)), b = rd(path.join(B, f));
  if (a.width !== b.width || a.height !== b.height) { rows.push({ f, erro: 'tamanhos diferentes' }); reprovadas++; continue; }
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  const pct = +(100 * n / (a.width * a.height)).toFixed(4);
  const ok = pct <= TOL_PCT; if (!ok) reprovadas++;
  rows.push({ f, pixels: n, pct, ok });
  // lado a lado: antes | depois | diferença
  const W = a.width, H = a.height, gap = 8, out = new PNG({ width: W * 3 + gap * 2, height: H });
  out.data.fill(255);
  const blit = (src, x0) => PNG.bitblt(src, out, 0, 0, W, H, x0, 0);
  blit(a, 0); blit(b, W + gap); blit(diff, 2 * (W + gap));
  if (!ok || process.env.ALL_SIDE_BY_SIDE) fs.writeFileSync(path.join(OUT, f.replace('.png', '.lado-a-lado.png')), PNG.sync.write(out));
}
fs.writeFileSync(path.join(OUT, 'comparacao.json'), JSON.stringify({ tolerancia_pct: TOL_PCT, reprovadas, rows }, null, 1));
for (const r of rows) console.log(`${r.ok ? 'OK ' : 'DIF'} ${r.f.padEnd(40)} ${r.erro || r.pct + '%  (' + r.pixels + ' px)'}`);
console.log(`\n${rows.length} capturas | reprovadas: ${reprovadas} | tolerância ${TOL_PCT}%`);
process.exit(reprovadas ? 1 : 0);
