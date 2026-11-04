# Relatório de QA/Segurança — Fase 3 (publicação, datas, Tailwind, CSP)

Base: `main` com a Fase 2 mergeada e aplicada em produção. **Esta fase não altera o banco** (nenhuma migration).
Nenhum teste tocou o Supabase de produção (rede externa bloqueada nos testes de navegador; banco só local).
Sem e-mails, UUIDs reais ou segredos neste relatório (os e-mails das capturas são fictícios, `exemplo.com`).

| ID | Achado | Estado | Arquivos | Teste que prova | Risco |
|---|---|---|---|---|---|
| G1 / N3 | Publicar só os arquivos do app. **Observação:** o `deploy.yml` já não publicava a raiz desde a Fase 2 (lista fixa `cp -r …`, PR #38); a premissa "path: '.'" já estava corrigida. A Fase 3 troca a lista fixa por um build que **deriva** os arquivos das referências de `index.html`/`manifest.json`/`sw.js` e **falha** se um referenciado não existir | CORRIGIDO (3a) | `scripts/build-site.js`, `.github/workflows/deploy.yml` | `tests/static/pages-artifact.test.js` (6): sem docs/tests/supabase/scripts/.github/server.js/package*/iniciar.bat/"Ideias…"; contém tudo que é referenciado; build quebra com referência inexistente; injeção de versão **idêntica ao `sed` antigo** (comparada com o próprio `sed`); `tests/static/deploy-allowlist.test.js` adaptado | Baixo. Mudança no passo de deploy: primeira execução real só após o merge (ver DEPLOY-FASE-3.md) |
| G2 / MON-05 | Datas de calendário via `toISOString()` (UTC): depois das 21h em Brasília "hoje" virava amanhã (data padrão do lançamento, avisos de lembrete, mês corrente, último dia do mês) | CORRIGIDO (3a) | `js/utils.js` (+5 helpers), `js/app.js`, `js/storage.js`, `js/insights.js`, `js/push.js` | `tests/unit/dates.test.js` (33): 7 cenários × 4 fusos (America/Sao_Paulo, UTC, Asia/Tokyo, America/New_York) + scanner que falha se voltar `toISOString().slice/split`; CI repete a suíte por fuso. Falhou antes (33/33) e passa depois | Baixo. 21 pontos trocados; instantes (`created_at`, `fire_at`…) mantidos — lista em DECISOES.md D8 |
| G3 | `cdn.tailwindcss.com` (script de terceiro sem SRI, com acesso total à página, e bloqueio para a CSP) | CORRIGIDO (3a) | `tailwind.config.js`, `css/input.css`, `package.json` (tailwindcss 3.4.19 exato), `index.html` (`<link css/app.css>`), `.gitignore`, `iniciar.bat`, `deploy.yml` | `tests/static/tailwind.test.js` (4): versão exata, sem CDN, link depois do `<style>`, toda classe usada existe no CSS, safelist cobre `border/bg/text-${c}-…`; validação visual: 42 capturas, 0 divergências (ver abaixo) | Médio-baixo: se uma classe for montada por string e esquecida, some o estilo dela. Mitigado pelo teste e pelo safelist (D9) |
| G4 | CSP ativa por `<meta>` (hashes em vez de `'unsafe-inline'` em scripts; sem `'unsafe-eval'`) + referrer-policy | CORRIGIDO (branch/PR 3b `qa/fase-3b-csp`, commit isolado) | `index.html`, `scripts/csp-hashes.js`, `scripts/visual/csp-check.js`, `docs/qa/csp-validacao.json` | `tests/static/csp.test.js` (7) + validação em Chromium: 16 passos, **0 violações**; controle negativo: 30 violações detectadas | Médio: uma CSP errada derruba o app. Mitigado por teste de hashes e validação; reversão com um `git revert` (DEPLOY-FASE-3.md). Detalhes e concessões: DECISOES.md D10 |
| G5 | Actions em Node 20 → 24 | NÃO ALTERADO (não consegui verificar) | — | — | Baixo |

## G1 — como ficou
`scripts/build-site.js` monta `_site/` com 19 arquivos (index.html, sw.js, manifest.json, icon.svg, 6 ícones, 8 js e `css/app.css`) e injeta a versão **nas cópias** (`APP_VERSION` em `js/app.js` e o nome do cache no `sw.js`, horário de Brasília, mesmas expressões do `sed` anterior). O `deploy.yml` agora faz `npm ci` + `npm run build:css` + `node scripts/build-site.js` e publica `path: '_site'`, mantendo `needs: test`.

```diff
-      - name: Inject version timestamp (horário de Brasília)
-        run: |  (sed em js/app.js e sw.js da raiz)
-      - name: Montar o site (somente arquivos do app)
-        run: |  mkdir _site; cp -r index.html manifest.json sw.js icon.svg icons js _site/
+      - uses: actions/setup-node@v4 (node 22, cache npm)
+      - name: Instalar dependências e gerar o CSS (Tailwind)
+        run: npm ci && npm run build:css
+      - name: Montar o site (somente arquivos do app + versão)
+        run: node scripts/build-site.js
         ...
           path: '_site'      # (já era _site desde a Fase 2)
```

## G2 — pontos
21 substituições listadas em DECISOES.md **D8**, mais a tabela do que foi mantido com `toISOString()` e por quê.

## G3 — validação visual
`scripts/visual/capture.js` + `compare.js` (Chromium/Playwright, relógio fixo 15/10/2026, modo local do app, dados fictícios, **toda requisição externa bloqueada**; o único host que o app tentou contatar foi o do Supabase na tela de login e foi barrado). 21 telas × celular (390×844) e desktop (1280×800): login, início, lançamentos, resumo, investir, cofrinhos (lista/detalhe/formulário/movimentação), lembretes (lista/formulário), lançamento (novo/parcelado/edição), carteiras (lista/nova), categorias (lista/formulário), tipos, metas, importar.
- **Antes** = equivalente do CDN (o `cdn.tailwindcss.com` é inacessível neste ambiente; o Play CDN gera o CSS no navegador a partir das classes presentes no DOM, e é isso que a captura "antes" reproduz, com a mesma versão do Tailwind). **Limitação declarada:** não é o script do CDN real; a conferência final é visual no deploy (checklist em DEPLOY-FASE-3.md).
- Resultado: **0 de 42 capturas acima da tolerância (0,05 % dos pixels)**; a maior diferença foram 4 pixels (início/celular). Nenhuma divergência a corrigir. Sanidade: tirando `js/**` do `content`, 25 capturas passam a divergir.
- Capturas lado a lado (antes | depois | diferença) em `docs/qa/visual/` (9 imagens + `comparacao.json`).
- Bug pré-existente achado na captura (não corrigido, fora do escopo): no **modo local** (sem Supabase) a aba Resumo quebra em `renderPersonBreakdown` porque `myEmail` é vazio (`NaN` no índice da paleta). No modo nuvem sempre há e-mail, então não afeta produção.

## G5 — Actions
Não alterei: este ambiente só alcança o repositório do projeto e não consegue ler o README/changelog de `actions/checkout`, `setup-node`, `configure-pages`, `upload-pages-artifact` e `deploy-pages` para confirmar a versão maior que declara Node 24. Versões atuais: `checkout@v4`, `setup-node@v4`, `configure-pages@v5`, `upload-pages-artifact@v3`, `deploy-pages@v4`. **Ação sugerida:** conferir os releases no GitHub e me passar as versões, ou eu aplico depois.

## Decisões que preciso de você
Ver o resumo final no chat e DEPLOY-FASE-3.md.
