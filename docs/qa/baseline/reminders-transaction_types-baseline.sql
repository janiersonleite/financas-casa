-- BASELINE DOCUMENTAL — NÃO APLICAR. Reconstitui, a partir do catálogo de produção (26/10), tabelas/colunas que existem
-- lá sem migration no repositório. Serve para recriar um ambiente do zero. Sem dados.

create table if not exists public.reminders (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references auth.users(id) on delete cascade,
    financa_id   uuid references public.financas(id) on delete cascade,
    name         text not null,
    day          integer,
    amount       numeric,
    category     text,
    type         text,
    emoji        text,
    active       boolean default true,
    created_at   timestamptz default now(),
    notify_time  text,
    notify_date  date
);

create table if not exists public.transaction_types (
    id          uuid primary key default gen_random_uuid(),
    custom_id   text,
    name        text not null,
    behavior    text default 'neutro',
    emoji       text,
    color       text,
    user_id     uuid references auth.users(id) on delete cascade,
    financa_id  uuid references public.financas(id) on delete cascade,
    created_at  timestamptz default now(),
    no_person   boolean not null default false,
    invest_role text
);

-- colunas adicionadas à mão em tabelas que têm migration
alter table public.categories   add column if not exists financa_id uuid references public.financas(id) on delete cascade;
alter table public.transactions add column if not exists reminder_id text;
alter table public.transactions add column if not exists installment_group_id text;
alter table public.transactions add column if not exists installment_current integer;
alter table public.transactions add column if not exists installment_total integer;
alter table public.push_queue   add column if not exists due_ym text;
-- transactions em produção: type/category varchar (sem tamanho), description/notes text, SEM CHECK em type.
