// Edge Function: envia os lembretes vencidos por Web Push.
// Chamada a cada minuto pelo pg_cron (ver README.md). Deploy com --no-verify-jwt:
// a autenticação é o cabeçalho x-cron-secret.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { processBatch, type Deps, type QueueRow, type Sub } from './handler.ts';

const env = (k: string) => Deno.env.get(k) ?? '';
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// comparação em tempo constante
function safeEqual(a: string, b: string) {
    const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
    let d = x.length ^ y.length;
    for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
    return d === 0;
}

Deno.serve(async (req) => {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const secret = env('CRON_SECRET');
    if (!secret || !safeEqual(req.headers.get('x-cron-secret') ?? '', secret)) return json({ error: 'unauthorized' }, 401);

    const privateKey = env('VAPID_PRIVATE_KEY'), subject = env('VAPID_SUBJECT');
    if (!privateKey || !subject) return json({ error: 'VAPID_PRIVATE_KEY / VAPID_SUBJECT não configurados' }, 500);

    const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
    const { data: cfg, error: cfgErr } = await sb.from('app_settings').select('value').eq('key', 'vapid_public_key').maybeSingle();
    if (cfgErr || !cfg?.value) return json({ error: 'vapid_public_key ausente em app_settings' }, 500);
    webpush.setVapidDetails(subject, cfg.value, privateKey);

    const deps: Deps = {
        async claim(limit) {
            const { data, error } = await sb.rpc('claim_due_push', { p_limit: limit });
            if (error) throw error;
            return (data ?? []) as QueueRow[];
        },
        async subscriptionsFor(userIds) {
            const { data, error } = await sb.from('push_subscriptions').select('endpoint,p256dh,auth,user_id').in('user_id', userIds);
            if (error) throw error;
            return (data ?? []) as Sub[];
        },
        send: (s, payload, opts) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, opts),
        async deleteSubscription(endpoint) { await sb.from('push_subscriptions').delete().eq('endpoint', endpoint); },
        async markDone(id, result) { await sb.from('push_queue').update({ sent_at: new Date().toISOString(), result }).eq('id', id); },
        async release(id) { await sb.from('push_queue').update({ claimed_at: null }).eq('id', id); },
        async cleanup() { await sb.rpc('cleanup_push_queue'); },
    };

    try { return json(await processBatch(deps)); }
    catch (e) { return json({ error: String((e as Error)?.message ?? e) }, 500); }
});
