#!/usr/bin/env node
// Calcula os hashes (sha256) dos <script> inline e dos atributos on*= do index.html para a CSP (script-src com hashes
// em vez de 'unsafe-inline'). Usado pelo teste tests/static/csp.test.js: se alguém editar um handler/bloco inline sem atualizar
// a <meta> da CSP, o teste falha (e o app quebraria). Uso: node scripts/csp-hashes.js  → imprime os hashes atuais.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sha = s => "'sha256-" + crypto.createHash('sha256').update(s, 'utf8').digest('base64') + "'";
const decode = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function inventario(html) {
  const scriptsInline = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const handlers = [...html.matchAll(/\s(on[a-z]+)="([^"]*)"/gi)].map(m => ({ attr: m[1].toLowerCase(), code: decode(m[2]) }));
  const styleAttrs = (html.match(/\sstyle="/g) || []).length;
  const styleBlocks = (html.match(/<style\b/gi) || []).length;
  return {
    scriptsInline, handlers, styleAttrs, styleBlocks,
    hashesScripts: [...new Set(scriptsInline.map(sha))],
    hashesHandlers: [...new Set(handlers.map(h => sha(h.code)))],
  };
}
module.exports = { inventario, sha };

if (require.main === module) {
  const inv = inventario(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
  console.log(`<script> inline: ${inv.scriptsInline.length} | handlers on*=: ${inv.handlers.length} | <style>: ${inv.styleBlocks} | style="": ${inv.styleAttrs}`);
  console.log('hashes de scripts:', inv.hashesScripts.join(' '));
  console.log('hashes de handlers:', inv.hashesHandlers.join(' '));
}
