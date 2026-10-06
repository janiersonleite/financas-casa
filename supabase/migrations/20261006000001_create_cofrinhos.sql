-- Cofrinhos: objetivos de poupança (carro, viagem...) com extrato de depósitos
-- e retiradas. São independentes de `transactions`: não alteram o saldo do mês.
--
-- Escopo: cada cofrinho pertence a uma finança (financa_id) ou é pessoal
-- (financa_id NULL). Em finança compartilhada, qualquer membro vê, edita e
-- exclui; no modo pessoal, apenas o dono.
--
-- Como aplicar: cole este arquivo inteiro no SQL Editor do Supabase e execute
-- (é idempotente — pode rodar mais de uma vez).

-- ── Tabelas ───────────────────────────────────────────────────────────────────
create table if not exists public.cofrinhos (
    id            uuid primary key default gen_random_uuid(),
    financa_id    uuid references public.financas(id) on delete cascade,
    user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
    name          text not null check (char_length(btrim(name)) between 1 and 80),
    emoji         text not null default '🐷',
    color         text not null default '#1baf7a' check (color ~ '^#[0-9a-fA-F]{6}$'),
    category      text,
    target_amount numeric(14,2) not null default 0 check (target_amount >= 0),
    start_date    date not null default current_date,
    target_date   date,
    created_at    timestamptz not null default now(),
    constraint cofrinhos_dates_ok check (target_date is null or target_date >= start_date)
);

create table if not exists public.cofrinho_movs (
    id          uuid primary key default gen_random_uuid(),
    cofrinho_id uuid not null references public.cofrinhos(id) on delete cascade,
    user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
    kind        text not null check (kind in ('inicial', 'deposito', 'retirada')),
    amount      numeric(14,2) not null check (amount > 0),
    note        text,
    mov_date    date not null default current_date,
    created_at  timestamptz not null default now()
);

create index if not exists cofrinhos_financa_idx on public.cofrinhos (financa_id);
create index if not exists cofrinhos_user_idx    on public.cofrinhos (user_id);
create index if not exists cofrinho_movs_cof_idx on public.cofrinho_movs (cofrinho_id, mov_date desc);

-- ── Acesso ────────────────────────────────────────────────────────────────────
-- Pessoal (financa_id NULL): só o dono. Compartilhada: qualquer membro.
-- is_financa_member() vem de 20260423000005_financa_rls.sql.
create or replace function public.can_access_cofrinho(c_user uuid, c_financa uuid)
returns boolean language sql stable as $$
    select case
        when c_financa is null then c_user = auth.uid()
        else public.is_financa_member(c_financa)
    end;
$$;

alter table public.cofrinhos      enable row level security;
alter table public.cofrinho_movs  enable row level security;

drop policy if exists cofrinhos_select on public.cofrinhos;
drop policy if exists cofrinhos_insert on public.cofrinhos;
drop policy if exists cofrinhos_update on public.cofrinhos;
drop policy if exists cofrinhos_delete on public.cofrinhos;

create policy cofrinhos_select on public.cofrinhos for select
    using (public.can_access_cofrinho(user_id, financa_id));
create policy cofrinhos_insert on public.cofrinhos for insert
    with check (user_id = auth.uid() and (financa_id is null or public.is_financa_member(financa_id)));
create policy cofrinhos_update on public.cofrinhos for update
    using (public.can_access_cofrinho(user_id, financa_id))
    with check (public.can_access_cofrinho(user_id, financa_id));
create policy cofrinhos_delete on public.cofrinhos for delete
    using (public.can_access_cofrinho(user_id, financa_id));

-- Movimentações herdam o acesso do cofrinho. Não há policy de UPDATE de
-- propósito: para corrigir um lançamento, exclui-se e lança-se de novo.
drop policy if exists cofrinho_movs_select on public.cofrinho_movs;
drop policy if exists cofrinho_movs_insert on public.cofrinho_movs;
drop policy if exists cofrinho_movs_delete on public.cofrinho_movs;

create policy cofrinho_movs_select on public.cofrinho_movs for select
    using (exists (
        select 1 from public.cofrinhos c
        where c.id = cofrinho_id and public.can_access_cofrinho(c.user_id, c.financa_id)
    ));
create policy cofrinho_movs_insert on public.cofrinho_movs for insert
    with check (user_id = auth.uid() and exists (
        select 1 from public.cofrinhos c
        where c.id = cofrinho_id and public.can_access_cofrinho(c.user_id, c.financa_id)
    ));
create policy cofrinho_movs_delete on public.cofrinho_movs for delete
    using (exists (
        select 1 from public.cofrinhos c
        where c.id = cofrinho_id and public.can_access_cofrinho(c.user_id, c.financa_id)
    ));

grant select, insert, update, delete on public.cofrinhos     to authenticated;
grant select, insert, delete         on public.cofrinho_movs to authenticated;

-- Faz a API (PostgREST) enxergar as tabelas novas sem esperar o cache expirar.
notify pgrst, 'reload schema';
