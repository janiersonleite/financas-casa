# Roteiro de aplicação em produção — Fase 2

Você aplica tudo à mão (SQL Editor / painel). **Nada foi aplicado por mim.** Ordem obrigatória (as migrations são deterministicamente
idempotentes: se uma execução parar no meio, rode de novo; se já aplicou parte, aplique o resto na ordem).

## 1. Backup e pré-verificações
1. **Backup** (Database → Backups, ou `pg_dump` completo). Anote o horário.
2. Consultas de leitura (SQL Editor):
   - `docs/qa/verificacao-push-hosts.sql` → hosts de push em uso. Esperado: só `fcm.googleapis.com`, `updates.push.services.mozilla.com`,
     `*.push.apple.com`/`web.push.apple.com`, `*.notify.windows.com`. **Se aparecer outro host, não aplique a 000010 e me avise** (a lista é restritiva).
   - `docs/qa/verificacao-limites.sql` → contagem de textos já acima dos limites. Esperado: tudo 0 (senão, encurte antes — ver o arquivo).
   - Policies que serão SUBSTITUÍDAS (as migrations removem **todas** as policies destas tabelas e recriam o conjunto correto; se você criou
     alguma policy própria nelas, ela some):
     ```sql
     select tablename, policyname, cmd from pg_policies
      where schemaname='public' and tablename in ('financa_members','financa_invites','transactions','categories','reminders','transaction_types','financas','cofrinho_movs')
      order by 1, 3, 2;
     ```
     Compare com `docs/qa/baseline/ESTADO-PRODUCAO.md`. Qualquer policy fora da lista = me mostre antes de aplicar.

## 2. Migrations ADITIVAS (seguras antes do front)
| Arquivo | Efeito | Verificação depois | Reverter |
|---|---|---|---|
| `20261027000001_accept_invite_rpc.sql` | cria `accept_invite(uuid)` | `select has_function_privilege('anon','public.accept_invite(uuid)','execute'), has_function_privilege('authenticated','public.accept_invite(uuid)','execute');` → `false, true` | `drop function public.accept_invite(uuid);` |
| `20261027000014_mark_invite_emailed.sql` | cria `mark_invite_emailed(uuid)` (só service_role) | `select has_function_privilege('authenticated','public.mark_invite_emailed(uuid)','execute');` → `false` | `drop function public.mark_invite_emailed(uuid);` |

## 3. Deploy do front + Edge Function (usam as RPCs do passo 2)
1. Em uma máquina **com internet**: `npm ci && npm run verify:sri` → todas as linhas `OK` (SRI errado = script não carrega = app em branco; o ambiente de
   testes não alcançava o jsDelivr). O novo `deploy.yml` roda os testes e o mesmo check antes de publicar.
2. Merge da branch na `main` → o workflow `Deploy to GitHub Pages` roda `test` e só então publica.
3. **Edge Function `send-invite`** (painel → Edge Functions): substitua `handler.ts` e `index.ts` pelos de `supabase/functions/send-invite/`.
   **Verify JWT continua DESLIGADO.** Só depois do passo 2 (usa `mark_invite_emailed`).
4. Teste rápido: logar, convidar um e-mail novo (👥) → e-mail chega; aceitar convite com outra conta.

## 4. Migrations RESTRITIVAS (somente DEPOIS de o front novo estar no ar)
Aplique uma por vez, nesta ordem, e rode a verificação antes de seguir. **Reverter** = `docs/qa/baseline/rollback-estado-producao.sql` (devolve
policies/grants/view ao estado anterior; testado) ou o bloco "COMO REVERTER" do cabeçalho de cada arquivo.

