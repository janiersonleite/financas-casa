# push-reminders — avisos de lembretes com o app fechado (Web Push)

O app grava na tabela `push_queue` os avisos futuros de cada lembrete. A cada minuto o
`pg_cron` chama esta função, que envia o que venceu via Web Push (Android, iPhone com o app
instalado, desktop). Sem custo extra: roda no plano gratuito do Supabase.

## Passo a passo (uma vez só)

### 1) Banco
No **SQL Editor** do Supabase, rode o arquivo
`supabase/migrations/20261007000001_push_notifications.sql` (pode rodar mais de uma vez).

### 2) Chaves VAPID
No seu computador (precisa do Node):

```bash
npx web-push generate-vapid-keys
```

Guarde as duas chaves. A **privada** nunca vai para o GitHub nem para o app.

Publique a chave **pública** (o app lê daqui; não precisa alterar código):

```sql
insert into public.app_settings (key, value)
values ('vapid_public_key', 'COLE_AQUI_A_CHAVE_PUBLICA')
on conflict (key) do update set value = excluded.value;
```

### 3) Segredos da função
Dashboard → **Edge Functions → Secrets** (ou `supabase secrets set ...`):

| Nome | Valor |
|---|---|
| `VAPID_PRIVATE_KEY` | a chave privada gerada acima |
| `VAPID_SUBJECT` | `mailto:seu-email@exemplo.com` |
| `CRON_SECRET` | uma senha longa e aleatória (ex.: `openssl rand -hex 32`) |

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já existem automaticamente.

### 4) Publicar a função
Com a CLI do Supabase (`supabase login` + `supabase link --project-ref dvjjolhalgjooqnravqu`):

```bash
supabase functions deploy push-reminders --no-verify-jwt
```

`--no-verify-jwt` é necessário: quem chama é o `pg_cron`, e a proteção é o cabeçalho
`x-cron-secret`.

### 5) Agendar a cada minuto
Dashboard → **Database → Extensions**: ative **pg_cron** e **pg_net**. Depois, no SQL Editor
(troque `SEU_CRON_SECRET` pelo mesmo valor do passo 3):

```sql
select cron.schedule(
  'push-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://dvjjolhalgjooqnravqu.supabase.co/functions/v1/push-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'SEU_CRON_SECRET'),
    body    := '{}'::jsonb
  );
  $$
);
```

Para parar: `select cron.unschedule('push-reminders');`

### 6) Conferir no app
Abra o app (instalado na tela inicial) → **Lembretes** → **Ativar avisos neste aparelho** →
**Enviar teste**. Feche o app: em 1–2 minutos chega "✅ Avisos funcionando!".

> **iPhone:** só funciona com o app instalado (Compartilhar → Adicionar à Tela de Início, iOS 16.4+)
> e aberto por esse ícone. A permissão é pedida ao tocar em "Ativar".

## Diagnóstico

```sql
-- o cron está rodando?
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
-- respostas da função
select status_code, content::text from net._http_response order by created desc limit 5;
-- fila de avisos
select fire_at, title, attempts, sent_at, result from public.push_queue order by fire_at desc limit 20;
-- aparelhos cadastrados
select user_id, left(endpoint, 50) as endpoint, last_seen_at from public.push_subscriptions;
```

- `401` na resposta → `CRON_SECRET` diferente entre a função e o `cron.schedule`.
- `500 vapid_public_key ausente` → falta o passo 2.
- `result = no_subscription` → o aparelho não está cadastrado (ative de novo no app).
- Assinaturas que o serviço de push informa como expiradas (404/410) são removidas sozinhas.

## Como funciona (resumo técnico)
- `handler.ts` tem a lógica (lote, retentativas, limpeza de assinaturas mortas) sem dependências;
  `index.ts` só liga Supabase + `web-push`.
- Cada aviso é reservado com `claim_due_push` (`for update skip locked`): duas execuções
  simultâneas não enviam o mesmo aviso. Até 3 tentativas; avisos atrasados mais de 6 h são descartados.
- O app recalcula e substitui os avisos pendentes de cada carteira quando lembretes mudam, quando
  algo é marcado como pago e ao abrir o app. Horizonte: 45 dias.
