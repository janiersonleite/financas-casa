-- Reproduz, no banco de teste, o ESTADO REAL DA PRODUÇÃO (levantado pelo catálogo do Postgres em 26/10),
-- que diverge das migrations do repositório por alterações manuais. Aplicado DEPOIS das migrations
-- existentes e ANTES das migrations de correção (202610270000NN). Só nomes de tabela/política/função:
-- nenhum dado real. Fatos de referência: F1–F7, F11, F12 e F14 (ver docs/qa/baseline/).

-- ── helper: remove TODAS as policies de uma tabela (o estado de produção é recriado do zero) ──────
create or replace function pg_temp.drop_all_policies(p_table text) returns void language plpgsql as $$
declare r record;
begin
    for r in select policyname from pg_policies where schemaname = 'public' and tablename = p_table loop
        execute format('drop policy %I on public.%I', r.policyname, p_table);
    end loop;
end $$;

-- ── F11: tabelas/colunas que só existem em produção ─────────────────────────────────────────────
alter table public.reminders
    add column if not exists amount numeric, add column if not exists type text, add column if not exists emoji text,
    add column if not exists active boolean default true, add column if not exists created_at timestamptz default now(),
    add column if not exists notify_time text, add column if not exists notify_date date;
alter table public.transaction_types
    add column if not exists custom_id text, add column if not exists emoji text, add column if not exists color text,
    add column if not exists created_at timestamptz default now(), add column if not exists no_person boolean not null default false,
    add column if not exists invest_role text;
alter table public.transaction_types alter column behavior set default 'neutro';

alter table public.categories add column if not exists financa_id uuid references public.financas(id) on delete cascade;
alter table public.categories add column if not exists no_person boolean not null default false;

-- transactions: colunas só de produção; sem CHECK em type; sem limite de tamanho
drop view if exists public.monthly_summary;
alter table public.transactions drop constraint if exists transactions_type_check;
alter table public.transactions
    add column if not exists reminder_id text, add column if not exists installment_group_id text,
    add column if not exists installment_current integer, add column if not exists installment_total integer;
alter table public.transactions alter column type type varchar, alter column category type varchar;
-- A10 (antes): view SEM security_invoker, legível por anon
create view public.monthly_summary as
    select user_id, to_char(date, 'YYYY-MM') as month,
           sum(case when type = 'entrada' then value else 0 end) as total_income,
           sum(case when type = 'saida' then value else 0 end) as total_expense,
           sum(case when type = 'entrada' then value else -value end) as balance,
           count(*) as transaction_count
      from public.transactions group by user_id, to_char(date, 'YYYY-MM');
grant select on public.monthly_summary to anon, authenticated, service_role;

-- ── F1: financa_members ────────────────────────────────────────────────────────────────────────
select pg_temp.drop_all_policies('financa_members');
create policy members_select on public.financa_members for select using (is_financa_member(financa_id));
create policy members_insert on public.financa_members for insert to public with check (auth.uid() is not null);
create policy members_delete on public.financa_members for delete using (user_id = auth.uid() or is_financa_admin(financa_id));

-- ── F2: financa_invites ────────────────────────────────────────────────────────────────────────
select pg_temp.drop_all_policies('financa_invites');
create policy invites_select on public.financa_invites for select using (is_financa_admin(financa_id) or my_invite_email_matches(email));
create policy invites_insert on public.financa_invites for insert with check (is_financa_admin(financa_id) and invited_by = auth.uid());
create policy invites_update on public.financa_invites for update
    using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) or is_financa_admin(financa_id));
create policy invites_delete on public.financa_invites for delete using (is_financa_admin(financa_id));

-- ── F3: transactions (4 atuais + 4 legadas *_own, todas permissivas) ───────────────────────────
select pg_temp.drop_all_policies('transactions');
create policy transactions_select on public.transactions for select
    using (user_id = auth.uid() or (financa_id is not null and is_financa_member(financa_id)));
