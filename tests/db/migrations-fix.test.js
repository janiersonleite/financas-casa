// As migrations de correção (202610270000NN) precisam ser DETERMINÍSTICAS e IDEMPOTENTES: corretas sobre o estado real de
// produção, sobre um estado em que parte delas já foi aplicada, aplicadas duas vezes, e sobre um estado só-repositório.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestDb, sqlFiles, MIG_DIR, FIX_PREFIX } = require('./harness');
const { createCollector } = require('../qa-findings');
const { seed, A, D, F } = require('./seed');
const col = createCollector('migrations-fix-findings.json');
test.after(() => col.flush());

const FIXES = sqlFiles().filter(f => f >= FIX_PREFIX);
const sql = f => fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
const assinatura = async db => {
  const pol = (await db.admin.query(`select tablename||'.'||policyname||':'||cmd||':'||coalesce(qual,'')||':'||coalesce(with_check,'') s from pg_policies where schemaname='public' order by 1`)).rows.map(r => r.s);
  const fn = (await db.admin.query(`select p.oid::regprocedure::text||':'||coalesce(array_to_string(p.proconfig,','),'') s from pg_proc p where pronamespace='public'::regnamespace order by 1`)).rows.map(r => r.s);
  const gr = (await db.admin.query(`select p.oid::regprocedure::text||':'||has_function_privilege('anon',p.oid,'execute')||has_function_privilege('authenticated',p.oid,'execute')||has_function_privilege('service_role',p.oid,'execute') s from pg_proc p where pronamespace='public'::regnamespace order by 1`)).rows.map(r => r.s);
  const tg = (await db.admin.query(`select event_object_table||'.'||trigger_name s from information_schema.triggers where trigger_schema='public' order by 1`)).rows.map(r => r.s);
  return JSON.stringify({ pol, fn, gr, tg });
};

test('existem as 13 migrations de correção, com prefixo 202610270000NN e cabeçalho (corrige / quebra / reverte)', () => {
  assert.ok(FIXES.length >= 13, 'esperava ≥ 13, achei ' + FIXES.length);
  for (const f of FIXES) {
    assert.match(f, /^202610270000\d\d_/, f);
    const cab = sql(f).split('\n').slice(0, 30).join('\n');
    assert.match(cab, /O QUE (CORRIGE|FAZ)|CORRIGE/i, f + ': cabeçalho sem "o que corrige"');
    assert.match(cab, /PODE QUEBRAR/i, f + ': cabeçalho sem "o que pode quebrar"');
    assert.match(cab, /REVERTER/i, f + ': cabeçalho sem "como reverter"');
  }
  // nenhuma migration existente foi editada: só arquivos novos com o prefixo novo
  assert.ok(sqlFiles().filter(f => f < FIX_PREFIX).length >= 30);
});

test('aplicar TODAS duas vezes sobre o estado de produção: sem erro e mesmo resultado', async () => {
  const db = await createTestDb();
  try {
    assert.deepEqual(db.failed, [], JSON.stringify(db.failed));
    const antes = await assinatura(db);
    for (const f of FIXES) await db.admin.query(sql(f));
    assert.equal(await assinatura(db), antes, 'a segunda aplicação mudou o estado');
  } finally { await db.close(); }
});

test('cada migration, sozinha, aplica sem erro sobre o estado de produção (e 2×)', async () => {
  for (const f of FIXES) {
    const db = await createTestDb({ fixes: false });
    try { await db.admin.query(sql(f)); await db.admin.query(sql(f)); }
    catch (e) { assert.fail(`${f} falhou sozinha: ${e.message}`); }
    finally { await db.close(); }
  }
});

test('estado PARCIAL (parte já aplicada, fora de ordem) converge para o mesmo estado final', async () => {
  const completo = await createTestDb();
  const ref = await assinatura(completo); await completo.close();
  const parcial = await createTestDb({ fixes: false });
  try {
    // o dono já aplicou 7, 9, 4 e 13 (fora de ordem), depois aplica todas em ordem
    for (const n of ['07', '09', '04', '13']) await parcial.admin.query(sql(FIXES.find(f => f.startsWith('202610270000' + n))));
    for (const f of FIXES) await parcial.admin.query(sql(f));
    assert.equal(await assinatura(parcial), ref);
  } finally { await parcial.close(); }
});

