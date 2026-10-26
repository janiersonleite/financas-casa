// A8 — grants de EXECUTE (estado real de produção: anon e authenticated executam quase tudo).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./harness');
const { createCollector } = require('../qa-findings');
const { A, B, C, D, F, seed } = require('./seed');
const col = createCollector('fix-grants-findings.json');
let db;
test.before(async () => { db = await createTestDb(); await seed(db); });
test.after(async () => { col.flush(); await db.close(); });

const RPCS_APP = ['add_member_by_email(uuid, text, text)', 'auto_accept_my_invites()', 'get_my_pending_invites()', 'link_my_transactions_to_financa(uuid)',
  'register_push_subscription(text, text, text, text)', 'sync_push_queue(text, jsonb)', 'accept_invite(uuid)'];
const SO_SERVICE = ['claim_due_push(integer)', 'cleanup_push_queue()'];
const TRIGGERS = ['financa_members_set_user()', 'financas_set_owner()', 'handle_updated_at()', 'transactions_set_inserted_by()', 'update_updated_at_column()'];
const USADAS_PELAS_POLICIES = ['is_financa_member(uuid)', 'is_financa_admin(uuid)', 'can_access_cofrinho(uuid, uuid)', 'my_invite_email_matches(text)'];
const priv = async (role, sig) => (await db.admin.query('select has_function_privilege($1, $2::regprocedure, \'execute\') p', [role, 'public.' + sig])).rows[0].p;

test('A8: RPCs do app — anon NÃO executa; authenticated executa', async () => {
  for (const sig of [...RPCS_APP, 'unregister_push_subscription(text)']) {
    assert.equal(await priv('anon', sig), false, `anon ainda executa ${sig}`);
    assert.equal(await priv('authenticated', sig), true, `authenticated perdeu ${sig}`);
    assert.equal(await priv('service_role', sig), true, `service_role perdeu ${sig}`);
  }
});

test('A8: claim_due_push e cleanup_push_queue — só service_role', async () => {
  for (const sig of SO_SERVICE) {
    assert.equal(await priv('anon', sig), false); assert.equal(await priv('authenticated', sig), false);
    assert.equal(await priv('service_role', sig), true);
    assert.equal((await db.admin.query('select has_function_privilege(0, $1::regprocedure, \'execute\') p', ['public.' + sig]).catch(() => ({ rows: [{ p: false }] }))).rows[0].p, false);
  }
});

test('A8: funções de trigger — anon/authenticated não executam', async () => {
  for (const sig of [...TRIGGERS, 'transactions_lock_user_id()', 'lock_row_user_id()', 'financas_lock_owner()']) {
    assert.equal(await priv('anon', sig), false, `anon executa ${sig}`); assert.equal(await priv('authenticated', sig), false, `authenticated executa ${sig}`);
  }
  // triggers continuam disparando (INSERT em financas define owner; UPDATE de transactions atualiza updated_at)
  await db.as(B, async c => {
    await c.query(`insert into financas(id,name,type) values ('00000000-0000-0000-0000-0000000000fc','T','individual')`);
    await c.query('reset role');
    assert.equal((await c.query(`select owner_id from financas where id='00000000-0000-0000-0000-0000000000fc'`)).rows[0].owner_id, B.id);
  });
});

test('A8: helpers usados pelas policies NÃO foram revogados (RLS segue funcionando)', async () => {
  for (const sig of USADAS_PELAS_POLICIES) assert.equal(await priv('authenticated', sig), true, `authenticated perdeu ${sig}`);
  const r = await db.as(C, async c => (await c.query('select count(*)::int n from transactions where financa_id=$1', [F])).rows[0].n);
  assert.equal(r, 1);
});

test('A8: chamadas reais — authenticated segue usando as RPCs; anon é recusado', async () => {
  const b = await db.as(B, async c => ({
    add: await db.try(c, `select add_member_by_email($1,'novo@teste.com','membro') r`, [F]),
    pend: await db.try(c, 'select * from get_my_pending_invites()'),
    auto: await db.try(c, 'select auto_accept_my_invites() n'),
    link: await db.try(c, 'select link_my_transactions_to_financa($1) n', [F]),
    reg: await db.try(c, `select register_push_subscription('https://fcm.googleapis.com/fcm/send/abc','p','a','ua')`),
    sync: await db.try(c, `select sync_push_queue('s', '[]'::jsonb) n`),
    unreg: await db.try(c, `select unregister_push_subscription('https://fcm.googleapis.com/fcm/send/abc')`),
  }));
  for (const [k, v] of Object.entries(b)) assert.equal(v.ok, true, `${k}: ${v.error}`);
  assert.equal(b.add.rows[0].r, 'invited');
  const anon = await db.as(null, async c => {
    const out = {};
    for (const q of ['select add_member_by_email($1,\'x@x.com\',\'membro\')', 'select auto_accept_my_invites()', 'select * from get_my_pending_invites()', 'select link_my_transactions_to_financa($1)',
      'select register_push_subscription(\'https://fcm.googleapis.com/x\',\'p\',\'a\')', 'select sync_push_queue(\'s\',\'[]\'::jsonb)', 'select accept_invite($1)']) {
      out[q.slice(0, 40)] = await db.try(c, q, q.includes('$1') ? [F] : []);
    }
    return out;
  }, { role: 'anon' });
  for (const [k, v] of Object.entries(anon)) { assert.equal(v.ok, false, `anon executou: ${k}`); assert.match(v.error, /permission denied/); }
  col.add('A8', 'CORRIGIDO', 'EXECUTE: RPCs só authenticated; claim/cleanup só service_role; triggers fechadas; helpers de policy preservados');
});

