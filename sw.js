// ─── Service Worker — Finanças Casa ──────────────────────────────────────────
// APP_VERSION: 2026-10-06 12:00  ← atualizar junto com app.js a cada deploy
const RUNTIME_CACHE = 'app-runtime-v20261009g';

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

// ── Web Push (lembretes enviados pelo servidor, com o app fechado) ───────────
// Todo push PRECISA exibir uma notificação (exigência do iOS e do Chrome).
self.addEventListener('push', event => {
    let d = {};
    try { d = event.data ? event.data.json() : {}; }
    catch (_) { d = { body: event.data ? event.data.text() : '' }; }

    const tag = d.tag || 'push-' + Date.now();
    const urgent = /_d0$|^sched_rem_/.test(tag);
    event.waitUntil(
        self.registration.showNotification(d.title || '🔔 Lembrete', {
            body:               d.body || '',
            icon:               'icons/icon-192.png',
            badge:              'icons/badge-96.png',
            tag,
            renotify:           true,
            requireInteraction: urgent,
            vibrate:            urgent ? [200, 100, 200] : [100],
            data:               { action: d.action || 'open-reminders', reminderId: d.reminderId || null },
        })
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
