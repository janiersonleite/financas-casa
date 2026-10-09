-- Web Push: não avisar de lembretes que já foram pagos (idempotente).
-- O servidor passa a conferir, NO MOMENTO DO ENVIO, se existe lançamento vinculado ao lembrete
-- (transactions.reminder_id) dentro do mês do vencimento. Vale para qualquer aparelho/pessoa:
-- se alguém da carteira pagou, ninguém recebe o aviso.

alter table public.push_queue add column if not exists due_ym text;   -- 'YYYY-MM' do vencimento

-- Avisos já na fila (sem due_ym): deduz o mês a partir do horário e do tipo (d2/d1/d0, fuso de Brasília)
update public.push_queue
   set due_ym = to_char((fire_at at time zone 'America/Sao_Paulo')
                        + (case when tag ~ '_d2$' then 2 when tag ~ '_d1$' then 1 else 0 end) * interval '1 day', 'YYYY-MM')
 where due_ym is null and sent_at is null;

-- Índice para a conferência (só se a coluna existir neste banco)
do $$
begin
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'transactions' and column_name = 'reminder_id') then
        execute 'create index if not exists transactions_reminder_id_idx on public.transactions (reminder_id) where reminder_id is not null';
    end if;
end $$;

-- sync_push_queue passa a guardar due_ym
create or replace function public.sync_push_queue(p_scope text, p_items jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer; v_scopes integer; v_total integer;
begin
    if auth.uid() is null then raise exception 'not authenticated'; end if;
    if coalesce(p_scope, '') = '' or length(p_scope) > 64 then raise exception 'invalid scope'; end if;
    if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then raise exception 'items must be an array'; end if;
    if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 500 then raise exception 'too many items'; end if;

    select count(distinct scope) into v_scopes
      from public.push_queue where user_id = auth.uid() and sent_at is null and scope <> p_scope;
    if v_scopes >= 20 then raise exception 'too many scopes'; end if;

    delete from public.push_queue
     where user_id = auth.uid() and scope = p_scope and sent_at is null;

    insert into public.push_queue (user_id, scope, reminder_id, fire_at, title, body, tag, action, due_ym)
    select auth.uid(), p_scope, left(x->>'reminder_id', 100), (x->>'fire_at')::timestamptz,
           left(coalesce(x->>'title', ''), 120), left(coalesce(x->>'body', ''), 300),
           left(coalesce(x->>'tag', x->>'reminder_id'), 100),
           case when x->>'action' in ('open-reminders', 'new-transaction') then x->>'action' else 'open-reminders' end,
           case when x->>'due_ym' ~ '^\d{4}-\d{2}$' then x->>'due_ym' else null end
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
     where (x->>'fire_at')::timestamptz > now() - interval '1 minute'
       and coalesce(x->>'reminder_id', '') <> ''
    on conflict (user_id, scope, reminder_id, tag, fire_at) do nothing;
    get diagnostics n = row_count;

    select count(*) into v_total from public.push_queue where user_id = auth.uid() and sent_at is null;
    if v_total > 1500 then raise exception 'queue limit exceeded'; end if;
    return n;
end $$;

-- claim_due_push: antes de reservar, descarta (result = 'paid') os avisos de lembretes já pagos
create or replace function public.claim_due_push(p_limit integer default 200)
returns setof public.push_queue
language plpgsql security definer set search_path = public as $$
begin
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'transactions' and column_name = 'reminder_id') then
        execute $q$
            update public.push_queue q
               set sent_at = now(), result = 'paid'
             where q.sent_at is null
               and q.fire_at <= now()
               and q.fire_at > now() - interval '6 hours'
               and q.due_ym ~ '^\d{4}-\d{2}$'
               and exists (select 1 from public.transactions t
                            where t.reminder_id::text = q.reminder_id
                              and t.date >= (q.due_ym || '-01')::date
                              and t.date <  ((q.due_ym || '-01')::date + interval '1 month'))
        $q$;
    end if;

    return query
    with u as (
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
        returning q.*)
    select * from u;
end $$;

revoke all on function public.sync_push_queue(text, jsonb) from public, anon;
grant  execute on function public.sync_push_queue(text, jsonb) to authenticated;
revoke all on function public.claim_due_push(integer) from public, anon, authenticated;
grant  execute on function public.claim_due_push(integer) to service_role;
