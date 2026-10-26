// Resume os achados gravados em tests/_out/*.json pelos testes (rodar depois de `npm test`).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '_out');
const all = [];
for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort() : []) {
  for (const it of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) all.push({ arquivo: f, ...it });
}
const por = all.reduce((a, x) => (a[x.status] = (a[x.status] || 0) + 1, a), {});
console.log('\n== Resumo dos achados ==');
console.log(por);
for (const x of all) console.log(`${x.status.padEnd(15)} ${x.id.padEnd(8)} ${x.titulo}`);
