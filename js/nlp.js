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
        desc = desc.replace(/\b(hoje|ontem|anteontem|semana\s+passada)\b/gi, '');
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

    extractValue(text) {
        const t = text.toLowerCase().trim();

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

    extractCategory(text) {
        // Usa dynamicCategories se disponível; caso contrário, estático puro
        // Em ambos os casos, garante que keywords estáticos de fallback sejam checados
        const cats = this.dynamicCategories
            ? { ...this.categories, ...this.dynamicCategories }
            : this.categories;
        const norm = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

        // 1. Mapa aprendido tem prioridade m\u00e1xima
        const learned = this._checkLearned(norm);
        if (learned) return learned;

        // 2. Regras est\u00e1ticas / keywords das categorias
        for (const [cat, keywords] of Object.entries(cats)) {
            if (cat === 'Outros') continue;
            for (const kw of keywords) {
                const kwNorm = kw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // short keywords (≤3 chars): exact word — prevents "gas"→"gastei", "doc"→"doce"
                // longer keywords: prefix match — allows "doce"→"doces", "uber"→"ubereats"
                const re = kwNorm.length <= 3
                    ? new RegExp(`\\b${kwNorm}\\b`, 'i')
                    : new RegExp(`\\b${kwNorm}`, 'i');
                if (re.test(norm)) return cat;
            }
        }
        return 'Outros';
    }
};
