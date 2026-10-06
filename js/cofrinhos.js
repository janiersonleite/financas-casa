// ─── Cofrinhos — objetivos de poupança (aba Investir) ───────────────────────
// Dinheiro guardado para objetivos (carro, viagem, reserva...), com depósitos,
// retiradas e extrato. É independente dos lançamentos: NÃO altera o saldo do mês.
// Dados: tabelas `cofrinhos`, `cofrinho_movs` e `cofrinho_categories`
// (supabase/migrations/20261006000001_*, 20261006000002_* e 20261006000003_* [PIX]).
// Escopo: finança ativa (compartilhada = todos os membros) ou pessoal.
const Cofrinhos = {
    // Cores do objetivo: mesmas do conjunto categórico validado do app (dataviz).
    COLORS: ['#1baf7a', '#2a78d6', '#eb6834', '#eda100', '#e87ba4', '#4a3aa7', '#008300', '#e34948'],
    EMOJIS: ['🐷', '🚗', '🏠', '✈️', '🎓', '💍', '🎁', '🛡️', '💻', '🏖️', '🏍️', '👶'],
    // Sugestões de categoria (um toque para criar); as categorias reais são editáveis.
    SUGGESTED_CATEGORIES: ['Pessoal', 'Educação', 'Viagem', 'Casa', 'Carro', 'Reserva'],
    // Séries do gráfico (par validado: ΔE CVD 24.7, contraste ≥ 3:1)
    SERIES: { dep: '#2a78d6', ret: '#eb6834' },
    MONTHS: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
    KIND_LABEL: { inicial: 'Saldo inicial', deposito: 'Depósito', retirada: 'Retirada' },

    view: 'carteira',               // 'carteira' | 'cofrinhos' (subvisão da aba Investir)
    _data: { cofrinhos: [], movs: [], cats: [], mode: 'cloud' },
    _catById: {},                   // categorias por id
    _catEditId: null,               // categoria em edição no gerenciador
    _movsBy: {},                    // movs agrupadas por cofrinho_id (mais recentes primeiro)
    _ui: { q: '', sort: 'recent', cat: '' },
    _detailId: null,
    _detailMsg: '',
    _planPeriod: 'month',
    _editId: null,
    _form: { emoji: '🐷', color: '#1baf7a' },
    _mov: null,                     // { id, kind } do modal de depósito/retirada
    _chart: null,
    _bound: false,

    // ─── Helpers ──────────────────────────────────────────────────────────────
    _ymd(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    },
    _today() { return this._ymd(new Date()); },
    _parseYmd(s) {
        const [y, m, d] = (s || '').split('-').map(Number);
        return new Date(y, (m || 1) - 1, d || 1);
    },
    _round(n) { return Math.round((Number(n) || 0) * 100) / 100; },
    _ceil(n)  { return Math.ceil((Number(n) || 0) * 100 - 1e-9) / 100; },
    _money(v) { return App.formatCurrency(this._round(v)); },
    _esc(s)   { return App._escHtml(s); },
    _safeColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c || '') ? c : this.COLORS[0]; },
    _pctTxt(p) { return p >= 1000 ? '999%+' : (p > 0 && p < 10 ? p.toFixed(1) : Math.round(p)) + '%'; },
    _uid() {
        return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
            : 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    },
    _fid() {
        const f = Storage.activeFinancaId;
        return (f && f !== 'null') ? f : null;
    },
    _cacheKey() { return 'cofrinhos_cache_' + (this._fid() || 'personal'); },
    _isMissingTable(e) {
        const m = (((e && e.message) || '') + ' ' + ((e && e.code) || '')).toLowerCase();
        return /pgrst205|pgrst204|42p01|42703|schema cache|does not exist/.test(m);
    },
    // Qual migração falta: a de categorias (tabela cofrinho_categories / coluna category_id) ou a base.
    _missingFile(e) {
        const m = (e && e.message) || '';
        if (/pix_(key|name|bank)/i.test(m)) return '20261006000003_add_pix_to_cofrinhos.sql';
        return /cofrinho_categories|category_id/i.test(m)
            ? '20261006000002_create_cofrinho_categories.sql' : '20261006000001_create_cofrinhos.sql';
    },

    // ─── Chave PIX do cofrinho (opcional) ─────────────────────────────────────
    // Só envia as colunas de PIX quando há o que gravar (ou o que limpar): quem não usa
    // PIX continua salvando normalmente mesmo sem a migração 3 aplicada.
    _pixFields(f, prev = null) {
        const key = (f.pixKey || '').trim(), name = this._normName(f.pixName), bank = this._normName(f.pixBank);
        const had = prev && (prev.pix_key || prev.pix_name || prev.pix_bank);
        if (!key && !name && !bank && !had) return {};
        return { pix_key: key || null, pix_name: name || null, pix_bank: bank || null };
    },

    // Copia texto; o botão mostra "✅ Copiado" (um toast ficaria atrás dos modais).
    async _copy(text, btn) {
        let ok = false;
        try { await navigator.clipboard.writeText(text); ok = true; }
        catch {
            const ta = document.createElement('textarea');
            ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
            document.body.appendChild(ta); ta.select();
            try { ok = document.execCommand('copy'); } catch {}
            ta.remove();
        }
        if (btn) {
            const old = btn.dataset.label || (btn.dataset.label = btn.textContent);
            btn.textContent = ok ? '✅ Copiado' : '⚠️ Não foi possível copiar';
            clearTimeout(btn._t); btn._t = setTimeout(() => { btn.textContent = old; }, 2000);
        }
        return ok;
    },

    // Bloco "Depositar por PIX" (detalhe e tela de depósito); vazio sem chave
    _pixBlockHtml(c, copyAttr) {
        if (!c.pix_key) return '';
        const type = App._pixKeyType ? App._pixKeyType(c.pix_key) : '';
        const who = [c.pix_name, c.pix_bank].filter(Boolean).map(x => this._esc(x)).join(' · ');
        return `
            <div class="flex items-center justify-between gap-2 mb-1">
                <p class="text-sm font-semibold text-gray-700">🔑 Depositar por PIX</p>
                ${type ? `<span class="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">${this._esc(type)}</span>` : ''}
            </div>
            <p class="font-mono text-sm text-gray-800 break-all">${this._esc(c.pix_key)}</p>
            ${who ? `<p class="text-xs text-gray-500 mt-1">${who}</p>` : ''}
            <button type="button" ${copyAttr} class="mt-2 w-full py-2 rounded-xl border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-gray-50">📋 Copiar chave</button>`;
    },
    _assertWritable() {
        if (Storage.isCloud && !Storage.isOnline) throw new Error('Sem conexão. Tente novamente quando estiver online.');
    },

    // ─── Dados ────────────────────────────────────────────────────────────────
    async load() {
        const fid = this._fid();
        if (!Storage.isCloud) {
            const d = Storage._localGet();
            const cofrinhos = (d.cofrinhos || []).filter(c => (fid ? c.financa_id === fid : !c.financa_id));
            const ids = new Set(cofrinhos.map(c => c.id));
            const cats = (d.cofrinho_cats || []).filter(k => (fid ? k.financa_id === fid : !k.financa_id));
            return { cofrinhos, movs: (d.cofrinho_movs || []).filter(m => ids.has(m.cofrinho_id)), cats, mode: 'local' };
        }
        if (!Storage.isOnline) return this._fromCache('offline');
        try {
            let q = Storage.db.from('cofrinhos').select('*');
            q = fid ? q.eq('financa_id', fid) : q.eq('user_id', Storage.userId()).is('financa_id', null);
            const { data: cofrinhos, error } = await q.order('created_at', { ascending: true });
            if (error) throw error;
            const cats = await this._loadCats();
            const movs = cofrinhos.length ? await this._loadMovs(cofrinhos.map(c => c.id)) : [];
            try { localStorage.setItem(this._cacheKey(), JSON.stringify({ cofrinhos, movs, cats })); } catch {}
            return { cofrinhos, movs, cats, mode: 'cloud' };
        } catch (e) {
            if (this._isMissingTable(e)) return { cofrinhos: [], movs: [], cats: [], mode: 'missing', missingFile: this._missingFile(e) };
            console.warn('Cofrinhos.load:', e?.message || e);
            return this._fromCache('error');
        }
    },

    async _loadCats() {
        const fid = this._fid();
        let q = Storage.db.from('cofrinho_categories').select('*');
        q = fid ? q.eq('financa_id', fid) : q.eq('user_id', Storage.userId()).is('financa_id', null);
        const { data, error } = await q.order('name', { ascending: true });
        if (error) throw error;
        return data || [];
    },

    // O saldo é a soma do extrato, então NÃO pode ser cortado: o Supabase limita cada
    // resposta (padrão 1.000 linhas). Busca em páginas até completar o total.
    async _loadMovs(ids) {
        const PAGE = 1000;
        let movs = [], total = null;
        while (total === null || movs.length < total) {
            const r = await Storage.db.from('cofrinho_movs').select('*', { count: 'exact' })
                .in('cofrinho_id', ids)
                .order('mov_date', { ascending: false }).order('created_at', { ascending: false }).order('id')
                .range(movs.length, movs.length + PAGE - 1);
            if (r.error) throw r.error;
            const page = r.data || [];
            total = r.count ?? (movs.length + page.length);
            if (!page.length) break;
            movs = movs.concat(page);
        }
        return movs;
    },

    _fromCache(mode) {
        try {
            const c = JSON.parse(localStorage.getItem(this._cacheKey()) || 'null');
            if (c) return { cofrinhos: c.cofrinhos || [], movs: c.movs || [], cats: c.cats || [], mode };
        } catch {}
        return { cofrinhos: [], movs: [], cats: [], mode: mode + '-empty' };
    },

    _setData(data) {
        data.cats = [...(data.cats || [])].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR'));
        this._data = data;
        this._catById = Object.fromEntries(data.cats.map(k => [k.id, k]));
        this._movsBy = {};
        for (const m of data.movs) (this._movsBy[m.cofrinho_id] = this._movsBy[m.cofrinho_id] || []).push(m);
        for (const id in this._movsBy) {
            this._movsBy[id].sort((a, b) =>
                (b.mov_date || '').localeCompare(a.mov_date || '') || (b.created_at || '').localeCompare(a.created_at || ''));
        }
    },

    async createCofrinho(f) {
        this._assertWritable();
        const fid = this._fid();
        const row = {
            name: f.name, emoji: f.emoji, color: f.color, category_id: f.categoryId || null,
            target_amount: this._round(f.target), start_date: f.start, target_date: f.targetDate || null,
            ...this._pixFields(f)
        };
        let created;
        if (!Storage.isCloud) {
            const d = Storage._localGet();
            created = { id: this._uid(), financa_id: fid, user_id: 'local', created_at: new Date().toISOString(), ...row };
            d.cofrinhos = [...(d.cofrinhos || []), created];
            Storage._localSave(d);
        } else {
            const { data, error } = await Storage.db.from('cofrinhos')
                .insert({ ...row, financa_id: fid, user_id: Storage.userId() }).select().single();
            if (error) throw error;
            created = data;
        }
        if (f.initial > 0) {
            try { await this.addMov(created.id, 'inicial', f.initial, null, f.start); }
            catch (e) { await this._dropCofrinhoRow(created.id).catch(() => {}); throw e; }
        }
        return created;
    },

    async _dropCofrinhoRow(id) {
        if (!Storage.isCloud) {
            const d = Storage._localGet();
            d.cofrinhos = (d.cofrinhos || []).filter(c => c.id !== id);
            d.cofrinho_movs = (d.cofrinho_movs || []).filter(m => m.cofrinho_id !== id);
            Storage._localSave(d);
            return;
        }
        const { error } = await Storage.db.from('cofrinhos').delete().eq('id', id);
        if (error) throw error;
    },

    async updateCofrinho(id, fields) {
        this._assertWritable();
        if (!Storage.isCloud) {
            const d = Storage._localGet();
            const i = (d.cofrinhos || []).findIndex(c => c.id === id);
            if (i === -1) throw new Error('Cofrinho não encontrado.');
            d.cofrinhos[i] = { ...d.cofrinhos[i], ...fields };
            Storage._localSave(d);
            return;
        }
        // Segurança via RLS; .select() detecta quando nenhuma linha foi alterada.
        const { data, error } = await Storage.db.from('cofrinhos').update(fields).eq('id', id).select();
        if (error) throw error;
        if (!data || !data.length) throw new Error('Não foi possível editar este cofrinho (sem permissão ou já removido).');
    },

    async deleteCofrinho(id) {
        this._assertWritable();
        if (!Storage.isCloud) return this._dropCofrinhoRow(id);
        const { data, error } = await Storage.db.from('cofrinhos').delete().eq('id', id).select();
        if (error) throw error;
        if (!data || !data.length) throw new Error('Não foi possível excluir este cofrinho (sem permissão ou já removido).');
    },

    async addMov(cofrinhoId, kind, amount, note, date) {
        this._assertWritable();
        const row = {
            cofrinho_id: cofrinhoId, kind, amount: this._round(amount),
            note: (note || '').trim() || null, mov_date: date || this._today()
        };
        if (!Storage.isCloud) {
            const d = Storage._localGet();
            d.cofrinho_movs = [...(d.cofrinho_movs || []),
                { id: this._uid(), user_id: 'local', created_at: new Date().toISOString(), ...row }];
            Storage._localSave(d);
            return;
        }
        const { error } = await Storage.db.from('cofrinho_movs').insert({ ...row, user_id: Storage.userId() });
        if (error) throw error;
    },

    async deleteMov(id) {
        this._assertWritable();
        if (!Storage.isCloud) {
            const d = Storage._localGet();
            d.cofrinho_movs = (d.cofrinho_movs || []).filter(m => m.id !== id);
            Storage._localSave(d);
            return;
        }
        const { data, error } = await Storage.db.from('cofrinho_movs').delete().eq('id', id).select();
        if (error) throw error;
        if (!data || !data.length) throw new Error('Não foi possível excluir esta movimentação.');
    },

    // ─── Categorias (criar / renomear / excluir) ──────────────────────────────
    _normName(s) { return (s || '').trim().replace(/\s+/g, ' '); },
    _dupCat(name, exceptId = null) {
        const n = this._normName(name).toLowerCase();
        return this._data.cats.some(k => k.id !== exceptId && this._normName(k.name).toLowerCase() === n);
    },
    _checkCatName(name, exceptId = null) {
        const n = this._normName(name);
        if (!n) throw new Error('Informe o nome da categoria.');
        if (n.length > 40) throw new Error('Use até 40 caracteres.');
        if (this._dupCat(n, exceptId)) throw new Error('Já existe uma categoria com esse nome.');
        return n;
    },
    _catError(e) {
        return (e && (e.code === '23505' || /duplicate key|unique/i.test(e.message || '')))
            ? new Error('Já existe uma categoria com esse nome.') : e;
    },

    async createCategory(name) {
        this._assertWritable();
        const n = this._checkCatName(name);
        const fid = this._fid();
        if (!Storage.isCloud) {
            const d = Storage._localGet();
            const k = { id: this._uid(), financa_id: fid, user_id: 'local', name: n, created_at: new Date().toISOString() };
            d.cofrinho_cats = [...(d.cofrinho_cats || []), k];
            Storage._localSave(d);
            return k;
        }
        const { data, error } = await Storage.db.from('cofrinho_categories')
            .insert({ name: n, financa_id: fid, user_id: Storage.userId() }).select().single();
        if (error) throw this._catError(error);
        return data;
    },

    async renameCategory(id, name) {
        this._assertWritable();
        const n = this._checkCatName(name, id);
        if (!Storage.isCloud) {
            const d = Storage._localGet();
            const i = (d.cofrinho_cats || []).findIndex(k => k.id === id);
            if (i === -1) throw new Error('Categoria não encontrada.');
            d.cofrinho_cats[i] = { ...d.cofrinho_cats[i], name: n };
            Storage._localSave(d);
            return n;
        }
        const { data, error } = await Storage.db.from('cofrinho_categories').update({ name: n }).eq('id', id).select();
        if (error) throw this._catError(error);
        if (!data || !data.length) throw new Error('Não foi possível renomear (sem permissão ou categoria já removida).');
        return n;
    },

    // Os cofrinhos da categoria excluída ficam "sem categoria" (FK on delete set null).
    async deleteCategory(id) {
        this._assertWritable();
        if (!Storage.isCloud) {
            const d = Storage._localGet();
            d.cofrinho_cats = (d.cofrinho_cats || []).filter(k => k.id !== id);
            d.cofrinhos = (d.cofrinhos || []).map(c => (c.category_id === id ? { ...c, category_id: null } : c));
            Storage._localSave(d);
            return;
        }
        const { data, error } = await Storage.db.from('cofrinho_categories').delete().eq('id', id).select();
        if (error) throw error;
        if (!data || !data.length) throw new Error('Não foi possível excluir (sem permissão ou categoria já removida).');
    },

    _catName(c) { return (this._catById[c.category_id] || {}).name || ''; },

    // Carteira (finança) ativa: é nela que os cofrinhos são criados e listados.
    // Mesmos rótulos e cores do cartão "Carteira ativa" do modal de lançamento.
    _carteira() {
        const f = App.activeFinanca;
        const type = f?.type || 'individual';
        const labels = { individual: '👤 Individual', familiar: '👨‍👩‍👧 Familiar', compartilhada: '🤝 Compartilhada' };
        const cfg = {
            familiar:      { bg: 'linear-gradient(135deg,#9333ea,#6b21a8)', border: '#7c3aed', soft: 'text-purple-200' },
            compartilhada: { bg: 'linear-gradient(135deg,#0d9488,#0f766e)', border: '#0d9488', soft: 'text-teal-200' },
            individual:    { bg: 'linear-gradient(135deg,#059669,#065f46)', border: '#059669', soft: 'text-emerald-200' }
        };
        return { name: f?.name || 'Pessoal', emoji: f?.emoji || '💰', type, label: labels[type] || labels.individual, ...(cfg[type] || cfg.individual) };
    },

    _carteiraCardHtml() {
        const w = this._carteira();
        return `
            <button id="cof-carteira" type="button" aria-label="Carteira ativa: ${this._esc(w.name)}. Tocar para trocar"
                class="w-full flex items-center gap-3 rounded-2xl px-4 py-3 text-left shadow-md transition-all active:scale-95 border-2"
                style="background:${w.bg};border-color:${w.border}">
                <span class="text-3xl flex-shrink-0 leading-none">${this._esc(w.emoji)}</span>
                <div class="flex-1 min-w-0">
                    <p class="text-[10px] font-bold uppercase tracking-widest leading-none mb-1 ${w.soft}">● Carteira ativa</p>
                    <p class="text-base font-extrabold text-white truncate leading-tight">${this._esc(w.name)}</p>
                    <p class="text-xs ${w.soft} mt-0.5">${w.label}${w.type === 'compartilhada' ? ' · membros veem e editam' : ''}</p>
                </div>
                <span class="text-white/60 text-xs flex-shrink-0">trocar ▼</span>
            </button>`;
    },

    // Faixa do formulário: deixa claro em qual carteira o cofrinho será criado
    _renderFormCarteira(editing) {
        const el = document.getElementById('cof-form-carteira');
        if (!el) return;
        const w = this._carteira();
        el.style.background = w.bg;
        el.innerHTML = `<span class="text-xl leading-none flex-shrink-0">${this._esc(w.emoji)}</span>
            <div class="min-w-0 flex-1">
                <p class="text-[10px] font-bold uppercase tracking-widest leading-none mb-0.5 ${w.soft}">${editing ? 'Carteira do cofrinho' : 'Será criado na carteira'}</p>
                <p class="text-sm font-extrabold text-white truncate leading-tight">${this._esc(w.name)} <span class="font-normal ${w.soft}">· ${w.label}</span></p>
            </div>`;
    },

    // ─── Cálculos ─────────────────────────────────────────────────────────────
    _stats(c) {
        let ini = 0, dep = 0, ret = 0;
        for (const m of (this._movsBy[c.id] || [])) {
            const a = Number(m.amount) || 0;
            if (m.kind === 'retirada') ret += a;
            else if (m.kind === 'inicial') ini += a;
            else dep += a;
        }
        const saved  = this._round(ini + dep - ret);
        const target = Number(c.target_amount) || 0;
        return {
            ini: this._round(ini), dep: this._round(dep), ret: this._round(ret), saved, target,
            pct: target > 0 ? (saved / target) * 100 : 0,
            remaining: Math.max(0, this._round(target - saved)),
            done: target > 0 && saved >= target
        };
    },

    // Soma `n` meses a uma data, ajustando o dia ao último dia do mês quando preciso
    // (31/jan + 1 mês = 28/fev).
    _addMonths(d, n) {
        const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
        r.setDate(Math.min(d.getDate(), new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate()));
        return r;
    },

    // Quanto guardar por dia/semana/mês até a data-alvo. Usa meses de calendário e
    // conta só períodos COMPLETOS (mín. 1), então guardar o valor em cada período
    // garante atingir a meta até a data. Valores aproximados.
    _plan(c, remaining) {
        if (!c.target_date) return null;
        if (remaining <= 0) return { reached: true };
        const today = this._parseYmd(this._today()), end = this._parseYmd(c.target_date);
        const days = Math.round((end - today) / 86400000);
        if (days < 0) return { overdue: true };
        if (days === 0) return { dueToday: true };
        let months = (end.getFullYear() - today.getFullYear()) * 12 + (end.getMonth() - today.getMonth());
        if (this._addMonths(today, months) > end) months--;
        months = Math.max(0, months);
        const rest = Math.round((end - this._addMonths(today, months)) / 86400000);
        const nDay = days, nWeek = Math.max(1, Math.floor(days / 7)), nMonth = Math.max(1, months);
        return {
            day: this._ceil(remaining / nDay), week: this._ceil(remaining / nWeek), month: this._ceil(remaining / nMonth),
            nDay, nWeek, nMonth, months, weeks: Math.floor(rest / 7), days: rest % 7
        };
    },

    _summary() {
        let saved = 0, remaining = 0, goals = 0;
        for (const c of this._data.cofrinhos) {
            const s = this._stats(c);
            saved += s.saved; goals += s.target;
            if (!s.done) remaining += s.remaining;
        }
        return { saved: this._round(saved), remaining: this._round(remaining), goals: this._round(goals) };
    },

    _monthSeries(movs) {
        const now = new Date(), rows = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            rows.push({ ym: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), label: this.MONTHS[d.getMonth()], dep: 0, ret: 0 });
        }
        for (const m of movs) {
            if (m.kind === 'inicial') continue; // o saldo inicial não é movimentação do período
            const row = rows.find(r => r.ym === (m.mov_date || '').slice(0, 7));
            if (!row) continue;
            if (m.kind === 'retirada') row.ret += Number(m.amount) || 0;
            else row.dep += Number(m.amount) || 0;
        }
        return rows.map(r => ({ ...r, dep: this._round(r.dep), ret: this._round(r.ret) }));
    },

    // ─── Estrutura da aba (alternância Carteira | Cofrinhos) ──────────────────
    bind() {
        if (this._bound) return;
        this._bound = true;
        try { if (localStorage.getItem('invest_view') === 'cofrinhos') this.view = 'cofrinhos'; } catch {}

        document.getElementById('inv-seg-carteira')?.addEventListener('click', () => this.setView('carteira'));
        document.getElementById('inv-seg-cofrinhos')?.addEventListener('click', () => this.setView('cofrinhos'));

        // Detalhe
        const det = document.getElementById('cofrinho-detail-modal');
        det?.addEventListener('click', e => {
            if (e.target === det) return this.closeDetail();
            const b = e.target.closest('[data-dact]');
            if (b) this._onDetailAction(b);
        });

        // Formulário
        const form = document.getElementById('cofrinho-form-modal');
        form?.addEventListener('click', e => { if (e.target === form) this.closeForm(); });
        // O erro de validação some assim que o usuário volta a editar
        form?.addEventListener('input',  () => this._formError(''));
        form?.addEventListener('change', () => this._formError(''));
        document.getElementById('cof-form-close')?.addEventListener('click', () => this.closeForm());
        document.getElementById('cof-form-cancel')?.addEventListener('click', () => this.closeForm());
        document.getElementById('cof-form-save')?.addEventListener('click', () => this.saveForm());
        document.getElementById('cof-cat-add')?.addEventListener('click', () => {
            const row = document.getElementById('cof-cat-new-row');
            row.classList.toggle('hidden');
            if (!row.classList.contains('hidden')) document.getElementById('cof-cat-new')?.focus();
        });
        document.getElementById('cof-cat-new-ok')?.addEventListener('click', () => this._addCatInline());
        document.getElementById('cof-cat-new')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this._addCatInline(); } });
        document.getElementById('cof-cat-manage')?.addEventListener('click', () => this.openCats());

        // Gerenciador de categorias
        const cm = document.getElementById('cofrinho-cats-modal');
        cm?.addEventListener('click', e => {
            if (e.target === cm) return this.closeCats();
            const b = e.target.closest('[data-cact]');
            if (b) this._onCatsAction(b);
        });
        document.getElementById('cof-cats-close')?.addEventListener('click', () => this.closeCats());
        document.getElementById('cof-cat-add-btn')?.addEventListener('click', () => this._onCatsAction({ dataset: { cact: 'add' } }));
        cm?.addEventListener('keydown', e => {
            if (e.key === 'Enter' && e.target.id === 'cof-cat-add-input') { e.preventDefault(); this._onCatsAction({ dataset: { cact: 'add' } }); }
            else if (e.key === 'Enter' && e.target.id === 'cof-cat-edit-input') { e.preventDefault(); this._onCatsAction({ dataset: { cact: 'save', id: this._catEditId } }); }
            else if (e.key === 'Escape' && this._catEditId) { this._catEditId = null; this._renderCats(); }
        });
        cm?.addEventListener('input', () => this._catsError(''));
        document.getElementById('cof-has-target')?.addEventListener('change', e => {
            document.getElementById('cof-target-date')?.classList.toggle('hidden', !e.target.checked);
        });
        document.getElementById('cof-emoji-row')?.addEventListener('click', e => {
            const b = e.target.closest('[data-v]'); if (!b) return;
            this._form.emoji = b.dataset.v; this._renderPickers();
        });
        document.getElementById('cof-color-row')?.addEventListener('click', e => {
            const b = e.target.closest('[data-v]'); if (!b) return;
            this._form.color = b.dataset.v; this._renderPickers();
        });
        for (const id of ['cof-target', 'cof-initial', 'cof-mov-amount']) {
            document.getElementById(id)?.addEventListener('input', e => App._applyCurrencyMask(e.target));
        }

        // Depósito / retirada
        const mov = document.getElementById('cofrinho-mov-modal');
        mov?.addEventListener('click', e => { if (e.target === mov) this.closeMov(); });
        mov?.addEventListener('input',  () => this._movError(''));
        mov?.addEventListener('change', () => this._movError(''));
        document.getElementById('cof-mov-close')?.addEventListener('click', () => this.closeMov());
        document.getElementById('cof-mov-cancel')?.addEventListener('click', () => this.closeMov());
        document.getElementById('cof-mov-save')?.addEventListener('click', () => this.saveMov());
        document.getElementById('cof-mov-pix')?.addEventListener('click', e => {
            const b = e.target.closest('#cof-mov-pix-copy'); if (!b) return;
            const c = this._data.cofrinhos.find(x => x.id === this._mov?.id);
            if (c?.pix_key) this._copy(c.pix_key, b);
        });
        document.getElementById('cof-mov-amount')?.addEventListener('keydown', e => { if (e.key === 'Enter') this.saveMov(); });
    },

    setView(v) {
        this.view = v === 'cofrinhos' ? 'cofrinhos' : 'carteira';
        try { localStorage.setItem('invest_view', this.view); } catch {}
        App.renderInvestmentsTab();
    },

    // Alternância no topo da aba + rótulo do botão do cabeçalho
    syncChrome() {
        const isCof = this.view === 'cofrinhos';
        const on  = 'flex-1 py-2 rounded-xl text-sm font-semibold bg-white text-emerald-700 shadow-sm transition-colors';
        const off = 'flex-1 py-2 rounded-xl text-sm font-semibold text-gray-500 transition-colors';
        const a = document.getElementById('inv-seg-carteira'), b = document.getElementById('inv-seg-cofrinhos');
        if (a) { a.className = isCof ? off : on; a.setAttribute('aria-selected', String(!isCof)); }
        if (b) { b.className = isCof ? on : off; b.setAttribute('aria-selected', String(isCof)); }
        const top = document.getElementById('inv-new-aporte-top');
        if (top) top.textContent = isCof ? '+ Cofrinho' : '+ Aporte';
    },

    // ─── Lista ────────────────────────────────────────────────────────────────
    async render(body) {
        this.bind();
        // Primeira renderização desta visão mostra "Carregando"; as seguintes mantêm
        // o conteúdo anterior até os dados chegarem (sem piscar).
        if (!document.getElementById('cof-list') && !document.getElementById('cof-missing')) {
            body.innerHTML = '<p class="text-center text-gray-400 py-8 text-sm">Carregando cofrinhos…</p>';
        }
        const data = await this.load();
        if (this.view !== 'cofrinhos') return; // usuário voltou para a Carteira durante o carregamento
        this._setData(data);
        this._renderShell(body);
        if (this._detailId) this._renderDetail();
    },

    _bannerHtml(mode) {
        if (mode === 'offline' || mode === 'error') {
            const why = mode === 'offline' ? 'Sem conexão' : 'Falha ao carregar';
            return `<div class="rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs px-3 py-2">⚠️ ${why} — mostrando os últimos dados salvos neste aparelho. Depósitos e retiradas ficam indisponíveis até reconectar.</div>`;
        }
        if (mode === 'offline-empty' || mode === 'error-empty') {
            return '<div class="rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs px-3 py-2">⚠️ Não foi possível carregar os cofrinhos agora.</div>';
        }
        return '';
    },

    _renderShell(body) {
        const d = this._data;
        if (d.mode === 'missing') {
            const isCat = /categories/.test(d.missingFile || '');
            body.innerHTML = `
                <div id="cof-missing" class="bg-white rounded-2xl border border-amber-200 p-5 text-center">
                    <div class="text-3xl mb-2">🛠️</div>
                    <p class="text-sm font-semibold text-gray-700">${isCat ? 'As categorias dos cofrinhos ainda não foram habilitadas no banco' : 'Cofrinhos ainda não foram habilitados no banco'}</p>
                    <p class="text-xs text-gray-500 mt-2 leading-relaxed">Falta aplicar uma vez a migração <code class="bg-gray-100 px-1 rounded">${this._esc(d.missingFile || '20261006000001_create_cofrinhos.sql')}</code> (pasta <code class="bg-gray-100 px-1 rounded">supabase/migrations</code>) no SQL Editor do Supabase.</p>
                    <button id="cof-retry" class="mt-4 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold">Já apliquei, tentar de novo</button>
                </div>`;
            document.getElementById('cof-retry')?.addEventListener('click', () => App.renderInvestmentsTab());
            return;
        }

        // Só categorias em uso aparecem no filtro (as vazias só poluiriam a lista)
        const usedIds = new Set(d.cofrinhos.map(c => c.category_id).filter(Boolean));
        const cats = d.cats.filter(k => usedIds.has(k.id));
        if (this._ui.cat && this._ui.cat !== '__none__' && !usedIds.has(this._ui.cat)) this._ui.cat = '';
        const hasNone = d.cofrinhos.some(c => !c.category_id);
        const sel = 'border border-gray-200 rounded-xl px-3 py-2 text-xs bg-white focus:outline-none focus:border-emerald-500';

        const controls = d.cofrinhos.length >= 2 ? `
            <div class="space-y-2">
                <input id="cof-search" type="search" placeholder="🔎 Buscar cofrinho..." value="${this._esc(this._ui.q)}"
                    class="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:border-emerald-500">
                <div class="flex gap-2">
                    <select id="cof-sort" class="${sel} flex-1" aria-label="Ordenar">
                        <option value="recent">Mais recentes</option>
                        <option value="name">Nome (A–Z)</option>
                        <option value="progress">Maior progresso</option>
                        <option value="deadline">Prazo mais próximo</option>
                    </select>
                    <select id="cof-cat" class="${sel} flex-1" aria-label="Filtrar por categoria">
                        <option value="">Todas as categorias</option>
                        ${cats.map(k => `<option value="${this._esc(k.id)}">${this._esc(k.name)}</option>`).join('')}
                        ${hasNone && cats.length ? '<option value="__none__">Sem categoria</option>' : ''}
                    </select>
                </div>
            </div>` : '';

        body.innerHTML = `
            ${this._bannerHtml(d.mode)}
            ${this._carteiraCardHtml()}
            <div class="flex justify-end">
                <button id="cof-cats-btn" type="button" class="text-xs font-semibold text-gray-600 bg-white border border-gray-200 rounded-full px-3 py-1.5 hover:bg-gray-50">🏷️ Categorias${d.cats.length ? ' (' + d.cats.length + ')' : ''}</button>
            </div>
            <div id="cof-summary"></div>
            ${controls}
            <div id="cof-list" class="space-y-3"></div>`;

        const sort = document.getElementById('cof-sort'), cat = document.getElementById('cof-cat');
        if (sort) sort.value = this._ui.sort;
        if (cat)  cat.value  = this._ui.cat;
        document.getElementById('cof-search')?.addEventListener('input', e => { this._ui.q = e.target.value; this._renderList(); });
        sort?.addEventListener('change', e => { this._ui.sort = e.target.value; this._renderList(); });
        cat?.addEventListener('change',  e => { this._ui.cat  = e.target.value; this._renderList(); });
        document.getElementById('cof-carteira')?.addEventListener('click', () => App.openFinancaModal());
        document.getElementById('cof-cats-btn')?.addEventListener('click', () => this.openCats());
        document.getElementById('cof-list')?.addEventListener('click', e => {
            const pix = e.target.closest('[data-pix]');
            if (pix) {
                const c = this._data.cofrinhos.find(x => x.id === pix.dataset.pix);
                if (c?.pix_key) this._copy(c.pix_key, pix);
                return;
            }
            const act = e.target.closest('[data-act]');
            if (act) { if (!act.disabled) this.openMov(act.dataset.id, act.dataset.act); return; }
            const card = e.target.closest('[data-card]');
            if (card) this.openDetail(card.dataset.card);
        });
        this._renderList();
    },

    _filtered() {
        const q = this._ui.q.trim().toLowerCase();
        const rows = this._data.cofrinhos.map(c => ({ c, s: this._stats(c) })).filter(({ c }) => {
            if (q && !(c.name || '').toLowerCase().includes(q) && !this._catName(c).toLowerCase().includes(q)) return false;
            if (this._ui.cat === '__none__') return !c.category_id;
            return !this._ui.cat || c.category_id === this._ui.cat;
        });
        const by = {
            recent:   (a, b) => (b.c.created_at || '').localeCompare(a.c.created_at || ''),
            name:     (a, b) => (a.c.name || '').localeCompare(b.c.name || '', 'pt-BR'),
            progress: (a, b) => b.s.pct - a.s.pct,
            deadline: (a, b) => (a.c.target_date || '9999').localeCompare(b.c.target_date || '9999')
        };
        return rows.sort(by[this._ui.sort] || by.recent);
    },

    _renderList() {
        const list = document.getElementById('cof-list');
        if (!list) return;
        const all = this._data.cofrinhos;
        const canWrite = !(Storage.isCloud && (this._data.mode === 'offline' || this._data.mode === 'error' || !Storage.isOnline));

        const sum = document.getElementById('cof-summary');
        if (sum) {
            const t = this._summary();
            const tile = (label, v) => `
                <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-3 text-center">
                    <div class="text-[10px] text-gray-400 uppercase tracking-wide">${label}</div>
                    <div class="text-sm font-bold text-gray-800 mt-0.5">${this._money(v)}</div>
                </div>`;
            sum.innerHTML = all.length ? `
                <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 text-center">
                    <div class="text-[11px] text-gray-400 uppercase tracking-wide">Total guardado</div>
                    <div class="text-2xl font-extrabold text-gray-800 mt-1">${this._money(t.saved)}</div>
                </div>
                <div class="grid grid-cols-2 gap-2 mt-2">
                    ${tile('Falta para as metas', t.remaining)}
                    ${tile('Soma das metas', t.goals)}
                </div>` : '';
        }

        if (!all.length) {
            list.innerHTML = `
                <div class="bg-white rounded-2xl border border-gray-100 text-center text-gray-400 py-10 px-6">
                    <div class="text-4xl mb-3">🐷</div>
                    <p class="text-sm font-semibold text-gray-500">Nenhum cofrinho ainda</p>
                    <p class="text-xs mt-2 leading-relaxed">Toque em <b>+ Cofrinho</b> no topo para juntar dinheiro para um objetivo — carro, viagem, reserva — e acompanhar o progresso. Ele fica separado dos seus lançamentos do mês.</p>
                </div>`;
            return;
        }
        const rows = this._filtered();
        if (!rows.length) {
            list.innerHTML = '<p class="text-center text-gray-400 text-sm py-6">Nenhum cofrinho encontrado.</p>';
            return;
        }
        list.innerHTML = rows.map(({ c, s }) => this._cardHtml(c, s, canWrite)).join('');
    },

    // Chave PIX no cartão da lista: chave + (tipo · titular · banco) e botão de copiar
    _cardPixHtml(c) {
        if (!c.pix_key) return '';
        const type = App._pixKeyType ? App._pixKeyType(c.pix_key) : '';
        const sub = ['PIX', type, c.pix_name, c.pix_bank].filter(Boolean).map(x => this._esc(x)).join(' · ');
        return `
            <div class="mt-3 flex items-center gap-2 rounded-xl bg-gray-50 border border-gray-100 px-3 py-2">
                <span class="text-base leading-none flex-shrink-0">🔑</span>
                <div class="flex-1 min-w-0">
                    <div class="font-mono text-xs text-gray-800 break-all leading-snug">${this._esc(c.pix_key)}</div>
                    <div class="text-[10px] text-gray-400 break-words">${sub}</div>
                </div>
                <button type="button" data-pix="${c.id}" aria-label="Copiar chave PIX de ${this._esc(c.name)}"
                    class="flex-shrink-0 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-[11px] font-semibold text-gray-600 hover:bg-gray-50">Copiar</button>
            </div>`;
    },

    _deadlineTxt(c, s) {
        if (!c.target_date) return '';
        const late = !s.done && c.target_date < this._today();
        return `até ${App.formatDate(c.target_date)}${late ? ' · prazo vencido' : ''}`;
    },

    _cardHtml(c, s, canWrite) {
        const color = this._safeColor(c.color);
        const w = Math.max(0, Math.min(100, s.pct));
        const meta = [this._esc(this._catName(c)), this._deadlineTxt(c, s)].filter(Boolean).join(' · ');
        return `
        <div data-card="${c.id}" class="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 cursor-pointer">
            <div class="flex items-start gap-3">
                <div class="w-11 h-11 rounded-2xl flex items-center justify-center text-2xl flex-shrink-0" style="background:${color}26">${this._esc(c.emoji || '🐷')}</div>
                <div class="flex-1 min-w-0">
                    <div class="font-semibold text-gray-800 truncate">${this._esc(c.name)}</div>
                    <div class="text-[11px] text-gray-400 truncate">${s.done ? '<span class="font-semibold text-emerald-700">🎉 Concluído</span>' + (meta ? ' · ' : '') : ''}${meta || (s.done ? '' : '&nbsp;')}</div>
                </div>
                <div class="text-right flex-shrink-0">
                    <div class="text-sm font-bold text-gray-800">${this._money(s.saved)}</div>
                    <div class="text-[11px] text-gray-400">de ${this._money(s.target)}</div>
                </div>
            </div>
            <div class="h-2 rounded-full mt-3" style="background:${color}26"><div class="h-2 rounded-full" style="width:${w.toFixed(1)}%;background:${color}"></div></div>
            <div class="flex justify-between text-[11px] text-gray-500 mt-1">
                <span class="font-semibold">${this._pctTxt(s.pct)}</span>
                <span>${s.done ? 'Meta atingida' : 'Faltam ' + this._money(s.remaining)}</span>
            </div>
            ${this._cardPixHtml(c)}
            <div class="flex gap-2 mt-3">
                <button data-act="retirada" data-id="${c.id}" ${canWrite && s.saved > 0 ? '' : 'disabled'}
                    class="flex-1 py-2 rounded-xl border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-40">− Retirar</button>
                <button data-act="deposito" data-id="${c.id}" ${canWrite ? '' : 'disabled'}
                    class="flex-1 py-2 rounded-xl bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 disabled:opacity-40">+ Depositar</button>
            </div>
        </div>`;
    },

    // ─── Detalhe ──────────────────────────────────────────────────────────────
    openDetail(id) {
        this._detailId = id;
        this._detailMsg = '';
        document.getElementById('cofrinho-detail-modal')?.classList.remove('hidden');
        this._renderDetail();
    },

    closeDetail() {
        this._detailId = null;
        if (this._chart) { this._chart.destroy(); this._chart = null; }
        document.getElementById('cofrinho-detail-modal')?.classList.add('hidden');
    },

    _onDetailAction(btn) {
        const id = this._detailId, a = btn.dataset.dact;
        if (a === 'close') return this.closeDetail();
        if (a === 'edit') return this.openForm(id);
        if (a === 'dep' || a === 'ret') return this.openMov(id, a === 'dep' ? 'deposito' : 'retirada');
        if (a === 'plan') { this._planPeriod = btn.dataset.p; return this._renderDetail(); }
        if (a === 'copy-pix') {
            const c = this._data.cofrinhos.find(x => x.id === id);
            return c?.pix_key && this._copy(c.pix_key, btn);
        }
        if (a === 'del') return this._deleteCofrinho(id);
        if (a === 'del-mov') return this._deleteMov(btn.dataset.id);
    },

    async _deleteCofrinho(id) {
        const c = this._data.cofrinhos.find(x => x.id === id);
        if (!c || !confirm(`Excluir o cofrinho "${c.name}"? Todo o extrato será apagado.`)) return;
        try {
            await this.deleteCofrinho(id);
            this.closeDetail();
            App.showToast('🗑️ Cofrinho excluído');
            await App.renderInvestmentsTab();
        } catch (e) {
            this._detailMsg = '❌ ' + (e.message || 'Erro ao excluir');
            this._renderDetail();
        }
    },

    async _deleteMov(movId) {
        const m = this._data.movs.find(x => x.id === movId);
        const c = m && this._data.cofrinhos.find(x => x.id === m.cofrinho_id);
        if (!m || !c) return;
        // Excluir um depósito não pode deixar o saldo negativo.
        if (m.kind !== 'retirada' && this._stats(c).saved - Number(m.amount) < -0.004) {
            this._detailMsg = '⚠️ Não dá para excluir: o saldo ficaria negativo. Exclua antes as retiradas posteriores.';
            return this._renderDetail();
        }
        if (!confirm(`Excluir ${this.KIND_LABEL[m.kind].toLowerCase()} de ${this._money(m.amount)}?`)) return;
        try {
            await this.deleteMov(movId);
            this._detailMsg = '';
            await App.renderInvestmentsTab();
        } catch (e) {
            this._detailMsg = '❌ ' + (e.message || 'Erro ao excluir');
            this._renderDetail();
        }
    },

    _renderDetail() {
        const wrap = document.getElementById('cof-detail-body');
        const c = this._data.cofrinhos.find(x => x.id === this._detailId);
        if (!wrap) return;
        if (!c) return this.closeDetail(); // removido por outro membro
        const s = this._stats(c), color = this._safeColor(c.color), plan = this._plan(c, s.remaining);
        const movs = this._movsBy[c.id] || [];
        const canWrite = !(Storage.isCloud && (this._data.mode === 'offline' || this._data.mode === 'error' || !Storage.isOnline));

        // ── Recomendação de aporte até a data-alvo ──
        let planHtml;
        if (!c.target_date) {
            planHtml = '<p class="text-xs text-gray-400">Defina uma data-alvo (em Editar) para ver quanto guardar por dia, semana ou mês.</p>';
        } else if (plan.reached) {
            planHtml = '<p class="text-sm font-semibold text-gray-700">🎉 Meta atingida!</p>';
        } else if (plan.overdue) {
            planHtml = `<p class="text-sm text-gray-700">O prazo (${App.formatDate(c.target_date)}) já passou e ainda faltam <b>${this._money(s.remaining)}</b>. Edite a data-alvo para recalcular.</p>`;
        } else if (plan.dueToday) {
            planHtml = `<p class="text-sm text-gray-700">O prazo termina <b>hoje</b> e ainda faltam <b>${this._money(s.remaining)}</b>.</p>`;
        } else {
            const periods = [['day', 'Por dia'], ['week', 'Por semana'], ['month', 'Por mês']];
            const k = this._planPeriod;
            const unit = { day: 'por dia', week: 'por semana', month: 'por mês' }[k];
            const n = plan[{ day: 'nDay', week: 'nWeek', month: 'nMonth' }[k]];
            const deps = n === 1
                ? `1 depósito ${{ day: 'diário', week: 'semanal', month: 'mensal' }[k]}`
                : `${n} depósitos ${{ day: 'diários', week: 'semanais', month: 'mensais' }[k]}`;
            const left = [
                plan.months ? `${plan.months} ${plan.months === 1 ? 'mês' : 'meses'}` : '',
                plan.weeks  ? `${plan.weeks} ${plan.weeks === 1 ? 'semana' : 'semanas'}` : '',
                plan.days   ? `${plan.days} ${plan.days === 1 ? 'dia' : 'dias'}` : ''
            ].filter(Boolean).join(' · ') || 'menos de 1 dia';
            planHtml = `
                <div class="flex gap-2 mb-3">
                    ${periods.map(([key, label]) => `<button type="button" data-dact="plan" data-p="${key}"
                        class="flex-1 py-1.5 rounded-xl text-xs font-semibold border ${k === key ? 'bg-emerald-600 text-white border-emerald-600' : 'border-gray-200 text-gray-600'}">${label}</button>`).join('')}
                </div>
                <p class="text-sm text-gray-600">Para bater a meta, guarde</p>
                <div class="text-2xl font-extrabold text-gray-800">${this._money(plan[k])} <span class="text-base font-bold text-gray-500">${unit}</span></div>
                <p class="text-xs text-gray-600 mt-1">${deps} · total que falta ${this._money(s.remaining)}</p>
                <p class="text-[11px] text-gray-400 mt-1">Até ${App.formatDate(c.target_date)} · restam ${left} (valores aproximados)</p>`;
        }

        // ── Extrato ──
        const rows = movs.map(m => {
            const isRet = m.kind === 'retirada';
            return `
            <div class="flex items-center gap-2 py-2 border-b border-gray-50 last:border-0">
                <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${isRet ? this.SERIES.ret : this.SERIES.dep}"></span>
                <div class="flex-1 min-w-0">
                    <div class="text-sm text-gray-800 truncate">${this.KIND_LABEL[m.kind] || 'Depósito'}${m.note ? ' · ' + this._esc(m.note) : ''}</div>
                    <div class="text-[10px] text-gray-400">${App.formatDate(m.mov_date)}</div>
                </div>
                <div class="text-sm font-bold text-gray-800 flex-shrink-0">${isRet ? '−' : '+'}${this._money(m.amount)}</div>
                ${canWrite ? `<button type="button" data-dact="del-mov" data-id="${m.id}" aria-label="Excluir movimentação" class="text-gray-300 hover:text-red-500 text-sm px-1">🗑</button>` : ''}
            </div>`;
        }).join('') || '<p class="text-xs text-gray-400 text-center py-2">Nenhuma movimentação ainda.</p>';

        // ── Gráfico (ou aviso) + tabela equivalente ──
        const series = this._monthSeries(movs);
        const hasMoves = series.some(r => r.dep > 0 || r.ret > 0);
        const chartHtml = hasMoves ? `
            <div style="position:relative;height:210px"><canvas id="cof-chart" role="img"
                aria-label="Depósitos e retiradas por mês nos últimos 6 meses"></canvas></div>
            <details class="mt-2">
                <summary class="text-[11px] text-gray-500 cursor-pointer">Ver como tabela</summary>
                <table class="w-full text-xs mt-2">
                    <thead><tr class="text-left text-gray-400"><th class="font-medium py-1">Mês</th><th class="font-medium text-right">Depósitos</th><th class="font-medium text-right">Retiradas</th></tr></thead>
                    <tbody>${series.map(r => `<tr class="border-t border-gray-50"><td class="py-1 text-gray-700">${r.label}</td><td class="text-right tabular-nums text-gray-700">${this._money(r.dep)}</td><td class="text-right tabular-nums text-gray-700">${this._money(r.ret)}</td></tr>`).join('')}</tbody>
                </table>
            </details>`
            : '<p class="text-xs text-gray-400 text-center py-4">Sem depósitos ou retiradas nos últimos 6 meses.</p>';

        const swatch = bg => `<span class="inline-block w-2 h-2 rounded-full mr-1.5" style="background:${bg}"></span>`;
        const meta = [this._esc(this._catName(c)), this._deadlineTxt(c, s), 'início ' + App.formatDate(c.start_date)].filter(Boolean).join(' · ');

        wrap.innerHTML = `
            <div class="flex items-start gap-3">
                <div class="w-12 h-12 rounded-2xl flex items-center justify-center text-3xl flex-shrink-0" style="background:${color}26">${this._esc(c.emoji || '🐷')}</div>
                <div class="flex-1 min-w-0">
                    <h3 class="font-bold text-lg text-gray-800 truncate">${this._esc(c.name)}</h3>
                    <p class="text-[11px] text-gray-400">${meta}</p>
                </div>
                <button type="button" data-dact="close" aria-label="Fechar" class="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 flex-shrink-0">✕</button>
            </div>
            ${this._detailMsg ? `<div class="rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2">${this._esc(this._detailMsg)}</div>` : ''}

            <div>
                <div class="flex items-end justify-between">
                    <div>
                        <div class="text-[11px] text-gray-400 uppercase tracking-wide">Guardado</div>
                        <div class="text-2xl font-extrabold text-gray-800">${this._money(s.saved)}</div>
                    </div>
                    <div class="text-right">
                        <div class="text-[11px] text-gray-400 uppercase tracking-wide">Meta</div>
                        <div class="text-sm font-bold text-gray-800">${this._money(s.target)}</div>
                    </div>
                </div>
                <div class="h-3 rounded-full mt-2" style="background:${color}26"><div class="h-3 rounded-full" style="width:${Math.max(0, Math.min(100, s.pct)).toFixed(1)}%;background:${color}"></div></div>
                <div class="flex justify-between text-xs text-gray-500 mt-1">
                    <span class="font-semibold">${this._pctTxt(s.pct)}${s.done ? ' · 🎉 Concluído' : ''}</span>
                    <span>${s.done ? 'Meta atingida' : 'Faltam ' + this._money(s.remaining)}</span>
                </div>
            </div>

            <div class="flex gap-2">
                <button type="button" data-dact="ret" ${canWrite && s.saved > 0 ? '' : 'disabled'} class="flex-1 py-3 rounded-xl border-2 border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-40">− Retirar</button>
                <button type="button" data-dact="dep" ${canWrite ? '' : 'disabled'} class="flex-1 py-3 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-40">+ Depositar</button>
            </div>

            ${c.pix_key ? `<div class="rounded-2xl border border-gray-100 p-4">${this._pixBlockHtml(c, 'data-dact="copy-pix"')}</div>` : ''}

            <div class="rounded-2xl border border-gray-100 p-4">
                <p class="text-sm font-semibold text-gray-700 mb-2">Quanto guardar</p>
                ${planHtml}
            </div>

            <div class="grid grid-cols-2 gap-2">
                <div class="rounded-2xl border border-gray-100 p-3">
                    <div class="text-[10px] uppercase tracking-wide text-gray-400">${swatch(this.SERIES.dep)}Depositado</div>
                    <div class="text-sm font-bold text-gray-800 mt-0.5">${this._money(s.ini + s.dep)}</div>
                </div>
                <div class="rounded-2xl border border-gray-100 p-3">
                    <div class="text-[10px] uppercase tracking-wide text-gray-400">${swatch(this.SERIES.ret)}Retirado</div>
                    <div class="text-sm font-bold text-gray-800 mt-0.5">${this._money(s.ret)}</div>
                </div>
            </div>

            <div class="rounded-2xl border border-gray-100 p-4">
                <p class="text-sm font-semibold text-gray-700">Últimos 6 meses</p>
                <p class="text-[11px] text-gray-400 mb-2">Depósitos e retiradas por mês (sem o saldo inicial)</p>
                ${chartHtml}
            </div>

            <div class="rounded-2xl border border-gray-100 p-4">
                <p class="text-sm font-semibold text-gray-700 mb-1">Extrato (${movs.length})</p>
                ${rows}
            </div>

            ${canWrite ? `<div class="flex gap-2 pb-2">
                <button type="button" data-dact="edit" class="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">✏️ Editar</button>
                <button type="button" data-dact="del" class="flex-1 py-2.5 rounded-xl border border-red-200 text-sm font-semibold text-red-600 hover:bg-red-50">🗑️ Excluir</button>
            </div>` : ''}`;

        this._drawChart(series, hasMoves);
    },

    _drawChart(series, hasMoves) {
        if (this._chart) { this._chart.destroy(); this._chart = null; }
        const cv = document.getElementById('cof-chart');
        if (!hasMoves || !cv || !window.Chart) return;
        const gap = { left: 1, right: 1, top: 0, bottom: 0 }; // 2px de superfície entre barras vizinhas
        const mk = (label, key, color) => ({
            label, data: series.map(r => r[key]), backgroundColor: color,
            borderColor: '#ffffff', borderWidth: gap, borderSkipped: 'bottom',
            borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 }, maxBarThickness: 24
        });
        this._chart = new Chart(cv, {
            type: 'bar',
            data: { labels: series.map(r => r.label), datasets: [mk('Depósitos', 'dep', this.SERIES.dep), mk('Retiradas', 'ret', this.SERIES.ret)] },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { position: 'top', align: 'start', labels: { usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 8, boxHeight: 8, color: '#52514e', font: { size: 11 } } },
                    tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${this._money(ctx.parsed.y)}` } }
                },
                scales: {
                    y: { beginAtZero: true, border: { display: false }, grid: { color: '#ececea', lineWidth: 1 },
                        ticks: { color: '#6b6a66', font: { size: 10 }, maxTicksLimit: 5, callback: v => v >= 1000 ? 'R$' + (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : 'R$' + v } },
                    x: { grid: { display: false }, border: { color: '#ececea' }, ticks: { color: '#6b6a66', font: { size: 10 } } }
                }
            }
        });
    },

    // ─── Formulário (criar / editar) ──────────────────────────────────────────
    _renderPickers() {
        const f = this._form;
        const emojis = this.EMOJIS.includes(f.emoji) ? this.EMOJIS : [f.emoji, ...this.EMOJIS];
        const er = document.getElementById('cof-emoji-row'), cr = document.getElementById('cof-color-row');
        if (er) er.innerHTML = emojis.map(e => `<button type="button" data-v="${this._esc(e)}" aria-label="Emoji ${this._esc(e)}"
            class="w-10 h-10 rounded-xl text-xl flex items-center justify-center border-2 ${e === f.emoji ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200'}">${this._esc(e)}</button>`).join('');
        if (cr) cr.innerHTML = this.COLORS.map(c => `<button type="button" data-v="${c}" aria-label="Cor ${c}"
            class="w-8 h-8 rounded-full" style="background:${c};${c === f.color ? 'box-shadow:0 0 0 2px #fff,0 0 0 4px ' + c : ''}"></button>`).join('');
    },

    openForm(id = null) {
        this._editId = id;
        const c = id ? this._data.cofrinhos.find(x => x.id === id) : null;
        this._form = { emoji: c?.emoji || '🐷', color: this._safeColor(c?.color) };
        document.getElementById('cof-form-title').textContent = c ? 'Editar cofrinho' : 'Novo cofrinho';
        this._renderFormCarteira(!!c);
        document.getElementById('cof-name').value     = c?.name || '';
        document.getElementById('cof-target').value   = c ? App._toMaskedCurrency(c.target_amount) : '';
        document.getElementById('cof-initial').value  = '';
        document.getElementById('cof-initial-wrap').classList.toggle('hidden', !!c); // saldo inicial só na criação
        document.getElementById('cof-pix-key').value  = c?.pix_key  || '';
        document.getElementById('cof-pix-name').value = c?.pix_name || '';
        document.getElementById('cof-pix-bank').value = c?.pix_bank || '';
        document.getElementById('cof-pix-details').open = !!(c?.pix_key || c?.pix_name || c?.pix_bank);
        this._fillCatSelect(c?.category_id || '');
        document.getElementById('cof-cat-new-row').classList.add('hidden');
        document.getElementById('cof-start').value    = c?.start_date || this._today();
        document.getElementById('cof-has-target').checked = !!c?.target_date;
        const td = document.getElementById('cof-target-date');
        td.value = c?.target_date || '';
        td.classList.toggle('hidden', !c?.target_date);
        this._formError('');
        this._renderPickers();
        document.getElementById('cofrinho-form-modal').classList.remove('hidden');
        setTimeout(() => document.getElementById('cof-name')?.focus(), 100);
    },

    closeForm() {
        document.getElementById('cofrinho-form-modal')?.classList.add('hidden');
        this._editId = null;
    },

    _formError(msg) {
        const el = document.getElementById('cof-form-error');
        if (!el) return;
        el.textContent = msg || '';
        el.classList.toggle('hidden', !msg);
    },

    async saveForm() {
        const name   = document.getElementById('cof-name').value.trim();
        const target = App._parseMaskedCurrency(document.getElementById('cof-target').value);
        const initial = this._editId ? 0 : App._parseMaskedCurrency(document.getElementById('cof-initial').value);
        const start  = document.getElementById('cof-start').value;
        const hasTd  = document.getElementById('cof-has-target').checked;
        const tdate  = hasTd ? document.getElementById('cof-target-date').value : '';
        const categoryId = document.getElementById('cof-category').value || null;
        const pix = {
            pixKey:  document.getElementById('cof-pix-key').value.trim(),
            pixName: document.getElementById('cof-pix-name').value,
            pixBank: document.getElementById('cof-pix-bank').value
        };

        if (!name)          return this._formError('Informe o nome do objetivo.');
        if (!(target > 0))  return this._formError('Informe o valor da meta.');
        if (!start)         return this._formError('Informe a data de início.');
        if (hasTd && !tdate) return this._formError('Informe a data-alvo ou desmarque a opção.');
        if (tdate && tdate < start) return this._formError('A data-alvo deve ser igual ou posterior à data de início.');
        if ((pix.pixName.trim() || pix.pixBank.trim()) && !pix.pixKey) {
            document.getElementById('cof-pix-details').open = true;
            return this._formError('Informe a chave PIX ou limpe o nome e o banco.');
        }
        if (pix.pixKey.length > 100) { document.getElementById('cof-pix-details').open = true; return this._formError('A chave PIX deve ter até 100 caracteres.'); }
        if (this._normName(pix.pixName).length > 80) return this._formError('O nome do titular deve ter até 80 caracteres.');
        if (this._normName(pix.pixBank).length > 60) return this._formError('O banco deve ter até 60 caracteres.');
        this._formError('');

        const btn = document.getElementById('cof-form-save');
        btn.disabled = true; btn.textContent = 'Salvando...';
        try {
            const editing = !!this._editId;
            if (editing) {
                const prev = this._data.cofrinhos.find(x => x.id === this._editId);
                await this.updateCofrinho(this._editId, {
                    name, emoji: this._form.emoji, color: this._form.color, category_id: categoryId,
                    target_amount: this._round(target), start_date: start, target_date: tdate || null,
                    ...this._pixFields(pix, prev)
                });
            } else {
                await this.createCofrinho({ name, emoji: this._form.emoji, color: this._form.color, categoryId, target, initial, start, targetDate: tdate, ...pix });
            }
            this.closeForm();
            App.showToast(editing ? '✅ Cofrinho atualizado!' : '✅ Cofrinho criado!');
            await App.renderInvestmentsTab();
        } catch (e) {
            const file = this._isMissingTable(e) ? this._missingFile(e) : null;
            this._formError(!file ? (e.message || 'Não foi possível salvar.')
                : /pix/.test(file) ? 'A chave PIX ainda não foi habilitada no banco (migração pendente: ' + file + '). Deixe os campos de PIX vazios para salvar sem ela.'
                : /categories/.test(file) ? 'As categorias ainda não foram habilitadas no banco (migração pendente: ' + file + ').'
                : 'Cofrinhos ainda não foram habilitados no banco (migração pendente: ' + file + ').');
        } finally {
            btn.disabled = false; btn.textContent = 'Salvar';
        }
    },

    // Preenche o <select> de categoria do formulário (mantém a seleção quando possível)
    _fillCatSelect(selectedId) {
        const sel = document.getElementById('cof-category');
        if (!sel) return;
        sel.innerHTML = '<option value="">Sem categoria</option>' +
            this._data.cats.map(k => `<option value="${this._esc(k.id)}">${this._esc(k.name)}</option>`).join('');
        sel.value = this._catById[selectedId] ? selectedId : '';
    },

    // "+" ao lado da categoria: cria uma categoria sem sair do formulário
    async _addCatInline() {
        const input = document.getElementById('cof-cat-new');
        try {
            const k = await this.createCategory(input.value);
            this._data.cats.push(k);
            this._setData({ ...this._data, cats: this._data.cats });
            this._fillCatSelect(k.id);
            input.value = '';
            document.getElementById('cof-cat-new-row').classList.add('hidden');
            this._formError('');
            this._afterCatsChanged();
        } catch (e) { this._formError(e.message || 'Não foi possível criar a categoria.'); }
    },

    // ─── Gerenciador de categorias ────────────────────────────────────────────
    openCats() {
        this._catEditId = null;
        this._catsError('');
        document.getElementById('cof-cat-add-input').value = '';
        this._renderCats();
        document.getElementById('cofrinho-cats-modal').classList.remove('hidden');
    },

    closeCats() {
        document.getElementById('cofrinho-cats-modal')?.classList.add('hidden');
        this._catEditId = null;
    },

    _catsError(msg) {
        const el = document.getElementById('cof-cats-error');
        if (!el) return;
        el.textContent = msg || '';
        el.classList.toggle('hidden', !msg);
    },

    _renderCats() {
        const wrap = document.getElementById('cof-cats-list');
        if (!wrap) return;
        const counts = {};
        for (const c of this._data.cofrinhos) if (c.category_id) counts[c.category_id] = (counts[c.category_id] || 0) + 1;
        const canWrite = !(Storage.isCloud && !Storage.isOnline);
        const rows = this._data.cats.map(k => {
            const n = counts[k.id] || 0;
            if (this._catEditId === k.id) {
                return `<div class="flex items-center gap-2 py-2 border-b border-gray-50 last:border-0">
                    <input id="cof-cat-edit-input" type="text" maxlength="40" value="${this._esc(k.name)}" aria-label="Novo nome da categoria"
                        class="flex-1 min-w-0 border-2 border-emerald-500 rounded-xl px-3 py-2 text-sm focus:outline-none">
                    <button type="button" data-cact="save" data-id="${k.id}" class="px-3 py-2 rounded-xl bg-emerald-600 text-white text-xs font-semibold">Salvar</button>
                    <button type="button" data-cact="cancel" aria-label="Cancelar" class="px-2 py-2 rounded-xl border border-gray-200 text-xs text-gray-500">✕</button>
                </div>`;
            }
            return `<div class="flex items-center gap-2 py-2 border-b border-gray-50 last:border-0">
                <div class="flex-1 min-w-0">
                    <div class="text-sm text-gray-800 truncate">${this._esc(k.name)}</div>
                    <div class="text-[10px] text-gray-400">${n === 0 ? 'nenhum cofrinho' : n === 1 ? '1 cofrinho' : n + ' cofrinhos'}</div>
                </div>
                ${canWrite ? `<button type="button" data-cact="edit" data-id="${k.id}" aria-label="Renomear ${this._esc(k.name)}" class="px-2 py-1 text-sm">✏️</button>
                <button type="button" data-cact="del" data-id="${k.id}" aria-label="Excluir ${this._esc(k.name)}" class="px-2 py-1 text-sm">🗑️</button>` : ''}
            </div>`;
        }).join('') || '<p class="text-xs text-gray-400 text-center py-3">Nenhuma categoria ainda. Crie uma acima ou toque numa sugestão.</p>';

        const sugg = this.SUGGESTED_CATEGORIES.filter(n => !this._dupCat(n));
        const suggHtml = canWrite && sugg.length ? `
            <div class="pt-1">
                <p class="text-[11px] text-gray-400 mb-1.5">Sugestões</p>
                <div class="flex flex-wrap gap-2">${sugg.map(n => `<button type="button" data-cact="sug" data-name="${this._esc(n)}"
                    class="px-3 py-1.5 rounded-full border border-dashed border-gray-300 text-xs text-gray-600 hover:bg-gray-50">+ ${this._esc(n)}</button>`).join('')}</div>
            </div>` : '';
        wrap.innerHTML = rows + suggHtml;
        if (this._catEditId) setTimeout(() => { const i = document.getElementById('cof-cat-edit-input'); i?.focus(); i?.select(); }, 30);
    },

    async _onCatsAction(btn) {
        const a = btn.dataset.cact, id = btn.dataset.id;
        try {
            if (a === 'edit')   { this._catEditId = id; this._catsError(''); return this._renderCats(); }
            if (a === 'cancel') { this._catEditId = null; this._catsError(''); return this._renderCats(); }
            if (a === 'add' || a === 'sug') {
                const input = document.getElementById('cof-cat-add-input');
                const k = await this.createCategory(a === 'sug' ? btn.dataset.name : input.value);
                this._data.cats.push(k);
                if (a === 'add') input.value = '';
            } else if (a === 'save') {
                const name = await this.renameCategory(id, document.getElementById('cof-cat-edit-input').value);
                const k = this._catById[id]; if (k) k.name = name;
                this._catEditId = null;
            } else if (a === 'del') {
                const k = this._catById[id];
                const n = this._data.cofrinhos.filter(c => c.category_id === id).length;
                if (!k || !confirm(`Excluir a categoria "${k.name}"?` + (n ? ` ${n === 1 ? 'O cofrinho dela ficará' : 'Os ' + n + ' cofrinhos dela ficarão'} sem categoria.` : ''))) return;
                await this.deleteCategory(id);
                this._data.cats = this._data.cats.filter(x => x.id !== id);
                this._data.cofrinhos = this._data.cofrinhos.map(c => (c.category_id === id ? { ...c, category_id: null } : c));
                if (this._ui.cat === id) this._ui.cat = '';
            }
            this._catsError('');
            this._setData({ ...this._data });
            this._renderCats();
            this._afterCatsChanged();
        } catch (e) { this._catsError(e.message || 'Não foi possível salvar a categoria.'); }
    },

    // Atualiza o que depende das categorias (formulário aberto, lista e detalhe)
    _afterCatsChanged() {
        const form = document.getElementById('cofrinho-form-modal');
        if (form && !form.classList.contains('hidden')) {
            this._fillCatSelect(document.getElementById('cof-category').value);
        }
        App.renderInvestmentsTab();
    },

    // ─── Depósito / retirada ──────────────────────────────────────────────────
    openMov(id, kind) {
        const c = this._data.cofrinhos.find(x => x.id === id);
        if (!c) return;
        this._mov = { id, kind: kind === 'retirada' ? 'retirada' : 'deposito' };
        const s = this._stats(c), isRet = this._mov.kind === 'retirada';
        document.getElementById('cof-mov-title').textContent = (isRet ? 'Retirar de ' : 'Depositar em ') + (c.emoji || '🐷') + ' ' + c.name;
        document.getElementById('cof-mov-hint').textContent = isRet
            ? `Guardado agora: ${this._money(s.saved)} (máximo para retirar)`
            : (s.done ? `Guardado agora: ${this._money(s.saved)} · meta já atingida` : `Guardado agora: ${this._money(s.saved)} · faltam ${this._money(s.remaining)}`);
        const pixBox = document.getElementById('cof-mov-pix');
        pixBox.innerHTML = !isRet && c.pix_key ? this._pixBlockHtml(c, 'id="cof-mov-pix-copy"') : '';
        pixBox.classList.toggle('hidden', isRet || !c.pix_key);
        document.getElementById('cof-mov-amount').value = '';
        document.getElementById('cof-mov-date').value   = this._today();
        document.getElementById('cof-mov-note').value   = '';
        const save = document.getElementById('cof-mov-save');
        save.textContent = isRet ? 'Retirar' : 'Depositar';
        save.className = 'flex-1 py-3 rounded-xl text-white text-sm font-bold ' + (isRet ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700');
        this._movError('');
        document.getElementById('cofrinho-mov-modal').classList.remove('hidden');
        setTimeout(() => document.getElementById('cof-mov-amount')?.focus(), 100);
    },

    closeMov() {
        document.getElementById('cofrinho-mov-modal')?.classList.add('hidden');
        this._mov = null;
    },

    _movError(msg) {
        const el = document.getElementById('cof-mov-error');
        if (!el) return;
        el.textContent = msg || '';
        el.classList.toggle('hidden', !msg);
    },

    async saveMov() {
        if (!this._mov) return;
        const c = this._data.cofrinhos.find(x => x.id === this._mov.id);
        if (!c) return this.closeMov();
        const kind = this._mov.kind, s = this._stats(c);
        const amount = App._parseMaskedCurrency(document.getElementById('cof-mov-amount').value);
        const date = document.getElementById('cof-mov-date').value || this._today();
        const note = document.getElementById('cof-mov-note').value;

        if (!(amount > 0)) return this._movError('Informe um valor maior que zero.');
        if (date > this._today()) return this._movError('A data não pode ser futura.');
        if (kind === 'retirada' && amount > s.saved + 0.004) {
            return this._movError(`Você só tem ${this._money(s.saved)} guardado neste cofrinho.`);
        }
        this._movError('');

        const btn = document.getElementById('cof-mov-save'), label = btn.textContent;
        btn.disabled = true; btn.textContent = 'Salvando...';
        try {
            await this.addMov(c.id, kind, amount, note, date);
            const reached = kind === 'deposito' && !s.done && s.target > 0 && s.saved + amount >= s.target;
            this.closeMov();
            App.showToast(reached ? '🎉 Meta atingida! Parabéns!'
                : (kind === 'deposito' ? '✅ Depósito de ' : '✅ Retirada de ') + this._money(amount) + (kind === 'deposito' ? ' registrado' : ' registrada'));
            await App.renderInvestmentsTab();
        } catch (e) {
            this._movError(e.message || 'Não foi possível salvar.');
        } finally {
            btn.disabled = false; btn.textContent = label;
        }
    }
};
