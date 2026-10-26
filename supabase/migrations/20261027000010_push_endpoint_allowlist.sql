-- [A9 / SEC-07] register_push_subscription: o endpoint só pode ser de um serviço de push conhecido.
--
-- O QUE CORRIGE
--   O endpoint só precisava começar com "https://": dava para registrar https://169.254.169.254/..., localhost, IPs privados etc., e a
--   Edge Function push-reminders faria POST nesses endereços (SSRF cego). Agora o host precisa ser (porta padrão 443, sem usuário/senha):
--     fcm.googleapis.com                (Chrome, Edge, Opera, Brave, Samsung — FCM)
--     updates.push.services.mozilla.com (Firefox)
--     web.push.apple.com e *.push.apple.com (Safari / iOS PWA)
--     *.notify.windows.com              (Windows / Edge legado)
--   IPs, localhost, portas diferentes de 443, "user@host" e domínios parecidos são rejeitados. Mantém o limite de 10 aparelhos por usuário.
--
-- O QUE PODE QUEBRAR: navegador com serviço de push fora da lista não ativa notificações; assinaturas JÁ gravadas não são apagadas nem
--   revalidadas. ANTES de aplicar, rode docs/qa/verificacao-push-hosts.sql (lista os hosts em uso) e me avise se houver host fora da lista.
-- COMO REVERTER: reaplicar o corpo de register_push_subscription de 20261007000002_push_scale_hardening.sql (só exige '^https://').

create or replace function public.register_push_subscription(
    p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null then raise exception 'not authenticated'; end if;
    if p_endpoint is null or length(p_endpoint) > 2000
       or p_endpoint !~* '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)(:443)?/[^[:space:]\\]*$'
       or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
        raise exception 'invalid subscription';
    end if;
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
    on conflict (endpoint) do update
        set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
            user_agent = excluded.user_agent, last_seen_at = now();

    -- no máximo 10 aparelhos por usuário (mantém os mais recentes)
    delete from public.push_subscriptions
     where user_id = auth.uid()
       and id not in (select id from public.push_subscriptions where user_id = auth.uid()
                       order by last_seen_at desc limit 10);
end $$;

revoke all on function public.register_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.register_push_subscription(text, text, text, text) to authenticated;
