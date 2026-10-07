# push-reminders — avisos de lembretes com o app fechado (Web Push)

O app grava na tabela `push_queue` os avisos futuros de cada lembrete. A cada minuto o
`pg_cron` chama esta função, que envia o que venceu via Web Push (Android, iPhone com o app
instalado, desktop). Sem custo extra: roda no plano gratuito do Supabase.

## Passo a passo (uma vez só)

### 1) Banco
No **SQL Editor** do Supabase, rode, nesta ordem, os arquivos (podem rodar mais de uma vez):
1. `supabase/migrations/20261007000001_push_notifications.sql`
2. `supabase/migrations/20261007000002_push_scale_hardening.sql` (limites por usuário, limpeza em blocos e índices)

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
(O nome da função define o endereço usado no passo 5: use o mesmo nome nos dois lugares, por exemplo `push-reminders` ou o que o painel gerar.)

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

**Recomendado — limpar o histórico do próprio agendador** (o `pg_cron` não apaga sozinho; sem isso são ~43 mil linhas por mês):

```sql
select cron.schedule('limpar-historico-cron', '0 3 * * *',
  $$ delete from cron.job_run_details where end_time < now() - interval '7 days'; $$);
```

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

## Escala (muitos usuários)
- O agendador é **1 chamada por minuto**, com 1 ou 100 mil usuários. Não vale restringir o horário
  (08–20h): economiza pouco e perderia lembretes marcados fora da janela.
- Cada execução reserva até 250 avisos por lote (2 lotes). Se o último lote vier cheio, ela **dispara outra
  execução encadeada** (até 40 por minuto, ≈ 20 mil avisos/minuto), porque cada execução tem limite de CPU.
- Lembretes **sem horário** avisam numa janela de 08:30 a 09:29 (minuto fixo por lembrete e usuário), para não
  concentrar tudo às 09:00. Lembretes **com horário** avisam exatamente no horário.
- Limpeza da fila 1 vez por hora (em blocos de 20 mil linhas, com índice).
- Limites por usuário: 20 carteiras com avisos pendentes, 1.500 avisos pendentes e 10 aparelhos.
- O plano gratuito do Supabase não é pensado para produto público (limites de usuários, banco de 500 MB e
  chamadas): para muitos usuários, considere o plano Pro.

## Como funciona (resumo técnico)
- `handler.ts` tem a lógica (lote, retentativas, limpeza de assinaturas mortas) sem dependências;
  `index.ts` só liga Supabase + `web-push`.
- Cada aviso é reservado com `claim_due_push` (`for update skip locked`): duas execuções
  simultâneas não enviam o mesmo aviso. Até 3 tentativas; avisos atrasados mais de 6 h são descartados.
- O app recalcula e substitui os avisos pendentes de cada carteira quando lembretes mudam, quando
  algo é marcado como pago e ao abrir o app. Horizonte: 45 dias.
