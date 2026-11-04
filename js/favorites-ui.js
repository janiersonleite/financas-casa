// Interface dos favoritos: seção "Lançar rápido" na Home, painel de valor (teclado de centavos), gerenciar/editar, toast com "Desfazer".
// Todo texto vindo do usuário passa por Utils.esc. Sem handlers inline (CSP): addEventListener/delegação.
const FavoritesUI = {
    list: [], loadError: false, panel: null, edit: null, _undo: null, _undoTimer: null, _confirmId: null, _confirmTimer: null,

    $(id) { return document.getElementById(id); },
    ICON: {
        saida:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
        entrada: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
    },

    // visualizador não usa favoritos (papel desconhecido na nuvem → espera carregar, para não piscar a seção)
    allowed() {
        const f = App.activeFinanca;
        if (!f) return false;
        if (!Storage.isCloud) return true;
        const role = App.myRole(f);
        return role !== undefined && role !== 'visualizador';
    },
    catName(fav) {
        const c = fav.category_id ? (App.categories || []).find(x => x.id === fav.category_id) : null;
        return c ? c.name : null;
    },

    // ───────────── Home ─────────────
    async renderHome() {
        const sec = this.$('home-fav'); if (!sec) return;
        if (!this.allowed()) { sec.classList.add('hidden'); return; }
        try { this.list = await Favorites.load(); this.loadError = false; } catch (_) { this.list = []; this.loadError = true; }
        sec.classList.remove('hidden');
        const grid = this.$('fav-grid');
        if (this.loadError) {
            grid.innerHTML = '<div class="fav-empty"><p class="text-sm text-gray-600 flex-1">Não foi possível carregar os favoritos.</p><button type="button" data-fav-retry class="text-sm font-semibold text-emerald-700" style="min-height:44px;padding:0 12px">Tentar de novo</button></div>';
            return;
        }
        if (!this.list.length) {
            grid.innerHTML = '<div class="fav-empty"><span class="text-2xl" aria-hidden="true">⚡</span><p class="text-sm text-gray-700 flex-1">Crie seus favoritos para lançar com um toque</p><button type="button" data-fav-new class="rounded-xl text-white text-sm font-bold" style="min-height:44px;padding:0 16px;background:#059669">Adicionar</button></div>';
            return;
        }
        grid.innerHTML = this.list.slice(0, Favorites.MAX).map(f => this.buttonHtml(f)).join('');
    },
    buttonHtml(f) {
        const T = Favorites.TYPES[f.type] || Favorites.TYPES.saida, cat = this.catName(f);
        const ini = Utils.esc((Array.from(f.name || '?')[0] || '?').toUpperCase());
        return `<button type="button" class="fav-btn t-${Utils.esc(f.type)}" data-fav-id="${Utils.esc(f.id)}"
            aria-label="${Utils.esc(`${T.label}: ${f.name}${cat ? ', categoria ' + cat : ''}. Toque para lançar`)}">
            <span class="fav-top"><span class="fav-ini" aria-hidden="true">${ini}</span><span class="fav-name">${Utils.esc(f.name)}</span></span>
            <span class="fav-cat">${Utils.esc(cat || 'Sem categoria')}</span>
            <span class="fav-badge b-${Utils.esc(f.type)}">${this.ICON[f.type] || ''}${T.label}</span>
        </button>`;
    },

    // ───────────── painel de valor ─────────────
    openPanel(fav, origin) {
        const T = Favorites.TYPES[fav.type]; if (!T) return;
        const cat = this.catName(fav);
        this.panel = { fav, cents: 0, launching: false, origin: origin || null };
        Metrics.begin('favorito', 1);
        this.$('fav-panel-title').textContent = `${T.label} · ${fav.name}`;
        this.$('fav-panel-cat').textContent = cat || 'Sem categoria';
        const w = App.activeFinanca, wal = this.$('fav-panel-wallet');
        wal.style.setProperty('--wallet-accent', Utils.walletColor(w?.id));
        wal.textContent = `Lançando em ${w?.name || 'Pessoal'}`;
        const cta = this.$('fav-cta');
        cta.textContent = T.cta; cta.style.background = fav.type === 'entrada' ? '#059669' : '#dc2626';
        const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'del'];
        const lab = { '00': 'zero zero', del: 'apagar', 0: 'zero' };
        this.$('fav-keypad').innerHTML = keys.map(k => `<button type="button" class="fav-key" data-key="${k}" aria-label="${lab[k] || k}">${k === 'del' ? '⌫' : k}</button>`).join('');
        this.$('fav-error').classList.add('hidden');
        this._paintAmount();
        this._open('fav-panel', 'fav-panel-box');
    },
    _paintAmount() {
        const p = this.panel; if (!p) return;
        const el = this.$('fav-amount'), T = Favorites.TYPES[p.fav.type];
        el.textContent = (p.cents > 0 ? T.sign : '') + Favorites.formatCents(p.cents);
        el.style.color = p.cents > 0 ? (p.fav.type === 'entrada' ? '#047857' : '#b91c1c') : '#94a3b8';
        const cta = this.$('fav-cta'); cta.disabled = p.cents <= 0 || p.launching;
    },
    press(key) {
        const p = this.panel; if (!p || p.launching) return;
        p.cents = Favorites.keypadPress(p.cents, key);
        this.$('fav-error').classList.add('hidden');
        this._paintAmount();
    },
    closePanel({ cancelled = true } = {}) {
        if (!this.panel) return;
        const origin = this.panel.origin; this.panel = null;
        if (cancelled) Metrics.cancel();
        this._close('fav-panel', origin);
    },

    // Lança: desabilita (anti duplo toque), insere, fecha, atualiza e mostra o toast com Desfazer
    async launch() {
        const p = this.panel;
        if (!p || p.launching || p.cents <= 0) return;
        p.launching = true; this._paintAmount();
        const fav = p.fav, T = Favorites.TYPES[fav.type], cents = p.cents;
        let tx;
        try {
            tx = await Storage.addTransaction({
                type: fav.type, category: this.catName(fav) || 'Outros', description: fav.name,
                value: Favorites.centsToValue(cents), date: Utils.todayLocal(),
            });
        } catch (e) {                                                        // mantém o painel aberto e o valor digitado
            p.launching = false; this._paintAmount();
            const er = this.$('fav-error'); er.textContent = `Não foi possível lançar: ${e?.message || 'erro desconhecido'}. Seu valor foi mantido; tente de novo.`; er.classList.remove('hidden');
            return;
        }
        Metrics.end();
        this.closePanel({ cancelled: false });
        try { await App.renderHome(); if (App.currentTab !== 'home') await App.renderCurrentTab(); } catch (_) {}
        // a grade foi redesenhada: devolve o foco ao botão do favorito (o nó antigo saiu da página)
        setTimeout(() => [...(this.$('fav-grid')?.querySelectorAll('[data-fav-id]') || [])].find(b => b.dataset.favId === fav.id)?.focus(), 120);
        this._toast(`Lançado: ${fav.name} ${T.sign}${Favorites.formatCents(cents)} (${T.verb})`, tx?.id);
    },
    _toast(text, txId) {
        const el = this.$('fav-toast'); if (!el) return;
        this.$('fav-toast-text').textContent = text;
        this._undo = txId || null;
        this.$('fav-undo').style.display = txId ? '' : 'none';
        el.classList.remove('hidden');
        clearTimeout(this._undoTimer);
        this._undoTimer = setTimeout(() => { el.classList.add('hidden'); this._undo = null; }, 6000);
    },
    // Desfazer: remove SOMENTE a transação recém-criada (pelo id retornado)
    async undo() {
        const id = this._undo; if (!id) return;
        this._undo = null; clearTimeout(this._undoTimer);
        this.$('fav-toast').classList.add('hidden');
        try { await Storage.deleteTransaction(id); await App.renderHome(); if (App.currentTab !== 'home') await App.renderCurrentTab(); App.showToast('Lançamento desfeito'); }
        catch (e) { App.showToast('❌ Não foi possível desfazer: ' + (e?.message || e), true); }
    },

    // ───────────── gerenciar ─────────────
    async openManage(origin) {
        this._manageOrigin = origin || this.$('fav-edit-btn');
        this.list = await Favorites.load().catch(() => this.list);
        await this.renderManage();
        this._open('fav-manage', 'fav-manage-box');
    },
    async renderManage() {
        const list = this.list, n = list.length;
        this.$('fav-counter').textContent = `Na Home (${n} de ${Favorites.MAX})`;
        const box = this.$('fav-manage-list');
        box.innerHTML = list.length ? list.map((f, i) => {
            const T = Favorites.TYPES[f.type] || Favorites.TYPES.saida, cat = this.catName(f);
            const conf = this._confirmId === f.id;
            return `<div class="fav-row" data-row="${Utils.esc(f.id)}">
                <div class="flex-1 min-w-0">
                    <div class="font-semibold text-gray-800 truncate">${Utils.esc(f.name)}</div>
                    <div class="flex items-center gap-1.5 mt-0.5"><span class="fav-badge b-${Utils.esc(f.type)}">${this.ICON[f.type] || ''}${T.label}</span>
                        <span class="text-xs text-gray-500 truncate">${Utils.esc(cat || 'Sem categoria')}</span></div>
                </div>
                <div class="fav-actions">
                    <button type="button" data-act="up" aria-label="Subir ${Utils.esc(f.name)}" ${i === 0 ? 'disabled' : ''}>▲</button>
                    <button type="button" data-act="down" aria-label="Descer ${Utils.esc(f.name)}" ${i === n - 1 ? 'disabled' : ''}>▼</button>
                    <button type="button" data-act="edit" aria-label="Editar ${Utils.esc(f.name)}">✏️</button>
                    <button type="button" data-act="del" aria-label="${conf ? 'Confirmar remoção de ' : 'Remover '}${Utils.esc(f.name)}" style="${conf ? 'background:#fee2e2;color:#991b1b;font-size:12px;font-weight:700' : ''}">${conf ? 'Confirmar?' : '🗑'}</button>
                </div></div>`;
        }).join('') : '<p class="text-sm text-gray-500">Nenhum favorito ainda.</p>';
        const add = this.$('fav-add'), help = this.$('fav-add-help'), cheio = n >= Favorites.MAX;
        add.disabled = cheio;
        help.textContent = cheio ? `Você já tem ${Favorites.MAX} favoritos. Remova um para adicionar outro: entradas e saídas dividem as ${Favorites.MAX} vagas.` : '';
        help.classList.toggle('hidden', !cheio);
        await this.renderSuggestions();
    },
    async renderSuggestions() {
        const wrap = this.$('fav-sugg-wrap'), box = this.$('fav-sugg-list');
        let txs = [];
        try { txs = await Storage.getTransactions({}); } catch (_) {}
        const sug = Favorites.suggest(txs, this.list).slice(0, 5);
        wrap.classList.toggle('hidden', !sug.length);
        const cheio = this.list.length >= Favorites.MAX;
        box.innerHTML = sug.map((s, i) => {
            const T = Favorites.TYPES[s.type];
            return `<div class="fav-row"><div class="flex-1 min-w-0"><div class="font-semibold text-gray-800 truncate">${Utils.esc(s.name)}</div>
                <div class="flex items-center gap-1.5 mt-0.5"><span class="fav-badge b-${Utils.esc(s.type)}">${this.ICON[s.type]}${T.label}</span><span class="text-xs text-gray-500 truncate">${Utils.esc(s.category || 'Sem categoria')}</span></div>
                <div class="text-xs text-gray-500 mt-0.5">Lançou ${s.count} vezes nos últimos ${Favorites.SUGGEST_DAYS} dias</div></div>
                <button type="button" data-sugg="${i}" class="rounded-xl text-white text-sm font-bold disabled:opacity-40" style="min-height:44px;min-width:44px;padding:0 14px;background:#059669" ${cheio ? 'disabled aria-label="Sem vagas: remova um favorito"' : ''}>Adicionar</button></div>`;
        }).join('');
        this._sugg = sug;
    },
    async addSuggestion(i) {
        const s = this._sugg?.[i]; if (!s) return;
        const cat = (App.categories || []).find(c => c.name === s.category && Favorites.categoryUsable(c) && Favorites.categoryFits(c, s.type));
        const msg = Favorites.validate(this.list, { name: s.name, type: s.type, categoryId: cat?.id || null }, App.categories);
        if (msg) { App.showToast(msg, true); return; }
        try { await Favorites.create({ name: s.name, type: s.type, categoryId: cat?.id || null }); } catch (e) { App.showToast(e.message, true); return; }
        this.list = await Favorites.load(); await this.renderManage(); this.renderHome();
    },

    // ───────────── criar / editar ─────────────
    openEdit(fav = null) {
        this.edit = { id: fav?.id || null, type: fav?.type || 'saida', categoryId: fav?.category_id || '', needCat: false };
        this.$('fav-edit-title').textContent = fav ? 'Editar favorito' : 'Novo favorito';
        this.$('fav-name').value = fav?.name || '';
        this.$('fav-edit-error').classList.add('hidden');
        this._paintEdit();
        this._open('fav-edit', 'fav-name', this.$('fav-add'));
    },
    _catOptions(type) {
        return (App.categories || []).filter(c => Favorites.categoryUsable(c) && Favorites.categoryFits(c, type));
    },
    _paintEdit() {
        const e = this.edit; if (!e) return;
        this.$('fav-type-seg').querySelectorAll('[data-fav-type]').forEach(b => {
            const on = b.dataset.favType === e.type;
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
            b.style.background = on ? (e.type === 'entrada' ? '#059669' : '#dc2626') : 'transparent';
            b.style.color = on ? '#fff' : '#475569';
        });
        const sel = this.$('fav-cat'), opts = this._catOptions(e.type);
        sel.innerHTML = `<option value="">Sem categoria</option>` + opts.map(c => `<option value="${Utils.esc(c.id)}">${Utils.esc(c.emoji || '')} ${Utils.esc(c.name)}</option>`).join('');
        sel.value = opts.some(c => c.id === e.categoryId) ? e.categoryId : '';
        const hint = this.$('fav-cat-hint');
        hint.textContent = e.needCat ? 'A categoria anterior não combina com este tipo. Escolha outra.' : '';
        hint.classList.toggle('hidden', !e.needCat);
    },
    setType(type) {
        const e = this.edit; if (!e || e.type === type) return;
        e.type = type;
        const cur = (App.categories || []).find(c => c.id === e.categoryId);
        if (cur && !Favorites.categoryFits(cur, type)) { e.categoryId = ''; e.needCat = true; }     // categoria incompatível: limpa e pede nova
        this._paintEdit();
    },
    async saveEdit() {
        const e = this.edit; if (!e) return;
        const name = this.$('fav-name').value, categoryId = this.$('fav-cat').value || null;
        const err = this.$('fav-edit-error');
        const msg = Favorites.validate(this.list, { id: e.id, name, type: e.type, categoryId }, App.categories);
        if (msg) { err.textContent = msg; err.classList.remove('hidden'); return; }
        const btn = this.$('fav-edit-save'); btn.disabled = true;
        try {
            if (e.id) await Favorites.update(e.id, { name, type: e.type, categoryId });
            else await Favorites.create({ name, type: e.type, categoryId });
        } catch (x) { err.textContent = x.message; err.classList.remove('hidden'); btn.disabled = false; return; }
        btn.disabled = false;
        this.list = await Favorites.load(); this.edit = null; this._close('fav-edit', this.$('fav-add'));
        await this.renderManage(); this.renderHome();
    },
    async rowAction(id, act) {
        if (act === 'edit') { const f = this.list.find(x => x.id === id); if (f) this.openEdit(f); return; }
        if (act === 'up' || act === 'down') { try { this.list = await Favorites.move(id, act === 'up' ? -1 : 1); } catch (e) { App.showToast(e.message, true); } await this.renderManage(); this.renderHome(); return; }
        if (act === 'del') {
            if (this._confirmId !== id) {                                      // confirmação leve: 2º toque em até 4 s
                this._confirmId = id; clearTimeout(this._confirmTimer);
                this._confirmTimer = setTimeout(() => { this._confirmId = null; this.renderManage(); }, 4000);
                return this.renderManage();
            }
            this._confirmId = null; clearTimeout(this._confirmTimer);
            try { await Favorites.remove(id); } catch (e) { App.showToast(e.message, true); }
            this.list = await Favorites.load().catch(() => this.list); await this.renderManage(); this.renderHome();
        }
    },

    // ───────────── foco / diálogos ─────────────
    _stack: [],
    _open(overlayId, focusId, returnTo = null) {
        const ov = this.$(overlayId);
        this._stack.push({ overlayId, returnTo: returnTo || document.activeElement });
        ov.classList.remove('hidden'); ov.setAttribute('aria-hidden', 'false');
        const t = this.$(focusId); if (t) setTimeout(() => t.focus(), 30);
    },
    _close(overlayId, returnTo = null) {
        const ov = this.$(overlayId); ov.classList.add('hidden'); ov.setAttribute('aria-hidden', 'true');
        const i = this._stack.map(s => s.overlayId).lastIndexOf(overlayId);
        const ent = i >= 0 ? this._stack.splice(i, 1)[0] : null;
        const back = returnTo || ent?.returnTo;
        if (back && document.body.contains(back) && back.focus) setTimeout(() => back.focus(), 30);   // devolve o foco ao botão de origem
    },
    _onKey(e) {
        const top = this._stack[this._stack.length - 1]; if (!top) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            if (top.overlayId === 'fav-panel') this.closePanel();
            else if (top.overlayId === 'fav-edit') { this.edit = null; this._close('fav-edit', this.$('fav-add')); }
            else if (top.overlayId === 'fav-manage') this._close('fav-manage', this._manageOrigin);
        } else if (e.key === 'Tab') {                                              // mantém o Tab dentro do diálogo aberto
            const box = this.$(top.overlayId)?.querySelector('[role="dialog"]'); if (!box) return;
            const f = [...box.querySelectorAll('button:not([disabled]), input, select, [tabindex]:not([tabindex="-1"])')].filter(x => x.offsetParent !== null || x === document.activeElement);
            if (!f.length) return;
            const first = f[0], last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    },

    init() {
        if (this._bound || !this.$('home-fav')) return; this._bound = true;
        this.$('fav-grid').addEventListener('click', e => {
            const b = e.target.closest('[data-fav-id]');
            if (b) { const f = this.list.find(x => x.id === b.dataset.favId); if (f) this.openPanel(f, b); return; }
            if (e.target.closest('[data-fav-new]')) { this.openManage(e.target.closest('[data-fav-new]')).then(() => this.openEdit()); return; }
            if (e.target.closest('[data-fav-retry]')) this.renderHome();
        });
        this.$('fav-edit-btn').addEventListener('click', e => this.openManage(e.currentTarget));
        this.$('fav-keypad').addEventListener('click', e => { const k = e.target.closest('[data-key]'); if (k) this.press(k.dataset.key); });
        this.$('fav-cta').addEventListener('click', () => this.launch());
        this.$('fav-panel-close').addEventListener('click', () => this.closePanel());
        this.$('fav-panel').addEventListener('click', e => { if (e.target === e.currentTarget) this.closePanel(); });
        this.$('fav-undo').addEventListener('click', () => this.undo());
        this.$('fav-manage-close').addEventListener('click', () => this._close('fav-manage', this._manageOrigin));
        this.$('fav-manage').addEventListener('click', e => { if (e.target === e.currentTarget) this._close('fav-manage', this._manageOrigin); });
        this.$('fav-add').addEventListener('click', () => this.openEdit());
        this.$('fav-manage-list').addEventListener('click', e => { const b = e.target.closest('[data-act]'), r = e.target.closest('[data-row]'); if (b && r) this.rowAction(r.dataset.row, b.dataset.act); });
        this.$('fav-sugg-list').addEventListener('click', e => { const b = e.target.closest('[data-sugg]'); if (b && !b.disabled) this.addSuggestion(Number(b.dataset.sugg)); });
        this.$('fav-type-seg').addEventListener('click', e => { const b = e.target.closest('[data-fav-type]'); if (b) this.setType(b.dataset.favType); });
        this.$('fav-cat').addEventListener('change', e => { if (this.edit) { this.edit.categoryId = e.target.value; this.edit.needCat = false; this._paintEdit(); } });
        this.$('fav-edit-save').addEventListener('click', () => this.saveEdit());
        const closeEdit = () => { this.edit = null; this._close('fav-edit', this.$('fav-add')); };
        this.$('fav-edit-cancel').addEventListener('click', closeEdit); this.$('fav-edit-close').addEventListener('click', closeEdit);
        this.$('fav-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.saveEdit(); } });
        document.addEventListener('keydown', e => this._onKey(e));
    },
};
