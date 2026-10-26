// Confere, NA REDE (CDN real), que cada <script src="https://..."> de index.html com integrity
// tem exatamente o hash declarado. Rodar em CI e antes de publicar: `npm run verify:sri`.
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const tags = [...html.matchAll(/<script\b[^>]*\bsrc="(https:[^"]+)"[^>]*>/g)].map(m => ({ url: m[1], tag: m[0] }));
(async () => {
  let bad = 0;
  for (const { url, tag } of tags) {
    const m = /integrity="(sha(?:256|384|512))-([^"]+)"/.exec(tag);
    if (!m) { console.log(`PULADO (sem SRI): ${url}`); continue; }
    const r = await fetch(url);
    if (!r.ok) { console.log(`FALHA ${r.status}: ${url}`); bad++; continue; }
    const h = crypto.createHash(m[1]).update(Buffer.from(await r.arrayBuffer())).digest('base64');
    const ok = h === m[2];
    console.log(`${ok ? 'OK   ' : 'ERRO '} ${url}${ok ? '' : `\n      declarado: ${m[1]}-${m[2]}\n      real:      ${m[1]}-${h}`}`);
    if (!ok) bad++;
  }
  process.exit(bad ? 1 : 0);
})();
