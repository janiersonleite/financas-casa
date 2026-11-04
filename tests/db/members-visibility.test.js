// Correção 1 (chip da carteira): o nº de membros vem de financa_members. Prova, no Postgres de teste com o estado de produção, que:
//  - cada membro (admin ou membro) enxerga TODOS os membros das carteiras de que participa, numa única consulta agregada;
//  - quem não participa não enxerga nada daquela carteira;
//  - o tipo da carteira (financas.type) não tem relação com a contagem (carteira "individual" com 2 membros → 2);
//  - convite pendente NÃO é linha de financa_members.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./harness');
const { A, B, C, D, seed } = require('./seed');
const H = '00000000-0000-0000-0000-0000000000f7';   // carteira criada como 'individual' que depois recebeu um membro (o caso real do relatório)
const I = '00000000-0000-0000-0000-0000000000f8';   // carteira individual só do A
let db;
test.before(async () => {
  db = await createTestDb(); await seed(db);
  const a = db.admin;
  for (const [id, nome] of [[H, 'Família'], [I, 'Só minha']]) {
    await a.query(`select set_config('request.jwt.claim.sub', $1, false)`, [A.id]);
    await a.query(`insert into financas(id,name,type) values ($1,$2,'individual')`, [id, nome]);
  }
  await a.query(`select set_config('request.jwt.claim.sub', '', false)`);
  // o app insere o dono como admin e, depois, o convidado aceito como membro
  await a.query(`insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'admin'),($1,$4,$5,'membro'),($6,$2,$3,'admin')`, [H, A.id, A.email, B.id, B.email, I]);
});
test.after(async () => { await db.close(); });

const CONTAGEM = `select financa_id, count(*)::int as n from financa_members group by financa_id`;
const porId = rows => Object.fromEntries(rows.map(r => [r.financa_id, r.n]));

test('admin enxerga os 2 membros da carteira "individual" (uma consulta agregada para todas as carteiras)', async () => {
  const m = porId(await db.as(A, async c => (await c.query(CONTAGEM)).rows));
  assert.equal(m[H], 2);
  assert.equal(m[I], 1);
});

test('o membro (não admin) enxerga os mesmos 2 membros — a policy de leitura mostra todos os membros das carteiras de que participa', async () => {
  const m = porId(await db.as(B, async c => (await c.query(CONTAGEM)).rows));
  assert.equal(m[H], 2, 'o membro precisa ver a contagem completa');
  assert.equal(m[I], undefined, 'e nada de carteiras de que não participa');
  const linhas = await db.as(B, async c => (await c.query(`select email, role from financa_members where financa_id=$1 order by role`, [H])).rows);
  assert.deepEqual(linhas.map(r => r.role), ['admin', 'membro']);
});

test('estranho não vê membro nenhum dessas carteiras', async () => {
  const m = porId(await db.as(D, async c => (await c.query(CONTAGEM)).rows));
  assert.equal(m[H], undefined); assert.equal(m[I], undefined);
});

test('convite pendente NÃO conta: financa_members continua com 2 linhas; o admin vê o convite à parte', async () => {
  await db.admin.query(`insert into financa_invites(financa_id,email,invited_by) values ($1,$2,$3)`, [H, 'convidado@teste.com', A.id]);
  const m = porId(await db.as(A, async c => (await c.query(CONTAGEM)).rows));
  assert.equal(m[H], 2);
  const inv = await db.as(A, async c => (await c.query(`select count(*)::int n from financa_invites where financa_id=$1 and accepted_at is null`, [H])).rows[0].n);
  assert.equal(inv, 1);
  const invMembro = await db.as(B, async c => (await c.query(`select count(*)::int n from financa_invites where financa_id=$1`, [H])).rows[0].n);
  assert.equal(invMembro, 0, 'membro comum não vê convites (só o admin) — o "· 1 convite" é só para admin');
});

test('remover um membro reduz a contagem para 1 (o chip deve voltar a "Só você")', async () => {
  await db.admin.query(`delete from financa_members where financa_id=$1 and user_id=$2`, [H, B.id]);
  const m = porId(await db.as(A, async c => (await c.query(CONTAGEM)).rows));
  assert.equal(m[H], 1);
});
