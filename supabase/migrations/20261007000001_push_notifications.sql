-- Web Push para os lembretes (avisos com o app FECHADO).
--
-- Como funciona:
--   1. O app (PWA) registra a "assinatura push" do aparelho em push_subscriptions.
--   2. O app calcula as próximas ocorrências dos lembretes e grava em push_queue
--      (RPC sync_push_queue) — a lógica de recorrência fica no app, o servidor só dispara.
--   3. Uma Edge Function (push-reminders), chamada a cada minuto pelo pg_cron, pega o que
--      venceu (claim_due_push) e envia via Web Push.
--
-- Idempotente: pode ser executada mais de uma vez.

-- ── Configuração pública (chave pública VAPID) ───────────────────────────────
create table if not exists public.app_settings (
    key   text primary key,
    value text not null
);
alter table public.app_settings enable row level security;

drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings
    for select to authenticated
    using (key in ('vapid_public_key'));
-- (sem policies de escrita: só o SQL Editor / service role grava)

-- ── Assinaturas push (uma por aparelho/navegador) ────────────────────────────
create table if not exists public.push_subscriptions (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references auth.users(id) on delete cascade,
    endpoint     text not null unique,
    p256dh       text not null,
    auth         text not null,
    user_agent   text,
    created_at   timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;

drop policy if exists push_subs_select on public.push_subscriptions;
drop policy if exists push_subs_delete on public.push_subscriptions;
create policy push_subs_select on public.push_subscriptions
    for select to authenticated using (user_id = auth.uid());
create policy push_subs_delete on public.push_subscriptions
    for delete to authenticated using (user_id = auth.uid());
-- Inserção/atualização só pela função register_push_subscription (abaixo).

-- ── Fila de avisos agendados ─────────────────────────────────────────────────
create table if not exists public.push_queue (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references auth.users(id) on delete cascade,
    scope       text not null,            -- id da finança (ou 'personal'): cada uma sincroniza separado
    reminder_id text not null,
    fire_at     timestamptz not null,
    title       text not null,
    body        text not null default '',
    tag         text not null,
    action      text not null default 'open-reminders',
    attempts    int  not null default 0,
    claimed_at  timestamptz,
    sent_at     timestamptz,
    result      text,                     -- ok | no_subscription | failed
    created_at  timestamptz not null default now(),
    unique (user_id, scope, reminder_id, tag, fire_at)
);
create index if not exists push_queue_due_idx on public.push_queue (fire_at) where sent_at is null;
alter table public.push_queue enable row level security;

drop policy if exists push_queue_select on public.push_queue;
create policy push_queue_select on public.push_queue
    for select to authenticated using (user_id = auth.uid());
-- Escrita só via sync_push_queue / service role.

-- ── RPC: registra (ou transfere) a assinatura deste aparelho para o usuário logado ─
create or replace function public.register_push_subscription(
    p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null then raise exception 'not authenticated'; end if;
    if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 2000
       or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
        raise exception 'invalid subscription';
    end if;
    -- O mesmo aparelho pode trocar de conta: a assinatura passa para quem está logado agora.
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
    on conflict (endpoint) do update
        set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
            user_agent = excluded.user_agent, last_seen_at = now();
end $$;

create or replace function public.unregister_push_subscription(p_endpoint text) returns void
language sql security invoker set search_path = public as $$
    delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

-- ── RPC: substitui os avisos AINDA NÃO ENVIADOS de um escopo ─────────────────
-- p_items: [{reminder_id, fire_at, title, body, tag, action}]
-- Avisos já enviados ficam (evita reenviar o mesmo se o app sincronizar de novo).
create or replace function public.sync_push_queue(p_scope text, p_items jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
    if auth.uid() is null then raise exception 'not authenticated'; end if;
    if coalesce(p_scope, '') = '' then raise exception 'scope required'; end if;
    if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then raise exception 'items must be an array'; end if;
    if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 500 then raise exception 'too many items'; end if;

    delete from public.push_queue
     where user_id = auth.uid() and scope = p_scope and sent_at is null;

    insert into public.push_queue (user_id, scope, reminder_id, fire_at, title, body, tag, action)
    select auth.uid(), p_scope, x->>'reminder_id', (x->>'fire_at')::timestamptz,
           left(coalesce(x->>'title', ''), 120), left(coalesce(x->>'body', ''), 300),
           left(coalesce(x->>'tag', x->>'reminder_id'), 100),
           case when x->>'action' in ('open-reminders', 'new-transaction') then x->>'action' else 'open-reminders' end
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
     where (x->>'fire_at')::timestamptz > now() - interval '1 minute'
       and coalesce(x->>'reminder_id', '') <> ''
    on conflict (user_id, scope, reminder_id, tag, fire_at) do nothing;

    get diagnostics n = row_count;
    return n;
end $$;

-- ── Uso exclusivo da Edge Function (service role) ────────────────────────────
-- Reserva avisos vencidos (até 6 h de atraso; até 3 tentativas), sem pegar o mesmo duas vezes.
create or replace function public.claim_due_push(p_limit integer default 200)
returns setof public.push_queue
language sql security definer set search_path = public as $$
    update public.push_queue q
       set attempts = q.attempts + 1, claimed_at = now()
     where q.id in (
            select id from public.push_queue
             where sent_at is null
               and fire_at <= now()
               and fire_at > now() - interval '6 hours'
               and attempts < 3
               and (claimed_at is null or claimed_at < now() - interval '5 minutes')
             order by fire_at
             limit greatest(1, least(coalesce(p_limit, 200), 500))
               for update skip locked)
    returning q.*;
$$;

-- Limpeza: avisos enviados há mais de 7 dias e vencidos que nunca saíram (>1 dia)
create or replace function public.cleanup_push_queue() returns void
language sql security definer set search_path = public as $$
    delete from public.push_queue
     where (sent_at is not null and sent_at < now() - interval '7 days')
        or (sent_at is null and fire_at < now() - interval '1 day');
$$;

revoke all on function public.claim_due_push(integer)  from public, anon, authenticated;
revoke all on function public.cleanup_push_queue()     from public, anon, authenticated;
grant execute on function public.claim_due_push(integer) to service_role;
grant execute on function public.cleanup_push_queue()    to service_role;

revoke all on function public.register_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.unregister_push_subscription(text)                from public, anon;
revoke all on function public.sync_push_queue(text, jsonb)                      from public, anon;
grant execute on function public.register_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.unregister_push_subscription(text)                 to authenticated;
grant execute on function public.sync_push_queue(text, jsonb)                       to authenticated;
