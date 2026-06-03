// ─── Versão ───────────────────────────────────────────────────────────────────
const APP_VERSION = '2026-05-22 10:00';

// Detecta mudança de versão e força reload (resolve cache antigo no iOS)
(function () {
    const STORED = 'app_version_cache';
    const prev = localStorage.getItem(STORED);
    if (prev && prev !== APP_VERSION) {
        // Nova versão detectada: limpa caches e recarrega uma vez
        localStorage.setItem(STORED, APP_VERSION);
        if ('caches' in window) {
            caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
                .then(() => window.location.reload());
        } else {
            window.location.reload();
        }
    } else {
        localStorage.setItem(STORED, APP_VERSION);
    }
})();

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
    reminders:          [],
    editingReminderId:  null,
    _reminderSourceId:       null,
    _reminderSuggestDismissed: false, // true quando o usuário dispensou a sugestão de vínculo
    _modalFinancaId:    null,   // finança escolhida para o lançamento atual (null = usa a ativa)
    _importFinancaId:   null,   // finança escolhida para o import atual
    _financaSelectCallback: null, // callback ao confirmar seleção
    _installmentQty:    1,      // número de parcelas (1 = à vista)
    _homeSearch:        '',     // texto da pesquisa na home
    _historyMonths:     1,      // período selecionado na aba histórico (1 | 2 | 3 | 6 | 12)
    _historyCategories: new Set(), // categorias selecionadas no filtro do histórico
    _monthTransactions: [],    // transações do mês atual (fonte de verdade para isReminderPaid)
    _modalCategories:   null,  // categorias do perfil escolhido no modal (null = usa o ativo)
    _modalReminders:    null,  // lembretes do perfil escolhido no modal (null = usa o ativo)
    _LEARN_KEY: 'financas_learned_cats',  // chave localStorage para aprendizado
    _catUserPicked:     false,  // true quando usuário escolheu categoria manualmente no modal

    // ─── Init ─────────────────────────────────────────────────────────────────
    async init() {
        await Auth.init();
        Auth.bindUI();
        this.bindNav();
        this.bindQuickInput();
        this.bindModal();
        this.bindOCR();
        this.bindVoice();
        this.bindVolumeShortcut();
        this.bindMonthNav();
        this.bindFinancaUI();
        this.bindCategoryUI();
        this.bindExportButtons();
        this.bindImportUI();
        this.bindOfflineSync();
        this.bindTypesUI();
        this.bindRemindersUI();
        this.bindHomeSearch();
        this.bindHistoryPills();
        this.bindHistoryCatFilter();
        this.bindReminderNewCat();
        this.bindInsightsHandlers();
        this._initLearnedMap();
        const verEl = document.getElementById('app-version-label');
        if (verEl) verEl.textContent = `v ${APP_VERSION}`;
        await this.loadFinancas();
        await Storage.syncCustomTypesFromCloud(); // sincroniza primeiro para ter os tipos no localStorage
        await this.loadTransactionTypes();         // depois carrega já com os tipos sincronizados
        await this.loadCategories();
        await this.loadReminders();
        await this.renderHome();
        this.refreshMonthDisplay();
        // Aquece o cache offline em segundo plano (não bloqueia a UI)
        if (navigator.onLine) {
            this._warmOfflineCache();
            // ⚡ Sync na inicialização: garante que ops pendentes (feitos offline
            //    antes de fechar o app) sejam enviados quando o app abre online
            if (Storage.pendingCount() > 0) {
                setTimeout(() => this.onReconnect(), 1500); // pequeno delay para Supabase conectar
            }
        }
        // Retry para iOS: rede pode não estar pronta quando o PWA abre
        // Se categorias carregaram como defaults (sem dados do Supabase), re-tenta após 3s
        if (navigator.onLine) {
            setTimeout(async () => {
                const onlyDefaults = this.categories.every(c => c.id && c.id.startsWith('d-'));
                if (onlyDefaults) {
                    await Storage.syncCustomTypesFromCloud();
                    await this.loadTransactionTypes();
                    await this.loadCategories();
                }
            }, 3000);
        }
        // Verifica se há comprovante compartilhado (PWA share target)
        if (window.__pendingShared) await this.checkSharedContent();
        // Notificações de lembretes vencendo hoje
        this.checkReminderNotifications();
        // Atalho de URL: ?action=new-transaction (shortcut do PWA)
        this._handleUrlAction();
        // Notificação persistente na barra + escuta mensagens do SW
        this._setupQuickAddNotification();
        this._bindSwMessages();
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
                        this.showToast(`✅ Você foi adicionado a ${accepted} carteira${accepted > 1 ? 's' : ''}!`);
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
        const f = this.activeFinanca;
        const nameEl  = document.getElementById('financa-switcher-name');
        const emojiEl = document.getElementById('financa-switcher-emoji');
        const typeEl  = document.getElementById('financa-switcher-type');
        const header  = document.getElementById('home-header');

        if (nameEl)  nameEl.textContent  = f?.name  || 'Carteiras';
        if (emojiEl) emojiEl.textContent = f?.emoji || '💰';

        // Label do tipo
        const typeLabels = {
            individual:    '👤 Individual',
            familiar:      '👨‍👩‍👧 Familiar',
            compartilhada: '🤝 Compartilhada',
        };
        if (typeEl) typeEl.textContent = typeLabels[f?.type] || '👤 Individual';

        // Cor do dot "● Carteira ativa" conforme tipo
        const activeDot = document.querySelector('#financa-switcher p:first-child');
        if (activeDot) {
            activeDot.className = 'text-[10px] font-bold uppercase tracking-widest leading-none mb-1 '
                + (f?.type === 'familiar'      ? 'text-purple-500'
                 : f?.type === 'compartilhada' ? 'text-teal-500'
                 :                               'text-emerald-500');
        }

        // Cor do header por tipo de perfil
        if (header) {
            const grad = f?.type === 'familiar'
                ? 'linear-gradient(160deg,#3b0764 0%,#1e0433 100%)'
                : f?.type === 'compartilhada'
                ? 'linear-gradient(160deg,#0e4d4a 0%,#052120 100%)'
                : 'linear-gradient(160deg,#0d3b2e 0%,#051f15 100%)';
            header.style.background = grad;
        }
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
                    b.classList.remove('border-emerald-500', 'bg-emerald-50');
                    b.classList.add('border-gray-200', 'bg-gray-50');
                });
                btn.classList.add('border-emerald-500', 'bg-emerald-50');
                btn.classList.remove('border-gray-200', 'bg-gray-50');
            });
        });

        // Type toggle
        document.querySelectorAll('[data-ftype]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-ftype]').forEach(b => {
                    b.classList.remove('border-emerald-500', 'bg-emerald-50', 'text-emerald-800');
                    b.classList.add('border-gray-200', 'text-gray-600');
                });
                btn.classList.add('border-emerald-500', 'bg-emerald-50', 'text-emerald-800');
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
            <div class="flex items-center gap-3 p-3 mb-2 rounded-xl border-2 cursor-pointer transition-all ${isActive ? 'border-emerald-500 bg-emerald-50' : 'border-gray-100 bg-white hover:border-gray-300'}" data-financa-select="${f.id}">
                <span class="text-2xl">${f.emoji || '💰'}</span>
                <div class="flex-1 min-w-0">
                    <div class="font-semibold text-gray-800 truncate">${f.name}</div>
                    <div class="text-xs text-gray-400">${f.type === 'compartilhada' ? '👥 Compartilhada' : '👤 Individual'}</div>
                </div>
                ${isActive ? '<span class="text-emerald-600 text-lg">✓</span>' : ''}
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
                await Storage.syncCustomTypesFromCloud();
                await Promise.all([this.loadCategories(), this.loadReminders(), this.loadTransactionTypes()]);
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
                        await Storage.syncCustomTypesFromCloud();
                await Promise.all([this.loadCategories(), this.loadReminders(), this.loadTransactionTypes()]);
                        await this.renderCurrentTab();
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
            b.classList.toggle('border-emerald-500', i === 0);
            b.classList.toggle('bg-emerald-50',      i === 0);
            b.classList.toggle('border-gray-200',  i !== 0);
            b.classList.toggle('bg-gray-50',       i !== 0);
        });
        // Reset type
        document.querySelectorAll('[data-ftype]').forEach(b => {
            const sel = b.dataset.ftype === 'individual';
            b.classList.toggle('border-emerald-500', sel);
            b.classList.toggle('bg-emerald-50',      sel);
            b.classList.toggle('text-emerald-800',   sel);
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
        const emoji = document.querySelector('.financa-emoji-btn.border-emerald-500')?.dataset.emoji || '💰';
        const btn   = document.getElementById('financa-create-save');
        btn.disabled = true; btn.textContent = 'Criando...';
        try {
            const f = await Storage.createFinanca(name, type, emoji);
            this.financas.push(f);
            this.activeFinanca = f;
            Storage.setActiveFinanca(f.id);
            this.closeCreateFinancaModal();
            this.renderFinancaSwitcher();
            await Promise.all([this.loadCategories(), this.loadReminders(), Storage.syncCustomTypesFromCloud()]);
            await this.renderCurrentTab();
            this.showToast('✅ Carteira criada!');
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
                <div class="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-sm font-bold text-emerald-700">
                    ${(m.email || 'U').charAt(0).toUpperCase()}
                </div>
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium text-gray-800 truncate">${m.email || 'Usuário'}</div>
                    <div class="text-xs text-gray-400">${m.role === 'admin' ? '⭐ Admin' : m.role === 'visualizador' ? '👁 Visualizador' : '👤 Membro'}</div>
                </div>
                ${m.user_id !== Auth.user?.id
                    ? `<button class="text-gray-300 hover:text-red-400 text-lg remove-member-btn" data-member-id="${m.id}">✕</button>`
                    : '<span class="text-xs text-emerald-600 font-medium">Você</span>'}
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
            btn.disabled = false; btn.textContent = '🔗 Vincular meus lançamentos a esta carteira';
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
        const names = invites.map(i => `${i.financa?.emoji || '💰'} ${i.financa?.name || 'Carteira'}`).join(', ');
        bannerTx.textContent = `Convite${invites.length > 1 ? 's' : ''}: ${names}`;
        banner.classList.remove('hidden');
        // Offset tab content so banner doesn't overlap
        document.getElementById('tab-home').style.paddingTop = '52px';
    },

    async showPendingInvitesModal(invites) {
        invites = invites || this._pendingInvites || [];
        for (const invite of invites) {
            const financa = invite.financa;
            const name = `${financa?.emoji || '💰'} ${financa?.name || 'uma carteira'}`;
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
        // "Categorias — Ver tudo"
        document.getElementById('open-categories-btn')?.addEventListener('click', () => this.openCategoryModal());
        // "Lembretes — Ver tudo"
        document.getElementById('reminders-manage-link')?.addEventListener('click', () => this.openRemindersModal());
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
        // Botão + abre o modal diretamente (sem campo de texto visível)
        btn.addEventListener('click', () => {
            const text = input.value.trim();
            if (text) this.processQuickInput();
            else this.openModal({ focusValue: true });
        });
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
        input.value  = '';
        // Comando composto? ("gasolina 200 e mercado 150")
        if (this.handleCompoundCommand(text)) return;
        const parsed = NLP.parse(text);
        this.openModal({ ...parsed, focusValue: !parsed.value });
    },

    // ─── Modal ────────────────────────────────────────────────────────────────
    bindModal() {
        document.getElementById('modal-close').addEventListener('click',  () => this.closeModal());
        document.getElementById('modal-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('modal-voice-btn')?.addEventListener('click', () => this._startModalVoice());
        document.getElementById('modal-save').addEventListener('click',   () => this.saveModal());
        document.getElementById('modal-overlay').addEventListener('click', e => {
            if (e.target === e.currentTarget) this.closeModal();
        });
        document.getElementById('modal-types-container').addEventListener('click', e => {
            const btn = e.target.closest('[data-type-btn]');
            if (btn) this.selectModalType(btn.dataset.typeBtn);
        });
        document.getElementById('manage-types-link')?.addEventListener('click', () => this.openTypesModal());

        // Picker de finança no modal
        document.getElementById('modal-financa-picker')?.addEventListener('click', () => {
            this.openFinancaSelectModal(selectedId => {
                const activeId = this.activeFinanca?.id || null;
                const isSame   = selectedId === activeId || (!selectedId && !activeId);
                if (isSame) {
                    // Mesmo perfil: sem confirmação, só atualiza display
                    this._modalFinancaId = null;
                    this._renderModalFinancaPicker();
                    return;
                }
                // Perfil diferente: pergunta se quer trocar
                this._showFinancaConfirm(
                    selectedId,
                    async () => {
                        // Sim: muda perfil ativo + lançamento vai para o novo perfil
                        const newF = selectedId
                            ? this.financas.find(x => x.id === selectedId)
                            : { id: null, name: 'Pessoal', emoji: '💰', type: 'individual' };
                        this.activeFinanca = newF;
                        Storage.setActiveFinanca(newF?.id || null);
                        this.renderFinancaSwitcher();
                        await Storage.syncCustomTypesFromCloud();
                await Promise.all([this.loadCategories(), this.loadReminders(), this.loadTransactionTypes()]);
                        this._modalFinancaId = null; // null = usa o perfil ativo (já trocado)
                        this._renderModalFinancaPicker();
                    },
                    () => {
                        // Não: mantém perfil atual, lançamento fica no perfil ativo
                        this._modalFinancaId = null;
                        this._renderModalFinancaPicker();
                    }
                );
            });
        });

        // Modal de seleção de finança
        document.getElementById('financa-select-close')?.addEventListener('click', () => this.closeFinancaSelectModal());
        document.getElementById('financa-select-modal')?.addEventListener('click', e => {
            if (e.target === e.currentTarget) this.closeFinancaSelectModal();
        });

        // Máscara de moeda no campo de valor
        document.getElementById('modal-value')?.addEventListener('input', e => {
            this._applyCurrencyMask(e.target);
        });

        // Picker de parcelas
        document.getElementById('modal-overlay')?.addEventListener('click', e => {
            const btn = e.target.closest('.installment-opt');
            if (!btn) return;
            this._installmentQty = parseInt(btn.dataset.qty) || 1;
            const customInput = document.getElementById('modal-installment-custom');
            if (customInput) customInput.value = '';
            this._renderInstallmentPicker();
        });
        document.getElementById('modal-installment-custom')?.addEventListener('input', e => {
            const v = parseInt(e.target.value);
            if (v >= 2 && v <= 48) {
                this._installmentQty = v;
                this._renderInstallmentPicker(true);
            }
        });
        // Atualiza preview quando a data muda
        document.getElementById('modal-date')?.addEventListener('change', () => {
            if ((this._installmentQty || 1) > 1) this._renderInstallmentPicker();
        });

        // ── Nova categoria inline no modal de lançamento ──────────────────────
        document.getElementById('modal-new-cat-btn')?.addEventListener('click', () => {
            const panel = document.getElementById('modal-new-cat-panel');
            if (!panel) return;
            panel.classList.toggle('hidden');
            if (!panel.classList.contains('hidden')) {
                document.getElementById('modal-cat-name-input')?.focus();
                this._buildModalCatEmojiPicker();
            }
        });
        document.getElementById('modal-cat-cancel-btn')?.addEventListener('click', () => {
            document.getElementById('modal-new-cat-panel')?.classList.add('hidden');
            document.getElementById('modal-cat-name-input').value = '';
            document.getElementById('modal-cat-emoji-input').value = '📦';
            document.getElementById('modal-cat-emoji-btn').textContent = '📦';
        });
        document.getElementById('modal-cat-emoji-btn')?.addEventListener('click', () => {
            document.getElementById('modal-cat-emoji-picker')?.classList.toggle('hidden');
        });
        document.addEventListener('click', e => {
            if (!e.target.closest('#modal-cat-emoji-btn') && !e.target.closest('#modal-cat-emoji-picker')) {
                document.getElementById('modal-cat-emoji-picker')?.classList.add('hidden');
            }
        });
        document.getElementById('modal-cat-save-btn')?.addEventListener('click', () => this._saveModalNewCategory());
        document.getElementById('modal-cat-name-input')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') this._saveModalNewCategory();
        });
        document.getElementById('modal-cat-name-input')?.addEventListener('input', e => {
            const sug = this._suggestEmoji(e.target.value);
            if (sug) {
                document.getElementById('modal-cat-emoji-input').value = sug;
                document.getElementById('modal-cat-emoji-btn').textContent = sug;
            }
        });

        // ── Sugestão de categoria por aprendizado ──────────────────────────────
        // Detecta quando o usuário escolhe a categoria manualmente
        document.getElementById('modal-category')?.addEventListener('change', () => {
            this._catUserPicked = true;
            const badge = document.getElementById('cat-learned-badge');
            if (badge) badge.classList.add('hidden'), badge.classList.remove('inline-flex');
            // Correção manual: aprende imediatamente com peso 2 (sobrepõe sugestão errada mais rápido)
            const desc = document.getElementById('modal-description')?.value?.trim();
            const cat  = document.getElementById('modal-category')?.value;
            if (desc && cat && cat !== 'Outros') this._learnCategory(desc, cat, 2);
            this._checkReminderSuggestByCategory();
        });

        // ── Botões de sugestão de vínculo com lembrete ─────────────────────────
        document.getElementById('modal-rs-yes')?.addEventListener('click', () => {
            const suggest = document.getElementById('modal-reminder-suggest');
            const rid = suggest?.dataset.reminderId;
            if (!rid) return;
            this._reminderSourceId = rid;
            const r = this.reminders.find(x => x.id === rid);
            // Atualiza o badge de lembrete vinculado
            const reminderBadgeEl = document.getElementById('modal-reminder-badge');
            if (reminderBadgeEl && r) {
                reminderBadgeEl.innerHTML = `<span class="inline-flex items-center gap-1.5 text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-xl px-3 py-1.5 font-medium">
                    ${r.emoji || '🔔'} Lembrete: <strong>${this._escHtml(r.name)}</strong> — todo dia ${r.day}
                </span>`;
                reminderBadgeEl.classList.remove('hidden');
            }
            suggest.style.display = 'none';
        });

        document.getElementById('modal-rs-no')?.addEventListener('click', () => {
            this._reminderSuggestDismissed = true;
            document.getElementById('modal-reminder-suggest').style.display = 'none';
        });

        let _learnDebounce = null;
        document.getElementById('modal-description')?.addEventListener('input', e => {
            clearTimeout(_learnDebounce);
            _learnDebounce = setTimeout(() => {
                // Não sobrescreve se o usuário já escolheu manualmente nesta sessão
                if (this._catUserPicked) return;

                const badge  = document.getElementById('cat-learned-badge');
                const catSel = document.getElementById('modal-category');
                const text   = e.target.value.trim();
                if (!text || !catSel) return;

                // 1) Keywords estáticos via NLP — prioridade máxima (curados, específicos)
                const nlpCat = NLP.extractCategoryStatic(text);
                // 2) Mapa aprendido — usado quando NLP não achou match direto
                const learnedResult = this._suggestLearnedCategory(text);

                // Regra: keyword estático vence mapa aprendido com qualquer confiança;
                // mapa aprendido só entra se não houver match estático.
                let suggested, isLearned, confidence;
                if (nlpCat && nlpCat !== 'Outros') {
                    suggested  = nlpCat;
                    isLearned  = false;
                    confidence = 0;
                } else if (learnedResult) {
                    suggested  = learnedResult.cat;
                    isLearned  = true;
                    confidence = learnedResult.confidence;
                } else {
                    suggested  = 'Outros';
                    isLearned  = false;
                    confidence = 0;
                }

                if (suggested && suggested !== 'Outros') {
                    catSel.value = suggested;
                    if (badge) {
                        if (isLearned) {
                            badge.classList.remove('hidden');
                            badge.classList.add('inline-flex');
                            // Mostra indicador de confiança: alto ≥70%, médio ≥40%, baixo <40%
                            const level = confidence >= 70 ? '🧠' : confidence >= 40 ? '💡' : '❓';
                            badge.textContent = `${level} Aprendido ${confidence}%`;
                        } else {
                            badge.classList.add('hidden');
                            badge.classList.remove('inline-flex');
                        }
                    }
                    this._checkReminderSuggestByCategory();
                } else {
                    if (badge) badge.classList.add('hidden'), badge.classList.remove('inline-flex');
                }
            }, 300);
        });
    },

    // ─── Finança Select Modal ─────────────────────────────────────────────────
    openFinancaSelectModal(callback) {
        this._financaSelectCallback = callback;
        const list = document.getElementById('financa-select-list');
        // this.financas já inclui o perfil Pessoal — não adicionar entrada duplicada
        const all  = this.financas.length ? this.financas : [{ id: null, name: 'Pessoal', emoji: '💰', type: 'individual' }];
        list.innerHTML = all.map(f => {
            const currentId = this._financaSelectCallback === callback
                ? (this._modalFinancaId ?? (this.activeFinanca?.id || null))
                : (this._importFinancaId ?? (this.activeFinanca?.id || null));
            const isActive = (f.id === currentId) || (!f.id && !currentId);
            return `<button class="financa-select-item w-full flex items-center gap-3 px-3 py-3 rounded-xl border-2 transition-all ${isActive ? 'border-emerald-500 bg-emerald-50' : 'border-gray-100 bg-gray-50 hover:border-emerald-200'}" data-fid="${f.id || ''}">
                <span class="text-2xl">${f.emoji || '💰'}</span>
                <div class="flex-1 text-left">
                    <p class="font-semibold text-gray-800 text-sm">${f.name}</p>
                    <p class="text-xs text-gray-400">${f.type === 'compartilhada' ? '👥 Compartilhada' : '👤 Individual'}</p>
                </div>
                ${isActive ? '<span class="text-emerald-600 text-lg">✓</span>' : ''}
            </button>`;
        }).join('');

        list.querySelectorAll('.financa-select-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const fid = btn.dataset.fid || null;
                const cb = this._financaSelectCallback;
                this.closeFinancaSelectModal();
                if (cb) cb(fid);
            });
        });

        document.getElementById('financa-select-modal').classList.remove('hidden');
    },

    closeFinancaSelectModal() {
        document.getElementById('financa-select-modal').classList.add('hidden');
        this._financaSelectCallback = null;
    },

    _renderModalFinancaPicker() {
        const fid  = this._modalFinancaId;
        const f    = fid ? this.financas.find(x => x.id === fid) : this.activeFinanca;
        const name  = f?.name  || 'Pessoal';
        const emoji = f?.emoji || '💰';
        const type  = f?.type  || 'individual';

        document.getElementById('modal-financa-emoji').textContent = emoji;
        document.getElementById('modal-financa-name').textContent  = name;

        const typeLabels = {
            individual:    '👤 Individual',
            familiar:      '👨‍👩‍👧 Familiar',
            compartilhada: '🤝 Compartilhada',
        };
        const typeEl = document.getElementById('modal-financa-type');
        if (typeEl) typeEl.textContent = typeLabels[type] || '👤 Individual';

        // Gradiente e cor do dot conforme tipo
        const btn = document.getElementById('modal-financa-picker');
        const dot = document.getElementById('modal-financa-active-label');
        if (btn) {
            const configs = {
                familiar:      { bg: 'linear-gradient(135deg,#9333ea,#6b21a8)', border: '#7c3aed', dot: 'text-purple-200' },
                compartilhada: { bg: 'linear-gradient(135deg,#0d9488,#0f766e)', border: '#0d9488', dot: 'text-teal-200'   },
                individual:    { bg: 'linear-gradient(135deg,#059669,#065f46)', border: '#059669', dot: 'text-emerald-200'   },
            };
            const cfg = configs[type] || configs.individual;
            btn.style.background   = cfg.bg;
            btn.style.borderColor  = cfg.border;
            if (dot) dot.className = `text-[10px] font-bold uppercase tracking-widest leading-none mb-1 ${cfg.dot}`;
        }
    },

    _showFinancaConfirm(newFid, onConfirm, onCancel) {
        const f     = newFid ? this.financas.find(x => x.id === newFid) : null;
        const name  = f?.name  || 'Pessoal';
        const emoji = f?.emoji || '💰';

        document.getElementById('financa-confirm-emoji').textContent = emoji;
        document.getElementById('financa-confirm-msg').textContent =
            `A carteira ativa e este lançamento serão movidos para "${name}". Deseja continuar?`;

        const modal = document.getElementById('financa-confirm-modal');
        modal.classList.remove('hidden');

        // Recria os botões para não acumular listeners de chamadas anteriores
        const oldYes = document.getElementById('financa-confirm-yes');
        const oldNo  = document.getElementById('financa-confirm-no');
        const yesBtn = oldYes.cloneNode(true);
        const noBtn  = oldNo.cloneNode(true);
        oldYes.replaceWith(yesBtn);
        oldNo.replaceWith(noBtn);

        const close = () => modal.classList.add('hidden');
        yesBtn.addEventListener('click', () => { close(); onConfirm(); });
        noBtn.addEventListener('click',  () => { close(); if (onCancel) onCancel(); });
    },

    // ─── Currency mask helpers ────────────────────────────────────────────────
    _applyCurrencyMask(input) {
        const raw = input.value.replace(/\D/g, '');
        if (!raw) { input.value = ''; return; }
        const num     = parseInt(raw, 10) || 0;
        const str     = String(num).padStart(3, '0');
        const decPart = str.slice(-2);
        const intPart = (str.slice(0, -2) || '0').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        input.value   = intPart + ',' + decPart;
    },

    _toMaskedCurrency(num) {
        if (!num && num !== 0) return '';
        const [intRaw, dec] = Number(num).toFixed(2).split('.');
        return intRaw.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + dec;
    },

    _parseMaskedCurrency(str) {
        if (!str) return 0;
        return parseFloat(str.replace(/\./g, '').replace(',', '.')) || 0;
    },

    // ─── Installment helpers ──────────────────────────────────────────────────
    _addMonths(dateStr, months) {
        if (!months) return dateStr;
        const [y, m, d] = dateStr.split('-').map(Number);
        const result = new Date(y, m - 1 + months, 1);
        const maxDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
        result.setDate(Math.min(d, maxDay));
        return result.toISOString().split('T')[0];
    },

    _renderInstallmentPicker(customActive = false) {
        const qty = this._installmentQty || 1;
        document.querySelectorAll('.installment-opt').forEach(btn => {
            const bQty   = parseInt(btn.dataset.qty);
            const active = !customActive && bQty === qty;
            btn.className = active
                ? 'installment-opt px-3 py-1.5 rounded-xl text-xs font-semibold border-2 border-emerald-500 bg-emerald-50 text-emerald-700 transition-all'
                : 'installment-opt px-3 py-1.5 rounded-xl text-xs font-semibold border-2 border-gray-200 text-gray-500 hover:border-emerald-300 transition-all';
        });
        const preview = document.getElementById('modal-installment-preview');
        if (!preview) return;
        if (qty > 1) {
            const date = document.getElementById('modal-date')?.value;
            if (date) {
                const lastDate = this._addMonths(date, qty - 1);
                const [ly, lm] = lastDate.split('-');
                const lastMonth = new Date(Number(ly), Number(lm) - 1, 1)
                    .toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
                preview.textContent = `${qty} parcelas — até ${lastMonth}`;
                preview.classList.remove('hidden');
            }
        } else {
            preview.classList.add('hidden');
        }
    },

    _showInstallmentEditDialog(t, futureCount, totalCount) {
        return new Promise(resolve => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/60 z-[90] flex items-center justify-center px-4';
            modal.innerHTML = `
                <div class="bg-white rounded-2xl w-full max-w-sm p-5 shadow-2xl">
                    <h3 class="font-bold text-gray-800 text-base mb-1">Alterar parcela?</h3>
                    <p class="text-sm text-gray-500 mb-4">Parcela ${t.installment_current} de ${t.installment_total}</p>
                    <div class="space-y-2">
                        <button id="_edit-single" class="w-full py-2.5 px-4 rounded-xl border-2 border-gray-200 text-gray-700 font-semibold text-sm text-left hover:bg-gray-50 transition-colors">
                            ✏️ Só esta parcela
                        </button>
                        ${futureCount > 1 ? `<button id="_edit-future" class="w-full py-2.5 px-4 rounded-xl border-2 border-emerald-200 text-emerald-700 font-semibold text-sm text-left hover:bg-emerald-50 transition-colors">
                            📅 Esta e as próximas (${futureCount})
                        </button>` : ''}
                        ${totalCount > 1 ? `<button id="_edit-all" class="w-full py-2.5 px-4 rounded-xl border-2 border-purple-200 text-purple-600 font-semibold text-sm text-left hover:bg-purple-50 transition-colors">
                            📦 Todas as parcelas (${totalCount})
                        </button>` : ''}
                        <button id="_edit-cancel" class="w-full py-2.5 rounded-xl border-2 border-gray-200 text-gray-400 text-sm hover:bg-gray-50 transition-colors">
                            Cancelar
                        </button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
            const close = val => { modal.remove(); resolve(val); };
            modal.querySelector('#_edit-single')?.addEventListener('click', () => close('single'));
            modal.querySelector('#_edit-future')?.addEventListener('click', () => close('future'));
            modal.querySelector('#_edit-all')?.addEventListener('click',    () => close('all'));
            modal.querySelector('#_edit-cancel')?.addEventListener('click', () => close(null));
            modal.addEventListener('click', e => { if (e.target === modal) close(null); });
        });
    },

    _showInstallmentDeleteDialog(t, futureCount, totalCount) {
        return new Promise(resolve => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/60 z-[90] flex items-center justify-center px-4';
            modal.innerHTML = `
                <div class="bg-white rounded-2xl w-full max-w-sm p-5 shadow-2xl">
                    <h3 class="font-bold text-gray-800 text-base mb-1">Excluir parcela?</h3>
                    <p class="text-sm text-gray-500 mb-4">Parcela ${t.installment_current} de ${t.installment_total}</p>
                    <div class="space-y-2">
                        <button id="_del-single" class="w-full py-2.5 px-4 rounded-xl border-2 border-gray-200 text-gray-700 font-semibold text-sm text-left hover:bg-gray-50 transition-colors">
                            🗑️ Só esta parcela
                        </button>
                        ${futureCount > 1 ? `<button id="_del-future" class="w-full py-2.5 px-4 rounded-xl border-2 border-orange-200 text-orange-600 font-semibold text-sm text-left hover:bg-orange-50 transition-colors">
                            📅 Esta e as próximas (${futureCount})
                        </button>` : ''}
                        ${totalCount > 1 ? `<button id="_del-all" class="w-full py-2.5 px-4 rounded-xl border-2 border-red-200 text-red-600 font-semibold text-sm text-left hover:bg-red-50 transition-colors">
                            ✕ Todas as parcelas (${totalCount})
                        </button>` : ''}
                        <button id="_del-cancel" class="w-full py-2.5 rounded-xl border-2 border-gray-200 text-gray-400 text-sm hover:bg-gray-50 transition-colors">
                            Cancelar
                        </button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
            const close = val => { modal.remove(); resolve(val); };
            modal.querySelector('#_del-single')?.addEventListener('click', () => close('single'));
            modal.querySelector('#_del-future')?.addEventListener('click', () => close('future'));
            modal.querySelector('#_del-all')?.addEventListener('click',    () => close('all'));
            modal.querySelector('#_del-cancel')?.addEventListener('click', () => close(null));
            modal.addEventListener('click', e => { if (e.target === modal) close(null); });
        });
    },

    async openModal(data = {}) {
        // ── Se novo lançamento e usuário tem >1 perfil, pergunta qual usar antes de abrir ──
        if (!data.id && !data._financaChosen && this.financas.length > 1) {
            // Salva o _reminderSourceId atual (pode estar setado por quickAddFromReminder)
            const savedReminderId = this._reminderSourceId;
            // Limpa temporariamente para não vazar caso o usuário cancele o picker
            this._reminderSourceId = null;
            this.openFinancaSelectModal(selectedId => {
                // Restaura o vínculo com o lembrete antes de abrir o modal de verdade
                this._reminderSourceId = savedReminderId;
                this.openModal({ ...data, _financaChosen: true, _financaId: selectedId });
            });
            return;
        }

        this.editingId = data.id || null;
        // Inicializa seletor de finança:
        // • ao editar: usa a finança da transação
        // • ao criar com seleção prévia (_financaId): usa a escolhida
        // • ao criar sem seleção: usa a ativa (null = ativa)
        if (data._financaId !== undefined) {
            const activeId = this.activeFinanca?.id || null;
            const sameAsActive = data._financaId === activeId || (!data._financaId && !activeId);
            this._modalFinancaId = sameAsActive ? null : data._financaId;
        } else {
            this._modalFinancaId = data.financa_id || null;
        }
        this._renderModalFinancaPicker();
        document.getElementById('modal-overlay').classList.remove('hidden');

        // ── Carrega categorias, lembretes e tipos do perfil escolhido (se diferente do ativo) ──
        if (this._modalFinancaId && this._modalFinancaId !== (this.activeFinanca?.id || null)) {
            try {
                const [rawCats, rawRem] = await Promise.all([
                    Storage.getCategoriesForFinanca(this._modalFinancaId),
                    Storage.getRemindersForFinanca(this._modalFinancaId),
                ]);
                const seen = new Set();
                const deduped = rawCats.filter(c => {
                    const k = (c.name || '').trim().toLowerCase();
                    return seen.has(k) ? false : (seen.add(k), true);
                });
                // null = usa this.categories como fallback (renderCategorySelect trata)
                this._modalCategories = deduped.length ? this._sortCategories(deduped) : null;
                this._modalReminders = rawRem;
                // Tipos do perfil escolhido
                const prevFid = Storage.activeFinancaId;
                Storage.activeFinancaId = this._modalFinancaId;
                this.transactionTypes = await Storage.getTransactionTypes();
                Storage.activeFinancaId = prevFid;
            } catch (e) {
                console.warn('openModal: load for finança', e);
                this._modalCategories = null;
                this._modalReminders  = null;
            }
        } else {
            this._modalCategories = null; // usa this.categories (perfil ativo)
            this._modalReminders  = null; // usa this.reminders (perfil ativo)
            // Garante tipos do perfil ativo atualizados
            this.transactionTypes = await Storage.getTransactionTypes();
        }

        this._catUserPicked = false;            // reset: usuário ainda não escolheu categoria neste modal
        this._reminderSuggestDismissed = false; // reset: permite nova sugestão ao abrir modal
        // Preserva _reminderSourceId se já definido antes (ex.: quickAddFromReminder)
        // Caso contrário carrega o reminder_id da transação sendo editada (ou null para novo)
        if (!this._reminderSourceId) {
            this._reminderSourceId = data.reminder_id || null;
        }
        // Esconde banner de sugestão de lembrete
        const rSuggest = document.getElementById('modal-reminder-suggest');
        if (rSuggest) rSuggest.style.display = 'none';
        // Esconde badge de aprendizado ao abrir modal (evita vazamento)
        const _lb = document.getElementById('cat-learned-badge');
        if (_lb) _lb.classList.add('hidden'), _lb.classList.remove('inline-flex');
        document.getElementById('modal-title').textContent = this.editingId ? 'Editar Lançamento' : 'Novo Lançamento';
        document.getElementById('modal-value').value       = data.value ? this._toMaskedCurrency(data.value) : '';
        // Remove sufixo "(X/N)" ao editar parcela para o campo ficar limpo
        const cleanDesc = (data.description || '').replace(/\s*\(\d+\/\d+\)\s*$/, '');
        document.getElementById('modal-description').value = cleanDesc;
        document.getElementById('modal-date').value        = data.date || new Date().toISOString().split('T')[0];
        document.getElementById('modal-notes').value       = data.rawText ? '📎 Processado via OCR' : (data.notes || '');
        this.renderModalTypeBtns();
        this.selectModalType(data.type || 'saida');
        this.renderCategorySelect(data.category || 'Outros');
        // Seção de parcelas
        this._installmentQty = 1;
        const installWrap    = document.getElementById('modal-installment-wrap');
        const pickerSection  = document.getElementById('modal-installment-picker-section');
        const infoSection    = document.getElementById('modal-installment-info');
        const customInput    = document.getElementById('modal-installment-custom');
        if (customInput) customInput.value = '';
        if (installWrap && pickerSection && infoSection) {
            if (this.editingId && data.installment_group_id) {
                // Editando uma parcela existente: mostra info, esconde picker
                installWrap.classList.remove('hidden');
                pickerSection.classList.add('hidden');
                infoSection.classList.remove('hidden');
                const infoText = document.getElementById('modal-installment-info-text');
                if (infoText) infoText.textContent = `${data.installment_current}/${data.installment_total}`;
            } else if (this.editingId) {
                // Editando lançamento simples: esconde seção
                installWrap.classList.add('hidden');
            } else {
                // Novo lançamento: mostra picker
                installWrap.classList.remove('hidden');
                pickerSection.classList.remove('hidden');
                infoSection.classList.add('hidden');
                this._renderInstallmentPicker();
            }
        }
        // Exibe vínculo com lembrete (se existir)
        const reminderBadgeEl = document.getElementById('modal-reminder-badge');
        if (reminderBadgeEl) {
            const linked = data.reminder_id ? this.reminders.find(r => r.id === data.reminder_id) : null;
            if (linked) {
                reminderBadgeEl.innerHTML = `<span class="inline-flex items-center gap-1.5 text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-xl px-3 py-1.5 font-medium">
                    ${linked.emoji || '🔔'} Lembrete: <strong>${linked.name}</strong> — todo dia ${linked.day}
                </span>`;
                reminderBadgeEl.classList.remove('hidden');
            } else {
                reminderBadgeEl.classList.add('hidden');
            }
        }
        if (data.focusValue) setTimeout(() => document.getElementById('modal-value').focus(), 100);
        // Verifica sugestão de lembrete para a categoria já preenchida ao abrir
        setTimeout(() => this._checkReminderSuggestByCategory(), 50);
    },

    closeModal() {
        document.getElementById('modal-overlay').classList.add('hidden');
        this.editingId         = null;
        this._reminderSourceId = null;
        this._modalFinancaId   = null;
        this._modalCategories  = null; // limpa categorias temporárias do perfil escolhido
        this._modalReminders   = null; // limpa lembretes temporários do perfil escolhido
    },

    // Verifica se há lembrete com a categoria selecionada e exibe sugestão de vínculo
    _checkReminderSuggestByCategory() {
        const suggest = document.getElementById('modal-reminder-suggest');
        if (!suggest) return;

        // Não sugere se: já há lembrete vinculado ou usuário dispensou
        if (this._reminderSourceId || this._reminderSuggestDismissed) {
            suggest.style.display = 'none';
            return;
        }

        const selectedCat = document.getElementById('modal-category')?.value;
        if (!selectedCat || selectedCat === 'Outros' || !selectedCat.trim()) {
            suggest.style.display = 'none';
            return;
        }

        // Usa lembretes do perfil escolhido no modal (ou do perfil ativo)
        const reminders = this._modalReminders ?? this.reminders;
        const match = reminders.find(r =>
            r.category && r.category === selectedCat && !this.isReminderPaid(r.id)
        );

        if (!match) {
            suggest.style.display = 'none';
            return;
        }

        // Exibe sugestão
        const nameEl  = document.getElementById('modal-rs-name');
        const emojiEl = document.getElementById('modal-rs-emoji');
        if (nameEl)  nameEl.textContent  = match.name;
        if (emojiEl) emojiEl.textContent = match.emoji || '🔔';
        suggest.dataset.reminderId = match.id;
        suggest.style.display = 'flex';
    },

    async saveModal() {
        const value = this._parseMaskedCurrency(document.getElementById('modal-value').value);
        if (!value || value <= 0) { this.shake(document.getElementById('modal-value')); return; }

        const installQty = !this.editingId ? (this._installmentQty || 1) : 1;
        const baseDesc   = document.getElementById('modal-description').value || 'Sem descrição';

        const base = {
            value,
            type:        document.getElementById('modal-type').value,
            category:    document.getElementById('modal-category').value || 'Outros',
            description: baseDesc,
            date:        document.getElementById('modal-date').value,
            notes:       document.getElementById('modal-notes').value,
            ...(this._reminderSourceId ? { reminder_id: this._reminderSourceId } : {}),
            ...(!this.editingId && this._modalFinancaId ? { _targetFinancaId: this._modalFinancaId } : {})
        };

        const btn = document.getElementById('modal-save');
        btn.disabled = true;
        btn.textContent = installQty > 1 ? `Criando ${installQty} parcelas...` : 'Salvando...';

        try {
            let result;
            const wasEditing = !!this.editingId;
            if (this.editingId) {
                // Verifica se é parcela para perguntar escopo da edição
                const allTxns    = await Storage.getTransactions();
                const original   = allTxns.find(x => x.id === this.editingId);

                if (original?.installment_group_id) {
                    const groupTxns  = allTxns
                        .filter(x => x.installment_group_id === original.installment_group_id)
                        .sort((a, b) => a.installment_current - b.installment_current);
                    const futureTxns = groupTxns.filter(x => x.installment_current >= original.installment_current);

                    const choice = await this._showInstallmentEditDialog(original, futureTxns.length, groupTxns.length);
                    if (!choice) {
                        btn.disabled = false; btn.textContent = 'Salvar';
                        return;
                    }
                    const toUpdate = choice === 'all' ? groupTxns : choice === 'future' ? futureTxns : [original];
                    for (const tx of toUpdate) {
                        await Storage.updateTransaction(tx.id, {
                            ...base,
                            date:        tx.date,  // mantém a data de cada parcela
                            description: `${baseDesc} (${tx.installment_current}/${tx.installment_total})`,
                        });
                    }
                } else {
                    await Storage.updateTransaction(this.editingId, base);
                }
            } else if (installQty > 1) {
                // Cria N transações, uma por mês
                const groupId = 'inst_' + Date.now().toString(36);
                const txns = Array.from({ length: installQty }, (_, i) => ({
                    ...base,
                    date:                 this._addMonths(base.date, i),
                    description:          `${baseDesc} (${i + 1}/${installQty})`,
                    installment_group_id: groupId,
                    installment_current:  i + 1,
                    installment_total:    installQty,
                }));
                await Storage.bulkAddTransactions(txns);
            } else {
                result = await Storage.addTransaction(base);
            }

            // Aprende associação descrição → categoria para sugestões futuras
            this._learnCategory(baseDesc, base.category);

            // Marca lembrete como pago se o modal foi aberto via "Registrar"
            const paidReminderId   = this._reminderSourceId;
            // Captura carteira-alvo ANTES de closeModal() limpá-la
            const savedToFinancaId = !this.editingId ? this._modalFinancaId : null;

            this.closeModal();

            // ── Troca carteira ativa se o lançamento foi para outra ──────────────
            const activeId = this.activeFinanca?.id || null;
            if (savedToFinancaId && savedToFinancaId !== activeId) {
                const newF = this.financas.find(f => f.id === savedToFinancaId);
                if (newF) {
                    this.activeFinanca = newF;
                    Storage.setActiveFinanca(newF.id);
                    this.renderFinancaSwitcher();
                    await Storage.syncCustomTypesFromCloud();
                    await Promise.all([
                        this.loadCategories(),
                        this.loadReminders(),
                        this.loadTransactionTypes()
                    ]);
                }
            }

            await this.renderCurrentTab();

            if (paidReminderId) {
                const rem = this.reminders.find(r => r.id === paidReminderId);
                const paidMonth = this._markReminderPaid(paidReminderId);
                this.renderRemindersHome();
                const [py, pm] = paidMonth.split('-');
                const monthLabel = new Date(Number(py), Number(pm) - 1, 1)
                    .toLocaleDateString('pt-BR', { month: 'long' });
                this.showToast(`✅ ${rem?.name || 'Lembrete'} pago — ${monthLabel}`);
            } else if (installQty > 1) {
                this.showToast(`✅ ${installQty} parcelas criadas!`);
            } else if (result?._constraintFallback) {
                this.showToast('⚠️ Salvo localmente. Para sincronizar, remova a restrição no Supabase (SQL: ALTER TABLE transactions DROP CONSTRAINT transactions_type_check)', true);
            } else {
                this.showToast(wasEditing ? '✅ Lançamento atualizado!' : '✅ Lançamento salvo!');
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
        // Se online mas sem tipos customizados no cache, tenta sincronizar do Supabase
        // (cobre caso de iPhone que nunca sincronizou ou teve cache limpo)
        if (navigator.onLine && !Storage.getCustomTypes().length) {
            try { await Storage.syncCustomTypesFromCloud(); } catch (_) {}
        }
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
                btn.className = 'behavior-btn py-2.5 px-1 rounded-xl text-xs font-semibold border-2 border-emerald-500 bg-emerald-50 text-emerald-800 transition-all';
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
        grid.innerHTML = this._emojiPickerGroups.map(g =>
            `<div class="col-span-8 text-xs font-semibold text-gray-400 mt-2 mb-0.5 px-0.5">${g.label}</div>` +
            g.emojis.map(e =>
                `<button type="button" data-emoji="${e}" class="text-2xl p-1 rounded-lg hover:bg-emerald-50 transition-colors leading-none">${e}</button>`
            ).join('')
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
                    <button class="type-edit-btn text-gray-400 hover:text-emerald-600 px-2 text-lg" data-type-id="${t.id}">✏️</button>
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
            btn.className = `behavior-btn py-2.5 px-1 rounded-xl text-xs font-semibold border-2 transition-all ${active ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-gray-200 text-gray-600'}`;
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
            this.renderModalTypeBtns(); // atualiza botões no modal de lançamento
            this.showToast(this.editingTypeId ? '✅ Tipo atualizado!' : '✅ Tipo criado!');
        } catch (e) {
            this.showToast('❌ Erro: ' + e.message, true);
        } finally {
            btn.disabled = false; btn.textContent = 'Salvar';
        }
    },

    // ─── Reminders ───────────────────────────────────────────────────────────
    async loadReminders() {
        try { this.reminders = await Storage.getReminders(); } catch { this.reminders = []; }
    },

    // ─── Notificações de lembretes ────────────────────────────────────────────

    // Retorna quantos dias faltam para o próximo vencimento do lembrete (0 = hoje)
    _daysUntilDue(day) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Tenta no mês atual
        const candidate = new Date(today.getFullYear(), today.getMonth(), day);
        candidate.setHours(0, 0, 0, 0);

        let diff = Math.round((candidate - today) / 86_400_000);

        // Se já passou neste mês, tenta no próximo
        if (diff < 0) {
            const next = new Date(today.getFullYear(), today.getMonth() + 1, day);
            next.setHours(0, 0, 0, 0);
            diff = Math.round((next - today) / 86_400_000);
        }

        return diff;
    },

    async checkReminderNotifications() {
        if (!('Notification' in window)) return;  // navegador não suporta

        const todayKey = new Date().toISOString().slice(0, 10); // "2026-04-30"

        // Configuração dos 3 alertas: chave de deduplicação, dias antes, textos
        const THRESHOLDS = [
            { offset: 0, storKey: `notified_rem_d0_${todayKey}`, label: 'Vence hoje!',      badge: '🔴', urgency: true  },
            { offset: 1, storKey: `notified_rem_d1_${todayKey}`, label: 'Vence amanhã',     badge: '🟠', urgency: false },
            { offset: 2, storKey: `notified_rem_d2_${todayKey}`, label: 'Vence em 2 dias',  badge: '🟡', urgency: false },
        ];

        // Monta lista de lembretes ativos e não pagos por threshold
        const groups = THRESHOLDS.map(t => ({
            ...t,
            reminders: this.reminders.filter(r =>
                r.active !== false &&
                !this.isReminderPaid(r.id) &&
                this._daysUntilDue(r.day) === t.offset
            ),
        })).filter(g => g.reminders.length > 0);

        if (!groups.length) return;

        // Pede permissão se ainda não concedida
        let permission = Notification.permission;
        if (permission === 'default') {
            permission = await Notification.requestPermission();
        }

        // Sem permissão: banner in-app apenas para os que vencem hoje
        if (permission !== 'granted') {
            const dueToday = groups.find(g => g.offset === 0);
            if (dueToday) this._showReminderBanner(dueToday.reminders);
            return;
        }

        // Tenta obter SW registration para showNotification (iOS / background)
        let swReg = null;
        try {
            if ('serviceWorker' in navigator) swReg = await navigator.serviceWorker.ready;
        } catch (_) {}

        const _notify = (title, opts) => {
            try {
                if (swReg?.showNotification) return swReg.showNotification(title, opts);
                return Promise.resolve(new Notification(title, opts));
            } catch (_) { return Promise.resolve(); }
        };

        for (const group of groups) {
            // Carrega IDs já notificados para este threshold hoje
            let notified = [];
            try { notified = JSON.parse(localStorage.getItem(group.storKey) || '[]'); } catch {}

            const toNotify = group.reminders.filter(r => !notified.includes(r.id));
            if (!toNotify.length) continue;

            for (const r of toNotify) {
                const valor = r.amount > 0 ? ` — ${this.formatCurrency(r.amount)}` : '';
                const body  = `${r.emoji || '🔔'} ${group.label} (dia ${r.day})${valor}`;
                const title = `${group.badge} ${r.name}`;

                await _notify(title, {
                    body,
                    icon:               'icon.svg',
                    badge:              'icon.svg',
                    tag:                `reminder_${r.id}_d${group.offset}`,
                    requireInteraction: group.offset === 0,  // persiste só no vencimento
                    vibrate:            group.offset === 0 ? [200, 100, 200] : [100],
                    data:               { action: 'open-reminders' },
                });

                notified.push(r.id);
            }

            // Persiste para não repetir hoje
            try { localStorage.setItem(group.storKey, JSON.stringify(notified)); } catch {}
        }
    },

    // Banner in-app quando Notifications não está disponível/negado
    // offset: 0 = hoje, 1 = amanhã, 2 = em 2 dias
    _showReminderBanner(reminders, offset = 0) {
        const existing = document.getElementById('reminder-banner');
        if (existing) existing.remove();

        const LABEL = ['vencem hoje!', 'vencem amanhã', 'vencem em 2 dias'];
        const COLOR = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500'];
        const ICON  = ['🔴', '🟠', '🟡'];

        const banner = document.createElement('div');
        banner.id = 'reminder-banner';
        banner.className = 'fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-md z-[200] px-3 pt-2';

        const list = reminders.map(r => {
            const val  = r.amount > 0 ? ` — ${this.formatCurrency(r.amount)}` : '';
            const tag  = ['text-red-200', 'text-orange-200', 'text-yellow-200'][offset] || 'text-white/70';
            const lbl  = ['Vence hoje', 'Vence amanhã', 'Vence em 2 dias'][offset] || 'Vence';
            return `<div class="flex items-center gap-2">
                <span>${r.emoji || '🔔'}</span>
                <span class="font-semibold">${r.name}</span>
                <span class="${tag} text-xs">${lbl}${val}</span>
            </div>`;
        }).join('');

        const colorCls = COLOR[offset] || 'bg-orange-500';
        const icon     = ICON[offset]  || '📅';
        const heading  = `Pagamentos ${LABEL[offset] || 'vencem em breve'}`;

        banner.innerHTML = `
        <div class="${colorCls} text-white rounded-2xl shadow-xl px-4 py-3 flex items-start gap-3">
            <span class="text-2xl flex-shrink-0">${icon}</span>
            <div class="flex-1 min-w-0 space-y-0.5">
                <p class="text-sm font-bold mb-1">${heading}</p>
                ${list}
            </div>
            <button id="reminder-banner-close" class="text-white/70 hover:text-white text-xl leading-none flex-shrink-0 mt-0.5">✕</button>
        </div>`;

        document.body.appendChild(banner);

        document.getElementById('reminder-banner-close')?.addEventListener('click', () => banner.remove());
        banner.addEventListener('click', e => {
            if (!e.target.closest('#reminder-banner-close')) {
                this.openRemindersModal();
                banner.remove();
            }
        });

        // Remove automaticamente: 10 s para hoje, 6 s para antecipados
        setTimeout(() => banner?.remove(), offset === 0 ? 10_000 : 6_000);
    },

    renderRemindersHome() {
        const wrap = document.getElementById('reminders-home-section');
        if (!wrap) return;

        // Bind do botão vazio (só uma vez)
        const emptyBtn = document.getElementById('reminders-empty-btn');
        if (emptyBtn && !emptyBtn._bound) {
            emptyBtn._bound = true;
            emptyBtn.addEventListener('click', () => this.openRemindersModal());
        }

        const active = this.reminders.filter(r => r.active !== false);
        if (!active.length) {
            // Mostra só o botão de acesso vazio
            if (emptyBtn) emptyBtn.classList.remove('hidden');
            // Remove cards anteriores se existirem
            wrap.querySelectorAll('.reminder-cards-wrap').forEach(el => el.remove());
            return;
        }

        // Esconde o botão vazio e renderiza os cards
        if (emptyBtn) emptyBtn.classList.add('hidden');

        // Usa o mês visualizado para comparação de datas
        const today        = new Date();
        const realToday    = today.toISOString().slice(0, 7);
        const viewMonth    = this.currentMonth || realToday;
        const isCurrentMonth = viewMonth === realToday;
        const isFutureMonth  = viewMonth > realToday;
        const isPastMonth    = viewMonth < realToday;

        // Meses anteriores: não exibe lembretes
        if (isPastMonth) {
            wrap.querySelectorAll('.reminder-cards-wrap').forEach(el => el.remove());
            if (emptyBtn) emptyBtn.classList.remove('hidden');
            return;
        }

        const refDay = isCurrentMonth ? today.getDate() : 0;
        const in7 = refDay + 7;

        // ── Separa pagos / não pagos e ordena por dia ──────────────────────────
        const unpaid = active.filter(r => !this.isReminderPaid(r.id)).sort((a, b) => a.day - b.day);
        const paid   = active.filter(r =>  this.isReminderPaid(r.id)).sort((a, b) => a.day - b.day);

        // ── Accent por urgência (só aplica a não pagos) ────────────────────────
        const accentFor = r => {
            if (r.day < refDay)           return { iconBg:'#fff1f2', label:'#ef4444', badge:'⚠️ Vencido',        amtColor:'#ef4444', fill:'background:linear-gradient(90deg,#f87171,#ef4444)', btn:'#ef4444' };
            if (r.day === refDay)         return { iconBg:'#fff7ed', label:'#f97316', badge:'📅 Vence hoje',      amtColor:'#f97316', fill:'background:linear-gradient(90deg,#fb923c,#f97316)', btn:'#f97316' };
            if (r.day <= in7)             return { iconBg:'#f0fdf4', label:'#059669', badge:'📆 Próximos 7 dias', amtColor:'#059669', fill:'background:linear-gradient(90deg,#a3e635,#4ade80)', btn:'#059669' };
            /* later */                   return { iconBg:'#f8fafc', label:'#64748b', badge:'🗓️ Este mês',        amtColor:'#374151', fill:'background:linear-gradient(90deg,#94a3b8,#64748b)', btn:'#64748b' };
        };

        // ── Deal-card builder (reference design style) ──────────────────────────
        const daysInMonth = new Date(
            Number(viewMonth.slice(0,4)),
            Number(viewMonth.slice(5,7)),
            0
        ).getDate();

        const card = (r, accent) => {
            const isPaid = this.isReminderPaid(r.id);

            // Progress: % do mês já decorrido até o dia do lembrete
            const pct = Math.min(100, Math.round((r.day / daysInMonth) * 100));
            const progFill = isPaid
                ? 'background:linear-gradient(90deg,#4ade80,#22c55e)'
                : accent.fill;

            const amtTxt = r.amount > 0 ? this.formatCurrency(r.amount) : '—';
            const dayTxt = `Dia ${r.day}${r.category ? ' · ' + r.category : ''}`;

            if (isPaid) {
                const refMonth = this._reminderPaidMonth(r.id);
                const [ry, rm] = refMonth.split('-');
                const monthName = new Date(Number(ry), Number(rm)-1, 1)
                    .toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' });
                return `
                <div class="deal-card reminder-paid-card cursor-pointer hover:shadow-md transition-shadow opacity-70" style="padding:10px 12px" data-reminder-id="${r.id}">
                    <div class="flex items-center gap-2 mb-1.5">
                        <div class="w-7 h-7 rounded-lg flex items-center justify-center text-base flex-shrink-0" style="background:#f0fdf4">${r.emoji || '🔔'}</div>
                        <div class="flex-1 min-w-0">
                            <div class="text-xs font-semibold text-gray-400 truncate line-through">${r.name}</div>
                            <div class="text-[10px] text-green-500 font-medium">✅ Pago · ${monthName} · <span class="underline">ver lançamento</span></div>
                        </div>
                        <button class="reminder-unpay-btn text-[10px] text-gray-300 hover:text-red-400 px-1 flex-shrink-0" data-reminder-id="${r.id}" title="Desfazer">↩</button>
                    </div>
                    <div class="prog-bar" style="height:4px"><div class="prog-fill" style="width:100%;${progFill}"></div></div>
                    <div class="flex justify-between mt-1 text-[10px] text-gray-400">
                        <span>${dayTxt}</span>
                        <span class="font-semibold text-green-500">${amtTxt}</span>
                    </div>
                </div>`;
            }

            return `
            <div class="deal-card reminder-unpaid-card cursor-pointer hover:shadow-md transition-shadow" style="padding:10px 12px" data-reminder-id="${r.id}">
                <div class="flex items-center gap-2 mb-1.5">
                    <div class="w-7 h-7 rounded-lg flex items-center justify-center text-base flex-shrink-0" style="background:${accent.iconBg}">${r.emoji || '🔔'}</div>
                    <div class="flex-1 min-w-0">
                        <div class="text-xs font-bold text-gray-800 truncate">${r.name}</div>
                        <div class="text-[10px] font-medium" style="color:${accent.label}">${accent.badge}</div>
                    </div>
                    <span class="text-sm font-extrabold" style="color:${accent.amtColor}">${amtTxt}</span>
                </div>
                <div class="prog-bar" style="height:4px"><div class="prog-fill" style="width:${pct}%;${accent.fill}"></div></div>
                <div class="flex justify-between items-center mt-1.5">
                    <span class="text-[10px] text-gray-400">${dayTxt}</span>
                    <button class="reminder-register-btn text-[10px] font-bold px-2.5 py-1 rounded-lg text-white transition-all flex-shrink-0"
                        style="background:${accent.btn}" data-reminder-id="${r.id}">
                        Registrar
                    </button>
                </div>
            </div>`;
        };

        // Não pagos primeiro (ordem por dia), pagos ao final (ordem por dia)
        let html = '';
        html += unpaid.map(r => card(r, accentFor(r))).join('');
        html += paid.map(r   => card(r, accentFor(r))).join('');

        // Injeta os cards numa div separada para não sobrescrever o botão vazio
        wrap.querySelectorAll('.reminder-cards-wrap').forEach(el => el.remove());
        const cardsDiv = document.createElement('div');
        cardsDiv.className = 'reminder-cards-wrap space-y-3';
        cardsDiv.innerHTML = html;
        wrap.appendChild(cardsDiv);

        // Clique no botão Registrar → abre fluxo de cadastro
        cardsDiv.querySelectorAll('.reminder-register-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                this.quickAddFromReminder(btn.dataset.reminderId);
            });
        });

        // Clique no botão ↩ → desfaz pagamento
        cardsDiv.querySelectorAll('.reminder-unpay-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                this._unmarkReminderPaid(btn.dataset.reminderId);
                this.renderRemindersHome();
            });
        });

        // Clique no card PAGO → mostra detalhe do lançamento
        cardsDiv.querySelectorAll('.reminder-paid-card').forEach(card => {
            card.addEventListener('click', e => {
                if (e.target.closest('.reminder-unpay-btn')) return;
                const remId = card.dataset.reminderId;
                const rem = this.reminders.find(r => r.id === remId);
                const txn = (this._monthTransactions || []).find(t => t.reminder_id === remId);
                this.openReminderTxnModal(rem, txn);
            });
        });

        // Clique no card NÃO PAGO (fora do botão) → inicia registro
        cardsDiv.querySelectorAll('.reminder-unpaid-card').forEach(card => {
            card.addEventListener('click', e => {
                if (e.target.closest('.reminder-register-btn')) return;
                this.quickAddFromReminder(card.dataset.reminderId);
            });
        });
    },

    // ── Reminder Transaction Detail Modal ───────────────────────────────────
    openReminderTxnModal(rem, txn) {
        const modal = document.getElementById('reminder-txn-modal');
        if (!modal) return;
        modal.classList.remove('hidden');

        document.getElementById('reminder-txn-emoji').textContent  = rem?.emoji || '🔔';
        document.getElementById('reminder-txn-title').textContent  = rem?.name  || 'Lembrete';

        const body = document.getElementById('reminder-txn-body');

        if (!txn) {
            document.getElementById('reminder-txn-sub').textContent = 'Lançamento não encontrado neste mês';
            body.innerHTML = `
            <div class="flex flex-col items-center justify-center py-10 text-gray-400 gap-2">
                <span class="text-3xl">🔍</span>
                <p class="text-sm">Nenhum lançamento vinculado encontrado.</p>
                <p class="text-xs text-gray-300">O registro pode ter sido feito em outro mês.</p>
            </div>`;
            return;
        }

        // Sub-título: data do lançamento
        const dateLabel = txn.date
            ? new Date(txn.date + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
            : '';
        document.getElementById('reminder-txn-sub').textContent = dateLabel;

        // Detalhe estilo resumo
        const beh      = Storage.getBehavior(txn.type);
        const isIncome = beh === 'soma';
        const sign     = isIncome ? '+' : beh === 'subtrai' ? '-' : '±';
        const color    = isIncome ? 'text-emerald-600' : beh === 'subtrai' ? 'text-red-600' : 'text-gray-500';
        const catIcon  = this.getCategoryIcon(txn.category);
        const badge    = this.getInserterBadge(txn);

        body.innerHTML = `
        <div class="bg-gray-50 rounded-2xl p-4 space-y-3">
            <!-- Ícone + descrição -->
            <div class="flex items-center gap-3">
                <div class="w-11 h-11 rounded-2xl bg-white flex items-center justify-center text-2xl shadow-sm flex-shrink-0">${catIcon}</div>
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-bold text-gray-800 truncate">${txn.description || txn.category || '—'}</p>
                    <p class="text-xs text-gray-400">${txn.category || ''}${badge ? ' · ' : ''}${badge ? badge.replace(/<[^>]*>/g,'') : ''}</p>
                </div>
                <span class="text-lg font-extrabold flex-shrink-0 ${color}">${sign}${this.formatCurrency(txn.value)}</span>
            </div>

            <!-- Linha divisória -->
            <div class="border-t border-gray-200"></div>

            <!-- Detalhes em grid -->
            <div class="grid grid-cols-2 gap-3 text-xs">
                <div>
                    <p class="text-gray-400 mb-0.5">Data</p>
                    <p class="font-semibold text-gray-700">${dateLabel || '—'}</p>
                </div>
                <div>
                    <p class="text-gray-400 mb-0.5">Tipo</p>
                    <p class="font-semibold text-gray-700">${txn.type || '—'}</p>
                </div>
                <div>
                    <p class="text-gray-400 mb-0.5">Categoria</p>
                    <p class="font-semibold text-gray-700">${txn.category || '—'}</p>
                </div>
                <div>
                    <p class="text-gray-400 mb-0.5">Valor</p>
                    <p class="font-bold ${color}">${sign}${this.formatCurrency(txn.value)}</p>
                </div>
                ${txn.notes ? `<div class="col-span-2"><p class="text-gray-400 mb-0.5">Observação</p><p class="font-semibold text-gray-700">${txn.notes}</p></div>` : ''}
            </div>
        </div>

        <!-- Botão editar -->
        <button id="reminder-txn-edit-btn" class="mt-4 w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-emerald-200 text-emerald-700 text-sm font-semibold hover:bg-emerald-50 transition-colors">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.172-8.172z"/>
            </svg>
            Editar lançamento
        </button>`;

        document.getElementById('reminder-txn-edit-btn')?.addEventListener('click', () => {
            this.closeReminderTxnModal();
            this.openModal(txn);
        });
    },

    closeReminderTxnModal() {
        document.getElementById('reminder-txn-modal')?.classList.add('hidden');
    },

    // ── Reminder paid helpers ────────────────────────────────────────────────
    // Fonte primária: transações do Supabase (sobrevive a limpeza de cache).
    // Fonte secundária: localStorage (compatibilidade e fallback enquanto
    //   _monthTransactions ainda não foi carregado).
    _currentMonth() { return this.currentMonth || new Date().toISOString().slice(0, 7); },
    _paidKey(month) { return 'reminder_paid_' + month; },
    _getPaidReminders(month) {
        try { return JSON.parse(localStorage.getItem(this._paidKey(month)) || '[]'); } catch { return []; }
    },
    _markReminderPaid(id) {
        // Escreve no localStorage só para o toast de mês; a verdade fica no Supabase.
        const month = this._currentMonth();
        const list  = this._getPaidReminders(month);
        if (!list.includes(id)) { list.push(id); localStorage.setItem(this._paidKey(month), JSON.stringify(list)); }
        return month;
    },
    _unmarkReminderPaid(id) {
        // Remove do localStorage (a transação já foi deletada do Supabase pelo chamador).
        const month = this._currentMonth();
        const list  = this._getPaidReminders(month).filter(x => x !== id);
        localStorage.setItem(this._paidKey(month), JSON.stringify(list));
    },
    isReminderPaid(id) {
        // 1. Verifica nas transações reais já carregadas (fonte principal — Supabase)
        if (this._monthTransactions && this._monthTransactions.some(t => t.reminder_id === id)) return true;
        // 2. Fallback: localStorage (enquanto as transações ainda não foram carregadas)
        return this._getPaidReminders(this._currentMonth()).includes(id);
    },
    _reminderPaidMonth(id) { return this._currentMonth(); },

    quickAddFromReminder(id) {
        const r = this.reminders.find(x => x.id === id);
        if (!r) return;
        this._reminderSourceId = id;   // rastreia qual lembrete gerou o modal

        const today = new Date().toISOString().slice(0, 10);
        const day   = String(r.day).padStart(2, '0');
        const month = new Date().toISOString().slice(0, 7);
        const date  = `${month}-${day}`;

        // Passa todos os dados via objeto para que sobrevivam ao picker de perfil
        this.openModal({
            description: r.name,
            value:       r.amount > 0 ? r.amount : undefined,
            date:        date <= today ? date : today,
            category:    r.category || undefined,
            type:        r.type || 'saida',
        });
    },

    bindRemindersUI() {
        const modal = document.getElementById('reminders-modal');
        document.getElementById('reminders-modal-close')?.addEventListener('click',  () => this.closeRemindersModal());
        modal?.addEventListener('click', e => { if (e.target === modal) this.closeRemindersModal(); });
        document.getElementById('reminder-add-btn')?.addEventListener('click', () => this.openReminderForm());

        const fModal = document.getElementById('reminder-form-modal');
        document.getElementById('reminder-form-close')?.addEventListener('click',  () => this.closeReminderForm());
        document.getElementById('reminder-form-cancel')?.addEventListener('click', () => this.closeReminderForm());
        fModal?.addEventListener('click', e => { if (e.target === fModal) this.closeReminderForm(); });
        document.getElementById('reminder-form-save')?.addEventListener('click',   () => this.saveReminderForm());

        // ── Áudio no form de lembrete ──────────────────────────────────────────
        document.getElementById('reminder-voice-btn')?.addEventListener('click', () => {
            this._startReminderVoice();
        });
    },

    _startReminderVoice() {
        const btn  = document.getElementById('reminder-voice-btn');
        const hint = document.getElementById('reminder-voice-hint');
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            this.showToast('⚠️ Seu navegador não suporta reconhecimento de voz', true);
            return;
        }

        if (btn._listening) return; // evita duplo clique

        const rec = new SpeechRecognition();
        rec.lang           = 'pt-BR';
        rec.interimResults = false;
        rec.maxAlternatives = 1;

        btn._listening = true;
        btn.textContent = '🔴';
        btn.classList.add('listening');
        if (hint) hint.textContent = 'Ouvindo... fale agora';

        rec.onresult = (e) => {
            const text = e.results[0][0].transcript.trim();
            if (hint) hint.textContent = `"${text}"`;
            this._fillReminderFromVoice(text);
        };

        rec.onerror = (e) => {
            const msgs = {
                'not-allowed':  'Permissão de microfone negada.',
                'no-speech':    'Nenhuma fala detectada.',
                'network':      'Erro de rede. Verifique a conexão.',
                'aborted':      'Gravação cancelada.',
            };
            const msg = msgs[e.error] || `Erro: ${e.error}`;
            this.showToast(`⚠️ ${msg}`, true);
            if (hint) hint.textContent = 'Ex: "Luz dia 10 valor 120 reais"';
        };

        rec.onend = () => {
            btn._listening  = false;
            btn.textContent = '🎤';
            btn.classList.remove('listening');
            setTimeout(() => {
                if (hint && !hint.textContent.startsWith('"'))
                    hint.textContent = 'Ex: "Luz dia 10 valor 120 reais"';
            }, 3000);
        };

        rec.start();
    },

    _fillReminderFromVoice(text) {
        const lower = text.toLowerCase();

        // ── Nome: tudo antes de "dia", "valor", "reais", número ──────────────
        const nameMatch = text.match(/^([^\d]+?)(?:\s+dia\s|\s+valor\s|\s+\d|$)/i);
        const name = nameMatch ? nameMatch[1].trim() : text.split(' ').slice(0, 3).join(' ');
        if (name) {
            const nameEl = document.getElementById('reminder-name-input');
            if (nameEl) nameEl.value = name.charAt(0).toUpperCase() + name.slice(1);
        }

        // ── Dia: "dia 10", "todo dia 5", ou número isolado 1-31 ─────────────
        const dayMatch = lower.match(/\bdia\s+(\d{1,2})\b/) || lower.match(/\b(0?[1-9]|[12]\d|3[01])\b/);
        if (dayMatch) {
            const d = parseInt(dayMatch[1]);
            if (d >= 1 && d <= 31) {
                const dayEl = document.getElementById('reminder-day-input');
                if (dayEl) dayEl.value = d;
            }
        }

        // ── Valor: "valor 120", "120 reais", "r$ 150,00" ────────────────────
        const valMatch = lower.match(/(?:valor|r\$)\s*(\d+(?:[.,]\d{1,2})?)/)
                      || lower.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:reais|real)/);
        if (valMatch) {
            const v = parseFloat(valMatch[1].replace(',', '.'));
            if (!isNaN(v) && v > 0) {
                const amtEl = document.getElementById('reminder-amount-input');
                if (amtEl) amtEl.value = v.toFixed(2);
            }
        }

        // ── Categoria: via NLP ───────────────────────────────────────────────
        const cat = NLP.extractCategory(text);
        if (cat && cat !== 'Outros') {
            const catEl = document.getElementById('reminder-category-input');
            if (catEl && [...catEl.options].some(o => o.value === cat))
                catEl.value = cat;
        }

        // ── Emoji: tenta adivinhar pela categoria ────────────────────────────
        const emojiMap = {
            'Alimentação':'🍔','Transporte':'🚗','Saúde':'💊','Moradia':'🏠',
            'Educação':'📚','Lazer':'🎮','Vestuário':'👕','PIX':'💸','Salário':'💰',
        };
        if (cat && emojiMap[cat]) {
            const emojiEl = document.getElementById('reminder-emoji-input');
            if (emojiEl && emojiEl.value === '🔔') emojiEl.value = emojiMap[cat];
        }

        this.showToast('✅ Campos preenchidos por voz!');
    },

    openRemindersModal() {
        document.getElementById('reminders-modal')?.classList.remove('hidden');
        this.renderRemindersList();
    },

    closeRemindersModal() {
        document.getElementById('reminders-modal')?.classList.add('hidden');
    },

    renderRemindersList() {
        const list = document.getElementById('reminders-list-container');
        if (!list) return;
        if (!this.reminders.length) {
            list.innerHTML = `<div class="text-center text-gray-400 py-8">
                <div class="text-3xl mb-2">🔔</div>
                <p class="text-sm">Nenhum lembrete cadastrado</p>
                <p class="text-xs mt-1">Adicione pagamentos recorrentes para não esquecer</p>
            </div>`;
            return;
        }
        list.innerHTML = this.reminders.map(r => {
            const amt = r.amount > 0 ? ` · ${this.formatCurrency(r.amount)}` : '';
            const cat = r.category ? ` · ${r.category}` : '';
            return `<div class="flex items-center gap-3 bg-gray-50 rounded-xl px-3 py-3 border border-gray-100">
                <span class="text-2xl">${r.emoji || '🔔'}</span>
                <div class="flex-1 min-w-0">
                    <div class="font-semibold text-gray-800 text-sm truncate">${r.name}</div>
                    <div class="text-xs text-gray-400">Todo dia ${r.day}${cat}${amt}</div>
                </div>
                <button class="reminder-edit-btn p-1.5 rounded-lg hover:bg-white text-gray-400 hover:text-emerald-600" data-id="${r.id}" title="Editar">✏️</button>
                <button class="reminder-del-btn  p-1.5 rounded-lg hover:bg-white text-gray-400 hover:text-red-500"  data-id="${r.id}" title="Excluir">🗑️</button>
            </div>`;
        }).join('');

        list.querySelectorAll('.reminder-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => { const r = this.reminders.find(x => x.id === btn.dataset.id); if (r) this.openReminderForm(r); });
        });
        list.querySelectorAll('.reminder-del-btn').forEach(btn => {
            btn.addEventListener('click', () => this.deleteReminder(btn.dataset.id));
        });
    },

    openReminderForm(reminder = null) {
        this.editingReminderId = reminder?.id || null;
        document.getElementById('reminder-form-title').textContent = reminder ? 'Editar Lembrete' : 'Novo Lembrete';
        document.getElementById('reminder-name-input').value    = reminder?.name    || '';
        document.getElementById('reminder-day-input').value     = reminder?.day     || '';
        document.getElementById('reminder-amount-input').value  = reminder?.amount > 0 ? reminder.amount : '';
        document.getElementById('reminder-emoji-input').value   = reminder?.emoji   || '🔔';
        document.getElementById('reminder-category-input').value = reminder?.category || '';
        // Preenche o select de categoria com as categorias disponíveis + opção de criar
        const catSel = document.getElementById('reminder-category-input');
        this._populateReminderCatSelect(catSel, reminder?.category || '');
        // Garante que painel de nova categoria esteja fechado ao abrir o form
        const ncPanel = document.getElementById('reminder-new-cat-panel');
        if (ncPanel) ncPanel.style.display = 'none';
        // Tipo
        const typeSel = document.getElementById('reminder-type-input');
        const allTypes = [
            { id: 'saida',   name: '💸 Saída (Gasto)' },
            { id: 'entrada', name: '💰 Entrada (Receita)' },
            ...Storage.getCustomTypes().map(t => ({ id: t.id, name: `${t.emoji} ${t.name}` }))
        ];
        typeSel.innerHTML = allTypes.map(t => `<option value="${t.id}" ${reminder?.type === t.id ? 'selected' : ''}>${t.name}</option>`).join('');
        document.getElementById('reminder-form-modal')?.classList.remove('hidden');
        document.getElementById('reminder-name-input').focus();
    },

    closeReminderForm() {
        document.getElementById('reminder-form-modal')?.classList.add('hidden');
        this.editingReminderId = null;
    },

    // Popula o select de categoria do form de lembrete (inclui opção "Nova categoria")
    _populateReminderCatSelect(sel, selectedName = '') {
        sel.innerHTML =
            `<option value="">— Sem categoria —</option>` +
            this.categories.map(c =>
                `<option value="${this._escHtml(c.name)}" ${c.name === selectedName ? 'selected' : ''}>${c.emoji} ${this._escHtml(c.name)}</option>`
            ).join('') +
            `<option value="__new__">➕ Nova categoria…</option>`;
    },

    // Liga os eventos do painel de nova categoria no form de lembrete
    bindReminderNewCat() {
        const sel    = document.getElementById('reminder-category-input');
        const panel  = document.getElementById('reminder-new-cat-panel');
        const nameIn = document.getElementById('reminder-cat-name');
        const emojiIn= document.getElementById('reminder-cat-emoji');
        const saveBtn= document.getElementById('reminder-cat-save');
        const cancelBtn = document.getElementById('reminder-cat-cancel');
        if (!sel || !panel) return;

        // Abre painel quando usuário escolhe "Nova categoria…"
        sel.addEventListener('change', () => {
            if (sel.value === '__new__') {
                panel.style.display = 'block';
                nameIn?.focus();
            } else {
                panel.style.display = 'none';
            }
        });

        // Cancelar — fecha painel e volta para "Sem categoria"
        cancelBtn?.addEventListener('click', () => {
            panel.style.display = 'none';
            sel.value = '';
        });

        // Salvar nova categoria
        saveBtn?.addEventListener('click', async () => {
            const name  = nameIn?.value.trim();
            const emoji = emojiIn?.value.trim() || '📦';
            if (!name) { nameIn?.focus(); return; }

            saveBtn.disabled = true;
            saveBtn.textContent = 'Criando…';
            try {
                // Verifica duplicata local
                if (this.categories.find(c => c.name.toLowerCase() === name.toLowerCase())) {
                    // Já existe — apenas seleciona
                    this._populateReminderCatSelect(sel, name);
                    panel.style.display = 'none';
                    this.showToast('✅ Categoria selecionada!');
                    return;
                }
                const cat = await Storage.createCategory(name, emoji, [], 'both');
                this.categories.push(cat);
                this.categories = this._sortCategories(this.categories);
                NLP.setCategoryMap(this.categories);
                this.renderCategorySelect();
                this.renderQuickButtons();
                // Atualiza o select do lembrete e seleciona a nova categoria
                this._populateReminderCatSelect(sel, name);
                panel.style.display = 'none';
                nameIn.value  = '';
                emojiIn.value = '';
                this.showToast('✅ Categoria criada!');
            } catch (e) {
                this.showToast('❌ ' + (e.message || 'Erro ao criar categoria'), true);
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Criar';
            }
        });

        // Enter no campo de nome também salva
        nameIn?.addEventListener('keydown', e => { if (e.key === 'Enter') saveBtn?.click(); });
    },

    async saveReminderForm() {
        const name   = document.getElementById('reminder-name-input').value.trim();
        const day    = parseInt(document.getElementById('reminder-day-input').value);
        const amount = parseFloat(document.getElementById('reminder-amount-input').value) || 0;
        const emoji  = document.getElementById('reminder-emoji-input').value.trim() || '🔔';
        const catRaw   = document.getElementById('reminder-category-input').value;
        const category = catRaw === '__new__' ? '' : catRaw; // ignora opção de nova categoria não finalizada
        const type   = document.getElementById('reminder-type-input').value || 'saida';

        if (!name) { document.getElementById('reminder-name-input').focus(); return; }
        if (!day || day < 1 || day > 31) { this.showToast('⚠️ Dia inválido (1–31)', true); return; }

        const btn = document.getElementById('reminder-form-save');
        btn.disabled = true; btn.textContent = 'Salvando...';
        try {
            if (this.editingReminderId) {
                await Storage.updateReminder(this.editingReminderId, { name, day, amount, emoji, category, type });
                const idx = this.reminders.findIndex(r => r.id === this.editingReminderId);
                if (idx !== -1) this.reminders[idx] = { ...this.reminders[idx], name, day, amount, emoji, category, type };
            } else {
                const r = await Storage.createReminder({ name, day, amount, emoji, category, type });
                this.reminders.push(r);
            }
            this.reminders.sort((a, b) => a.day - b.day);
            this.closeReminderForm();
            this.renderRemindersList();
            this.renderRemindersHome();
            this.showToast(this.editingReminderId ? '✅ Lembrete atualizado!' : '✅ Lembrete criado!');
        } catch (e) {
            this.showToast('❌ Erro: ' + e.message, true);
        } finally {
            btn.disabled = false; btn.textContent = 'Salvar';
        }
    },

    async deleteReminder(id) {
        if (!confirm('Excluir este lembrete?')) return;
        try {
            await Storage.deleteReminder(id);
            this.reminders = this.reminders.filter(r => r.id !== id);
            this.renderRemindersList();
            this.renderRemindersHome();
            this.showToast('🗑️ Lembrete excluído');
        } catch (e) {
            this.showToast('❌ Erro: ' + e.message, true);
        }
    },

    // ─── Voz no modal de lançamento ───────────────────────────────────────────
    _startModalVoice() {
        const btn      = document.getElementById('modal-voice-btn');
        const feedback = document.getElementById('modal-voice-feedback');
        const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRec) {
            this.showToast('⚠️ Voz não disponível neste navegador', true);
            return;
        }
        if (btn._listening) return;

        const rec = new SpeechRec();
        rec.lang            = 'pt-BR';
        rec.interimResults  = false;
        rec.maxAlternatives = 1;

        // Estado: gravando
        btn._listening = true;
        btn.innerHTML  = '<span class="text-base listening">🔴</span><span>Ouvindo...</span>';
        btn.classList.add('bg-white/40');
        if (feedback) { feedback.textContent = '🎙️ Fale o lançamento...'; feedback.classList.remove('hidden'); }

        rec.onresult = (e) => {
            const text = e.results[0][0].transcript.trim();
            // Mostra o texto reconhecido em destaque para o usuário verificar
            if (feedback) {
                feedback.innerHTML = `<span class="text-white/60 text-[10px]">Reconhecido:</span> <span class="font-semibold">"${this._escHtml(text)}"</span>`;
                feedback.classList.remove('hidden');
            }
            this._fillModalFromVoice(text);
        };

        rec.onerror = (e) => {
            const msgs = {
                'not-allowed': 'Permissão de microfone negada.',
                'no-speech':   'Nenhuma fala detectada. Tente novamente.',
                'network':     'Sem internet. A voz precisa de conexão.',
            };
            const msg = msgs[e.error] || `Erro: ${e.error}`;
            if (feedback) { feedback.textContent = `⚠️ ${msg}`; }
            this.showToast(`⚠️ ${msg}`, true);
        };

        rec.onend = () => {
            btn._listening = false;
            btn.innerHTML  = '<span class="text-base">🎤</span><span>Voz</span>';
            btn.classList.remove('bg-white/40');
            // Mantém o texto reconhecido visível por mais tempo para o usuário conferir
            setTimeout(() => { if (feedback) feedback.classList.add('hidden'); }, 6000);
        };

        rec.start();
    },

    _fillModalFromVoice(text) {
        // Usa o mesmo NLP do quick-input para extrair todos os campos
        const parsed = NLP.parse(text);

        // Descrição
        if (parsed.description) {
            document.getElementById('modal-description').value = parsed.description;
            // Dispara o listener de aprendizado de categoria
            document.getElementById('modal-description').dispatchEvent(new Event('input'));
        }

        // Valor
        if (parsed.value) {
            document.getElementById('modal-value').value = this._toMaskedCurrency(parsed.value);
        }

        // Data
        if (parsed.date) {
            document.getElementById('modal-date').value = parsed.date;
            this._updateInstallmentPreview?.();
        }

        // Categoria
        if (parsed.category && parsed.category !== 'Outros') {
            const sel = document.getElementById('modal-category');
            if (sel && [...sel.options].some(o => o.value === parsed.category)) {
                sel.value = parsed.category;
                this._catUserPicked = false; // não bloqueia sugestões futuras
            }
        }

        // Tipo
        if (parsed.type) {
            this.selectModalType(parsed.type);
        }

        this.showToast('✅ Campos preenchidos por voz!');
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
            // Mostra brevemente o texto reconhecido para o usuário conferir
            this.showToast(`🎤 "${transcript}"`, false, 3000);
            this.processQuickInput();
        };
        this.recognition.onerror = e => {
            this.stopListening();
            const msgs = {
                'network':             'Sem internet. Digite o lançamento no campo de texto.',
                'not-allowed':         'Microfone bloqueado. Clique no 🔒 da barra de endereço e permita o microfone.',
                'no-speech':           'Nenhuma fala detectada. Tente novamente.',
                'audio-capture':       'Microfone não encontrado ou ocupado por outro app.',
                'service-not-allowed': 'Serviço de voz bloqueado. Use HTTPS ou localhost.',
            };
            const msg = msgs[e.error] || `Erro de voz: ${e.error}`;
            this.showToast('🎤 ' + msg, true);
            // Fallback: foca no campo de texto para o usuário digitar
            const input = document.getElementById('quick-input');
            if (input) {
                input.focus();
                input.placeholder = '✏️ Digite o lançamento aqui...';
                setTimeout(() => {
                    input.placeholder = 'Ex: "Gastei 50 no mercado" ou "Recebi 1500 de salário"';
                }, 4000);
            }
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
        dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('border-emerald-500', 'bg-emerald-50'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('border-emerald-500', 'bg-emerald-50'));
        dropzone.addEventListener('drop', e => {
            e.preventDefault();
            dropzone.classList.remove('border-emerald-500', 'bg-emerald-50');
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
        const [summary, allMonth] = await Promise.all([
            Storage.getSummary(this.currentMonth),
            Storage.getTransactions({ month: this.currentMonth }),
            this.loadReminders()   // sempre atualiza lembretes ao renderizar home
        ]);
        // Cacheia para isReminderPaid derivar do Supabase (não depende de localStorage)
        this._monthTransactions = allMonth;
        // Garante categorias renderizadas mesmo se loadCategories ocorreu antes do DOM estar pronto
        if (document.getElementById('quick-cats-grid')?.children.length === 0) {
            this.renderQuickButtons();
        }
        // Aprendizado retroativo: processa histórico existente uma única vez
        this._retroLearn(allMonth);
        // Balance com decimal em fonte menor (estilo fintech)
        const balEl = document.getElementById('balance');
        if (balEl) {
            const formatted = this.formatCurrency(summary.balance);
            // Separa parte inteira e decimal: "R$ 1.234,56" → ["R$ 1.234", "56"]
            const commaIdx = formatted.lastIndexOf(',');
            const intPart  = commaIdx >= 0 ? formatted.slice(0, commaIdx) : formatted;
            const decPart  = commaIdx >= 0 ? formatted.slice(commaIdx)    : '';
            balEl.innerHTML = `${intPart}<span class="balance-decimal">${decPart}</span>`;
            balEl.className = `text-4xl font-extrabold tracking-tight leading-none ${summary.balance >= 0 ? 'text-white' : 'text-red-300'}`;
        }
        document.getElementById('total-income').textContent  = this.formatCurrency(summary.income);
        document.getElementById('total-expense').textContent = this.formatCurrency(summary.expense);
        this.renderRemindersHome();

        const q = this._homeSearch.trim().toLowerCase();
        const label = document.getElementById('home-section-label');

        if (q) {
            // Busca em TODOS os meses
            const allTxns = await Storage.getTransactions();
            const filtered = allTxns.filter(t =>
                (t.description || '').toLowerCase().includes(q) ||
                (t.category    || '').toLowerCase().includes(q)
            );
            if (label) label.textContent = filtered.length
                ? `${filtered.length} resultado${filtered.length !== 1 ? 's' : ''} encontrado${filtered.length !== 1 ? 's' : ''}`
                : 'Nenhum resultado';
            this.renderTransactionList('home-transactions', filtered, q);
        } else {
            if (label) label.textContent = 'Lançamentos do mês';
            this.renderTransactionList('home-transactions', allMonth.slice(0, 30));
        }
    },

    // ─── Bind Home Search ─────────────────────────────────────────────────────
    bindHomeSearch() {
        const toggleBtn = document.getElementById('home-search-toggle');
        const bar       = document.getElementById('home-search-bar');
        const input     = document.getElementById('home-search');
        const clearBtn  = document.getElementById('home-search-clear');
        if (!toggleBtn || !bar || !input) return;

        // Abre/fecha a barra
        toggleBtn.addEventListener('click', () => {
            const isOpen = !bar.classList.contains('hidden');
            if (isOpen) {
                // Fecha e limpa
                bar.classList.add('hidden');
                input.value = '';
                this._homeSearch = '';
                toggleBtn.classList.remove('text-emerald-600', 'bg-emerald-50');
                this.renderHome();
            } else {
                bar.classList.remove('hidden');
                toggleBtn.classList.add('text-emerald-600', 'bg-emerald-50');
                setTimeout(() => input.focus(), 50);
            }
        });

        // Digitar na busca
        input.addEventListener('input', () => {
            this._homeSearch = input.value;
            clearBtn.classList.toggle('hidden', !input.value);
            this.renderHome();
        });

        // Botão ✕ dentro do input
        clearBtn.addEventListener('click', () => {
            input.value = '';
            this._homeSearch = '';
            clearBtn.classList.add('hidden');
            input.focus();
            this.renderHome();
        });

        // ESC fecha a barra
        input.addEventListener('keydown', e => {
            if (e.key === 'Escape') toggleBtn.click();
        });
    },

    // ─── Category Learning ────────────────────────────────────────────────────
    // Estrutura do mapa: { "frase": { "Categoria": contagem, ... }, ... }
    // A categoria com maior contagem vence → robusto contra erros acidentais.

    _getLearnedMap() {
        try { return JSON.parse(localStorage.getItem(this._LEARN_KEY) || '{}'); }
        catch { return {}; }
    },

    _saveLearnedMap(map) {
        try { localStorage.setItem(this._LEARN_KEY, JSON.stringify(map)); } catch {}
    },

    // Extrai tokens aprendíveis: frase completa + bigramas + palavras individuais
    _extractTokens(normDesc) {
        const stopWords = new Set([
            // Artigos / preposições / conjunções
            'para','com','uma','umas','que','por','nao','nao','foi','ser','tem',
            'ter','das','dos','numa','num','pelo','pela','este','essa','isso',
            'meu','minha','meus','minhas','seu','sua','seus','suas','mais','muito',
            'uns','ela','ele','eles','elas','nos','nas','aos',
            // ⚠️ Temporais — aparecem em todo tipo de lançamento; não identificam categoria
            'hoje','ontem','amanha','semana','passada','proxima','agora',
            'dia','dias','mes','meses','ano','anos','manha','tarde','noite',
            'segunda','terca','quarta','quinta','sexta','sabado','domingo',
            // Verbos de transação — genéricos demais
            'gastei','paguei','comprei','recebi','ganhei','fui','fiz','fez',
            'mandei','enviei','transferi','depositei','saquei',
            // Quantificadores genéricos
            'real','reais','valor','total','gasto',
        ]);
        const words = normDesc.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
        const tokens = new Set();

        // Frase completa (até 5 palavras — evita frases genéricas demais)
        if (words.length >= 1 && words.length <= 5) tokens.add(normDesc);

        // Bigramas (pares de palavras consecutivas)
        for (let i = 0; i < words.length - 1; i++) {
            if (words[i].length > 2 && words[i+1].length > 2)
                tokens.add(`${words[i]} ${words[i+1]}`);
        }

        // Palavras individuais com comprimento > 3
        for (const w of words) {
            if (w.length > 3) tokens.add(w);
        }

        return [...tokens];
    },

    // Incrementa contagem de (token → categoria) no mapa com peso opcional
    _learnCategory(description, category, weight = 1) {
        if (!description || !category || category === 'Outros') return;
        const map  = this._getLearnedMap();
        const norm = str => str.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
        const tokens = this._extractTokens(norm(description));

        for (const token of tokens) {
            if (!map[token]) map[token] = {};
            map[token][category] = (map[token][category] || 0) + weight;
        }

        this._saveLearnedMap(map);
        NLP.setLearnedMap(this._resolveLearnedMap(map));
    },

    // Converte mapa de frequências → mapa simples { token: categoriaVencedora }
    // usado pelo NLP (que espera o formato simples)
    _resolveLearnedMap(map) {
        const resolved = {};
        for (const [token, counts] of Object.entries(map)) {
            if (!counts || typeof counts !== 'object') {
                // Compatibilidade com mapa antigo (valor era string direto)
                if (typeof counts === 'string') resolved[token] = counts;
                continue;
            }
            const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
            if (best) resolved[token] = best[0];
        }
        return resolved;
    },

    // Inicializa NLP com mapa resolvido (chamado no init)
    _initLearnedMap() {
        NLP.setLearnedMap(this._resolveLearnedMap(this._getLearnedMap()));
    },

    // Aprende com todos os lançamentos já existentes (executa uma vez por sessão)
    async _retroLearn(txns) {
        // v3: stopWords expandido (temporais removidos), mapa regenerado limpo
        const key = 'financas_retro_learned_v3';
        if (localStorage.getItem(key)) return; // já executou
        // Limpa mapa antigo (pode conter associações ruins com palavras temporais)
        try { localStorage.removeItem(this._LEARN_KEY); } catch {}
        NLP.setLearnedMap({});
        if (!txns || !txns.length) return;
        const map = this._getLearnedMap();
        const norm = str => str.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

        for (const t of txns) {
            if (!t.description || !t.category || t.category === 'Outros') continue;
            const tokens = this._extractTokens(norm(t.description));
            for (const token of tokens) {
                if (!map[token]) map[token] = {};
                map[token][t.category] = (map[token][t.category] || 0) + 1;
            }
        }
        this._saveLearnedMap(map);
        NLP.setLearnedMap(this._resolveLearnedMap(map));
        localStorage.setItem(key, '1');
    },

    // Testa se o texto tem associação aprendida; retorna { cat, confidence } ou null
    _suggestLearnedCategory(text) {
        if (!text || text.length < 2) return null;
        const map = this._getLearnedMap();
        if (!Object.keys(map).length) return null;
        const norm = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

        // Testa tokens do texto contra o mapa, preferindo frases mais longas
        const candidates = {};
        const tokens = this._extractTokens(norm);

        for (const token of tokens) {
            const counts = map[token];
            if (!counts) continue;
            // Compatibilidade com formato antigo
            if (typeof counts === 'string') {
                candidates[counts] = (candidates[counts] || 0) + token.split(' ').length;
                continue;
            }
            for (const [cat, count] of Object.entries(counts)) {
                // Peso: contagem × comprimento do token (frases longas = mais específicas)
                candidates[cat] = (candidates[cat] || 0) + count * token.split(' ').length;
            }
        }

        if (!Object.keys(candidates).length) return null;
        const best = Object.entries(candidates).sort((a, b) => b[1] - a[1])[0];
        const total = Object.values(candidates).reduce((s, v) => s + v, 0);
        const confidence = Math.round((best[1] / total) * 100);
        return { cat: best[0], confidence };
    },

    // ─── Render History ───────────────────────────────────────────────────────
    async renderHistory() {
        const search = document.getElementById('history-search')?.value?.toLowerCase() || '';
        const n      = this._historyMonths || 1;
        const months = this._buildMonthRange(this.currentMonth, n);

        // Busca todos os meses em paralelo
        const results = await Promise.all(months.map(m => Storage.getTransactions({ month: m })));

        // Renderiza chips de categoria com base nos dados carregados
        this._renderHistoryCatChips(results.flat());

        const container = document.getElementById('history-transactions');
        if (!container) return;

        const hasCatFilter = this._historyCategories.size > 0;

        if (n === 1) {
            // ── Modo mês único ───────────────────────────────────────────────
            let list = this._applyHistoryFilters(results[0], search);
            this.renderTransactionList('history-transactions', list, search);
        } else {
            // ── Modo multi-mês: agrupa por mês com cabeçalho ─────────────────
            container.innerHTML = '';
            const MONTH_NAMES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                                 'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
            let anyResult = false;

            for (let i = 0; i < months.length; i++) {
                const list = this._applyHistoryFilters(results[i], search);
                if (!list.length) continue;
                anyResult = true;

                const [y, m] = months[i].split('-').map(Number);

                // Cabeçalho do mês
                const header = document.createElement('div');
                header.className = 'flex items-center gap-2 mt-5 mb-1 first:mt-0';
                header.innerHTML = `
                    <span class="text-xs font-bold text-emerald-600 uppercase tracking-widest">${MONTH_NAMES[m - 1]} ${y}</span>
                    <div class="flex-1 h-px bg-emerald-100"></div>`;
                container.appendChild(header);

                const tempId = `_hist_grp_${i}`;
                const temp   = document.createElement('div');
                temp.id      = tempId;
                container.appendChild(temp);
                this.renderTransactionList(tempId, list, search);
            }

            if (!anyResult) {
                const isEmpty = !search && !hasCatFilter;
                container.innerHTML = `
                    <div class="text-center text-gray-400 py-10">
                        <div class="text-4xl mb-2">${isEmpty ? '📭' : '🔍'}</div>
                        <p>${isEmpty ? 'Nenhum lançamento no período' : 'Nenhum resultado com esses filtros'}</p>
                        ${!isEmpty ? '<p class="text-sm mt-1">Tente ajustar a busca ou as categorias</p>' : ''}
                    </div>`;
            }
        }

        // Vincula busca (uma só vez)
        const searchEl = document.getElementById('history-search');
        if (searchEl && !searchEl._bound) {
            searchEl._bound = true;
            searchEl.addEventListener('input', () => this.renderHistory());
        }

        // Atualiza visual dos pills de período
        this._updateHistoryPills();
    },

    // Aplica filtros de texto e categoria a uma lista
    _applyHistoryFilters(list, search) {
        if (search) list = list.filter(t =>
            (t.description || '').toLowerCase().includes(search) ||
            (t.category    || '').toLowerCase().includes(search)
        );
        if (this._historyCategories.size > 0) {
            list = list.filter(t => this._historyCategories.has(t.category || ''));
        }
        return list;
    },

    // Renderiza chips de categoria no painel de filtro
    _renderHistoryCatChips(allTransactions) {
        const panel = document.getElementById('history-cat-chips');
        if (!panel) return;

        // Categorias presentes nas transações carregadas, na ordem de this.categories
        const presentNames = new Set(allTransactions.map(t => t.category || '').filter(Boolean));
        const cats = this.categories.filter(c => presentNames.has(c.name));

        // Adiciona categorias que estão nos dados mas não em this.categories (ex.: legados)
        for (const name of presentNames) {
            if (!cats.find(c => c.name === name)) cats.push({ name, emoji: '📦' });
        }

        if (!cats.length) {
            panel.innerHTML = '<span class="text-xs text-gray-400 italic py-1 px-1">Sem categorias neste período</span>';
            return;
        }

        const sel = this._historyCategories;
        panel.innerHTML = cats.map(c => {
            const active = sel.has(c.name);
            return `<button class="hist-cat-chip flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap border transition-all ${active ? 'bg-emerald-500 text-white border-emerald-600' : 'bg-gray-50 text-gray-600 border-gray-200'}" data-hcat="${this._escHtml(c.name)}">
                <span>${c.emoji || '📦'}</span><span>${this._escHtml(c.name)}</span>
            </button>`;
        }).join('');

        // Botão "Limpar" quando há filtro ativo
        if (sel.size > 0) {
            panel.innerHTML += `<button id="history-cat-clear" class="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap bg-red-50 text-red-500 border border-red-200">✕ Limpar</button>`;
        }

        // Atualiza badge e cor do botão de filtro
        const badge     = document.getElementById('history-cat-badge');
        const filterBtn = document.getElementById('history-cat-filter-btn');
        if (badge) {
            badge.textContent = sel.size || '';
            badge.style.display = sel.size > 0 ? 'flex' : 'none';
        }
        if (filterBtn) {
            filterBtn.classList.toggle('bg-emerald-100', sel.size > 0);
            filterBtn.classList.toggle('text-emerald-700', sel.size > 0);
            filterBtn.classList.toggle('bg-gray-100',  sel.size === 0);
            filterBtn.classList.toggle('text-gray-600', sel.size === 0);
        }
    },

    // Gera array de N meses retroativos a partir de baseMonth (inclusive)
    _buildMonthRange(baseMonth, n) {
        const [cy, cm] = baseMonth.split('-').map(Number);
        const months = [];
        for (let i = 0; i < n; i++) {
            let year = cy, month = cm - i;
            while (month <= 0) { month += 12; year--; }
            months.push(`${year}-${String(month).padStart(2, '0')}`);
        }
        return months;
    },

    // Atualiza destaque visual dos pills de período
    _updateHistoryPills() {
        document.querySelectorAll('.history-pill').forEach(pill => {
            const active = parseInt(pill.dataset.months) === (this._historyMonths || 1);
            pill.classList.toggle('pill-active', active);
        });
    },

    // Vincula cliques nos pills de período do histórico
    bindHistoryPills() {
        document.getElementById('history-period-pills')?.addEventListener('click', async e => {
            const pill = e.target.closest('.history-pill');
            if (!pill) return;
            this._historyMonths = parseInt(pill.dataset.months) || 1;
            if (this.currentTab === 'history') await this.renderHistory();
        });
    },

    // Vincula botão de filtro e cliques nos chips de categoria
    bindHistoryCatFilter() {
        // Abre/fecha painel de chips (usa style.display para evitar conflito com classes Tailwind)
        document.getElementById('history-cat-filter-btn')?.addEventListener('click', () => {
            const panel = document.getElementById('history-cat-chips');
            if (!panel) return;
            panel.style.display = (panel.style.display === 'none' || !panel.style.display) ? 'flex' : 'none';
        });

        // Clique em chip — delegação no contêiner pai (painel re-renderiza, precisa de delegação no pai fixo)
        document.getElementById('tab-history')?.addEventListener('click', async e => {
            // Chip de categoria
            const chip = e.target.closest('.hist-cat-chip');
            if (chip) {
                const cat = chip.dataset.hcat;
                if (this._historyCategories.has(cat)) {
                    this._historyCategories.delete(cat);
                } else {
                    this._historyCategories.add(cat);
                }
                await this.renderHistory();
                return;
            }
            // Botão limpar
            if (e.target.closest('#history-cat-clear')) {
                this._historyCategories.clear();
                await this.renderHistory();
            }
        });
    },

    renderTransactionList(containerId, transactions, highlight = '') {
        const container = document.getElementById(containerId);
        if (!container) return;
        if (!transactions.length) {
            container.innerHTML = highlight
                ? `<div class="text-center text-gray-400 py-10">
                       <div class="text-4xl mb-2">🔍</div>
                       <p>Nenhum lançamento encontrado</p>
                       <p class="text-sm mt-1">Tente outro termo de busca</p>
                   </div>`
                : `<div class="text-center text-gray-400 py-10">
                       <div class="text-4xl mb-2">📭</div>
                       <p>Nenhum lançamento ainda</p>
                       <p class="text-sm mt-1">Use o campo acima para adicionar</p>
                   </div>`;
            return;
        }
        const todayStr = new Date().toISOString().split('T')[0];

        const grouped = {};
        for (const t of transactions) {
            const d = t.date || 'sem-data';
            if (!grouped[d]) grouped[d] = [];
            grouped[d].push(t);
        }
        let html = '';
        for (const [date, items] of Object.entries(grouped)) {
            const isFuture = date !== 'sem-data' && date > todayStr;
            // Cabeçalho do grupo de data
            html += isFuture
                ? `<div class="text-xs font-semibold text-indigo-400 uppercase mt-4 mb-1 px-1">⏳ ${this.formatDateGroup(date)}</div>`
                : `<div class="text-xs font-semibold text-gray-400 uppercase mt-4 mb-1 px-1">${this.formatDateGroup(date)}</div>`;

            for (const t of items) {
                const icon  = this.getCategoryIcon(t.category);
                const beh   = Storage.getBehavior(t.type);
                const color = beh === 'soma' ? 'text-green-600' : beh === 'subtrai' ? 'text-red-600' : 'text-gray-500';
                const sign  = beh === 'soma' ? '+' : beh === 'subtrai' ? '-' : '±';
                // Badge de lembrete vinculado
                const linkedReminder = t.reminder_id ? this.reminders.find(r => r.id === t.reminder_id) : null;
                const reminderBadge  = linkedReminder
                    ? `<span class="inline-flex items-center gap-1 text-xs bg-emerald-50 text-emerald-600 border border-emerald-100 rounded-full px-2 py-0.5 mt-0.5">
                           ${linkedReminder.emoji || '🔔'} ${linkedReminder.name}
                       </span>`
                    : '';
                // Badge de parcela
                const installBadge = t.installment_group_id
                    ? `<span class="inline-flex items-center gap-1 text-xs bg-purple-50 text-purple-500 border border-purple-100 rounded-full px-2 py-0.5 mt-0.5">
                           📦 ${t.installment_current}/${t.installment_total}
                       </span>`
                    : '';
                const _catName    = t.category || '';
                const catDisplay  = _catName
                    ? (highlight ? this._hlText(_catName, highlight) : this._escHtml(_catName))
                    : `<span class="text-gray-300 italic text-xs">Sem categoria</span>`;
                const descDisplay = highlight ? this._hlText(t.description, highlight) : this._escHtml(t.description);
                // Badge de tipo (Entrada / Saída / tipo customizado)
                const typeBadgeColor = beh === 'soma'    ? 'bg-green-50 text-green-600 border-green-100'
                                     : beh === 'subtrai' ? 'bg-red-50 text-red-500 border-red-100'
                                     :                     'bg-gray-100 text-gray-500 border-gray-200';
                const typeObj   = (this.transactionTypes || []).find(x => x.id === t.type);
                const typeName  = typeObj ? typeObj.name
                                : t.type === 'entrada' ? 'Entrada'
                                : t.type === 'saida'   ? 'Saída'
                                : t.type               ? this._escHtml(t.type)
                                : '';
                const typeBadge = typeName
                    ? `<span class="inline-flex items-center text-xs border rounded-full px-2 py-0.5 ${typeBadgeColor} font-medium">${this._escHtml(typeName)}</span>`
                    : '';
                // Estilo do card: futuro = fundo índigo claro; passado/hoje = branco
                const cardBg   = isFuture ? 'bg-indigo-50 border-indigo-100' : 'bg-white border-gray-100';
                const iconBg   = isFuture ? 'bg-indigo-100' : 'bg-gray-100';
                html += `
                <div class="flex items-center gap-3 ${cardBg} rounded-xl p-3 mb-2 shadow-sm border transaction-item cursor-pointer" data-id="${t.id}">
                    <div class="w-10 h-10 rounded-full ${iconBg} flex items-center justify-center text-xl flex-shrink-0">${icon}</div>
                    <div class="flex-1 min-w-0">
                        <div class="font-medium text-gray-800 truncate">${catDisplay}</div>
                        <div class="text-xs text-gray-400 truncate">${descDisplay}</div>
                        <div class="flex flex-wrap items-center gap-1 mt-0.5">${typeBadge}${reminderBadge}${installBadge}</div>
                        ${this.getInserterBadge(t)}
                    </div>
                    <div class="flex flex-col items-end gap-0.5">
                        ${t.installment_group_id ? `<div class="text-xs text-gray-400 font-normal">Total ${this.formatCurrency(t.value * t.installment_total)}</div>` : ''}
                        <div class="font-bold ${color}">${sign}${this.formatCurrency(t.value)}</div>
                        <button class="text-xs text-gray-300 hover:text-red-400 delete-btn" data-id="${t.id}" data-reminder-id="${t.reminder_id || ''}">✕</button>
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
                // reminder_id já está no atributo do botão — não depende de fetch
                const btnReminderId = btn.dataset.reminderId || null;
                try {
                    const all = await Storage.getTransactions();
                    const t   = all.find(x => x.id === btn.dataset.id);
                    if (t?.installment_group_id) {
                        // Lançamento parcelado: pergunta o que deletar
                        const groupTxns  = all.filter(x => x.installment_group_id === t.installment_group_id);
                        const futureTxns = groupTxns.filter(x => x.installment_current >= t.installment_current);
                        const choice = await this._showInstallmentDeleteDialog(t, futureTxns.length, groupTxns.length);
                        if (!choice) return;
                        const toDelete = choice === 'all'    ? groupTxns
                                       : choice === 'future' ? futureTxns
                                       :                       [t];
                        for (const tx of toDelete) {
                            // Usa reminder_id do próprio objeto (parcelas do grupo)
                            const rid = tx.reminder_id || (tx.id === btn.dataset.id ? btnReminderId : null);
                            if (rid) this._unmarkReminderPaid(rid);
                            await Storage.deleteTransaction(tx.id);
                        }
                    } else {
                        if (!confirm('Remover este lançamento?')) return;
                        // Usa reminder_id do atributo do botão (mais confiável que o fetch)
                        if (btnReminderId) this._unmarkReminderPaid(btnReminderId);
                        await Storage.deleteTransaction(btn.dataset.id);
                    }
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

        // ── 💡 Insights inteligentes ──────────────────────────────────────────
        this.renderInsightsSection(txns, prevSummary, trendSummaries);
        this.renderGoalsSection(txns);
        this.renderReconcileSection(txns);

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
                panelHtml += `<div class="text-[10px] font-semibold text-emerald-500 uppercase pt-2 pb-0.5 px-1">${this.formatDateGroup(date)}</div>`;
                for (const t of items) {
                    const isIncome = Storage.getBehavior(t.type) === 'soma';
                    const badge    = this.getInserterBadge(t);
                    panelHtml += `
                    <div class="flex items-center gap-2 bg-white rounded-lg px-2.5 py-1.5 mb-1 border border-emerald-100">
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
                <div class="cat-txn-panel hidden bg-emerald-50 rounded-2xl px-3 pt-1 pb-3 mb-2">
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

        // Exibe para todos os perfis, desde que haja ao menos um lançamento
        if (!people.length) { wrap.classList.add('hidden'); return; }
        wrap.classList.remove('hidden');

        // Sort by expense descending
        people.sort((a, b) => b.expense - a.expense);

        const totalExp = people.reduce((s, p) => s + p.expense, 0);

        const avatarPalettes = [
            ['bg-emerald-500', 'text-white'],
            ['bg-purple-500',  'text-white'],
            ['bg-orange-500',  'text-white'],
            ['bg-teal-500',    'text-white'],
            ['bg-pink-500',    'text-white'],
            ['bg-indigo-500',  'text-white'],
        ];

        // Group txns by person for panel
        const txnsByPerson = {};
        for (const t of txns) {
            const key = (t.inserted_by_email || myEmail).toLowerCase();
            if (!txnsByPerson[key]) txnsByPerson[key] = [];
            txnsByPerson[key].push(t);
        }

        let html = '';
        for (const p of people) {
            const isMe     = p.email === myEmail;
            const label    = isMe ? 'Você' : (p.email.split('@')[0] || p.email);
            const pct      = totalExp > 0 ? ((p.expense / totalExp) * 100).toFixed(1) : 0;
            const seed     = p.email.charCodeAt(0) + (p.email.charCodeAt(1) || 0);
            const [bgCls, txtCls] = avatarPalettes[seed % avatarPalettes.length];
            const initials = label.slice(0, 2).toUpperCase();
            const barColor = isMe ? 'bg-emerald-500' : ['bg-purple-400','bg-orange-400','bg-teal-400','bg-pink-400','bg-indigo-400'][seed % 5];

            // Monta painel inline de transações
            const personTxns = (txnsByPerson[p.email] || []).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

            // Helper: renderiza um item de lançamento (usado por ambas as visões)
            const renderItem = (t) => {
                const beh      = Storage.getBehavior(t.type);
                const isIncome = beh === 'soma';
                const sign     = isIncome ? '+' : beh === 'subtrai' ? '-' : '±';
                const color    = isIncome ? 'text-green-600' : beh === 'subtrai' ? 'text-red-600' : 'text-gray-500';
                const badge    = this.getInserterBadge(t);
                const catIcon  = this.getCategoryIcon(t.category);
                return `
                <div class="person-panel-item flex items-center gap-2 bg-white rounded-lg px-2.5 py-1.5 mb-1 border border-emerald-100 cursor-pointer hover:bg-emerald-50 transition-colors" data-id="${t.id}">
                    <span class="text-base flex-shrink-0">${catIcon}</span>
                    <div class="flex-1 min-w-0">
                        <div class="text-xs font-medium text-gray-800 truncate">${t.description || t.category || '—'}</div>
                        <div class="text-[10px] text-gray-400 truncate">${t.category || ''}${t.date ? ' · ' + t.date.slice(8) + '/' + this._monthAbbr(t.date) : ''}</div>
                        ${badge ? `<div class="mt-0.5">${badge}</div>` : ''}
                    </div>
                    <div class="text-xs font-bold flex-shrink-0 ${color}">${sign}${this.formatCurrency(t.value)}</div>
                </div>`;
            };

            // VISÃO 1: agrupada por data (padrão)
            const byDate = {};
            for (const t of personTxns) { const d = t.date || ''; if (!byDate[d]) byDate[d] = []; byDate[d].push(t); }
            let byDateHtml = '';
            for (const [date, items] of Object.entries(byDate)) {
                byDateHtml += `<div class="text-[10px] font-semibold text-emerald-500 uppercase pt-2 pb-0.5 px-1">${this.formatDateGroup(date)}</div>`;
                for (const t of items) byDateHtml += renderItem(t);
            }

            // VISÃO 2: agrupada por categoria — soma por categoria (apenas saídas para o ranking),
            //          mas exibe entradas/neutros também. Categorias ordenadas por total gasto desc.
            const byCat = {};
            for (const t of personTxns) {
                const cat = t.category || 'Sem categoria';
                if (!byCat[cat]) byCat[cat] = { items: [], expense: 0, income: 0 };
                byCat[cat].items.push(t);
                const beh = Storage.getBehavior(t.type);
                if (beh === 'subtrai') byCat[cat].expense += Number(t.value) || 0;
                else if (beh === 'soma') byCat[cat].income += Number(t.value) || 0;
            }
            const catsSorted = Object.entries(byCat).sort((a, b) => b[1].expense - a[1].expense);
            let byCatHtml = '';
            for (const [cat, info] of catsSorted) {
                const catIcon = this.getCategoryIcon(cat);
                const totalLine = info.expense > 0
                    ? `<span class="text-red-600 font-bold">-${this.formatCurrency(info.expense)}</span>`
                    : info.income > 0 ? `<span class="text-green-600 font-bold">+${this.formatCurrency(info.income)}</span>`
                    : '';
                byCatHtml += `
                <div class="flex items-center justify-between pt-2 pb-0.5 px-1">
                    <div class="text-[10px] font-semibold text-emerald-600 uppercase flex items-center gap-1">
                        <span class="text-sm">${catIcon}</span>${this._escHtml(cat)}
                        <span class="text-gray-400 normal-case">· ${info.items.length}</span>
                    </div>
                    <div class="text-[11px]">${totalLine}</div>
                </div>`;
                // Itens da categoria, do maior valor para o menor
                const sortedItems = [...info.items].sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
                for (const t of sortedItems) byCatHtml += renderItem(t);
            }

            // Toggle de visualização (apenas se houver lançamentos)
            let panelHtml = '';
            if (personTxns.length) {
                panelHtml = `
                <div class="flex gap-1 bg-white rounded-full p-1 mb-2 sticky top-0 z-10" data-view-toggle>
                    <button class="view-btn flex-1 text-[11px] font-semibold py-1.5 px-2 rounded-full transition-all bg-emerald-500 text-white" data-view="date">📅 Por data</button>
                    <button class="view-btn flex-1 text-[11px] font-semibold py-1.5 px-2 rounded-full transition-all text-gray-500 hover:bg-emerald-50" data-view="cat">🏷️ Por categoria</button>
                </div>
                <div data-view-content="date">${byDateHtml}</div>
                <div data-view-content="cat" class="hidden">${byCatHtml}</div>`;
            } else {
                panelHtml = '<p class="text-xs text-gray-400 py-2 text-center">Sem lançamentos</p>';
            }

            html += `
            <div class="border-b border-gray-100 last:border-0">
                <div class="flex justify-between items-center py-3 cursor-pointer select-none person-breakdown-row">
                    <div class="flex items-center gap-2">
                        <div class="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold ${bgCls} ${txtCls}">${initials}</div>
                        <div>
                            <div class="text-sm font-semibold text-gray-800">${label}${isMe ? ' <span class="text-xs text-emerald-500 font-normal">(você)</span>' : ''}</div>
                            <div class="text-xs text-gray-400">${personTxns.length} lançamento${personTxns.length !== 1 ? 's' : ''}${pct > 0 ? ` · ${pct}%` : ''}</div>
                        </div>
                    </div>
                    <div class="flex items-center gap-3">
                        <div class="text-right">
                            ${p.expense > 0 ? `<div class="text-sm font-bold text-red-600">-${this.formatCurrency(p.expense)}</div>` : ''}
                            ${p.income  > 0 ? `<div class="text-sm font-bold text-green-600">+${this.formatCurrency(p.income)}</div>`  : ''}
                        </div>
                        <div class="person-chevron w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 text-xs transition-transform duration-200 flex-shrink-0">▼</div>
                    </div>
                </div>
                ${pct > 0 ? `<div class="w-full bg-gray-100 rounded-full h-1.5 -mt-1 mb-2"><div class="${barColor} h-1.5 rounded-full" style="width:${pct}%"></div></div>` : ''}
                <div class="person-txn-panel hidden bg-emerald-50 rounded-2xl px-3 pt-1 pb-3 mb-2" data-person-email="${p.email}">
                    ${panelHtml}
                </div>
            </div>`;
        }

        bd.innerHTML = html || '<div class="text-gray-400 text-center py-4">Sem dados</div>';

        // Accordion toggle
        bd.querySelectorAll('.person-breakdown-row').forEach(el => {
            el.addEventListener('click', () => {
                const panel   = el.parentElement.querySelector('.person-txn-panel');
                const chevron = el.querySelector('.person-chevron');
                const open    = !panel.classList.contains('hidden');
                panel.classList.toggle('hidden', open);
                chevron.style.transform = open ? '' : 'rotate(180deg)';
            });
        });

        // Toggle de visualização (Por data / Por categoria) dentro do painel
        bd.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const view  = btn.dataset.view;
                const panel = btn.closest('.person-txn-panel');
                if (!panel) return;
                // Alterna botões
                panel.querySelectorAll('.view-btn').forEach(b => {
                    const active = b.dataset.view === view;
                    b.classList.toggle('bg-emerald-500', active);
                    b.classList.toggle('text-white', active);
                    b.classList.toggle('text-gray-500', !active);
                });
                // Alterna conteúdo
                panel.querySelectorAll('[data-view-content]').forEach(c => {
                    c.classList.toggle('hidden', c.dataset.viewContent !== view);
                });
            });
        });

        // Clique em item do painel → abre modal de edição
        bd.querySelectorAll('.person-panel-item').forEach(el => {
            el.addEventListener('click', e => {
                e.stopPropagation();
                const email   = el.closest('.person-txn-panel').dataset.personEmail;
                const allTxns = txnsByPerson[email] || [];
                const t = allTxns.find(x => x.id === el.dataset.id);
                if (t) this.openModal(t);
            });
        });
    },

    // ═══════════════════════════════════════════════════════════════════════
    // ─── 💡 INSIGHTS, METAS E RECONCILIAÇÃO ───────────────────────────────
    // ═══════════════════════════════════════════════════════════════════════

    // ─── Insights & Previsão ──────────────────────────────────────────────────
    async renderInsightsSection(currTxns, prevSummary, trendSummaries) {
        const card = document.getElementById('insights-card');
        const sumEl = document.getElementById('insights-summary');
        const projEl = document.getElementById('insights-projection');
        if (!card || !sumEl) return;

        try {
            // Resumo mensal: compara com mês anterior
            const prevMonth = this.getPrevMonth(this.currentMonth);
            const prevTxns  = await Storage.getTransactions({ month: prevMonth });
            const monthly   = Insights.monthlySummary(currTxns, prevTxns, this.currentMonth, prevMonth);

            if (monthly.sentences.length) {
                sumEl.innerHTML = monthly.sentences.map(s => `<p>• ${this._escHtml(s)}</p>`).join('');
                card.classList.remove('hidden');
            } else {
                sumEl.innerHTML = '<p class="text-gray-400">Sem dados suficientes para comparar.</p>';
                card.classList.remove('hidden');
            }

            // Projeção de fechamento
            const proj = Insights.projectMonthEnd(currTxns, this.currentMonth);
            if (proj.isCurrent && proj.message) {
                const goals = Storage.getGoals();
                const totalGoal = Object.values(goals).reduce((s, v) => s + Number(v || 0), 0);
                let metaTxt = '';
                if (totalGoal > 0) {
                    const overPct = ((proj.projection - totalGoal) / totalGoal) * 100;
                    if (overPct > 5)       metaTxt = ` <span class="text-red-600 font-semibold">(${overPct.toFixed(0)}% acima da meta)</span>`;
                    else if (overPct < -5) metaTxt = ` <span class="text-green-600 font-semibold">(${(-overPct).toFixed(0)}% abaixo da meta)</span>`;
                }
                projEl.innerHTML = `<p>🔮 <strong>Previsão:</strong> ${this._escHtml(proj.message)}${metaTxt}</p>`;
            } else {
                projEl.innerHTML = '';
            }

            // Recorrentes sem lembrete (busca em 6 meses)
            this._renderRecurringSuggestions();
        } catch (e) { console.warn('renderInsightsSection:', e); }
    },

    async _renderRecurringSuggestions() {
        try {
            const months = [];
            let ym = this.currentMonth;
            for (let i = 0; i < 6; i++) { months.push(ym); ym = this.getPrevMonth(ym); }
            const allTxns = (await Promise.all(months.map(m => Storage.getTransactions({ month: m })))).flat();
            const reminders = await Storage.getReminders();
            const recur = Insights.findRecurringWithoutReminder(allTxns, reminders);

            const projEl = document.getElementById('insights-projection');
            if (!projEl) return;
            if (!recur.length) return;

            const rHtml = recur.map((r, i) => `
                <div class="mt-2 bg-white rounded-xl p-2.5 border border-violet-100 flex items-center gap-2">
                    <span class="text-base">🔁</span>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs font-semibold text-gray-700 truncate">${this._escHtml(r.description || r.category || '—')}</p>
                        <p class="text-[10px] text-gray-400">Aparece todo mês ≈ dia ${r.day} · média ${Insights._money(r.avgValue)}</p>
                    </div>
                    <button class="recur-create-btn text-[10px] font-semibold bg-violet-100 text-violet-700 px-2.5 py-1.5 rounded-full"
                            data-name="${this._escHtml(r.description || r.category)}"
                            data-day="${r.day}"
                            data-value="${r.avgValue.toFixed(2)}"
                            data-cat="${this._escHtml(r.category || '')}">Criar lembrete</button>
                </div>
            `).join('');
            projEl.insertAdjacentHTML('beforeend', `<div class="mt-2"><p class="text-xs text-violet-700 font-semibold mt-3 mb-1">🔁 Recorrências sem lembrete:</p>${rHtml}</div>`);

            // Liga handlers de criar lembrete
            projEl.querySelectorAll('.recur-create-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    try {
                        await Storage.createReminder({
                            name:     btn.dataset.name,
                            day:      parseInt(btn.dataset.day),
                            amount:   parseFloat(btn.dataset.value),
                            category: btn.dataset.cat || 'Outros',
                            type:     'saida',
                            emoji:    '🔔',
                        });
                        this.showToast('✅ Lembrete criado!');
                        await this.loadReminders();
                        await this.renderSummary();
                    } catch (err) { this.showToast('❌ Erro ao criar lembrete', true); }
                });
            });
        } catch (e) { console.warn('_renderRecurringSuggestions:', e); }
    },

    // ─── Metas ────────────────────────────────────────────────────────────────
    renderGoalsSection(currTxns) {
        const goals = Storage.getGoals();
        const listEl     = document.getElementById('goals-list');
        const alertsEl   = document.getElementById('goals-alerts');
        const suggestBtn = document.getElementById('goals-suggest-btn');
        if (!listEl) return;

        const goalEntries = Object.entries(goals);

        // Alertas (apenas mês atual)
        const alerts = Insights.goalAlerts(currTxns, goals, this.currentMonth);
        alertsEl.innerHTML = alerts.map(a => {
            const colors = a.level === 'danger'    ? 'bg-red-50 border-red-200 text-red-700'
                         : a.level === 'warning'   ? 'bg-orange-50 border-orange-200 text-orange-700'
                         :                           'bg-yellow-50 border-yellow-200 text-yellow-700';
            const icon   = a.level === 'danger' ? '🚨' : a.level === 'warning' ? '⚠️' : '📈';
            return `<div class="${colors} border rounded-xl p-2.5 text-xs">${icon} ${this._escHtml(a.message)}</div>`;
        }).join('');

        // Lista de metas com barra de progresso
        if (!goalEntries.length) {
            listEl.innerHTML = '<p class="text-xs text-gray-400 text-center py-2">Nenhuma meta definida.</p>';
            suggestBtn.classList.remove('hidden');
        } else {
            const expByCat = Insights._expenseByCategory(currTxns);
            listEl.innerHTML = goalEntries.map(([cat, limit]) => {
                const spent = expByCat[cat] || 0;
                const pct   = Math.min(100, (spent / limit) * 100);
                const barColor = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-orange-500' : 'bg-emerald-500';
                const txtColor = pct >= 100 ? 'text-red-600' : pct >= 80 ? 'text-orange-600' : 'text-emerald-700';
                return `<div>
                    <div class="flex justify-between items-center text-xs mb-1">
                        <span class="font-medium text-gray-700">${this._escHtml(cat)}</span>
                        <span class="${txtColor} font-semibold">${Insights._money(spent)} / ${Insights._money(limit)}</span>
                    </div>
                    <div class="bg-gray-100 rounded-full h-1.5"><div class="${barColor} h-1.5 rounded-full" style="width:${pct}%"></div></div>
                </div>`;
            }).join('');
            suggestBtn.classList.remove('hidden');
        }
    },

    // Sugere metas pelo histórico (mediana dos últimos 3 meses)
    async suggestAndApplyGoals() {
        try {
            const history = await Storage.getHistoryByMonth(3);
            const suggested = Insights.suggestGoals(history);
            if (!Object.keys(suggested).length) {
                this.showToast('Histórico insuficiente para sugerir metas (precisa ≥ 2 meses)', true, 4000);
                return;
            }
            // Funde com metas existentes (não sobrescreve as já definidas)
            const current = Storage.getGoals();
            const merged = { ...suggested, ...current };
            Storage.setGoals(merged);
            this.showToast(`✨ ${Object.keys(suggested).length} meta${Object.keys(suggested).length !== 1 ? 's' : ''} sugerida${Object.keys(suggested).length !== 1 ? 's' : ''} com base no histórico`, false, 3500);
            await this.renderSummary();
        } catch (e) { this.showToast('❌ Erro ao sugerir metas', true); }
    },

    openGoalsModal() {
        const modal = document.getElementById('goals-modal');
        const list  = document.getElementById('goals-modal-list');
        if (!modal || !list) return;
        const goals = Storage.getGoals();
        const cats  = this.categories || [];
        list.innerHTML = cats.map(c => {
            const val = goals[c.name] || '';
            return `<div class="flex items-center gap-2">
                <span class="text-lg">${c.emoji || '📦'}</span>
                <span class="flex-1 text-sm text-gray-700">${this._escHtml(c.name)}</span>
                <div class="flex items-center gap-1">
                    <span class="text-xs text-gray-400">R$</span>
                    <input type="number" inputmode="decimal" class="goal-input w-24 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-right" placeholder="0" value="${val}" data-cat="${this._escHtml(c.name)}">
                </div>
            </div>`;
        }).join('');
        modal.classList.remove('hidden');
    },

    saveGoalsModal() {
        const inputs = document.querySelectorAll('#goals-modal-list .goal-input');
        const goals = {};
        for (const inp of inputs) {
            const v = parseFloat(inp.value);
            if (!isNaN(v) && v > 0) goals[inp.dataset.cat] = v;
        }
        Storage.setGoals(goals);
        document.getElementById('goals-modal').classList.add('hidden');
        this.showToast('✅ Metas atualizadas');
        this.renderSummary();
    },

    // ─── Reconciliação ────────────────────────────────────────────────────────
    async renderReconcileSection(monthTxns) {
        const card = document.getElementById('reconcile-card');
        const list = document.getElementById('reconcile-list');
        if (!card || !list) return;

        const dupes = Insights.findDuplicates(monthTxns);

        // Parcelas faltantes — varre 12 meses
        const months = [];
        let ym = this.currentMonth;
        for (let i = 0; i < 12; i++) { months.push(ym); ym = this.getPrevMonth(ym); }
        const allTxns = (await Promise.all(months.map(m => Storage.getTransactions({ month: m })))).flat();
        const missing = Insights.findMissingInstallments(allTxns);

        // Mal categorizadas (no mês atual)
        const miscategorized = Insights.findMiscategorized(monthTxns, (text) => NLP.extractCategoryStatic(text));

        const blocks = [];

        if (dupes.length) {
            const dupHtml = dupes.map(group => `
                <div class="bg-yellow-50 border border-yellow-200 rounded-xl p-2.5">
                    <p class="font-semibold text-yellow-800 mb-1">🔁 ${group.length} lançamentos similares em ${group[0].date}</p>
                    ${group.map(t => `
                        <div class="flex items-center justify-between mt-1">
                            <span class="text-gray-700 truncate">${this._escHtml(t.description || t.category || '')}</span>
                            <span class="font-semibold text-red-600 ml-2">${Insights._money(t.value)}</span>
                        </div>
                    `).join('')}
                    <button class="dupe-del-btn mt-2 w-full text-[10px] font-semibold bg-red-500 text-white py-1.5 rounded-lg" data-ids="${group.slice(1).map(t => t.id).join(',')}">
                        Remover ${group.length - 1} duplicata${group.length - 1 > 1 ? 's' : ''}
                    </button>
                </div>
            `).join('');
            blocks.push(dupHtml);
        }

        if (missing.length) {
            const missHtml = missing.map(m => `
                <div class="bg-orange-50 border border-orange-200 rounded-xl p-2.5">
                    <p class="font-semibold text-orange-800 mb-1">📦 Parcela faltando: ${this._escHtml(m.description || '')}</p>
                    <p class="text-gray-600">${m.missing.length} de ${m.total} parcelas não foram lançadas</p>
                    <p class="text-[10px] text-gray-500">Faltando: ${m.missing.map(g => `${g.num}/${m.total}`).join(', ')}</p>
                    <button class="miss-create-btn mt-2 w-full text-[10px] font-semibold bg-orange-500 text-white py-1.5 rounded-lg"
                            data-group="${m.group_id}">Criar parcelas faltantes</button>
                </div>
            `).join('');
            blocks.push(missHtml);
        }

        if (miscategorized.length) {
            blocks.push(`<button id="open-recat-btn" class="w-full bg-violet-50 border border-violet-200 text-violet-700 rounded-xl p-2.5 text-left font-semibold">
                🤖 ${miscategorized.length} lançamento${miscategorized.length !== 1 ? 's' : ''} podem estar mal categorizado${miscategorized.length !== 1 ? 's' : ''} — revisar
            </button>`);
        }

        list.innerHTML = blocks.join('');
        if (blocks.length) card.classList.remove('hidden');
        else card.classList.add('hidden');

        // Handlers
        this._miscategorizedCache = miscategorized;
        this._missingInstallmentsCache = missing;

        list.querySelectorAll('.dupe-del-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Remover duplicatas?')) return;
                const ids = btn.dataset.ids.split(',').filter(Boolean);
                for (const id of ids) {
                    try { await Storage.deleteTransaction(id); } catch (_) {}
                }
                this.showToast(`✅ ${ids.length} duplicata${ids.length !== 1 ? 's' : ''} removida${ids.length !== 1 ? 's' : ''}`);
                await this.renderCurrentTab();
            });
        });

        list.querySelectorAll('.miss-create-btn').forEach(btn => {
            btn.addEventListener('click', () => this._createMissingInstallments(btn.dataset.group));
        });

        document.getElementById('open-recat-btn')?.addEventListener('click', () => this.openRecategorizeModal());
    },

    async _createMissingInstallments(groupId) {
        const m = this._missingInstallmentsCache?.find(x => x.group_id === groupId);
        if (!m) return;
        if (!confirm(`Criar ${m.missing.length} parcela(s) faltante(s) de "${m.description}"?`)) return;
        let created = 0;
        for (const gap of m.missing) {
            try {
                await Storage.addTransaction({
                    value: m.value,
                    type: m.type,
                    category: m.category,
                    description: `${m.description.replace(/\s*\(\d+\/\d+\)\s*$/, '')} (${gap.num}/${m.total})`,
                    date: gap.expectedDate,
                    notes: 'Criado via reconciliação',
                    installment_group_id: groupId,
                    installment_current: gap.num,
                    installment_total: m.total,
                });
                created++;
            } catch (_) {}
        }
        this.showToast(`✅ ${created} parcela${created !== 1 ? 's' : ''} criada${created !== 1 ? 's' : ''}`);
        await this.renderCurrentTab();
    },

    openRecategorizeModal() {
        const items = this._miscategorizedCache || [];
        if (!items.length) return;
        const modal = document.getElementById('recat-modal');
        const list  = document.getElementById('recat-modal-list');
        list.innerHTML = items.map((it, i) => `
            <label class="flex items-start gap-2 bg-gray-50 rounded-xl p-2.5 cursor-pointer">
                <input type="checkbox" class="recat-check mt-1" data-idx="${i}" checked>
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-semibold text-gray-800 truncate">${this._escHtml(it.tx.description)}</p>
                    <p class="text-[11px] text-gray-500">${Insights._money(it.tx.value)} · ${it.tx.date || ''}</p>
                    <p class="text-xs mt-1">
                        <span class="text-gray-400 line-through">${this._escHtml(it.current)}</span>
                        <span class="text-violet-600 font-semibold">→ ${this._escHtml(it.suggested)}</span>
                    </p>
                </div>
            </label>
        `).join('');
        modal.classList.remove('hidden');
    },

    async applyRecategorize() {
        const items   = this._miscategorizedCache || [];
        const checked = document.querySelectorAll('#recat-modal-list .recat-check:checked');
        let updated = 0;
        for (const cb of checked) {
            const it = items[parseInt(cb.dataset.idx)];
            if (!it) continue;
            try {
                await Storage.updateTransaction(it.tx.id, { category: it.suggested });
                updated++;
            } catch (_) {}
        }
        document.getElementById('recat-modal').classList.add('hidden');
        this.showToast(`✅ ${updated} lançamento${updated !== 1 ? 's' : ''} recategorizado${updated !== 1 ? 's' : ''}`);
        await this.renderCurrentTab();
    },

    // ─── Comandos compostos por voz ───────────────────────────────────────────
    handleCompoundCommand(text) {
        const segments = NLP.splitCompoundCommand(text);
        if (segments.length <= 1) return false; // não é composto
        const parsedList = segments.map(s => NLP.parse(s));
        // Só vale a pena se ≥2 segmentos tiverem valor
        const validCount = parsedList.filter(p => p.value && p.value > 0).length;
        if (validCount < 2) return false;

        this._compoundDraft = parsedList;
        this._renderCompoundModal();
        return true;
    },

    _renderCompoundModal() {
        const modal = document.getElementById('compound-modal');
        const list  = document.getElementById('compound-modal-list');
        list.innerHTML = this._compoundDraft.map((p, i) => `
            <div class="bg-gray-50 rounded-xl p-2.5">
                <div class="flex items-center gap-2 mb-1">
                    <span class="text-xs font-semibold text-indigo-600">#${i + 1}</span>
                    <span class="text-xs text-gray-500 truncate flex-1">"${this._escHtml(p.original || '')}"</span>
                </div>
                <div class="grid grid-cols-2 gap-1.5 text-xs">
                    <div><span class="text-gray-400">Descrição:</span> <strong>${this._escHtml(p.description || '—')}</strong></div>
                    <div><span class="text-gray-400">Valor:</span> <strong class="text-red-600">${p.value ? Insights._money(p.value) : '—'}</strong></div>
                    <div><span class="text-gray-400">Categoria:</span> <strong>${this._escHtml(p.category || 'Outros')}</strong></div>
                    <div><span class="text-gray-400">Tipo:</span> <strong>${p.type === 'entrada' ? 'Entrada' : 'Saída'}</strong></div>
                </div>
            </div>
        `).join('');
        modal.classList.remove('hidden');
    },

    async saveCompoundCommand() {
        const drafts = this._compoundDraft || [];
        let saved = 0;
        const todayStr = new Date().toISOString().slice(0, 10);
        for (const p of drafts) {
            if (!p.value || p.value <= 0) continue;
            try {
                await Storage.addTransaction({
                    value:       p.value,
                    type:        p.type || 'saida',
                    category:    p.category || 'Outros',
                    description: p.description || 'Sem descrição',
                    date:        p.date || todayStr,
                    notes:       'Voz (composto)',
                });
                saved++;
            } catch (_) {}
        }
        document.getElementById('compound-modal').classList.add('hidden');
        this._compoundDraft = null;
        this.showToast(`✅ ${saved} lançamento${saved !== 1 ? 's' : ''} criado${saved !== 1 ? 's' : ''}!`);
        await this.renderCurrentTab();
    },

    // Liga handlers das modais e botões (chamado no init)
    bindInsightsHandlers() {
        document.getElementById('goals-edit-btn')?.addEventListener('click', () => this.openGoalsModal());
        document.getElementById('goals-modal-close')?.addEventListener('click', () => document.getElementById('goals-modal').classList.add('hidden'));
        document.getElementById('goals-modal-save')?.addEventListener('click', () => this.saveGoalsModal());
        document.getElementById('goals-suggest-btn')?.addEventListener('click', () => this.suggestAndApplyGoals());
        document.getElementById('recat-modal-close')?.addEventListener('click', () => document.getElementById('recat-modal').classList.add('hidden'));
        document.getElementById('recat-modal-cancel')?.addEventListener('click', () => document.getElementById('recat-modal').classList.add('hidden'));
        document.getElementById('recat-modal-apply')?.addEventListener('click', () => this.applyRecategorize());
        document.getElementById('compound-modal-close')?.addEventListener('click', () => document.getElementById('compound-modal').classList.add('hidden'));
        document.getElementById('compound-modal-cancel')?.addEventListener('click', () => {
            document.getElementById('compound-modal').classList.add('hidden');
            this._compoundDraft = null;
        });
        document.getElementById('compound-modal-save')?.addEventListener('click', () => this.saveCompoundCommand());
    },

    // ─── Custom Types Chart ───────────────────────────────────────────────────
    renderCustomTypesChart(txns) {
        const wrap = document.getElementById('custom-types-chart-wrap');
        if (!wrap) return;

        // Usa todos os tipos de todos os perfis para encontrar lançamentos com tipos customizados
        const customs = Storage.getAllCustomTypesForChart();
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
        document.getElementById('export-excel-btn')?.addEventListener('click',  () => this.exportExcel());
        document.getElementById('export-pdf-btn')?.addEventListener('click',    () => this.exportPDF());
        document.getElementById('export-backup-btn')?.addEventListener('click', () => this.exportFullBackup());
    },

    async exportExcel() {
        const btn = document.getElementById('export-excel-btn');
        btn.disabled = true; btn.textContent = 'Gerando...';
        try {
            const transactions = await Storage.getTransactions({ month: this.currentMonth });
            const summary      = await Storage.getSummary(this.currentMonth);

            // Sheet 1: transactions
            const rows = transactions.map(t => {
                const beh = Storage.getBehavior(t.type);
                return {
                    'Data':         t.date,
                    'Tipo':         this._resolveTypeName(t.type),
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
                    const beh  = Storage.getBehavior(t.type);
                    const sign = beh === 'soma' ? '+' : beh === 'subtrai' ? '-' : '±';
                    return [t.date, this._resolveTypeName(t.type), t.category, t.description, sign + this.formatCurrency(Number(t.value)), t.inserted_by_email || ''];
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

    // ─── Full Backup Export ───────────────────────────────────────────────────
    async exportFullBackup() {
        const btn = document.getElementById('export-backup-btn');
        btn.disabled = true; btn.textContent = 'Gerando backup...';
        try {
            const financa = this.activeFinanca;
            const fname   = financa?.name || 'Pessoal';
            const today   = new Date().toISOString().slice(0, 10);

            // 1. Todos os lançamentos (sem filtro de mês)
            const allTxns = await Storage.getTransactions({});
            const txRows  = allTxns.map(t => {
                const beh = Storage.getBehavior(t.type);
                return {
                    'Data':            t.date,
                    'Tipo':            this._resolveTypeName(t.type),
                    'Categoria':       t.category,
                    'Descrição':       t.description,
                    'Valor (R$)':      beh === 'soma' ? Number(t.value) : beh === 'subtrai' ? -Number(t.value) : Number(t.value),
                    'Inserido por':    t.inserted_by_email || '',
                    'ID Lembrete':     t.reminder_id || '',
                    'ID':              t.id,
                    'Criado em':       t.created_at || ''
                };
            });

            // 2. Resumo mensal
            const months = [...new Set(allTxns.map(t => t.date?.slice(0, 7)).filter(Boolean))].sort();
            const monthSummaries = await Promise.all(months.map(async m => {
                const s = await Storage.getSummary(m);
                return {
                    'Mês':         m,
                    'Entradas (R$)': s.income,
                    'Saídas (R$)':   s.expense,
                    'Saldo (R$)':    s.balance
                };
            }));

            // 3. Categorias
            const catRows = this.categories.map(c => ({
                'Nome':       c.name,
                'Emoji':      c.emoji,
                'Tipo':       c.type,
                'Palavras-chave': (c.keywords || []).join(', ')
            }));

            // 4. Lembretes
            const remRows = this.reminders.map(r => ({
                'Nome':       r.name,
                'Emoji':      r.emoji,
                'Dia':        r.day,
                'Valor (R$)': r.amount || 0,
                'Categoria':  r.category || '',
                'Tipo':       this._resolveTypeName(r.type),
                'Ativo':      r.active !== false ? 'Sim' : 'Não'
            }));

            // 5. Info do perfil
            const infoRows = [
                { 'Campo': 'Nome',           'Valor': financa?.name  || 'Pessoal' },
                { 'Campo': 'Tipo',           'Valor': financa?.type  || 'individual' },
                { 'Campo': 'Emoji',          'Valor': financa?.emoji || '💰' },
                { 'Campo': 'Data do backup', 'Valor': today },
                { 'Campo': 'Total lançamentos', 'Valor': allTxns.length },
                { 'Campo': 'Total categorias',  'Valor': this.categories.length },
                { 'Campo': 'Total lembretes',   'Valor': this.reminders.length }
            ];

            // Monta o workbook com todas as abas
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(txRows.length        ? txRows        : [{ '': 'Sem dados' }]), 'Lançamentos');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(monthSummaries.length ? monthSummaries : [{ '': 'Sem dados' }]), 'Resumo Mensal');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(catRows.length        ? catRows        : [{ '': 'Sem dados' }]), 'Categorias');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(remRows.length        ? remRows        : [{ '': 'Sem dados' }]), 'Lembretes');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(infoRows),                                                       'Info');

            const safeName = fname.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            XLSX.writeFile(wb, `backup_${safeName}_${today}.xlsx`);
            this.showToast(`✅ Backup exportado — ${allTxns.length} lançamentos`);
        } catch (e) {
            this.showToast('❌ Erro ao gerar backup: ' + e.message, true);
        } finally {
            btn.disabled = false; btn.textContent = '📦 Backup completo';
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
        dropzone?.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('border-emerald-500', 'bg-emerald-50'); });
        dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('border-emerald-500', 'bg-emerald-50'));
        dropzone?.addEventListener('drop', e => {
            e.preventDefault();
            dropzone.classList.remove('border-emerald-500', 'bg-emerald-50');
            if (e.dataTransfer.files[0]) this.handleImportFile(e.dataTransfer.files[0]);
        });
        fileInput?.addEventListener('change', e => { if (e.target.files[0]) this.handleImportFile(e.target.files[0]); });

        document.getElementById('import-download-template')?.addEventListener('click', () => this.downloadImportTemplate());
        document.getElementById('import-back')?.addEventListener('click', () => this.importShowStep(1));
        document.getElementById('import-confirm')?.addEventListener('click', () => this.confirmImport());

        // Botão trocar perfil no import
        document.getElementById('import-change-financa-btn')?.addEventListener('click', () => {
            this.openFinancaSelectModal(selectedId => {
                this._importFinancaId = selectedId;
                const f = selectedId ? this.financas.find(x => x.id === selectedId) : null;
                document.getElementById('import-financa-emoji').textContent = f?.emoji || this.activeFinanca?.emoji || '💰';
                document.getElementById('import-financa-name').textContent  = f?.name  || this.activeFinanca?.name  || 'Pessoal';
                document.getElementById('import-financa-type').textContent  =
                    (f?.type || this.activeFinanca?.type) === 'compartilhada' ? '👥 Compartilhada' : '👤 Individual';
            });
        });
    },

    openImportModal() {
        document.getElementById('import-modal').classList.remove('hidden');
        this._importFinancaId = null; // reseta ao abrir
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
                <select id="import-map-${field}" class="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-emerald-500">
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
            const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            const v = norm(raw);
            // 1. Tipos customizados (verificados primeiro para não confundir com fixos)
            for (const ct of Storage.getCustomTypes()) {
                const ctv = norm(ct.name);
                if (ctv.length >= 2 && (v === ctv || v.includes(ctv) || ctv.includes(v))) return ct.id;
            }
            // 2. Tipos fixos
            if (['entrada','credito','credit','receita','income'].some(k => v.includes(k))) return 'entrada';
            if (['saida','debito','debit','despesa','expense','gasto'].some(k => v.includes(k))) return 'saida';
        }
        return 'saida'; // fallback seguro — não adivinha pelo sinal do valor
    },

    _getMapping() {
        const get = f => document.getElementById(`import-map-${f}`)?.value || '(ignorar)';
        return { date: get('date'), type: get('type'), category: get('category'), description: get('description'), value: get('value'), inserter: get('inserter') };
    },

    _rowToTransaction(row, map) {
        const col = name => name === '(ignorar)' ? '' : row[this._importColumns.indexOf(name)] ?? '';
        const rawVal  = this._parseImportValue(col(map.value));
        const absVal  = Math.abs(rawVal);
        const rawType = String(col(map.type) || '').trim();
        const type    = this._parseImportType(rawType, rawVal);
        const inserter = String(col(map.inserter) || '').trim();
        return {
            date:        this._parseImportDate(col(map.date)),
            type,
            _rawType:    rawType,
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
            const beh    = Storage.getBehavior(t.type);
            const tColor = beh === 'soma' ? 'text-green-600' : beh === 'subtrai' ? 'text-red-600' : 'text-gray-500';
            const tArrow = beh === 'soma' ? '↓' : beh === 'subtrai' ? '↑' : '±';
            const tName  = (() => {
                // Se é um tipo customizado já cadastrado, mostra o nome resolvido
                if (t.type !== 'saida' && t.type !== 'entrada') return this._resolveTypeName(t.type);
                // Se tem rawType e NÃO é palavra-chave de saída/entrada padrão, mostra o nome bruto
                if (t._rawType) {
                    const n = t._rawType.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
                    const isStdSaida   = ['saida','debito','debit','despesa','expense','gasto'].some(k => n.includes(k));
                    const isStdEntrada = ['entrada','credito','credit','receita','income'].some(k => n.includes(k));
                    if (!isStdSaida && !isStdEntrada) return t._rawType; // ex: "Nubank", "Cartão"
                }
                return this._resolveTypeName(t.type);
            })();
            return `<tr class="${i % 2 === 0 ? '' : 'bg-gray-50'}">
                <td class="px-2 py-1.5 text-gray-700">${t.date}</td>
                <td class="px-2 py-1.5 ${tColor}">${tArrow} ${tName}</td>
                <td class="px-2 py-1.5 text-gray-700">${t.category}</td>
                <td class="px-2 py-1.5 text-gray-500 max-w-[80px] truncate">${t.description}</td>
                <td class="px-2 py-1.5 text-right font-medium ${tColor}">${this.formatCurrency(t.value)}</td>
                <td class="px-2 py-1.5 text-gray-400 text-xs truncate max-w-[80px]">${inserterDisplay}</td>
            </tr>`;
        }).join('');

        const more = txns.length - shown.length;
        document.getElementById('import-more').textContent = more > 0 ? `+ ${more} lançamento${more > 1 ? 's' : ''} não exibido${more > 1 ? 's' : ''}` : '';

        // Store for confirm
        this._importParsed = txns;

        // Aviso de tipos novos que serão criados automaticamente
        const newTypesWrap = document.getElementById('import-new-types');
        if (newTypesWrap) {
            const normStr = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
            const knownTypeNorms = new Set([
                ...Storage.getCustomTypes().map(t => normStr(t.name)),
                'entrada', 'saida'
            ]);
            const newTypeNames = [...new Set(
                txns.map(t => t._rawType).filter(raw => {
                    if (!raw) return false;
                    const n = normStr(raw);
                    if (['entrada','credito','receita','income'].some(k => n.includes(k))) return false;
                    if (['saida','debito','despesa','expense','gasto'].some(k => n.includes(k))) return false;
                    return !knownTypeNorms.has(n);
                })
            )];
            if (newTypeNames.length) {
                newTypesWrap.classList.remove('hidden');
                document.getElementById('import-new-types-list').textContent = newTypeNames.join(', ');
            } else {
                newTypesWrap.classList.add('hidden');
            }
        }

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
                this.categories = this._sortCategories(this.categories);
                NLP.setCategoryMap(this.categories);
                this.renderCategorySelect();
                this.renderQuickButtons();
            }

            // Auto-criar tipos customizados não reconhecidos
            const normStr = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
            const fixedIds = new Set(['entrada', 'saida']);
            const knownTypeNorms = new Set([
                ...Storage.getCustomTypes().map(t => normStr(t.name)),
                ...Storage.getCustomTypes().map(t => t.id)
            ]);
            const unknownTypeNames = [...new Set(
                txns.map(t => t._rawType).filter(raw => {
                    if (!raw) return false;
                    const n = normStr(raw);
                    if (fixedIds.has(n)) return false;
                    if (['entrada','credito','receita','income'].some(k => n.includes(k))) return false;
                    if (['saida','debito','despesa','expense','gasto'].some(k => n.includes(k))) return false;
                    return !knownTypeNorms.has(n);
                })
            )];
            if (unknownTypeNames.length) {
                btn.textContent = `Criando ${unknownTypeNames.length} tipo${unknownTypeNames.length > 1 ? 's' : ''}...`;
                const typeEmojis = ['🏷️','💳','📋','🔖','📌','💡','🗂️','📁'];
                const typeColors = ['gray','purple','teal','orange','indigo','pink','yellow'];
                for (let i = 0; i < unknownTypeNames.length; i++) {
                    const name = unknownTypeNames[i];
                    try {
                        const ct = await Storage.createTransactionType(name, 'subtrai', typeEmojis[i % typeEmojis.length], typeColors[i % typeColors.length]);
                        // Remapeia transações para usar o novo ID
                        const nName = normStr(name);
                        for (const t of txns) {
                            if (t._rawType && normStr(t._rawType) === nName) t.type = ct.id;
                        }
                    } catch (_) {}
                }
                this.transactionTypes = await Storage.getTransactionTypes();
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
            // Se o usuário trocou o perfil no import, sobrescreve temporariamente
            const prevFinancaId = Storage.activeFinancaId;
            if (this._importFinancaId !== null && this._importFinancaId !== undefined) {
                Storage.activeFinancaId = this._importFinancaId;
            }
            await Storage.bulkAddTransactions(txns);
            Storage.activeFinancaId = prevFinancaId; // restaura
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

    // ─── Notificação persistente "Novo Lançamento" ────────────────────────────
    async _setupQuickAddNotification() {
        if (!('serviceWorker' in navigator) || !('Notification' in window)) return;

        // Pede permissão se ainda não concedida
        let perm = Notification.permission;
        if (perm === 'default') perm = await Notification.requestPermission();
        if (perm !== 'granted') return;

        // Mostra agora e re-mostra toda vez que o app voltar ao foco
        await this._showQuickAddNotification();

        document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState !== 'visible') return;
            // Verifica se a notificação ainda existe; se não, recria
            try {
                const reg   = await navigator.serviceWorker.ready;
                const notifs = await reg.getNotifications({ tag: 'quick-add' });
                if (!notifs.length) await this._showQuickAddNotification();
            } catch (_) {}
        });

        window.addEventListener('focus', async () => {
            try {
                const reg   = await navigator.serviceWorker.ready;
                const notifs = await reg.getNotifications({ tag: 'quick-add' });
                if (!notifs.length) await this._showQuickAddNotification();
            } catch (_) {}
        });
    },

    async _showQuickAddNotification() {
        try {
            const reg = await navigator.serviceWorker.ready;
            await reg.showNotification('💰 Minhas Carteiras', {
                body:               'Toque para adicionar um novo lançamento',
                icon:               '/financas-casa/icon.svg',
                badge:              '/financas-casa/icon.svg',
                tag:                'quick-add',
                renotify:           false,
                silent:             true,
                requireInteraction: false,
                data:               { action: 'new-transaction' },
                actions:            [{ action: 'new-transaction', title: '➕ Novo Lançamento' }],
            });
        } catch (_) {}
    },

    // ─── Escuta mensagens do Service Worker ───────────────────────────────────
    _bindSwMessages() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.addEventListener('message', event => {
            const action = event.data?.action;
            if (action === 'new-transaction') {
                // Pequeno delay para a janela estar em foco
                setTimeout(() => {
                    if (document.getElementById('modal-overlay')?.classList.contains('hidden')) {
                        this.openModal();
                    }
                }, 200);
            } else if (action === 'open-reminders') {
                setTimeout(() => this.openRemindersModal(), 200);
            }
        });
    },

    // ─── Handler de URL action ────────────────────────────────────────────────
    _handleUrlAction() {
        const params = new URLSearchParams(window.location.search);
        const action = params.get('action');
        if (action === 'new-transaction') {
            // Limpa o parâmetro da URL sem recarregar
            const clean = window.location.pathname;
            window.history.replaceState({}, '', clean);
            // Aguarda a UI estar pronta e abre o modal
            setTimeout(() => this.openModal(), 400);
        } else if (action === 'open-reminders') {
            const clean = window.location.pathname;
            window.history.replaceState({}, '', clean);
            setTimeout(() => this.openRemindersModal(), 400);
        }
    },

    // ─── Atalho volume-down × 3 → novo lançamento ────────────────────────────
    bindVolumeShortcut() {
        let count = 0;
        let timer = null;

        const showHint = (remaining) => {
            let el = document.getElementById('volume-shortcut-hint');
            if (!el) {
                el = document.createElement('div');
                el.id = 'volume-shortcut-hint';
                el.style.cssText = [
                    'position:fixed','bottom:90px','left:50%',
                    'transform:translateX(-50%)',
                    'background:rgba(0,0,0,0.75)','color:#fff',
                    'font-size:13px','font-weight:600',
                    'padding:8px 18px','border-radius:999px',
                    'z-index:9999','pointer-events:none',
                    'transition:opacity .3s',
                ].join(';');
                document.body.appendChild(el);
            }
            el.textContent = remaining > 0
                ? `🔉 +${remaining} para novo lançamento`
                : '✅ Abrindo lançamento...';
            el.style.opacity = '1';
            clearTimeout(el._hide);
            el._hide = setTimeout(() => { el.style.opacity = '0'; }, 1200);
        };

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'AudioVolumeDown' && e.key !== 'VolumeDown') return;

            count++;
            clearTimeout(timer);

            if (count === 3) {
                count = 0;
                showHint(0);
                setTimeout(() => {
                    if (!document.getElementById('modal-overlay')?.classList.contains('hidden')) return;
                    this.openModal();
                }, 300);
                return;
            }

            showHint(3 - count);

            // Reset se o usuário demorar mais de 1,5s entre pressões
            timer = setTimeout(() => { count = 0; }, 1500);
        });
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
        // Aguarda até 3 s para navigator.onLine ser confiável (race condition do evento "online")
        if (!navigator.onLine) {
            await new Promise(r => setTimeout(r, 800));
            if (!navigator.onLine) return; // ainda offline — desiste
        }

        const pending = Storage.pendingCount();
        if (pending > 0) {
            this.updateOfflineBar();
            this.showToast(`🔄 Sincronizando ${pending} lançamento${pending > 1 ? 's' : ''}...`);
            const result = await Storage.syncPendingOps();
            if (result.synced > 0) {
                this.showToast(`✅ ${result.synced} lançamento${result.synced > 1 ? 's sincronizados' : ' sincronizado'}!`);
                await this.renderCurrentTab();
            }
            if (result.failed > 0) {
                this.showToast(`⚠️ ${result.failed} lançamento${result.failed > 1 ? 's' : ''} não sincronizado${result.failed > 1 ? 's' : ''} — tente novamente`, true);
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

    // Escapa caracteres HTML perigosos em texto puro
    _escHtml(str) {
        return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    },

    // Destaca todas as ocorrências de `query` em `str` (case-insensitive)
    _hlText(str, query) {
        if (!str || !query) return this._escHtml(str);
        const safe  = this._escHtml(str);
        const safeQ = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return safe.replace(new RegExp(`(${safeQ})`, 'gi'),
            '<mark class="bg-yellow-200 text-yellow-900 rounded-sm px-0.5 not-italic">$1</mark>');
    },

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
    _sortCategories(cats) {
        return [...cats].sort((a, b) => {
            if (a.name === 'Outros') return 1;
            if (b.name === 'Outros') return -1;
            return a.name.localeCompare(b.name, 'pt-BR');
        });
    },

    async loadCategories() {
        try {
            const raw = await Storage.getCategories();
            // Remove duplicatas pelo nome (case-insensitive), mantém a primeira ocorrência
            const seen = new Set();
            const deduped = raw.filter(c => {
                const key = (c.name || '').trim().toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            this.categories = this._sortCategories(deduped);
        } catch (e) {
            console.warn('loadCategories:', e);
            this.categories = [];
        }
        // Segurança: nunca deixa sem categorias (iOS ITP / rede instável / cache vazio)
        if (!this.categories.length) {
            this.categories = this._sortCategories([...Storage.defaultCategories]);
        }
        NLP.setCategoryMap(this.categories);
        this.renderCategorySelect();
        this.renderQuickButtons();
    },

    // ── Nova categoria inline no modal de lançamento ─────────────────────────
    async _saveModalNewCategory() {
        const name  = document.getElementById('modal-cat-name-input')?.value.trim();
        const emoji = document.getElementById('modal-cat-emoji-input')?.value.trim() || '📦';
        if (!name) { document.getElementById('modal-cat-name-input')?.focus(); return; }

        const btn = document.getElementById('modal-cat-save-btn');
        btn.disabled = true; btn.textContent = 'Criando...';
        try {
            const cat = await Storage.createCategory(name, emoji, [], 'saida');
            // Atualiza lista local de categorias (ou _modalCategories se perfil diferente)
            if (this._modalCategories) {
                this._modalCategories.push(cat);
                this._modalCategories = this._sortCategories(this._modalCategories);
            } else {
                this.categories.push(cat);
                this.categories = this._sortCategories(this.categories);
            }
            NLP.setCategoryMap(this.categories);
            this.renderCategorySelect(name); // seleciona a nova categoria
            // Fecha e limpa painel
            document.getElementById('modal-new-cat-panel').classList.add('hidden');
            document.getElementById('modal-cat-name-input').value  = '';
            document.getElementById('modal-cat-emoji-input').value = '📦';
            document.getElementById('modal-cat-emoji-btn').textContent = '📦';
            this.showToast(`✅ Categoria "${name}" criada!`);
        } catch (e) {
            const msg = e.message || '';
            if (msg.includes('duplicate') || msg.includes('unique') || msg.includes('already exists')) {
                this.showToast('⚠️ Já existe uma categoria com esse nome.', true);
            } else {
                this.showToast('❌ Erro: ' + msg, true);
            }
        } finally {
            btn.disabled = false; btn.textContent = 'Criar';
        }
    },

    _buildModalCatEmojiPicker() {
        const grid = document.getElementById('modal-cat-emoji-grid');
        if (!grid || grid.dataset.built) return;
        grid.dataset.built = '1';
        grid.innerHTML = this._emojiPickerGroups.map(g =>
            `<div class="col-span-8 text-xs font-semibold text-gray-400 mt-1.5 mb-0.5 px-0.5">${g.label}</div>` +
            g.emojis.map(e =>
                `<button type="button" data-emoji="${e}" class="text-xl p-0.5 rounded-lg hover:bg-emerald-50 transition-colors leading-none">${e}</button>`
            ).join('')
        ).join('');
        grid.addEventListener('click', e => {
            const btn = e.target.closest('[data-emoji]');
            if (!btn) return;
            document.getElementById('modal-cat-emoji-input').value    = btn.dataset.emoji;
            document.getElementById('modal-cat-emoji-btn').textContent = btn.dataset.emoji;
            document.getElementById('modal-cat-emoji-picker').classList.add('hidden');
        });
    },

    renderCategorySelect(selectedVal) {
        const sel = document.getElementById('modal-category');
        if (!sel) return;
        const current = selectedVal ?? sel.value ?? 'Outros';
        // Usa categorias do perfil escolhido no modal; [] vazio cai para o perfil ativo
        const cats = (this._modalCategories?.length) ? this._modalCategories : this.categories;
        sel.innerHTML = cats.map(c =>
            `<option value="${c.name}">${c.emoji} ${c.name}</option>`
        ).join('');
        sel.value = current;
        if (!sel.value && cats.length) sel.value = cats[0].name;
    },

    renderQuickButtons() {
        const grid = document.getElementById('quick-cats-grid');
        if (!grid) return;
        // Garante sem duplicatas por nome antes de renderizar
        const seen = new Set();
        const unique = this.categories.filter(c => {
            const key = (c.name || '').trim().toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key); return true;
        });
        const visible = unique.slice(0, 7);
        grid.innerHTML = visible.map(c => {
            const qtype = c.type === 'entrada' ? 'entrada' : 'saida';
            const isIncome = c.type === 'entrada';
            const iconBg = isIncome ? 'background:#ecfdf5' : 'background:#f0fdf4';
            return `<button data-quick-cat="${c.name}" data-quick-type="${qtype}" data-quick-label="${c.name}"
                class="cat-card flex flex-col items-center gap-1">
                <div class="cat-card-icon" style="${iconBg}">
                    <span class="text-xl leading-none">${c.emoji}</span>
                </div>
                <span class="text-[10px] text-gray-600 truncate w-full text-center leading-tight font-medium">${c.name}</span>
            </button>`;
        }).join('') + `
        <button id="manage-cats-btn" class="cat-card flex flex-col items-center gap-1">
            <div class="cat-card-icon" style="background:#f9fafb">
                <svg class="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"/>
                </svg>
            </div>
            <span class="text-[10px] text-gray-500 font-medium">Mais</span>
        </button>`;
        grid.querySelectorAll('[data-quick-cat]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.openModal({ category: btn.dataset.quickCat, type: btn.dataset.quickType, focusValue: true });
            });
        });
        document.getElementById('manage-cats-btn')?.addEventListener('click', () => this.openCategoryModal());
    },

    // ── Emoji picker helpers ──────────────────────────────────────────────────
    _emojiPickerGroups: [
        { label: '😊 Rostos', emojis: ['😀','😁','😂','🤣','🥰','😍','🤩','😎','🥳','🤔','😴','🤗','😇','🥹','😅','😬','🤯','🤫','🫡','😤','😡','🤬','😭','😱','😨','😰','🤑','🤤','🥱','😶','🫠','🙃'] },
        { label: '🍔 Alimentação', emojis: ['🍔','🍕','🌮','🌯','🥙','🥗','🍣','🍜','🍝','🍛','🍲','🥘','🫕','🍱','🥩','🥓','🍗','🍖','🌭','🥚','🍳','🧈','🧀','🥞','🧇','🥐','🍞','🥖','🥨','🥨','🍰','🎂','🧁','🍩','🍪','🍫','🍬','🍭','🍦','🍧','🍨','🍿','🧃','🥤','☕','🫖','🍵','🧋','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🍾','🛒','🫙','🥫','🧂'] },
        { label: '🚗 Transporte', emojis: ['🚗','🚕','🚙','🏎️','🚓','🚑','🚒','🚐','🚌','🚎','🏍️','🛵','🚲','🛴','🛺','🚜','🚛','🚚','🚃','🚋','🚝','🚂','✈️','🛫','🛬','🚁','🛸','⛵','🚢','🛳️','⛽','🅿️','🛣️','🗺️','🧭'] },
        { label: '💊 Saúde', emojis: ['💊','🏥','🦷','💉','🩺','🩹','🧬','🩻','🩼','🧪','🔬','🩸','🫀','🫁','🧠','👁️','👂','🦿','🦾','🛁','🚿','🧴','🧻','🪥','🧼','🧽','💆','🧘','🏃','🚶','🤸','⚕️','🌡️','💪','🥦','🥕','🍎','🥑'] },
        { label: '🏠 Moradia', emojis: ['🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏗️','🛖','⛺','🏕️','🛋️','🛏️','🪑','🚪','🪟','🪞','🧹','🧺','🧴','🪣','🔑','🗝️','🔒','💡','🔦','🕯️','💧','🚿','🛁','🔧','🔨','🪛','🪚','⚒️','🛠️','🔩','🧲','🪜','🪤'] },
        { label: '📚 Educação', emojis: ['📚','📖','📝','✏️','🖊️','🖋️','📓','📔','📒','📕','📗','📘','📙','📃','📄','📑','📊','📋','📌','📍','🗂️','🗃️','📂','🎓','🏫','🏛️','💻','🖥️','⌨️','🖱️','🖨️','📱','📡','🔭','🔬','🧪','🎒','✂️','📐','📏'] },
        { label: '🎮 Lazer', emojis: ['🎮','🕹️','👾','🎲','🎯','🎳','🎰','🃏','🀄','🎭','🎨','🖌️','🎬','🎥','📽️','🎞️','📺','📻','🎵','🎶','🎼','🎤','🎧','🎷','🎸','🎹','🎺','🎻','🪗','🥁','🪘','🎙️','🎪','🎠','🎡','🎢','🎟️','🎫'] },
        { label: '👕 Vestuário', emojis: ['👕','👔','👗','👘','🥻','🩱','🩲','🩳','👙','🩴','👟','👠','👡','👢','🥾','🧤','🧣','🧥','🧦','👒','🎩','⛑️','🪖','👑','💍','👜','👝','🎒','🧳','🕶️','🥽','💄','💅','💇','💈'] },
        { label: '💰 Finanças', emojis: ['💰','💵','💴','💶','💷','💸','💳','🏧','💱','💲','🪙','💎','📈','📉','📊','🏦','🤑','🏷️','🧾','📑','💼','🤝','🪙','📦','🏪','🛒','🛍️','🎁','🎀','🎊','🎉'] },
        { label: '💻 Tecnologia', emojis: ['💻','🖥️','🖨️','⌨️','🖱️','📱','☎️','📞','📟','📠','📡','📺','📷','📸','📹','🎥','📽️','🎞️','🔋','🪫','🔌','💡','🔦','🕹️','🖲️','📀','💽','💾','📼','📲','🌐','⌚','📡','🛰️','🔭'] },
        { label: '✈️ Viagem', emojis: ['✈️','🛫','🛬','🛩️','🚁','🛸','🚀','🛳️','⛴️','🚢','🛥️','⛵','🏖️','🏝️','🏔️','⛰️','🗻','🌋','🏕️','🗺️','🧭','🗼','🗽','🏰','🏯','⛩️','🌉','🌁','🌃','🌆','🌇','🌅','🌄','🌠','🎑','🎆','🎇','🧳','🎿','🏂','🪂','🤿','🏄','🤽'] },
        { label: '🌱 Natureza', emojis: ['🌱','🌿','🍀','🌾','🌵','🌴','🌳','🌲','🍁','🍂','🍃','🌺','🌸','🌼','🌻','🌹','💐','🌷','🪷','🍄','🌊','🌈','⛅','🌤️','🌦️','⛈️','❄️','🌬️','🌀','🌙','⭐','☀️','🌟','✨','⚡','🔥','💧','🌍','🌎','🌏'] },
        { label: '🐾 Animais', emojis: ['🐾','🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🦄','🐴','🐑','🐗','🐺','🦝','🦨','🦡','🦫','🐇','🦌','🐈','🐕','🦮','🐩','🐓','🦜','🐠','🐟','🐡','🦋','🐛','🐝','🌸'] },
        { label: '⚽ Esporte', emojis: ['⚽','🏀','🏈','⚾','🥎','🏐','🏉','🎾','🏸','🏒','🥊','🥋','🎽','🤸','🏋️','⛹️','🏊','🚴','🧗','🤺','⛷️','🏂','🏌️','🏇','🧘','🤼','🤾','🤽','🚵','🎯','🎱','🏓','🏸','🥅','⛳','🎣','🤿','🪃','🛷','🥌','🎿'] },
        { label: '💆 Beleza', emojis: ['💆','💇','💅','🛁','🛀','🧴','🧼','🪥','🪞','💊','💄','👄','💋','💃','🕺','👙','🩱','💍','💎','🌸','🌺','🌷','🌹','🧖','🧘','✨','⭐','🌟','🎀','🪄','🎭','🎨'] },
        { label: '👶 Família', emojis: ['👶','🧒','👦','👧','🧑','👱','👨','👩','🧓','👴','👵','👪','👨‍👩‍👦','👨‍👩‍👧','👨‍👩‍👧‍👦','👨‍👦','👩‍👦','👨‍👧','👩‍👧','🤱','🍼','🪆','🎠','🎡','🎢','🧸','🪀','🪁','⛸️','🛝','🎒','✏️','📚'] },
        { label: '💼 Trabalho', emojis: ['💼','🏢','🏭','🗂️','📋','📊','📈','📉','📌','📍','📎','🖇️','✂️','🗃️','🗄️','🗑️','🖊️','🖋️','✒️','📝','📅','📆','🗓️','📇','📁','📂','🗂️','🤝','📣','📢','💬','💭','🔔','📯','📜','📋','🖥️','💻','⌨️','🖱️'] },
        { label: '🎊 Comemorações', emojis: ['🎉','🎊','🎈','🎁','🎀','🎂','🎆','🎇','🪅','🎑','🎐','🎏','🎎','🎍','🎋','🎃','🎄','🎋','🎍','🤶','🎅','🪆','🎠','🃏','🎲','🎯','🏆','🥇','🥈','🥉','🎖️','🏅','🎗️','🎟️','🎫'] },
        { label: '🔧 Outros', emojis: ['🔧','🔨','⚒️','🛠️','⛏️','🪚','🔩','⚙️','🧱','🧲','🪜','🪝','🔗','📎','🖇️','🗑️','📦','📫','📬','📭','📮','📯','📣','🔔','🔕','❓','❗','⭕','✅','❌','🚫','⚠️','🔱','♻️','🔄','⏩','⏫','🆕','🆗','🆙','🈴'] },
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
        grid.innerHTML = this._emojiPickerGroups.map(g =>
            `<div class="col-span-8 text-xs font-semibold text-gray-400 mt-2 mb-0.5 px-0.5">${g.label}</div>` +
            g.emojis.map(e =>
                `<button type="button" data-emoji="${e}" class="text-2xl p-1 rounded-lg hover:bg-emerald-50 transition-colors leading-none">${e}</button>`
            ).join('')
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
                    <button class="cat-edit-btn text-gray-400 hover:text-emerald-600 px-2 text-lg" data-cat-id="${cat.id}" title="Editar">✏️</button>
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
                this.categories = this._sortCategories(this.categories);
            }
            NLP.setCategoryMap(this.categories);
            this.closeCategoryForm();
            this.renderCategoryList();
            this.renderCategorySelect();
            this.renderQuickButtons();
            this.showToast(this.editingCatId ? '✅ Categoria atualizada!' : '✅ Categoria criada!');
        } catch (e) {
            const msg = e.message || '';
            if (msg.includes('duplicate key') || msg.includes('unique constraint') || msg.includes('already exists')) {
                this.showToast('⚠️ Já existe uma categoria com esse nome neste perfil.', true);
            } else {
                this.showToast('❌ Erro: ' + msg, true);
            }
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
        const cls = isMe ? 'bg-emerald-100 text-emerald-700' : palettes[seed % palettes.length];
        return `<span class="inline-block text-xs px-1.5 py-0.5 rounded-full ${cls} font-medium leading-tight">${name}</span>`;
    },

    _resolveTypeName(typeId) {
        if (typeId === 'entrada') return 'Entrada';
        if (typeId === 'saida')   return 'Saída';
        // Tenta pela lista carregada em memória
        const inMem = this.transactionTypes.find(t => t.id === typeId);
        if (inMem) return inMem.name;
        // Tenta direto do localStorage (cobre migração de IDs)
        const inStorage = Storage.getCustomTypes().find(t => t.id === typeId);
        if (inStorage) return inStorage.name;
        // Heurística: ID começa com 'ct' → era um tipo customizado removido
        if (String(typeId).startsWith('ct')) return `Tipo (${typeId})`;
        return 'Saída';
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

    showToast(msg, error = false, duration = 2500) {
        const toast = document.getElementById('toast');
        toast.textContent = msg;
        toast.className = `fixed bottom-24 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full text-white text-sm font-medium shadow-lg z-50 transition-all ${error ? 'bg-red-500' : 'bg-green-500'}`;
        toast.classList.remove('hidden', 'opacity-0');
        clearTimeout(toast._toastTimer);
        toast._toastTimer = setTimeout(() => { toast.classList.add('opacity-0'); setTimeout(() => toast.classList.add('hidden'), 300); }, duration);
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());
