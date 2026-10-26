// A2 / A1 / A6 — convites e membros (sobre o estado REAL da produção: tests/db/prod-state.sql).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./harness');
const { createCollector } = require('../qa-findings');
const { A, B, C, D, E_UNCONF, F, G, seed } = require('./seed');
const col = createCollector('fix-invites-findings.json');
let db;
test.before(async () => { db = await createTestDb(); await seed(db); });
test.after(async () => { col.flush(); await db.close(); });

const convite = (email, role, extra = '') => db.admin.query(
  `insert into financa_invites(financa_id,email,role,invited_by${extra ? ',' + extra.split('=')[0] : ''}) values ($1,$2,$3,$4${extra ? ',' + extra.split('=')[1] : ''}) returning id`, [F, email, role, A.id]).then(r => r.rows[0].id);
const limpa = async () => { await db.admin.query('delete from financa_invites'); await db.admin.query('delete from financa_members where user_id = any($1)', [[D.id, E_UNCONF.id]]); };

test('A2: accept_invite — papel DO CONVITE, valida e-mail/confirmação/estado, devolve a carteira', async () => {
  const id = await convite(D.email, 'visualizador');
  const r = await db.as(D, async c => {
    const f = (await c.query('select accept_invite($1) f', [id])).rows[0].f;
    const papel = (await c.query('select role from financa_members where financa_id=$1 and user_id=$2', [F, D.id])).rows[0].role;
    const marcado = (await c.query('select accepted_at is not null a from financa_invites where id=$1', [id])).rows[0].a;
    const denovo = await db.try(c, 'select accept_invite($1)', [id]);   // convite já aceito não é aceito de novo
    return { f, papel, marcado, denovo };
  });
  assert.equal(r.f, F); assert.equal(r.papel, 'visualizador'); assert.equal(r.marcado, true);
  assert.equal(r.denovo.ok, false);
  await limpa();

  // convite de OUTRO e-mail
  const alheio = await convite(C.email, 'admin');
  const x = await db.as(D, c => db.try(c, 'select accept_invite($1)', [alheio]));
  assert.equal(x.ok, false);
  await limpa();

  // expirado
  const exp = await db.admin.query(`insert into financa_invites(financa_id,email,role,invited_by,expires_at) values ($1,$2,'membro',$3, now() - interval '1 day') returning id`, [F, D.email, A.id]);
  const e = await db.as(D, c => db.try(c, 'select accept_invite($1)', [exp.rows[0].id]));
  assert.equal(e.ok, false);
  await limpa();

  // e-mail NÃO confirmado
  const nc = await db.admin.query(`insert into financa_invites(financa_id,email,role,invited_by) values ($1,$2,'admin',$3) returning id`, [F, E_UNCONF.email, A.id]);
  const u = await db.as(E_UNCONF, c => db.try(c, 'select accept_invite($1)', [nc.rows[0].id]));
  assert.equal(u.ok, false);
  await limpa();

  // quem já é membro com papel maior NÃO é rebaixado/alterado (ON CONFLICT DO NOTHING)
  const ja = await convite(B.email, 'visualizador');
  const papelB = await db.as(B, async c => { await c.query('select accept_invite($1)', [ja]); return (await c.query('select role from financa_members where financa_id=$1 and user_id=$2', [F, B.id])).rows[0].role; });
  assert.equal(papelB, 'admin');
  await limpa();

  // anon não executa; sem login falha
  const anon = await db.as(null, c => db.try(c, 'select accept_invite($1)', ['00000000-0000-0000-0000-000000000000']), { role: 'anon' });
  assert.equal(anon.ok, false);
  col.add('A2', 'CORRIGIDO', 'accept_invite: papel vem do convite; valida e-mail, confirmação, validade; anon sem acesso');
});

