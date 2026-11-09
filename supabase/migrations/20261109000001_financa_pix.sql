-- Chave PIX COMPARTILHADA por carteira (Investir). NÃO APLICADA: revisar antes.
--
-- O QUE FAZ
--   Cria public.financa_pix (uma linha por carteira): todos os membros veem a mesma chave; quem pode lançar
--   (dono, admin, membro) cria/altera/exclui; visualizador só lê. A carteira "personal" continua em public.user_pix.
--   Copia, uma vez, as chaves já salvas em user_pix para carteiras (só se o autor ainda é dono/membro; não sobrescreve).
-- SEGURANÇA: RLS ligada; sem acesso para anon; updated_by gravado pelo servidor (default auth.uid()).
-- O QUE PODE QUEBRAR: nada existente (tabela nova; user_pix não é alterada).
-- COMO REVERTER: drop table public.financa_pix;  (user_pix segue intacta)
create table if not exists public.financa_pix (
    financa_id uuid primary key references public.financas(id) on delete cascade,
    pix_key    text not null default '',
    name       text not null default '',
    bank       text not null default '',
    updated_by uuid default auth.uid() references auth.users(id) on delete set null,
    updated_at timestamptz not null default now(),
    constraint financa_pix_len check (char_length(pix_key) <= 200 and char_length(name) <= 120 and char_length(bank) <= 80)
);
alter table public.financa_pix enable row level security;

do $$
declare r record;
begin
    for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'financa_pix' loop
        execute format('drop policy if exists %I on public.financa_pix', r.policyname);
    end loop;
end $$;

create policy financa_pix_select on public.financa_pix for select to authenticated
    using (exists (select 1 from public.financas f where f.id = financa_id and f.owner_id = auth.uid())
        or exists (select 1 from public.financa_members m where m.financa_id = financa_pix.financa_id and m.user_id = auth.uid()));
create policy financa_pix_insert on public.financa_pix for insert to authenticated
    with check (exists (select 1 from public.financas f where f.id = financa_pix.financa_id and f.owner_id = auth.uid())
        or exists (select 1 from public.financa_members m where m.financa_id = financa_pix.financa_id and m.user_id = auth.uid() and m.role in ('admin', 'membro')));
create policy financa_pix_update on public.financa_pix for update to authenticated
    using (exists (select 1 from public.financas f where f.id = financa_pix.financa_id and f.owner_id = auth.uid())
        or exists (select 1 from public.financa_members m where m.financa_id = financa_pix.financa_id and m.user_id = auth.uid() and m.role in ('admin', 'membro')))
    with check (exists (select 1 from public.financas f where f.id = financa_pix.financa_id and f.owner_id = auth.uid())
        or exists (select 1 from public.financa_members m where m.financa_id = financa_pix.financa_id and m.user_id = auth.uid() and m.role in ('admin', 'membro')));
create policy financa_pix_delete on public.financa_pix for delete to authenticated
    using (exists (select 1 from public.financas f where f.id = financa_pix.financa_id and f.owner_id = auth.uid())
        or exists (select 1 from public.financa_members m where m.financa_id = financa_pix.financa_id and m.user_id = auth.uid() and m.role in ('admin', 'membro')));

revoke all on public.financa_pix from anon, public;
grant select, insert, update, delete on public.financa_pix to authenticated;

-- cópia única do que já existia por usuário (a mais recente por carteira)
insert into public.financa_pix (financa_id, pix_key, name, bank, updated_by, updated_at)
select distinct on (f.id) f.id, p.pix_key, p.name, p.bank, p.user_id, p.updated_at
from public.user_pix p
join public.financas f on p.scope ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and f.id::text = p.scope
where (p.pix_key <> '' or p.name <> '' or p.bank <> '')
  and (f.owner_id = p.user_id or exists (select 1 from public.financa_members m where m.financa_id = f.id and m.user_id = p.user_id))
order by f.id, p.updated_at desc
on conflict (financa_id) do nothing;

notify pgrst, 'reload schema';
