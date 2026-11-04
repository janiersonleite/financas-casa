# Desktop compacto (≥ 1024 px) — protótipo aprovado aplicado a todas as telas

Só CSS/HTML de layout em `index.html` (tudo dentro de `@media (min-width: 1024px)`: **celular e tablet não mudam**). Sem mudanças de banco.

| Tela | O que mudou no desktop |
|---|---|
| Início | grade de 12 colunas: saldo (5/12) + registrar lançamento (7/12); categorias numa fileira de 8; lembretes (5/12) + lançamentos do mês (7/12) |
| Histórico | cabeçalho vira cartão arredondado (não gruda mais no topo); lista na coluna |
| Resumo | cabeçalho em cartão; seções em 2 colunas (cartões de saldo, insights e evolução ocupam a largura toda); ao entrar em "Editar layout" volta a 1 coluna para o arrastar funcionar |
| Investir | cabeçalho em cartão arredondado; conteúdo na coluna |
| Barra de carteira | fundo na largura toda; conteúdo na coluna de 1200 px |
| Menu lateral | painel flutuante vertical, encostado na coluna (14 px de folga) |
| Tipografia | fonte normal (100 %): o aumento para 118 %/130 % foi removido; rótulos de 9/10/11 px sobem para 10,5/11,5/12,5 px |
| Modais | já eram centralizados a partir de 768 px; sem mudança |

**Verificação (Chromium, 7 larguras de 1024 a 3440 px):** a barra de carteira e a aba visível têm exatamente a mesma coluna; o menu não sobrepõe a coluna; sem overflow horizontal; 0 erros de console. `tests/static/desktop-layout.test.js` trava as regras (inclusive que `#tab-home` não use `display:grid` direto, o que mostraria a Início em todas as abas). Capturas: `docs/qa/visual/desktop-compacto/` (Início em 7 larguras; Histórico, Resumo e Investir em 1366 e 1920 px). Protótipo: `docs/qa/prototipos/`.

**Diferenças conscientes em relação ao protótipo:** o cartão "Registrar lançamento" do app tem só os botões Adicionar e Falar (sem campo de texto, como no app atual); lembretes e lançamentos usam os componentes reais.
**Como reverter:** `git revert` do commit do layout; nada além de CSS/HTML estático é afetado.

## Ajuste (padronização da Início + botão de ocultar valores)
- **Padronização:** banner de instalação sempre numa linha própria no topo (antes empurrava o registrar para baixo e deixava um buraco ao lado do saldo); saldo e registrar com a mesma altura; categorias, lembretes e lançamentos com o mesmo cartão (branco, borda, raio 16, padding 16), o mesmo estilo de título e o mesmo "Ver tudo" verde; lembretes em 1 coluna dentro do cartão.
- **Botão de olho** agora fica na linha do "Saldo do mês", perto dos saldos (celular e desktop).
- **Ocultar valores NÃO afeta os lançamentos**: só saldo, entradas, saídas e valores dos lembretes viram •••••. (Se quiser os lembretes sempre visíveis também, é uma linha.)