| # | Arquivo | Item | Verificação (deve dar...) |
|---|---|---|---|
| 2 | `20261027000002_members_insert_admin_only.sql` | A1 | `select with_check from pg_policies where tablename='financa_members' and cmd='INSERT';` → `is_financa_admin(financa_id)` |
| 3 | `20261027000003_invites_update_admin_only.sql` | A2 | `select qual, with_check from pg_policies where tablename='financa_invites' and cmd='UPDATE';` → ambos `is_financa_admin(financa_id)` |
| 4 | `20261027000004_transactions_policies.sql` | A3 | `select policyname from pg_policies where tablename='transactions' order by 1;` → exatamente 4: `transactions_delete/insert/select/update` |
| 5 | `20261027000005_shared_tables_policies.sql` | A4 | `select tablename, count(*) from pg_policies where tablename in ('categories','reminders','transaction_types') group by 1;` → 4 cada |
| 6 | `20261027000006_financas_owner_lock.sql` | A5 | `select tgname from pg_trigger where tgname='financas_lock_owner_trigger';` → 1 linha |
| 7 | `20261027000007_confirmed_email_invites.sql` | A6 | `select prosrc ilike '%email_confirmed_at%' from pg_proc where proname='auto_accept_my_invites';` → `true` |
| 8 | `20261027000008_secdef_search_path.sql` | A7 | `select proname from pg_proc where pronamespace='public'::regnamespace and prosecdef and not exists (select 1 from unnest(coalesce(proconfig,'{}')) c where c like 'search_path=%');` → 0 linhas |
| 9 | `20261027000009_function_grants.sql` | A8 | `select has_function_privilege('anon','public.add_member_by_email(uuid,text,text)','execute');` → `false` |
| 10 | `20261027000010_push_endpoint_allowlist.sql` | A9 | logado: `select register_push_subscription('https://localhost/x','p','a');` → erro `invalid subscription` |
| 11 | `20261027000011_monthly_summary_security.sql` | A10 | `select reloptions from pg_class where oid='public.monthly_summary'::regclass;` → contém `security_invoker=true` |
| 12 | `20261027000012_cofrinho_movs_update.sql` | A11 | `select tgname from pg_trigger where tgname='cofrinho_movs_lock_keys_trigger';` → 1 linha |
| 13 | `20261027000013_length_checks.sql` | A14 | `select conname, convalidated from pg_constraint where conname like '%\_len';` → 6 linhas, `convalidated = false` |

**Depois da 13**, com `verificacao-limites.sql` em 0, rode os `VALIDATE CONSTRAINT` listados no fim daquele arquivo (um por vez).

## 5. Checklist de fumaça (celular e desktop)
- [ ] Criar carteira individual e **compartilhada** (aparece uma vez; você é admin)
- [ ] **Convidar** e-mail sem conta (e-mail chega) e e-mail com conta; **aceitar convite** (login automático e, se pendente, pelo banner) — o papel (membro/visualizador/admin) é o do convite
- [ ] **Remover membro**; **sair** da carteira; tentar voltar sem convite (deve falhar)
- [ ] **Lançar** gasto/entrada (texto e voz: "gastei 1.234,56 no mercado" = R$ 1.234,56); **mover lançamento** entre suas carteiras (deve funcionar) e tentar mover para carteira alheia (não é possível pela interface)
- [ ] **Parcelar** R$ 100 em 3× por valor total (prévia "R$ 33,34 + 2× de R$ 33,33", soma 100)
- [ ] Admin trocar o **autor** de um lançamento; membro comum não consegue editar o de outra pessoa
- [ ] **Cofrinho**: criar, depositar, **editar** movimentação, chave PIX de aporte
- [ ] **Lembrete** (criar/editar por outro membro da carteira) e **notificação push** (ativar em Chrome e, se possível, Safari/Firefox)
- [ ] **Categoria nova** e tipo novo com emoji; nome com `<b>` ou `&` aparece como texto
- [ ] Importar Excel (inclui valor `1.500`); Resumo por pessoa; exportar Excel/PDF
- [ ] Entrar como **visualizador** (hoje o papel continua só na interface — ADIADO)

## 6. Reversão
- **Banco:** `docs/qa/baseline/rollback-estado-producao.sql` (emergência; volta ao estado inseguro) e/ou o "COMO REVERTER" de cada migration (ordem inversa 13 → 2). Restore do backup do passo 1 em último caso.
- **Front:** `git revert -m 1 <merge>` e republicar (as migrations restritivas dependem do front novo: ao reverter o front, reverta antes as migrations 2 e 3, senão o aceite manual de convite pelo banner falha).
- **Edge Function:** republicar a versão anterior (a migration 14 pode ficar).
