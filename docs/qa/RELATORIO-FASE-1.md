# Relatório QA/Segurança — Fase 1 (somente testes e diagnóstico)

Projeto: Minhas Carteiras (`financas-casa`) · Branch: `qa/fase-1-testes` · Data: 2026-10-20
Escopo da Fase 1: **nenhum arquivo de produção foi alterado** (`js/*.js`, `index.html`, `sw.js`, migrations, workflow). Nenhuma conexão com o Supabase de produção foi feita; tudo roda em banco local.

## Como rodar

```bash
npm install
npm test                # tudo (≈ 6 s) + resumo dos achados
npm run test:db         # RLS / funções SQL (Postgres local)
npm run test:functions  # handlers das Edge Functions
npm run test:unit       # nlp.js, dinheiro, datas
npm run test:static     # scanner/prova de XSS, CDN/CSP, server.js, marca
npm run test:resumo     # reimprime os achados (tests/_out/*.json)
```

- **Banco**: Postgres 16 puro e descartável (sobe sozinho em `127.0.0.1`, porta aleatória; usa `TEST_DATABASE_URL` se definido — recusa hosts que não sejam localhost). Não foi possível usar `supabase start` (Docker instalado, mas sem daemon neste ambiente). O stub do ambiente Supabase está em `tests/db/stubs.sql` (schema `auth`, `auth.uid()/jwt()`, roles `anon/authenticated/service_role`, privilégios padrão como no Supabase).
- **Convenção dos testes de segurança**: um teste que **confirma uma falha não quebra o runner**; ele registra o achado (`[BUG-CONFIRMADO]`, `[PARCIAL]`, `[NAO-CONFIRMADO]`, `[INFO]`) no console e em `tests/_out/*.json`. Já os testes de comportamento esperado (ex.: "estranho não lê dados de A") **falham de verdade** se regredirem.
- Dependências novas (apenas dev): `pg`, `jsdom`. Alterações fora de `tests/` e `docs/`: `package.json` (scripts + devDependencies) e `.gitignore` (+ `tests/_out/`).

## Resultado em números

- **62 testes executados, 62 passando** (os achados não derrubam o runner).
- Achados: **28 CONFIRMADOS · 10 PARCIAIS · 5 NÃO CONFIRMADOS · 4 informativos**.
- Por severidade (linhas da tabela abaixo, agrupando IDs relacionados): **Alta 3 · Média 11 · Baixa 11 · Info 2**.

## Suspeitas do pedido original — o que se confirmou

| Suspeita | Resultado |
|---|---|
| `members_insert`: estranho se auto-insere como admin | **CONFIRMADO** (SEC-01/01b). Role arbitrário (`'xpto'`) é barrado pelo CHECK; `'admin'` passa. |
| `auto_accept_my_invites` com e-mail não confirmado | **PARCIAL** (SEC-02): no SQL entra (inclusive como admin); só é explorável se o Auth do projeto aceitar sessão sem confirmação de e-mail. |
| `transactions_update` sem WITH CHECK (mover para carteira alheia) | **CONFIRMADO** (SEC-03). |
| Isolamento geral do estranho (8 tabelas) | **NÃO CONFIRMADO** — isolamento ok (SEC-04). |
| Membro comum não administra | **NÃO CONFIRMADO** (SEC-05) — ok. |
| `add_member_by_email` nega não-admin | **NÃO CONFIRMADO** (SEC-06) — ok. |
| `register_push_subscription` aceita endpoints internos | **CONFIRMADO** (SEC-07). |
| `sync_push_queue` limites e isolamento | **NÃO CONFIRMADO** (SEC-08) — limites 500/20/1500 funcionam. |
| `claim_due_push` / `cleanup_push_queue` só service_role | **NÃO CONFIRMADO** (SEC-09) — ok. |
| SECURITY DEFINER sem `search_path` | **PARCIAL** (SEC-10): 6 de 15 funções sem; mitigado porque `authenticated` não tem CREATE no schema `public` (PG ≥ 15). |
| Policies duplicadas em `transactions` | **CONFIRMADO** (SEC-11): pares `transactions_*` e `transactions_*_own` (as `_own` são subconjunto; redundantes, não ampliam acesso). |
| XSS (linhas apontadas por você) | **CONFIRMADO** para as linhas de texto livre; 2286 e 5892/6388 **não** são XSS (ver XSS-S1). |
| "1.234,56 vira 1.23" | **Diferente do descrito**: sem "R$"/"reais" vira **234,56** (NLP-01). Com "R$" ou "reais" funciona. |

