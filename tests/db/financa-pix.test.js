// Chave PIX compartilhada por carteira (migration 20261109000001_financa_pix.sql). Postgres LOCAL de teste; dados fictícios.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./harness');
const { A, B, C, D, F, seed } = require('./seed');
const V = { id: '00000000-0000-0000-0000-000000000006', email: 'u6@teste.com' };   // visualizador de F
let db;
test.before(async () => {
  db = await createTestDb(); await seed(db);
  await db.admin.query('insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())', [V.id, V.email]);
  await db.admin.query(`insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'visualizador')`, [F, V.id, V.email]);
});
test.after(async () => { await db.close(); });

test('membro grava a chave; todos os membros leem a mesma; estranho não lê', async () => {
  const w = await db.as(C, c => db.try(c, `insert into financa_pix(financa_id,pix_key,name,bank) values ($1,'chave-teste','Fulano','Banco X')`, [F]));
  assert.equal(w.ok, true, w.error);
  await db.admin.query(`insert into financa_pix(financa_id,pix_key) values ($1,'chave-teste') on conflict (financa_id) do nothing`, [F]);
  for (const u of [A, B, C, V]) {
    const r = await db.as(u, async c => (await c.query('select pix_key from financa_pix where financa_id = $1', [F])).rows);
    assert.equal(r.length, 1, `usuário ${u.email} deveria ler`);
  }
  const d = await db.as(D, async c => (await c.query('select 1 from financa_pix')).rows);
  assert.equal(d.length, 0);
});

test('visualizador e estranho não escrevem; admin altera e exclui', async () => {
  await db.admin.query(`insert into financa_pix(financa_id,pix_key) values ($1,'k0') on conflict (financa_id) do update set pix_key='k0'`, [F]);
  const v = await db.as(V, c => db.try(c, `update financa_pix set pix_key='x' where financa_id=$1`, [F]));
  assert.equal(v.ok && v.rowCount > 0, false);
  const vi = await db.as(V, c => db.try(c, `delete from financa_pix where financa_id=$1`, [F]));
  assert.equal(vi.ok && vi.rowCount > 0, false);
  const d = await db.as(D, c => db.try(c, `update financa_pix set pix_key='x' where financa_id=$1`, [F]));
  assert.equal(d.ok && d.rowCount > 0, false);
  const b = await db.as(B, c => db.try(c, `update financa_pix set pix_key='novo' where financa_id=$1`, [F]));
  assert.equal(b.ok && b.rowCount, 1);
  const bd = await db.as(B, c => db.try(c, `delete from financa_pix where financa_id=$1`, [F]));
  assert.equal(bd.ok && bd.rowCount, 1);
});

test('anon não acessa a tabela', async () => {
  const r = (await db.admin.query(`select has_table_privilege('anon','public.financa_pix','select') s`)).rows[0].s;
  assert.equal(r, false);
});
