# Relatório QA/Segurança — Fase 2 (correções sobre o estado REAL da produção)

Branch `qa/fase-2-correcoes` (a partir de `qa/fase-1-testes`) · um commit por item · **sem push** · nada aplicado em produção.
Base: fatos F1–F15 levantados no catálogo de produção (ver `docs/qa/baseline/ESTADO-PRODUCAO.md`), reproduzidos em `tests/db/prod-state.sql`.
`npm test`: **99 testes, todos passando**. Sem as correções (`QA_FIXES=0`) os testes de banco falham (prova do "antes").
Migrations novas: `supabase/migrations/20261027000001…014` (determinísticas: removem as policies das tabelas afetadas por nome E por catálogo, recriam o conjunto
correto; idempotentes; testadas 2×, isoladas, em estado parcial fora de ordem, só-repositório e com policies manuais). Rollback testado: `docs/qa/baseline/rollback-estado-producao.sql`.

## Tabela
| ID | Achado | Estado | Arquivo(s) | Teste que prova | Risco de regressão |
|---|---|---|---|---|---|
| A1 [F1] | `members_insert` com `WITH CHECK (auth.uid() IS NOT NULL)`: qualquer logado vira admin de qualquer carteira | **CORRIGIDO** | `…000002_members_insert_admin_only` | `tests/db/fix-invites.test.js` (estranho, membro comum, ex-membro NÃO entram; dono criando carteira entra; admin adiciona) | Médio: o front **antigo** perde o aceite manual de convite (daí a ordem do deploy) |
| A2 [F2/F13] | Convidado reescreve `role`/`financa_id` do convite; aceite feito pelo cliente | **CORRIGIDO** | `…000001_accept_invite_rpc` (aditiva), `…000003_invites_update_admin_only`, `js/storage.js` (`acceptInvite` → RPC) | `fix-invites.test.js` (papel do convite, e-mail, confirmação, validade, anon) | Médio (ordem: RPC → front → policy) |
| A3 [F3/SEC-03] | 4 policies legadas `*_own` anulam a checagem; `update` sem WITH CHECK; `user_id` mutável | **CORRIGIDO** | `…000004_transactions_policies` | `fix-transactions.test.js` (alheia falha; dono/membro/admin/estranho seguem) | Baixo |
| A4 [F4/F5/F6] | categorias/lembretes/tipos: escrita não checa `financa_id` (injeção em carteira alheia) | **CORRIGIDO** | `…000005_shared_tables_policies` | `fix-shared.test.js` (3 tabelas: injeção, move, user_id; visibilidade e regras do app preservadas) | Médio-baixo: remove **todas** as policies dessas tabelas (inclui manuais) |
| A5 [F7] | admin troca `owner_id` e toma a carteira; `financas_insert (true)` | **CORRIGIDO** | `…000006_financas_owner_lock` | `fix-shared.test.js` (A5) | Baixo (transferir carteira exigirá desligar o trigger) |
| A6 [F9/SEC-02] | convite sem checar e-mail confirmado | **CORRIGIDO** (severidade baixa: "Confirm email" LIGADO) | `…000007_confirmed_email_invites` | `rls.test.js` teste 2 | Baixo |
| A7 [F8] | 8 funções sem `search_path` | **CORRIGIDO** | `…000008_secdef_search_path` | `rls.test.js` teste 10 | Baixo |
| A8 [F14] | `anon`/`authenticated` executam quase tudo | **CORRIGIDO** | `…000009_function_grants` | `fix-grants.test.js` (anon recusado; authenticated segue; helpers das policies preservados; RPCs reais) | Médio-baixo: RPC chamada sem login deixa de existir |
| A9 [SEC-07] | SSRF via endpoint de push | **CORRIGIDO** | `…000010_push_endpoint_allowlist`, `docs/qa/verificacao-push-hosts.sql` | `rls.test.js` teste 7 (7 hosts bons, 15 maliciosos) | **Médio**: lista restritiva (decisão sua, abaixo) |
| A10 | `monthly_summary` sem `security_invoker`, legível por anon | **CORRIGIDO** (front não usa) | `…000011_monthly_summary_security` | `fix-grants.test.js` (A10) | Nulo |
| A11 [F12] | `cofrinho_movs_update`: `user_id`/`kind`/`cofrinho_id` mutáveis | **CORRIGIDO** (policy mantida: o front edita movimentações) | `…000012_cofrinho_movs_update` | `fix-grants.test.js` (A11) | Baixo |
| A12 | `inserted_by_email` forjável | **ADIADO/documentado** (uso legítimo: importação e ajuste de autor) | `docs/qa/DECISOES.md` D3 | — | — |
| A13 | Estado real da produção | **FEITO** | `docs/qa/baseline/*` | `tests/db/prod-state.sql` | — |
| A14 | Sem limite de tamanho | **CORRIGIDO** (CHECK NOT VALID) | `…000013_length_checks`, `index.html` (maxlength), `js/app.js` (importação/salvar), `docs/qa/verificacao-limites.sql` | `fix-shared.test.js` (A14, inclui dado antigo + VALIDATE) | Baixo (UPDATE em linha antiga fora do limite falha até encurtar) |
| B1–B4 | XSS: 34 de texto livre + 22 de emoji; `_escHtml` sem `'`; emoji sem validação | **CORRIGIDO** | `js/utils.js` (`Utils.esc`, `cleanEmoji`), `js/app.js`, `js/cofrinhos.js` | `tests/static/xss-dynamic.test.js` (10 telas jsdom: payload vira texto), `xss-scan.test.js` (0 vulneráveis + guarda de regressão que FALHA com nova interpolação crua) | Médio-baixo (`&`, `<` agora aparecem como texto) |
| B5 | Cache dos scripts | **FEITO** (`?v=20261027a`; `sw.js` intocado, exceto o comentário da 1ª linha) | `index.html` | `misc.test.js` | — |
| C1 | `1.234,56` → 234,56; "1 mil" → 1; importação lê `1.500` como 1,5 | **CORRIGIDO** | `js/utils.js` `parseMoneyBR` (→ `null` se inválido), `js/nlp.js`, `js/app.js` | `tests/unit/money.test.js`, `nlp.test.js` | Baixo (ambíguos em DECISOES D4) |
| C2 | Parcelas somam ≠ total | **CORRIGIDO** | `Utils.splitMoney`, `js/app.js` | `money.test.js` (12 fixos + 500 aleatórios: soma === total) | Baixo |
| C3 | Ponto flutuante nos pontos marcados | **CORRIGIDO** (só os marcados) | `js/storage.js` `summarizeList`, `js/app.js` | `money.test.js` | Baixo |
| D1 | send-invite | **CORRIGIDO** | `supabase/functions/send-invite/*`, `…000014_mark_invite_emailed` | `tests/functions/send-invite.test.js`, `rls.test.js` 15 (20 chamadas paralelas = 20) | Baixo; **`index.ts` não roda em Deno aqui** (só o `handler.ts` é testado) |
| D2 | server.js | **CORRIGIDO** | `server.js` | `tests/static/misc.test.js` | Nulo (dev) |
| E1 | CDN sem versão/SRI | **CORRIGIDO** (5 scripts); Tailwind **ADIADO** | `index.html`, `scripts/verify-sri.js`, DECISOES D6 | `misc.test.js`; hashes recomputados de 2 hosts de registry | **Alto se o hash estiver errado**: rode `npm run verify:sri` com internet antes do merge |
| E2 | CSP | **PARCIAL**: proposta validada em Chromium (0 violações), **não ativada** | `docs/qa/csp-proposta.md` | harness local | — |
| E3 | CI | **FEITO** (`needs: test` no deploy) | `.github/workflows/test.yml`, `deploy.yml` | modo CI simulado localmente; o workflow em si **não foi executado** | Médio (CDN fora do ar bloqueia o deploy) |
| E4 | Marca | **CORRIGIDO** | `sw.js` (comentário), `package.json`, `manifest.json` | `misc.test.js` | Nulo |

