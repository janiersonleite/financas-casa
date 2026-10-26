-- ROLLBACK DAS MIGRATIONS DE CORREÇÃO (202610270000NN) — devolve o banco ao ESTADO ANTERIOR DE PRODUÇÃO (INSEGURO).
-- Use só em emergência (ex.: um fluxo do app quebrou e não dá para esperar correção). Restaura policies, grants, view e remove os
-- gatilhos/CHECKs/funções criados pelas correções. NÃO apaga dados. Idempotente. Testado em tests/db/migrations-fix.test.js (ida e volta).
-- Depois do rollback, o front novo continua funcionando (o RPC accept_invite pode ficar; é inofensivo).

-- helper: remove TODAS as policies de uma tabela
create or replace function pg_temp.drop_all_policies(p_table text) returns void language plpgsql as $$
declare r record;
begin
    for r in select policyname from pg_policies where schemaname = 'public' and tablename = p_table loop
        execute format('drop policy %I on public.%I', r.policyname, p_table);
    end loop;
end $$;

-- gatilhos e CHECKs criados pelas correções
drop trigger if exists transactions_lock_user_id_trigger on public.transactions;
drop trigger if exists lock_user_id_trigger on public.categories;
drop trigger if exists lock_user_id_trigger on public.reminders;
drop trigger if exists lock_user_id_trigger on public.transaction_types;
drop trigger if exists financas_lock_owner_trigger on public.financas;
drop trigger if exists cofrinho_movs_lock_keys_trigger on public.cofrinho_movs;
alter table public.transactions      drop constraint if exists transactions_description_len;
alter table public.transactions      drop constraint if exists transactions_notes_len;
alter table public.categories        drop constraint if exists categories_name_len;
alter table public.reminders         drop constraint if exists reminders_name_len;
alter table public.transaction_types drop constraint if exists transaction_types_name_len;
alter table public.financas          drop constraint if exists financas_name_len;

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



-- cofrinho_movs_update como em produção (sem trava de colunas)
select pg_temp.drop_all_policies('cofrinho_movs');
create policy cofrinho_movs_select on public.cofrinho_movs for select
    using (exists (select 1 from public.cofrinhos c where c.id = cofrinho_id and public.can_access_cofrinho(c.user_id, c.financa_id)));
create policy cofrinho_movs_insert on public.cofrinho_movs for insert
    with check (user_id = auth.uid() and exists (select 1 from public.cofrinhos c where c.id = cofrinho_id and public.can_access_cofrinho(c.user_id, c.financa_id)));
create policy cofrinho_movs_update on public.cofrinho_movs for update
    using (exists (select 1 from public.cofrinhos c where c.id = cofrinho_id and public.can_access_cofrinho(c.user_id, c.financa_id)))
    with check (exists (select 1 from public.cofrinhos c where c.id = cofrinho_id and public.can_access_cofrinho(c.user_id, c.financa_id)));
create policy cofrinho_movs_delete on public.cofrinho_movs for delete
    using (exists (select 1 from public.cofrinhos c where c.id = cofrinho_id and public.can_access_cofrinho(c.user_id, c.financa_id)));

-- view e grants como em produção
alter view public.monthly_summary reset (security_invoker);
grant select on public.monthly_summary to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
revoke execute on function public.claim_due_push(integer)  from public, anon, authenticated;
revoke execute on function public.cleanup_push_queue()     from public, anon, authenticated;
revoke execute on function public.register_push_subscription(text, text, text, text) from public, anon;
revoke execute on function public.sync_push_queue(text, jsonb)                      from public, anon;

-- search_path e funções: pode permanecer (é só endurecimento); para reverter por função:
--   alter function public.is_financa_member(uuid) reset search_path;  (idem demais)
