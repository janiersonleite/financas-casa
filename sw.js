// ─── Service Worker — Finanças Casa ──────────────────────────────────────────
const SHARE_CACHE   = 'share-target-v1';
const RUNTIME_CACHE = 'app-runtime-v1';

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(RUNTIME_CACHE)
            .then(c => c.addAll(['/financas-casa/', '/financas-casa/index.html']))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== RUNTIME_CACHE && k !== SHARE_CACHE)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // ── Share Target (POST /share-target) ────────────────────────────────────
    if (event.request.method === 'POST' && url.pathname === '/financas-casa/share-target') {
        event.respondWith(handleShareTarget(event.request));
        return;
    }

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
                .then(cached => cached || caches.match('/financas-casa/index.html'))
            )
    );
});

// ── Notificação persistente clicada ──────────────────────────────────────────
self.addEventListener('notificationclick', event => {
    event.notification.close();

    const action = event.action || event.notification.data?.action || '';
    const target = action === 'new-transaction' || event.notification.tag === 'quick-add'
        ? '/financas-casa/?action=new-transaction'
        : '/financas-casa/';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(list => {
                // App já aberto → manda mensagem e foca
                for (const client of list) {
                    if (client.url.includes('financas-casa')) {
                        if (action === 'new-transaction' || event.notification.tag === 'quick-add') {
                            client.postMessage({ action: 'new-transaction' });
                        }
                        return client.focus();
                    }
                }
                // App fechado → abre na URL com parâmetro
                return self.clients.openWindow(target);
            })
    );
});

// ── Share Target handler ──────────────────────────────────────────────────────
async function handleShareTarget(request) {
    const formData = await request.formData();
    const title    = formData.get('title') || '';
    const text     = formData.get('text')  || '';
    const file     = formData.get('receipt');

    const cache = await caches.open(SHARE_CACHE);

    if (file && file.size > 0) {
        await cache.put('shared-file', new Response(file, {
            headers: { 'Content-Type': file.type || 'image/jpeg' }
        }));
        await cache.put('shared-meta', new Response(JSON.stringify({
            kind: 'file', name: file.name, mimeType: file.type || 'image/jpeg', title, text
        }), { headers: { 'Content-Type': 'application/json' } }));
    } else if (text) {
        await cache.delete('shared-file');
        await cache.put('shared-meta', new Response(JSON.stringify({
            kind: 'text', text, title
        }), { headers: { 'Content-Type': 'application/json' } }));
    }

    return Response.redirect('/financas-casa/?shared=1', 303);
}
