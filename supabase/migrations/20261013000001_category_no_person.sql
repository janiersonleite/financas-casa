-- Categorias que não devem ser atribuídas a uma pessoa no "Resumo por pessoa"
-- (ex.: Receita Plano Cliente). Idempotente.
alter table public.categories add column if not exists no_person boolean not null default false;
