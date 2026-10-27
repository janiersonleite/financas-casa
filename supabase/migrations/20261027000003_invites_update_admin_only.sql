-- [A2 / F2] financa_invites: UPDATE só para ADMIN da carteira (USING e WITH CHECK).
--
-- O QUE CORRIGE
--   Em produção invites_update tinha USING (e-mail do JWT = e-mail do convite OR is_financa_admin) e NENHUM
--   WITH CHECK: o convidado podia reescrever role (virar admin ao aceitar), financa_id (levar o convite para
--   outra carteira) e e-mail do próprio convite. O aceite agora é feito pela RPC accept_invite (SECURITY DEFINER).
--
-- DETERMINÍSTICA: remove TODAS as policies de UPDATE de financa_invites (qualquer nome) e recria uma só.
-- ORDEM: aplicar DEPOIS do deploy do front que usa accept_invite.
-- O QUE PODE QUEBRAR: o front ANTIGO (aceite manual de convite pelo banner faz update direto em financa_invites).
-- COMO REVERTER (volta ao estado inseguro):
--   drop policy if exists "invites_update" on public.financa_invites;
--   create policy "invites_update" on public.financa_invites for update
--       using (lower(email) = lower(auth.jwt() ->> 'email') or public.is_financa_admin(financa_id));

do $$
declare r record;
begin
    for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'financa_invites' and cmd in ('UPDATE', 'ALL') loop
        execute format('drop policy if exists %I on public.financa_invites', r.policyname);
    end loop;
end $$;
drop policy if exists "invites_update" on public.financa_invites;

create policy "invites_update" on public.financa_invites for update
    using (public.is_financa_admin(financa_id))
    with check (public.is_financa_admin(financa_id));
