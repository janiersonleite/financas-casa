-- Marca tipos de lançamento que NÃO devem ser atribuídos a uma pessoa
-- (ex.: "Retirado do investimento"). Usado no "Resumo por pessoa" para não
-- contabilizar esses lançamentos como gasto de ninguém.
alter table public.transaction_types
    add column if not exists no_person boolean not null default false;
