# Decisões e pendências — QA Fase 2

## D1. Papel "visualizador" NÃO é imposto no banco (decisão do produto: adiado)
**Hoje:** o papel existe (`financa_members.role = 'visualizador'`, rótulo "👁 Só ver"), mas as policies de escrita só checam
`is_financa_member` (ver teste 12 de `tests/db/rls.test.js`, que segue registrando PARCIAL). Um visualizador consegue, direto pela API,
inserir transações e criar/excluir cofrinhos, categorias, lembretes e tipos da carteira. Editar/excluir lançamentos **de outras pessoas**
já exige admin.

**Por que adiado:** impor o papel exige tocar TODAS as policies de escrita (transactions, cofrinhos*, categories, reminders,
transaction_types); a Fase 2 já reescreveu várias delas e o papel muda o comportamento visível. Melhor decidir o produto antes.

**Desenho proposto (não aplicado):**
```sql
create or replace function public.is_financa_writer(fid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from financas where id = fid and owner_id = auth.uid())
      or exists (select 1 from financa_members where financa_id = fid and user_id = auth.uid() and role in ('admin','membro'));
$$;
-- trocar is_financa_member por is_financa_writer nas policies de INSERT/UPDATE/DELETE (SELECT continua is_financa_member).
```

## D2. A6 — e-mail confirmado (severidade baixa)
Na produção "Confirm email" está **LIGADO** (verificado em 26/10): não é possível obter sessão com o e-mail de outra pessoa sem confirmá-lo,
então o risco do SEC-02 é baixo. A checagem `email_confirmed_at IS NOT NULL` em `auto_accept_my_invites`, `get_my_pending_invites`,
`my_invite_email_matches` e `accept_invite` fica como **defesa em profundidade** para o caso de a opção ser desligada no futuro.

## D3. A12 — `inserted_by_email` forjável (severidade baixa): apenas documentado
O gatilho `transactions_set_inserted_by` só preenche o campo quando vem NULL; o cliente pode mandar qualquer valor. **Há uso legítimo**, por isso
não foi forçado o e-mail do JWT:
1. **Importação de Excel**: a coluna "Inserido por" atribui lançamentos a outras pessoas da carteira (`js/app.js`, importação → `inserted_by_email`).
2. **Ajuste de autor por admin**: o admin edita o campo em lançamento existente (UPDATE permitido pela policy de admin).
Risco residual: um membro pode atribuir um lançamento a outro e-mail (afeta só o "Resumo por pessoa" e a etiqueta de autor). O valor continua
sendo **escapado na renderização** (Bloco B). Se um dia a atribuição for restrita, desenho: no INSERT forçar o e-mail do JWT, exceto quando
`is_financa_admin(financa_id)`.
## D7. A8/A13 — baseline do schema de produção
Não foi necessário o dump completo: o estado real (policies, colunas, funções, grants, CHECKs) foi levantado pelo catálogo e está em
`docs/qa/baseline/ESTADO-PRODUCAO.md` + `reminders-transaction_types-baseline.sql` (documental, **não aplicar**), e reproduzido nos testes em
`tests/db/prod-state.sql`. **Pendente:** conferir no catálogo a policy de SELECT de `financas` (ver observação no baseline) e as demais policies
de `cofrinhos*`/`user_pix` já confirmadas como iguais ao repositório.

## D4. C1 — Regra única de valores em pt-BR (`Utils.parseMoneyBR`)
| Entrada | Resultado | Regra |
|---|---|---|
| `1.234,56` · `R$ 1.234,56` · `1,234.56` | 1234.56 | com os dois separadores, o **último** é o decimal |
| `12,5` · `50,30` | 12.5 · 50.3 | vírgula = decimal (até 2 casas) |
| `1.500` · `1.234.567` | 1500 · 1234567 | ponto + exatamente 3 dígitos, sem vírgula = **milhar** (padrão pt-BR) |
| `1500.50` · `50.3` | 1500.5 · 50.3 | ponto + 1–2 dígitos = decimal |
| `-50,30` | -50.3 | sinal "-" aceito no início |
| `0.500` | null | **ambíguo** (começa com 0): não chutamos |
| `1,234` | null | vírgula com 3 casas: ambíguo |
| `1,5,3` · `12.3.4` · `abc` · vazio | null | inválido |

Usada em: `nlp.js` (voz/texto, inclusive "2 mil", "1,5 mil" e "1.234,56" sem "R$"), importação de Excel/CSV (`_parseImportValue`: ambíguo/ inválido → 0).
**Caso ambíguo conhecido:** `1.500` digitado por quem pensa em "1,5" será lido como mil e quinhentos (o padrão do pt-BR). Na NLP, uma data no formato `12.05` na mesma frase ainda pode ser lida como valor 12,05 (comportamento anterior, não alterado).

