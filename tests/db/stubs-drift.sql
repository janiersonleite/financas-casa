-- SCHEMA DRIFT: estas tabelas existem em produção mas NÃO têm migration de criação
-- no repositório (foram criadas à mão no dashboard). Aqui só um stub MÍNIMO para
-- que as migrations seguintes possam rodar. Colunas/policies reais são desconhecidas.
create table if not exists public.transaction_types (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  financa_id uuid references public.financas(id) on delete cascade,
  custom_id text, name text, behavior text, emoji text, color text
);
create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  financa_id uuid references public.financas(id) on delete cascade,
  name text, day int, category text
);
alter table public.reminders enable row level security;
-- a migration 20260909000002 cita esta policy como já existente em produção:
create policy "Users manage own reminders" on public.reminders for all using (auth.uid() = user_id);
alter table public.transaction_types enable row level security;
