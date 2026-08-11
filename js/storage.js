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
        if (catData) {
            // Usa a MESMA chave que getCategories() lê (por finança) — evita mismatch
            const catCacheKey = 'cat_cache_' + (_fid || 'personal');
            try { localStorage.setItem(catCacheKey, JSON.stringify(catData)); } catch {}
        }

        // Finanças
        const { data: finData } = await this.db
            .from('financas')
            .select('*')
            .order('created_at', { ascending: true });
        if (finData) this._cacheFin(finData);
    },

    // ── Sync pending ops ──────────────────────────────────────────────────────
    // Campos internos que NÃO devem ir para o Supabase
    _INTERNAL_FIELDS: ['_offline', '_rawType', '_constraintFallback', '_targetFinancaId'],

    _cleanPayload(args) {
        const p = { ...args };
        for (const f of this._INTERNAL_FIELDS) delete p[f];
        // IDs temporários nunca devem ser enviados como id real
        if (typeof p.id === 'string' && p.id.startsWith('temp_')) delete p.id;
        return p;
    },

    async syncPendingOps() {
        if (!this.isCloud || !this.isOnline) return { synced: 0, failed: 0 };
        const queue = this._getQueue();
        if (!queue.length) return { synced: 0, failed: 0 };

        let synced = 0, failed = 0;
        const doneQids = [];

        for (const item of queue) {
            try {
                if (item.op === 'addTransaction') {
                    const payload = this._cleanPayload({
                        ...item.args,
                        user_id:           this.userId(),
                        inserted_by_email: Auth?.user?.email ?? null,
                    });
                    const { data, error } = await this.db.from('transactions').insert(payload).select().single();
                    if (error) throw error;
                    // Substitui o tempId no cache pelo ID real do Supabase
                    if (item.tempId && data) {
                        const cached = this._getCachedTx();
                        const idx = cached.findIndex(t => t.id === item.tempId);
                        if (idx !== -1) { cached[idx] = data; this._cacheTx(cached); }
                    }
                } else if (item.op === 'updateTransaction') {
                    const { id, updates } = item.args;
                    if (!id || id.startsWith('temp_')) { doneQids.push(item.qid); continue; } // tempId não existe no servidor
                    const cleanUpdates = this._cleanPayload(updates);
                    const { error } = await this.db.from('transactions').update(cleanUpdates).eq('id', id);
                    if (error) throw error;
                } else if (item.op === 'deleteTransaction') {
                    if (!item.args.id || item.args.id.startsWith('temp_')) { doneQids.push(item.qid); continue; }
                    const { error } = await this.db.from('transactions').delete().eq('id', item.args.id);
                    if (error) throw error;
                }
                doneQids.push(item.qid);
                synced++;
            } catch (e) {
                console.warn('Sync failed:', item.op, e.message, '| payload:', item.args);
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

    // ── Grupos de recorrência (localStorage — set de group_ids marcados como recorrentes) ──
    _RECURRING_KEY: 'recurring_groups',
    _getRecurringGroups() {
        try { return new Set(JSON.parse(localStorage.getItem(this._RECURRING_KEY) || '[]')); } catch { return new Set(); }
    },
    _saveRecurringGroups(set) {
        try { localStorage.setItem(this._RECURRING_KEY, JSON.stringify([...set])); } catch {}
    },
    isRecurringGroup(groupId) {
        if (!groupId) return false;
        if (typeof groupId === 'string' && groupId.startsWith('rec_')) return true; // convenção do prefixo
        return this._getRecurringGroups().has(groupId);
    },
    markRecurringGroup(groupId, isRecurring = true) {
        if (!groupId) return;
        const set = this._getRecurringGroups();
        if (isRecurring) set.add(groupId);
        else             set.delete(groupId);
        this._saveRecurringGroups(set);
    },
    // Encerra a recorrência: apaga transações do grupo com data >= fromDate.
    async endRecurringGroup(groupId, fromDate) {
        if (!groupId) return { deleted: 0 };
        const all = await this.getTransactions();
        const toDelete = all.filter(t =>
            t.installment_group_id === groupId &&
            t.date && t.date >= fromDate
        );
        for (const t of toDelete) {
            try { await this.deleteTransaction(t.id); } catch (_) {}
        }
        // Se não sobrou nenhuma transação no grupo, remove a marca
        const remaining = all.filter(t => t.installment_group_id === groupId && (!t.date || t.date < fromDate));
        if (!remaining.length) this.markRecurringGroup(groupId, false);
        return { deleted: toDelete.length };
    },

    // ── Pendências dispensadas (não reaparecem após o usuário ignorar) ────────
    _DISMISSED_KEY: 'pendings_dismissed',
    _getDismissed() {
        try { return new Set(JSON.parse(localStorage.getItem(this._DISMISSED_KEY) || '[]')); } catch { return new Set(); }
    },
    _saveDismissed(set) {
        try { localStorage.setItem(this._DISMISSED_KEY, JSON.stringify([...set])); } catch {}
    },
    isPendingDismissed(key) {
        return this._getDismissed().has(key);
    },
    dismissPending(key) {
        const set = this._getDismissed();
        set.add(key);
        this._saveDismissed(set);
    },
    restorePending(key) {
        const set = this._getDismissed();
        set.delete(key);
        this._saveDismissed(set);
    },
    clearAllDismissedPendings() {
        try { localStorage.removeItem(this._DISMISSED_KEY); } catch {}
    },

    // ── Metas por categoria (localStorage por finança) ────────────────────────
    _goalsKey(fid) {
        return 'category_goals_' + (fid || 'personal');
    },
    getGoals() {
        const fid = (this.activeFinancaId && this.activeFinancaId !== 'null') ? this.activeFinancaId : null;
        try { return JSON.parse(localStorage.getItem(this._goalsKey(fid)) || '{}'); } catch { return {}; }
    },
    setGoals(goals) {
        const fid = (this.activeFinancaId && this.activeFinancaId !== 'null') ? this.activeFinancaId : null;
        try { localStorage.setItem(this._goalsKey(fid), JSON.stringify(goals || {})); } catch {}
    },
    setGoal(category, value) {
        const goals = this.getGoals();
        if (value && value > 0) goals[category] = Number(value);
        else delete goals[category];
        this.setGoals(goals);
    },

    // Busca histórico dos últimos N meses agrupado por mês (para sugestão de metas)
    async getHistoryByMonth(monthsBack = 3) {
        const months = [];
        const today = new Date();
        for (let i = 1; i <= monthsBack; i++) {
            const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
            months.unshift(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
        }
        const result = {};
        for (const m of months) {
            result[m] = await this.getTransactions({ month: m });
        }
        return result;
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
        // Fallback final: categorias padrão (garante que nunca fica sem opções)
        const _defaults  = () => [...this.defaultCategories];

        if (this.isCloud) {
            if (!this.isOnline) {
                // Offline: usa cache por finança; se vazio, usa defaults
                const cached = _getCached();
                return this._applyOverrides(cached.length ? cached : _defaults());
            }
            let q = this.db.from('categories').select('*');
            // Finança compartilhada: busca por financa_id (qualquer membro pode ver)
            // Pessoal: filtra por user_id sem financa_id
            if (fid) q = q.eq('financa_id', fid);
            else     q = q.eq('user_id', this.userId()).is('financa_id', null);
            q = q.order('name', { ascending: true });
            const { data, error } = await q;
            if (error) {
                // Falha de rede (iOS ITP, CORS, timeout): usa cache ou defaults
                console.warn('getCategories Supabase error:', error.message);
                const cached = _getCached();
                return this._applyOverrides(cached.length ? cached : _defaults());
            }
            if (data) _setCache(data);
            // Supabase retornou [] (sem categorias criadas): usa defaults
            return this._applyOverrides(data?.length ? data : _defaults());
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
            // Cache offline por finança (mesma chave que getCategories usa)
            const cacheKey = 'cat_cache_' + (safeFid || 'personal');
            const _getCached = () => { try { return JSON.parse(localStorage.getItem(cacheKey) || '[]'); } catch { return []; } };

            if (!this.isOnline) {
                const cached = _getCached();
                return cached.length ? cached : [...this.defaultCategories];
            }
            let q = this.db.from('categories').select('*');
            if (safeFid) q = q.eq('financa_id', safeFid);
            else         q = q.eq('user_id', this.userId()).is('financa_id', null);
            q = q.order('name', { ascending: true });
            const { data, error } = await q;
            if (error) {
                console.warn('getCategoriesForFinanca error:', error.message);
                const cached = _getCached();
                return cached.length ? cached : [...this.defaultCategories];
            }
            // Atualiza cache e retorna; se vazio, usa defaults
            if (data?.length) {
                try { localStorage.setItem(cacheKey, JSON.stringify(data)); } catch {}
                return data;
            }
            return [...this.defaultCategories];
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
                return this._applyReminderDurations(data ?? []);
            } catch (_) {}
        }
        // Local fallback: filtra por finança
        return this._applyReminderDurations(this._getLocalReminders().filter(r => fid ? r.financa_id === fid : !r.financa_id));
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
                return this._applyReminderDurations(data ?? []);
            } catch (_) { return []; }
        }
        return this._applyReminderDurations(this._getLocalReminders().filter(r => safeFid ? r.financa_id === safeFid : !r.financa_id));
    },

    // ── Durações de lembretes (localStorage — fallback se Supabase não tem a coluna) ──
    _REM_DUR_KEY: 'reminder_durations',
    _REM_START_KEY: 'reminder_start_months',
    _getReminderDurations() {
        try { return JSON.parse(localStorage.getItem(this._REM_DUR_KEY) || '{}'); } catch { return {}; }
    },
    _setReminderDuration(id, months) {
        try {
            const map = this._getReminderDurations();
            if (months && months > 0) map[id] = Number(months);
            else                       delete map[id];
            localStorage.setItem(this._REM_DUR_KEY, JSON.stringify(map));
        } catch {}
    },
    // Mês de início do lembrete: string 'YYYY-MM' ou vazio para usar created_at
    _getReminderStartMonths() {
        try { return JSON.parse(localStorage.getItem(this._REM_START_KEY) || '{}'); } catch { return {}; }
    },
    _setReminderStartMonth(id, ym) {
        try {
            const map = this._getReminderStartMonths();
            if (ym && /^\d{4}-\d{2}$/.test(ym)) map[id] = ym;
            else                                 delete map[id];
            localStorage.setItem(this._REM_START_KEY, JSON.stringify(map));
        } catch {}
    },
    // Aplica duração + mês de início locais em cima de uma lista de reminders
    _applyReminderDurations(list) {
        const durMap   = this._getReminderDurations();
        const startMap = this._getReminderStartMonths();
        return (list || []).map(r => {
            const out = { ...r };
            const localDur   = durMap[r.id];
            const localStart = startMap[r.id];
            // localStorage tem prioridade — fonte da verdade local
            if (localDur   !== undefined) out.duration_months = localDur;
            if (localStart !== undefined) out.start_month     = localStart;
            return out;
        });
    },

    async createReminder({ name, day, amount, category, type, emoji, financa_id, duration_months, start_month }) {
        const fid = financa_id ?? ((this.activeFinancaId && this.activeFinancaId !== 'null') ? this.activeFinancaId : null);
        const localId = 'rem_' + Date.now().toString(36);
        const base = { name, day: Number(day), amount: Number(amount) || 0, category: category || '', type: type || 'saida', emoji: emoji || '🔔', active: true };
        const durMonths  = Number(duration_months) || 0;
        const startMonth = (start_month && /^\d{4}-\d{2}$/.test(start_month)) ? start_month : '';
        if (this.isCloud) {
            try {
                // Tenta enviar com duration_months + start_month; se coluna não existir, faz fallback
                const payloadWithDur = { ...base, user_id: this.userId(), ...(fid ? { financa_id: fid } : {}),
                    ...(durMonths > 0 ? { duration_months: durMonths } : {}),
                    ...(startMonth   ? { start_month: startMonth } : {}) };
                let data, error;
                ({ data, error } = await this.db.from('reminders').insert(payloadWithDur).select().single());
                if (error && /(duration_months|start_month)/i.test(error.message || '')) {
                    // Uma ou ambas colunas ausentes: insere sem os campos custom
                    const { user_id, financa_id, ...rest } = payloadWithDur;
                    delete rest.duration_months;
                    delete rest.start_month;
                    ({ data, error } = await this.db.from('reminders').insert({ ...rest, user_id, ...(fid ? { financa_id } : {}) }).select().single());
                }
                if (error) throw error;
                // Salva no localStorage (fonte da verdade local)
                this._setReminderDuration(data.id, durMonths);
                this._setReminderStartMonth(data.id, startMonth);
                data.duration_months = durMonths;
                if (startMonth) data.start_month = startMonth;
                const list = this._getLocalReminders();
                list.push(data);
                this._saveLocalReminders(list);
                return data;
            } catch (_) {}
        }
        const rem = { ...base, id: localId, user_id: 'local', _localOnly: true, ...(fid ? { financa_id: fid } : {}), created_at: new Date().toISOString(), duration_months: durMonths, ...(startMonth ? { start_month: startMonth } : {}) };
        this._setReminderDuration(localId, durMonths);
        this._setReminderStartMonth(localId, startMonth);
        const list = this._getLocalReminders();
        list.push(rem);
        this._saveLocalReminders(list);
        return rem;
    },

    async updateReminder(id, updates) {
        // duration_months e start_month sempre no localStorage (fonte da verdade local)
        if (Object.prototype.hasOwnProperty.call(updates, 'duration_months')) {
            this._setReminderDuration(id, updates.duration_months);
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'start_month')) {
            this._setReminderStartMonth(id, updates.start_month);
        }
        if (this.isCloud) {
            try {
                await this.db.from('reminders').update(updates).eq('id', id).eq('user_id', this.userId());
            } catch (_) {
                // Se erro de coluna ausente, tenta sem os campos customizados
                const { duration_months, start_month, ...rest } = updates;
                if (Object.keys(rest).length) {
                    try { await this.db.from('reminders').update(rest).eq('id', id).eq('user_id', this.userId()); } catch (__) {}
                }
            }
        }
        const list = this._getLocalReminders();
        const idx = list.findIndex(r => r.id === id);
        if (idx !== -1) { list[idx] = { ...list[idx], ...updates }; this._saveLocalReminders(list); }
    },

    async deleteReminder(id) {
        if (this.isCloud) {
            try { await this.db.from('reminders').delete().eq('id', id).eq('user_id', this.userId()); } catch (_) {}
        }
        this._setReminderDuration(id, 0);   // remove duração do localStorage
        this._setReminderStartMonth(id, ''); // remove mês de início
        this._saveLocalReminders(this._getLocalReminders().filter(r => r.id !== id));
    },

    // ── Transactions ──────────────────────────────────────────────────────────
    async bulkAddTransactions(transactions) {
        if (this.isCloud) {
            const userBase = {
                user_id:           this.userId(),
                inserted_by_email: Auth?.user?.email ?? null,
            };
            const payload = transactions.map(t => {
                // Remove TODOS os campos internos (inclui _targetFinancaId)
                const clean = this._cleanPayload(t);
                // Se a transação tinha _targetFinancaId, usa como financa_id;
                // senão, usa a finança ativa (comportamento anterior)
                const targetFid = t._targetFinancaId !== undefined
                    ? (t._targetFinancaId || null)
                    : (this.activeFinancaId || null);
                return {
                    ...userBase,
                    ...(targetFid ? { financa_id: targetFid } : {}),
                    ...clean,
                };
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

    // ── Detector de "pagamento de cartão" ─────────────────────────────────────
    // Heurística por palavra-chave na descrição ou categoria.
    // Usado para evitar dupla contagem com as parcelas no mesmo mês.
    isCardPayment(t) {
        const text = `${t.description || ''} ${t.category || ''}`
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '');
        return /\b(cartao|fatura)\b/.test(text);
    },

    async getSummary(month = null, options = {}) {
        const list = await this.getTransactions(month ? { month } : {});
        let income  = 0, expense = 0;
        let cardPaymentExcluded = 0;

        // Lógica inteligente: se houver parcelas no mês, ignora os pagamentos de cartão
        // (assume que as parcelas já representam o gasto real)
        const smart = options.smartCardLogic !== false; // ligado por padrão
        const hasInstallments = smart && list.some(t => t.installment_group_id);

        for (const t of list) {
            const beh = this.getBehavior(t.type);
            if (beh === 'soma') {
                income += Number(t.value);
            } else if (beh === 'subtrai') {
                if (hasInstallments && this.isCardPayment(t)) {
                    cardPaymentExcluded += Number(t.value);
                    continue;
                }
                expense += Number(t.value);
            }
        }
        return { income, expense, balance: income - expense, count: list.length, cardPaymentExcluded };
    },

    async getCategoryTotals(month = null, options = {}) {
        const list = await this.getTransactions(month ? { month } : {});
        const totals = {};
        const smart = options.smartCardLogic !== false;
        const hasInstallments = smart && list.some(t => t.installment_group_id);

        for (const t of list) {
            const beh = this.getBehavior(t.type);
            if (beh === 'neutro') continue;
            // Ignora pagamento de cartão quando há parcelas no mês
            if (hasInstallments && beh === 'subtrai' && this.isCardPayment(t)) continue;
            if (!totals[t.category]) totals[t.category] = { income: 0, expense: 0 };
            if (beh === 'soma') totals[t.category].income  += Number(t.value);
            else                totals[t.category].expense += Number(t.value);
        }
        return totals;
    }
};
