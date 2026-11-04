-- Onda 1: favoritos de um toque (lançamento rápido). NOVA tabela privada de quem a criou. NÃO APLICADA: revisar antes.
--
-- O QUE FAZ
--   Cria public.favorite_entries: atalhos com NOME, TIPO (entrada | saida) e CATEGORIA, definidos pelo usuário. Nunca guarda valor
--   (o usuário digita o valor a cada uso). Por usuário E por carteira; máximo de 6 (entradas + saídas juntas) por (user_id, financa_id).
--
-- MODELO DE TIPO (reaproveitado, nada novo): o app representa o tipo de um lançamento em transactions.type com os ids fixos
--   'entrada' e 'saida' (VARCHAR(10), CHECK IN ('entrada','saida') na migration de criação); categories.type aceita
--   'entrada' | 'saida' | 'both'. O favorito usa a mesma coluna `type` e os mesmos dois valores. (Tipos personalizados
--   — transaction_types, ids 'ct…' — ficam fora desta onda: "entrada ou saída" foi a decisão de produto.)
--
-- SEGURANÇA
--   * RLS ligada; select/insert/update/delete SÓ do dono (user_id = auth.uid()) E com papel que pode lançar na carteira
--     (dono da carteira, admin ou membro). VISUALIZADOR não cria nem lê favoritos.
--   * WITH CHECK de insert/update: category_id, se informado, tem de ser da MESMA financa_id do favorito (anti-injeção entre
--     carteiras, como na Fase 2) e de tipo compatível (categoria 'both' ou igual ao tipo do favorito).
--   * Trigger rejeita o 7º favorito (conta entradas e saídas juntas) com trava por (user_id, financa_id) contra corrida.
--   * Trigger impede alterar user_id e financa_id.
--   * Sem acesso para anon; grants só para authenticated. Funções com search_path fixo.
--
-- O QUE PODE QUEBRAR
--   Nada existente: tabela e funções novas (public.can_write_financa é nova). Atenção: as policies de `transactions` (Fase 2) NÃO
--   checam papel (decisão D1: visualizador só é barrado na tela); aqui, por pedido, o banco barra o visualizador nos favoritos.
-- COMO REVERTER: docs/qa/rollback-favorite-entries.sql (apaga a tabela — e os favoritos — e as 3 funções novas).

create or replace function public.can_write_financa(fid uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.financas where id = fid and owner_id = auth.uid())
        or exists (select 1 from public.financa_members
                   where financa_id = fid and user_id = auth.uid() and role in ('admin', 'membro'));
$$;
revoke all on function public.can_write_financa(uuid) from public, anon;
grant execute on function public.can_write_financa(uuid) to authenticated;

create table if not exists public.favorite_entries (
    id          uuid primary key default gen_random_uuid(),
    financa_id  uuid not null references public.financas(id) on delete cascade,
    user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
    name        text not null,
    type        text not null,
    category_id uuid references public.categories(id) on delete set null,
    position    int  not null default 0,
    created_at  timestamptz not null default now(),
    constraint favorite_entries_name_len  check (char_length(btrim(name)) between 1 and 40),
    constraint favorite_entries_type_check check (type in ('entrada', 'saida'))
);

-- mesmo nome pode existir como entrada e como saída; não duplicado no mesmo tipo
create unique index if not exists favorite_entries_uniq
    on public.favorite_entries (user_id, financa_id, type, lower(btrim(name)));
create index if not exists favorite_entries_user_financa on public.favorite_entries (user_id, financa_id, position);

alter table public.favorite_entries enable row level security;

-- determinístico: remove QUALQUER policy existente (inclusive manuais) e recria só as 4
do $$
declare r record;
begin
    for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'favorite_entries' loop
        execute format('drop policy if exists %I on public.favorite_entries', r.policyname);
    end loop;
end $$;
drop policy if exists "favorite_entries_select" on public.favorite_entries;
drop policy if exists "favorite_entries_insert" on public.favorite_entries;
drop policy if exists "favorite_entries_update" on public.favorite_entries;
drop policy if exists "favorite_entries_delete" on public.favorite_entries;

create policy "favorite_entries_select" on public.favorite_entries for select to authenticated
    using (user_id = auth.uid() and public.can_write_financa(financa_id));

create policy "favorite_entries_insert" on public.favorite_entries for insert to authenticated
    with check (
        user_id = auth.uid() and public.can_write_financa(financa_id)
        and (category_id is null or exists (
            select 1 from public.categories c
            where c.id = favorite_entries.category_id
              and c.financa_id = favorite_entries.financa_id
              and coalesce(c.type, 'both') in ('both', favorite_entries.type)))
    );

create policy "favorite_entries_update" on public.favorite_entries for update to authenticated
    using (user_id = auth.uid() and public.can_write_financa(financa_id))
    with check (
        user_id = auth.uid() and public.can_write_financa(financa_id)
        and (category_id is null or exists (
            select 1 from public.categories c
            where c.id = favorite_entries.category_id
              and c.financa_id = favorite_entries.financa_id
              and coalesce(c.type, 'both') in ('both', favorite_entries.type)))
    );

create policy "favorite_entries_delete" on public.favorite_entries for delete to authenticated
    using (user_id = auth.uid() and public.can_write_financa(financa_id));

-- limite: no máximo 6 por (user_id, financa_id), entradas e saídas juntas
create or replace function public.favorite_entries_limit() returns trigger
language plpgsql set search_path = public as $$
begin
    perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || ':' || new.financa_id::text, 0));
    if (select count(*) from public.favorite_entries where user_id = new.user_id and financa_id = new.financa_id) >= 6 then
        raise exception 'limite de 6 favoritos por carteira (entradas e saídas juntas)' using errcode = 'check_violation';
    end if;
    return new;
end $$;

drop trigger if exists favorite_entries_limit_trigger on public.favorite_entries;
create trigger favorite_entries_limit_trigger before insert on public.favorite_entries
    for each row execute function public.favorite_entries_limit();

-- user_id e financa_id imutáveis
create or replace function public.favorite_entries_lock_keys() returns trigger
language plpgsql set search_path = public as $$
begin
    if new.user_id is distinct from old.user_id or new.financa_id is distinct from old.financa_id then
        raise exception 'favorite_entries.user_id e financa_id não podem ser alterados';
    end if;
    return new;
end $$;

drop trigger if exists favorite_entries_lock_keys_trigger on public.favorite_entries;
create trigger favorite_entries_lock_keys_trigger before update on public.favorite_entries
    for each row execute function public.favorite_entries_lock_keys();

-- grants: nada para anon/public; authenticated só o necessário
revoke all on public.favorite_entries from public, anon;
grant select, insert, update, delete on public.favorite_entries to authenticated;
