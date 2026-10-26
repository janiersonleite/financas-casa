// Testes da lógica pura de supabase/functions/send-invite/handler.ts (sem rede, sem Supabase).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createCollector } = require('../qa-findings');
const col = createCollector('send-invite-findings.json');
test.after(() => col.flush());

const H = import(pathToFileURL(path.join(__dirname, '..', '..', 'supabase', 'functions', 'send-invite', 'handler.ts')).href);
const FID = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-10-20T12:00:00Z');

function mkDeps(over = {}) {
  const calls = { sent: [], marked: [] };
  const deps = {
    getUser: async t => (t === 'tok' ? { id: 'u1', email: 'admin@x.com' } : null),
    isAdmin: async () => true,
    getFinanca: async () => ({ name: 'Casa', emoji: '🏠' }),
    getInvite: async () => ({ id: 'inv1', accepted_at: null, expires_at: '2026-11-20T00:00:00Z', emailed_at: null, email_count: 0 }),
    countRecentEmailsBy: async () => 0,
    sendEmail: async m => { calls.sent.push(m); return { ok: true, status: 200 }; },
    markEmailed: async id => { calls.marked.push(id); },
    now: () => NOW,
    appUrl: 'https://minhascarteiras.com.br',
    ...over
  };
  return { deps, calls };
}
const body = (o = {}) => ({ financa_id: FID, email: 'novo@x.com', ...o });

test('401 sem token / token inválido', async () => {
  const { handleSendInvite } = await H; const { deps } = mkDeps();
  assert.equal((await handleSendInvite(deps, null, body())).status, 401);
  assert.equal((await handleSendInvite(deps, 'ruim', body())).status, 401);
});

test('400 com UUID ou e-mail inválido / corpo vazio', async () => {
  const { handleSendInvite } = await H; const { deps } = mkDeps();
  for (const b of [body({ financa_id: 'abc' }), body({ email: 'sem-arroba' }), body({ email: 'a@b' }), body({ email: 'a b@x.com' }), body({ email: 'a@x.com'.padEnd(260, 'x') + '.com' }), null, {}, { financa_id: 5, email: 6 }])
    assert.equal((await handleSendInvite(deps, 'tok', b)).status, 400, JSON.stringify(b));
});

test('validação estrita de UUID: 36 hífens e formatos quase-UUID → 400 (FN-01)', async () => {
  const { handleSendInvite } = await H; const { deps } = mkDeps();
  for (const id of ['-'.repeat(36), FID.replace(/4/g, 'g'), FID.slice(1), FID + 'a', ' ' + FID])
    assert.equal((await handleSendInvite(deps, 'tok', body({ financa_id: id }))).status, 400, id);
  assert.equal((await handleSendInvite(deps, 'tok', body({ financa_id: FID.toUpperCase() }))).status, 200);
  col.add('FN-01', 'CORRIGIDO', 'financa_id validado como UUID estrito (8-4-4-4-12 hex)');
});

test('403 se não for admin', async () => {
  const { handleSendInvite } = await H; const { deps, calls } = mkDeps({ isAdmin: async () => false });
  assert.equal((await handleSendInvite(deps, 'tok', body())).status, 403);
  assert.equal(calls.sent.length, 0);
});

test('404 convite inexistente / aceito / expirado', async () => {
  const { handleSendInvite } = await H;
  const inv = o => ({ id: 'i', accepted_at: null, expires_at: '2026-11-01T00:00:00Z', emailed_at: null, email_count: 0, ...o });
  for (const getInvite of [async () => null, async () => inv({ accepted_at: '2026-10-01T00:00:00Z' }), async () => inv({ expires_at: '2026-10-01T00:00:00Z' })]) {
    const { deps } = mkDeps({ getInvite });
    assert.equal((await handleSendInvite(deps, 'tok', body())).status, 404);
  }
  // sem expires_at = nunca expira
  const { deps, calls } = mkDeps({ getInvite: async () => inv({ expires_at: null }) });
  assert.equal((await handleSendInvite(deps, 'tok', body())).status, 200); assert.equal(calls.sent.length, 1);
});

test('429: too_soon (<5 min), limit_reached (5) e hourly_limit (20)', async () => {
  const { handleSendInvite } = await H;
  const base = { id: 'i', accepted_at: null, expires_at: '2026-11-20T00:00:00Z', emailed_at: null, email_count: 0 };
  let r = await handleSendInvite(mkDeps({ getInvite: async () => ({ ...base, emailed_at: new Date(NOW - 60e3).toISOString(), email_count: 1 }) }).deps, 'tok', body());
  assert.equal(r.status, 429); assert.equal(r.body.error, 'too_soon'); assert.equal(r.body.retry_after, 240);
  r = await handleSendInvite(mkDeps({ getInvite: async () => ({ ...base, email_count: 5 }) }).deps, 'tok', body());
  assert.equal(r.status, 429); assert.equal(r.body.error, 'limit_reached');
  r = await handleSendInvite(mkDeps({ countRecentEmailsBy: async () => 20 }).deps, 'tok', body());
  assert.equal(r.status, 429); assert.equal(r.body.error, 'hourly_limit');
  // limites logo abaixo passam
  r = await handleSendInvite(mkDeps({ getInvite: async () => ({ ...base, email_count: 4, emailed_at: new Date(NOW - 301e3).toISOString() }), countRecentEmailsBy: async () => 19 }).deps, 'tok', body());
  assert.equal(r.status, 200);
});

