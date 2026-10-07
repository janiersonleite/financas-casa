-- Web Push: ajustes para muitos usuários (complementa 20261007000001; idempotente).
--   * limpeza em blocos e com índices (a função a executa 1x por hora);
--   * limites por usuário: carteiras, avisos pendentes e aparelhos.

create index if not exists push_queue_sent_idx on public.push_queue (sent_at) where sent_at is not null;

-- Limpeza em blocos de 20 mil (não trava a tabela). Repetida a cada hora.
create or replace function public.cleanup_push_queue() returns void
language plpgsql security definer set search_path = public as $$
begin
    delete from public.push_queue
     where id in (
        select id from public.push_queue
         where (sent_at is not null and sent_at < now() - interval '7 days')
            or (sent_at is null     and fire_at < now() - interval '1 day')
         limit 20000);
end $$;

-- sync_push_queue com limites por usuário
create or replace function public.sync_push_queue(p_scope text, p_items jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer; v_scopes integer; v_total integer;
begin
    if auth.uid() is null then raise exception 'not authenticated'; end if;
    if coalesce(p_scope, '') = '' or length(p_scope) > 64 then raise exception 'invalid scope'; end if;
    if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then raise exception 'items must be an array'; end if;
    if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 500 then raise exception 'too many items'; end if;

    -- no máximo 20 carteiras (escopos) com avisos pendentes por usuário
    select count(distinct scope) into v_scopes
      from public.push_queue where user_id = auth.uid() and sent_at is null and scope <> p_scope;
    if v_scopes >= 20 then raise exception 'too many scopes'; end if;

    delete from public.push_queue
     where user_id = auth.uid() and scope = p_scope and sent_at is null;

    insert into public.push_queue (user_id, scope, reminder_id, fire_at, title, body, tag, action)
    select auth.uid(), p_scope, left(x->>'reminder_id', 100), (x->>'fire_at')::timestamptz,
           left(coalesce(x->>'title', ''), 120), left(coalesce(x->>'body', ''), 300),
           left(coalesce(x->>'tag', x->>'reminder_id'), 100),
           case when x->>'action' in ('open-reminders', 'new-transaction') then x->>'action' else 'open-reminders' end
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
     where (x->>'fire_at')::timestamptz > now() - interval '1 minute'
       and coalesce(x->>'reminder_id', '') <> ''
    on conflict (user_id, scope, reminder_id, tag, fire_at) do nothing;
    get diagnostics n = row_count;

    -- no máximo 1.500 avisos pendentes por usuário (desfaz a chamada inteira se passar)
    select count(*) into v_total from public.push_queue where user_id = auth.uid() and sent_at is null;
    if v_total > 1500 then raise exception 'queue limit exceeded'; end if;
    return n;
end $$;

-- register_push_subscription: no máximo 10 aparelhos por usuário (mantém os mais recentes)
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
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
    on conflict (endpoint) do update
        set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
            user_agent = excluded.user_agent, last_seen_at = now();

    delete from public.push_subscriptions
     where user_id = auth.uid()
       and id not in (select id from public.push_subscriptions where user_id = auth.uid()
                       order by last_seen_at desc limit 10);
end $$;

revoke all on function public.cleanup_push_queue()                                  from public, anon, authenticated;
grant  execute on function public.cleanup_push_queue()                              to service_role;
revoke all on function public.sync_push_queue(text, jsonb)                          from public, anon;
grant  execute on function public.sync_push_queue(text, jsonb)                      to authenticated;
revoke all on function public.register_push_subscription(text, text, text, text)    from public, anon;
grant  execute on function public.register_push_subscription(text, text, text, text) to authenticated;
