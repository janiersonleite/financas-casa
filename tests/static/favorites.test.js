// T2 (jsdom): favoritos de um toque — Home, painel de valor, lançar/desfazer, papéis, editor, 7º bloqueado, XSS, métricas.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const r = spawnSync(process.execPath, [path.join(__dirname, 'favorites-runner.js')], { cwd: ROOT, encoding: 'utf8', timeout: 90000 });
const o = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}');
const n = t => String(t).replace(/\s/g, ' ');

test('o runner jsdom terminou sem erro', () => { assert.equal(r.status, 0, r.stderr + (o.erro || '')); });

test('Home: sem favoritos mostra o cartão "Crie seus favoritos para lançar com um toque" + Adicionar', () => {
  assert.equal(o.vazio.oculta, false); assert.equal(o.vazio.botoes.length, 0); assert.ok(o.vazio.vazio && o.vazio.temAdicionar);
  assert.match(o.vazio.vazioTexto, /Crie seus favoritos para lançar com um toque/);
});

test('Home: 5 favoritos mistos (3 saídas + 2 entradas) com selo de TIPO em ícone + texto; nenhum valor aparece', () => {
  const b = o.misto.botoes;
  assert.equal(b.length, 5);
  assert.deepEqual(b.map(x => x.tipo), ['saida', 'entrada', 'saida', 'entrada', 'saida']);
  assert.deepEqual(b.map(x => x.selo), ['Saída', 'Entrada', 'Saída', 'Entrada', 'Saída']);
  assert.ok(b.every(x => x.icone), 'todo selo tem ícone (não depende só de cor)');
  for (const x of b) { assert.doesNotMatch(x.texto, /R\$|\d,\d\d/); assert.match(x.aria, /^(Saída|Entrada): .+Toque para lançar$/); }
  assert.match(b[0].aria, /categoria Alimentação/); assert.match(b[2].texto, /Sem categoria/);
  assert.ok(!b.some(x => /De outra carteira/.test(x.texto)), 'favoritos de outra carteira não aparecem');
});

test('painel de valor (saída): título com o tipo, categoria, faixa da carteira na cor dela, CTA desabilitado com valor zero, teclas com aria-label', () => {
  const p = o.painelSaida;
  assert.ok(p.aberto); assert.equal(p.titulo, 'Saída · Mercado'); assert.equal(p.cat, 'Alimentação'); assert.equal(p.carteira, 'Lançando em Família');
  assert.equal(p.cor, p.corEsperada); assert.equal(n(p.valor), 'R$ 0,00'); assert.equal(p.cta, 'Lançar saída'); assert.equal(p.ctaDesab, true);
  assert.deepEqual(p.ariaTeclas, ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'zero zero', 'zero', 'apagar']);
  assert.equal(p.foco, 'fav-panel-box', 'o foco vai para o painel ao abrir');
  assert.equal(n(o.painelSaidaValor.valor), '-R$ 15,00', '1,5,0,0 → R$ 15,00 com prefixo "-"'); assert.equal(o.painelSaidaValor.ctaDesab, false);
  assert.equal(n(o.teclado.aposApagar), '-R$ 1,50'); assert.equal(n(o.teclado.aposDoisZeros), '-R$ 150,00');
  assert.equal(o.zero.ctaDesab, true, 'valor zero desabilita');
});

test('lançar saída: insert com payload EXATO (descrição, categoria, tipo, data local, valor), 1 insert mesmo com 3 toques, saldo SUBTRAI, painel fecha, foco volta ao botão', () => {
  const l = o.lancarSaida;
  assert.equal(l.chamadas, 1, 'duplo/triplo toque gera 1 insert');
  assert.deepEqual(l.payload, [{ type: 'saida', category: 'Alimentação', description: 'Mercado', value: 15, date: l.hoje }]);
  assert.ok(l.painelFechado); assert.equal(n(l.saldoAntes), 'R$ 0,00'); assert.equal(n(l.saldoDepois), '-R$ 15,00');
  assert.ok(l.foco, 'o foco volta ao botão de origem');
});

