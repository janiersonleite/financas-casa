# Estado real da produção (levantado pelo catálogo do Postgres em 26/10) — baseline documental

Só nomes de tabelas, políticas e funções; **nenhum dado**. Reproduzido nos testes por `tests/db/prod-state.sql`. Onde o repositório diverge,
**prevalece o que está aqui**. As migrations `20261027000001…013` partem deste estado e o corrigem de forma determinística.

## Policies (RLS) — antes das correções
| Tabela | Policies em produção | Problema | Corrigido em |
|---|---|---|---|
| `financa_members` | `members_select`, `members_insert` (INSERT, roles public, `WITH CHECK (auth.uid() IS NOT NULL)`), `members_delete`. **Sem UPDATE.** | qualquer logado se insere como admin | A1 (…002) |
| `financa_invites` | `invites_select`, `invites_insert`, `invites_update` (USING e-mail do JWT OU admin, **sem WITH CHECK**), `invites_delete` | convidado reescreve `role`/`financa_id` | A2 (…001 RPC, …003) |
| `transactions` | `transactions_select/insert/update/delete` (membro/admin) **+ legadas** `transactions_select_own`, `_insert_own`, `_update_own`, `_delete_own` (permissivas); `update` sem WITH CHECK | legadas anulam a checagem de membro | A3 (…004) |
| `categories` | `categories_select`, `"Users can read own or shared categories"`, `categories_insert` (CHECK user_id), `categories_update` (sem CHECK), `categories_delete` | nada checa `financa_id` na escrita | A4 (…005) |
| `reminders` | `"Users manage own reminders"` (ALL), `"Users can read own or shared reminders"`, `reminders_update_members`, `reminders_delete_members` | ALL sem checar `financa_id` | A4 (…005) |
| `transaction_types` | insert (CHECK user_id), update (sem CHECK), delete próprio, select próprio/compartilhado | nada checa `financa_id` na escrita | A4 (…005) |
| `financas` | `financas_insert` (`WITH CHECK (true)`), `financas_update` (USING admin, **sem WITH CHECK**); trigger `financas_set_owner` só BEFORE INSERT | admin troca `owner_id` | A5 (…006) |
| `cofrinhos`, `cofrinho_categories` | conferem com o repositório | — | — |
| `cofrinho_movs` | inclui `cofrinho_movs_update` (o repo original dizia que a ausência era proposital; o front agora edita movimentações) | `user_id`/`kind` mutáveis | A11 (…012) |
| `user_pix` | `user_pix_all` (ALL, authenticated, `user_id = auth.uid()`) | — | — |

## Constraints
- **CHECK de `role` JÁ EXISTE** em `financa_members` e `financa_invites` (`admin`, `membro`, `visualizador`) — não foi criado outro (F10). `financas.type` também tem CHECK.
- `transactions.type` **sem CHECK** (guarda ids de tipos customizados): mantido assim. Sem limite de tamanho em textos → A14 (NOT VALID).

## Funções e grants
- SECURITY DEFINER **sem `search_path`**: `is_financa_admin`, `is_financa_member`, `financa_members_set_user`, `financas_set_owner`, `handle_updated_at`, `transactions_set_inserted_by`; também sem: `can_access_cofrinho`, `update_updated_at_column` → A7 (…008).
- `auto_accept_my_invites`, `get_my_pending_invites`, `my_invite_email_matches` não checavam `email_confirmed_at` → A6 (…007). Produção: **"Confirm email" ligado** (26/10).
- EXECUTE: `anon` e `authenticated` executavam todas as funções do schema, exceto `claim_due_push` e `cleanup_push_queue` (bloqueadas para ambos) e `register_push_subscription`/`sync_push_queue` (bloqueadas para `anon`) → A8 (…009).
- View `monthly_summary` (`user_id, month, total_income, total_expense, balance, transaction_count`): sem `security_invoker`, legível por `anon`; **não usada pelo front** → A10 (…011).

## Tabelas/colunas SEM migration no repositório (criadas à mão)
Ver `reminders-transaction_types-baseline.sql` (documental; **não aplicar**). Inclui `reminders`, `transaction_types`, `categories.financa_id`,
colunas extras de `transactions` (`reminder_id`, `installment_*`) e `push_queue.due_ym`.
`user_pix` já tem migration (`20261019000002`).

## Observação sobre o teste local
No banco de teste (Postgres 16 puro) `INSERT ... RETURNING` em `financas` falha na policy de SELECT (`is_financa_member` não enxerga a linha recém-inserida
dentro do mesmo comando). O app usa `.insert().select().single()` ao criar carteira e funciona em produção, o que sugere que a policy de SELECT de
`financas` em produção difere da do repositório (ex.: inclui `owner_id = auth.uid()`). **Não alterei `financas_select`**; vale conferir no catálogo.
