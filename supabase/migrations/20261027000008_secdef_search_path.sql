-- [A7 / F8] Fixa search_path = public nas 8 funções que ainda não tinham.
--
-- O QUE CORRIGE
--   is_financa_admin, is_financa_member, financa_members_set_user, financas_set_owner, handle_updated_at,
--   transactions_set_inserted_by (SECURITY DEFINER), can_access_cofrinho e update_updated_at_column rodavam sem
--   search_path fixo (um schema antes de "public" no search_path do chamador poderia sequestrar nomes de tabela/função).
--   Usa ALTER FUNCTION: corpo e assinatura permanecem IDÊNTICOS. Funções ausentes são ignoradas (idempotente).
--
-- O QUE PODE QUEBRAR: nada esperado (todas só referenciam public.* e auth.* qualificado). As funções SQL is_financa_* deixam
--   de ser "inlinadas" pelo planejador (custo marginal em consultas muito grandes).
-- COMO REVERTER (por função): alter function public.<nome>(<args>) reset search_path;

do $$
declare sig text;
begin
    foreach sig in array array[
        'public.is_financa_admin(uuid)', 'public.is_financa_member(uuid)', 'public.financa_members_set_user()',
        'public.financas_set_owner()', 'public.handle_updated_at()', 'public.transactions_set_inserted_by()',
        'public.can_access_cofrinho(uuid, uuid)', 'public.update_updated_at_column()'
    ] loop
        if to_regprocedure(sig) is not null then
            execute format('alter function %s set search_path = public', sig);
        end if;
    end loop;
end $$;
