-- [A2 / F13] RPC accept_invite — o aceite de convite passa a ser feito pelo SERVIDOR.
--
-- O QUE CORRIGE
--   Storage.acceptInvite fazia upsert em financa_members e update em financa_invites direto pelo cliente, com
--   role fixo 'membro'. Isso depende de policies frouxas (members_insert "auth.uid() IS NOT NULL" e invites_update
--   sem WITH CHECK). Esta função valida tudo no servidor e usa o role DO CONVITE, nunca o do cliente.
--
-- ORDEM DE APLICAÇÃO: este arquivo é ADITIVO (só cria uma função) e deve ser aplicado ANTES do deploy do front
--   novo. As policies restritivas (20261027000002 e seguintes) vão DEPOIS do deploy.
--
-- O QUE PODE QUEBRAR: nada (função nova; o app antigo simplesmente não a usa).
-- COMO REVERTER: drop function if exists public.accept_invite(uuid);

create or replace function public.accept_invite(p_invite_id uuid) returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare v_email text; v_conf timestamptz; inv record;
begin
    if auth.uid() is null then raise exception 'not authenticated'; end if;
    select email, email_confirmed_at into v_email, v_conf from auth.users where id = auth.uid();
    if v_email is null or v_conf is null then raise exception 'email not confirmed'; end if;

    select * into inv from public.financa_invites
     where id = p_invite_id and lower(email) = lower(v_email)
       and accepted_at is null and (expires_at is null or expires_at > now())
     for update;
    if not found then raise exception 'invite not found'; end if;

    insert into public.financa_members (financa_id, user_id, email, role, invited_by)
    values (inv.financa_id, auth.uid(), lower(v_email), inv.role, inv.invited_by)
    on conflict (financa_id, user_id) do nothing;

    update public.financa_invites set accepted_at = now() where id = inv.id;
    return inv.financa_id;
end $$;

revoke all on function public.accept_invite(uuid) from public, anon;
grant execute on function public.accept_invite(uuid) to authenticated;