test('502 se o envio falhar (resposta !ok ou exceção) e não marca como enviado', async () => {
  const { handleSendInvite } = await H;
  for (const sendEmail of [async () => ({ ok: false, status: 500 }), async () => { throw new Error('rede'); }]) {
    const { deps, calls } = mkDeps({ sendEmail });
    assert.equal((await handleSendInvite(deps, 'tok', body())).status, 502);
    assert.equal(calls.marked.length, 0);
  }
});

test('200: envia 1 e-mail, marca emailed e usa reply-to do convidante; e-mail normalizado', async () => {
  const { handleSendInvite } = await H; const { deps, calls } = mkDeps();
  const r = await handleSendInvite(deps, 'tok', body({ email: '  NOVO@X.com ' }));
  assert.equal(r.status, 200);
  assert.deepEqual(calls.marked, ['inv1']);
  assert.equal(calls.sent[0].to, 'novo@x.com'); assert.equal(calls.sent[0].replyTo, 'admin@x.com');
});

test('escape de HTML: nome de carteira com <script>, aspas e emoji hostil', async () => {
  const { handleSendInvite, esc } = await H;
  const nome = `<script>alert("x")</script>' onerror='1`;
  const { deps, calls } = mkDeps({ getFinanca: async () => ({ name: nome, emoji: '<img src=x onerror=alert(1)>' }) });
  await handleSendInvite(deps, 'tok', body());
  const { html, subject, text } = calls.sent[0];
  assert.ok(!html.includes('<script>') && !html.includes('<img'), 'HTML não escapado');
  assert.ok(html.includes('&lt;script&gt;') && html.includes('&quot;x&quot;') && html.includes('&#39;'));
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  // o assunto e a parte texto vão crus (não são HTML) — registrar para o relatório
  assert.ok(subject.includes('<script>') && text.includes('<script>'));
});

test('inviterEmail e appUrl também são escapados no HTML', async () => {
  const { buildEmail } = await H;
  const m = buildEmail({ inviterEmail: '"><b>x</b>@x.com', financaName: 'C', emoji: '💰', to: 'a@b.com', appUrl: 'https://x/?a=1&b="2"' });
  assert.ok(!m.html.includes('<b>x</b>')); assert.ok(m.html.includes('&amp;b=&quot;2&quot;'));
});

test('D1: convidante com e-mail NÃO confirmado → 403', async () => {
  const { handleSendInvite } = await H;
  const { deps, calls } = mkDeps({ getUser: async () => ({ id: 'u1', email: 'admin@x.com', emailConfirmed: false }) });
  const r = await handleSendInvite(deps, 'tok', body());
  assert.equal(r.status, 403); assert.equal(r.body.error, 'email_not_confirmed'); assert.equal(calls.sent.length, 0);
  const ok = mkDeps({ getUser: async () => ({ id: 'u1', email: 'admin@x.com', emailConfirmed: true }) });
  assert.equal((await handleSendInvite(ok.deps, 'tok', body())).status, 200);
  col.add('FN-03', 'CORRIGIDO', 'send-invite exige e-mail confirmado do convidante');
});

test('D1: nome da carteira limitado a 80 caracteres e sem quebras de linha no assunto', async () => {
  const { handleSendInvite, safeName, MAX_NAME_LEN } = await H;
  assert.equal(MAX_NAME_LEN, 80);
  const longo = 'A'.repeat(500);
  assert.ok(safeName(longo).length <= 80 && safeName(longo).endsWith('…'));
  assert.equal(safeName('Casa\r\nBcc: x@y.com\u2028linha'), 'Casa Bcc: x@y.com linha');
  const { deps, calls } = mkDeps({ getFinanca: async () => ({ name: longo + '\nBcc: atacante@x.com', emoji: '🏠' }) });
  await handleSendInvite(deps, 'tok', body());
  const m = calls.sent[0];
  assert.ok(!/[\r\n]/.test(m.subject), 'assunto com quebra de linha');
  assert.ok(m.subject.length < 140 && !m.html.includes('A'.repeat(100)) && !m.text.includes('A'.repeat(100)));
  col.add('FN-02', 'CORRIGIDO', 'Nome da carteira no e-mail: ≤ 80 caracteres, sem quebras de linha/controle');
});

test('D1: index.ts usa .eq (sem ilike/curingas) e o RPC atômico mark_invite_emailed', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'supabase', 'functions', 'send-invite', 'index.ts'), 'utf8');
  assert.ok(!/\.ilike\(/.test(src), 'ilike ainda presente');
  assert.ok(/\.eq\('email', email\)/.test(src));
  assert.ok(/rpc\('mark_invite_emailed'/.test(src));
  assert.ok(!/email_count: \(data\?\.email_count/.test(src), 'incremento não atômico ainda presente');
  assert.ok(/email_confirmed_at/.test(src));
});