test('A2: front — Storage.acceptInvite usa a RPC (sem upsert/update direto em financa_members/financa_invites)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'js', 'storage.js'), 'utf8');
  const corpo = src.slice(src.indexOf('async acceptInvite('), src.indexOf('// ── Categories'));
  assert.match(corpo, /rpc\('accept_invite'/);
  assert.doesNotMatch(corpo, /\.from\('financa_members'\)|\.from\('financa_invites'\)|\.upsert\(|\.update\(/);
});

test('A1: members_insert só para admin — estranho, membro comum e ex-membro NÃO entram; dono criando carteira entra', async () => {
  const r = await db.as(D, async c => ({
    admin: await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'admin')`, [F, D.id, D.email]),
    membro: await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'membro')`, [F, D.id, D.email]),
    viz: await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'visualizador')`, [F, D.id, D.email]),
    le: (await c.query('select count(*)::int n from transactions where financa_id=$1', [F])).rows[0].n
  }));
  assert.equal(r.admin.ok, false, 'estranho virou admin'); assert.equal(r.membro.ok, false); assert.equal(r.viz.ok, false); assert.equal(r.le, 0);
  assert.match(r.admin.error, /row-level security/);

  // membro comum: não adiciona ninguém nem se "promove" (upsert exigiria UPDATE, que não existe)
  const c1 = await db.as(C, async c => ({
    outro: await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'membro')`, [F, D.id, D.email]),
    promove: await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'admin') on conflict (financa_id,user_id) do update set role='admin'`, [F, C.id, C.email]),
    update: await db.try(c, `update financa_members set role='admin' where financa_id=$1 and user_id=$2 returning id`, [F, C.id]),
  }));
  assert.equal(c1.outro.ok, false); assert.equal(c1.promove.ok, false); assert.ok(!c1.update.ok || c1.update.rowCount === 0);

  // ex-membro removido NÃO volta sozinho
  const volta = await db.as(C, async c => {
    await db.try(c, 'delete from financa_members where financa_id=$1 and user_id=$2', [F, C.id]);   // "sair da carteira" (policy members_delete)
    return db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'membro')`, [F, C.id, C.email]);
  });
  assert.equal(volta.ok, false, 'ex-membro voltou sozinho');

  // fluxo createFinanca (storage.js): dono cria a carteira e se registra como admin
  const Nova = '00000000-0000-0000-0000-0000000000f9';
  await db.as(B, async c => {
    await c.query(`insert into financas(id,name,type) values ($1,'Nova','compartilhada')`, [Nova]);   // trigger define owner_id = auth.uid()
    const eu = await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'admin')`, [Nova, B.id, B.email]);
    assert.equal(eu.ok, true, 'dono não conseguiu se registrar: ' + eu.error);
    const outro = await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'membro')`, [Nova, C.id, C.email]);
    assert.equal(outro.ok, true, 'admin não conseguiu adicionar outra pessoa');
    const xpto = await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'xpto')`, [Nova, D.id, D.email]);
    assert.equal(xpto.ok, false);   // CHECK de role (já existe: F10)
  });
  // o "Pessoal" automático (app.js ~142) também é createFinanca → mesmo caminho
  col.add('A1', 'CORRIGIDO', 'members_insert exige is_financa_admin', r.admin.error);
});

test('A2 (policy): invites_update só admin — convidado não reescreve role/financa_id/aceite do próprio convite', async () => {
  const id = await convite(D.email, 'visualizador');
  const r = await db.as(D, async c => ({
    role: await db.try(c, `update financa_invites set role='admin' where id=$1 returning id`, [id]),
    carteira: await db.try(c, `update financa_invites set financa_id=$2 where id=$1 returning id`, [id, G]),
    aceite: await db.try(c, `update financa_invites set accepted_at=now() where id=$1 returning id`, [id]),
    email: await db.try(c, `update financa_invites set email='outro@teste.com' where id=$1 returning id`, [id]),
    ve: (await c.query('select count(*)::int n from financa_invites where id=$1', [id])).rows[0].n
  }));
  for (const k of ['role', 'carteira', 'aceite', 'email']) assert.ok(!r[k].ok || r[k].rowCount === 0, `convidado conseguiu editar (${k})`);
  assert.equal(r.ve, 1, 'convidado deve continuar VENDO o próprio convite');
  // admin da carteira edita (reenviar/mudar papel) — mas não leva o convite para carteira em que não é admin
  const adm = await db.as(B, async c => ({
    papel: await db.try(c, `update financa_invites set role='membro' where id=$1 returning id`, [id]),
    leva: await db.try(c, `update financa_invites set financa_id=$2 where id=$1 returning id`, [id, G]),
  }));
  assert.equal(adm.papel.rowCount, 1); assert.ok(!adm.leva.ok || adm.leva.rowCount === 0);
  // membro comum não edita
  const comum = await db.as(C, c => db.try(c, `update financa_invites set role='admin' where id=$1 returning id`, [id]));
  assert.ok(!comum.ok || comum.rowCount === 0);
  // o aceite legítimo continua pela RPC mesmo com a policy fechada
  const ok = await db.as(D, async c => { await c.query('select accept_invite($1)', [id]); return (await c.query('select role from financa_members where financa_id=$1 and user_id=$2', [F, D.id])).rows[0].role; });
  assert.equal(ok, 'visualizador');
  await limpa();
  col.add('A2b', 'CORRIGIDO', 'invites_update: USING e WITH CHECK is_financa_admin');
});
