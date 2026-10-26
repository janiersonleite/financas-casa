-- [A8 / F14] Grants de EXECUTE: o mínimo necessário para cada função.
--
-- O QUE CORRIGE
--   Em produção anon e authenticated executam TODAS as funções do schema (exceto claim_due_push/cleanup_push_queue e,
--   para anon, register_push_subscription/sync_push_queue). Isso expõe RPCs SECURITY DEFINER do app a quem nem logou
--   e funções de trigger a qualquer um. Agora:
--     RPCs do app (add_member_by_email, auto_accept_my_invites, get_my_pending_invites, link_my_transactions_to_financa,
--       register_push_subscription, sync_push_queue, unregister_push_subscription, accept_invite):
--       REVOKE de public e anon; GRANT a authenticated (e service_role).
--     claim_due_push e cleanup_push_queue: só service_role (Edge Function push-reminders).
--     funções de trigger: REVOKE de public, anon e authenticated (o disparo do trigger não exige EXECUTE).
--   NÃO são revogadas: is_financa_member, is_financa_admin, can_access_cofrinho e my_invite_email_matches (as policies as
--   chamam com os direitos do usuário). Funções ausentes são ignoradas (idempotente).
--
-- O QUE PODE QUEBRAR: chamar essas RPCs SEM estar logado (o app só as usa logado). Edge Functions usam service_role.
-- COMO REVERTER: grant execute on all functions in schema public to anon, authenticated;  (e reaplique os revokes de
--   claim_due_push/cleanup_push_queue/register_push_subscription/sync_push_queue do estado anterior)

do $$
declare sig text;
begin
    -- RPCs do app: só usuário logado
    foreach sig in array array[
        'public.add_member_by_email(uuid, text, text)', 'public.auto_accept_my_invites()', 'public.get_my_pending_invites()',
        'public.link_my_transactions_to_financa(uuid)', 'public.register_push_subscription(text, text, text, text)',
        'public.sync_push_queue(text, jsonb)', 'public.unregister_push_subscription(text)', 'public.accept_invite(uuid)'
    ] loop
        if to_regprocedure(sig) is not null then
            execute format('revoke all on function %s from public, anon', sig);
            execute format('grant execute on function %s to authenticated, service_role', sig);
        end if;
    end loop;

    -- só a Edge Function (service_role)
    foreach sig in array array['public.claim_due_push(integer)', 'public.cleanup_push_queue()'] loop
        if to_regprocedure(sig) is not null then
            execute format('revoke all on function %s from public, anon, authenticated', sig);
            execute format('grant execute on function %s to service_role', sig);
        end if;
    end loop;

    -- funções de trigger: ninguém precisa executá-las diretamente
    foreach sig in array array[
        'public.financa_members_set_user()', 'public.financas_set_owner()', 'public.handle_updated_at()',
        'public.transactions_set_inserted_by()', 'public.update_updated_at_column()', 'public.transactions_lock_user_id()',
        'public.lock_row_user_id()', 'public.financas_lock_owner()'
    ] loop
        if to_regprocedure(sig) is not null then
            execute format('revoke all on function %s from public, anon, authenticated', sig);
            execute format('grant execute on function %s to service_role', sig);
        end if;
    end loop;
end $$;
