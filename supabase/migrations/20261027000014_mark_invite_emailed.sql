-- Incremento ATÔMICO do contador de e-mails de convite (usado pela Edge Function send-invite).
--
-- O QUE FAZ: um único UPDATE ... SET email_count = email_count + 1 (em vez de ler e depois gravar), garantindo a contagem correta
--   mesmo com chamadas simultâneas.
-- O QUE PODE QUEBRAR: nada. Só service_role (a Edge Function) executa; usuários comuns não.
-- ORDEM: aplicar ANTES de publicar a nova versão da Edge Function send-invite.
-- COMO REVERTER: drop function if exists public.mark_invite_emailed(uuid);  (e republique a versão antiga da função)

create or replace function public.mark_invite_emailed(p_invite_id uuid) returns void
language sql security definer set search_path = public as $$
    update public.financa_invites
       set emailed_at = now(), email_count = coalesce(email_count, 0) + 1
     where id = p_invite_id;
$$;

revoke all on function public.mark_invite_emailed(uuid) from public, anon, authenticated;
grant execute on function public.mark_invite_emailed(uuid) to service_role;
