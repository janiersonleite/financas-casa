const NLP = {
    dynamicCategories: null,

    setCategoryMap(categoriesArray) {
        this.dynamicCategories = {};
        for (const cat of categoriesArray) {
            this.dynamicCategories[cat.name] = cat.keywords || [];
        }
    },

    categories: {
        'Alimentação': ['mercado', 'supermercado', 'restaurante', 'lanche', 'comida', 'almoço', 'jantar', 'café', 'cafeteria', 'hamburguer', 'hamburger', 'pizza', 'açaí', 'acai', 'padaria', 'ifood', 'rappi', 'delivery', 'marmita', 'feira', 'hortifruti', 'fruta', 'verdura', 'pão', 'pao', 'salgado', 'carne', 'frango', 'peixe', 'sorvete', 'doce', 'biscoito', 'bebida', 'refrigerante', 'cerveja', 'bar'],
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

        // 5. Remove valores monetários
        desc = desc.replace(/r\$\s*\d+([.,]\d{1,2})?/gi, '');
        desc = desc.replace(/\d+([.,]\d{1,2})?\s*(reais|real|conto|contos|reis)/gi, '');
        desc = desc.replace(/\b\d+([.,]\d{1,2})?\b/g, '');

        // 6. Remove conjunções e relativos sozinhos
        desc = desc.replace(/\b(que|o que|isso|aquilo|então|aí|só)\b/gi, '');

        // 7. Remove preposições/artigos no início (múltiplas passagens)
        const leadingJunk = /^\s*(no|na|nos|nas|com|em|de|do|da|dos|das|para|pro|pra|por|num|numa|a|o|os|as|um|uma|uns|umas|ao|aos|à|às)\s+/gi;
        let prev;
        do { prev = desc; desc = desc.replace(leadingJunk, ''); } while (desc !== prev);

        // 8. Limpa espaços e capitaliza
        desc = desc.replace(/\s+/g, ' ').trim();
        if (desc) desc = desc.charAt(0).toUpperCase() + desc.slice(1);

        return desc || text.trim();
    },

    extractValue(text) {
        const patterns = [
            /r\$\s*(\d+(?:[.,]\d{1,2})?)/i,
            /(\d+(?:[.,]\d{1,2})?)\s*reais/i,
            /(\d+(?:[.,]\d{1,2})?)\s*conto/i,
            /(\d+(?:[.,]\d{1,2})?)\s*real/i,
            /(\d+(?:[.,]\d{2}))/,
            /(\d+)/
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                const raw = match[1].replace(',', '.');
                const val = parseFloat(raw);
                if (!isNaN(val) && val > 0) return val;
            }
        }
        return null;
    },

    extractType(text) {
        for (const kw of this.incomeKeywords) {
            if (text.includes(kw)) return 'entrada';
        }
        for (const kw of this.expenseKeywords) {
            if (text.includes(kw)) return 'saida';
        }
        return 'saida';
    },

    extractCategory(text) {
        const cats = this.dynamicCategories || this.categories;
        for (const [cat, keywords] of Object.entries(cats)) {
            if (cat === 'Outros') continue;
            for (const kw of keywords) {
                if (text.includes(kw)) return cat;
            }
        }
        return 'Outros';
    }
};
