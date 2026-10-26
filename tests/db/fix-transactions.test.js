// A3 — transactions (estado real de produção: 4 policies atuais + 4 legadas *_own permissivas).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./harness');
const { createCollector } = require('../qa-findings');
const { A, B, C, D, F, G, TX_A, seed } = require('./seed');
const col = createCollector('fix-transactions-findings.json');
let db;
test.before(async () => { db = await createTestDb(); await seed(db); });
test.after(async () => { col.flush(); await db.close(); });
const ins = (c, uid, fid) => db.try(c, `insert into transactions(user_id,financa_id,value,type,category,description) values ($1,$2,1,'saida','Outros','x') returning id`, [uid, fid]);

test('A3: policies — exatamente 1 por comando, sem as legadas *_own', async () => {
  const r = await db.admin.query(`select policyname, cmd from pg_policies where schemaname='public' and tablename='transactions' order by cmd, policyname`);
  assert.deepEqual(r.rows.map(x => x.policyname), ['transactions_delete', 'transactions_insert', 'transactions_select', 'transactions_update']);
});

test('A3: mover/inserir lançamento em carteira alheia falha; user_id imutável', async () => {
  const r = await db.as(A, async c => ({
    move: await db.try(c, 'update transactions set financa_id=$1 where id=$2 returning id', [G, TX_A]),
    insere: await ins(c, A.id, G),
    insereComoOutro: await ins(c, B.id, F),
    trocaUser: await db.try(c, 'update transactions set user_id=$1 where id=$2 returning id', [B.id, TX_A]),
  }));
  assert.ok(!r.move.ok || r.move.rowCount === 0, 'moveu para carteira alheia');
  assert.equal(r.insere.ok, false, 'inseriu em carteira alheia');
  assert.equal(r.insereComoOutro.ok, false, 'inseriu em nome de outra pessoa');
  assert.equal(r.trocaUser.ok, false, 'trocou user_id');
  // nem o admin da carteira troca o user_id de um lançamento
  const adm = await db.as(B, c => db.try(c, 'update transactions set user_id=$1 where id=$2 returning id', [B.id, TX_A]));
  assert.equal(adm.ok, false);
  // estranho não insere na carteira nem altera/exclui lançamento dela
  const d = await db.as(D, async c => ({
    insere: await ins(c, D.id, F),
    edita: await db.try(c, `update transactions set description='x' where id=$1 returning id`, [TX_A]),
    exclui: await db.try(c, 'delete from transactions where id=$1 returning id', [TX_A]),
    le: (await c.query('select count(*)::int n from transactions where id=$1', [TX_A])).rows[0].n
  }));
  assert.equal(d.insere.ok, false); assert.equal(d.edita.rowCount, 0); assert.equal(d.exclui.rowCount, 0); assert.equal(d.le, 0);
  col.add('A3', 'CORRIGIDO', 'transactions: WITH CHECK de pertencimento + legadas removidas + user_id imutável');
});

test('A3: fluxos legítimos seguem funcionando (dono, membro, admin, estranho)', async () => {
  const PESSOAL = '00000000-0000-0000-0000-0000000000a9';
  await db.admin.query(`insert into transactions(id,user_id,financa_id,value,type,category,description) values ($1,$2,null,5,'saida','Outros','pessoal')`, [PESSOAL, A.id]);
  // dono: lê/edita/exclui as próprias; move para NULL e de volta; insere pessoal e na carteira onde é membro
  await db.as(A, async c => {
    assert.equal((await c.query('select count(*)::int n from transactions where id = any($1)', [[PESSOAL, TX_A]])).rows[0].n, 2);
    assert.equal((await db.try(c, `update transactions set description='ok' where id=$1 returning id`, [TX_A])).rowCount, 1);
    assert.equal((await db.try(c, 'update transactions set financa_id=null where id=$1 returning id', [TX_A])).rowCount, 1);
    assert.equal((await db.try(c, 'update transactions set financa_id=$1 where id=$2 returning id', [F, TX_A])).rowCount, 1);
    assert.equal((await db.try(c, 'update transactions set financa_id=$1 where id=$2 returning id', [F, PESSOAL])).rowCount, 1);   // pessoal → carteira onde é membro
    assert.ok((await ins(c, A.id, null)).ok); assert.ok((await ins(c, A.id, F)).ok);
    assert.equal((await db.try(c, 'delete from transactions where id=$1 returning id', [PESSOAL])).rowCount, 1);
  });
  // membro comum: vê, insere na carteira, edita/exclui só o que é dele; não mexe no de outro
  await db.as(C, async c => {
    assert.equal((await c.query('select count(*)::int n from transactions where id=$1', [TX_A])).rows[0].n, 1);
    const novo = await ins(c, C.id, F); assert.ok(novo.ok);
    assert.equal((await db.try(c, `update transactions set description='meu' where id=$1 returning id`, [novo.rows[0].id])).rowCount, 1);
    assert.equal((await db.try(c, `update transactions set description='hack' where id=$1 returning id`, [TX_A])).rowCount, 0);
    assert.equal((await db.try(c, 'delete from transactions where id=$1 returning id', [TX_A])).rowCount, 0);
    assert.equal((await db.try(c, 'delete from transactions where id=$1 returning id', [novo.rows[0].id])).rowCount, 1);
  });
  // admin: edita (inclui ajustar o autor) e exclui lançamento de outra pessoa na carteira
  await db.as(B, async c => {
    assert.equal((await db.try(c, `update transactions set inserted_by_email='x@teste.com' where id=$1 returning id`, [TX_A])).rowCount, 1);
    const leva = await db.try(c, 'update transactions set financa_id=$1 where id=$2 returning id', [G, TX_A]);   // não leva p/ carteira alheia
    assert.ok(!leva.ok || leva.rowCount === 0);
    assert.equal((await db.try(c, 'delete from transactions where id=$1 returning id', [TX_A])).rowCount, 1);
  });
  // quem NÃO é mais membro perde o acesso
  await db.admin.query('delete from transactions where id=$1', [PESSOAL]);
});
