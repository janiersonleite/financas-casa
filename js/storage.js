// ─── Storage ── Supabase (cloud) com fallback para localStorage ───────────────
const Storage = {
    LOCAL_KEY:    'financas_data',
    QUEUE_KEY:    'offline_queue',
    CACHE_TX_KEY: 'offline_txcache',
    CACHE_FIN_KEY:'offline_fincache',
    CACHE_CAT_KEY:'offline_catcache',
    CUSTOM_TYPES_KEY: 'custom_tx_types',

    // ── Tipos fixos (não editáveis) ───────────────────────────────────────────
    _fixedTypes: [
        { id: 'saida',   name: 'Saída (Gasto)',    behavior: 'subtrai', emoji: '💸', color: 'red',   fixed: true },
        { id: 'entrada', name: 'Entrada (Receita)', behavior: 'soma',    emoji: '💰', color: 'green', fixed: true },
    ],

    getCustomTypes() {
        const fid = this.activeFinancaId && this.activeFinancaId !== 'null' ? this.activeFinancaId : null;
        try {
            let all = JSON.parse(localStorage.getItem(this.CUSTOM_TYPES_KEY) || '[]');
            // Migra IDs antigos que ultrapassam VARCHAR(10)
            let dirty = false;
            all = all.map(t => {
                if (t.id && t.id.length > 10) {
                    dirty = true;
                    return { ...t, id: 'ct' + t.id.replace(/\D/g, '').slice(-6) };
                }
                return t;
            });
            if (dirty) localStorage.setItem(this.CUSTOM_TYPES_KEY, JSON.stringify(all));
            // Filtra pelo perfil ativo (financa_id null = pessoal)
            return all.filter(t => (t.financa_id || null) === fid);
        } catch { return []; }
    },

    _saveCustomTypes(list) {
        // Preserva tipos de outros perfis, substitui apenas os do perfil ativo
        const fid = this.activeFinancaId && this.activeFinancaId !== 'null' ? this.activeFinancaId : null;
        try {
            const all     = JSON.parse(localStorage.getItem(this.CUSTOM_TYPES_KEY) || '[]');
            const others  = all.filter(t => (t.financa_id || null) !== fid);
            const updated = [...others, ...list.map(t => ({ ...t, financa_id: fid }))];
            localStorage.setItem(this.CUSTOM_TYPES_KEY, JSON.stringify(updated));
        } catch {}
    },

    async getTransactionTypes() {
        return [...this._fixedTypes, ...this.getCustomTypes()];
    },

    // Busca um tipo pelo ID em TODOS os perfis do localStorage (fallback cross-perfil)
    findCustomTypeById(id) {
        // 1. Tenta no perfil ativo primeiro
        const inActive = this.getCustomTypes().find(t => t.id === id);
        if (inActive) return inActive;
        // 2. Varre todas as chaves de tipos no localStorage
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith(this.CUSTOM_TYPES_KEY)) continue;
            try {
                const list = JSON.parse(localStorage.getItem(key) || '[]');
                const found = list.find(t => t.id === id);
                if (found) return found;
            } catch (_) {}
        }
        return null;
    },

    // Retorna todos os tipos únicos de todos os perfis (para o gráfico do resumo)
    getAllCustomTypesForChart() {
        const seen = new Set();
        const result = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith(this.CUSTOM_TYPES_KEY)) continue;
            try {
                const list = JSON.parse(localStorage.getItem(key) || '[]');
                for (const t of list) {
                    if (!seen.has(t.id)) { seen.add(t.id); result.push(t); }
                }
            } catch (_) {}
        }
        return result;
    },

    // Carrega tipos do Supabase e sincroniza com localStorage (chamado no init e troca de perfil)
    async syncCustomTypesFromCloud() {
        if (!this.isCloud || !this.isOnline) return;
        try {
            const fid = this.activeFinancaId && this.activeFinancaId !== 'null' ? this.activeFinancaId : null;
            let q = this.db.from('transaction_types').select('*');
            if (fid) q = q.eq('financa_id', fid);
            else     q = q.eq('user_id', this.userId()).is('financa_id', null);
            const { data, error } = await q;
            if (error || !data) return;
            // Mescla com tipos locais do perfil ativo, sem duplicar
            const existing = this.getCustomTypes();
            const merged   = [...existing];
            for (const row of data) {
                const localId = row.custom_id || ('ct' + (row.id || '').replace(/\D/g, '').slice(-6));
                if (!merged.find(t => t._supabaseId === row.id || t.id === localId)) {
                    merged.push({ id: localId, name: row.name, behavior: row.behavior, emoji: row.emoji, color: row.color, financa_id: fid || null, _supabaseId: row.id });
                }
            }
            this._saveCustomTypes(merged);
        } catch (_) {}
    },

    async createTransactionType(name, behavior, emoji, color) {
        // ID curto (≤10 chars) para caber no VARCHAR(10) da coluna transactions.type
        // NÃO sobrescreve com UUID do Supabase — nosso ID curto é o canônico
        const fid = this.activeFinancaId && this.activeFinancaId !== 'null' ? this.activeFinancaId : null;
        const t = { id: 'ct' + Date.now().toString(36).slice(-6), name, behavior, emoji, color, financa_id: fid };
        if (this.isCloud) {
            try {
                const payload = { name, behavior, emoji, color, user_id: this.userId(), custom_id: t.id };
                if (fid) payload.financa_id = fid;
                const { data } = await this.db.from('transaction_types')
                    .insert(payload).select().single();
                // Guarda o UUID do Supabase separado (para update/delete), mas mantém nosso ID curto
                if (data?.id) t._supabaseId = data.id;
            } catch (_) {}
        }
        const list = this.getCustomTypes();
        list.push(t);
        this._saveCustomTypes(list);
        return t;
    },

    async updateTransactionType(id, updates) {
        if (this.isCloud) {
            try {
                const ct = this.getCustomTypes().find(t => t.id === id);
                const supaId = ct?._supabaseId || null;
                if (supaId) {
                    await this.db.from('transaction_types').update(updates).eq('id', supaId).eq('user_id', this.userId());
                } else {
                    // fallback: busca pelo nome se não tiver UUID salvo
                    await this.db.from('transaction_types').update(updates).eq('name', ct?.name || id).eq('user_id', this.userId());
                }
            } catch (_) {}
        }
        const list = this.getCustomTypes();
        const idx = list.findIndex(t => t.id === id);
        if (idx !== -1) { list[idx] = { ...list[idx], ...updates }; this._saveCustomTypes(list); }
    },

    async deleteTransactionType(id) {
        if (this.isCloud) {
            try {
                const ct = this.getCustomTypes().find(t => t.id === id);
                const supaId = ct?._supabaseId || null;
                if (supaId) {
                    await this.db.from('transaction_types').delete().eq('id', supaId).eq('user_id', this.userId());
                } else {
                    await this.db.from('transaction_types').delete().eq('name', ct?.name || id).eq('user_id', this.userId());
                }
            } catch (_) {}
        }
        this._saveCustomTypes(this.getCustomTypes().filter(t => t.id !== id));
    },

    getBehavior(typeId) {
        if (typeId === 'entrada') return 'soma';
        if (typeId === 'saida')   return 'subtrai';
        return this.getCustomTypes().find(t => t.id === typeId)?.behavior || 'neutro';
    },
    activeFinancaId: null,

    // ── Helpers ──────────────────────────────────────────────────────────────
    get db() { return window.$sb; },
    get isCloud() { return IS_SUPABASE_CONFIGURED && !!this.db; },
    get isOnline() { return navigator.onLine; },
    userId() { return Auth?.user?.id ?? null; },

    // ── Offline Queue ─────────────────────────────────────────────────────────
    _getQueue() {
        try { return JSON.parse(localStorage.getItem(this.QUEUE_KEY) || '[]'); } catch { return []; }
    },
    _saveQueue(q) { localStorage.setItem(this.QUEUE_KEY, JSON.stringify(q)); },
    _queueOp(op, args, tempId) {
        const q = this._getQueue();
        q.push({ qid: 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2), op, args, tempId: tempId || null, ts: Date.now() });
        this._saveQueue(q);
    },
    pendingCount() { return this._getQueue().length; },

    // ── Offline TX Cache ──────────────────────────────────────────────────────
    _getCachedTx() {
        try { return JSON.parse(localStorage.getItem(this.CACHE_TX_KEY) || '[]'); } catch { return []; }
    },
    _cacheTx(list) { localStorage.setItem(this.CACHE_TX_KEY, JSON.stringify(list)); },
    _mergeTxCache(freshList) {
        const map = new Map(this._getCachedTx().map(t => [t.id, t]));
        for (const t of freshList) map.set(t.id, t);
        this._cacheTx([...map.values()].sort((a, b) => (b.date || '').localeCompare(a.date || '')));
    },

    // ── Offline Finança Cache ─────────────────────────────────────────────────
    _getCachedFin() {
        try { return JSON.parse(localStorage.getItem(this.CACHE_FIN_KEY) || '[]'); } catch { return []; }
    },
    _cacheFin(list) { localStorage.setItem(this.CACHE_FIN_KEY, JSON.stringify(list)); },

    // ── Offline Category Cache ────────────────────────────────────────────────
    _getCachedCat() {
        try { return JSON.parse(localStorage.getItem(this.CACHE_CAT_KEY) || '[]'); } catch { return []; }
    },
    _cacheCat(list) { localStorage.setItem(this.CACHE_CAT_KEY, JSON.stringify(list)); },

    // ── Cache Warm-up (roda ao iniciar online) ────────────────────────────────
    async warmCache() {
        if (!this.isCloud || !this.isOnline) return;

        // Busca todas as transações sem filtro de mês
        let q = this.db
            .from('transactions')
            .select('*')
            .order('date',       { ascending: false })
            .order('created_at', { ascending: false });
        if (this.activeFinancaId) q = q.eq('financa_id', this.activeFinancaId);
        else                      q = q.eq('user_id', this.userId());
        const { data: txData } = await q;
        if (txData) this._mergeTxCache(txData);

        // Categorias (filtra pela finança ativa)
        const uid = this.userId();
        const _fid = (this.activeFinancaId && this.activeFinancaId !== 'null') ? this.activeFinancaId : null;
        let catQ = this.db.from('categories').select('*');
        // Finança compartilhada: busca por financa_id (qualquer membro pode ver)
        // Pessoal: filtra por user_id sem financa_id
        if (_fid) catQ = catQ.eq('financa_id', _fid);
        else      catQ = catQ.eq('user_id', uid).is('financa_id', null);
        const { data: catData } = await catQ;
        if (catData) this._cacheCat(catData);

        // Finanças
        const { data: finData } = await this.db
            .from('financas')
            .select('*')
            .order('created_at', { ascending: true });
        if (finData) this._cacheFin(finData);
    },

    // ── Sync pending ops ──────────────────────────────────────────────────────
    async syncPendingOps() {
        if (!this.isCloud || !this.isOnline) return { synced: 0, failed: 0 };
        const queue = this._getQueue();
        if (!queue.length) return { synced: 0, failed: 0 };

        let synced = 0, failed = 0;
        const doneQids = [];

        for (const item of queue) {
            try {
                if (item.op === 'addTransaction') {
                    const payload = { ...item.args, user_id: this.userId() };
                    delete payload._offline;
                    const { data, error } = await this.db.from('transactions').insert(payload).select().single();
                    if (error) throw error;
                    if (item.tempId && data) {
                        const cached = this._getCachedTx();
                        const idx = cached.findIndex(t => t.id === item.tempId);
                        if (idx !== -1) { cached[idx] = data; this._cacheTx(cached); }
                    }
                } else if (item.op === 'updateTransaction') {
                    const { id, updates } = item.args;
                    const { error } = await this.db.from('transactions').update(updates).eq('id', id);
                    if (error) throw error;
                } else if (item.op === 'deleteTransaction') {
                    const { error } = await this.db.from('transactions').delete().eq('id', item.args.id);
                    if (error) throw error;
                }
                doneQids.push(item.qid);
                synced++;
            } catch (e) {
                console.warn('Sync failed:', item.op, e.message);
                failed++;
            }
        }

        const remaining = queue.filter(q => !doneQids.includes(q.qid));
        this._saveQueue(remaining);
        return { synced, failed };
    },

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
        const safe = (id && id !== 'null') ? id : null;
        this.activeFinancaId = safe;
        if (safe) localStorage.setItem('active_financa_id', safe);
        else      localStorage.removeItem('active_financa_id');
    },

    // ── Finance CRUD ──────────────────────────────────────────────────────────
    async getFinancas() {
        if (this.isCloud) {
            if (!this.isOnline) return this._getCachedFin();
            const { data, error } = await this.db
                .from('financas')
                .select('*')
                .order('created_at', { ascending: true });
            if (error) throw error;
            if (data) this._cacheFin(data);
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
        const fid = (this.activeFinancaId && this.activeFinancaId !== 'null') ? this.activeFinancaId : null;
        const cacheKey = 'cat_cache_' + (fid || 'personal');
        const _getCached = () => { try { return JSON.parse(localStorage.getItem(cacheKey) || '[]'); } catch { return []; } };
        const _setCache  = d  => { try { localStorage.setItem(cacheKey, JSON.stringify(d)); } catch {} };

        if (this.isCloud) {
            if (!this.isOnline) {
                return this._applyOverrides(_getCached());
            }
            let q = this.db.from('categories').select('*');
            // Finança compartilhada: busca por financa_id (qualquer membro pode ver)
            // Pessoal: filtra por user_id sem financa_id
            if (fid) q = q.eq('financa_id', fid);
            else     q = q.eq('user_id', this.userId()).is('financa_id', null);
            q = q.order('name', { ascending: true });
            const { data, error } = await q;
            if (error) throw error;
            if (data) _setCache(data);
            return this._applyOverrides(data ?? []);
        }
        // Modo local: categorias separadas por finança
        const d = this._localGet();
        const all = (d.categories || []).filter(c => (fid ? c.financa_id === fid : !c.financa_id));
        return this._applyOverrides(all);
    },

    // Busca categorias de uma finança específica (independente da ativa)
    async getCategoriesForFinanca(fid) {
        const safeFid = (fid && fid !== 'null') ? fid : null;
        if (this.isCloud) {
            let q = this.db.from('categories').select('*');
            if (safeFid) q = q.eq('financa_id', safeFid);
            else         q = q.eq('user_id', this.userId()).is('financa_id', null);
            q = q.order('name', { ascending: true });
            const { data, error } = await q;
            if (error) throw error;
            return data ?? [];
        }
        const d = this._localGet();
        return (d.categories || []).filter(c => safeFid ? c.financa_id === safeFid : !c.financa_id);
    },

    async createCategory(name, emoji, keywords, type) {
        const fid = (this.activeFinancaId && this.activeFinancaId !== 'null') ? this.activeFinancaId : null;
        if (this.isCloud) {
            const payload = { name, emoji, keywords, type, user_id: this.userId() };
            if (fid) payload.financa_id = fid;
            const { data, error } = await this.db
                .from('categories')
                .insert(payload)
                .select().single();
            if (error) throw error;
            return data;
        }
        const d = this._localGet();
        if (!d.categories) d.categories = [];
        const cat = { id: Date.now().toString(), name, emoji, keywords, type, sort_order: 99, user_id: 'local', ...(fid ? { financa_id: fid } : {}) };
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

    // ── Reminders ─────────────────────────────────────────────────────────────
    REMINDERS_KEY: 'user_reminders',

    _getLocalReminders() {
        try { return JSON.parse(localStorage.getItem(this.REMINDERS_KEY) || '[]'); } catch { return []; }
    },
    _saveLocalReminders(list) {
        localStorage.setItem(this.REMINDERS_KEY, JSON.stringify(list));
    },

    async getReminders() {
        const fid = (this.activeFinancaId && this.activeFinancaId !== 'null') ? this.activeFinancaId : null;
        if (this.isCloud) {
            try {
                let q = this.db.from('reminders').select('*').eq('active', true);
                // Finança compartilhada: busca por financa_id (qualquer membro pode ver)
                // Pessoal: filtra por user_id sem financa_id
                if (fid) q = q.eq('financa_id', fid);
                else     q = q.eq('user_id', this.userId()).is('financa_id', null);
                q = q.order('day', { ascending: true });
                const { data, error } = await q;
                if (error) throw error;
                // Sincroniza cache local
                const all = this._getLocalReminders().filter(r => r._localOnly);
                this._saveLocalReminders([...(data ?? []), ...all]);
                return data ?? [];
            } catch (_) {}
        }
        // Local fallback: filtra por finança
        return this._getLocalReminders().filter(r => fid ? r.financa_id === fid : !r.financa_id);
    },

    // Busca lembretes de uma finança específica (independente da ativa)
    async getRemindersForFinanca(fid) {
        const safeFid = (fid && fid !== 'null') ? fid : null;
        if (this.isCloud) {
            try {
                let q = this.db.from('reminders').select('*').eq('active', true);
                if (safeFid) q = q.eq('financa_id', safeFid);
                else         q = q.eq('user_id', this.userId()).is('financa_id', null);
                q = q.order('day', { ascending: true });
                const { data, error } = await q;
                if (error) throw error;
                return data ?? [];
            } catch (_) { return []; }
        }
        return this._getLocalReminders().filter(r => safeFid ? r.financa_id === safeFid : !r.financa_id);
    },

    async createReminder({ name, day, amount, category, type, emoji, financa_id }) {
        const fid = financa_id ?? ((this.activeFinancaId && this.activeFinancaId !== 'null') ? this.activeFinancaId : null);
        const localId = 'rem_' + Date.now().toString(36);
        const base = { name, day: Number(day), amount: Number(amount) || 0, category: category || '', type: type || 'saida', emoji: emoji || '🔔', active: true };
        if (this.isCloud) {
            try {
                const payload = { ...base, user_id: this.userId(), ...(fid ? { financa_id: fid } : {}) };
                const { data, error } = await this.db.from('reminders').insert(payload).select().single();
                if (error) throw error;
                const list = this._getLocalReminders();
                list.push(data);
                this._saveLocalReminders(list);
                return data;
            } catch (_) {}
        }
        const rem = { ...base, id: localId, user_id: 'local', _localOnly: true, ...(fid ? { financa_id: fid } : {}), created_at: new Date().toISOString() };
        const list = this._getLocalReminders();
        list.push(rem);
        this._saveLocalReminders(list);
        return rem;
    },

    async updateReminder(id, updates) {
        if (this.isCloud) {
            try { await this.db.from('reminders').update(updates).eq('id', id).eq('user_id', this.userId()); } catch (_) {}
        }
        const list = this._getLocalReminders();
        const idx = list.findIndex(r => r.id === id);
        if (idx !== -1) { list[idx] = { ...list[idx], ...updates }; this._saveLocalReminders(list); }
    },

    async deleteReminder(id) {
        if (this.isCloud) {
            try { await this.db.from('reminders').delete().eq('id', id).eq('user_id', this.userId()); } catch (_) {}
        }
        this._saveLocalReminders(this._getLocalReminders().filter(r => r.id !== id));
    },

    // ── Transactions ──────────────────────────────────────────────────────────
    async bulkAddTransactions(transactions) {
        if (this.isCloud) {
            const base = {
                user_id:           this.userId(),
                inserted_by_email: Auth?.user?.email ?? null,
                ...(this.activeFinancaId ? { financa_id: this.activeFinancaId } : {})
            };
            const payload = transactions.map(t => {
                const { _rawType, _offline, _constraintFallback, ...clean } = t;
                return { ...base, ...clean };
            });
            for (let i = 0; i < payload.length; i += 50) {
                const { error } = await this.db.from('transactions').insert(payload.slice(i, i + 50));
                if (error) {
                    // CHECK constraint ainda existe no Supabase → salva localmente e enfileira para sync
                    if (error.message?.includes('type_check') || error.message?.includes('check constraint') || error.message?.includes('violates check')) {
                        const batch = payload.slice(i, i + 50);
                        const d = this._localGet();
                        for (const tx of batch) {
                            const tempId = 'temp_' + Date.now() + '_' + Math.random().toString(36).slice(2);
                            d.transactions.unshift({ ...tx, id: tempId, created_at: new Date().toISOString(), _offline: true, _constraintFallback: true });
                        }
                        this._localSave(d);
                        // Não lança erro — continua os próximos batches
                        continue;
                    }
                    throw error;
                }
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
        // _targetFinancaId: finança escolhida pontualmente (não altera activeFinancaId globalmente)
        const targetFid = t._targetFinancaId !== undefined
            ? (t._targetFinancaId || null)
            : (this.activeFinancaId && this.activeFinancaId !== 'null' ? this.activeFinancaId : null);
        if (this.isCloud) {
            if (!this.isOnline) {
                const tempId = 'temp_' + Date.now();
                const tx = { ...t, id: tempId, user_id: this.userId(), financa_id: targetFid, created_at: new Date().toISOString(), _offline: true };
                const cached = this._getCachedTx();
                cached.unshift(tx);
                this._cacheTx(cached);
                this._queueOp('addTransaction', { ...t, financa_id: targetFid }, tempId);
                return tx;
            }
            const { _rawType, _offline, _constraintFallback, _targetFinancaId, ...tClean } = t;
            const payload = { ...tClean, user_id: this.userId(), inserted_by_email: Auth?.user?.email ?? null };
            if (targetFid) payload.financa_id = targetFid;
            const { data, error } = await this.db
                .from('transactions').insert(payload).select().single();
            if (error) {
                // Constraint de tipo customizado ainda não removida → salva local + fila
                if (error.message?.includes('type_check') || error.message?.includes('check constraint')) {
                    const tempId = 'temp_' + Date.now();
                    const tx = { ...t, id: tempId, user_id: this.userId(), financa_id: this.activeFinancaId, created_at: new Date().toISOString(), _offline: true };
                    const cached = this._getCachedTx(); cached.unshift(tx); this._cacheTx(cached);
                    this._queueOp('addTransaction', { ...t, financa_id: this.activeFinancaId }, tempId);
                    tx._constraintFallback = true;
                    return tx;
                }
                throw error;
            }
            const cached = this._getCachedTx(); cached.unshift(data); this._cacheTx(cached);
            return data;
        }
        // Local mode: strip internal fields before saving
        const { _rawType, _offline, _constraintFallback, _targetFinancaId, ...tLocal } = t;
        if (targetFid) tLocal.financa_id = targetFid;
        return this._localAdd(tLocal);
    },

    async updateTransaction(id, updates) {
        if (this.isCloud) {
            const isTemp = id.startsWith('temp_');
            if (!this.isOnline || isTemp) {
                const cached = this._getCachedTx();
                const idx = cached.findIndex(t => t.id === id);
                if (idx !== -1) { cached[idx] = { ...cached[idx], ...updates }; this._cacheTx(cached); }
                if (isTemp) {
                    const q = this._getQueue();
                    const opIdx = q.findIndex(item => item.op === 'addTransaction' && item.tempId === id);
                    if (opIdx !== -1) { q[opIdx].args = { ...q[opIdx].args, ...updates }; this._saveQueue(q); }
                } else {
                    this._queueOp('updateTransaction', { id, updates });
                }
                return;
            }
            const { error } = await this.db.from('transactions').update(updates).eq('id', id);
            if (error) throw error;
            const cached = this._getCachedTx();
            const idx = cached.findIndex(t => t.id === id);
            if (idx !== -1) { cached[idx] = { ...cached[idx], ...updates }; this._cacheTx(cached); }
            return;
        }
        const data = this._localGet();
        const idx = data.transactions.findIndex(t => t.id === id);
        if (idx !== -1) { data.transactions[idx] = { ...data.transactions[idx], ...updates }; this._localSave(data); }
    },

    async deleteTransaction(id) {
        if (this.isCloud) {
            const isTemp = id.startsWith('temp_');
            if (!this.isOnline || isTemp) {
                this._cacheTx(this._getCachedTx().filter(t => t.id !== id));
                if (isTemp) {
                    this._saveQueue(this._getQueue().filter(item => !(item.op === 'addTransaction' && item.tempId === id)));
                } else {
                    this._queueOp('deleteTransaction', { id });
                }
                return;
            }
            const { error } = await this.db.from('transactions').delete().eq('id', id);
            if (error) throw error;
            this._cacheTx(this._getCachedTx().filter(t => t.id !== id));
            return;
        }
        const data = this._localGet();
        data.transactions = data.transactions.filter(t => t.id !== id);
        this._localSave(data);
    },

    async getTransactions(filters = {}) {
        if (this.isCloud) {
            if (!this.isOnline) {
                let list = this._getCachedTx();
                const uid = this.userId();
                list = this.activeFinancaId
                    ? list.filter(t => t.financa_id === this.activeFinancaId)
                    : list.filter(t => t.user_id === uid);
                if (filters.type) list = list.filter(t => t.type === filters.type);
                if (filters.month) {
                    const [y, m] = filters.month.split('-');
                    const from = `${y}-${m}-01`;
                    const to   = new Date(+y, +m, 0).toISOString().split('T')[0];
                    list = list.filter(t => t.date >= from && t.date <= to);
                }
                return list;
            }

            let q = this.db
                .from('transactions')
                .select('*')
                .order('date',       { ascending: false })
                .order('created_at', { ascending: false });

            const _fid = (this.activeFinancaId && this.activeFinancaId !== 'null') ? this.activeFinancaId : null;
            if (_fid) {
                q = q.eq('financa_id', _fid);
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
            if (data) this._mergeTxCache(data);
            return data ?? [];
        }
        return this._localFilter(filters);
    },

    async getSummary(month = null) {
        const list    = await this.getTransactions(month ? { month } : {});
        const income  = list.filter(t => this.getBehavior(t.type) === 'soma').reduce((s, t) => s + Number(t.value), 0);
        const expense = list.filter(t => this.getBehavior(t.type) === 'subtrai').reduce((s, t) => s + Number(t.value), 0);
        return { income, expense, balance: income - expense, count: list.length };
    },

    async getCategoryTotals(month = null) {
        const list   = await this.getTransactions(month ? { month } : {});
        const totals = {};
        for (const t of list) {
            const beh = this.getBehavior(t.type);
            if (beh === 'neutro') continue;
            if (!totals[t.category]) totals[t.category] = { income: 0, expense: 0 };
            if (beh === 'soma') totals[t.category].income  += Number(t.value);
            else                totals[t.category].expense += Number(t.value);
        }
        return totals;
    }
};
