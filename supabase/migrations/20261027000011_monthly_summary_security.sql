-- [A10] View monthly_summary: security_invoker e sem acesso anônimo.
--
-- O QUE CORRIGE
--   A migration original define a view com security_invoker, mas em produção ela está SEM essa opção (executa com os direitos do
--   dono e ignora a RLS de transactions) e legível por anon. O front NÃO usa esta view (verificado por grep em js/ e index.html).
--   Agora: ALTER VIEW ... SET (security_invoker = true) (a RLS de transactions passa a valer) e REVOKE de anon/public.
--
-- O QUE PODE QUEBRAR: quem consultasse a view como anon, ou esperasse totais de OUTROS usuários (nada no app faz isso).
-- COMO REVERTER: alter view public.monthly_summary reset (security_invoker); grant select on public.monthly_summary to anon, authenticated;

do $$
begin
    if to_regclass('public.monthly_summary') is not null then
        alter view public.monthly_summary set (security_invoker = true);
        revoke all on public.monthly_summary from public, anon;
        grant select on public.monthly_summary to authenticated, service_role;
    end if;
end $$;
