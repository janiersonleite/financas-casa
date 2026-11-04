// U1/U3/U4/U5/U7 (T2): barra de carteira ativa no jsdom — presença nas 4 abas, troca de carteira (nome, cor, chip, toast, mês),
// estados (carregando, vazio, offline, 1 membro), nome longo e nome malicioso (texto, nunca HTML).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const r = spawnSync(process.execPath, [path.join(__dirname, 'wallet-bar-runner.js')], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
const o = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}');
test('o runner jsdom terminou sem erro', () => { assert.equal(r.status, 0, r.stderr + (o.erro || '')); });

test('U1: um único <button id="wallet-bar"> antes das 4 abas, fora delas; pílula antiga removida', () => {
  assert.equal(o.estrutura.barras, 1);
  assert.ok(o.estrutura.ehButton);
  assert.equal(o.estrutura.primeiroFilhoDoApp, 'wallet-bar');
  assert.equal(o.estrutura.dentroDeAba, false);
  assert.ok(o.estrutura.antesDasAbas);
  assert.deepEqual(o.estrutura.abas, ['tab-home', 'tab-history', 'tab-summary', 'tab-investments']);
  assert.equal(o.estrutura.pilulaAntiga, false);
  const html = read('index.html');
  assert.doesNotMatch(html, /financa-switcher/);
  for (const f of ['js/app.js', 'js/cofrinhos.js', 'js/push.js']) assert.doesNotMatch(read(f), /financa-switcher/, f);
  assert.doesNotMatch(html, /\.financa-switcher|#financa-switcher/);
});

test('U1: a barra continua visível ao trocar de aba (Início, Histórico, Resumo, Investir)', () => {
  assert.equal(o.abas.length, 4);
  for (const a of o.abas) { assert.ok(a.abaVisivel, a.aba); assert.equal(a.barraOculta, false, `barra oculta em ${a.aba}`); }
});

test('U1/U2: carteira individual — nome, cor do hash, chip "Só você", aria-label e título da página', () => {
  const s = o.individual;
  assert.equal(s.state, 'ready'); assert.equal(s.nome, 'Pessoal'); assert.equal(s.chip, 'Só você'); assert.equal(s.chipKind, 'solo');
  assert.equal(s.cor, s.corEsperada);
  assert.equal(s.aria, 'Carteira ativa: Pessoal (só você). Toque para trocar de carteira');
  assert.equal(s.titulo, 'Pessoal · Minhas Carteiras');
});

test('U3: lista "Trocar de carteira" — título, selo "Ativa" só na atual, cor por carteira, botões Fechar e + Nova carteira', () => {
  const l = o.lista;
  assert.equal(l.titulo, 'Trocar de carteira'); assert.equal(l.linhas, 5); assert.equal(l.ativa.length, 1);
  assert.equal(l.botoes.fechar, 'Fechar'); assert.equal(l.botoes.nova, '+ Nova carteira');
  assert.match(l.chipB, /Compartilhada\s*·\s*3/);
  assert.match(l.corLinhaB, /^#[0-9a-f]{6}$/); assert.equal(l.imgs, 0);
});

test('U3 (T2): trocar de carteira atualiza nome, cor, chip e toast; mantém o mês; re-renderiza a aba atual', () => {
  const t = o.troca;
  assert.ok(t.ativa && t.modalFechado);
  assert.equal(t.nome, 'Família'); assert.equal(t.cor, t.corEsperada); assert.notEqual(t.cor, o.individual.cor);
  assert.equal(t.chipKind, 'shared'); assert.match(t.chip, /Compartilhada\s*·\s*3/);
  assert.match(t.aria, /^Carteira ativa: Família \(compartilhada com 3 membros\)\. Toque para trocar de carteira$/);
  assert.equal(t.titulo, 'Família · Minhas Carteiras');
  assert.equal(t.mes, '2026-03', 'o mês selecionado deve ser mantido');
  assert.deepEqual(t.renders, [{ aba: 'history', mes: '2026-03' }], 're-renderiza a aba atual (uma vez) com o mês mantido');
  assert.equal(t.toast.texto, 'Agora vendo: Família'); assert.equal(t.toast.role, 'status'); assert.ok(t.toast.visivel);
  assert.equal(t.toast.ponto, t.cor, 'ponto do toast na cor da carteira');
  assert.ok(t.toastSumiu, 'o toast some em ~2,8 s');
});

test('U1 (T2): carteira com 1 membro mostra "Só você" (mesmo sendo do tipo compartilhada)', () => {
  assert.equal(o.umMembro.chip, 'Só você'); assert.equal(o.umMembro.chipKind, 'solo');
});

test('U4: estados — carregando (esqueleto role=status), nenhuma carteira, sem internet, nome longo', () => {
  assert.equal(o.carregando.state, 'loading'); assert.equal(o.carregando.skelRole, 'status'); assert.equal(o.carregando.skelAria, 'Carregando carteira');
  assert.equal(o.carregando.aria, 'Carregando carteira');
  assert.equal(o.vazio.state, 'empty'); assert.equal(o.vazio.nome, 'Escolha uma carteira'); assert.equal(o.vazio.label, 'Toque para criar ou entrar em uma');
  assert.equal(o.vazio.cor, '#64748b', 'faixa cinza');
  assert.equal(o.offline.chip, 'Sem internet'); assert.equal(o.offline.chipKind, 'offline');
  assert.ok(o.longo.aria.includes('Carteira com um nome extremamente longo que não cabe em nenhuma tela de celular pequena'), 'o nome completo vai no aria-label');
  assert.equal(o.longo.nome.length > 60, true, 'o texto não é cortado no JS (a truncagem é CSS: ellipsis)');
});

test('C3/XSS: nome de carteira malicioso vira TEXTO na barra, na lista, no toast e no título', () => {
  assert.equal(o.xss.imgs, 0); assert.equal(o.xss.pwned, false);
  assert.equal(o.xss.barra.nome, '<img src=x onerror=window.__pwned=1>');
  assert.equal(o.xss.toast, 'Agora vendo: <img src=x onerror=window.__pwned=1>');
});

test('U5: terminologia — "Investimentos | Cofrinhos" no seletor de Investir', () => {
  assert.equal(o.estrutura.toggleInvest, '📈 Investimentos'); assert.equal(o.estrutura.toggleCofrinhos, '🐷 Cofrinhos');
  assert.doesNotMatch(read('index.html'), /📈 Carteira</);
});

test('U6: nome de arquivo exportado com a carteira, sem acentos nem espaços', () => {
  assert.equal(o.arquivo.slug, 'familia-2026'); assert.equal(o.arquivo.vazio, 'carteira'); assert.ok(o.arquivo.longo <= 40);
  const app = read('js/app.js');
  assert.match(app, /`lancamentos-\$\{this\._walletFileSlug\(\)\}-\$\{rng\.slug\}\.xlsx`/);
  assert.match(app, /`lancamentos-\$\{this\._walletFileSlug\(\)\}-\$\{rng\.slug\}\.pdf`/);
  assert.match(app, /`backup-\$\{this\._walletFileSlug\(\)\}-\$\{today\}\.xlsx`/);
});

test('U7: sem classes dinâmicas do Tailwind na barra, ?v= e versão do service worker atualizados, reduced-motion respeitado', () => {
  const html = read('index.html'), app = read('js/app.js');
  assert.match(html, /--wallet-accent/);
  assert.doesNotMatch(app.slice(app.indexOf('renderFinancaSwitcher() {'), app.indexOf('bindFinancaUI() {')), /(?:bg|text|border)-\$\{/);
  assert.match(html, /prefers-reduced-motion: no-preference[\s\S]*wb-shimmer/);
  assert.match(html, /<script src="js\/app\.js\?v=\d{8}[a-z]">/);
  assert.match(read('sw.js'), /app-runtime-v20261104a/);
});
