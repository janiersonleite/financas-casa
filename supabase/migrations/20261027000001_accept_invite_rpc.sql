-- RPC accept_invite — o aceite de convite passa a ser feito pelo SERVIDOR.
--
-- O QUE FAZ
--   Valida no banco (e-mail do convite = e-mail de quem aceita, e-mail confirmado, convite não aceito e não expirado), insere o novo
--   membro com o papel DO CONVITE e marca o convite como aceito. O app novo (Storage.acceptInvite) passa a chamar esta função.
--
-- ORDEM: arquivo ADITIVO (só cria uma função); aplicar ANTES do deploy do front novo.
-- O QUE PODE QUEBRAR: nada (função nova; o app antigo não a usa).
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
