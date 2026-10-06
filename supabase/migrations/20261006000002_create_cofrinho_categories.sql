-- Categorias dos cofrinhos (criar / editar / excluir), por finança ou pessoais.
-- Substitui o campo de texto livre `cofrinhos.category` por uma referência
-- (`category_id`): renomear uma categoria vale para todos os cofrinhos dela e
-- excluir deixa os cofrinhos "sem categoria".
--
-- Requer 20261006000001_create_cofrinhos.sql já aplicada.
-- Como aplicar: cole este arquivo inteiro no SQL Editor do Supabase e execute
-- (é idempotente — pode rodar mais de uma vez).

-- ── Tabela ────────────────────────────────────────────────────────────────────
create table if not exists public.cofrinho_categories (
    id         uuid primary key default gen_random_uuid(),
    financa_id uuid references public.financas(id) on delete cascade,
    user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
    name       text not null check (char_length(btrim(name)) between 1 and 40),
    created_at timestamptz not null default now()
);

-- Nome único por escopo (finança ou, no modo pessoal, usuário), sem diferenciar
-- maiúsculas/minúsculas nem espaços nas pontas.
create unique index if not exists cofrinho_categories_name_uidx
    on public.cofrinho_categories (coalesce(financa_id, user_id), lower(btrim(name)));

alter table public.cofrinhos
    add column if not exists category_id uuid references public.cofrinho_categories(id) on delete set null;
create index if not exists cofrinhos_category_idx on public.cofrinhos (category_id);

-- ── Acesso (mesma regra dos cofrinhos) ────────────────────────────────────────
alter table public.cofrinho_categories enable row level security;

drop policy if exists cofrinho_categories_select on public.cofrinho_categories;
drop policy if exists cofrinho_categories_insert on public.cofrinho_categories;
drop policy if exists cofrinho_categories_update on public.cofrinho_categories;
drop policy if exists cofrinho_categories_delete on public.cofrinho_categories;

create policy cofrinho_categories_select on public.cofrinho_categories for select
    using (public.can_access_cofrinho(user_id, financa_id));
create policy cofrinho_categories_insert on public.cofrinho_categories for insert
    with check (user_id = auth.uid() and (financa_id is null or public.is_financa_member(financa_id)));
create policy cofrinho_categories_update on public.cofrinho_categories for update
    using (public.can_access_cofrinho(user_id, financa_id))
    with check (public.can_access_cofrinho(user_id, financa_id));
create policy cofrinho_categories_delete on public.cofrinho_categories for delete
    using (public.can_access_cofrinho(user_id, financa_id));

grant select, insert, update, delete on public.cofrinho_categories to authenticated;

-- ── Migra as categorias que já existiam como texto ────────────────────────────
-- Cria uma categoria para cada nome distinto (por escopo), liga os cofrinhos a
-- ela e remove a coluna antiga. Só roda se a coluna `category` ainda existir.
do $$
begin
    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'cofrinhos' and column_name = 'category'
    ) then
        insert into public.cofrinho_categories (financa_id, user_id, name)
        select distinct on (coalesce(c.financa_id, c.user_id), lower(btrim(c.category)))
               c.financa_id, c.user_id, btrim(c.category)
        from public.cofrinhos c
        where c.category is not null and btrim(c.category) <> ''
        order by coalesce(c.financa_id, c.user_id), lower(btrim(c.category)), c.created_at
        on conflict do nothing;

        update public.cofrinhos c
           set category_id = k.id
          from public.cofrinho_categories k
         where c.category_id is null
           and c.category is not null and btrim(c.category) <> ''
           and coalesce(k.financa_id, k.user_id) = coalesce(c.financa_id, c.user_id)
           and lower(btrim(k.name)) = lower(btrim(c.category));

        alter table public.cofrinhos drop column category;
    end if;
end $$;

-- Faz a API (PostgREST) enxergar a tabela/coluna nova sem esperar o cache expirar.
notify pgrst, 'reload schema';
