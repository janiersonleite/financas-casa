-- Chave PIX para aporte (Investimentos): passa a ficar na nuvem para aparecer em
-- todos os aparelhos do usuário. Uma linha por usuário e carteira (scope = id da
-- carteira ou 'personal'). Idempotente.
create table if not exists public.user_pix (
    user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
    scope      text not null,
    pix_key    text not null default '',
    name       text not null default '',
    bank       text not null default '',
    updated_at timestamptz not null default now(),
    primary key (user_id, scope)
);
alter table public.user_pix enable row level security;

drop policy if exists user_pix_all on public.user_pix;
create policy user_pix_all on public.user_pix for all to authenticated
    using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update, delete on public.user_pix to authenticated;
notify pgrst, 'reload schema';