test('A10: monthly_summary — security_invoker e sem acesso anônimo; usuário só vê os próprios totais', async () => {
  const opts = (await db.admin.query(`select coalesce(reloptions::text,'') o from pg_class where oid='public.monthly_summary'::regclass`)).rows[0].o;
  assert.match(opts, /security_invoker=(true|on)/);
  assert.equal((await db.admin.query(`select has_table_privilege('anon','public.monthly_summary','select') p`)).rows[0].p, false);
  assert.equal((await db.admin.query(`select has_table_privilege('authenticated','public.monthly_summary','select') p`)).rows[0].p, true);
  // lançamentos do A (carteira F) e do D: cada um só enxerga o próprio; membro comum vê só o dele (RLS da base vale para a view)
  await db.admin.query(`insert into transactions(user_id,financa_id,value,type,category,description,date) values ($1,null,100,'entrada','Outros','d','2026-10-10')`, [D.id]);
  const ve = async u => (await db.as(u, c => c.query('select user_id, total_income::float ti from monthly_summary'))).rows;
  const vD = await ve(D); assert.deepEqual(vD.map(r => r.user_id), [D.id]); assert.equal(vD[0].ti, 100);
  const vC = await ve(C); assert.ok(vC.every(r => r.user_id !== D.id), 'view vazou linhas de usuário sem relação');   // C vê as da carteira compartilhada (RLS), não as do D
  const vE = await ve(require('./seed').E_UNCONF); assert.deepEqual(vE, []);
  const anon = await db.as(null, c => db.try(c, 'select * from monthly_summary'), { role: 'anon' });
  assert.equal(anon.ok, false);
  col.add('A10', 'CORRIGIDO', 'monthly_summary: security_invoker=true, sem acesso anon (front não a usa)');
});

test('A11: cofrinho_movs_update — o front edita movimentações (Cofrinhos.updateMov); user_id/cofrinho_id/kind imutáveis; estranho não edita', async () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'js', 'cofrinhos.js'), 'utf8');
  assert.match(src, /from\('cofrinho_movs'\)\.update\(/, 'o front não usa mais UPDATE em cofrinho_movs: remover a policy (ver DECISOES)');
  const COF = '00000000-0000-0000-0000-0000000000d1', COF_D = '00000000-0000-0000-0000-0000000000d2', MOV = '00000000-0000-0000-0000-0000000000d3';
  await db.admin.query(`insert into cofrinhos(id,user_id,financa_id,name,target_amount) values ($1,$2,$3,'Viagem',1000),($4,$5,null,'Do D',10)`, [COF, A.id, F, COF_D, D.id]);
  await db.admin.query(`insert into cofrinho_movs(id,cofrinho_id,user_id,kind,amount) values ($1,$2,$3,'deposito',100)`, [MOV, COF, A.id]);
  const m = await db.as(C, async c => ({   // membro da carteira edita a movimentação criada por outro membro
    edita: await db.try(c, `update cofrinho_movs set amount=150, note='ajuste' where id=$1 returning id`, [MOV]),
    trocaUser: await db.try(c, `update cofrinho_movs set user_id=$2 where id=$1 returning id`, [MOV, C.id]),
    trocaKind: await db.try(c, `update cofrinho_movs set kind='retirada' where id=$1 returning id`, [MOV]),
    leva: await db.try(c, `update cofrinho_movs set cofrinho_id=$2 where id=$1 returning id`, [MOV, COF_D]),
  }));
  assert.equal(m.edita.rowCount, 1);
  assert.equal(m.trocaUser.ok, false, 'user_id alterado'); assert.equal(m.trocaKind.ok, false, 'kind alterado'); assert.equal(m.leva.ok, false, 'movimentação levada para outro cofrinho');
  const d = await db.as(D, c => db.try(c, `update cofrinho_movs set amount=1 where id=$1 returning id`, [MOV]));
  assert.ok(!d.ok || d.rowCount === 0, 'estranho editou movimentação');
  col.add('A11', 'CORRIGIDO', 'cofrinho_movs_update mantida (front edita) com user_id/cofrinho_id/kind imutáveis');
});
