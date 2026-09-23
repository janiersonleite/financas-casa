// ─── Service Worker — Finanças Casa ──────────────────────────────────────────
// APP_VERSION: 2026-09-23 12:00  ← atualizar junto com app.js a cada deploy
const RUNTIME_CACHE = 'app-runtime-v20260923a';

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(RUNTIME_CACHE)
            .then(c => c.addAll([self.registration.scope, self.registration.scope + 'index.html']))
            .then(() => self.skipWaiting())
    );
});

// ── Mensagem do cliente: força ativação imediata (botão "Atualizar") ──────────
self.addEventListener('message', e => {
    if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== RUNTIME_CACHE)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Só intercepta GET
    if (event.request.method !== 'GET') return;

    // Deixa chamadas Supabase passarem direto (o JS trata os erros de rede)
    if (url.hostname.includes('supabase.co')) return;

    // Network-first com fallback para cache (funciona para app shell + CDN)
    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(RUNTIME_CACHE).then(c => c.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request)
                .then(cached => cached || caches.match(self.registration.scope + 'index.html'))
            )
    );
});

// ── Notificação persistente clicada ──────────────────────────────────────────
self.addEventListener('notificationclick', event => {
    event.notification.close();

    const action  = event.action || event.notification.data?.action || '';
    const isReminder    = action === 'open-reminders' ||
                          (event.notification.tag || '').startsWith('reminder_');
    const isNewTxn      = action === 'new-transaction' || event.notification.tag === 'quick-add';

    const base = self.registration.scope; // URL base do app (agnóstico ao domínio/caminho)
    const target = isNewTxn    ? base + '?action=new-transaction'
                 : isReminder  ? base + '?action=open-reminders'
                 :               base;

    const postMsg = isNewTxn   ? { action: 'new-transaction' }
                  : isReminder ? { action: 'open-reminders'  }
                  : null;

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(list => {
                // App já aberto → manda mensagem e foca
                for (const client of list) {
                    if (client.url.startsWith(base)) {
                        if (postMsg) client.postMessage(postMsg);
                        return client.focus();
                    }
                }
                // App fechado → abre na URL com parâmetro
                return self.clients.openWindow(target);
            })
    );
});
