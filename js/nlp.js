const NLP = {
    dynamicCategories: null,
    learnedMap: {},   // { "termo_normalizado": "NomeCategoria" }

    setCategoryMap(categoriesArray) {
        this.dynamicCategories = {};
        for (const cat of categoriesArray) {
            // Keywords do banco + keywords estáticos (mesclados, sem duplicatas)
            const dbKw     = cat.keywords || [];
            const staticKw = this.categories[cat.name] || [];
            const merged   = [...new Set([...dbKw, ...staticKw])];
            this.dynamicCategories[cat.name] = merged;
        }
    },

    setLearnedMap(map) {
        this.learnedMap = map || {};
    },

    // Retorna categoria aprendida para o texto (ou null se não encontrar)
    _checkLearned(normText) {
        if (!this.learnedMap || !Object.keys(this.learnedMap).length) return null;
        // Ordena por comprimento decrescente para preferir frases mais específicas
        const entries = Object.entries(this.learnedMap)
            .sort((a, b) => b[0].length - a[0].length);
        for (const [phrase, cat] of entries) {
            if (!phrase) continue;
            const safePhrase = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`\\b${safePhrase}`, 'i').test(normText)) return cat;
        }
        return null;
    },

    categories: {
        'Alimentação': ['mercado', 'supermercado', 'restaurante', 'lanche', 'comida', 'almoço', 'jantar', 'café', 'cafeteria', 'hamburguer', 'hamburger', 'pizza', 'açaí', 'acai', 'padaria', 'ifood', 'rappi', 'delivery', 'marmita', 'feira', 'hortifruti', 'fruta', 'verdura', 'pão', 'pao', 'salgado', 'carne', 'frango', 'peixe', 'sorvete', 'doce', 'biscoito', 'bebida', 'refrigerante', 'cerveja', 'bar', 'merenda', 'lancheira', 'refeição', 'refeicao', 'quentinha', 'misto', 'tapioca', 'coxinha', 'pastel'],
        'Transporte': ['uber', 'taxi', '99', 'ônibus', 'onibus', 'metrô', 'metro', 'gasolina', 'combustível', 'combustivel', 'estacionamento', 'pedágio', 'pedagio', 'passagem', 'mototaxi', 'bicicleta', 'scooter', '99pop', 'cabify'],
        'Saúde': ['farmácia', 'farmacia', 'remédio', 'remedio', 'médico', 'medico', 'hospital', 'consulta', 'dentista', 'exame', 'plano', 'academia', 'drogaria', 'manipulação', 'manipulacao', 'vacina', 'fisioterapia'],
        'Moradia': ['aluguel', 'condomínio', 'condominio', 'água', 'agua', 'luz', 'energia', 'internet', 'gás', 'gas', 'telefone', 'celular', 'tv', 'streaming', 'netflix', 'aluguel'],
        'Educação': ['escola', 'faculdade', 'curso', 'livro', 'mensalidade', 'apostila', 'aula', 'universidade', 'inglês', 'ingles', 'idioma', 'treinamento'],
        'Lazer': ['cinema', 'show', 'spotify', 'youtube', 'jogo', 'game', 'balada', 'festa', 'viagem', 'hotel', 'passeio', 'parque', 'teatro', 'museu', 'disney', 'hbo', 'prime'],
        'Vestuário': ['roupa', 'calçado', 'calcado', 'tênis', 'tenis', 'sapato', 'camisa', 'calça', 'calca', 'vestido', 'bermuda', 'casaco', 'jaqueta', 'meia', 'cueca', 'lingerie'],
        'PIX': ['pix', 'transferência', 'transferencia', 'ted', 'doc'],
        'Outros': []
    },

    incomeKeywords: ['recebi', 'ganhei', 'depósito', 'deposito', 'salário', 'salario', 'freela', 'freelance', 'vendi', 'entrada', 'reembolso', 'devolução', 'devolucao', 'crédito', 'credito', 'rendimento', 'lucro', 'renda', 'bolsa', 'auxílio', 'auxilio', 'benefício', 'beneficio'],
    expenseKeywords: ['gastei', 'paguei', 'comprei', 'transferi', 'mandei', 'enviei', 'saída', 'saida', 'debitou', 'cobrado', 'débito', 'debito'],

    // ─── Comandos compostos por voz ──────────────────────────────────────────
    // Detecta múltiplos lançamentos em uma única fala:
    //   "gasolina 200 e mercado 150" → ["gasolina 200", "mercado 150"]
    //   "gastei 50 no almoço e 30 no uber" → ["gastei 50 no almoço", "30 no uber"]
    // Retorna [text] se não detectar comando composto.
    splitCompoundCommand(text) {
        const normalized = this._normalizeVoiceNumber(text);
        // Marca posições de cada valor monetário
        const valueRe = /(\d+(?:[.,]\d{1,2})?(?:\s*(?:reais?|real|contos?))?)/gi;
        const matches = [...normalized.matchAll(valueRe)];
        if (matches.length < 2) return [text];

        const connectorRe = /\s+(e|tambem|também|depois|mais|ai|aí)\s+|\s*[;,]\s+/i;
        const segments = [];
        let lastEnd = 0;

        for (let i = 0; i < matches.length - 1; i++) {
            const m    = matches[i];
            const next = matches[i + 1];
            const between = normalized.slice(m.index + m[0].length, next.index);
            const conn = between.match(connectorRe);
            if (conn) {
                const splitStart = m.index + m[0].length + conn.index;
                const splitEnd   = splitStart + conn[0].length;
                segments.push(normalized.slice(lastEnd, splitStart).trim());
                lastEnd = splitEnd;
            }
        }
        segments.push(normalized.slice(lastEnd).trim());

        // Filtra segmentos sem número (não viáveis como lançamento)
        const valid = segments.filter(s => /\d/.test(s) && s.length > 1);
        return valid.length > 1 ? valid : [text];
    },

    // Faz parse de cada segmento separadamente
    parseCompound(text) {
        const segments = this.splitCompoundCommand(text);
        if (segments.length === 1) return [this.parse(text)];
        return segments.map(s => this.parse(s));
    },

    parse(text) {
        const lower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const original = text.toLowerCase();

        const value       = this.extractValue(original);
        const type        = this.extractType(original);
        const category    = this.extractCategory(original);
        const date        = this.extractDate(lower);
        const description = this.extractDescription(original);

        return { value, type, category, date, description, original: text };
    },

    extractDate(text) {
        const today = new Date();
        const pad   = n => String(n).padStart(2, '0');
        const fmt   = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

        // "hoje"
        if (/\bhoje\b/.test(text)) return fmt(today);

        // "amanhã" / "amanha"
        if (/\bamanha\b/.test(text.normalize('NFD').replace(/[̀-ͯ]/g, ''))) {
            const d = new Date(today); d.setDate(d.getDate() + 1); return fmt(d);
        }

        // "depois de amanhã" / "depois de amanha"
        if (/depois\s+de\s+amanha/.test(text.normalize('NFD').replace(/[̀-ͯ]/g, ''))) {
            const d = new Date(today); d.setDate(d.getDate() + 2); return fmt(d);
        }

        // "ontem"
        if (/\bontem\b/.test(text)) {
            const d = new Date(today); d.setDate(d.getDate() - 1); return fmt(d);
        }

        // "anteontem"
        if (/\banteontem\b/.test(text)) {
            const d = new Date(today); d.setDate(d.getDate() - 2); return fmt(d);
        }

        // "semana passada" → 7 dias atrás
        if (/semana\s+passada/.test(text)) {
            const d = new Date(today); d.setDate(d.getDate() - 7); return fmt(d);
        }

        // "próxima semana" / "semana que vem" → 7 dias à frente
        if (/pr[oó]xima\s+semana|semana\s+que\s+vem/.test(text)) {
            const d = new Date(today); d.setDate(d.getDate() + 7); return fmt(d);
        }

        // dia da semana: "segunda", "terça", etc. → último ocorrido
        const weekdays = { segunda: 1, terca: 2, 'terca-feira': 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6, domingo: 0 };
        for (const [name, dow] of Object.entries(weekdays)) {
            const re = new RegExp(`\\b${name}(\\s*-?\\s*feira)?\\b`);
            if (re.test(text)) {
                const d = new Date(today);
                const diff = (d.getDay() - dow + 7) % 7 || 7;
                d.setDate(d.getDate() - diff);
                return fmt(d);
            }
        }

        // "dia 15", "dia 15 de abril", "no dia 5"
        const diaMatch = text.match(/\b(?:no\s+)?dia\s+(\d{1,2})(?:\s+de\s+(\w+))?/);
        if (diaMatch) {
            const day = parseInt(diaMatch[1]);
            const months = { janeiro:0,fevereiro:1,marco:2,abril:3,maio:4,junho:5,julho:6,agosto:7,setembro:8,outubro:9,novembro:10,dezembro:11 };
            const monthName = diaMatch[2]?.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
            const month = monthName && months[monthName] !== undefined ? months[monthName] : today.getMonth();
            const year  = today.getFullYear();
            const d = new Date(year, month, day);
            if (!isNaN(d.getTime())) return fmt(d);
        }

        // "15/04", "15/04/2026", "15-04", "15-04-2026"
        const dateMatch = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
        if (dateMatch) {
            const day   = parseInt(dateMatch[1]);
            const month = parseInt(dateMatch[2]) - 1;
            const year  = dateMatch[3] ? (dateMatch[3].length === 2 ? 2000 + parseInt(dateMatch[3]) : parseInt(dateMatch[3])) : today.getFullYear();
            const d = new Date(year, month, day);
            if (!isNaN(d.getTime()) && day >= 1 && day <= 31 && month >= 0 && month <= 11) return fmt(d);
        }

        return null;
    },

    extractDescription(text) {
        let desc = text.toLowerCase();

        // 0. Normaliza separador decimal falado por voz ANTES de remover números
        //    ex: "plano calde 118 vírgula 40" → "plano calde 118,40"
        desc = this._normalizeVoiceNumber(desc);

        // 1. Remove saudações e introduções
        desc = desc.replace(/^(oi|olá|ola|ei|hey|bom dia|boa tarde|boa noite)[,!\s]*/i, '');

        // 2. Remove frases de introdução completas (modo voz)
        const fillerPhrases = [
            /\b(queria|quero|gostaria de?)\s+(avisar|dizer|informar|falar|contar|registrar)\s+(que|isso)?\s*/gi,
            /\b(só\s+)?(para|pra)\s+(avisar|dizer|informar|falar|contar|registrar)\s+(que\s*)?/gi,
            /\b(pronto[,\s]+)?(agora\s+)?(eu\s+)?(queria|quero|preciso)\s+/gi,
            /\bvocê\s+sou\b.*$/gi,
        ];
        for (const p of fillerPhrases) desc = desc.replace(p, '');

        // 3. Remove pronomes sujeito
        desc = desc.replace(/\b(eu|a gente|nós|nos|você|vc)\b/gi, '');

        // 4. Remove verbos de ação financeiros
        const verbs = ['gastei','paguei','comprei','transferi','mandei','enviei',
                       'recebi','ganhei','vendi','depositei','saquei','peguei',
                       'gastou','pagou','comprou','recebeu'];
        for (const v of verbs) {
            desc = desc.replace(new RegExp(`\\b${v}\\b`, 'gi'), '');
        }

        // 5. Remove referências de data completas antes de remover números
        desc = desc.replace(/\b(no\s+dia|dia)\s+\d{1,2}(\s+de\s+\w+)?(\s+de\s+\d{4})?\b/gi, '');
        // \b não funciona com acentos (ã, ó…), por isso os termos acentuados ficam separados
        desc = desc.replace(/\b(hoje|ontem|anteontem|amanha|depois\s+de\s+amanha|semana\s+passada|proxima\s+semana|semana\s+que\s+vem)\b/gi, '');
        desc = desc.replace(/amanhã/gi, '').replace(/depois\s+de\s+amanhã/gi, '').replace(/próxima\s+semana/gi, '');
        desc = desc.replace(/\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?\b/g, '');
        const weekdays = /\b(segunda|terça|terca|quarta|quinta|sexta|sábado|sabado|domingo)(\s*-?\s*feira)?\b/gi;
        desc = desc.replace(weekdays, '');

        // 6. Remove valores monetários (inclusive preposição "por/de/valor" antes do valor)
        desc = desc.replace(/\bvalor\s+(de\s+)?/gi, '');
        desc = desc.replace(/\b(por|de)\s+r\$\s*\d+([.,]\d{1,2})?/gi, '');
        desc = desc.replace(/\b(por|de)\s+\d+([.,]\d{1,2})?\s*(reais|real|conto|contos|reis)/gi, '');
        desc = desc.replace(/r\$\s*\d+([.,]\d{1,2})?/gi, '');
        desc = desc.replace(/\d+([.,]\d{1,2})?\s*(reais|real|conto|contos|reis)/gi, '');
        desc = desc.replace(/\b\d+([.,]\d{1,2})?\b/g, '');

        // 6b. Remove números escritos por extenso + "reais/real/conto"
        // ex: "cinco reais", "vinte e cinco reais", "cem reais"
        const _numPart = '(?:um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezasseis|dezessete|dezassete|dezoito|dezenove|dezanove|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|cem|cento|duzentos?|trezentos?|quatrocentos?|quinhentos?|seiscentos?|setecentos?|oitocentos?|novecentos?|mil)';
        const _numPhrase = new RegExp(`\\b${_numPart}(?:\\s+e\\s+${_numPart}|\\s+${_numPart})*\\s+(?:reais?|real|contos?)\\b`, 'gi');
        desc = desc.replace(_numPhrase, '');

        // 7. Remove conjunções e relativos sozinhos
        desc = desc.replace(/\b(que|o que|isso|aquilo|então|aí|só)\b/gi, '');

        // 8. Remove preposições/artigos no início (múltiplas passagens)
        const leadingJunk = /^\s*(no|na|nos|nas|com|em|de|do|da|dos|das|para|pro|pra|por|num|numa|a|o|os|as|um|uma|uns|umas|ao|aos|à|às)\s+/gi;
        let prev;
        do { prev = desc; desc = desc.replace(leadingJunk, ''); } while (desc !== prev);

        // 9. Remove preposições/artigos soltos no final
        desc = desc.replace(/\s+(por|de|do|da|em|no|na|com|a|o|e|ao|para|pra|pro|num|numa)\s*$/gi, '');

        // 10. Limpa espaços e capitaliza
        desc = desc.replace(/\s+/g, ' ').trim();
        if (desc) desc = desc.charAt(0).toUpperCase() + desc.slice(1);

        return desc || text.trim();
    },

    // ─── Tabelas para números por extenso ────────────────────────────────────
    _numWords: {
        ones: { 'um':1,'uma':1,'dois':2,'duas':2,'tres':3,'quatro':4,'cinco':5,
                'seis':6,'sete':7,'oito':8,'nove':9,'dez':10,'onze':11,'doze':12,
                'treze':13,'quatorze':14,'catorze':14,'quinze':15,
                'dezesseis':16,'dezasseis':16,'dezessete':17,'dezassete':17,
                'dezoito':18,'dezenove':19,'dezanove':19 },
        tens: { 'vinte':20,'trinta':30,'quarenta':40,'cinquenta':50,
                'sessenta':60,'setenta':70,'oitenta':80,'noventa':90 },
        hundreds: { 'cem':100,'cento':100,'duzentos':200,'duzentas':200,
                    'trezentos':300,'trezentas':300,'quatrocentos':400,'quatrocentas':400,
                    'quinhentos':500,'quinhentas':500,'seiscentos':600,'seiscentas':600,
                    'setecentos':700,'setecentas':700,'oitocentos':800,'oitocentas':800,
                    'novecentos':900,'novecentas':900 },
    },

    // Converte texto de número por extenso para float.
    // Retorna null se não encontrar padrão reconhecível.
    // Ex: "vinte e cinco" → 25 | "dois mil e quinhentos" → 2500 | "cinco" → 5
    _parseWrittenNumber(text) {
        const norm = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
        const { ones, tens, hundreds } = this._numWords;
        // Divide por " e " ou espaço simples
        const words = norm.split(/\s+e\s+|\s+/).filter(Boolean);
        if (!words.length) return null;
        let total = 0, current = 0, valid = false;
        for (const w of words) {
            if (w === 'e') continue;
            if (ones[w]     !== undefined) { current += ones[w];     valid = true; }
            else if (tens[w]!== undefined) { current += tens[w];     valid = true; }
            else if (hundreds[w] !== undefined) { current += hundreds[w]; valid = true; }
            else if (w === 'mil')          { total += (current || 1) * 1000; current = 0; valid = true; }
            else return null; // palavra desconhecida — bail out
        }
        total += current;
        return (valid && total > 0) ? total : null;
    },

    // ─── Converte string numérica BR para float ───────────────────────────────
    // Suporta: "1.500,50" → 1500.50 | "1500,50" → 1500.50 | "50,30" → 50.30
    //          "1.500" → 1500 | "50.30" → 50.30 | "1500" → 1500
    _parseBRNumber(raw) {
        if (!raw) return NaN;
        const s = raw.trim();

        // Formato BR completo: milhar com ponto + decimal com vírgula  ex: 1.500,50
        if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) {
            return parseFloat(s.replace(/\./g, '').replace(',', '.'));
        }

        // Apenas vírgula decimal (sem ponto de milhar)  ex: 50,30 | 1500,50
        if (/^\d+(,\d{1,2})$/.test(s)) {
            return parseFloat(s.replace(',', '.'));
        }

        // Ponto ambíguo: 3 dígitos após ponto → milhar  ex: 1.500 → 1500
        if (/^\d+\.\d{3}$/.test(s)) {
            return parseFloat(s.replace('.', ''));
        }

        // Ponto com 1–2 dígitos → decimal  ex: 50.30 | 50.5
        if (/^\d+\.\d{1,2}$/.test(s)) {
            return parseFloat(s);
        }

        // Número inteiro sem separador
        return parseFloat(s.replace(',', '.'));
    },

    // Normaliza saída do reconhecimento de voz antes de parsear o valor.
    // O speech-to-text do iOS/Android escreve o separador decimal por extenso:
    //   "118 vírgula 40"  → "118,40"
    //   "1500 vírgula 50" → "1500,50"
    //   "50 ponto 30"     → "50,30" (alguns engines usam "ponto" para decimal)
    _normalizeVoiceNumber(text) {
        return text
            .replace(/(\d+)\s+v[ií]rgula\s+(\d{1,2})/gi,  '$1,$2')
            .replace(/(\d+)\s+ponto\s+(\d{1,2})(?!\d)/gi, '$1,$2');
    },

    extractValue(text) {
        // Normaliza números falados por extenso antes de qualquer padrão
        const t = this._normalizeVoiceNumber(text.toLowerCase().trim());

        // ── 1. Padrão "X reais e Y centavos" (escrito por extenso) ──────────────
        const rCents = t.match(/(\d+)\s*(?:reais?|real|contos?)\s+e\s+(\d{1,2})\s*centavos?/);
        if (rCents) {
            const reais = parseInt(rCents[1], 10);
            const cents = parseInt(rCents[2], 10);
            const val = reais + cents / 100;
            if (val > 0) return val;
        }

        // ── 2. Apenas centavos  ex: "50 centavos" ────────────────────────────────
        const onlyCents = t.match(/(\d{1,2})\s*centavos?/);
        if (onlyCents && !t.match(/\d+\s*(?:reais?|real|contos?)/)) {
            const val = parseInt(onlyCents[1], 10) / 100;
            if (val > 0) return val;
        }

        // ── 3. R$ com número BR  ex: R$ 1.500,50 | R$ 50,30 | R$ 2.500 ─────────
        const rBRL = t.match(/r\$\s*([\d.,]+)/i);
        if (rBRL) {
            const val = this._parseBRNumber(rBRL[1]);
            if (!isNaN(val) && val > 0) return val;
        }

        // ── 4. Número seguido de "reais" / "real" / "conto" ──────────────────────
        const rWord = t.match(/([\d.,]+)\s*(?:reais?|real|contos?)/);
        if (rWord) {
            const val = this._parseBRNumber(rWord[1]);
            if (!isNaN(val) && val > 0) return val;
        }

        // ── 5. Número com vírgula decimal  ex: "gastei 50,30 no mercado" ─────────
        const rComma = t.match(/\b(\d+,\d{1,2})\b/);
        if (rComma) {
            const val = this._parseBRNumber(rComma[1]);
            if (!isNaN(val) && val > 0) return val;
        }

        // ── 6. Número com ponto  ex: "1.500,00" já coberto; "50.30" ──────────────
        const rDot = t.match(/\b(\d+\.\d+)\b/);
        if (rDot) {
            const val = this._parseBRNumber(rDot[1]);
            if (!isNaN(val) && val > 0) return val;
        }

        // ── 7. Número inteiro simples ─────────────────────────────────────────────
        const rInt = t.match(/\b(\d+)\b/);
        if (rInt) {
            const val = parseFloat(rInt[1]);
            if (!isNaN(val) && val > 0) return val;
        }

        // ── 8. Número escrito por extenso + "reais/real/conto" ──────────────────
        // ex: "cinco reais" → 5 | "vinte e cinco reais" → 25 | "cem reais" → 100
        const writtenReaisMatch = t.match(/\b([a-záéíóúàâêôãõüç]+(?:\s+e\s+[a-záéíóúàâêôãõüç]+|\s+[a-záéíóúàâêôãõüç]+)*)\s+(?:reais?|real|contos?)\b/);
        if (writtenReaisMatch) {
            const val = this._parseWrittenNumber(writtenReaisMatch[1]);
            if (val) return val;
        }

        // ── 9. Número escrito sozinho (sem "reais") quando não há outra info ────
        // ex: "hoje lanche cinco" → 5  (só aplica se o texto é curto/simples)
        const allWords = t.replace(/[^a-záéíóúàâêôãõüç\s]/g, ' ').trim().split(/\s+/);
        if (allWords.length <= 5) {
            for (const w of [...allWords].reverse()) {
                const val = this._parseWrittenNumber(w);
                if (val) return val;
            }
        }

        return null;
    },

    extractType(text) {
        // Usa borda de palavra para evitar falsos positivos:
        // ex: 'renda' NÃO deve casar dentro de 'merenda'
        const norm = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        for (const kw of this.incomeKeywords) {
            const safe = kw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`\\b${safe}\\b`).test(norm)) return 'entrada';
        }
        for (const kw of this.expenseKeywords) {
            const safe = kw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`\\b${safe}\\b`).test(norm)) return 'saida';
        }
        return 'saida';
    },

    // Verifica se o NOME de alguma categoria aparece como palavra inteira no texto.
    // Prioriza nomes mais longos (ex: "Aluguel Casa" antes de "Casa").
    // Ex: usuario tem categoria "Feira" e fala "feira" => retorna "Feira".
    _matchCategoryByName(norm, catNames) {
        const sorted = [...catNames]
            .filter(n => n && n !== 'Outros')
            .sort((a, b) => b.length - a.length);
        for (const name of sorted) {
            const nameNorm = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
            if (!nameNorm) continue;
            const safe = nameNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`\\b${safe}\\b`, 'i').test(norm)) return name;
        }
        return null;
    },

    // Extrai categoria usando APENAS keywords estaticos (sem mapa aprendido).
    // Usado pela UI do modal para garantir que 'frango' => Alimentacao sem ambiguidade.
    extractCategoryStatic(text) {
        const cats = this.dynamicCategories
            ? { ...this.categories, ...this.dynamicCategories }
            : this.categories;
        const norm = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        // 0. Nome exato de categoria — PRIORIDADE ABSOLUTA
        //    Categoria do usuario ("Feira") vence keyword estatico ("feira"=>Alimentacao)
        const byName = this._matchCategoryByName(norm, Object.keys(cats));
        if (byName) return byName;
        for (const [cat, keywords] of Object.entries(cats)) {
            if (cat === 'Outros') continue;
            for (const kw of keywords) {
                const kwNorm = kw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = kwNorm.length <= 3
                ? new RegExp(`\\b${kwNorm}\\b`, 'i')
                : new RegExp(`\\b${kwNorm}`, 'i');
                if (re.test(norm)) return cat;
            }
        }
        return 'Outros';
    },
    extractCategory(text) {
        // Usa dynamicCategories se disponível; caso contrário, estático puro
        const cats = this.dynamicCategories
            ? { ...this.categories, ...this.dynamicCategories }
            : this.categories;
        const norm = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

        // 0. Nome exato de categoria — PRIORIDADE ABSOLUTA
        const byName = this._matchCategoryByName(norm, Object.keys(cats));
        if (byName) return byName;

        // 1. Keywords estáticos / do banco — PRIORIDADE ALTA
        //    São curados e específicos: 'frango' = Alimentação, sem ambiguidade.
        //    Mapa aprendido só entra quando nenhum keyword estático bater.
        for (const [cat, keywords] of Object.entries(cats)) {
            if (cat === 'Outros') continue;
            for (const kw of keywords) {
                const kwNorm = kw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = kwNorm.length <= 3
                    ? new RegExp(`\\b${kwNorm}\\b`, 'i')
                    : new RegExp(`\\b${kwNorm}`, 'i');
                if (re.test(norm)) return cat;
            }
        }

        // 2. Mapa aprendido — cobre descrições não previstas nas listas
        const learned = this._checkLearned(norm);
        if (learned) return learned;

        return 'Outros';
    }
};