test('toast: role=status, texto indica o tipo, botão Desfazer', () => {
  const t = o.lancarSaida.toast;
  assert.equal(t.texto, 'Lançado: Mercado -R$ 15,00 (saída)'); assert.equal(t.role, 'status'); assert.ok(t.visivel); assert.equal(t.desfazer, 'Desfazer');
  assert.equal(n(o.lancarEntrada.toast), 'Lançado: Salário +R$ 2.500,00 (entrada)');
  const html = read('index.html');
  assert.match(html, /#fav-toast #fav-undo \{[^}]*min-height: 44px; min-width: 44px/, 'Desfazer ≥ 44 px');
  assert.match(read('js/favorites-ui.js'), /setTimeout\(\(\) => \{ el\.classList\.add\('hidden'\); this\._undo = null; \}, 6000\)/, 'some depois de 6 s');
});

test('Desfazer remove SOMENTE a transação recém-criada (pelo id) e o saldo volta', () => {
  const d = o.desfazer;
  assert.deepEqual(d.apagou, ['tx1']); assert.deepEqual(d.restou, ['tx-antigo']); assert.ok(d.toastEscondido); assert.equal(n(d.saldo), '-R$ 10,00');
});

test('favorito de ENTRADA: título "Entrada · Salário", prefixo "+", "Lançar entrada", grava o tipo e SOMA no saldo', () => {
  const p = o.painelEntrada;
  assert.equal(p.titulo, 'Entrada · Salário'); assert.equal(n(p.valor), '+R$ 2.500,00'); assert.equal(p.cta, 'Lançar entrada');
  assert.deepEqual(o.lancarEntrada.payload, { type: 'entrada', category: 'Salário', description: 'Salário', value: 2500, date: o.lancarSaida.hoje });
  assert.equal(n(o.lancarEntrada.saldoAntes), '-R$ 10,00'); assert.equal(n(o.lancarEntrada.saldoDepois), 'R$ 2.490,00');
});

test('falha no insert: painel continua aberto, valor mantido, erro claro, botão volta a habilitar, nada lançado', () => {
  const f = o.falha;
  assert.ok(f.aberto); assert.equal(n(f.valor), '-R$ 99,00'); assert.match(f.erro, /Não foi possível lançar: rede caiu\. Seu valor foi mantido/); assert.ok(f.erroVisivel && f.ctaHabilitado);
  assert.equal(f.txs, 2, 'só o lançamento antigo + o da entrada (a falha não criou nada)');
  assert.ok(o.esc.fechou, 'Esc fecha o painel');
});

test('trocar de carteira troca os favoritos; visualizador não vê a seção; papel ainda desconhecido não pisca a seção', () => {
  assert.deepEqual(o.outraCarteira.botoes.map(b => b.texto.includes('De outra carteira')), [true]);
  assert.equal(o.visualizador, true); assert.equal(o.admin, true); assert.equal(o.papelDesconhecido, true);
});

test('gerenciar: contador "Na Home (n de 6)" conta tudo, texto de ajuda, selo de tipo em cada item, "Sem categoria", remover com confirmação leve', () => {
  const g = o.gerenciar;
  assert.equal(g.contador, 'Na Home (5 de 6)'); assert.ok(g.ajuda, '"Entradas e saídas dividem as 6 vagas"');
  assert.deepEqual(g.lista.map(x => x.selo), ['Saída', 'Entrada', 'Saída', 'Entrada', 'Saída']); assert.equal(g.lista[2].cat, 'Sem categoria');
  assert.equal(o.confirmar.texto, 'Confirmar?'); assert.equal(o.confirmar.aindaTem, 5, '1º toque só pede confirmação');
  assert.equal(o.removeu.calls, 1); assert.equal(o.removeu.restam, 4); assert.equal(o.removeu.contador, 'Na Home (4 de 6)');
});

test('editor: trocar o tipo limpa a categoria incompatível e pede nova; só categorias compatíveis são listadas; cria com nome aparado', () => {
  const t = o.trocaTipo;
  assert.ok(t.categoriaLimpa && t.dicaVisivel); assert.match(t.dica, /Escolha outra/);
  assert.deepEqual(t.opcoes, ['Sem categoria', '💰 Salário', '📦 Outros'], 'tipo entrada: sem a categoria de saída');
  assert.deepEqual(o.criou.insert, { name: 'Padaria do Zé', type: 'saida', category_id: 'c0000000-0000-4000-8000-0000000000a1', financa_id: 'f1111111-0000-4000-8000-000000000001', position: 6 });
});

test('o 7º favorito (misturando tipos) é bloqueado na UI com mensagem; com 6 o "Adicionar" fica desabilitado com explicação', () => {
  assert.equal(o.cheio.contador, 'Na Home (6 de 6)'); assert.ok(o.cheio.addDesab && o.cheio.ajudaVisivel);
  assert.match(o.cheio.ajuda, /Você já tem 6 favoritos.*entradas e saídas dividem as 6 vagas/);
  assert.match(o.setimo.erro, /6 favoritos.*dividem as 6 vagas/); assert.equal(o.setimo.inseriu, false);
});

test('sugestões do histórico: (descrição, tipo) com ≥3 ocorrências em 60 dias, "Lançou N vezes…", mesmo nome em tipos diferentes = 2 sugestões', () => {
  assert.equal(o.sugestoes.length, 2);
  assert.ok(o.sugestoes.some(s => /Pão Saída/.test(s)) && o.sugestoes.some(s => /Pão Entrada/.test(s)));
  for (const s of o.sugestoes) { assert.match(s, /Lançou 3 vezes nos últimos 60 dias/); assert.doesNotMatch(s, /R\$/); }
});

test('XSS: nome/categoria de favorito com <img onerror> vira texto no botão, painel, gerenciar e toast', () => {
  assert.equal(o.xss.imgs, 0); assert.equal(o.xss.pwned, false); assert.match(o.xss.titulo, /^Saída · <img/);
});

test('métricas locais: o método "favorito" foi registrado (contagem, mediana de toques/segundos), sem dados pessoais', () => {
  assert.ok(o.metricas.favorito.count >= 1); assert.ok(o.metricas.favorito.medianTaps >= 5); assert.equal(typeof o.metricas.favorito.medianSeconds, 'number');
  assert.equal(o.metricas.formulario.count, 0);
});

test('acessibilidade e estilo: alvos ≥ 44 px, botão ~84 px, grade de 3 colunas, reduced-motion, sem handlers inline', () => {
  const html = read('index.html'), ui = read('js/favorites-ui.js');
  assert.match(html, /\.fav-btn \{[^}]*min-height: 84px; min-width: 44px/);
  assert.match(html, /\.fav-key \{ min-height: 52px/); assert.match(html, /id="fav-grid" class="grid grid-cols-3 gap-2\.5"/);
  assert.match(html, /prefers-reduced-motion: no-preference\) \{ \.fav-btn \{ transition/);
  assert.match(html, /id="fav-panel-box"[^>]*role="dialog" aria-modal="true" aria-labelledby="fav-panel-title"/);
  assert.doesNotMatch(ui, /\son(click|change|input|keydown)=/);
  assert.match(ui, /e\.key === 'Escape'/); assert.match(ui, /e\.key === 'Tab'/);
  assert.match(html, /id="fav-error" role="alert"/); assert.match(html, /id="fav-toast" class="hidden" role="status"/);
});
