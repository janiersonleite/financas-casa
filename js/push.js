// ─── Web Push dos lembretes (avisos com o app FECHADO) ────────────────────────
// O app calcula as próximas ocorrências dos lembretes e grava em push_queue (RPC
// sync_push_queue). Uma Edge Function (supabase/functions/push-reminders) envia na hora.
// Requer: migração 20261007000001, chave VAPID em app_settings e a função publicada
// (veja supabase/functions/push-reminders/README.md).
const PushNotif = {
    HORIZON_DAYS: 45,        // até quando agendar à frente
    MONTHS_AHEAD: 3,         // ocorrências mensais consideradas
    UNTIMED_START_MIN: 8 * 60 + 30, // lembretes sem horário: janela de 08:30 a 09:29 ...
    UNTIMED_SPREAD_MIN: 60,         // ... cada lembrete cai num minuto fixo dela (evita pico no servidor)
    UNTIMED_OFFSETS: [2, 1, 0], // dias antes do vencimento (igual aos avisos ao abrir o app)
    MIN_SYNC_GAP_MS: 2 * 60 * 1000,

    _sig: {},                // assinatura do último envio por escopo (evita RPC repetida)
    _lastSync: 0,
    _timer: null,
    _busy: false,

    // ── Suporte / estado ──────────────────────────────────────────────────────
    supported() {
        return typeof navigator !== 'undefined' && 'serviceWorker' in navigator &&
               typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
    },
    isIOS() {
        const ua = navigator.userAgent || '';
        return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    },
    isStandalone() {
        return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
    },
    _uid() { try { return Storage.userId?.() || null; } catch { return null; } },
    _flagKey() { return 'push_enabled_' + (this._uid() || 'anon'); },
    flagOn() { try { return localStorage.getItem(this._flagKey()) === '1'; } catch { return false; } },
    _setFlag(on) { try { on ? localStorage.setItem(this._flagKey(), '1') : localStorage.removeItem(this._flagKey()); } catch {} },

    /** 'local' | 'unsupported' | 'needs-install' | 'denied' | 'on' | 'off' */
    async state() {
        if (!Storage.isCloud || !window.$sb) return 'local';
        // iPhone/iPad: o Safari só libera Push para o app instalado na Tela de Início
        if (this.isIOS() && !this.isStandalone()) return 'needs-install';
        if (!this.supported()) return 'unsupported';
        if (Notification.permission === 'denied') return 'denied';
        if (Notification.permission === 'granted' && this.flagOn()) {
            try {
                const reg = await navigator.serviceWorker.ready;
                if (await reg.pushManager.getSubscription()) return 'on';
            } catch {}
        }
        return 'off';
    },

    // Minuto (0..SPREAD-1) estável para uma chave: o mesmo lembrete sempre cai no mesmo minuto.
    _spread(key) {
        let h = 2166136261;                         // FNV-1a 32 bits
        for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
        return (h >>> 0) % this.UNTIMED_SPREAD_MIN;
    },

    // ── Cálculo das ocorrências (puro: recebe tudo por parâmetro) ─────────────
    // reminders: lista de lembretes; ctx: { now, salt, isPaid(r), isExpiredAt(r, Date), money(v), currentMonth }
    buildItems(reminders, ctx) {
        const now = ctx.now ?? Date.now();
        const limit = now + this.HORIZON_DAYS * 86400000;
        const ymKey = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        const items = [];
        const LABEL = { 0: 'Vence hoje!', 1: 'Vence amanhã', 2: 'Vence em 2 dias' };
        const BADGE = { 0: '🔴', 1: '🟠', 2: '🟡' };

        for (const r of reminders || []) {
            if (!r || r.active === false || !r.id) continue;
            const timeOk = r.notify_time && /^\d{2}:\d{2}/.test(r.notify_time);

            // Datas de vencimento (00:00 local)
            const dues = [];
            if (r.notify_date && /^\d{4}-\d{2}-\d{2}$/.test(r.notify_date)) {
                const [y, m, d] = r.notify_date.split('-').map(Number);
                dues.push(new Date(y, m - 1, d));
            } else {
                const day = Number(r.day);
                if (!day || day < 1 || day > 31) continue;
                const base = new Date(now);
                for (let k = 0; k <= this.MONTHS_AHEAD; k++) {
                    const last = new Date(base.getFullYear(), base.getMonth() + k + 1, 0).getDate(); // dia 31 em mês curto → último dia
                    dues.push(new Date(base.getFullYear(), base.getMonth() + k, Math.min(day, last)));
                }
            }

            const valor = '';   // o valor cadastrado é só uma previsão (contas variam): não vai na notificação
            const emoji = r.emoji || '🔔';
            for (const due of dues) {
                if (ctx.isExpiredAt && ctx.isExpiredAt(r, due)) continue;
                if (ctx.isPaid && ymKey(due) === ctx.currentMonth && ctx.isPaid(r)) continue; // (opcional) já pago neste mês
                const dueYm = ymKey(due);   // o servidor usa isto para pular o aviso se já houver lançamento pago

                if (timeOk) {
                    const [hh, mm] = r.notify_time.slice(0, 5).split(':').map(Number);
                    const at = new Date(due.getFullYear(), due.getMonth(), due.getDate(), hh, mm, 0, 0).getTime();
                    if (at <= now || at > limit) continue;
                    items.push({
                        reminder_id: String(r.id), fire_at: new Date(at).toISOString(),
                        title: `🔔 ${r.name}`, body: `${emoji} Hora de registrar${valor}`,
                        tag: `sched_rem_${r.id}`, action: 'open-reminders', due_ym: dueYm,
                    });
                } else {
                    const quando = r.notify_date
                        ? `${String(due.getDate()).padStart(2, '0')}/${String(due.getMonth() + 1).padStart(2, '0')}`
                        : `dia ${r.day}`;
                    const minOfDay = this.UNTIMED_START_MIN + this._spread((ctx.salt || '') + ':' + r.id);
                    for (const off of this.UNTIMED_OFFSETS) {
                        const at = new Date(due.getFullYear(), due.getMonth(), due.getDate() - off, Math.floor(minOfDay / 60), minOfDay % 60, 0, 0).getTime();
                        if (at <= now || at > limit) continue;
                        items.push({
                            reminder_id: String(r.id), fire_at: new Date(at).toISOString(),
                            title: `${BADGE[off]} ${r.name}`, body: `${emoji} ${LABEL[off]} (${quando})${valor}`,
                            tag: `reminder_${r.id}_d${off}`, action: 'open-reminders', due_ym: dueYm,
                        });
                    }
                }
            }
        }
        items.sort((a, b) => a.fire_at.localeCompare(b.fire_at) || a.tag.localeCompare(b.tag));
        return items.slice(0, 400);
    },

    // ── Ligar / desligar ──────────────────────────────────────────────────────
    _b64ToU8(b64) {
        const pad = '='.repeat((4 - (b64.length % 4)) % 4);
        const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
        return Uint8Array.from(raw, c => c.charCodeAt(0));
    },
    _sameKey(sub, key) {
        try {
            const cur = sub.options?.applicationServerKey;
            if (!cur) return false;
            const a = new Uint8Array(cur), b = this._b64ToU8(key);
            return a.length === b.length && a.every((v, i) => v === b[i]);
        } catch { return false; }
    },
    async _vapidKey() {
        const { data, error } = await window.$sb.from('app_settings').select('value').eq('key', 'vapid_public_key').maybeSingle();
        if (error || !data?.value) { const e = new Error('SERVER_NOT_CONFIGURED'); e.code = 'SERVER_NOT_CONFIGURED'; throw e; }
        return data.value;
    },
    async _subscribe(reg, key) {
        let sub = await reg.pushManager.getSubscription();
        if (sub && !this._sameKey(sub, key)) { try { await sub.unsubscribe(); } catch {} sub = null; }
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: this._b64ToU8(key) });
        return sub;
    },
    async _register(sub) {
        const j = sub.toJSON();
        const { error } = await window.$sb.rpc('register_push_subscription', {
            p_endpoint: sub.endpoint, p_p256dh: j.keys?.p256dh, p_auth: j.keys?.auth, p_user_agent: navigator.userAgent,
        });
        if (error) throw error;
    },

    /** Deve ser chamado a partir de um clique (iOS exige gesto do usuário para pedir permissão). */
    async enable() {
        if (!this.supported()) throw new Error('UNSUPPORTED');
        if (this.isIOS() && !this.isStandalone()) throw new Error('NEEDS_INSTALL');
        const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
        if (perm !== 'granted') { const e = new Error('DENIED'); e.code = 'DENIED'; throw e; }
        const key = await this._vapidKey();
        const reg = await navigator.serviceWorker.ready;
        const sub = await this._subscribe(reg, key);
        await this._register(sub);
        this._setFlag(true);
        this._sig = {};
        await this.sync({ force: true });
    },

    async disable() {
        try {
            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.getSubscription();
            if (sub) {
                try { await window.$sb.rpc('unregister_push_subscription', { p_endpoint: sub.endpoint }); } catch {}
                try { await sub.unsubscribe(); } catch {}
            }
        } catch {}
        this._setFlag(false);
        // esvazia a fila pendente deste usuário
        try { for (const sc of [...this._scopes(), 'test']) await window.$sb.rpc('sync_push_queue', { p_scope: sc, p_items: [] }); } catch {}
        this._sig = {};
    },

    /** Chamado ao sair da conta: este aparelho deixa de receber avisos dessa conta. */
    async onLogout() {
        try {
            if (!this.supported() || !Storage.isCloud) return;
            // nunca trava o logout: se o service worker não responder em 1,5 s, segue sem desvincular
            const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 1500))]);
            if (!reg) return;
            const sub = await reg.pushManager.getSubscription();
            if (sub && window.$sb) await window.$sb.rpc('unregister_push_subscription', { p_endpoint: sub.endpoint });
        } catch {}
        this._sig = {};
    },

    /** Ao abrir o app: se o usuário já ativou, garante que a assinatura continua válida. */
    async ensure() {
        try {
            if (!this.supported() || !Storage.isCloud || !this._uid() || !this.flagOn()) return;
            if (Notification.permission !== 'granted') return;
            const reg = await navigator.serviceWorker.ready;
            let sub = await reg.pushManager.getSubscription();
            const stamp = 'push_registered_' + this._uid();
            const day = new Date().toISOString().slice(0, 10);
            if (!sub || localStorage.getItem(stamp) !== day) {
                const key = await this._vapidKey();
                sub = await this._subscribe(reg, key);
                await this._register(sub);
                try { localStorage.setItem(stamp, day); } catch {}
            }
            this.syncSoon();
        } catch (_) { /* offline ou servidor ainda não configurado: tenta na próxima abertura */ }
    },

    // ── Sincronização da fila ─────────────────────────────────────────────────
    _scopes() {
        const ids = (App.financas || []).map(f => f.id).filter(Boolean);
        return ids.length ? ids : ['personal'];
    },
    _ctx() {
        return {
            now: Date.now(),
            salt: this._uid() || '',
            // Pagamento é conferido pelo SERVIDOR na hora do envio (vale para qualquer aparelho e mês).
            isExpiredAt: (r, d) => App._isReminderExpired(r, d),
            money: v => App.formatCurrency(v),
        };
    },
    syncSoon(force = false) {
        if (!this.flagOn()) return;
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this.sync({ force }).catch(() => {}), force ? 800 : 3000);
    },
    async sync({ force = false } = {}) {
        if (this._busy || !window.$sb || !Storage.isCloud || !this.flagOn() || Notification.permission !== 'granted') return;
        if (!force && Date.now() - this._lastSync < this.MIN_SYNC_GAP_MS) return;
        this._busy = true;
        try {
            const fins = (App.financas && App.financas.length) ? App.financas : [{ id: null }];
            for (const f of fins) {
                const scope = f.id || 'personal';
                const list = f.id === (App.activeFinanca?.id ?? null) && App.reminders?.length
                    ? App.reminders : await Storage.getRemindersForFinanca(f.id);
                const items = this.buildItems(list, this._ctx());
                const sig = JSON.stringify(items);
                if (!force && this._sig[scope] === sig) continue;
                const { error } = await window.$sb.rpc('sync_push_queue', { p_scope: scope, p_items: items });
                if (error) throw error;
                this._sig[scope] = sig;
            }
            this._lastSync = Date.now();
        } finally { this._busy = false; }
    },

    /** Teste de ponta a ponta: agenda um aviso para daqui a ~1 minuto (passa pelo servidor). */
    async sendTest() {
        const at = new Date(Date.now() + 40 * 1000).toISOString();
        const { error } = await window.$sb.rpc('sync_push_queue', {
            p_scope: 'test',
            p_items: [{ reminder_id: 'test', fire_at: at, title: '✅ Avisos funcionando!', body: 'Este aviso veio do servidor, com o app fechado.', tag: 'push_test', action: 'open-reminders' }],
        });
        if (error) throw error;
    },

    // ── Cartão na tela de Lembretes ───────────────────────────────────────────
    async renderCard(msg) {
        const el = document.getElementById('push-card');
        if (!el) return;
        const st = await this.state();
        const box = (cls, inner) => { el.innerHTML = `<div class="rounded-xl border px-3 py-2.5 mb-2 text-xs ${cls}">${inner}</div>`; };
        const note = msg ? `<p class="mt-1.5 font-semibold" id="push-card-msg">${msg}</p>` : '<p class="mt-1.5 font-semibold hidden" id="push-card-msg"></p>';
        if (st === 'local') return box('bg-gray-50 border-gray-100 text-gray-500', '🔕 Avisos com o app fechado precisam de conta na nuvem (entre com seu e-mail).');
        if (st === 'unsupported') return box('bg-gray-50 border-gray-100 text-gray-500', '🔕 Este navegador não oferece avisos com o app fechado. Os avisos continuam aparecendo ao abrir o app.');
        if (st === 'needs-install') return box('bg-amber-50 border-amber-200 text-amber-800',
            '📲 <b>No iPhone</b>, os avisos só funcionam com o app instalado: toque em <b>Compartilhar</b> → <b>Adicionar à Tela de Início</b> e abra o app por esse ícone. Depois volte aqui para ativar.');
        if (st === 'denied') return box('bg-red-50 border-red-200 text-red-700',
            '🚫 As notificações estão bloqueadas para este app. Libere nas configurações do aparelho/navegador (Notificações → Permitir) e volte aqui.');
        if (st === 'on') {
            box('bg-emerald-50 border-emerald-200 text-emerald-800', `
                <div class="flex items-center gap-2">
                    <span class="text-base">🔔</span>
                    <div class="flex-1"><b>Avisos com o app fechado: ativados</b><br><span class="text-emerald-700/80">Você recebe os lembretes neste aparelho no horário definido.</span></div>
                </div>
                <div class="flex gap-2 mt-2">
                    <button id="push-test-btn" class="flex-1 py-1.5 rounded-lg bg-white border border-emerald-300 text-emerald-700 font-semibold">Enviar teste</button>
                    <button id="push-off-btn" class="flex-1 py-1.5 rounded-lg bg-white border border-gray-200 text-gray-500 font-semibold">Desativar</button>
                </div>${note}`);
        } else {
            box('bg-blue-50 border-blue-200 text-blue-800', `
                <div class="flex items-center gap-2">
                    <span class="text-base">🔕</span>
                    <div class="flex-1"><b>Receba os lembretes mesmo com o app fechado</b><br><span class="text-blue-700/80">Ative para ser avisado no horário certo, sem precisar abrir o app.</span></div>
                </div>
                <button id="push-on-btn" class="w-full mt-2 py-2 rounded-lg bg-blue-600 text-white font-semibold">Ativar avisos neste aparelho</button>${note}`);
        }
        this._bindCard();
    },
    _say(text, bad) {
        const m = document.getElementById('push-card-msg');
        if (!m) return;
        m.textContent = text; m.classList.remove('hidden');
        m.style.color = bad ? '#b91c1c' : '';
    },
    _bindCard() {
        const on = document.getElementById('push-on-btn');
        on?.addEventListener('click', async () => {
            on.disabled = true; on.textContent = 'Ativando...';
            try { await this.enable(); await this.renderCard('✅ Pronto! Use "Enviar teste" para conferir.'); }
            catch (e) {
                await this.renderCard();
                const code = e?.code || e?.message;
                this._say(code === 'DENIED' ? '🚫 Permissão negada. Libere as notificações nas configurações.'
                    : code === 'SERVER_NOT_CONFIGURED' ? '⚙️ O servidor de avisos ainda não foi configurado (veja o passo a passo do administrador).'
                    : code === 'NEEDS_INSTALL' ? '📲 Instale o app na Tela de Início primeiro.'
                    : '❌ Não foi possível ativar: ' + (e?.message || 'erro desconhecido'), true);
            }
        });
        document.getElementById('push-off-btn')?.addEventListener('click', async () => {
            await this.disable(); await this.renderCard('Avisos desativados neste aparelho.');
        });
        const test = document.getElementById('push-test-btn');
        test?.addEventListener('click', async () => {
            test.disabled = true;
            try { await this.sendTest(); this._say('⏳ Teste agendado: feche o app e aguarde cerca de 1–2 minutos.'); }
            catch (e) { this._say('❌ Falha ao agendar o teste: ' + (e?.message || e), true); }
            finally { test.disabled = false; }
        });
    },
};
window.PushNotif = PushNotif;
