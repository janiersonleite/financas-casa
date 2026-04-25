// ─── State ───────────────────────────────────────────────────────────────────
const App = {
    currentTab: 'home',
    editingId:  null,
    chart:      null,
    recognition: null,
    isListening: false,
    currentMonth: new Date().toISOString().slice(0, 7),
    financas:      [],
    activeFinanca: null,
    categories:    [],
    editingCatId:  null,
    trendChart:    null,
    transactionTypes:   [],
    editingTypeId:      null,
    customTypesChart:   null,

    // ─── Init ─────────────────────────────────────────────────────────────────
    async init() {
        await Auth.init();
        Auth.bindUI();
        this.bindNav();
        this.bindQuickInput();
        this.bindModal();
        this.bindOCR();
        this.bindVoice();
        this.bindMonthNav();
        this.bindFinancaUI();
        this.bindCategoryUI();
        this.bindExportButtons();
        this.bindImportUI();
        this.bindOfflineSync();
        this.bindTypesUI();
        await this.loadFinancas();
        await this.loadTransactionTypes();
        await this.loadCategories();
        await this.renderHome();
        this.refreshMonthDisplay();
        // Aquece o cache offline em segundo plano (não bloqueia a UI)
        if (navigator.onLine) this._warmOfflineCache();
        // Verifica se há comprovante compartilhado (PWA share target)
        if (window.__pendingShared) await this.checkSharedContent();
    },

    // ─── Finances ─────────────────────────────────────────────────────────────
    async loadFinancas() {
        try {
            let financas = await Storage.getFinancas();
            if (!financas.length) {
                try {
                    const f = await Storage.createFinanca('Pessoal', 'individual', '💰');
                    financas = [f];
                } catch (createErr) {
                    console.warn('Não foi possível criar finança na nuvem, usando local:', createErr.message);
                    // Fallback: id null faz as queries usarem user_id em vez de financa_id
                    financas = [{ id: null, name: 'Pessoal', emoji: '💰', type: 'individual', owner_id: 'local' }];
                }
            }
            this.financas = financas;

            // Auto-accept pending invites via SECURITY DEFINER function
            if (Storage.isCloud) {
                try {
                    const { data: accepted } = await Storage.db.rpc('auto_accept_my_invites');
                    if (accepted > 0) {
                        // Reload financas so newly accepted ones appear
                        const { data: refreshed } = await Storage.db
                            .from('financas').select('*').order('created_at', { ascending: true });
                        financas = refreshed ?? financas;
                        this.financas = financas;
                        this.showToast(`✅ Você foi adicionado a ${accepted} finança${accepted > 1 ? 's' : ''}!`);
                    }
                } catch (_) {}
            }

            // Restore active finance from localStorage
            const storedId = localStorage.getItem('active_financa_id');
            const found = storedId ? financas.find(f => f.id === storedId) : null;
            this.activeFinanca = found || financas[0] || null;
            Storage.setActiveFinanca(this.activeFinanca?.id || null);
            this.renderFinancaSwitcher();
        } catch (e) {
            console.error('loadFinancas error:', e);
            // Garante que o switcher sempre renderiza
            this.activeFinanca = { id: null, name: 'Pessoal', emoji: '💰', type: 'individual' };
            this.renderFinancaSwitcher();
        }
    },

    renderFinancaSwitcher() {
        const nameEl  = document.getElementById('financa-switcher-name');
        const emojiEl = document.getElementById('financa-switcher-emoji');
        if (nameEl)  nameEl.textContent  = this.activeFinanca?.name  || 'Finanças';
        if (emojiEl) emojiEl.textContent = this.activeFinanca?.emoji || '💰';
    },

    bindFinancaUI() {
        // Switcher → open list
        document.getElementById('financa-switcher')?.addEventListener('click', () => this.openFinancaModal());

        // Finance list modal
        const fModal = document.getElementById('financa-modal');
        document.getElementById('financa-modal-close')?.addEventListener('click', () => this.closeFinancaModal());
        fModal?.addEventListener('click', e => { if (e.target === fModal) this.closeFinancaModal(); });

        // Create finance
        document.getElementById('financa-create-btn')?.addEventListener('click', () => {
            this.closeFinancaModal();
            this.openCreateFinancaModal();
        });
        const cModal = document.getElementById('financa-create-modal');
        document.getElementById('financa-create-cancel')?.addEventListener('click', () => this.closeCreateFinancaModal());
        cModal?.addEventListener('click', e => { if (e.target === cModal) this.closeCreateFinancaModal(); });
        document.getElementById('financa-create-save')?.addEventListener('click', () => this.saveNewFinanca());

        // Emoji picker
        document.querySelectorAll('.financa-emoji-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.financa-emoji-btn').forEach(b => {
                    b.classList.remove('border-blue-400', 'bg-blue-50');
                    b.classList.add('border-gray-200', 'bg-gray-50');
                });
                btn.classList.add('border-blue-400', 'bg-blue-50');
                btn.classList.remove('border-gray-200', 'bg-gray-50');
            });
        });

        // Type toggle
        document.querySelectorAll('[data-ftype]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-ftype]').forEach(b => {
                    b.classList.remove('border-blue-400', 'bg-blue-50', 'text-blue-700');
                    b.classList.add('border-gray-200', 'text-gray-600');
                });
                btn.classList.add('border-blue-400', 'bg-blue-50', 'text-blue-700');
                btn.classList.remove('border-gray-200', 'text-gray-600');
                document.getElementById('financa-type-input').value = btn.dataset.ftype;
            });
        });

        // Share modal
        document.getElementById('financa-share-btn')?.addEventListener('click', () => {
            if (this.activeFinanca) this.openShareModal(this.activeFinanca);
        });
        const sModal = document.getElementById('share-modal');
        document.getElementById('share-modal-close')?.addEventListener('click', () => this.closeShareModal());
        sModal?.addEventListener('click', e => { if (e.target === sModal) this.closeShareModal(); });
        document.getElementById('invite-send')?.addEventListener('click', () => this.sendInvite());
        document.getElementById('link-txns-btn')?.addEventListener('click', () => this.linkTransactionsToFinanca());
        document.getElementById('invite-banner-btn')?.addEventListener('click', () => this.showPendingInvitesModal());
        document.getElementById('invite-banner-dismiss')?.addEventListener('click', () => {
            document.getElementById('invite-banner').classList.add('hidden');
        });
        document.getElementById('check-invites-btn')?.addEventListener('click', () => this.manualCheckInvites());
    },

    openFinancaModal() {
        document.getElementById('financa-modal').classList.remove('hidden');
        this.renderFinancaList();
    },

    closeFinancaModal() {
        document.getElementById('financa-modal').classList.add('hidden');
    },

    renderFinancaList() {
        const container = document.getElementById('financa-list');
        if (!this.financas.length) { container.innerHTML = ''; return; }
        container.innerHTML = this.financas.map(f => {
            const isActive = f.id === this.activeFinanca?.id;
            const isOwner  = f.owner_id === Auth.user?.id || f.owner_id === 'local';
            return `
            <div class="flex items-center gap-3 p-3 mb-2 rounded-xl border-2 cursor-pointer transition-all ${isActive ? 'border-blue-400 bg-blue-50' : 'border-gray-100 bg-white hover:border-gray-300'}" data-financa-select="${f.id}">
                <span class="text-2xl">${f.emoji || '💰'}</span>
                <div class="flex-1 min-w-0">
                    <div class="font-semibold text-gray-800 truncate">${f.name}</div>
                    <div class="text-xs text-gray-400">${f.type === 'compartilhada' ? '👥 Compartilhada' : '👤 Individual'}</div>
                </div>
                ${isActive ? '<span class="text-blue-500 text-lg">✓</span>' : ''}
                ${isOwner ? `<button class="text-gray-300 hover:text-red-400 text-lg px-1 delete-financa-btn" data-financa-del="${f.id}" title="Excluir">🗑</button>` : ''}
            </div>`;
        }).join('');

        container.querySelectorAll('[data-financa-select]').forEach(el => {
            el.addEventListener('click', async e => {
                if (e.target.closest('.delete-financa-btn')) return;
                const f = this.financas.find(x => x.id === el.dataset.financaSelect);
                if (!f) return;
                this.activeFinanca = f;
                Storage.setActiveFinanca(f.id);
                this.closeFinancaModal();
                this.renderFinancaSwitcher();
                await this.renderCurrentTab();
                if (navigator.onLine) this._warmOfflineCache();
                if (this.currentTab !== 'home') await this.renderHome();
            });
        });

        container.querySelectorAll('.delete-financa-btn').forEach(btn => {
            btn.addEventListener('click', async e => {
                e.stopPropagation();
                const f = this.financas.find(x => x.id === btn.dataset.financaDel);
                if (!confirm(`Excluir "${f?.name}"? Todos os lançamentos serão removidos.`)) return;
                try {
                    await Storage.deleteFinanca(btn.dataset.financaDel);
                    this.financas = this.financas.filter(x => x.id !== btn.dataset.financaDel);
                    if (this.activeFinanca?.id === btn.dataset.financaDel) {
                        this.activeFinanca = this.financas[0] || null;
                        Storage.setActiveFinanca(this.activeFinanca?.id || null);
                        this.renderFinancaSwitcher();
                    }
                    this.renderFinancaList();
                } catch (err) { this.showToast('❌ Erro ao excluir', true); }
            });
        });
    },

    openCreateFinancaModal() {
        document.getElementById('financa-create-modal').classList.remove('hidden');
        document.getElementById('financa-name-input').value = '';
        document.getElementById('financa-type-input').value = 'individual';
        // Reset emoji to first
        document.querySelectorAll('.financa-emoji-btn').forEach((b, i) => {
            b.classList.toggle('border-blue-400', i === 0);
            b.classList.toggle('bg-blue-50',      i === 0);
            b.classList.toggle('border-gray-200',  i !== 0);
            b.classList.toggle('bg-gray-50',       i !== 0);
        });
        // Reset type
        document.querySelectorAll('[data-ftype]').forEach(b => {
            const sel = b.dataset.ftype === 'individual';
            b.classList.toggle('border-blue-400', sel);
            b.classList.toggle('bg-blue-50',      sel);
            b.classList.toggle('text-blue-700',   sel);
            b.classList.toggle('border-gray-200', !sel);
            b.classList.toggle('text-gray-600',   !sel);
        });
        setTimeout(() => document.getElementById('financa-name-input').focus(), 100);
    },

    closeCreateFinancaModal() {
        document.getElementById('financa-create-modal').classList.add('hidden');
    },

    async saveNewFinanca() {
        const name  = document.getElementById('financa-name-input').value.trim();
        if (!name) { document.getElementById('financa-name-input').focus(); return; }
        const type  = document.getElementById('financa-type-input').value;
        const emoji = document.querySelector('.financa-emoji-btn.border-blue-400')?.dataset.emoji || '💰';
        const btn   = document.getElementById('financa-create-save');
        btn.disabled = true; btn.textContent = 'Criando...';
        try {
            const f = await Storage.createFinanca(name, type, emoji);
            this.financas.push(f);
            this.activeFinanca = f;
            Storage.setActiveFinanca(f.id);
            this.closeCreateFinancaModal();
            this.renderFinancaSwitcher();
            await this.renderCurrentTab();
            this.showToast('✅ Finança criada!');
        } catch (e) {
            this.showToast('❌ ' + e.message, true);
        } finally {
            btn.disabled = false; btn.textContent = 'Criar';
        }
    },

    async openShareModal(financa) {
        document.getElementById('share-modal').classList.remove('hidden');
        document.getElementById('share-financa-name').textContent = `${financa.emoji} ${financa.name}`;
        document.getElementById('invite-email').value = '';
        await this.renderMembersList(financa.id);
        await this.renderLinkSection(financa);
    },

    async renderLinkSection(financa) {
        const section = document.getElementById('link-txns-section');
        if (!Storage.isCloud || financa.type !== 'compartilhada') { section.classList.add('hidden'); return; }
        try {
            const { count } = await Storage.db
                .from('transactions')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', Storage.userId())
                .is('financa_id', null);
            if (count > 0) {
                section.classList.remove('hidden');
                const countEl = document.getElementById('link-txns-count');
                countEl.textContent = `${count} lançamento${count !== 1 ? 's' : ''} pessoal${count !== 1 ? 'is' : ''} sem vínculo`;
                countEl.classList.remove('hidden');
            } else {
                section.classList.add('hidden');
            }
        } catch { section.classList.add('hidden'); }
    },

    closeShareModal() {
        document.getElementById('share-modal').classList.add('hidden');
    },

    async renderMembersList(financaId) {
        const [members, invites] = await Promise.all([
            Storage.getMembers(financaId),
            Storage.getPendingInvites(financaId)
        ]);

        const membersEl = document.getElementById('members-list');
        membersEl.innerHTML = members.length ? members.map(m => `
            <div class="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
                <div class="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-sm font-bold text-blue-600">
                    ${(m.email || 'U').charAt(0).toUpperCase()}
                </div>
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium text-gray-800 truncate">${m.email || 'Usuário'}</div>
                    <div class="text-xs text-gray-400">${m.role === 'admin' ? '⭐ Admin' : m.role === 'visualizador' ? '👁 Visualizador' : '👤 Membro'}</div>
                </div>
                ${m.user_id !== Auth.user?.id
                    ? `<button class="text-gray-300 hover:text-red-400 text-lg remove-member-btn" data-member-id="${m.id}">✕</button>`
                    : '<span class="text-xs text-blue-500 font-medium">Você</span>'}
            </div>
        `).join('') : '<p class="text-sm text-gray-400 py-2">Nenhum membro ainda</p>';

        membersEl.querySelectorAll('.remove-member-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Remover este membro?')) return;
                try {
                    await Storage.removeMember(financaId, btn.dataset.memberId);
                    await this.renderMembersList(financaId);
                } catch (e) { this.showToast('❌ Erro ao remover', true); }
            });
        });

        const invitesSection = document.getElementById('invites-section');
        const invitesList    = document.getElementById('invites-list');
        if (invites.length) {
            invitesSection.classList.remove('hidden');
            invitesList.innerHTML = invites.map(inv => `
                <div class="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
                    <div class="w-8 h-8 rounded-full bg-yellow-100 flex items-center justify-center text-sm">⏳</div>
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-medium text-gray-800 truncate">${inv.email}</div>
                        <div class="text-xs text-gray-400">Aguardando aceite</div>
                    </div>
                    <button class="text-gray-300 hover:text-red-400 text-lg cancel-invite-btn" data-invite-id="${inv.id}">✕</button>
                </div>
            `).join('');
            invitesList.querySelectorAll('.cancel-invite-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    await Storage.cancelInvite(btn.dataset.inviteId);
                    await this.renderMembersList(financaId);
                });
            });
        } else {
            invitesSection.classList.add('hidden');
        }
    },

    async sendInvite() {
        const email = document.getElementById('invite-email').value.trim();
        const role  = document.getElementById('invite-role').value;
        if (!email || !this.activeFinanca) { document.getElementById('invite-email').focus(); return; }
        const btn = document.getElementById('invite-send');
        btn.disabled = true; btn.textContent = '...';
        try {
            const result = await Storage.inviteMember(this.activeFinanca.id, email, role);
            document.getElementById('invite-email').value = '';
            await this.renderMembersList(this.activeFinanca.id);
            this.showToast(result === 'added' ? '✅ Membro adicionado diretamente!' : '✅ Convite enviado!');
        } catch (e) {
            this.showToast('❌ ' + e.message, true);
        } finally {
            btn.disabled = false; btn.textContent = 'Enviar';
        }
    },

    async linkTransactionsToFinanca() {
        if (!this.activeFinanca || !Storage.isCloud) return;
        const btn = document.getElementById('link-txns-btn');
        btn.disabled = true; btn.textContent = 'Vinculando...';
        try {
            const { data, error } = await Storage.db.rpc('link_my_transactions_to_financa', { fid: this.activeFinanca.id });
            if (error) throw error;
            const n = data ?? 0;
            this.showToast(`✅ ${n} lançamento${n !== 1 ? 's' : ''} vinculado${n !== 1 ? 's' : ''}!`);
            document.getElementById('link-txns-section').classList.add('hidden');
            await this.renderCurrentTab();
        } catch (e) {
            this.showToast('❌ Erro ao vincular: ' + e.message, true);
        } finally {
            btn.disabled = false; btn.textContent = '🔗 Vincular meus lançamentos a esta finança';
        }
    },

    async manualCheckInvites() {
        const sub = document.getElementById('check-invites-sub');
        sub.textContent = 'Verificando...';
        try {
            const invites = await Storage.checkMyInvites();
            if (!invites.length) {
                sub.textContent = 'Nenhum convite pendente encontrado.';
                return;
            }
            this.closeFinancaModal();
            await this.showPendingInvitesModal(invites);
        } catch (e) {
            sub.textContent = 'Erro ao verificar: ' + e.message;
        }
    },

    async showInviteNotification(invites) {
        // Show persistent banner instead of confirm() dialog
        const banner   = document.getElementById('invite-banner');
        const bannerTx = document.getElementById('invite-banner-text');
        this._pendingInvites = invites;
        const names = invites.map(i => `${i.financa?.emoji || '💰'} ${i.financa?.name || 'Finança'}`).join(', ');
        bannerTx.textContent = `Convite${invites.length > 1 ? 's' : ''}: ${names}`;
        banner.classList.remove('hidden');
        // Offset tab content so banner doesn't overlap
        document.getElementById('tab-home').style.paddingTop = '52px';
    },

    async showPendingInvitesModal(invites) {
        invites = invites || this._pendingInvites || [];
        for (const invite of invites) {
            const financa = invite.financa;
            const name = `${financa?.emoji || '💰'} ${financa?.name || 'uma finança'}`;
            if (!confirm(`Você foi convidado para "${name}". Aceitar?`)) continue;
            try {
                await Storage.acceptInvite(invite.id, invite.financa_id);
                this.showToast(`✅ Agora você faz parte de "${name}"!`);
            } catch (e) {
                this.showToast('❌ Erro ao aceitar convite: ' + e.message, true);
            }
        }
        document.getElementById('invite-banner').classList.add('hidden');
        document.getElementById('tab-home').style.paddingTop = '';
        this._pendingInvites = [];
        await this.loadFinancas();
        await this.renderCurrentTab();
    },

    // ─── Navigation ───────────────────────────────────────────────────────────
    bindNav() {
        document.querySelectorAll('[data-tab]').forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
        });
    },

    async switchTab(tab) {
        this.currentTab = tab;
        document.querySelectorAll('.tab-page').forEach(p => p.classList.add('hidden'));
        document.getElementById(`tab-${tab}`).classList.remove('hidden');
        document.querySelectorAll('[data-tab]').forEach(b => {
            b.classList.toggle('tab-active', b.dataset.tab === tab);
        });
        await this.renderCurrentTab();
    },

    // ─── Quick Input ──────────────────────────────────────────────────────────
    bindQuickInput() {
        const input = document.getElementById('quick-input');
        const btn   = document.getElementById('quick-send');
        btn.addEventListener('click', () => this.processQuickInput());
        input.addEventListener('keydown', e => { if (e.key === 'Enter') this.processQuickInput(); });
        document.querySelectorAll('[data-quick-cat]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.openModal({
                    category:    btn.dataset.quickCat,
                    type:        btn.dataset.quickType || 'saida',
                    description: btn.dataset.quickLabel || btn.dataset.quickCat
                });
            });
        });
    },

    processQuickInput() {
        const input  = document.getElementById('quick-input');
        const text   = input.value.trim();
        if (!text) { this.openModal({ focusValue: true }); return; }
        const parsed = NLP.parse(text);
        input.value  = '';
        this.openModal({ ...parsed, focusValue: !parsed.value });
    },

    // ─── Modal ────────────────────────────────────────────────────────────────
    bindModal() {
        document.getElementById('modal-close').addEventListener('click',  () => this.closeModal());
        document.getElementById('modal-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('modal-save').addEventListener('click',   () => this.saveModal());
        document.getElementById('modal-overlay').addEventListener('click', e => {
            if (e.target === e.currentTarget) this.closeModal();
        });
        document.getElementById('modal-types-container').addEventListener('click', e => {
            const btn = e.target.closest('[data-type-btn]');
            if (btn) this.selectModalType(btn.dataset.typeBtn);
        });
        document.getElementById('manage-types-link')?.addEventListener('click', () => this.openTypesModal());
    },

    openModal(data = {}) {
        this.editingId = data.id || null;
        document.getElementById('modal-overlay').classList.remove('hidden');
        document.getElementById('modal-title').textContent = this.editingId ? 'Editar Lançamento' : 'Novo Lançamento';
        document.getElementById('modal-value').value       = data.value || '';
        document.getElementById('modal-description').value = data.description || '';
        document.getElementById('modal-date').value        = data.date || new Date().toISOString().split('T')[0];
        document.getElementById('modal-notes').value       = data.rawText ? '📎 Processado via OCR' : (data.notes || '');
        this.renderModalTypeBtns();
        this.selectModalType(data.type || 'saida');
        this.renderCategorySelect(data.category || 'Outros');
        if (data.focusValue) setTimeout(() => document.getElementById('modal-value').focus(), 100);
    },

    closeModal() {
        document.getElementById('modal-overlay').classList.add('hidden');
        this.editingId = null;
    },

    async saveModal() {
        const value = parseFloat(document.getElementById('modal-value').value);
        if (!value || value <= 0) { this.shake(document.getElementById('modal-value')); return; }
        const transaction = {
            value,
            type:        document.getElementById('modal-type').value,
            category:    document.getElementById('modal-category').value,
            description: document.getElementById('modal-description').value || 'Sem descrição',
            date:        document.getElementById('modal-date').value,
            notes:       document.getElementById('modal-notes').value
        };
        const btn = document.getElementById('modal-save');
        btn.disabled = true; btn.textContent = 'Salvando...';
        try {
            let result;
            if (this.editingId) await Storage.updateTransaction(this.editingId, transaction);
            else                result = await Storage.addTransaction(transaction);
            this.closeModal();
            await this.renderCurrentTab();
            if (result?._constraintFallback) {
                this.showToast('⚠️ Salvo localmente. Para sincronizar, remova a restrição no Supabase (SQL: ALTER TABLE transactions DROP CONSTRAINT transactions_type_check)', true);
            } else {
                this.showToast(this.editingId ? 'Lançamento atualizado!' : '✅ Lançamento salvo!');
            }
        } catch (e) {
            this.showToast('❌ Erro ao salvar: ' + e.message, true);
        } finally {
            btn.disabled = false; btn.textContent = 'Salvar';
        }
    },

    updateModalColors(typeId) {
        const h    = document.getElementById('modal-header');
        const type = (this.transactionTypes || []).find(t => t.id === typeId);
        const hex  = type ? this._getTypeColorHex(type.color) : (typeId === 'entrada' ? '#22c55e' : '#ef4444');
        h.className    = 'p-4 text-white rounded-t-2xl';
        h.style.background = hex;
    },

    // ─── Transaction Types ────────────────────────────────────────────────────
    async loadTransactionTypes() {
        this.transactionTypes = await Storage.getTransactionTypes();
    },

    _getTypeColorHex(color) {
        const map = { red: '#ef4444', green: '#22c55e', purple: '#a855f7', teal: '#14b8a6', orange: '#f97316', indigo: '#6366f1', pink: '#ec4899', yellow: '#eab308', gray: '#6b7280' };
        return map[color] || '#6b7280';
    },

    renderModalTypeBtns() {
        const container = document.getElementById('modal-types-container');
        if (!container) return;
        container.innerHTML = this.transactionTypes.map(t => {
            const hex = this._getTypeColorHex(t.color);
            return `<button data-type-btn="${t.id}"
                class="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border-2 transition-all"
                style="border-color:#e5e7eb;color:#374151;" data-hex="${hex}">
                ${t.emoji} ${t.name}
            </button>`;
        }).join('');
    },

    selectModalType(typeId) {
        const container = document.getElementById('modal-types-container');
        if (!container) return;
        container.querySelectorAll('[data-type-btn]').forEach(btn => {
            if (btn.dataset.typeBtn === typeId) {
                const hex = btn.dataset.hex;
                btn.style.borderColor      = hex;
                btn.style.backgroundColor  = hex + '22';
                btn.style.color            = hex;
            } else {
                btn.style.borderColor      = '#e5e7eb';
                btn.style.backgroundColor  = '';
                btn.style.color            = '#374151';
            }
        });
        document.getElementById('modal-type').value = typeId;
        this.updateModalColors(typeId);
    },

    bindTypesUI() {
        const tModal = document.getElementById('types-modal');
        document.getElementById('types-modal-close')?.addEventListener('click', () => this.closeTypesModal());
        tModal?.addEventListener('click', e => { if (e.target === tModal) this.closeTypesModal(); });
        document.getElementById('type-add-btn')?.addEventListener('click', () => this.openTypeForm());

        const fModal = document.getElementById('type-form-modal');
        document.getElementById('type-form-close')?.addEventListener('click',   () => this.closeTypeForm());
        document.getElementById('type-form-cancel')?.addEventListener('click',  () => this.closeTypeForm());
        fModal?.addEventListener('click', e => { if (e.target === fModal) this.closeTypeForm(); });
        document.getElementById('type-form-save')?.addEventListener('click',    () => this.saveTypeForm());

        document.querySelectorAll('[data-behavior]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-behavior]').forEach(b => {
                    b.className = 'behavior-btn py-2.5 px-1 rounded-xl text-xs font-semibold border-2 border-gray-200 text-gray-600 transition-all';
                });
                btn.className = 'behavior-btn py-2.5 px-1 rounded-xl text-xs font-semibold border-2 border-blue-400 bg-blue-50 text-blue-700 transition-all';
                document.getElementById('type-behavior-input').value = btn.dataset.behavior;
            });
        });

        document.querySelectorAll('.type-color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.type-color-btn').forEach(b => { b.style.outline = ''; b.style.outlineOffset = ''; });
                btn.style.outline       = '3px solid ' + btn.style.background;
                btn.style.outlineOffset = '2px';
                document.getElementById('type-color-input').value = btn.dataset.color;
            });
        });

        document.getElementById('type-emoji-btn')?.addEventListener('click', e => {
            e.stopPropagation();
            this._buildTypeEmojiPicker();
            document.getElementById('type-emoji-picker').classList.toggle('hidden');
        });
        document.addEventListener('click', e => {
            if (!e.target.closest('#type-emoji-btn') && !e.target.closest('#type-emoji-picker')) {
                document.getElementById('type-emoji-picker')?.classList.add('hidden');
            }
        });
    },

    _buildTypeEmojiPicker() {
        const grid = document.getElementById('type-emoji-grid');
        if (!grid || grid.dataset.built) return;
        grid.dataset.built = '1';
        grid.innerHTML = this._emojiPickerList.map(e =>
            `<button type="button" data-emoji="${e}" class="text-2xl p-1 rounded-lg hover:bg-blue-50 transition-colors leading-none">${e}</button>`
        ).join('');
        grid.addEventListener('click', e => {
            const btn = e.target.closest('[data-emoji]');
            if (!btn) return;
            document.getElementById('type-emoji-input').value    = btn.dataset.emoji;
            document.getElementById('type-emoji-btn').textContent = btn.dataset.emoji;
            document.getElementById('type-emoji-picker').classList.add('hidden');
        });
    },

    openTypesModal() {
        document.getElementById('types-modal').classList.remove('hidden');
        this.renderTypesList();
    },

    closeTypesModal() {
        document.getElementById('types-modal').classList.add('hidden');
    },

    renderTypesList() {
        const container = document.getElementById('custom-types-list');
        if (!container) return;
        const customs = Storage.getCustomTypes();
        if (!customs.length) {
            container.innerHTML = '<p class="text-xs text-gray-400 text-center py-3">Nenhum tipo personalizado ainda</p>';
            return;
        }
        const behaviorLabel = { soma: '➕ Soma ao saldo', subtrai: '➖ Subtrai do saldo', neutro: '⬜ Não contabiliza' };
        container.innerHTML = customs.map(t => {
            const hex = this._getTypeColorHex(t.color);
            return `<div class="flex items-center gap-3 py-2.5 border-b border-gray-100 last:border-0">
                <span class="text-xl w-8 text-center">${t.emoji}</span>
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium text-gray-800">${t.name}</div>
                    <div class="text-xs" style="color:${hex}">${behaviorLabel[t.behavior] || t.behavior}</div>
                </div>
                <div class="flex items-center gap-1 flex-shrink-0">
                    <button class="type-edit-btn text-gray-400 hover:text-blue-500 px-2 text-lg" data-type-id="${t.id}">✏️</button>
                    <button class="type-del-btn text-gray-400 hover:text-red-500 px-1 text-lg"  data-type-id="${t.id}">🗑</button>
                </div>
            </div>`;
        }).join('');

        container.querySelectorAll('.type-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const t = Storage.getCustomTypes().find(x => x.id === btn.dataset.typeId);
                if (t) this.openTypeForm(t);
            });
        });
        container.querySelectorAll('.type-del-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Excluir este tipo de lançamento?')) return;
                try {
                    await Storage.deleteTransactionType(btn.dataset.typeId);
                    this.transactionTypes = await Storage.getTransactionTypes();
                    this.renderTypesList();
                    this.showToast('Tipo removido');
                } catch (e) { this.showToast('❌ Erro: ' + e.message, true); }
            });
        });
    },

    openTypeForm(type = null) {
        this.editingTypeId = type?.id || null;
        document.getElementById('type-form-title').textContent = type ? 'Editar Tipo' : 'Novo Tipo';
        const emoji = type?.emoji || '📋';
        document.getElementById('type-emoji-input').value     = emoji;
        document.getElementById('type-emoji-btn').textContent = emoji;
        document.getElementById('type-name-input').value      = type?.name || '';
        const behavior = type?.behavior || 'soma';
        document.getElementById('type-behavior-input').value  = behavior;
        document.querySelectorAll('[data-behavior]').forEach(btn => {
            const active = btn.dataset.behavior === behavior;
            btn.className = `behavior-btn py-2.5 px-1 rounded-xl text-xs font-semibold border-2 transition-all ${active ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600'}`;
        });
        const color = type?.color || 'purple';
        document.getElementById('type-color-input').value = color;
        document.querySelectorAll('.type-color-btn').forEach(btn => {
            const active = btn.dataset.color === color;
            btn.style.outline       = active ? '3px solid ' + btn.style.background : '';
            btn.style.outlineOffset = active ? '2px' : '';
        });
        document.getElementById('type-form-modal').classList.remove('hidden');
        setTimeout(() => document.getElementById('type-name-input').focus(), 100);
    },

    closeTypeForm() {
        document.getElementById('type-form-modal').classList.add('hidden');
        this.editingTypeId = null;
    },

    async saveTypeForm() {
        const name     = document.getElementById('type-name-input').value.trim();
        const emoji    = document.getElementById('type-emoji-input').value.trim() || '📋';
        const behavior = document.getElementById('type-behavior-input').value;
        const color    = document.getElementById('type-color-input').value;
        if (!name) { document.getElementById('type-name-input').focus(); return; }
        const btn = document.getElementById('type-form-save');
        btn.disabled = true; btn.textContent = 'Salvando...';
        try {
            if (this.editingTypeId) {
                await Storage.updateTransactionType(this.editingTypeId, { name, emoji, behavior, color });
            } else {
                await Storage.createTransactionType(name, behavior, emoji, color);
            }
            this.transactionTypes = await Storage.getTransactionTypes();
            this.closeTypeForm();
            this.renderTypesList();
            this.showToast(this.editingTypeId ? '✅ Tipo atualizado!' : '✅ Tipo criado!');
        } catch (e) {
            this.showToast('❌ Erro: ' + e.message, true);
        } finally {
            btn.disabled = false; btn.textContent = 'Salvar';
        }
    },

    // ─── Voice Input ──────────────────────────────────────────────────────────
    bindVoice() {
        const btn = document.getElementById('voice-btn');
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            btn.classList.add('opacity-40');
            btn.title = 'Voz não suportada neste navegador';
            return;
        }
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.recognition = new SR();
        this.recognition.lang           = 'pt-BR';
        this.recognition.continuous     = false;
        this.recognition.interimResults = false;
        this.recognition.onresult = e => {
            const transcript = e.results[0][0].transcript;
            document.getElementById('quick-input').value = transcript;
            this.stopListening();
            this.processQuickInput();
        };
        this.recognition.onerror = e => {
            this.stopListening();
            const msgs = {
                'network':        'Reconhecimento de voz requer conexão com a internet.',
                'not-allowed':    'Permissão de microfone negada. Clique no 🔒 da barra de endereço e permita o microfone.',
                'no-speech':      'Nenhuma fala detectada. Tente novamente.',
                'network':        'Erro de rede. A API de voz requer conexão com a internet.',
                'audio-capture':  'Microfone não encontrado ou ocupado por outro app.',
                'service-not-allowed': 'Serviço de voz bloqueado. Use HTTPS ou localhost.'
            };
            const msg = msgs[e.error] || `Erro de voz: ${e.error}`;
            this.showToast('🎤 ' + msg, true);
        };
        this.recognition.onend = () => this.stopListening();
        btn.addEventListener('click', () => {
            if (this.isListening) this.stopListening(); else this.startListening();
        });
    },

    startListening() {
        if (!navigator.onLine) {
            this.showToast('🎤 Reconhecimento de voz requer conexão com a internet.', true);
            return;
        }
        this.isListening = true;
        this.recognition.start();
        const btn = document.getElementById('voice-btn');
        btn.classList.add('listening');
        btn.innerHTML = '<span class="animate-pulse">🔴</span>';
        document.getElementById('quick-input').placeholder = 'Ouvindo...';
    },

    stopListening() {
        this.isListening = false;
        try { this.recognition.stop(); } catch (_) {}
        const btn = document.getElementById('voice-btn');
        btn.classList.remove('listening');
        btn.innerHTML = '🎤';
        document.getElementById('quick-input').placeholder = 'Ex: "Gastei 50 no mercado" ou "Recebi 200 de freela"';
    },

    // ─── OCR ──────────────────────────────────────────────────────────────────
    bindOCR() {
        const dropzone   = document.getElementById('ocr-dropzone');
        const fileInput  = document.getElementById('ocr-file');
        const pasteBtn   = document.getElementById('ocr-paste');
        const pasteArea  = document.getElementById('ocr-paste-area');
        const processPaste = document.getElementById('ocr-process-paste');

        dropzone.addEventListener('click', () => fileInput.click());
        dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('border-blue-400', 'bg-blue-50'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('border-blue-400', 'bg-blue-50'));
        dropzone.addEventListener('drop', e => {
            e.preventDefault();
            dropzone.classList.remove('border-blue-400', 'bg-blue-50');
            if (e.dataTransfer.files[0]) this.runOCR(e.dataTransfer.files[0]);
        });
        fileInput.addEventListener('change', e => { if (e.target.files[0]) this.runOCR(e.target.files[0]); });
        pasteBtn.addEventListener('click', () => pasteArea.classList.toggle('hidden'));
        processPaste.addEventListener('click', () => {
            const text = document.getElementById('ocr-text-input').value.trim();
            if (!text) return;
            this.showOCRResult(OCR.parseClipboardText(text));
        });
        document.addEventListener('paste', e => {
            if (this.currentTab !== 'receipt') return;
            for (const item of e.clipboardData.items) {
                if (item.type.startsWith('image/')) { this.runOCR(item.getAsFile()); return; }
            }
        });
    },

    async runOCR(file) {
        const preview     = document.getElementById('ocr-preview');
        const progress    = document.getElementById('ocr-progress');
        const progressBar = document.getElementById('ocr-progress-bar');
        const progressTxt = document.getElementById('ocr-progress-text');

        const isPDF = file.type === 'application/pdf' || file.name?.toLowerCase().endsWith('.pdf');

        if (isPDF) {
            // Mostra ícone de PDF em vez de preview de imagem
            preview.classList.add('hidden');
        } else {
            preview.src = URL.createObjectURL(file);
            preview.classList.remove('hidden');
        }

        progress.classList.remove('hidden');
        document.getElementById('ocr-result').classList.add('hidden');

        const onProgress = pct => {
            progressBar.style.width = `${pct}%`;
            progressTxt.textContent = `${pct}%`;
        };

        try {
            const result = isPDF
                ? await OCR.processPDF(file, onProgress)
                : await OCR.processImage(file, onProgress);
            progress.classList.add('hidden');
            this.showOCRResult(result);
        } catch (err) {
            progress.classList.add('hidden');
            this.showToast('❌ ' + err.message, true);
        }
    },

    showOCRResult(result) {
        const box = document.getElementById('ocr-result');
        box.classList.remove('hidden');
        document.getElementById('ocr-result-value').textContent = result.value ? this.formatCurrency(result.value) : '—';
        document.getElementById('ocr-result-date').textContent  = result.date ? this.formatDate(result.date) : '—';
        document.getElementById('ocr-result-type').textContent  = result.type === 'entrada' ? '💚 Entrada' : '🔴 Saída';
        document.getElementById('ocr-result-desc').textContent  = result.description || '—';
        document.getElementById('ocr-use-result').onclick = () => {
            this.openModal({
                value:       result.value,
                date:        result.date,
                type:        result.type,
                category:    result.category || 'PIX',
                description: result.description,
                rawText:     result.rawText
            });
            this.switchTab('home');
        };
    },

    // ─── PWA Share Target ─────────────────────────────────────────────────────
    async checkSharedContent() {
        if (!('caches' in window)) return;
        try {
            const cache   = await caches.open('share-target-v1');
            const metaRes = await cache.match('shared-meta');
            if (!metaRes) return;

            const meta = await metaRes.json();
            this.switchTab('receipt');

            if (meta.kind === 'text') {
                // Texto compartilhado → processa diretamente
                const result = OCR.parseClipboardText(meta.text);
                this.showOCRResult(result);
            } else if (meta.kind === 'file') {
                // Imagem compartilhada → roda OCR
                const fileRes = await cache.match('shared-file');
                if (fileRes) {
                    const blob = await fileRes.blob();
                    const file = new File([blob], meta.name || 'comprovante.jpg', { type: meta.mimeType });
                    await this.runOCR(file);
                }
            }

            // Limpa o cache após processar
            await cache.delete('shared-meta');
            await cache.delete('shared-file');
        } catch (err) {
            console.error('checkSharedContent error:', err);
            this.showToast('Erro ao processar comprovante compartilhado', true);
        }
    },

    // ─── Render Home ──────────────────────────────────────────────────────────
    async renderHome() {
        const [summary, list] = await Promise.all([
            Storage.getSummary(this.currentMonth),
            Storage.getTransactions({ month: this.currentMonth })
        ]);
        document.getElementById('balance').textContent       = this.formatCurrency(summary.balance);
        document.getElementById('total-income').textContent  = this.formatCurrency(summary.income);
        document.getElementById('total-expense').textContent = this.formatCurrency(summary.expense);
        document.getElementById('balance').className =
            `text-3xl font-bold ${summary.balance >= 0 ? 'text-green-400' : 'text-red-400'}`;
        this.renderTransactionList('home-transactions', list.slice(0, 30));
    },

    // ─── Render History ───────────────────────────────────────────────────────
    async renderHistory() {
        const search = document.getElementById('history-search')?.value?.toLowerCase() || '';
        let list = await Storage.getTransactions({ month: this.currentMonth });
        if (search) list = list.filter(t =>
            t.description.toLowerCase().includes(search) ||
            t.category.toLowerCase().includes(search)
        );
        this.renderTransactionList('history-transactions', list);
        const searchEl = document.getElementById('history-search');
        if (searchEl && !searchEl._bound) {
            searchEl._bound = true;
            searchEl.addEventListener('input', () => this.renderHistory());
        }
    },

    renderTransactionList(containerId, transactions) {
        const container = document.getElementById(containerId);
        if (!container) return;
        if (!transactions.length) {
            container.innerHTML = `<div class="text-center text-gray-400 py-10">
                <div class="text-4xl mb-2">📭</div>
                <p>Nenhum lançamento ainda</p>
                <p class="text-sm mt-1">Use o campo acima para adicionar</p>
            </div>`;
            return;
        }
        const grouped = {};
        for (const t of transactions) {
            const d = t.date || 'sem-data';
            if (!grouped[d]) grouped[d] = [];
            grouped[d].push(t);
        }
        let html = '';
        for (const [date, items] of Object.entries(grouped)) {
            html += `<div class="text-xs font-semibold text-gray-400 uppercase mt-4 mb-1 px-1">${this.formatDateGroup(date)}</div>`;
            for (const t of items) {
                const icon  = this.getCategoryIcon(t.category);
                const beh   = Storage.getBehavior(t.type);
                const color = beh === 'soma' ? 'text-green-600' : beh === 'subtrai' ? 'text-red-600' : 'text-gray-500';
                const sign  = beh === 'soma' ? '+' : beh === 'subtrai' ? '-' : '±';
                html += `
                <div class="flex items-center gap-3 bg-white rounded-xl p-3 mb-2 shadow-sm border border-gray-100 transaction-item cursor-pointer" data-id="${t.id}">
                    <div class="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center text-xl flex-shrink-0">${icon}</div>
                    <div class="flex-1 min-w-0">
                        <div class="font-medium text-gray-800 truncate">${t.category}</div>
                        <div class="text-xs text-gray-400 truncate">${t.description}</div>
                        ${this.getInserterBadge(t)}
                    </div>
                    <div class="flex flex-col items-end gap-1">
                        <div class="font-bold ${color}">${sign}${this.formatCurrency(t.value)}</div>
                        <button class="text-xs text-gray-300 hover:text-red-400 delete-btn" data-id="${t.id}">✕</button>
                    </div>
                </div>`;
            }
        }
        container.innerHTML = html;

        container.querySelectorAll('.transaction-item').forEach(el => {
            el.addEventListener('click', async e => {
                if (e.target.classList.contains('delete-btn')) return;
                const all = await Storage.getTransactions();
                const t   = all.find(x => x.id === el.dataset.id);
                if (t) this.openModal(t);
            });
        });

        container.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', async e => {
                e.stopPropagation();
                if (!confirm('Remover este lançamento?')) return;
                try {
                    await Storage.deleteTransaction(btn.dataset.id);
                    await this.renderCurrentTab();
                    if (this.currentTab !== 'home') await this.renderHome();
                } catch (err) { this.showToast('❌ Erro ao remover', true); }
            });
        });
    },

    // ─── Render Summary ───────────────────────────────────────────────────────
    getPrevMonth(ym) {
        const [y, m] = ym.split('-').map(Number);
        const d = new Date(y, m - 2, 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    },

    formatMonthShort(ym) {
        const [y, m] = ym.split('-');
        const names = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        return `${names[parseInt(m) - 1]}/${y.slice(2)}`;
    },

    async renderSummary() {
        const prevMonth = this.getPrevMonth(this.currentMonth);

        // Fetch current + previous month + 6-month trend in parallel
        const monthsForTrend = [];
        let ym = this.currentMonth;
        for (let i = 0; i < 6; i++) { monthsForTrend.unshift(ym); ym = this.getPrevMonth(ym); }

        const [summary, catTotals, prevSummary, txns, ...trendSummaries] = await Promise.all([
            Storage.getSummary(this.currentMonth),
            Storage.getCategoryTotals(this.currentMonth),
            Storage.getSummary(prevMonth),
            Storage.getTransactions({ month: this.currentMonth }),
            ...monthsForTrend.map(m => Storage.getSummary(m))
        ]);

        // ── Cards ──────────────────────────────────────────────────────────────
        document.getElementById('sum-income').textContent  = this.formatCurrency(summary.income);
        document.getElementById('sum-expense').textContent = this.formatCurrency(summary.expense);
        document.getElementById('sum-balance').textContent = this.formatCurrency(summary.balance);

        const cmpTag = (cur, prev, invertGood = false) => {
            if (!prev) return '';
            const diff = cur - prev;
            const pct  = ((diff / prev) * 100).toFixed(1);
            const up   = diff > 0;
            const good = invertGood ? !up : up;
            const color = good ? 'text-green-500' : 'text-red-500';
            const arrow = up ? '▲' : '▼';
            return `<span class="${color}">${arrow} ${Math.abs(pct)}%</span>`;
        };
        document.getElementById('sum-income-cmp').innerHTML  = cmpTag(summary.income,  prevSummary.income,  false);
        document.getElementById('sum-expense-cmp').innerHTML = cmpTag(summary.expense, prevSummary.expense, true);
        document.getElementById('sum-balance-cmp').innerHTML = cmpTag(summary.balance, prevSummary.balance, false);

        // ── Donut chart ────────────────────────────────────────────────────────
        const labels = [], data = [], colors = [];
        const palette = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#8b5cf6','#ec4899','#14b8a6'];
        let ci = 0;
        for (const [cat, totals] of Object.entries(catTotals)) {
            if (totals.expense > 0) { labels.push(cat); data.push(totals.expense); colors.push(palette[ci++ % palette.length]); }
        }

        if (this.chart) this.chart.destroy();
        const wrap = document.getElementById('expense-chart-wrap');
        if (data.length) {
            wrap.innerHTML = '<canvas id="expense-chart"></canvas>';
            this.chart = new Chart(document.getElementById('expense-chart'), {
                type: 'doughnut',
                data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
                options: {
                    responsive: true,
                    plugins: {
                        legend: { position: 'bottom', labels: { padding: 12, font: { size: 12 } } },
                        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${this.formatCurrency(ctx.parsed)}` } }
                    }
                }
            });
        } else {
            wrap.innerHTML = '<div class="text-center text-gray-400 py-8">Sem gastos neste mês</div>';
        }

        // ── Trend bar chart ────────────────────────────────────────────────────
        if (this.trendChart) this.trendChart.destroy();
        this.trendChart = new Chart(document.getElementById('trend-chart'), {
            type: 'bar',
            data: {
                labels: monthsForTrend.map(m => this.formatMonthShort(m)),
                datasets: [
                    { label: 'Entradas', data: trendSummaries.map(s => s.income),  backgroundColor: '#22c55e99', borderColor: '#22c55e', borderWidth: 1, borderRadius: 4 },
                    { label: 'Saídas',   data: trendSummaries.map(s => s.expense), backgroundColor: '#ef444499', borderColor: '#ef4444', borderWidth: 1, borderRadius: 4 }
                ]
            },
            options: {
                responsive: true,
                plugins: { legend: { position: 'top', labels: { font: { size: 11 }, padding: 10 } } },
                scales: {
                    y: { beginAtZero: true, ticks: { font: { size: 10 }, callback: v => v >= 1000 ? 'R$' + (v/1000).toFixed(0) + 'k' : 'R$' + v } },
                    x: { ticks: { font: { size: 10 } } }
                }
            }
        });

        // ── Custom types chart ─────────────────────────────────────────────────
        this.renderCustomTypesChart(txns);

        // ── Person breakdown ───────────────────────────────────────────────────
        this.renderPersonBreakdown(txns);

        // ── Category breakdown (accordion) ────────────────────────────────────
        const totalExp = Object.values(catTotals).reduce((s, t) => s + t.expense, 0);

        // Group txns by category for quick lookup
        const txnsByCat = {};
        for (const t of txns) {
            if (!txnsByCat[t.category]) txnsByCat[t.category] = [];
            txnsByCat[t.category].push(t);
        }

        // Sort categories by expense descending
        const sortedCats = Object.entries(catTotals).sort((a, b) => b[1].expense - a[1].expense);

        let html = '';
        for (const [cat, totals] of sortedCats) {
            const pct     = totalExp > 0 && totals.expense > 0 ? ((totals.expense / totalExp) * 100).toFixed(1) : null;
            const catTxns = (txnsByCat[cat] || []).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            const icon    = this.getCategoryIcon(cat);

            // Group by date for the panel
            const byDate = {};
            for (const t of catTxns) { const d = t.date || ''; if (!byDate[d]) byDate[d] = []; byDate[d].push(t); }

            let panelHtml = '';
            for (const [date, items] of Object.entries(byDate)) {
                panelHtml += `<div class="text-[10px] font-semibold text-blue-400 uppercase pt-2 pb-0.5 px-1">${this.formatDateGroup(date)}</div>`;
                for (const t of items) {
                    const isIncome = Storage.getBehavior(t.type) === 'soma';
                    const badge    = this.getInserterBadge(t);
                    panelHtml += `
                    <div class="flex items-center gap-2 bg-white rounded-lg px-2.5 py-1.5 mb-1 border border-blue-100">
                        <span class="text-base flex-shrink-0">${icon}</span>
                        <div class="flex-1 min-w-0">
                            <div class="text-xs font-medium text-gray-800 truncate">${t.description || cat}</div>
                            ${badge ? `<div class="mt-0.5">${badge}</div>` : ''}
                        </div>
                        <div class="text-xs font-bold flex-shrink-0 ${isIncome ? 'text-green-600' : 'text-red-600'}">
                            ${isIncome ? '+' : '-'}${this.formatCurrency(t.value)}
                        </div>
                    </div>`;
                }
            }
            if (!panelHtml) panelHtml = '<p class="text-xs text-gray-400 py-2 text-center">Sem lançamentos</p>';

            const barColor = totals.income > totals.expense ? 'bg-green-400' : 'bg-red-400';

            html += `
            <div class="border-b border-gray-100 last:border-0">
                <div class="flex justify-between items-center py-3 cursor-pointer select-none cat-breakdown-row" data-cat="${cat}">
                    <div class="flex items-center gap-2">
                        <div class="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center text-lg flex-shrink-0">${icon}</div>
                        <div>
                            <div class="text-sm font-semibold text-gray-800">${cat}</div>
                            <div class="text-xs text-gray-400">${catTxns.length} lançamento${catTxns.length !== 1 ? 's' : ''}${pct ? ` · ${pct}%` : ''}</div>
                        </div>
                    </div>
                    <div class="flex items-center gap-3">
                        <div class="text-right">
                            ${totals.expense > 0 ? `<div class="text-sm font-bold text-red-600">-${this.formatCurrency(totals.expense)}</div>` : ''}
                            ${totals.income  > 0 ? `<div class="text-sm font-bold text-green-600">+${this.formatCurrency(totals.income)}</div>`  : ''}
                        </div>
                        <div class="cat-chevron w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 text-xs transition-transform duration-200 flex-shrink-0">▼</div>
                    </div>
                </div>
                ${pct ? `<div class="w-full bg-gray-100 rounded-full h-1.5 -mt-1 mb-2"><div class="${barColor} h-1.5 rounded-full" style="width:${pct}%"></div></div>` : ''}
                <div class="cat-txn-panel hidden bg-blue-50 rounded-2xl px-3 pt-1 pb-3 mb-2">
                    ${panelHtml}
                </div>
            </div>`;
        }
        const bd = document.getElementById('category-breakdown');
        bd.innerHTML = html || '<div class="text-gray-400 text-center py-4">Sem dados</div>';
        bd.querySelectorAll('.cat-breakdown-row').forEach(el => {
            el.addEventListener('click', () => {
                const panel   = el.parentElement.querySelector('.cat-txn-panel');
                const chevron = el.querySelector('.cat-chevron');
                const open    = !panel.classList.contains('hidden');
                panel.classList.toggle('hidden', open);
                chevron.style.transform = open ? '' : 'rotate(180deg)';
            });
        });
    },

    // ─── Person Breakdown ─────────────────────────────────────────────────────
    renderPersonBreakdown(txns) {
        const wrap = document.getElementById('person-breakdown-wrap');
        const bd   = document.getElementById('person-breakdown');
        const myEmail = (Auth.user?.email || '').toLowerCase();

        // Group by email (fall back to current user for transactions with no inserter)
        const byPerson = {};
        for (const t of txns) {
            const email = (t.inserted_by_email || myEmail).toLowerCase();
            if (!byPerson[email]) byPerson[email] = { email, income: 0, expense: 0 };
            if (t.type === 'entrada') byPerson[email].income  += Number(t.value);
            else                      byPerson[email].expense += Number(t.value);
        }

        const people = Object.values(byPerson);

        // Only show section if there's more than one person OR explicit inserted_by data
        const hasMultiInserters = txns.some(t => t.inserted_by_email && t.inserted_by_email.toLowerCase() !== myEmail);
        if (people.length < 2 && !hasMultiInserters) { wrap.classList.add('hidden'); return; }
        wrap.classList.remove('hidden');

        // Sort by expense descending
        people.sort((a, b) => b.expense - a.expense);

        const totalExp = people.reduce((s, p) => s + p.expense, 0);

        const avatarPalettes = [
            ['bg-blue-500',   'text-white'],
            ['bg-purple-500', 'text-white'],
            ['bg-orange-500', 'text-white'],
            ['bg-teal-500',   'text-white'],
            ['bg-pink-500',   'text-white'],
            ['bg-indigo-500', 'text-white'],
        ];

        const rows = people.map((p, i) => {
            const isMe  = p.email === myEmail;
            const label = isMe ? 'Você' : (p.email.split('@')[0] || p.email);
            const pct   = totalExp > 0 ? ((p.expense / totalExp) * 100).toFixed(1) : 0;
            const seed  = p.email.charCodeAt(0) + (p.email.charCodeAt(1) || 0);
            const [bgCls, txtCls] = avatarPalettes[seed % avatarPalettes.length];
            const initials = label.slice(0, 2).toUpperCase();
            const barColor = isMe ? 'bg-blue-500' : ['bg-purple-400','bg-orange-400','bg-teal-400','bg-pink-400','bg-indigo-400'][seed % 5];

            return `
            <div class="flex items-center gap-3 py-2.5 border-b border-gray-100 last:border-0">
                <div class="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold ${bgCls} ${txtCls}">${initials}</div>
                <div class="flex-1 min-w-0">
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-sm font-medium text-gray-800 truncate">${label}${isMe ? ' <span class="text-xs text-blue-400 font-normal">(você)</span>' : ''}</span>
                        <div class="flex items-center gap-2 flex-shrink-0 ml-2">
                            ${p.income  > 0 ? `<span class="text-xs font-semibold text-green-600">+${this.formatCurrency(p.income)}</span>`  : ''}
                            ${p.expense > 0 ? `<span class="text-xs font-bold text-red-600">-${this.formatCurrency(p.expense)}</span>` : ''}
                            ${pct > 0 ? `<span class="text-xs text-gray-400">${pct}%</span>` : ''}
                        </div>
                    </div>
                    ${pct > 0 ? `<div class="w-full bg-gray-100 rounded-full h-1.5"><div class="${barColor} h-1.5 rounded-full transition-all" style="width:${pct}%"></div></div>` : ''}
                </div>
            </div>`;
        });

        bd.innerHTML = rows.join('');
    },

    // ─── Custom Types Chart ───────────────────────────────────────────────────
    renderCustomTypesChart(txns) {
        const wrap = document.getElementById('custom-types-chart-wrap');
        if (!wrap) return;

        const customs = Storage.getCustomTypes();
        if (!customs.length) { wrap.classList.add('hidden'); return; }

        // Agrupa total por tipo customizado
        const totals = {};
        for (const t of txns) {
            if (!customs.find(c => c.id === t.type)) continue;
            totals[t.type] = (totals[t.type] || 0) + Number(t.value);
        }

        if (!Object.keys(totals).length) { wrap.classList.add('hidden'); return; }
        wrap.classList.remove('hidden');

        // Cards resumo por tipo
        const cardsEl = document.getElementById('custom-types-cards');
        if (cardsEl) {
            cardsEl.innerHTML = customs
                .filter(ct => totals[ct.id])
                .map(ct => {
                    const hex = this._getTypeColorHex(ct.color);
                    const behaviorIcon = ct.behavior === 'soma' ? '➕' : ct.behavior === 'subtrai' ? '➖' : '⬜';
                    return `<div class="flex items-center gap-2 px-3 py-2 rounded-xl border-2 text-sm font-semibold"
                        style="border-color:${hex};color:${hex};background:${hex}18">
                        <span>${ct.emoji}</span>
                        <span>${ct.name}</span>
                        <span class="font-bold">${this.formatCurrency(totals[ct.id])}</span>
                        <span class="text-xs font-normal opacity-70">${behaviorIcon}</span>
                    </div>`;
                }).join('');
        }

        // Gráfico de barras horizontais
        const labels = [], data = [], colors = [];
        for (const ct of customs) {
            if (!totals[ct.id]) continue;
            labels.push(ct.emoji + ' ' + ct.name);
            data.push(totals[ct.id]);
            colors.push(this._getTypeColorHex(ct.color));
        }

        if (this.customTypesChart) this.customTypesChart.destroy();
        document.getElementById('custom-types-chart-inner').innerHTML = '<canvas id="custom-types-chart"></canvas>';
        this.customTypesChart = new Chart(document.getElementById('custom-types-chart'), {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    data,
                    backgroundColor: colors.map(c => c + '44'),
                    borderColor: colors,
                    borderWidth: 2,
                    borderRadius: 6
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: ctx => ' ' + this.formatCurrency(ctx.parsed.x) } }
                },
                scales: {
                    x: { beginAtZero: true, ticks: { font: { size: 10 }, callback: v => v >= 1000 ? 'R$' + (v / 1000).toFixed(0) + 'k' : 'R$' + v } },
                    y: { ticks: { font: { size: 12 } } }
                }
            }
        });
    },

    // ─── Category Detail ──────────────────────────────────────────────────────
    async openCategoryDetail(cat) {
        const modal = document.getElementById('cat-detail-modal');
        modal.classList.remove('hidden');

        const icon = this.getCategoryIcon(cat);
        document.getElementById('cat-detail-title').textContent  = `${icon} ${cat}`;
        document.getElementById('cat-detail-month').textContent  = this.formatMonth(this.currentMonth);
        document.getElementById('cat-detail-list').innerHTML     = '<div class="text-center text-gray-400 py-8 text-sm">Carregando...</div>';
        document.getElementById('cat-detail-totals').innerHTML   = '';

        const all = await Storage.getTransactions({ month: this.currentMonth });
        const txns = all.filter(t => t.category === cat).sort((a, b) => b.date.localeCompare(a.date));

        const income  = txns.filter(t => Storage.getBehavior(t.type) === 'soma').reduce((s, t) => s + Number(t.value), 0);
        const expense = txns.filter(t => Storage.getBehavior(t.type) === 'subtrai').reduce((s, t) => s + Number(t.value), 0);

        document.getElementById('cat-detail-totals').innerHTML = `
            ${expense > 0 ? `<span class="px-3 py-1 bg-red-50 text-red-600 rounded-full text-xs font-semibold">Saídas: ${this.formatCurrency(expense)}</span>` : ''}
            ${income  > 0 ? `<span class="px-3 py-1 bg-green-50 text-green-600 rounded-full text-xs font-semibold">Entradas: ${this.formatCurrency(income)}</span>` : ''}`;

        if (!txns.length) {
            document.getElementById('cat-detail-list').innerHTML = '<div class="text-center text-gray-400 py-8 text-sm">Nenhum lançamento</div>';
            return;
        }

        const listEl = document.getElementById('cat-detail-list');
        listEl.innerHTML = txns.map(t => {
            const beh   = Storage.getBehavior(t.type);
            const sign  = beh === 'soma' ? '+' : beh === 'subtrai' ? '-' : '±';
            const color = beh === 'soma' ? 'text-green-600' : beh === 'subtrai' ? 'text-red-600' : 'text-gray-500';
            const badge = this.getInserterBadge(t);
            return `
            <div class="flex items-center gap-3 py-2.5 border-b border-gray-50 last:border-0 cursor-pointer hover:bg-gray-50 rounded-xl px-1 -mx-1 cat-detail-item" data-id="${t.id}">
                <div class="text-center flex-shrink-0 w-10">
                    <div class="text-xs font-bold text-gray-600">${t.date.slice(8)}</div>
                    <div class="text-xs text-gray-400">${this._monthAbbr(t.date)}</div>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="text-sm text-gray-700 truncate">${t.description}</div>
                    ${badge ? `<div class="mt-0.5">${badge}</div>` : ''}
                </div>
                <div class="font-bold text-sm ${color} flex-shrink-0">${sign}${this.formatCurrency(t.value)}</div>
            </div>`;
        }).join('');

        listEl.querySelectorAll('.cat-detail-item').forEach(el => {
            el.addEventListener('click', () => {
                const t = txns.find(x => x.id === el.dataset.id);
                if (t) { this.closeCategoryDetail(); this.openModal(t); }
            });
        });
    },

    closeCategoryDetail() {
        document.getElementById('cat-detail-modal').classList.add('hidden');
    },

    _monthAbbr(dateStr) {
        const m = parseInt((dateStr || '').slice(5, 7)) - 1;
        return ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][m] || '';
    },

    // ─── Export ───────────────────────────────────────────────────────────────
    bindExportButtons() {
        document.getElementById('export-excel-btn')?.addEventListener('click', () => this.exportExcel());
        document.getElementById('export-pdf-btn')?.addEventListener('click',   () => this.exportPDF());
    },

    async exportExcel() {
        const btn = document.getElementById('export-excel-btn');
        btn.disabled = true; btn.textContent = 'Gerando...';
        try {
            const transactions = await Storage.getTransactions({ month: this.currentMonth });
            const summary      = await Storage.getSummary(this.currentMonth);

            // Sheet 1: transactions
            const rows = transactions.map(t => {
                const typeObj = this.transactionTypes.find(x => x.id === t.type);
                const typeName = typeObj ? typeObj.name : (t.type === 'entrada' ? 'Entrada' : 'Saída');
                const beh = Storage.getBehavior(t.type);
                return {
                    'Data':         t.date,
                    'Tipo':         typeName,
                    'Categoria':    t.category,
                    'Descrição':    t.description,
                    'Valor (R$)':   beh === 'soma' ? Number(t.value) : beh === 'subtrai' ? -Number(t.value) : Number(t.value),
                    'Inserido por': t.inserted_by_email || ''
                };
            });

            // Sheet 2: summary
            const sumRows = [
                { 'Resumo': 'Entradas', 'Valor (R$)': summary.income  },
                { 'Resumo': 'Saídas',   'Valor (R$)': summary.expense },
                { 'Resumo': 'Saldo',    'Valor (R$)': summary.balance }
            ];

            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows),    'Lançamentos');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sumRows), 'Resumo');
            XLSX.writeFile(wb, `financas-${this.currentMonth}.xlsx`);
            this.showToast('✅ Excel exportado!');
        } catch (e) {
            this.showToast('❌ Erro ao exportar: ' + e.message, true);
        } finally {
            btn.disabled = false; btn.textContent = '📊 Exportar Excel';
        }
    },

    async exportPDF() {
        const btn = document.getElementById('export-pdf-btn');
        btn.disabled = true; btn.textContent = 'Gerando...';
        try {
            const { jsPDF } = window.jspdf;
            const doc          = new jsPDF();
            const transactions = await Storage.getTransactions({ month: this.currentMonth });
            const summary      = await Storage.getSummary(this.currentMonth);
            const monthLabel   = this.formatMonth(this.currentMonth);

            // Header
            doc.setFillColor(37, 99, 235);
            doc.rect(0, 0, 210, 30, 'F');
            doc.setTextColor(255, 255, 255);
            doc.setFontSize(18); doc.setFont('helvetica', 'bold');
            doc.text('Relatório Financeiro', 14, 13);
            doc.setFontSize(11); doc.setFont('helvetica', 'normal');
            doc.text(monthLabel, 14, 22);

            // Summary cards
            doc.setTextColor(0, 0, 0);
            doc.setFontSize(10);
            const cardY = 38;
            const cardData = [
                { label: 'Entradas', value: this.formatCurrency(summary.income),  color: [22, 163, 74]  },
                { label: 'Saídas',   value: this.formatCurrency(summary.expense), color: [220, 38, 38]  },
                { label: 'Saldo',    value: this.formatCurrency(summary.balance), color: [37, 99, 235]  }
            ];
            cardData.forEach((c, i) => {
                const x = 14 + i * 62;
                doc.setFillColor(...c.color);
                doc.roundedRect(x, cardY, 58, 18, 3, 3, 'F');
                doc.setTextColor(255, 255, 255);
                doc.setFontSize(8); doc.text(c.label, x + 4, cardY + 6);
                doc.setFontSize(10); doc.setFont('helvetica', 'bold');
                doc.text(c.value, x + 4, cardY + 14);
                doc.setFont('helvetica', 'normal');
            });

            // Transactions table
            doc.setTextColor(0, 0, 0);
            doc.setFontSize(11); doc.setFont('helvetica', 'bold');
            doc.text('Lançamentos', 14, cardY + 28);
            doc.setFont('helvetica', 'normal');

            doc.autoTable({
                startY: cardY + 32,
                head: [['Data', 'Tipo', 'Categoria', 'Descrição', 'Valor', 'Inserido por']],
                body: transactions.map(t => {
                    const typeObj  = this.transactionTypes.find(x => x.id === t.type);
                    const typeName = typeObj ? typeObj.name : (t.type === 'entrada' ? 'Entrada' : 'Saída');
                    const beh      = Storage.getBehavior(t.type);
                    const sign     = beh === 'soma' ? '+' : beh === 'subtrai' ? '-' : '±';
                    return [t.date, typeName, t.category, t.description, sign + this.formatCurrency(Number(t.value)), t.inserted_by_email || ''];
                }),
                styles:      { fontSize: 7, cellPadding: 2 },
                headStyles:  { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
                columnStyles: { 4: { halign: 'right' }, 5: { textColor: [100, 100, 100] } },
                alternateRowStyles: { fillColor: [248, 250, 252] }
            });

            doc.save(`financas-${this.currentMonth}.pdf`);
            this.showToast('✅ PDF exportado!');
        } catch (e) {
            this.showToast('❌ Erro ao exportar: ' + e.message, true);
        } finally {
            btn.disabled = false; btn.textContent = '📄 Exportar PDF';
        }
    },

    // ─── Import Excel ─────────────────────────────────────────────────────────
    _importRawRows: [],
    _importColumns: [],

    bindImportUI() {
        document.getElementById('import-excel-btn')?.addEventListener('click', () => this.openImportModal());

        const modal = document.getElementById('import-modal');
        document.getElementById('import-modal-close')?.addEventListener('click', () => this.closeImportModal());
        modal?.addEventListener('click', e => { if (e.target === modal) this.closeImportModal(); });

        const dropzone = document.getElementById('import-dropzone');
        const fileInput = document.getElementById('import-file');
        dropzone?.addEventListener('click', () => fileInput.click());
        dropzone?.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('border-blue-400', 'bg-blue-50'); });
        dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('border-blue-400', 'bg-blue-50'));
        dropzone?.addEventListener('drop', e => {
            e.preventDefault();
            dropzone.classList.remove('border-blue-400', 'bg-blue-50');
            if (e.dataTransfer.files[0]) this.handleImportFile(e.dataTransfer.files[0]);
        });
        fileInput?.addEventListener('change', e => { if (e.target.files[0]) this.handleImportFile(e.target.files[0]); });

        document.getElementById('import-download-template')?.addEventListener('click', () => this.downloadImportTemplate());
        document.getElementById('import-back')?.addEventListener('click', () => this.importShowStep(1));
        document.getElementById('import-confirm')?.addEventListener('click', () => this.confirmImport());
    },

    openImportModal() {
        document.getElementById('import-modal').classList.remove('hidden');
        this.importShowStep(1);
    },

    closeImportModal() {
        document.getElementById('import-modal').classList.add('hidden');
        document.getElementById('import-file').value = '';
    },

    importShowStep(step) {
        document.getElementById('import-step-upload').classList.toggle('hidden',  step !== 1);
        document.getElementById('import-step-preview').classList.toggle('hidden', step !== 2);
        if (step === 2) this._renderImportFinancaBanner();
    },

    _renderImportFinancaBanner() {
        const f = this.activeFinanca;
        if (!f) return;
        const emojiEl = document.getElementById('import-financa-emoji');
        const nameEl  = document.getElementById('import-financa-name');
        const typeEl  = document.getElementById('import-financa-type');
        if (emojiEl) emojiEl.textContent = f.emoji || '💰';
        if (nameEl)  nameEl.textContent  = f.name  || 'Pessoal';
        if (typeEl)  typeEl.textContent  = f.type === 'compartilhada' ? '👥 Compartilhada' : '👤 Individual';
    },

    async handleImportFile(file) {
        try {
            const buf  = await file.arrayBuffer();
            const wb   = XLSX.read(buf, { type: 'array', cellDates: true });
            const ws   = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

            if (rows.length < 2) { this.showToast('❌ Planilha vazia ou sem dados', true); return; }

            const headers = rows[0].map(h => String(h).trim());
            this._importRawRows = rows.slice(1).filter(r => r.some(c => c !== ''));
            this._importColumns = headers;

            this.renderImportMapping(headers);
            this.importShowStep(2);
        } catch (e) {
            this.showToast('❌ Erro ao ler arquivo: ' + e.message, true);
        }
    },

    _importFieldLabels: { date: 'Data', type: 'Tipo', category: 'Categoria', description: 'Descrição', value: 'Valor', inserter: 'Inserido por' },
    _importAutoDetect: {
        date:        ['data','date','dt','competencia','vencimento','lancamento'],
        type:        ['tipo','type','natureza','operacao','operação','movimentação','movimentacao'],
        category:    ['categoria','category','grupo','classificacao','classificação'],
        description: ['descrição','descricao','description','historico','histórico','memo','referencia','referência','obs','observacao','observação'],
        value:       ['valor','value','quantia','montante','amount','vlr','total','r$'],
        inserter:    ['inserido por','inseridor','inserido','responsavel','responsável','usuario','usuário','user','email','por']
    },

    renderImportMapping(headers) {
        const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const optHtml = ['(ignorar)', ...headers].map(h => `<option value="${h}">${h}</option>`).join('');

        const mapEl = document.getElementById('import-column-map');
        mapEl.innerHTML = Object.entries(this._importFieldLabels).map(([field, label]) => {
            // Auto-detect best match
            const keywords = this._importAutoDetect[field];
            const match    = headers.find(h => keywords.some(k => norm(h).includes(k))) || '(ignorar)';
            return `
            <div class="flex items-center gap-2">
                <span class="text-xs text-gray-600 w-24 flex-shrink-0">${label}</span>
                <select id="import-map-${field}" class="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-blue-400">
                    ${optHtml}
                </select>
            </div>`;
        }).join('');

        // Set auto-detected values
        Object.keys(this._importFieldLabels).forEach(field => {
            const keywords = this._importAutoDetect[field];
            const match    = headers.find(h => keywords.some(k => norm(h).includes(k)));
            if (match) document.getElementById(`import-map-${field}`).value = match;
        });

        // Re-render preview when mapping changes
        Object.keys(this._importFieldLabels).forEach(field => {
            document.getElementById(`import-map-${field}`)?.addEventListener('change', () => this.renderImportPreview());
        });

        this.renderImportPreview();
    },

    _parseImportValue(raw) {
        if (typeof raw === 'number') return raw;
        if (!raw) return 0;
        let s = String(raw).replace(/[R$\s]/g, '').trim();
        if (s.includes(',') && s.includes('.')) {
            s = s.indexOf('.') < s.indexOf(',') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
        } else if (s.includes(',')) {
            s = s.replace(',', '.');
        }
        return parseFloat(s) || 0;
    },

    _parseImportDate(raw) {
        const today = new Date().toISOString().split('T')[0];
        const clamp = (y, m, d) => {
            const last = new Date(Number(y), Number(m), 0).getDate(); // último dia do mês
            const dd   = Math.min(Math.max(1, Number(d)), last);
            return `${y}-${String(m).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
        };
        if (!raw) return today;
        if (raw instanceof Date) {
            if (isNaN(raw)) return today;
            return clamp(raw.getFullYear(), raw.getMonth() + 1, raw.getDate());
        }
        // Excel serial number (SheetJS with cellDates:false fallback)
        if (typeof raw === 'number') {
            const d = new Date(Math.round((raw - 25569) * 86400000));
            if (!isNaN(d)) return clamp(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
            return today;
        }
        const s = String(raw).trim();
        // DD/MM/AAAA ou DD-MM-AAAA ou DD.MM.AAAA
        const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
        if (dmy) {
            const y = dmy[3].length === 2 ? '20' + dmy[3] : dmy[3];
            return clamp(y, dmy[2], dmy[1]);
        }
        // AAAA-MM-DD ou AAAA/MM/DD
        const ymd = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
        if (ymd) return clamp(ymd[1], ymd[2], ymd[3]);
        // Tenta Date nativo como último recurso
        const d = new Date(s);
        if (!isNaN(d)) return clamp(d.getFullYear(), d.getMonth() + 1, d.getDate());
        return today;
    },

    _parseImportType(raw, value) {
        if (raw) {
            const v = String(raw).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            if (['entrada','credito','credit','receita','income'].some(k => v.includes(k))) return 'entrada';
            if (['saida','debito','debit','despesa','expense','gasto'].some(k => v.includes(k))) return 'saida';
        }
        return value >= 0 ? 'entrada' : 'saida';
    },

    _getMapping() {
        const get = f => document.getElementById(`import-map-${f}`)?.value || '(ignorar)';
        return { date: get('date'), type: get('type'), category: get('category'), description: get('description'), value: get('value'), inserter: get('inserter') };
    },

    _rowToTransaction(row, map) {
        const col = name => name === '(ignorar)' ? '' : row[this._importColumns.indexOf(name)] ?? '';
        const rawVal  = this._parseImportValue(col(map.value));
        const absVal  = Math.abs(rawVal);
        const type    = this._parseImportType(col(map.type), rawVal);
        const inserter = String(col(map.inserter) || '').trim();
        return {
            date:        this._parseImportDate(col(map.date)),
            type,
            category:    String(col(map.category) || 'Outros').trim() || 'Outros',
            description: String(col(map.description) || '').trim() || 'Importado',
            value:       absVal || 0,
            ...(inserter ? { inserted_by_email: inserter } : {})
        };
    },

    renderImportPreview() {
        const map   = this._getMapping();
        const txns  = this._importRawRows.map(r => this._rowToTransaction(r, map)).filter(t => t.value > 0);
        const shown = txns.slice(0, 6);

        document.getElementById('import-count').textContent = `${txns.length} lançamento${txns.length !== 1 ? 's' : ''} encontrado${txns.length !== 1 ? 's' : ''}`;
        const email = Auth?.user?.email ?? 'usuário atual';
        document.getElementById('import-inserter-email').textContent = email;

        const tbody = document.getElementById('import-preview-body');
        const fallbackEmail = Auth?.user?.email || '';
        tbody.innerHTML = shown.map((t, i) => {
            const inserter = t.inserted_by_email || fallbackEmail;
            const inserterDisplay = inserter ? (inserter.split('@')[0] || inserter) : '—';
            return `<tr class="${i % 2 === 0 ? '' : 'bg-gray-50'}">
                <td class="px-2 py-1.5 text-gray-700">${t.date}</td>
                <td class="px-2 py-1.5 ${t.type === 'entrada' ? 'text-green-600' : 'text-red-600'}">${t.type === 'entrada' ? '↓' : '↑'} ${t.type === 'entrada' ? 'Entrada' : 'Saída'}</td>
                <td class="px-2 py-1.5 text-gray-700">${t.category}</td>
                <td class="px-2 py-1.5 text-gray-500 max-w-[80px] truncate">${t.description}</td>
                <td class="px-2 py-1.5 text-right font-medium ${t.type === 'entrada' ? 'text-green-600' : 'text-red-600'}">${this.formatCurrency(t.value)}</td>
                <td class="px-2 py-1.5 text-gray-400 text-xs truncate max-w-[80px]">${inserterDisplay}</td>
            </tr>`;
        }).join('');

        const more = txns.length - shown.length;
        document.getElementById('import-more').textContent = more > 0 ? `+ ${more} lançamento${more > 1 ? 's' : ''} não exibido${more > 1 ? 's' : ''}` : '';

        // Store for confirm
        this._importParsed = txns;

        // Aviso de emails novos (só em finanças compartilhadas)
        const newEmailsWrap = document.getElementById('import-new-emails');
        if (newEmailsWrap) {
            const isShared = this.activeFinanca?.type === 'compartilhada' && Storage.isCloud;
            const myEmail  = (Auth?.user?.email || '').toLowerCase();
            const uniqueEmails = [...new Set(txns.map(t => t.inserted_by_email).filter(Boolean))]
                .map(e => e.toLowerCase().trim())
                .filter(e => e && e !== myEmail);

            if (isShared && uniqueEmails.length) {
                newEmailsWrap.classList.remove('hidden');
                document.getElementById('import-new-emails-list').textContent = uniqueEmails.join(', ');
            } else {
                newEmailsWrap.classList.add('hidden');
            }
        }
    },

    async confirmImport() {
        const txns = this._importParsed;
        if (!txns?.length) { this.showToast('Nenhum lançamento válido encontrado', true); return; }

        const f    = this.activeFinanca;
        const nome = f ? `${f.emoji || '💰'} ${f.name}` : 'Pessoal';
        const tipo = f?.type === 'compartilhada' ? ' (Compartilhada)' : ' (Individual)';
        if (!confirm(`Confirmar importação?\n\n📥 ${txns.length} lançamento${txns.length !== 1 ? 's' : ''} serão adicionados em:\n${nome}${tipo}\n\nEssa ação não pode ser desfeita em massa.`)) return;

        const btn = document.getElementById('import-confirm');
        btn.disabled = true; btn.textContent = 'Preparando...';
        try {
            // Auto-criar categorias que não existem ainda
            const existingNames = new Set(this.categories.map(c => c.name.toLowerCase()));
            const newNames = [...new Set(txns.map(t => t.category))]
                .filter(name => name && name !== 'Outros' && !existingNames.has(name.toLowerCase()));

            if (newNames.length) {
                btn.textContent = `Criando ${newNames.length} categoria${newNames.length > 1 ? 's' : ''}...`;
                const emojis = ['🏷️','📌','💡','🔖','📎','🗂️','📁','🏦','💳','🛒'];
                for (let i = 0; i < newNames.length; i++) {
                    try {
                        const cat = await Storage.createCategory(newNames[i], emojis[i % emojis.length], [], 'both');
                        this.categories.push(cat);
                    } catch (_) { /* ignora se já existir por race condition */ }
                }
                NLP.setCategoryMap(this.categories);
                this.renderCategorySelect();
                this.renderQuickButtons();
            }

            // Auto-convidar emails não cadastrados (só em finanças compartilhadas)
            let inviteCount = 0;
            if (Storage.isCloud && this.activeFinanca?.type === 'compartilhada' && this.activeFinanca?.id) {
                const myEmail = (Auth?.user?.email || '').toLowerCase();
                const emailsInImport = [...new Set(txns.map(t => t.inserted_by_email).filter(Boolean))]
                    .map(e => e.toLowerCase().trim())
                    .filter(e => e && e !== myEmail);

                if (emailsInImport.length) {
                    btn.textContent = 'Verificando membros...';
                    let knownEmails = new Set([myEmail]);
                    try {
                        const [members, invites] = await Promise.all([
                            Storage.getMembers(this.activeFinanca.id),
                            Storage.getPendingInvites(this.activeFinanca.id)
                        ]);
                        members.forEach(m => m.email && knownEmails.add(m.email.toLowerCase()));
                        invites.forEach(i => i.email && knownEmails.add(i.email.toLowerCase()));
                    } catch (_) {}

                    const toInvite = emailsInImport.filter(e => !knownEmails.has(e));
                    if (toInvite.length) {
                        btn.textContent = `Convidando ${toInvite.length} usuário${toInvite.length > 1 ? 's' : ''}...`;
                        for (const email of toInvite) {
                            try {
                                await Storage.inviteMember(this.activeFinanca.id, email, 'membro');
                                inviteCount++;
                            } catch (_) {}
                        }
                    }
                }
            }

            btn.textContent = `Importando ${txns.length}...`;
            await Storage.bulkAddTransactions(txns);
            this.closeImportModal();
            await this.renderCurrentTab();
            const catMsg     = newNames.length  ? ` · ${newNames.length} categoria${newNames.length > 1 ? 's' : ''} criada${newNames.length > 1 ? 's' : ''}` : '';
            const inviteMsg  = inviteCount       ? ` · ${inviteCount} convite${inviteCount > 1 ? 's' : ''} enviado${inviteCount > 1 ? 's' : ''}` : '';
            this.showToast(`✅ ${txns.length} lançamento${txns.length > 1 ? 's' : ''} importado${txns.length > 1 ? 's' : ''}${catMsg}${inviteMsg}!`);
        } catch (e) {
            this.showToast('❌ Erro ao importar: ' + e.message, true);
        } finally {
            btn.disabled = false; btn.textContent = 'Importar';
        }
    },

    downloadImportTemplate() {
        const wb      = XLSX.utils.book_new();
        const customs = Storage.getCustomTypes();
        const tipoEx  = customs.length ? customs[0].name : 'Investimento';
        const ws = XLSX.utils.aoa_to_sheet([
            ['Data',       'Tipo',    'Categoria',   'Descrição',         'Valor',  'Inserido por'],
            ['23/04/2026', 'saída',   'Alimentação', 'Mercado da semana', 150.00,   ''],
            ['23/04/2026', 'entrada', 'Salário',     'Salário abril',     3000.00,  ''],
            ['22/04/2026', 'saída',   'Transporte',  'Uber',              25.50,    'amigo@email.com'],
            ['21/04/2026', 'saída',   'Moradia',     'Aluguel',           1200.00,  ''],
            ['20/04/2026', tipoEx,    'Outros',      'Exemplo tipo extra', 500.00,  ''],
        ]);
        ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 28 }, { wch: 12 }, { wch: 24 }];
        XLSX.utils.book_append_sheet(wb, ws, 'Modelo');
        XLSX.writeFile(wb, 'modelo-financas.xlsx');
        this.showToast('✅ Modelo baixado!');
    },

    // ─── Month navigation ─────────────────────────────────────────────────────
    bindMonthNav() {
        document.querySelectorAll('[data-month-prev]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const [y, m] = this.currentMonth.split('-').map(Number);
                const d = new Date(y, m - 2, 1);
                this.currentMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                this.refreshMonthDisplay();
                await this.renderCurrentTab();
            });
        });
        document.querySelectorAll('[data-month-next]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const [y, m] = this.currentMonth.split('-').map(Number);
                const d = new Date(y, m, 1);
                this.currentMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                this.refreshMonthDisplay();
                await this.renderCurrentTab();
            });
        });
    },

    refreshMonthDisplay() {
        document.querySelectorAll('.month-display').forEach(el => {
            el.textContent = this.formatMonth(this.currentMonth);
        });
    },

    // ─── Offline Cache Warm-up ────────────────────────────────────────────────
    async _warmOfflineCache() {
        if (!Storage.isCloud) return;
        try { await Storage.warmCache(); } catch (e) { console.warn('Cache warm-up failed:', e.message); }
    },

    // ─── Offline Sync ─────────────────────────────────────────────────────────
    bindOfflineSync() {
        window.addEventListener('online',  () => this.onReconnect());
        window.addEventListener('offline', () => this.onDisconnect());
        document.getElementById('offline-sync-btn')?.addEventListener('click', () => this.onReconnect());
        this.updateOfflineBar();
    },

    updateOfflineBar() {
        const bar     = document.getElementById('offline-bar');
        const textEl  = document.getElementById('offline-bar-text');
        const syncBtn = document.getElementById('offline-sync-btn');
        if (!bar) return;
        const pending = Storage.pendingCount();
        if (!navigator.onLine) {
            const label = pending > 0 ? `Offline — ${pending} lançamento${pending > 1 ? 's' : ''} pendente${pending > 1 ? 's' : ''}` : 'Sem conexão — modo offline';
            if (textEl) textEl.textContent = label;
            if (syncBtn) syncBtn.classList.add('hidden');
            bar.classList.remove('hidden');
        } else if (pending > 0) {
            if (textEl) textEl.textContent = `${pending} lançamento${pending > 1 ? 's' : ''} para sincronizar`;
            if (syncBtn) syncBtn.classList.remove('hidden');
            bar.classList.remove('hidden');
        } else {
            bar.classList.add('hidden');
        }
    },

    onDisconnect() {
        this.updateOfflineBar();
        this.showToast('📵 Sem conexão — modo offline ativo');
    },

    async onReconnect() {
        const pending = Storage.pendingCount();
        if (pending > 0) {
            this.updateOfflineBar();
            this.showToast(`🔄 Sincronizando ${pending} item${pending > 1 ? 'ns' : ''}...`);
            const result = await Storage.syncPendingOps();
            if (result.synced > 0) {
                this.showToast(`✅ ${result.synced} item${result.synced > 1 ? 'ns sincronizados' : ' sincronizado'}!`);
                await this.renderCurrentTab();
            }
            if (result.failed > 0) {
                this.showToast(`⚠️ ${result.failed} item${result.failed > 1 ? 'ns' : ''} não sincronizado${result.failed > 1 ? 's' : ''}`, true);
            }
        } else if (navigator.onLine) {
            this.showToast('✅ Conexão restaurada');
        }
        this.updateOfflineBar();
    },

    async renderCurrentTab() {
        if      (this.currentTab === 'home')    await this.renderHome();
        else if (this.currentTab === 'history') await this.renderHistory();
        else if (this.currentTab === 'summary') await this.renderSummary();
    },

    // ─── Helpers ──────────────────────────────────────────────────────────────
    formatCurrency(value) {
        return (value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    },

    formatDate(dateStr) {
        if (!dateStr) return '';
        const [y, m, d] = dateStr.split('-');
        return `${d}/${m}/${y}`;
    },

    formatDateGroup(dateStr) {
        if (!dateStr || dateStr === 'sem-data') return 'Sem data';
        const today     = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        if (dateStr === today)     return 'Hoje';
        if (dateStr === yesterday) return 'Ontem';
        const [y, m, d] = dateStr.split('-');
        return `${d}/${m}/${y}`;
    },

    formatMonth(ym) {
        const [y, m] = ym.split('-');
        const months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
        return `${months[parseInt(m) - 1]} ${y}`;
    },

    // ─── Categories ───────────────────────────────────────────────────────────
    async loadCategories() {
        try {
            this.categories = await Storage.getCategories();
        } catch (e) {
            console.warn('loadCategories:', e);
        }
        NLP.setCategoryMap(this.categories);
        this.renderCategorySelect();
        this.renderQuickButtons();
    },

    renderCategorySelect(selectedVal) {
        const sel = document.getElementById('modal-category');
        if (!sel) return;
        const current = selectedVal ?? sel.value ?? 'Outros';
        sel.innerHTML = this.categories.map(c =>
            `<option value="${c.name}">${c.emoji} ${c.name}</option>`
        ).join('');
        sel.value = current;
        if (!sel.value) sel.value = 'Outros';
    },

    renderQuickButtons() {
        const grid = document.getElementById('quick-cats-grid');
        if (!grid) return;
        const visible = this.categories.slice(0, 7);
        grid.innerHTML = visible.map(c => {
            const qtype = c.type === 'entrada' ? 'entrada' : 'saida';
            const isIncome = c.type === 'entrada';
            return `<button data-quick-cat="${c.name}" data-quick-type="${qtype}" data-quick-label="${c.name}"
                class="flex flex-col items-center gap-1 ${isIncome ? 'bg-green-50 border-green-100' : 'bg-white border-gray-100'} rounded-xl p-3 shadow-sm border hover:border-blue-300 hover:shadow-md transition-all">
                <span class="text-2xl">${c.emoji}</span>
                <span class="text-xs ${isIncome ? 'text-green-700' : 'text-gray-600'} truncate w-full text-center">${c.name.split(' ')[0]}</span>
            </button>`;
        }).join('') + `
        <button id="manage-cats-btn"
            class="flex flex-col items-center gap-1 bg-gray-50 rounded-xl p-3 shadow-sm border border-gray-200 hover:border-blue-300 hover:shadow-md transition-all">
            <span class="text-2xl">⚙️</span>
            <span class="text-xs text-gray-500">Editar</span>
        </button>`;
        grid.querySelectorAll('[data-quick-cat]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.openModal({ category: btn.dataset.quickCat, type: btn.dataset.quickType, focusValue: true });
            });
        });
        document.getElementById('manage-cats-btn')?.addEventListener('click', () => this.openCategoryModal());
    },

    // ── Emoji picker helpers ──────────────────────────────────────────────────
    _emojiPickerList: [
        '😀','😂','🥰','😎','🤩','🥳','🤔','😴',
        '🍔','🍕','🍣','🥩','🍺','☕','🍰','🛒',
        '🚗','🚌','✈️','🛵','⛽','🚲','🚢','🏍️',
        '💊','🏥','🦷','💉','🩺','🧬','👶','🧒',
        '🏠','🏢','🛋️','💡','💧','🔑','🏗️','🛏️',
        '📚','🎓','✏️','💻','📱','🖥️','⌨️','🖨️',
        '🎮','🎬','🎵','🎭','🎨','🏋️','⚽','🎸',
        '👕','👗','👟','👜','💍','🕶️','🎩','🧣',
        '💸','💰','💳','🏦','📈','💵','🪙','💎',
        '🎁','🛍️','🏷️','📦','🛠️','🧹','🌱','🐾',
        '📺','🎙️','📷','🔌','🔋','💡','📡','🎧',
        '✈️','🏖️','⛺','🗺️','🧳','🎿','🏕️','🌍',
    ],

    _emojiSuggestMap: [
        { words: ['alimenta','comida','mercado','supermercado','restaur','lanche','almoç','jant','café','padaria','pizza','hamburguer','sushi','feira','marmita'],  emoji: '🍔' },
        { words: ['transport','carro','uber','taxi','ônibus','onibus','metrô','metro','gasolina','combustível','combustivel','pedágio','pedagio','estacionamento'], emoji: '🚗' },
        { words: ['saúde','saude','farmácia','farmacia','remédio','remedio','médico','medico','hospital','dentista','consulta','exame','plano de saúde'],           emoji: '💊' },
        { words: ['moradia','aluguel','condomínio','condominio','água','agua','luz','energia','internet','gás','gas','financiamento','iptu','imóvel'],               emoji: '🏠' },
        { words: ['educaç','escola','faculdade','curso','livro','mensalidade','aula','universidade','inglês','ingles','treinamento'],                                emoji: '📚' },
        { words: ['lazer','cinema','show','spotify','jogo','game','balada','festa','entretenimento','diversão','diversao'],                                         emoji: '🎮' },
        { words: ['vestuário','vestuario','roupa','calçado','calcado','tênis','tenis','sapato','camisa','calça','calca','vestido','casaco','moda'],                  emoji: '👕' },
        { words: ['pix','transferência','transferencia','ted','doc','envio','remessa'],                                                                             emoji: '💸' },
        { words: ['salário','salario','holerite','freela','freelance','vencimento','renda','receita','pagamento recebido','pro-labore'],                             emoji: '💰' },
        { words: ['pet','cachorro','gato','animal','veterinário','veterinario','ração','racao','petshop'],                                                          emoji: '🐾' },
        { words: ['academia','ginástica','ginastica','esporte','treino','crossfit','natação','natacao','futebol','musculação'],                                      emoji: '🏋️' },
        { words: ['beleza','cabelo','cabeleireiro','barbearia','manicure','estética','estetica','salão','salao','unhas'],                                            emoji: '💇' },
        { words: ['tecnologia','tech','computador','celular','smartphone','tablet','eletrônico','eletronico','software','hardware'],                                emoji: '💻' },
        { words: ['viagem','passagem','avião','aviao','aeroporto','hospedagem','hotel','turismo','férias','ferias'],                                                emoji: '✈️' },
        { words: ['present','gift','aniversário','aniversario','natal','lembrança','lembranca'],                                                                    emoji: '🎁' },
        { words: ['investimento','poupança','poupanca','rendimento','dividendo','ação','acao','bolsa','fundo','tesouro'],                                            emoji: '📈' },
        { words: ['seguro','apólice','apolice','proteção','protecao'],                                                                                             emoji: '🛡️' },
        { words: ['streaming','netflix','amazon','disney','hbo','prime','assinatura','subscriç'],                                                                   emoji: '📺' },
        { words: ['música','musica','concerto','instrumento'],                                                                                                     emoji: '🎵' },
        { words: ['delivery','ifood','rappi'],                                                                                                                     emoji: '🛵' },
        { words: ['compra','shopping','loja','varejo','mercadoria'],                                                                                                emoji: '🛍️' },
        { words: ['crédito','credito','cartão','cartao','fatura','débito','debito'],                                                                                emoji: '💳' },
        { words: ['trabalho','escritório','escritorio','negócio','negocio','empresa','negócios','comercio'],                                                        emoji: '💼' },
        { words: ['decoração','decoracao','móvel','movel','mobília','mobilia','eletrodoméstico','eletrodomestico'],                                                  emoji: '🛋️' },
        { words: ['jardim','planta','flor','horta','paisagismo'],                                                                                                  emoji: '🌱' },
        { words: ['churrasco','carne','açougue','acougue','frigorífico'],                                                                                          emoji: '🥩' },
        { words: ['cerveja','bebida','bar','drink','bares','balada'],                                                                                              emoji: '🍺' },
        { words: ['criança','crianca','bebê','bebe','filho','brinquedo','creche','escola infantil'],                                                                emoji: '🧒' },
        { words: ['parcela','prestação','prestacao','empréstimo','emprestimo','dívida','divida'],                                                                   emoji: '📋' },
        { words: ['outros','outro','geral','misc','diverso'],                                                                                                      emoji: '📦' },
    ],

    _suggestEmoji(name) {
        const lower = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        for (const { words, emoji } of this._emojiSuggestMap) {
            if (words.some(w => lower.includes(w.normalize('NFD').replace(/[\u0300-\u036f]/g, '')))) return emoji;
        }
        return null;
    },

    _setEmojiValue(emoji) {
        document.getElementById('cat-emoji-input').value = emoji;
        document.getElementById('cat-emoji-btn').textContent = emoji;
        document.getElementById('cat-emoji-picker').classList.add('hidden');
    },

    _buildEmojiPicker() {
        const grid = document.getElementById('cat-emoji-grid');
        if (!grid || grid.dataset.built) return;
        grid.dataset.built = '1';
        grid.innerHTML = this._emojiPickerList.map(e =>
            `<button type="button" data-emoji="${e}"
                class="text-2xl p-1 rounded-lg hover:bg-blue-50 transition-colors leading-none">${e}</button>`
        ).join('');
        grid.addEventListener('click', e => {
            const btn = e.target.closest('[data-emoji]');
            if (btn) this._setEmojiValue(btn.dataset.emoji);
        });
    },

    bindCategoryUI() {
        const modal = document.getElementById('category-modal');
        document.getElementById('category-modal-close')?.addEventListener('click', () => this.closeCategoryModal());
        modal?.addEventListener('click', e => { if (e.target === modal) this.closeCategoryModal(); });
        document.getElementById('category-add-btn')?.addEventListener('click', () => this.openCategoryForm());

        const fModal = document.getElementById('category-form-modal');
        document.getElementById('category-form-close')?.addEventListener('click', () => this.closeCategoryForm());
        document.getElementById('cat-form-cancel')?.addEventListener('click', () => this.closeCategoryForm());
        fModal?.addEventListener('click', e => { if (e.target === fModal) this.closeCategoryForm(); });
        document.getElementById('cat-form-save')?.addEventListener('click', () => this.saveCategoryForm());

        // Auto-suggest emoji ao digitar o nome
        document.getElementById('cat-name-input')?.addEventListener('input', e => {
            const suggestion = this._suggestEmoji(e.target.value);
            if (suggestion) this._setEmojiValue(suggestion);
        });

        // Emoji picker toggle
        document.getElementById('cat-emoji-btn')?.addEventListener('click', e => {
            e.stopPropagation();
            this._buildEmojiPicker();
            document.getElementById('cat-emoji-picker').classList.toggle('hidden');
        });
        // Fecha picker ao clicar fora
        document.addEventListener('click', e => {
            if (!e.target.closest('#cat-emoji-btn') && !e.target.closest('#cat-emoji-picker')) {
                document.getElementById('cat-emoji-picker')?.classList.add('hidden');
            }
        });

        document.getElementById('cat-restore-defaults-btn')?.addEventListener('click', async () => {
            if (!confirm('Restaurar todas as categorias padrão?\nIsto desfaz edições e reexibe categorias ocultas.')) return;
            Storage.restoreDefaultCategories();
            this.categories = await Storage.getCategories();
            NLP.setCategoryMap(this.categories);
            this.renderCategoryList();
            this.renderCategorySelect();
            this.renderQuickButtons();
            this.showToast('✅ Categorias padrão restauradas!');
        });

        document.querySelectorAll('[data-ctype]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-ctype]').forEach(b => {
                    b.className = b.className
                        .replace(/border-\w+-400|bg-\w+-50|text-\w+-700/g, '')
                        .replace(/\s+/g, ' ').trim()
                        + ' border-gray-200 text-gray-600';
                });
                const type = btn.dataset.ctype;
                const colorMap = { saida: 'red', entrada: 'green', both: 'blue' };
                const c = colorMap[type];
                btn.className = btn.className
                    .replace('border-gray-200 text-gray-600', '')
                    .trim()
                    + ` border-${c}-400 bg-${c}-50 text-${c}-700`;
                document.getElementById('cat-type-input').value = type;
            });
        });
    },

    openCategoryModal() {
        document.getElementById('category-modal').classList.remove('hidden');
        this.renderCategoryList();
    },

    closeCategoryModal() {
        document.getElementById('category-modal').classList.add('hidden');
    },

    renderCategoryList() {
        const container = document.getElementById('category-list');
        if (!container) return;

        const typeBadge = {
            saida:   '<span class="text-xs px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">Saída</span>',
            entrada: '<span class="text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-600">Entrada</span>',
            both:    '<span class="text-xs px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">Ambos</span>'
        };

        container.innerHTML = this.categories.map(cat => {
            const isDefault  = Storage._isDefaultId(cat.id);
            const isModified = isDefault && Storage._getCatOverrides()[cat.id];
            const badge      = isDefault
                ? `<span class="text-xs px-1.5 py-0.5 rounded-full ${isModified ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-400'}">
                       ${isModified ? 'modificada' : 'padrão'}
                   </span>`
                : '';
            return `<div class="flex items-center gap-3 py-2.5 border-b border-gray-50 last:border-0">
                <span class="text-2xl w-8 text-center">${cat.emoji}</span>
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium text-gray-800">${cat.name}</div>
                    <div class="flex items-center gap-1 mt-0.5">
                        ${typeBadge[cat.type] || ''}${badge ? '&nbsp;' + badge : ''}
                    </div>
                </div>
                <div class="flex items-center gap-0 flex-shrink-0">
                    <button class="cat-edit-btn text-gray-400 hover:text-blue-500 px-2 text-lg" data-cat-id="${cat.id}" title="Editar">✏️</button>
                    <button class="cat-del-btn text-gray-400 hover:text-red-500 px-1 text-lg"  data-cat-id="${cat.id}" title="Excluir">🗑</button>
                </div>
            </div>`;
        }).join('');

        container.querySelectorAll('.cat-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const cat = this.categories.find(c => c.id === btn.dataset.catId);
                if (cat) this.openCategoryForm(cat);
            });
        });
        container.querySelectorAll('.cat-del-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const cat = this.categories.find(c => c.id === btn.dataset.catId);
                if (!cat) return;
                const msg = Storage._isDefaultId(cat.id)
                    ? `Ocultar a categoria padrão "${cat.name}"?\nVocê pode restaurá-la depois.`
                    : `Excluir categoria "${cat.name}"?`;
                if (!confirm(msg)) return;
                try {
                    await Storage.deleteCategory(cat.id);
                    this.categories = this.categories.filter(c => c.id !== cat.id);
                    NLP.setCategoryMap(this.categories);
                    this.renderCategoryList();
                    this.renderCategorySelect();
                    this.renderQuickButtons();
                    this.showToast('Categoria removida');
                } catch (e) { this.showToast('❌ Erro: ' + e.message, true); }
            });
        });
    },

    openCategoryForm(cat = null) {
        this.editingCatId = cat?.id || null;
        document.getElementById('cat-form-title').textContent = cat ? 'Editar Categoria' : 'Nova Categoria';
        const emoji = cat?.emoji || '📦';
        document.getElementById('cat-emoji-input').value = emoji;
        document.getElementById('cat-emoji-btn').textContent = emoji;
        document.getElementById('cat-name-input').value    = cat?.name    || '';
        document.getElementById('cat-keywords-input').value = (cat?.keywords || []).join(', ');
        document.getElementById('cat-type-input').value    = cat?.type    || 'saida';

        // Reset type buttons
        const colorMap = { saida: 'red', entrada: 'green', both: 'blue' };
        document.querySelectorAll('[data-ctype]').forEach(b => {
            const active = b.dataset.ctype === (cat?.type || 'saida');
            const c = colorMap[b.dataset.ctype];
            b.className = `ctype-btn flex-1 py-2 rounded-xl text-sm font-medium border-2 ${active ? `border-${c}-400 bg-${c}-50 text-${c}-700` : 'border-gray-200 text-gray-600'}`;
        });

        document.getElementById('category-form-modal').classList.remove('hidden');
        setTimeout(() => document.getElementById('cat-name-input').focus(), 100);
    },

    closeCategoryForm() {
        document.getElementById('category-form-modal').classList.add('hidden');
        this.editingCatId = null;
    },

    async saveCategoryForm() {
        const name     = document.getElementById('cat-name-input').value.trim();
        const emoji    = document.getElementById('cat-emoji-input').value.trim() || '📦';
        const type     = document.getElementById('cat-type-input').value;
        const keywords = document.getElementById('cat-keywords-input').value
            .split(',').map(k => k.trim().toLowerCase()).filter(Boolean);

        if (!name) { document.getElementById('cat-name-input').focus(); return; }

        const btn = document.getElementById('cat-form-save');
        btn.disabled = true; btn.textContent = 'Salvando...';
        try {
            if (this.editingCatId) {
                await Storage.updateCategory(this.editingCatId, { name, emoji, keywords, type });
                const idx = this.categories.findIndex(c => c.id === this.editingCatId);
                if (idx !== -1) this.categories[idx] = { ...this.categories[idx], name, emoji, keywords, type };
            } else {
                const cat = await Storage.createCategory(name, emoji, keywords, type);
                this.categories.push(cat);
            }
            NLP.setCategoryMap(this.categories);
            this.closeCategoryForm();
            this.renderCategoryList();
            this.renderCategorySelect();
            this.renderQuickButtons();
            this.showToast(this.editingCatId ? '✅ Categoria atualizada!' : '✅ Categoria criada!');
        } catch (e) {
            this.showToast('❌ Erro: ' + e.message, true);
        } finally {
            btn.disabled = false; btn.textContent = 'Salvar';
        }
    },

    getInserterBadge(t) {
        const isShared = this.activeFinanca?.type === 'compartilhada';
        const hasOtherEmail = t.inserted_by_email &&
            (t.inserted_by_email || '').toLowerCase() !== (Auth.user?.email || '').toLowerCase();
        if (!isShared && !hasOtherEmail) return '';
        if (!t.inserted_by_email) return '';
        const isMe  = (t.inserted_by_email || '').toLowerCase() === (Auth.user?.email || '').toLowerCase();
        const name  = isMe ? 'Você' : (t.inserted_by_email.split('@')[0] || t.inserted_by_email);
        const seed  = t.inserted_by_email.charCodeAt(0) + (t.inserted_by_email.charCodeAt(1) || 0);
        const palettes = [
            'bg-purple-100 text-purple-600',
            'bg-orange-100 text-orange-600',
            'bg-teal-100   text-teal-700',
            'bg-pink-100   text-pink-600',
            'bg-indigo-100 text-indigo-600',
        ];
        const cls = isMe ? 'bg-blue-100 text-blue-600' : palettes[seed % palettes.length];
        return `<span class="inline-block text-xs px-1.5 py-0.5 rounded-full ${cls} font-medium leading-tight">${name}</span>`;
    },

    getCategoryIcon(cat) {
        const found = this.categories.find(c => c.name === cat);
        if (found) return found.emoji;
        const icons = { 'Alimentação':'🍔','Transporte':'🚗','Saúde':'💊','Moradia':'🏠','Educação':'📚','Lazer':'🎮','Vestuário':'👕','PIX':'💸','Salário':'💰','Outros':'📦' };
        return icons[cat] || '📦';
    },

    shake(el) {
        el.classList.add('shake');
        el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
        el.focus();
    },

    showToast(msg, error = false) {
        const toast = document.getElementById('toast');
        toast.textContent = msg;
        toast.className = `fixed bottom-24 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full text-white text-sm font-medium shadow-lg z-50 transition-all ${error ? 'bg-red-500' : 'bg-green-500'}`;
        toast.classList.remove('hidden', 'opacity-0');
        setTimeout(() => { toast.classList.add('opacity-0'); setTimeout(() => toast.classList.add('hidden'), 300); }, 2500);
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());
