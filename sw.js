// ─── Service Worker — Finanças Casa ──────────────────────────────────────────
const SHARE_CACHE = 'share-target-v1';

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

// ── Share Target (POST /share-target) ────────────────────────────────────────
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    if (event.request.method === 'POST' && url.pathname === '/share-target') {
        event.respondWith(handleShareTarget(event.request));
        return;
    }
});

async function handleShareTarget(request) {
    const formData = await request.formData();
    const title    = formData.get('title') || '';
    const text     = formData.get('text')  || '';
    const file     = formData.get('receipt');

    const cache = await caches.open(SHARE_CACHE);

    if (file && file.size > 0) {
        // Salva o arquivo compartilhado
        await cache.put('shared-file', new Response(file, {
            headers: { 'Content-Type': file.type || 'image/jpeg' }
        }));
        await cache.put('shared-meta', new Response(JSON.stringify({
            kind:     'file',
            name:     file.name,
            mimeType: file.type || 'image/jpeg',
            title,
            text
        }), { headers: { 'Content-Type': 'application/json' } }));
    } else if (text) {
        // Compartilhou texto (ex: cópia do comprovante)
        await cache.delete('shared-file');
        await cache.put('shared-meta', new Response(JSON.stringify({
            kind: 'text',
            text,
            title
        }), { headers: { 'Content-Type': 'application/json' } }));
    }

    // Redireciona para o app com flag de arquivo compartilhado
    return Response.redirect('/?shared=1', 303);
}