## Achados

Severidade: **Alta** = exploração real com impacto em dados/contas de outras pessoas · **Média** = falha concreta mas com pré-condição ou impacto limitado · **Baixa** = endurecimento/robustez · **Info** = observação.

| ID | Achado | Sev. | Status | Evidência | Correção sugerida (Fase 2) |
|---|---|---|---|---|---|
| SEC-01 | Qualquer usuário autenticado insere a si mesmo como **admin** de qualquer carteira (policy `members_insert`: `is_financa_admin(...) OR user_id = auth.uid()`). Lê todas as transações e edita a carteira. Pré-condição: conhecer o UUID da carteira. | **Alta** | CONFIRMADO | `tests/db/rls.test.js` teste 1 · `supabase/migrations/20260423000005_financa_rls.sql` (`members_insert`) | Remover a cláusula `OR user_id = auth.uid()`; a entrada passa a ser só via `add_member_by_email` / `auto_accept_my_invites` (SECURITY DEFINER). Se o dono precisa se auto-inserir, exigir `role` fixo e `owner_id = auth.uid()`. |
| SEC-01b | Variantes realistas: **ex-membro removido volta como admin**; convidado como "visualizador" **vira admin sem aceitar** (e `get_my_pending_invites()` já entrega o UUID da carteira). | **Alta** | CONFIRMADO | teste 1b | Mesma correção do SEC-01 + teste de regressão. |
| XSS-S1 / XSS-D1…D7 | **XSS armazenado entre usuários**: 34 interpolações de texto livre sem `_escHtml` (nome da carteira, nomes de categoria/lembrete/tipo, descrição, observação, e-mail de membro, "inserido por"). Prova dinâmica (jsdom) de 7 telas criando `<img onerror>` no DOM. Nome de carteira roda no navegador de quem entra (convite é auto-aceito no login). O token do Supabase fica em `localStorage` → roubo de sessão. | **Alta** | CONFIRMADO | `tests/static/xss-scan.test.js`, `xss-dynamic.test.js`; linhas em `tests/_out/xss-static-findings.json` (ex.: app.js:520, 1152, 1951, 2076, 2386, 2525, 2543, 2677, 2937, 3041, 4098, 4375, 4390, 4785, 4864, 4877, 5811, 5895, 7151, 7172, 7374, 7541) | Escapar tudo com `_escHtml` (ou `textContent`); tornar `_escHtml` robusto (ver XSS-S3/S4); adicionar CSP (SUP-04). O teste `xss-scan` já falha para ocorrências novas. |
| XSS-S2 | 22 interpolações do campo **emoji** sem escape. `categories.emoji`/`financas.emoji` são `VARCHAR(10)` (reduz mas não elimina); `reminders`/`transaction_types` sem limite conhecido. | Média | PARCIAL | `xss-static-findings.json` | Escapar/validar emoji (regex de emoji ou `_escHtml`). |
| XSS-S3 | `_escHtml` não escapa `'`. Hoje **não há** atributo com aspa simples recebendo valor escapado (latente). | Baixa | PARCIAL | `xss-scan.test.js` | Escapar `'` → `&#39;`. |
| XSS-S4 | `_escHtml(5)`/objeto lança `TypeError` (`(str||'').replace`). | Baixa | CONFIRMADO | idem | `String(str ?? '')`. |
| SEC-03 | Dono de uma transação a **move para qualquer carteira** (`UPDATE ... SET financa_id` sem WITH CHECK de pertencimento); o lançamento fica visível ao dono dessa carteira. Combinado com XSS-D6 vira vetor de injeção em carteira alheia (precisa do UUID). | Média | CONFIRMADO | teste 3 · `transactions_update` | `WITH CHECK (user_id = auth.uid() AND (financa_id IS NULL OR is_financa_member(financa_id)) OR is_financa_admin(financa_id))`. |
| SEC-02 | `auto_accept_my_invites` e `get_my_pending_invites` não checam `email_confirmed_at`. | Média | PARCIAL | teste 2 | Exigir `email_confirmed_at IS NOT NULL`; confirmar que "Confirm email" está ligado no Supabase Auth (não verificado — sem acesso ao projeto). |
| SEC-07 | `register_push_subscription` aceita `https://169.254.169.254/...`, `https://localhost/...`, `https://10.x` (só exige `^https://`). A Edge Function faz POST nesses endpoints (SSRF cego, payload fixo). | Média | CONFIRMADO | teste 7 · `20261007000001` / `20261007000002` | Allowlist de hosts de push (`fcm.googleapis.com`, `*.push.apple.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`) no SQL e/ou no handler. |
| SEC-12 | O papel **"visualizador" não é imposto no banco**: consegue inserir transações e criar/excluir cofrinhos (RLS só checa `is_financa_member`). Só edição de transações alheias é barrada. | Média | PARCIAL | teste 12 | Incluir `role <> 'visualizador'` nas policies de escrita (helper `can_write_financa()`). |
| DB-00 / DB-01 | **Schema drift**: `reminders` e `transaction_types` não têm migration de criação (4 migrations falham num banco limpo); colunas `categories.financa_id`, `transactions.reminder_id`, `installment_group_id/current/total` também sem migration. As policies reais dessas tabelas/colunas **não são revisáveis** a partir do repositório. | Média | CONFIRMADO | `tests/db/stubs-drift.sql`; testes "migrations" e 13 | Gerar migration de baseline a partir de `pg_dump --schema-only` de produção (Fase 2, com acesso do dono). Revisar RLS dessas tabelas. |
| SEC-10 | 6 funções `SECURITY DEFINER` sem `search_path` fixo: `is_financa_admin`, `is_financa_member`, `handle_updated_at`, `financas_set_owner`, `financa_members_set_user`, `transactions_set_inserted_by`. Mitigado (sem CREATE em `public`). | Baixa | PARCIAL | teste 10 | `ALTER FUNCTION ... SET search_path = public, auth`. |
| SEC-11 | Policies duplicadas em `transactions` (`*` e `*_own`). | Baixa | CONFIRMADO | teste 11 | Remover as `_own` (migration de limpeza). |
| MON-03 | Parcelamento por **valor total** divide igualmente e não ajusta o resto: R$ 100 em 3× → 3 × 33,33 = **99,99**. | Média | CONFIRMADO | `tests/unit/money.test.js`; `js/app.js` (`perInstallmentValue`, saveModal ~1790) | Última parcela recebe o resto (`total − Σ anteriores`). |
| NLP-01 | `"gastei 1.234,56 no mercado"` → **234,56** (perde o milhar) sem "R$"/"reais". Erro silencioso de valor. | Média | CONFIRMADO | `tests/unit/nlp.test.js`; `js/nlp.js` passo 5 de `extractValue` | Testar o formato BR completo (`_parseBRNumber`) antes do passo 5, ou ancorar o passo 5 com lookbehind `(?<![\d.])`. |
| MON-04 | Importação: texto `"1.500"` vira **1,5** (`_parseImportValue`). | Média | CONFIRMADO | money.test.js; `js/app.js` ~6254 | Tratar ponto + 3 dígitos como milhar quando não há vírgula (como o NLP faz). |
| NLP-02 | `"1 mil reais"`/`"2 mil"` → 1 / 2. | Baixa | CONFIRMADO | nlp.test.js | Suportar `\d+\s*mil`. |
| NLP-03 | `"3 parcelas de 100"`, `"5 x 100"` usam o 1º número. | Baixa | PARCIAL | nlp.test.js | Reconhecer padrão de parcelamento ou documentar. |
| MON-05 | Datas de parcelas/recorrência via `toISOString()` recuam 1 dia em fusos UTC+ (Lisboa, Tóquio). Brasil não é afetado. | Baixa | PARCIAL | money.test.js (3 fusos) | Montar `YYYY-MM-DD` com getters locais. |
| MON-01 / MON-02 | Dois caminhos de arredondamento (`toFixed` vs `Intl`) divergem em 1,005; somas em ponto flutuante (0,1+0,2) sem arredondar. | Baixa | PARCIAL | money.test.js | Centralizar em centavos inteiros ou `Math.round(x*100)/100`. |
| SUP-01…04 | 6/6 scripts de CDN sem SRI; `tailwindcss.com` (play CDN) e `supabase-js@2`/`chart.js` sem versão exata; sem CSP. | Média | CONFIRMADO | `tests/static/misc.test.js` | Fixar versões + `integrity`/`crossorigin`; compilar o Tailwind; `<meta http-equiv="Content-Security-Policy">` (GitHub Pages não envia cabeçalhos). |
| SRV-01 / SRV-02 | `server.js` (dev): path traversal com `/../` (cliente raw) e bind em `0.0.0.0`. Não vai para produção. | Baixa | CONFIRMADO | misc.test.js | `path.normalize` + checar prefixo da raiz; `listen(PORT, '127.0.0.1')`. |
| BRD-01 / BRD-02 | Nome antigo "Finanças Casa" em `sw.js:1` e `package.json`; `theme_color` do manifest (`#3b82f6`) ≠ `<meta theme-color>` (`#065f46`). | Baixa | CONFIRMADO | misc.test.js | Padronizar marca/cor. |
| FN-01 | `financa_id` com 36 hífens passa na validação; em produção cai em 403 (não é falha de segurança). | Baixa | PARCIAL | `tests/functions/send-invite.test.js` | Regex de UUID v4 estrita. |
| FN-02 | Nome da carteira vai cru no assunto/texto do e-mail (HTML está escapado). | Info | INFO | idem | Remover quebras de linha/links do assunto. |
| NLP-04 / SRV-03 / BRD-03 | Observações. | Info | INFO | — | — |

