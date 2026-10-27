# Como publicar a Fase 3

Esta fase **não mexe no banco**. São dois PRs, nesta ordem: **3a** (`qa/fase-3a-publicacao-datas-tailwind`: G1, G2, G3) e só depois **3b** (`qa/fase-3b-csp`: G4).

## Ordem
1. Faça o merge do **PR 3a** na `main`.
2. Aba **Actions** → "Deploy to GitHub Pages": o job `test` e o `deploy` devem ficar verdes. (O passo "Montar o site" imprime a lista de arquivos publicados.) Se falhar, o site atual continua no ar.
3. Rode o **checklist** abaixo (celular e desktop).
4. Só se tudo estiver ok: faça o merge do **PR 3b** (CSP) e repita o checklist (principalmente console sem violações).

## Verificações logo após o merge da 3a
- `https://minhascarteiras.com.br/docs/qa/RELATORIO-FASE-1.md` → **404**. Também 404: `/tests/`, `/supabase/`, `/server.js`, `/package.json`, `/scripts/build-site.js`.
- `https://minhascarteiras.com.br/css/app.css` → 200 (CSS do Tailwind).
- O app carrega com o visual de sempre e o **PWA instala** (Chrome: ícone de instalar na barra; celular: "Adicionar à tela inicial").
- No rodapé/menu, a versão (`v AAAA-MM-DD HH:MM`) é a da hora do deploy.

## Checklist de fumaça (celular e desktop)
- [ ] Login e logout
- [ ] **Lançar às 22h** (horário de Brasília): entre 21h e 23h59, abra "Novo lançamento" sem mexer na data e confira que a data padrão é **hoje**, não amanhã. Na última noite do mês, confira que o mês exibido no início não avança. (Não dá para simular o relógio do celular; se não puder testar à noite, a suíte `tests/unit/dates.test.js` já cobre 22:30, 21:00, 00:30, fim de mês e virada de ano em 4 fusos.)
- [ ] Gráficos (aba Resumo) e visual geral sem elementos "sem estilo"
- [ ] Exportar Excel e PDF
- [ ] Convite de carteira (enviar e aceitar)
- [ ] Notificações push (ativar e receber o teste)
- [ ] Instalar o PWA
- [ ] Console do navegador sem erros (F12)

## Como reverter
- **PR 3a:** na página do PR, "Revert" → merge do PR de reversão. O deploy volta ao fluxo anterior (lista fixa + Tailwind pelo CDN). Para reverter só um item: `git revert` do commit correspondente (G1, G2 ou G3 são commits separados).
- **PR 3b (CSP):** o commit da CSP é isolado: `git revert <commit>` (ou "Revert" no PR) remove a CSP sem afetar mais nada.
- Nenhuma reversão exige mexer no Supabase.
