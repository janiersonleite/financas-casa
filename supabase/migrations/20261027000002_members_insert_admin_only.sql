-- [A1 / F1] financa_members: INSERT só para ADMIN da carteira.
--
-- O QUE CORRIGE
--   Em produção a policy members_insert era WITH CHECK (auth.uid() IS NOT NULL): qualquer usuário logado se
--   inseria como admin de qualquer carteira (estranho que descobre o UUID, ex-membro removido, convidado
--   "visualizador"). Agora: WITH CHECK (is_financa_admin(financa_id)). O dono da carteira é admin via
--   financas.owner_id, então "criar carteira" (Storage.createFinanca → se registra como admin) continua funcionando;
--   convidados entram pelas RPCs SECURITY DEFINER (auto_accept_my_invites / accept_invite / add_member_by_email).
--
-- DETERMINÍSTICA: remove TODAS as policies de INSERT de financa_members (inclusive com outro nome/manuais) e
--   recria uma só. Não há policy de UPDATE em financa_members (e continua sem).
--
-- ORDEM: aplicar DEPOIS do deploy do front que usa accept_invite (20261027000001).
-- O QUE PODE QUEBRAR: o front ANTIGO (aceite manual de convite pelo banner) — o aceite automático no login não muda.
-- COMO REVERTER (volta ao estado inseguro de produção):
--   drop policy if exists "members_insert" on public.financa_members;
--   create policy "members_insert" on public.financa_members for insert to public with check (auth.uid() is not null);

do $$
declare r record;
begin
    for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'financa_members' and cmd in ('INSERT', 'ALL') loop
        execute format('drop policy if exists %I on public.financa_members', r.policyname);
    end loop;
end $$;
drop policy if exists "members_insert" on public.financa_members;

create policy "members_insert" on public.financa_members for insert
    with check (public.is_financa_admin(financa_id));
