// Mini-scanner de template literals (sem dependências): localiza `${...}` dentro de
// template literals com HTML e devolve cada interpolação com arquivo:linha.
'use strict';
const fs = require('node:fs');

/** Percorre o código e devolve os template literals (com interpolações e linha). */
function scanTemplates(src) {
  const out = [];
  let i = 0, line = 1;
  const n = src.length;
  const stack = [];                       // para templates aninhados dentro de ${ }
  function readTemplate(startLine) {
    // i está logo após a crase de abertura
    const t = { startLine, parts: [], interps: [] };
    let buf = '';
    while (i < n) {
      const c = src[i];
      if (c === '\\') { buf += c + (src[i + 1] || ''); if (src[i + 1] === '\n') line++; i += 2; continue; }
      if (c === '\n') line++;
      if (c === '`') { i++; t.parts.push(buf); out.push(t); return t; }
      if (c === '$' && src[i + 1] === '{') {
        t.parts.push(buf); buf = '';
        const iLine = line; i += 2;
        const start = i; let depth = 1;
        while (i < n && depth > 0) {
          const d = src[i];
          if (d === '\n') line++;
          if (d === '`') { i++; readTemplate(line); continue; }               // aninhado
          if (d === '"' || d === "'") { const q = d; i++; while (i < n && src[i] !== q) { if (src[i] === '\\') i++; if (src[i] === '\n') line++; i++; } i++; continue; }
          if (d === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
          if (d === '{') depth++;
          else if (d === '}') { depth--; if (depth === 0) break; }
          i++;
        }
        t.interps.push({ expr: src.slice(start, i), line: iLine });
        i++; continue;
      }
      buf += c; i++;
    }
    return t;
  }
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === '"' || c === "'") { const q = c; i++; while (i < n && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } i++; continue; }
    if (c === '/' && /[=(,:;!&|?{}\[]\s*$/.test(src.slice(Math.max(0, i - 3), i)) ) {   // literal de regex
      i++; let cls = false; while (i < n && src[i] !== '\n') { if (src[i] === '\\') { i += 2; continue; } if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; else if (src[i] === '/' && !cls) break; i++; } i++; continue;
    }
    if (c === '`') { i++; readTemplate(line); continue; }
    i++;
  }
  void stack;
  return out;
}

const HTMLISH = /<\/?[a-zA-Z][^>]*>?/;
const ESCAPERS = /(?:\b(?:this|App|Cofrinhos|Utils)\.)?\b(?:_escHtml|_esc|esc|escapeHtml|_hlText)\s*\(/g;
const SAFE_WRAPPERS = /\b(?:formatCurrency|formatDate|formatDateGroup|formatMonth\w*|_money|_fmt\w*|_pct\w*|Number|parseInt|parseFloat|Math\.\w+|toFixed|toLocaleString|_safeColor|JSON\.stringify|encodeURIComponent|String\(\s*(?:i|idx|index|n)\s*\))\b/;
const RISKY = /\b(?:name|nome|description|desc|note|notes|email|title|label|emoji|category|cat|text|msg|message|inserted_by_email|financa_name|financaName|bank|pix_key|keyword|keywords|author|inserter|member|user_name|display|sentence|s|e)\b/;

/** Remove do código da expressão as chamadas a funções de escape (parênteses balanceados). */
function stripEscaped(expr) {
  let s = expr, m;
  ESCAPERS.lastIndex = 0;
  for (;;) {
    ESCAPERS.lastIndex = 0; m = ESCAPERS.exec(s);
    if (!m) break;
    let j = m.index + m[0].length, depth = 1;
    while (j < s.length && depth > 0) { if (s[j] === '(') depth++; else if (s[j] === ')') depth--; j++; }
    s = s.slice(0, m.index) + '‹ESC›' + s.slice(j);
  }
  return s;
}

/** Interpolações potencialmente perigosas: texto livre sem escape, em template com HTML. */
function findCandidates(file) {
  const src = fs.readFileSync(file, 'utf8');
  const tpls = scanTemplates(src);
  const res = [];
  for (const t of tpls) {
    const text = t.parts.join('');
    if (!HTMLISH.test(text)) continue;                       // template sem HTML (mensagens, SQL, etc.)
    t.interps.forEach((it, idx) => {
      const before = t.parts[idx] || '';
      const stripped = stripEscaped(it.expr);
      // remove literais de texto dentro da expressão (ex.: ' · ', "<span>")
      const code = stripped.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''").replace(/`(?:\\.|[^`\\])*`/g, "''");
      if (!RISKY.test(code)) return;
      if (/^\s*(?:‹ESC›)\s*$/.test(code)) return;
      const sq = /='[^'"]*$/.test(before.slice(-200));       // dentro de atributo com aspa simples
      const sinkSafe = SAFE_WRAPPERS.test(code) && !/\b(?:name|description|note|email|title|label|emoji|text|msg|message)\b/.test(code.replace(SAFE_WRAPPERS, ''));
      if (sinkSafe) return;
      res.push({ file: file.split('/').slice(-2).join('/'), line: it.line, expr: it.expr.trim().replace(/\s+/g, ' ').slice(0, 140), singleQuoteAttr: sq });
    });
  }
  return { candidates: res, templates: tpls.length };
}
module.exports = { scanTemplates, findCandidates, stripEscaped };
