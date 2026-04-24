// ─── Storage ── Supabase (cloud) com fallback para localStorage ───────────────
const Storage = {
    LOCAL_KEY: 'financas_data',
    activeFinancaId: null,

    // ── Helpers ──────────────────────────────────────────────────────────────
    get db() { return window.$sb; },
    get isCloud() { return IS_SUPABASE_CONFIGURED && !!this.db; },
    userId() { return Auth?.user?.id ?? null; },

    // ── Local (fallback) ─────────────────────────────────────────────────────
    _localGet() {
        const d = localStorage.getItem(this.LOCAL_KEY);
        return d ? JSON.parse(d) : { transactions: [], financas: [] };
    },
    _localSave(data) {
        localStorage.setItem(this.LOCAL_KEY, JSON.stringify(data));
    },
    _localAdd(t) {
        const data = this._localGet();
        t.id = Date.now().toString();
        t.created_at = new Date().toISOString();
        if (!t.date) t.date = new Date().toISOString().split('T')[0];
        if (this.activeFinancaId) t.financa_id = this.activeFinancaId;
        data.transactions.unshift(t);
        this._localSave(data);
        return t;
    },
    _localFilter(filters = {}) {
        let list = this._localGet().transactions;
        if (this.activeFinancaId) {
            list = list.filter(t => t.financa_id === this.activeFinancaId || !t.financa_id);
        }
        if (filters.type)  list = list.filter(t => t.type === filters.type);
        if (filters.month) list = list.filter(t => t.date?.startsWith(filters.month));
        return list;
    },

    // ── Finance state ─────────────────────────────────────────────────────────
    setActiveFinanca(id) {
        this.activeFinancaId = id;
        if (id) localStorage.setItem('active_financa_id', id);
        else    localStorage.removeItem('active_financa_id');
    },

    // ── Finance CRUD ──────────────────────────────────────────────────────────
    async getFinancas() {
        if (this.isCloud) {
            const { data, error } = await this.db
                .from('financas')
                .select('*')
                .order('created_at', { ascending: true });
            if (error) throw error;
            return data ?? [];
        }
        return this._localGet().financas || [];
    },

    async createFinanca(name, type = 'individual', emoji = '💰') {
        if (this.isCloud) {
            const { data, error } = await this.db
                .from('financas')
                .insert({ name, type, emoji, owner_id: this.userId() })
                .select()
                .single();
            if (error) throw error;
            // Adiciona dono como membro admin
            await this.db.from('financa_members').insert({
                financa_id: data.id,
                user_id:    this.userId(),
                email:      Auth.user?.email,
                role:       'admin'
            });
            return data;
        }
        const d = this._localGet();
        if (!d.financas) d.financas = [];
        const f = { id: Date.now().toString(), name, type, emoji, owner_id: 'local', created_at: new Date().toISOString() };
        d.financas.push(f);
        this._localSave(d);
        return f;
    },

    async updateFinanca(id, updates) {
        if (this.isCloud) {
            const { error } = await this.db.from('financas').update(updates).eq('id', id);
            if (error) throw error;
            return;
        }
        const d = this._localGet();
        const idx = (d.financas || []).findIndex(f => f.id === id);
        if (idx !== -1) { d.financas[idx] = { ...d.financas[idx], ...updates }; this._localSave(d); }
    },

    async deleteFinanca(id) {
        if (this.isCloud) {
            const { error } = await this.db.from('financas').delete().eq('id', id).eq('owner_id', this.userId());
            if (error) throw error;
            return;
        }
        const d = this._localGet();
        d.financas = (d.financas || []).filter(f => f.id !== id);
        this._localSave(d);
    },

    // ── Members ───────────────────────────────────────────────────────────────
    async getMembers(financaId) {
        if (this.isCloud) {
            const { data, error } = await this.db
                .from('financa_members')
                .select('*')
                .eq('financa_id', financaId)
                .order('joined_at', { ascending: true });
            if (error) throw error;
            return data ?? [];
        }
        return [];
    },

    async removeMember(financaId, memberId) {
        if (this.isCloud) {
            const { error } = await this.db
                .from('financa_members').delete().eq('id', memberId).eq('financa_id', financaId);
            if (error) throw error;
        }
    },

    // ── Invites ───────────────────────────────────────────────────────────────
    async inviteMember(financaId, email, role = 'membro') {
        if (!this.isCloud) throw new Error('Compartilhamento requer Supabase configurado');
        const { data, error } = await this.db.rpc('add_member_by_email', {
            fid:          financaId,
            member_email: email.toLowerCase().trim(),
            member_role:  role
        });
        if (error) throw error;
        return data; // 'added' | 'invited'
    },

    async cancelInvite(inviteId) {
        if (this.isCloud) {
            const { error } = await this.db.from('financa_invites').delete().eq('id', inviteId);
            if (error) throw error;
        }
    },

    async getPendingInvites(financaId) {
        if (this.isCloud) {
            const { data, error } = await this.db
                .from('financa_invites')
                .select('*')
                .eq('financa_id', financaId)
                .is('accepted_at', null);
            if (error) throw error;
            return data ?? [];
        }
        return [];
    },

    async checkMyInvites() {
        if (!this.isCloud) return [];
        const { data, error } = await this.db.rpc('get_my_pending_invites');
        if (error) { console.warn('checkMyInvites error:', error.message); return []; }
        // Normalise shape to match what the rest of the app expects
        return (data ?? []).map(r => ({
            id:         r.id,
            financa_id: r.financa_id,
            email:      r.email,
            role:       r.role,
            accepted_at: r.accepted_at,
            financa: { name: r.financa_name, emoji: r.financa_emoji }
        }));
    },

    async acceptInvite(inviteId, financaId) {
        if (!this.isCloud) return;
        await this.db.from('financa_members').upsert({
            financa_id: financaId,
            user_id:    this.userId(),
            email:      Auth.user?.email,
            role:       'membro'
        }, { onConflict: 'financa_id,user_id' });
        await this.db.from('financa_invites')
            .update({ accepted_at: new Date().toISOString() })
            .eq('id', inviteId);
    },

    // ── Categories ───────────────────────────────────────────────────────────
    _defaultCategories: [
        { id: 'd-food',      name: 'Alimentação', emoji: '🍔', keywords: ['mercado','supermercado','restaurante','lanche','comida','almoço','jantar','café','padaria','ifood','rappi','delivery','marmita','feira'], type: 'saida',  sort_order: 1 },
        { id: 'd-transport', name: 'Transporte',  emoji: '🚗', keywords: ['uber','taxi','99','ônibus','metrô','gasolina','combustível','estacionamento','pedágio','passagem'], type: 'saida', sort_order: 2 },
        { id: 'd-health',    name: 'Saúde',       emoji: '💊', keywords: ['farmácia','remédio','médico','hospital','consulta','dentista','exame','plano','academia','drogaria'], type: 'saida', sort_order: 3 },
        { id: 'd-home',      name: 'Moradia',     emoji: '🏠', keywords: ['aluguel','condomínio','água','luz','energia','internet','gás','telefone','celular','netflix','streaming'], type: 'saida', sort_order: 4 },
        { id: 'd-edu',       name: 'Educação',    emoji: '📚', keywords: ['escola','faculdade','curso','livro','mensalidade','aula','universidade','inglês','treinamento'], type: 'saida', sort_order: 5 },
        { id: 'd-leisure',   name: 'Lazer',       emoji: '🎮', keywords: ['cinema','show','spotify','jogo','game','balada','festa','viagem','hotel','passeio'], type: 'saida', sort_order: 6 },
        { id: 'd-clothes',   name: 'Vestuário',   emoji: '👕', keywords: ['roupa','calçado','tênis','sapato','camisa','calça','vestido','casaco'], type: 'saida', sort_order: 7 },
        { id: 'd-pix',       name: 'PIX',         emoji: '💸', keywords: ['pix','transferência','ted','doc'], type: 'both',    sort_order: 8 },
        { id: 'd-salary',    name: 'Salário',     emoji: '💰', keywords: ['salário','salario','holerite','freela','freelance','vencimento','remuneração'], type: 'entrada', sort_order: 9 },
        { id: 'd-other',     name: 'Outros',      emoji: '📦', keywords: [], type: 'both', sort_order: 99 }
    ],

    // ── Helpers para overrides de categorias padrão ──────────────────────────
    _isDefaultId(id) {
        return typeof id === 'string' && id.startsWith('d-');
    },
    _getCatOverrides() {
        try { return JSON.parse(localStorage.getItem('cat_overrides') || '{}'); } catch { return {}; }
    },
    _getCatHidden() {
        try { return JSON.parse(localStorage.getItem('cat_hidden') || '[]'); } catch { return []; }
    },
    _applyOverrides(cats) {
        const overrides = this._getCatOverrides();
        const hidden    = this._getCatHidden();
        return cats
            .filter(c => !hidden.includes(c.id))
            .map(c => overrides[c.id] ? { ...c, ...overrides[c.id] } : c);
    },

    async getCategories() {
        if (this.isCloud) {
            const uid = this.userId();
            const { data, error } = await this.db
                .from('categories')
                .select('*')
                .or(`user_id.is.null,user_id.eq.${uid}`)
                .order('sort_order', { ascending: true })
                .order('name',       { ascending: true });
            if (error) throw error;
            return this._applyOverrides(data ?? []);
        }
        const d = this._localGet();
        const all = [...this._defaultCategories, ...(d.categories || [])];
        return this._applyOverrides(all);
    },

    async createCategory(name, emoji, keywords, type) {
        if (this.isCloud) {
            const { data, error } = await this.db
                .from('categories')
                .insert({ name, emoji, keywords, type, user_id: this.userId() })
                .select().single();
            if (error) throw error;
            return data;
        }
        const d = this._localGet();
        if (!d.categories) d.categories = [];
        const cat = { id: Date.now().toString(), name, emoji, keywords, type, sort_order: 99, user_id: 'local' };
        d.categories.push(cat);
        this._localSave(d);
        return cat;
    },

    async updateCategory(id, updates) {
        // Categorias padrão: salva override em localStorage (não altera o Supabase)
        if (this._isDefaultId(id)) {
            const overrides = this._getCatOverrides();
            overrides[id] = { ...(overrides[id] || {}), ...updates };
            localStorage.setItem('cat_overrides', JSON.stringify(overrides));
            return;
        }
        if (this.isCloud) {
            const { error } = await this.db
                .from('categories').update(updates).eq('id', id).eq('user_id', this.userId());
            if (error) throw error;
            return;
        }
        const d = this._localGet();
        const idx = (d.categories || []).findIndex(c => c.id === id);
        if (idx !== -1) { d.categories[idx] = { ...d.categories[idx], ...updates }; this._localSave(d); }
    },

    async deleteCategory(id) {
        // Categorias padrão: marca como oculta em localStorage
        if (this._isDefaultId(id)) {
            const hidden = this._getCatHidden();
            if (!hidden.includes(id)) { hidden.push(id); localStorage.setItem('cat_hidden', JSON.stringify(hidden)); }
            return;
        }
        if (this.isCloud) {
            const { error } = await this.db
                .from('categories').delete().eq('id', id).eq('user_id', this.userId());
            if (error) throw error;
            return;
        }
        const d = this._localGet();
        d.categories = (d.categories || []).filter(c => c.id !== id);
        this._localSave(d);
    },

    restoreDefaultCategories() {
        localStorage.removeItem('cat_overrides');
        localStorage.removeItem('cat_hidden');
    },

    // ── Transactions ──────────────────────────────────────────────────────────
    async bulkAddTransactions(transactions) {
        if (this.isCloud) {
            const base = {
                user_id:           this.userId(),
                inserted_by_email: Auth?.user?.email ?? null,
                ...(this.activeFinancaId ? { financa_id: this.activeFinancaId } : {})
            };
            const payload = transactions.map(t => ({ ...base, ...t }));
            for (let i = 0; i < payload.length; i += 50) {
                const { error } = await this.db.from('transactions').insert(payload.slice(i, i + 50));
                if (error) throw error;
            }
            return;
        }
        const d = this._localGet();
        for (const t of transactions) {
            if (!t.date) t.date = new Date().toISOString().split('T')[0];
            d.transactions.unshift({ ...t, id: Date.now().toString() + Math.random(), created_at: new Date().toISOString() });
        }
        this._localSave(d);
    },

    async addTransaction(t) {
        if (!t.date) t.date = new Date().toISOString().split('T')[0];
        if (this.isCloud) {
            const payload = { ...t, user_id: this.userId() };
            if (this.activeFinancaId) payload.financa_id = this.activeFinancaId;
            const { data, error } = await this.db
                .from('transactions').insert(payload).select().single();
            if (error) throw error;
            return data;
        }
        return this._localAdd(t);
    },

    async updateTransaction(id, updates) {
        if (this.isCloud) {
            const { error } = await this.db.from('transactions').update(updates).eq('id', id);
            if (error) throw error;
            return;
        }
        const data = this._localGet();
        const idx = data.transactions.findIndex(t => t.id === id);
        if (idx !== -1) { data.transactions[idx] = { ...data.transactions[idx], ...updates }; this._localSave(data); }
    },

    async deleteTransaction(id) {
        if (this.isCloud) {
            const { error } = await this.db.from('transactions').delete().eq('id', id);
            if (error) throw error;
            return;
        }
        const data = this._localGet();
        data.transactions = data.transactions.filter(t => t.id !== id);
        this._localSave(data);
    },

    async getTransactions(filters = {}) {
        if (this.isCloud) {
            let q = this.db
                .from('transactions')
                .select('*')
                .order('date',       { ascending: false })
                .order('created_at', { ascending: false });

            if (this.activeFinancaId) {
                q = q.eq('financa_id', this.activeFinancaId);
            } else {
                q = q.eq('user_id', this.userId());
            }

            if (filters.type)  q = q.eq('type', filters.type);
            if (filters.month) {
                const [y, m] = filters.month.split('-');
                const from   = `${y}-${m}-01`;
                const to     = new Date(+y, +m, 0).toISOString().split('T')[0];
                q = q.gte('date', from).lte('date', to);
            }

            const { data, error } = await q;
            if (error) throw error;
            return data ?? [];
        }
        return this._localFilter(filters);
    },

    async getSummary(month = null) {
        const list    = await this.getTransactions(month ? { month } : {});
        const income  = list.filter(t => t.type === 'entrada').reduce((s, t) => s + Number(t.value), 0);
        const expense = list.filter(t => t.type === 'saida').reduce((s, t)   => s + Number(t.value), 0);
        return { income, expense, balance: income - expense, count: list.length };
    },

    async getCategoryTotals(month = null) {
        const list   = await this.getTransactions(month ? { month } : {});
        const totals = {};
        for (const t of list) {
            if (!totals[t.category]) totals[t.category] = { income: 0, expense: 0 };
            if (t.type === 'entrada') totals[t.category].income  += Number(t.value);
            else                      totals[t.category].expense += Number(t.value);
        }
        return totals;
    }
};
