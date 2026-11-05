// Favoritos de um toque ("Lançar rápido"): atalhos com NOME, TIPO (entrada | saida) e CATEGORIA — nunca valor.
// Por usuário e por carteira; no máximo 6 (entradas e saídas juntas). Tipos = os mesmos ids de transactions.type ('entrada' | 'saida').
// Parte pura (normalização, sugestões, teclado de centavos) no topo; depois armazenamento (Supabase/local) e a interface.
const Favorites = {
    MAX: 6, NAME_MAX: 40, SUGGEST_DAYS: 60, SUGGEST_MIN: 3, MAX_CENTS: 999999999,        // R$ 9.999.999,99
    TYPES: {
        saida:   { label: 'Saída',   sign: '-', cta: 'Lançar saída',   verb: 'saída' },
        entrada: { label: 'Entrada', sign: '+', cta: 'Lançar entrada', verb: 'entrada' },
    },

    // ───────────────────────── lógica pura (testável em node) ─────────────────────────
    // minúsculas, sem acento, espaços colapsados; remove o sufixo de parcela "(2/4)"
    normalizeDesc(s) {
        return String(s ?? '').replace(/\s*\(\d+\/\d+\)\s*$/, '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    },
    cleanName(s) { return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, this.NAME_MAX); },

    // Sugestões a partir do histórico: últimos 60 dias, (descrição normalizada, tipo), ≥ 3 ocorrências, ignora as já favoritas do
    // MESMO tipo; categoria = a mais usada do grupo. Sem valor. today = "AAAA-MM-DD" local (para teste).
    suggest(transactions, favorites = [], { today = Utils.todayLocal(), days = this.SUGGEST_DAYS, min = this.SUGGEST_MIN } = {}) {
        const [y, m, d] = today.split('-').map(Number);
        const from = Utils.localDateStr(new Date(y, m - 1, d - days));
        const ja = new Set((favorites || []).map(f => `${this.normalizeDesc(f.name)}|${f.type}`));
        const groups = new Map();
        for (const t of transactions || []) {
            if (t.type !== 'entrada' && t.type !== 'saida') continue;
            if (!t.date || t.date < from || t.date > today) continue;
            const norm = this.normalizeDesc(t.description);
            if (!norm) continue;
            const key = `${norm}|${t.type}`;
            const g = groups.get(key) || { norm, type: t.type, count: 0, names: new Map(), cats: new Map() };
            g.count++;
            const nm = this.cleanName((t.description || '').replace(/\s*\(\d+\/\d+\)\s*$/, ''));
            g.names.set(nm, (g.names.get(nm) || 0) + 1);
            if (t.category) g.cats.set(t.category, (g.cats.get(t.category) || 0) + 1);
            groups.set(key, g);
        }
        const top = map => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] ?? null;
        return [...groups.values()].filter(g => g.count >= min && !ja.has(`${g.norm}|${g.type}`))
            .map(g => ({ name: top(g.names), type: g.type, category: top(g.cats), count: g.count }))
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    },

    // Teclado de centavos: "1","5","0","0" → 1500 (R$ 15,00). Teclas: '0'–'9', '00', 'del'. Nunca negativo, com teto.
    keypadPress(cents, key) {
        let c = Number.isInteger(cents) && cents > 0 ? cents : 0;
        if (key === 'del') return Math.floor(c / 10);
        if (key === '00') key = '00'; else if (!/^[0-9]$/.test(String(key))) return c;
        const n = c * Math.pow(10, String(key).length) + Number(key);
        return n > this.MAX_CENTS ? c : n;
    },
    formatCents(cents) {                                                      // só inteiros: "R$ 1.234,56"
        const c = Number.isInteger(cents) && cents > 0 ? cents : 0;
        const reais = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        return `R$ ${reais},${String(c % 100).padStart(2, '0')}`;
    },
    centsToValue(cents) { return Utils.roundMoney(cents / 100); },

    // Categoria compatível com o tipo do favorito (categoria 'both' serve aos dois)
    categoryFits(cat, type) { return !!cat && (cat.type === 'both' || !cat.type || cat.type === type); },
    // Só categorias reais (uuid): as padrão ("d-…") existem só no app e não têm linha no banco
    categoryUsable(cat) { return !!cat && typeof cat.id === 'string' && !cat.id.startsWith('d-'); },

    // ───────────────────────── armazenamento ─────────────────────────
    _fid() { const id = Storage.activeFinancaId; return id && id !== 'null' ? id : null; },
    _key(fid) { return `fav_${Storage.isCloud ? (Storage.userId() || 'u') : 'local'}_${fid || 'personal'}`; },
    _read(fid) { try { const a = JSON.parse(localStorage.getItem(this._key(fid)) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } },
    _write(fid, list) { try { localStorage.setItem(this._key(fid), JSON.stringify(list)); } catch (_) {} },
    _useDb(fid) { return Storage.isCloud && !!fid; },                          // carteira "Pessoal" sem id (modo local) fica no aparelho

    async load(fid = this._fid()) {
        let list;
        if (this._useDb(fid) && Storage.isOnline) {
            const { data, error } = await Storage.db.from('favorite_entries').select('*').eq('financa_id', fid).order('position', { ascending: true }).order('created_at', { ascending: true });
            if (error) throw error;
            list = data || []; this._write(fid, list);
        } else list = this._read(fid);
        return list.slice().sort((a, b) => (a.position || 0) - (b.position || 0)).slice(0, this.MAX + 4);
    },

    // Valida (cliente) e devolve a mensagem de erro, ou null
    validate(list, { id = null, name, type, categoryId = null }, categories = []) {
        const nm = this.cleanName(name);
        if (!nm) return 'Digite um nome.';
        if (!this.TYPES[type]) return 'Escolha Saída ou Entrada.';
        if (!id && list.length >= this.MAX) return `Você já tem ${this.MAX} favoritos. Entradas e saídas dividem as ${this.MAX} vagas.`;
        const norm = this.normalizeDesc(nm);
        if (list.some(f => f.id !== id && f.type === type && this.normalizeDesc(f.name) === norm)) return `Já existe um favorito de ${this.TYPES[type].verb} com esse nome.`;
        if (categoryId) {
            const cat = categories.find(c => c.id === categoryId);
            if (!cat || !this.categoryUsable(cat)) return 'Essa categoria não pode ser usada em favoritos.';
            if (!this.categoryFits(cat, type)) return 'Essa categoria não combina com o tipo escolhido. Escolha outra.';
        }
        return null;
    },
    _explain(e) {                                                              // erro do banco → mensagem clara
        const m = String(e?.message || e || '');
        if (e?.code === '23505' || /duplicate key|favorite_entries_uniq/i.test(m)) return 'Já existe um favorito com esse nome nesse tipo.';
        if (/limite de 6/i.test(m)) return 'Limite de 6 favoritos por carteira (entradas e saídas juntas).';
        if (e?.code === '42501' || /row-level security|permission denied/i.test(m)) return 'Você não tem permissão para criar favoritos nesta carteira.';
        if (/category|categoria|violates foreign key|with check/i.test(m)) return 'Categoria inválida para este tipo ou carteira.';
        return 'Não foi possível salvar. Tente de novo.';
    },

    async create(fav, fid = this._fid()) {
        const list = await this.load(fid);
        const fields = { name: this.cleanName(fav.name), type: fav.type, category_id: fav.categoryId || null };
        const position = list.reduce((mx, f) => Math.max(mx, f.position || 0), 0) + 1;
        if (this._useDb(fid)) {
            if (!Storage.isOnline) throw new Error('Sem internet: conecte-se para criar favoritos.');
            const { data, error } = await Storage.db.from('favorite_entries').insert({ ...fields, financa_id: fid, position }).select().single();
            if (error) throw new Error(this._explain(error));
            this._write(fid, [...list, data]); return data;
        }
        const row = { id: 'fav_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), financa_id: fid, user_id: Storage.userId?.() || 'local', ...fields, position, created_at: new Date().toISOString() };
        this._write(fid, [...list, row]); return row;
    },
    async update(id, fields, fid = this._fid()) {
        const list = await this.load(fid);
        const patch = {};
        if ('name' in fields) patch.name = this.cleanName(fields.name);
        if ('type' in fields) patch.type = fields.type;
        if ('categoryId' in fields) patch.category_id = fields.categoryId || null;
        if ('position' in fields) patch.position = fields.position;
        if (this._useDb(fid)) {
            if (!Storage.isOnline) throw new Error('Sem internet: conecte-se para editar favoritos.');
            const { data, error } = await Storage.db.from('favorite_entries').update(patch).eq('id', id).select().single();
            if (error) throw new Error(this._explain(error));
            this._write(fid, list.map(f => f.id === id ? data : f)); return data;
        }
        const next = list.map(f => f.id === id ? { ...f, ...patch } : f); this._write(fid, next); return next.find(f => f.id === id);
    },
    async remove(id, fid = this._fid()) {
        const list = await this.load(fid);
        if (this._useDb(fid)) {
            if (!Storage.isOnline) throw new Error('Sem internet: conecte-se para remover favoritos.');
            const { error } = await Storage.db.from('favorite_entries').delete().eq('id', id);
            if (error) throw new Error(this._explain(error));
        }
        this._write(fid, list.filter(f => f.id !== id));
    },
    // troca a posição de dois favoritos vizinhos (subir/descer)
    async move(id, dir, fid = this._fid()) {
        const list = await this.load(fid);
        const i = list.findIndex(f => f.id === id), j = i + dir;
        if (i < 0 || j < 0 || j >= list.length) return list;
        const a = list[i], b = list[j];
        const pa = a.position ?? i, pb = b.position ?? j;
        await this.update(a.id, { position: pb === pa ? pa + dir : pb }, fid);
        await this.update(b.id, { position: pa }, fid);
        return this.load(fid);
    },
};