### Não confirmados (comportamento correto, mantidos como regressão)
SEC-04 (isolamento de 8 tabelas) · SEC-05 (membro comum) · SEC-06 (`add_member_by_email`) · SEC-08 (limites de `sync_push_queue`) · SEC-09 (`claim_due_push`/`cleanup_push_queue` só `service_role`). Também passaram: 401/400/403/404/429/502 do `send-invite`, escape de HTML do e-mail (`<script>`, aspas), e todo o fluxo do `push-reminders` (ok, sem assinatura, 404/410, retry até 3, `processAll` com `more` e orçamento de tempo).

### Observações adicionais (sem teste)
- `cofrinhos.js` está limpo de XSS (usa `_esc` em nome/nota/PIX).
- Em `send-invite/index.ts`, `countRecentEmailsBy` conta **convites** com `emailed_at` na última hora, não e-mails enviados; reenvios do mesmo convite contam uma vez (limite horário subestimado; mitigado pelos limites por convite). `ilike('email', email)` trata `%`/`_` do e-mail como curingas (risco baixo).
- `link_my_transactions_to_financa` move **todas** as transações pessoais do usuário para qualquer carteira onde ele seja membro (depende de SEC-01 estar corrigido).
- A chave `sb_publishable_…` em `js/config.js` é a chave pública (esperado); nenhum `service_role` encontrado no front.

