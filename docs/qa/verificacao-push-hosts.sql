-- Rode na PRODUÇÃO (somente leitura) ANTES da migration 20261020000004_push_endpoint_allowlist.sql.
-- Mostra de quais hosts de push vêm as assinaturas atuais. Esperado: só fcm.googleapis.com,
-- updates.push.services.mozilla.com, *.push.apple.com, *.notify.windows.com.
select split_part(endpoint, '/', 3) as host, count(*) as assinaturas
  from public.push_subscriptions
 group by 1
 order by 2 desc;

-- Assinaturas que a nova regra NÃO aceitaria (para decidir se a lista precisa de mais um host):
select id, user_id, split_part(endpoint, '/', 3) as host, last_seen_at
  from public.push_subscriptions
 where endpoint !~* '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)(:443)?/[^[:space:]\\]*$';