create policy transactions_insert on public.transactions for insert
    with check (user_id = auth.uid() and (financa_id is null or is_financa_member(financa_id)));
create policy transactions_update on public.transactions for update
    using (user_id = auth.uid() or (financa_id is not null and is_financa_admin(financa_id)));          -- sem WITH CHECK
create policy transactions_delete on public.transactions for delete
    using (user_id = auth.uid() or (financa_id is not null and is_financa_admin(financa_id)));
create policy transactions_select_own on public.transactions for select to authenticated using (auth.uid() = user_id);
create policy transactions_insert_own on public.transactions for insert to authenticated with check (auth.uid() = user_id);
create policy transactions_update_own on public.transactions for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy transactions_delete_own on public.transactions for delete to authenticated using (auth.uid() = user_id);

-- ── F4: categories ─────────────────────────────────────────────────────────────────────────────
select pg_temp.drop_all_policies('categories');
create policy categories_select on public.categories for select using (user_id is null or user_id = auth.uid());
create policy "Users can read own or shared categories" on public.categories for select
    using (user_id = auth.uid() or financa_id in (select financa_id from public.financa_members where user_id = auth.uid()
                                                  union select id from public.financas where owner_id = auth.uid()));
create policy categories_insert on public.categories for insert with check (user_id = auth.uid());
create policy categories_update on public.categories for update using (user_id = auth.uid());              -- sem CHECK
create policy categories_delete on public.categories for delete using (user_id = auth.uid());

-- ── F5: reminders ──────────────────────────────────────────────────────────────────────────────
select pg_temp.drop_all_policies('reminders');
create policy "Users manage own reminders" on public.reminders for all using (auth.uid() = user_id);
create policy "Users can read own or shared reminders" on public.reminders for select
    using (auth.uid() = user_id or (financa_id is not null and is_financa_member(financa_id)));
create policy reminders_update_members on public.reminders for update
    using (financa_id is not null and is_financa_member(financa_id)) with check (financa_id is not null and is_financa_member(financa_id));
create policy reminders_delete_members on public.reminders for delete using (financa_id is not null and is_financa_member(financa_id));

-- ── F6: transaction_types ──────────────────────────────────────────────────────────────────────
select pg_temp.drop_all_policies('transaction_types');
create policy transaction_types_select on public.transaction_types for select
    using (user_id = auth.uid() or (financa_id is not null and is_financa_member(financa_id)));
create policy transaction_types_insert on public.transaction_types for insert with check (user_id = auth.uid());
create policy transaction_types_update on public.transaction_types for update using (user_id = auth.uid());   -- sem CHECK
create policy transaction_types_delete on public.transaction_types for delete using (user_id = auth.uid());

-- ── F7: financas ───────────────────────────────────────────────────────────────────────────────
select pg_temp.drop_all_policies('financas');
create policy financas_select on public.financas for select using (is_financa_member(id));
create policy financas_insert on public.financas for insert with check (true);
create policy financas_update on public.financas for update using (is_financa_admin(id));                    -- sem WITH CHECK
create policy financas_delete on public.financas for delete using (owner_id = auth.uid());

-- ── F11: user_pix (policy user_pix_all) ────────────────────────────────────────────────────────
select pg_temp.drop_all_policies('user_pix');
create policy user_pix_all on public.user_pix for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── F14: grants medidos ────────────────────────────────────────────────────────────────────────
-- anon e authenticated executam todas as funções do schema, exceto:
grant execute on all functions in schema public to anon, authenticated, service_role;
revoke execute on function public.claim_due_push(integer)  from public, anon, authenticated;
revoke execute on function public.cleanup_push_queue()     from public, anon, authenticated;
revoke execute on function public.register_push_subscription(text, text, text, text) from public, anon;
revoke execute on function public.sync_push_queue(text, jsonb)                      from public, anon;
