// ─── Auth ─────────────────────────────────────────────────────────────────────
const Auth = {
    user: null,

    async init() {
        if (!IS_SUPABASE_CONFIGURED) {
            this.showApp();
            return;
        }

        // Restore session from storage
        const { data: { session } } = await $sb.auth.getSession();
        if (session?.user) {
            this.user = session.user;
            this.showApp();
        } else {
            this.showAuthScreen();
        }

        // Listen for auth state changes
        $sb.auth.onAuthStateChange((event, session) => {
            this.user = session?.user ?? null;
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
        await $sb.auth.signOut();
    },

    async resetPassword(email) {
        const { error } = await $sb.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin
        });
        if (error) throw error;
    },

    showApp() {
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('main-app').classList.remove('hidden');
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) logoutBtn.classList.toggle('hidden', !IS_SUPABASE_CONFIGURED);
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

        logoutBtn?.addEventListener('click', async () => {
            if (confirm('Sair da conta?')) await this.logout();
        });
    },

    translateError(msg) {
        if (msg.includes('Invalid login')) return 'E-mail ou senha incorretos.';
        if (msg.includes('Email not confirmed')) return 'Confirme seu e-mail antes de entrar.';
        if (msg.includes('User already registered')) return 'E-mail já cadastrado.';
        if (msg.includes('Password should')) return 'A senha deve ter pelo menos 6 caracteres.';
        if (msg.includes('rate limit')) return 'Muitas tentativas. Aguarde alguns minutos.';
        return msg;
    }
};