## Achados NOVOS encontrados nesta fase
| ID | Achado | Tratado |
|---|---|---|
| N1 | `transactions_insert_own` (legada) permitia **inserir lançamento em carteira alheia** | A3 |
| N2 | `invites_update` permitia o convidado mudar `financa_id` do convite (levá-lo a outra carteira) | A2 |
| N3 | `deploy.yml` publica `path: '.'`: **`tests/`, `docs/qa/` (relatórios de vulnerabilidades) e `server.js` vão para o site público** | **NÃO alterado** — decisão sua |
| N4 | Em Postgres puro, `INSERT … RETURNING` em `financas` falha na policy de SELECT (`is_financa_member` não vê a linha nova); o app usa `.insert().select()` e funciona em produção ⇒ o SELECT de produção deve diferir do repo | A confirmar no catálogo (DECISOES D7); `financas_select` **não foi alterada** |
| N5 | `push-reminders/README.md` cita o identificador do projeto Supabase (público em `js/config.js`) | não alterado |

## Adiado
1. **Visualizador no banco** (decisão sua; desenho em DECISOES D1). 2. **Tailwind por build** e **CSP ativa**. 3. **MON-05** (`toISOString` em fusos UTC+) e **NLP-03** ("3 parcelas de 100"): fora do escopo. 4. **A12**: documentado, sem mudança.
