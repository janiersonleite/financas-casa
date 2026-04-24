// ─── Supabase Configuration ───────────────────────────────────────────────────
// 1. Acesse https://supabase.com/dashboard → seu projeto → Settings → API
// 2. Preencha as duas variáveis abaixo e salve o arquivo

const SUPABASE_URL      = 'https://dvjjolhalgjooqnravqu.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Rtxb1VHEu3XWJzdLX-CBmA_3czrRhbM';

// ─── Detect if Supabase is configured ────────────────────────────────────────
const IS_SUPABASE_CONFIGURED =
    !SUPABASE_URL.includes('SEU_PROJETO') &&
    !SUPABASE_ANON_KEY.includes('SUA_ANON_KEY');

// ─── Initialize client ────────────────────────────────────────────────────────
window.$sb = null;
if (IS_SUPABASE_CONFIGURED) {
    try {
        const { createClient } = window.supabase;
        window.$sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: { persistSession: true, autoRefreshToken: true }
        });
    } catch (e) {
        console.error('Supabase init error:', e);
    }
}

console.info(IS_SUPABASE_CONFIGURED
    ? '✅ Supabase configurado'
    : '⚠️  Supabase não configurado — usando localStorage');
