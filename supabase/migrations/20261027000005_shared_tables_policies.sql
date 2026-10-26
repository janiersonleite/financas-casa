-- [A4 / F4 / F5 / F6] categories, reminders, transaction_types: escrita só em carteira onde você é membro.
--
-- O QUE CORRIGE
--   Em produção nada checava financa_id na ESCRITA: qualquer usuário logado podia criar categoria/lembrete/tipo
--   dentro da carteira de OUTRA pessoa (injeção de dados — vetor de XSS armazenado) e mover os próprios
--   registros para lá; os UPDATEs não tinham WITH CHECK; user_id podia ser trocado.
--   Agora, por tabela, remove TODAS as policies (inclusive as com espaço no nome e manuais) e recria 1 por comando:
--     categories       select: padrão (user_id null) OU próprio OU membro da carteira | insert/update: user_id = auth.uid() E
--                      (sem carteira OU membro) | delete: próprio  (só o criador altera, como hoje)
--     reminders        select: próprio OU membro | insert: user_id = auth.uid() E (sem carteira OU membro) |
--                      update/delete: próprio OU membro da carteira (recurso do app: membros editam/excluem lembretes da
--                      carteira); novo valor precisa ser "pessoal do dono" OU "carteira em que é membro"
--     transaction_types select: próprio OU membro | insert/update: user_id = auth.uid() E (sem carteira OU membro) | delete: próprio
--   + trigger que impede alterar user_id nas três tabelas.
--   A policy ALL "Users manage own reminders" é substituída pelas explícitas acima (mesmo acesso do dono).
--
-- O QUE PODE QUEBRAR: criar/mover registro para carteira onde você NÃO é membro (nenhum fluxo do app); policy manual
--   sua nessas tabelas será removida (as listadas acima são recriadas). Visibilidade e permissões atuais do app mantidas.
-- COMO REVERTER: recrie as policies de produção descritas em docs/qa/baseline/ e
--   drop trigger if exists lock_user_id_trigger on public.categories / public.reminders / public.transaction_types;
--   drop function if exists public.lock_row_user_id();

-- em produção a coluna já existe (criada à mão, sem migration); garante em ambientes só-repositório
alter table public.categories add column if not exists financa_id uuid references public.financas(id) on delete cascade;

create or replace function public.lock_row_user_id() returns trigger
language plpgsql set search_path = public as $$
begin
    if new.user_id is distinct from old.user_id then
        raise exception '%.user_id não pode ser alterado', tg_table_name;
    end if;
    return new;
end $$;

-- ── categories ──────────────────────────────────────────────────────────────────────────────────
do $$
declare r record;
begin
    for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'categories' loop
        execute format('drop policy if exists %I on public.categories', r.policyname);
    end loop;
end $$;
drop policy if exists "categories_select" on public.categories;
drop policy if exists "Users can read own or shared categories" on public.categories;
drop policy if exists "categories_insert" on public.categories;
drop policy if exists "categories_update" on public.categories;
drop policy if exists "categories_delete" on public.categories;

create policy "categories_select" on public.categories for select
    using (user_id is null or user_id = auth.uid() or (financa_id is not null and public.is_financa_member(financa_id)));
create policy "categories_insert" on public.categories for insert
    with check (user_id = auth.uid() and (financa_id is null or public.is_financa_member(financa_id)));
create policy "categories_update" on public.categories for update
    using (user_id = auth.uid())
    with check (user_id = auth.uid() and (financa_id is null or public.is_financa_member(financa_id)));
create policy "categories_delete" on public.categories for delete
    using (user_id = auth.uid());

drop trigger if exists lock_user_id_trigger on public.categories;
create trigger lock_user_id_trigger before update on public.categories for each row execute function public.lock_row_user_id();

-- ── reminders ───────────────────────────────────────────────────────────────────────────────────
do $$
declare r record;
begin
    for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'reminders' loop
        execute format('drop policy if exists %I on public.reminders', r.policyname);
    end loop;
end $$;
drop policy if exists "Users manage own reminders" on public.reminders;
drop policy if exists "Users can read own or shared reminders" on public.reminders;
drop policy if exists "reminders_update_members" on public.reminders;
drop policy if exists "reminders_delete_members" on public.reminders;
drop policy if exists "reminders_select" on public.reminders;
drop policy if exists "reminders_insert" on public.reminders;
drop policy if exists "reminders_update" on public.reminders;
drop policy if exists "reminders_delete" on public.reminders;

create policy "reminders_select" on public.reminders for select
    using (user_id = auth.uid() or (financa_id is not null and public.is_financa_member(financa_id)));
create policy "reminders_insert" on public.reminders for insert
    with check (user_id = auth.uid() and (financa_id is null or public.is_financa_member(financa_id)));
create policy "reminders_update" on public.reminders for update
    using (user_id = auth.uid() or (financa_id is not null and public.is_financa_member(financa_id)))
    with check ((financa_id is null and user_id = auth.uid()) or (financa_id is not null and public.is_financa_member(financa_id)));
create policy "reminders_delete" on public.reminders for delete
    using (user_id = auth.uid() or (financa_id is not null and public.is_financa_member(financa_id)));

drop trigger if exists lock_user_id_trigger on public.reminders;
create trigger lock_user_id_trigger before update on public.reminders for each row execute function public.lock_row_user_id();

-- ── transaction_types ───────────────────────────────────────────────────────────────────────────
do $$
declare r record;
begin
    for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'transaction_types' loop
        execute format('drop policy if exists %I on public.transaction_types', r.policyname);
    end loop;
end $$;
drop policy if exists "transaction_types_select" on public.transaction_types;
drop policy if exists "transaction_types_insert" on public.transaction_types;
drop policy if exists "transaction_types_update" on public.transaction_types;
drop policy if exists "transaction_types_delete" on public.transaction_types;

create policy "transaction_types_select" on public.transaction_types for select
    using (user_id = auth.uid() or (financa_id is not null and public.is_financa_member(financa_id)));
create policy "transaction_types_insert" on public.transaction_types for insert
    with check (user_id = auth.uid() and (financa_id is null or public.is_financa_member(financa_id)));
create policy "transaction_types_update" on public.transaction_types for update
    using (user_id = auth.uid())
    with check (user_id = auth.uid() and (financa_id is null or public.is_financa_member(financa_id)));
create policy "transaction_types_delete" on public.transaction_types for delete
    using (user_id = auth.uid());

drop trigger if exists lock_user_id_trigger on public.transaction_types;
create trigger lock_user_id_trigger before update on public.transaction_types for each row execute function public.lock_row_user_id();