## D5. C2 — Parcelamento
Divisão em centavos inteiros (`Utils.splitMoney`): a **sobra vai uma a uma para as primeiras parcelas** (100/3 → 33,34 + 33,33 + 33,33). A prévia no modal mostra "R$ 33,34 + 2× de R$ 33,33". Total pequeno demais para o nº de parcelas (alguma parcela = R$ 0,00) é recusado com aviso.
**Não alterado (ADIADO):** NLP-03 (frases "3 parcelas de 100"): não estavam nos blocos desta fase (MON-05, datas, foi tratado na Fase 3: ver D8).

## D6. E1/E2 — CDN, SRI e CSP
- **SRI aplicado** a supabase-js, chart.js, xlsx, jsPDF e jsPDF-autotable, com versão EXATA e `crossorigin="anonymous"`. Os hashes foram calculados dos arquivos do pacote npm (`dist/...`), baixados de **dois hosts de registry** (`registry.npmjs.org` e `registry.yarnpkg.com`; tarballs idênticos, mesmo sha256) — o jsDelivr serve esses arquivos byte a byte. **Não consegui baixar do próprio jsDelivr** (o ambiente bloqueia o host), então a conferência final contra o CDN real fica no `npm run verify:sri`, que roda no CI e **deve rodar antes do deploy** (SRI errado = o script não carrega = app quebrado).
- Versões fixadas: `@supabase/supabase-js@2.118.0` (era `@2`, hoje resolvia para a mesma), `chart.js@4.5.1` (era sem versão); `xlsx@0.18.5`, `jspdf@2.5.1`, `jspdf-autotable@3.5.28` já estavam fixos.
- **Tailwind (`cdn.tailwindcss.com`)**: sem SRI (o script é dinâmico e muda). Risco registrado: código de terceiro com acesso total à página. **Tarefa futura:** compilar o Tailwind (CLI `tailwindcss -i ... -o css/tailwind.css --minify`, com `content: ['./index.html','./js/**/*.js']`) e servir o CSS do próprio site; isso também elimina o aviso do "play CDN em produção", acelera o carregamento e permite remover `'unsafe-eval'`/o host da CSP.
- **CSP**: apenas proposta em `docs/qa/csp-proposta.md` (ver lá por que não foi ativada).

## D8 — Datas de calendário no horário local (G2 / MON-05, Fase 3)
**Regra:** data de calendário ("hoje", mês corrente, último dia do mês, data padrão do lançamento) usa `Utils.localDateStr/todayLocal/monthKeyLocal/monthEndLocal/parseDateLocal` (js/utils.js). `toISOString()` converte para UTC e, no Brasil (UTC-3), depois das 21h devolve o dia seguinte.

**Substituídos (21 pontos):** `App.currentMonth` inicial; `_addMonths` (parcelas); data padrão do modal; chave diária dos avisos de lembrete; mês exibido/atual (3 pontos); "hoje" de `quickAddFromReminder`, lista de lançamentos, histórico, parcelas e relatórios; `formatDateGroup` (Hoje/Ontem); importação (`_parseImportDate`, "hoje" padrão); insights (projeção, gaps de parcela, `new Date(data + 'T12:00:00')` → parse local); push (`push_registered_<uid>` por dia); storage (data padrão em `_localAdd`, `addTransaction`, `addTransactions`; último dia do mês em `getTransactions` ×2, antes `new Date(+y, +m, 0).toISOString()`).

**Mantidos com `toISOString()` (são INSTANTES, não datas de calendário; o banco guarda timestamptz):**
| Onde | Motivo |
|---|---|
| `created_at` (storage.js ×7, cofrinhos.js ×3) | carimbo de criação |
| `updated_at` de `user_pix` (storage.js) | carimbo de atualização |
| `fire_at` (push.js ×2) e o disparo de teste `+40 s` (push.js) | instante absoluto exigido pela Edge Function |

**Mantido sem mudança:** `_parseImportDate` com número serial do Excel usa `getUTC*` (o serial já é "dia sem fuso"); `new Date(raw)` de texto livre só é usado como último recurso.

**Teste:** `tests/unit/dates.test.js` roda 7 cenários × 4 fusos (America/Sao_Paulo, UTC, Asia/Tokyo, America/New_York) com relógio simulado em processo filho, mais um scanner que falha se surgir `toISOString().slice/split` ou `new Date('AAAA-…')` fora da lista acima.