## O que NÃO consegui testar (e por quê)
1. **Supabase real**: sem Docker daemon, usei Postgres puro com stubs. Não validei Auth (confirmação de e-mail, JWT/claims reais), PostgREST (grants reais), Realtime, `pg_cron`/`pg_net` nem os privilégios padrão do projeto de produção. A regra "não tocar produção" impediu comparar o schema real (por isso o *drift* só é detectável pela ausência de migrations).
2. **RLS de `reminders`, `transaction_types` e `categories.financa_id`**: existem só em produção (drift). Usei stub mínimo; **a segurança dessas tabelas continua não verificada**.
3. **Edge Functions em runtime Deno** (`index.ts`, `Deno.serve`, `npm:@supabase/supabase-js`, Resend, Web Push real): testei só a lógica pura dos `handler.ts`.
4. **Navegador real / PWA / service worker / push / voz**: o XSS foi provado em jsdom (elemento `<img onerror>` entra no DOM; o `onerror` não foi executado de verdade). Não testei CSP, Safari/iOS, instalação do PWA nem offline.
5. **Fluxos completos de tela** (salvar lançamento, importar Excel real, exportar PDF/Excel, gráficos): só funções puras e renderizações isoladas. Importação de arquivo `.xlsx` real não foi exercitada.
6. **Workflow de deploy** (`.github/workflows/deploy.yml`): não analisado (fora do escopo desta fase; não alterado).
7. **Carga/concorrência** (milhares de usuários, `claim_due_push` com `FOR UPDATE SKIP LOCKED` concorrente) e **desempenho** de índices/RLS.

## Pronto para a Fase 2 (sugestão de ordem)
1. SEC-01/01b (policy `members_insert`) + SEC-03 (WITH CHECK) + SEC-12 (visualizador) — uma migration, com os testes de regressão já prontos.
2. XSS: escapar as 34 + 22 ocorrências e endurecer `_escHtml`; depois CSP/SRI.
3. NLP-01, MON-03, MON-04 (erros silenciosos de valor).
4. SEC-07 (allowlist de push), SEC-02, SEC-10/11.
5. Baseline do schema (DB-00/01) — requer `pg_dump` de produção pelo dono.