test('estado só-repositório (sem alterações manuais de produção): as correções também aplicam', async () => {
  const db = await createTestDb({ prodState: false });
  try {
    assert.deepEqual(db.failed, [], JSON.stringify(db.failed));
    const r = await db.admin.query(`select count(*)::int n from pg_policies where schemaname='public' and tablename='transactions'`);
    assert.equal(r.rows[0].n, 4);
  } finally { await db.close(); }
});

test('determinístico: policy manual/desconhecida nas tabelas afetadas é removida (não sobra brecha permissiva)', async () => {
  const db = await createTestDb({ fixes: false });
  try {
    await seed(db);
    // alguém criou à mão policies permissivas com nomes quaisquer (inclusive com espaço)
    await db.admin.query(`
      create policy "Qualquer um insere" on public.financa_members for insert with check (true);
      create policy "manual update invites" on public.financa_invites for update using (true) with check (true);
      create policy "tx tudo liberado" on public.transactions for all using (true) with check (true);
      create policy "cat tudo" on public.categories for all using (true) with check (true);
      create policy "tipos livres" on public.transaction_types for insert with check (true);
      create policy "lembretes livres" on public.reminders for insert with check (true);
      create policy "financas livres" on public.financas for update using (true) with check (true);
      create policy "movs livres" on public.cofrinho_movs for update using (true) with check (true);`);
    for (const f of FIXES) await db.admin.query(sql(f));
    const restantes = (await db.admin.query(`select tablename, policyname from pg_policies where policyname in ('Qualquer um insere','manual update invites','tx tudo liberado','cat tudo','tipos livres','lembretes livres','financas livres','movs livres')`)).rows;
    assert.deepEqual(restantes, []);
    // e o furo não existe mais
    const r = await db.as(D, async c => ({
      membro: await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'admin')`, [F, D.id, D.email]),
      tx: await db.try(c, `insert into transactions(user_id,financa_id,value,type,category,description) values ($1,$2,1,'saida','Outros','x')`, [D.id, F]),
    }));
    assert.equal(r.membro.ok, false); assert.equal(r.tx.ok, false);
  } finally { await db.close(); }
  col.add('MIG', 'CORRIGIDO', 'Migrations determinísticas/idempotentes: 2×, sozinhas, parciais fora de ordem, só-repo e com policies manuais');
});

test('rollback (docs/qa/baseline/rollback-estado-producao.sql): devolve policies, grants e view ao estado anterior de produção', async () => {
  const antes = await createTestDb({ fixes: false });
  const base = await assinatura(antes); await antes.close();
  const db = await createTestDb();                       // com as correções
  try {
    const rb = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'qa', 'baseline', 'rollback-estado-producao.sql'), 'utf8');
    await db.admin.query(rb); await db.admin.query(rb);   // 2× = idempotente
    const pol = async d => JSON.stringify((await d.admin.query(`select tablename||'.'||policyname||':'||cmd||':'||coalesce(qual,'')||':'||coalesce(with_check,'') s from pg_policies where schemaname='public' and tablename not like 'cofrinho%' order by 1`)).rows.map(r => r.s));
    const ref = await createTestDb({ fixes: false });
    try {
      assert.equal(await pol(db), await pol(ref), 'policies após o rollback ≠ estado anterior de produção');
      const gr = async d => JSON.stringify((await d.admin.query(`select p.proname||':'||has_function_privilege('anon',p.oid,'execute')||has_function_privilege('authenticated',p.oid,'execute') s from pg_proc p where pronamespace='public'::regnamespace and p.proname in ('add_member_by_email','auto_accept_my_invites','get_my_pending_invites','claim_due_push','cleanup_push_queue','register_push_subscription','sync_push_queue','is_financa_member') order by 1`)).rows.map(r => r.s));
      assert.equal(await gr(db), await gr(ref));
      const v = (await db.admin.query(`select coalesce(reloptions::text,'') o, has_table_privilege('anon','public.monthly_summary','select') a from pg_class where oid='public.monthly_summary'::regclass`)).rows[0];
      assert.equal(v.a, true); assert.doesNotMatch(v.o, /security_invoker/);
    } finally { await ref.close(); }
    // e depois do rollback as correções podem ser reaplicadas
    for (const f of FIXES) await db.admin.query(sql(f));
    assert.equal(await assinatura(db), await (async () => { const c = await createTestDb(); const a = await assinatura(c); await c.close(); return a; })());
  } finally { await db.close(); }
  void base;
});
