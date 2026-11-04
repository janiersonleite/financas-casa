// Utilitários compartilhados (carregado antes de storage.js/cofrinhos.js/app.js).
const Utils = {
    // Escape de HTML para texto/atributos (aspas duplas E simples). Aceita qualquer valor:
    // null/undefined → '', números/objetos → String(). Escape só na RENDERIZAÇÃO (nunca ao salvar).
    esc(v) {
        return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    // Emoji digitado/colado pelo usuário: devolve só o 1º grafema se for pictográfico (1–2 grafemas
    // aceitos, p.ex. bandeiras/ZWJ contam como 1); qualquer outra coisa → `fallback`.
    cleanEmoji(v, fallback = '📦') {
        const s = String(v ?? '').trim();
        if (!s) return fallback;
        const seg = typeof Intl !== 'undefined' && Intl.Segmenter
            ? [...new Intl.Segmenter('pt-BR', { granularity: 'grapheme' }).segment(s)].map(x => x.segment)
            : Array.from(s);
        const pict = g => /\p{Extended_Pictographic}|\p{Regional_Indicator}|^[0-9#*]️?⃣$/u.test(g);
        const ok = seg.filter(pict).slice(0, 2);
        return ok.length ? ok.join('') : fallback;
    },

    // ── Datas de CALENDÁRIO no horário LOCAL (nunca toISOString: ele converte para UTC e, no Brasil,
    // depois das 21h devolve o dia seguinte). toISOString só para instantes (created_at, fire_at…) — ver DECISOES.md (D8).
    localDateStr(d = new Date()) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    },
    todayLocal() { return Utils.localDateStr(new Date()); },
    monthKeyLocal(d = new Date()) { return Utils.localDateStr(d).slice(0, 7); },
    // "AAAA-MM-DD" → Date à meia-noite LOCAL (new Date('AAAA-MM-DD') seria UTC e exibiria o dia anterior em UTC-3)
    parseDateLocal(s) {
        const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
        return new Date(y, (m || 1) - 1, d || 1);
    },
    // Último dia do mês "AAAA-MM" como "AAAA-MM-DD"
    monthEndLocal(ym) {
        const [y, m] = String(ym).split('-').map(Number);
        return Utils.localDateStr(new Date(y, m, 0));
    },

    // ── Cor por carteira (barra de carteira ativa) ────────────────────────────
    // 8 cores SEM verde nem vermelho (esses já significam entrada e saída). A cor sai de um hash estável do id
    // da carteira: nada é gravado no banco, e a mesma carteira tem a mesma cor em todos os aparelhos.
    WALLET_COLORS: ['#60a5fa', '#c4b5fd', '#fbbf24', '#22d3ee', '#f9a8d4', '#fb923c', '#a5b4fc', '#e879f9'],
    walletColor(id) {
        const s = String(id ?? '');
        let h = 2166136261;                                   // FNV-1a 32 bits
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
        h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0; h ^= h >>> 13;   // mistura final (os bits baixos do FNV são fracos)
        return Utils.WALLET_COLORS[(h >>> 0) % Utils.WALLET_COLORS.length];
    },
    // Texto seguro para nome de arquivo: sem acentos, minúsculo, sem espaços ("Família 2026" → "familia-2026")
    slugFile(v, fallback = 'carteira') {
        const t = String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        return t || fallback;
    },

    // ── Dinheiro (pt-BR) ──────────────────────────────────────────────────────
    // Converte texto monetário em número. Regras (ver docs/qa/DECISOES.md, C1):
    //   "1.234,56" / "R$ 1.234,56" / "1,234.56" → 1234.56   (os dois separadores: o ÚLTIMO é o decimal)
    //   "12,5" → 12.5                                       (vírgula = decimal, até 2 casas)
    //   "1.500" / "1.234.567" → 1500 / 1234567              (ponto + exatamente 3 dígitos, sem vírgula = milhar)
    //   "1500.50" / "50.3" → 1500.5 / 50.3                  (ponto + 1–2 dígitos = decimal)
    //   "0.500" → null (ambíguo: começa com 0)   "1,234" → null (3 casas decimais)   "abc" → null
    // Aceita sinal "-" no início. Nunca devolve valor "chutado": ambíguo/inválido → null.
    parseMoneyBR(raw) {
        if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
        if (raw == null) return null;
        let s = String(raw).replace(/R\$/gi, '').replace(/[\s ]/g, '').replace(/^−/, '-');
        if (!s) return null;
        let neg = false;
        if (s[0] === '-') { neg = true; s = s.slice(1); }
        if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
        const dots = (s.match(/\./g) || []).length, commas = (s.match(/,/g) || []).length;
        let out;
        if (dots && commas) {
            const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
            const mil = dec === ',' ? '.' : ',';
            const ip = s.slice(0, s.lastIndexOf(dec)), fp = s.slice(s.lastIndexOf(dec) + 1);
            if (ip.split(dec).length > 1 || !/^\d{1,2}$/.test(fp)) return null;
            const grupos = ip.split(mil);
            if (!/^\d{1,3}$/.test(grupos[0]) || !grupos.slice(1).every(g => /^\d{3}$/.test(g))) return null;
            out = grupos.join('') + '.' + fp;
        } else if (commas) {
            if (commas > 1 || !/^\d+,\d{1,2}$/.test(s)) return null;
            out = s.replace(',', '.');
        } else if (dots) {
            if (/^\d{1,3}(\.\d{3})+$/.test(s) && !/^0\./.test(s)) out = s.replace(/\./g, '');
            else if (/^\d+\.\d{1,2}$/.test(s)) out = s;
            else return null;
        } else {
            out = s;
        }
        const n = Number(out);
        return Number.isFinite(n) ? (neg ? -n : n) : null;
    },

    // Arredonda para centavos (evita 0.1+0.2 e 1.005 → 1,00 vs 1,01)
    roundMoney(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; },
    toCents(n) { return Math.round((Number(n) + Number.EPSILON) * 100); },

    // Divide `total` em `n` partes em centavos inteiros; a soma é EXATAMENTE o total.
    // A sobra (centavos) vai uma a uma para as primeiras parcelas: 100/3 → [33.34, 33.33, 33.33].
    splitMoney(total, n) {
        const cents = Utils.toCents(total), k = Math.max(1, Math.floor(n));
        const base = Math.floor(cents / k), resto = cents - base * k;
        return Array.from({ length: k }, (_, i) => (base + (i < resto ? 1 : 0)) / 100);
    },
};
