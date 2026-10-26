-- [A5 / F7] financas: owner_id imutável, UPDATE com WITH CHECK e INSERT exigindo login.
--
-- O QUE CORRIGE
--   Em produção financas_update tinha USING is_financa_admin(id) e NENHUM WITH CHECK, e o trigger financas_set_owner
--   só roda BEFORE INSERT: um ADMIN (não dono) podia fazer UPDATE financas SET owner_id = <ele mesmo> e tomar a carteira.
--   financas_insert era WITH CHECK (true). Agora:
--     * trigger BEFORE UPDATE bloqueia qualquer mudança de owner_id (transferir dono, se um dia existir, será por função própria);
--     * financas_update: USING e WITH CHECK is_financa_admin(id);
--     * financas_insert: WITH CHECK (auth.uid() IS NOT NULL) (o trigger BEFORE INSERT continua forçando owner_id = auth.uid()).
--   Select/delete mantidos (membro vê; só o dono exclui). Remove TODAS as policies de INSERT/UPDATE de financas e recria.
--
-- O QUE PODE QUEBRAR: alterar owner_id (nenhum fluxo do app; no SQL Editor use `alter table public.financas disable trigger
--   financas_lock_owner_trigger` temporariamente se precisar transferir uma carteira).
-- COMO REVERTER:
--   drop trigger if exists financas_lock_owner_trigger on public.financas; drop function if exists public.financas_lock_owner();
--   drop policy if exists "financas_update" on public.financas; create policy "financas_update" on public.financas for update using (public.is_financa_admin(id));
--   drop policy if exists "financas_insert" on public.financas; create policy "financas_insert" on public.financas for insert with check (true);

create or replace function public.financas_lock_owner() returns trigger
language plpgsql set search_path = public as $$
begin
    if new.owner_id is distinct from old.owner_id then
        raise exception 'financas.owner_id não pode ser alterado';
    end if;
    return new;
end $$;

drop trigger if exists financas_lock_owner_trigger on public.financas;
create trigger financas_lock_owner_trigger before update on public.financas
    for each row execute function public.financas_lock_owner();

do $$
declare r record;
begin
    for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'financas' and cmd in ('INSERT', 'UPDATE', 'ALL') loop
        execute format('drop policy if exists %I on public.financas', r.policyname);
    end loop;
end $$;
drop policy if exists "financas_insert" on public.financas;
drop policy if exists "financas_update" on public.financas;

create policy "financas_insert" on public.financas for insert
    with check (auth.uid() is not null);
create policy "financas_update" on public.financas for update
    using (public.is_financa_admin(id))
    with check (public.is_financa_admin(id));
