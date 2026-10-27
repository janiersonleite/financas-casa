// Coletor de achados: os testes "de segurança" não quebram o runner quando
// confirmam uma falha — registram o resultado e imprimem uma linha [BUG-CONFIRMADO]
// / [NAO-CONFIRMADO] / [PARCIAL] / [INFO] (também gravada em tests/_out/*.json).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.join(__dirname, '_out');

function createCollector(file) {
  const items = [];
  return {
    add(id, status, titulo, evidencia = '') {
      items.push({ id, status, titulo, evidencia });
      const tag = { CORRIGIDO: '[CORRIGIDO]', ADIADO: '[ADIADO]', CONFIRMADO: '[BUG-CONFIRMADO]', 'NAO CONFIRMADO': '[NAO-CONFIRMADO]', PARCIAL: '[PARCIAL]', INFO: '[INFO]' }[status] || `[${status}]`;
      console.log(`    ${tag} ${id} — ${titulo}${evidencia ? '  ::  ' + evidencia : ''}`);
    },
    flush() {
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, file), JSON.stringify(items, null, 2));
    },
    items
  };
}
module.exports = { createCollector };
