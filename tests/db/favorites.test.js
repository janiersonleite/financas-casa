// T5/F1: executa docs/qa/verificacao-favoritos.sql (os 33 casos) num Postgres LOCAL com o estado de produção + migrations de correção
// + a migration NOVA 20261104000001_favorite_entries.sql (já aplicada pelo harness, que aplica tudo >= 20261027). Nunca produção.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestDb } = require('./harness');
const ROOT = path.resolve(__dirname, '..', '..');
let db;
test.before(async () => { db = await createTestDb(); });
test.after(async () => { await db.close(); });

test('a migration de favoritos aplica sem erro, com RLS ligada e sem grants para anon', async () => {
  assert.deepEqual(db.failed.filter(f => /favorite_entries/.test(f.file)), []);
  assert.ok(db.applied.includes('20261104000001_favorite_entries.sql'));
  const rls = (await db.admin.query(`select relrowsecurity from pg_class where oid = 'public.favorite_entries'::regclass`)).rows[0].relrowsecurity;
  assert.equal(rls, true);
  const pol = (await db.admin.query(`select policyname, cmd from pg_policies where tablename = 'favorite_entries' order by cmd`)).rows;
  assert.deepEqual(pol.map(p => p.cmd).sort(), ['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  const anon = (await db.admin.query(`select has_table_privilege('anon', 'public.favorite_entries', 'select') s, has_table_privilege('anon', 'public.favorite_entries', 'insert') i`)).rows[0];
  assert.deepEqual(anon, { s: false, i: false });
  const auth = (await db.admin.query(`select has_table_privilege('authenticated', 'public.favorite_entries', 'select,insert,update,delete') ok`)).rows[0].ok;
  assert.equal(auth, true);
});

test('docs/qa/verificacao-favoritos.sql: os 33 casos passam (e o resultado é registrado)', async () => {
  const sql = fs.readFileSync(path.join(ROOT, 'docs', 'qa', 'verificacao-favoritos.sql'), 'utf8');
  const res = await db.admin.query(sql);
  const tabela = (Array.isArray(res) ? res : [res]).find(r => r.fields?.some(f => f.name === 'esperado'));
  await db.admin.query('rollback');
  assert.ok(tabela, 'a consulta final não devolveu a tabela de resultados');
  const rows = tabela.rows;
  assert.equal(rows.length, 33);
  const falhas = rows.filter(r => !r.ok);
  assert.deepEqual(falhas.map(r => `${r.n}. ${r.caso} → esperado "${r.esperado}", obtido "${r.obtido}"`), []);
  fs.mkdirSync(path.join(ROOT, 'tests', '_out'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tests', '_out', 'favoritos-resultado.txt'), JSON.stringify(rows, null, 1));
});

test('rollback (docs/qa/rollback-favorite-entries.sql) remove tabela e funções novas e deixa o resto intacto', async () => {
  const velho = await createTestDb();
  try {
    const antes = (await velho.admin.query(`select count(*)::int n from pg_policies where tablename = 'transactions'`)).rows[0].n;
    await velho.admin.query(fs.readFileSync(path.join(ROOT, 'docs', 'qa', 'rollback-favorite-entries.sql'), 'utf8'));
    const t = (await velho.admin.query(`select to_regclass('public.favorite_entries') t, to_regprocedure('public.can_write_financa(uuid)') f1, to_regprocedure('public.favorite_entries_limit()') f2`)).rows[0];
    assert.deepEqual(t, { t: null, f1: null, f2: null });
    assert.equal((await velho.admin.query(`select count(*)::int n from pg_policies where tablename = 'transactions'`)).rows[0].n, antes);
    // reaplicar a migration depois do rollback funciona (idempotente/determinística)
    await velho.admin.query(fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261104000001_favorite_entries.sql'), 'utf8'));
    await velho.admin.query(fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261104000001_favorite_entries.sql'), 'utf8'));   // 2ª vez: sem erro
    assert.ok((await velho.admin.query(`select to_regclass('public.favorite_entries') t`)).rows[0].t);
  } finally { await velho.close(); }
});
