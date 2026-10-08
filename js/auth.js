// ─── Auth ─────────────────────────────────────────────────────────────────────
const Auth = {
    user: null,

    async init() {
        if (!IS_SUPABASE_CONFIGURED) {
            this.showApp();
            return;
        }

        // Link "Esqueci minha senha": NÃO entra no app. Só mostra a tela de nova senha;
        // depois de salvar, a sessão é encerrada e a pessoa entra com a senha nova.
        if (window.__PW_RECOVERY) this._recovering = true;

        // Restore session from storage
        const { data: { session } } = await $sb.auth.getSession();
        if (this._recovering) {
            this.user = null;
            this.showAuthScreen();
            this.showRecovery();
        } else if (session?.user) {
            this.user = session.user;
            this.showApp();
        } else {
            this.showAuthScreen();
            let changed = false;
            try { changed = sessionStorage.getItem('pw_changed') === '1'; sessionStorage.removeItem('pw_changed'); } catch (_) {}
            const info = document.getElementById('auth-info');
            if (changed && info) { info.textContent = '✅ Senha alterada! Entre com a sua nova senha.'; info.classList.remove('hidden'); }
            if (window.__AUTH_LINK_ERROR) {
                const e = document.getElementById('auth-error');
                if (e) { e.textContent = 'Esse link expirou ou já foi usado. Toque em "Esqueci minha senha" para receber outro.'; e.classList.remove('hidden'); }
            }
        }

        // Listen for auth state changes
        $sb.auth.onAuthStateChange((event, session) => {
            this.user = session?.user ?? null;
            if (event === 'PASSWORD_RECOVERY') { this._recovering = true; this.user = null; this.showAuthScreen(); this.showRecovery(); return; }
            if (this._recovering) return;   // enquanto define a nova senha, nenhum evento abre o app
            if (this.user) {
                this.showApp();
                // Fresh login (not initial page restore) — reload finances
                if (event === 'SIGNED_IN' && typeof App !== 'undefined' && App.loadFinancas) {
                    App.loadFinancas().then(() => App.renderCurrentTab());
                }
            } else {
                this.showAuthScreen();
            }
        });
    },

    async login(email, password) {
        const { error } = await $sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
    },

    async register(email, password) {
        const { error } = await $sb.auth.signUp({ email, password });
        if (error) throw error;
    },

    async logout() {
        try { await window.PushNotif?.onLogout(); } catch (_) {}   // este aparelho deixa de receber avisos da conta
        await $sb.auth.signOut();
    },

    // ── Nova senha após o link de recuperação ────────────────────────────────
    showRecovery() {
        const m = document.getElementById('recovery-modal');
        if (!m) return;
        m.classList.remove('hidden');
        setTimeout(() => document.getElementById('recovery-pass1')?.focus(), 50);
    },
    hideRecovery() {
        document.getElementById('recovery-modal')?.classList.add('hidden');
    },
    // Encerra a sessão temporária do link e recarrega limpo (sem token na URL) na tela de login.
    async finishRecovery(changed) {
        try { if (changed) sessionStorage.setItem('pw_changed', '1'); } catch (_) {}
        try { await $sb.auth.signOut({ scope: 'local' }); } catch (_) {}
        this.hideRecovery();
        location.replace(location.pathname);
    },
    async saveNewPassword(p1, p2) {
        if (!p1 || p1.length < 6) throw new Error('A senha deve ter pelo menos 6 caracteres.');
        if (p1 !== p2) throw new Error('As senhas não são iguais.');
        const { error } = await $sb.auth.updateUser({ password: p1 });
        if (error) throw error;
    },

    async resetPassword(email) {
        const { error } = await $sb.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin
        });
        if (error) throw error;
    },

    showApp() {
        if (this._recovering) return;
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('main-app').classList.remove('hidden');
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) logoutBtn.classList.toggle('hidden', !IS_SUPABASE_CONFIGURED);
        this._renderUserGreeting();
    },

    _renderUserGreeting() {
        const email    = this.user?.email || '';
        const meta     = this.user?.user_metadata || {};
        const fullName = meta.full_name || meta.name || '';
        const display  = fullName || (email ? email.split('@')[0] : 'Usuário');
        const initial  = display.charAt(0).toUpperCase();

        const nameEl     = document.getElementById('user-name');
        const avatarEl   = document.getElementById('user-avatar');
        const greetingEl = document.getElementById('home-greeting-text');
        if (nameEl)   nameEl.textContent   = display;
        if (avatarEl) avatarEl.textContent = initial;

        if (greetingEl) {
            const h = new Date().getHours();
            const saudacao = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
            greetingEl.textContent = `${saudacao} 👋`;
        }
    },

    showAuthScreen() {
        document.getElementById('auth-screen').classList.remove('hidden');
        document.getElementById('main-app').classList.add('hidden');
    },

    bindUI() {
        if (!IS_SUPABASE_CONFIGURED) return;

        const emailEl   = () => document.getElementById('auth-email');
        const passEl    = () => document.getElementById('auth-password');
        const errEl     = () => document.getElementById('auth-error');
        const loginBtn  = document.getElementById('auth-login-btn');
        const regBtn    = document.getElementById('auth-register-btn');
        const resetBtn  = document.getElementById('auth-reset-btn');
        const logoutBtn = document.getElementById('logout-btn');
        const tabLogin  = document.getElementById('tab-auth-login');
        const tabReg    = document.getElementById('tab-auth-register');

        const setError = (msg) => { errEl().textContent = msg; errEl().classList.toggle('hidden', !msg); };
        const setLoading = (btn, loading) => {
            btn.disabled = loading;
            btn.textContent = loading ? 'Aguarde...' : btn.dataset.label;
        };

        tabLogin?.addEventListener('click', () => {
            tabLogin.classList.add('border-blue-500', 'text-blue-600');
            tabReg.classList.remove('border-blue-500', 'text-blue-600');
            document.getElementById('auth-login-section').classList.remove('hidden');
            document.getElementById('auth-register-section').classList.add('hidden');
            setError('');
        });

        tabReg?.addEventListener('click', () => {
            tabReg.classList.add('border-blue-500', 'text-blue-600');
            tabLogin.classList.remove('border-blue-500', 'text-blue-600');
            document.getElementById('auth-register-section').classList.remove('hidden');
            document.getElementById('auth-login-section').classList.add('hidden');
            setError('');
        });

        loginBtn?.addEventListener('click', async () => {
            setError('');
            setLoading(loginBtn, true);
            try {
                await this.login(emailEl().value.trim(), passEl().value);
            } catch (e) {
                setError(this.translateError(e.message));
            } finally {
                setLoading(loginBtn, false);
            }
        });

        regBtn?.addEventListener('click', async () => {
            setError('');
            setLoading(regBtn, true);
            try {
                await this.register(
                    document.getElementById('reg-email').value.trim(),
                    document.getElementById('reg-password').value
                );
                setError('');
                document.getElementById('auth-success').classList.remove('hidden');
            } catch (e) {
                setError(this.translateError(e.message));
            } finally {
                setLoading(regBtn, false);
            }
        });

        resetBtn?.addEventListener('click', async () => {
            const email = emailEl().value.trim();
            if (!email) { setError('Digite seu e-mail primeiro.'); return; }
            try {
                await this.resetPassword(email);
                setError('');
                alert('E-mail de recuperação enviado! Verifique sua caixa de entrada.');
            } catch (e) {
                setError(this.translateError(e.message));
            }
        });

        const recSave = document.getElementById('recovery-save');
        const recErr  = document.getElementById('recovery-error');
        const recMsg  = (t) => { recErr.textContent = t; recErr.classList.toggle('hidden', !t); };
        recSave?.addEventListener('click', async () => {
            recMsg(''); recSave.disabled = true; recSave.textContent = 'Salvando...';
            try {
                await this.saveNewPassword(document.getElementById('recovery-pass1').value, document.getElementById('recovery-pass2').value);
                document.getElementById('recovery-pass1').value = ''; document.getElementById('recovery-pass2').value = '';
                await this.finishRecovery(true);
            } catch (e) {
                recMsg(this.translateError(e.message || String(e)));
            } finally { recSave.disabled = false; recSave.textContent = recSave.dataset.label; }
        });
        document.getElementById('recovery-cancel')?.addEventListener('click', async () => {
            await this.finishRecovery(false);
        });

        logoutBtn?.addEventListener('click', async () => {
            if (confirm('Sair da conta?')) await this.logout();
        });
    },

    translateError(msg) {
        if (msg.includes('Invalid login')) return 'E-mail ou senha incorretos.';
        if (msg.includes('Email not confirmed')) return 'Confirme seu e-mail antes de entrar.';
        if (msg.includes('User already registered')) return 'E-mail já cadastrado.';
        if (msg.includes('Password should')) return 'A senha deve ter pelo menos 6 caracteres.';
        if (msg.includes('same password') || msg.includes('different from the old')) return 'Escolha uma senha diferente da atual.';
        if (msg.includes('session') && msg.includes('missing')) return 'O link expirou. Peça um novo em "Esqueci minha senha".';
        if (msg.includes('rate limit')) return 'Muitas tentativas. Aguarde alguns minutos.';
        return msg;
    }
};
