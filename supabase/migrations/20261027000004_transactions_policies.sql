-- [A3 / F3 / SEC-03] transactions: policies determinísticas, WITH CHECK de pertencimento, user_id imutável.
--
-- O QUE CORRIGE
--   Em produção existem as 4 policies atuais (transactions_select/insert/update/delete) E as 4 legadas permissivas
--   transactions_select_own / _insert_own / _update_own / _delete_own. As permissivas somam por OR e ANULAM a
--   checagem de membro: era possível inserir/mover lançamentos em carteira alheia. Além disso transactions_update
--   não tinha WITH CHECK e o user_id podia ser alterado.
--   Agora: remove TODAS as policies de transactions (inclusive manuais) e recria apenas 4:
--     select : dono OU membro da carteira
--     insert : user_id = auth.uid() E (sem carteira OU membro da carteira)
--     update : USING dono OU admin da carteira; WITH CHECK (pessoal do próprio) OU (carteira em que é membro)
--     delete : dono OU admin da carteira
--   + trigger que impede alterar user_id.
--
-- O QUE PODE QUEBRAR: mover lançamento para carteira onde você NÃO é membro (nenhum fluxo do app faz isso);
--   alterar user_id (inclusive pelo SQL Editor). Dono, membro e admin legítimos seguem como antes.
-- COMO REVERTER: recrie as policies de produção (select/insert/update/delete + *_own) — definições em
--   docs/qa/baseline/ — e: drop trigger if exists transactions_lock_user_id_trigger on public.transactions;
--   drop function if exists public.transactions_lock_user_id();

do $$
declare r record;
begin
    for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'transactions' loop
        execute format('drop policy if exists %I on public.transactions', r.policyname);
    end loop;
end $$;
-- (nomes exatos, para documentação e para o caso de a consulta acima não enxergar alguma)
drop policy if exists "transactions_select_own" on public.transactions;
drop policy if exists "transactions_insert_own" on public.transactions;
drop policy if exists "transactions_update_own" on public.transactions;
drop policy if exists "transactions_delete_own" on public.transactions;
drop policy if exists "transactions_select" on public.transactions;
drop policy if exists "transactions_insert" on public.transactions;
drop policy if exists "transactions_update" on public.transactions;
drop policy if exists "transactions_delete" on public.transactions;

create policy "transactions_select" on public.transactions for select
    using (user_id = auth.uid() or (financa_id is not null and public.is_financa_member(financa_id)));

create policy "transactions_insert" on public.transactions for insert
    with check (user_id = auth.uid() and (financa_id is null or public.is_financa_member(financa_id)));

create policy "transactions_update" on public.transactions for update
    using (user_id = auth.uid() or (financa_id is not null and public.is_financa_admin(financa_id)))
    with check (
        (financa_id is null and user_id = auth.uid())
        or (financa_id is not null and public.is_financa_member(financa_id))
    );

create policy "transactions_delete" on public.transactions for delete
    using (user_id = auth.uid() or (financa_id is not null and public.is_financa_admin(financa_id)));

create or replace function public.transactions_lock_user_id() returns trigger
language plpgsql set search_path = public as $$
begin
    if new.user_id is distinct from old.user_id then
        raise exception 'transactions.user_id não pode ser alterado';
    end if;
    return new;
end $$;

drop trigger if exists transactions_lock_user_id_trigger on public.transactions;
create trigger transactions_lock_user_id_trigger
    before update on public.transactions
    for each row execute function public.transactions_lock_user_id();
