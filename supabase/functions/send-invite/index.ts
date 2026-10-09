// Edge Function: envia o e-mail de convite para entrar em uma carteira (via Resend).
// Chamada pelo app com o login da pessoa. Deploy com "Verify JWT" DESLIGADO: a função valida o
// token sozinha (compatível com as chaves novas do Supabase) e confere se a pessoa é admin da carteira.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleSendInvite, type Deps } from './handler.ts';

const env = (k: string) => Deno.env.get(k) ?? '';
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const apiKey = env('RESEND_API_KEY');
    if (!apiKey) return json({ error: 'not_configured' }, 503);
    const from = env('FROM_EMAIL') || 'Minhas Carteiras <nao-responda@minhascarteiras.com.br>';
    const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

    const deps: Deps = {
        appUrl: (env('APP_URL') || 'https://minhascarteiras.com.br').replace(/\/+$/, '') + '/',
        now: () => Date.now(),
        async getUser(token) {
            const { data, error } = await sb.auth.getUser(token);
            return error || !data?.user?.email ? null : { id: data.user.id, email: data.user.email };
        },
        async isAdmin(financaId, userId) {
            const { data: f } = await sb.from('financas').select('owner_id').eq('id', financaId).maybeSingle();
            if (f?.owner_id === userId) return true;
            const { data: m } = await sb.from('financa_members').select('role').eq('financa_id', financaId).eq('user_id', userId).maybeSingle();
            return m?.role === 'admin';
        },
        async getFinanca(id) {
            const { data } = await sb.from('financas').select('name,emoji').eq('id', id).maybeSingle();
            return data ?? null;
        },
        async getInvite(financaId, email) {
            const { data } = await sb.from('financa_invites').select('id,accepted_at,expires_at,emailed_at,email_count')
                .eq('financa_id', financaId).ilike('email', email).maybeSingle();
            return data ? { ...data, email_count: data.email_count ?? 0 } : null;
        },
        async countRecentEmailsBy(userId, sinceIso) {
            const { count } = await sb.from('financa_invites').select('id', { count: 'exact', head: true })
                .eq('invited_by', userId).gte('emailed_at', sinceIso);
            return count ?? 0;
        },
        async sendEmail(m) {
            const r = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from, to: [m.to], subject: m.subject, html: m.html, text: m.text, reply_to: m.replyTo }),
            });
            return { ok: r.ok, status: r.status };
        },
        async markEmailed(inviteId) {
            const { data } = await sb.from('financa_invites').select('email_count').eq('id', inviteId).maybeSingle();
            await sb.from('financa_invites').update({ emailed_at: new Date().toISOString(), email_count: (data?.email_count ?? 0) + 1 }).eq('id', inviteId);
        },
    };

    const auth = req.headers.get('authorization') ?? '';
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
    let body: unknown = null;
    try { body = await req.json(); } catch { /* corpo inválido → 400 */ }
    try {
        const r = await handleSendInvite(deps, token, body);
        return json(r.body, r.status);
    } catch { return json({ error: 'internal' }, 500); }
});
