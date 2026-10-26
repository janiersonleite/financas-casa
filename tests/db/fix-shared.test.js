// A4 (categories, reminders, transaction_types) e A5 (financas) — estado real de produção.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./harness');
const { createCollector } = require('../qa-findings');
const { A, B, C, D, F, G, seed } = require('./seed');
const fs = require('node:fs'), path = require('node:path');
const col = createCollector('fix-shared-findings.json');
let db;
const CAT = '00000000-0000-0000-0000-0000000000c1', REM = '00000000-0000-0000-0000-0000000000c2', TYP = '00000000-0000-0000-0000-0000000000c3', CAT_DEF = '00000000-0000-0000-0000-0000000000c4';
test.before(async () => {
  db = await createTestDb(); await seed(db);
  await db.admin.query(`insert into categories(id,user_id,financa_id,name,emoji,type) values ($1,$2,$3,'Mercado','🛒','saida'),($4,null,null,'Padrão','📦','both')`, [CAT, A.id, F, CAT_DEF]);
  await db.admin.query(`insert into reminders(id,user_id,financa_id,name,day,category) values ($1,$2,$3,'Luz',5,'Moradia')`, [REM, A.id, F]);
  await db.admin.query(`insert into transaction_types(id,user_id,financa_id,name,behavior,custom_id) values ($1,$2,$3,'Pix Cliente','soma','ct1')`, [TYP, A.id, F]);
});
test.after(async () => { col.flush(); await db.close(); });

const TABELAS = {
  categories: { id: CAT, ins: (uid, fid) => [`insert into categories(user_id,financa_id,name,emoji,type) values ($1,$2,'X'||gen_random_uuid()::text,'📦','saida')`, [uid, fid]], edita: `update categories set name='Y' where id=$1 returning id` },
  reminders: { id: REM, ins: (uid, fid) => [`insert into reminders(user_id,financa_id,name,day,category) values ($1,$2,'X'||gen_random_uuid()::text,1,'Outros')`, [uid, fid]], edita: `update reminders set name='Y' where id=$1 returning id` },
  transaction_types: { id: TYP, ins: (uid, fid) => [`insert into transaction_types(user_id,financa_id,name,behavior,custom_id) values ($1,$2,'X'||gen_random_uuid()::text,'soma',gen_random_uuid()::text)`, [uid, fid]], edita: `update transaction_types set name='Y' where id=$1 returning id` },
};

for (const [tab, t] of Object.entries(TABELAS)) {
  test(`A4 ${tab}: estranho NÃO injeta registro em carteira alheia; ninguém move/forja user_id`, async () => {
    const r = await db.as(D, async c => ({
      injeta: await db.try(c, ...t.ins(D.id, F)),
      emNomeDeOutro: await db.try(c, ...t.ins(A.id, null)),
      pessoal: await db.try(c, ...t.ins(D.id, null)),              // o próprio estranho cria o SEU (financa_id null) normalmente
      propriaCarteira: await db.try(c, ...t.ins(D.id, G)),         // e na carteira dele
      le: (await c.query(`select count(*)::int n from ${tab} where id=$1`, [t.id])).rows[0].n,
      edita: await db.try(c, t.edita, [t.id]),
    }));
    assert.equal(r.injeta.ok, false, `D injetou ${tab} na carteira alheia`);
    assert.equal(r.emNomeDeOutro.ok, false, 'forjou user_id');
    assert.equal(r.pessoal.ok, true, 'criar registro pessoal deve funcionar: ' + r.pessoal.error);
    assert.equal(r.propriaCarteira.ok, true, 'criar na própria carteira deve funcionar: ' + r.propriaCarteira.error);
    assert.equal(r.le, 0); assert.ok(!r.edita.ok || r.edita.rowCount === 0);
    // dono do registro: não move para carteira alheia nem troca user_id
    const o = await db.as(A, async c => ({
      move: await db.try(c, `update ${tab} set financa_id=$2 where id=$1 returning id`, [t.id, G]),
      troca: await db.try(c, `update ${tab} set user_id=$2 where id=$1 returning id`, [t.id, B.id]),
      edita: await db.try(c, t.edita, [t.id]),
      moveParaNull: await db.try(c, `update ${tab} set financa_id=null where id=$1 returning id`, [t.id]),
    }));
    assert.ok(!o.move.ok || o.move.rowCount === 0, 'moveu para carteira alheia');
    assert.equal(o.troca.ok, false, 'trocou user_id');
    assert.equal(o.edita.rowCount, 1); assert.equal(o.moveParaNull.rowCount, 1);
    // membro comum cria na carteira em que é membro
    const m = await db.as(C, c => db.try(c, ...t.ins(C.id, F)));
    assert.equal(m.ok, true, 'membro não conseguiu criar na carteira: ' + m.error);
    col.add(`A4-${tab}`, 'CORRIGIDO', `${tab}: INSERT/UPDATE checam pertencimento à carteira; user_id imutável`);
  });
}

test('A4: visibilidade preservada — membro vê os da carteira, estranho não; categorias padrão (user_id null) visíveis a todos', async () => {
  for (const [tab, t] of Object.entries(TABELAS)) {
    const vC = await db.as(C, async c => (await c.query(`select count(*)::int n from ${tab} where id=$1`, [t.id])).rows[0].n);
    const vD = await db.as(D, async c => (await c.query(`select count(*)::int n from ${tab} where id=$1`, [t.id])).rows[0].n);
    assert.equal(vC, 1, `${tab}: membro não vê`); assert.equal(vD, 0, `${tab}: estranho vê`);
  }
  const padrao = await db.as(D, async c => (await c.query('select count(*)::int n from categories where id=$1', [CAT_DEF])).rows[0].n);
  assert.equal(padrao, 1);
});

test('A4: regras por tabela preservadas (lembretes: membros editam/excluem; categorias/tipos: só o criador)', async () => {
  // reminders: recurso do app — membro edita e exclui lembrete de outro na MESMA carteira; estranho não
  const rem = await db.as(C, async c => ({
    edita: await db.try(c, `update reminders set name='editado pelo membro' where id=$1 returning id`, [REM]),
    leva: await db.try(c, `update reminders set financa_id=$2 where id=$1 returning id`, [REM, G]),
    exclui: await db.try(c, 'delete from reminders where id=$1 returning id', [REM]),
  }));
  assert.equal(rem.edita.rowCount, 1); assert.ok(!rem.leva.ok || rem.leva.rowCount === 0); assert.equal(rem.exclui.rowCount, 1);
  const remD = await db.as(D, async c => ({ e: await db.try(c, `update reminders set name='x' where id=$1 returning id`, [REM]), x: await db.try(c, 'delete from reminders where id=$1 returning id', [REM]) }));
  assert.equal(remD.e.rowCount, 0); assert.equal(remD.x.rowCount, 0);
  // reminders: dono edita/exclui os próprios (antiga policy ALL)
  const remA = await db.as(A, async c => ({ e: await db.try(c, `update reminders set name='meu' where id=$1 returning id`, [REM]), x: await db.try(c, 'delete from reminders where id=$1 returning id', [REM]) }));
  assert.equal(remA.e.rowCount, 1); assert.equal(remA.x.rowCount, 1);
  // categories / transaction_types: membro comum NÃO altera/exclui o do criador (comportamento atual mantido)
  for (const [tab, t] of [['categories', TABELAS.categories], ['transaction_types', TABELAS.transaction_types]]) {
    const m = await db.as(C, async c => ({ e: await db.try(c, t.edita, [t.id]), x: await db.try(c, `delete from ${tab} where id=$1 returning id`, [t.id]) }));
    assert.equal(m.e.rowCount, 0, tab); assert.equal(m.x.rowCount, 0, tab);
    const dono = await db.as(A, async c => ({ e: await db.try(c, t.edita, [t.id]), x: await db.try(c, `delete from ${tab} where id=$1 returning id`, [t.id]) }));
    assert.equal(dono.e.rowCount, 1, tab); assert.equal(dono.x.rowCount, 1, tab);
  }
});

test('A4: exatamente 1 policy por comando nas três tabelas (sem a ALL antiga)', async () => {
  for (const tab of Object.keys(TABELAS)) {
    const r = await db.admin.query(`select policyname, cmd from pg_policies where schemaname='public' and tablename=$1`, [tab]);
    const porCmd = {}; for (const p of r.rows) (porCmd[p.cmd] ||= []).push(p.policyname);
    assert.deepEqual(Object.keys(porCmd).sort(), ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], `${tab}: ${JSON.stringify(porCmd)}`);
    for (const [cmd, nomes] of Object.entries(porCmd)) assert.equal(nomes.length, 1, `${tab} ${cmd}: ${nomes}`);
  }
});

test('A5: financas — owner_id imutável (admin não toma a carteira); admin ainda edita nome/tipo; insert exige login', async () => {
  const r = await db.as(B, async c => ({   // B é ADMIN (não dono) da carteira F
    toma: await db.try(c, 'update financas set owner_id=$2 where id=$1 returning id', [F, B.id]),
    renomeia: await db.try(c, `update financas set name='Casa 2' where id=$1 returning id`, [F]),
    tipo: await db.try(c, `update financas set type='compartilhada' where id=$1 returning id`, [F]),
    exclui: await db.try(c, 'delete from financas where id=$1 returning id', [F]),
  }));
  assert.equal(r.toma.ok, false, 'admin trocou o dono da carteira'); assert.match(r.toma.error, /owner_id/);
  assert.equal(r.renomeia.rowCount, 1); assert.equal(r.tipo.rowCount, 1); assert.equal(r.exclui.rowCount, 0);
  // o próprio dono também não troca o owner_id (nem para outra pessoa nem para NULL)
  const dono = await db.as(A, async c => ({
    passa: await db.try(c, 'update financas set owner_id=$2 where id=$1 returning id', [F, D.id]),
    renomeia: await db.try(c, `update financas set name='Casa' where id=$1 returning id`, [F]),
  }));
  assert.equal(dono.passa.ok, false); assert.equal(dono.renomeia.rowCount, 1);
  // membro comum e estranho não alteram
  const outros = await db.as(C, c => db.try(c, `update financas set name='x' where id=$1 returning id`, [F]));
  const estranho = await db.as(D, c => db.try(c, `update financas set name='x' where id=$1 returning id`, [F]));
  assert.ok(!outros.ok || outros.rowCount === 0); assert.ok(!estranho.ok || estranho.rowCount === 0);
  // criar carteira: logado cria; o trigger fixa owner_id = auth.uid() (mesmo se o cliente mandar outro); anônimo não cria
  const NOVA = '00000000-0000-0000-0000-0000000000fa';
  const novo = await db.as(B, async c => {
    const ins = await db.try(c, `insert into financas(id,name,type,owner_id) values ($1,'Nova','individual',$2)`, [NOVA, A.id]);
    await c.query('reset role');                                   // lê o resultado como superusuário (mesma transação)
    const dono = (await c.query('select owner_id from financas where id=$1', [NOVA])).rows[0]?.owner_id;
    return { ok: ins.ok, dono };
  });
  assert.equal(novo.ok, true); assert.equal(novo.dono, B.id, 'owner_id deve ser o usuário logado, não o enviado pelo cliente');
  const anon = await db.as(null, c => db.try(c, `insert into financas(name,type) values ('x','individual')`), { role: 'anon' });
  assert.equal(anon.ok, false);
  const pol = (await db.admin.query(`select cmd, with_check, qual from pg_policies where tablename='financas' and cmd in ('INSERT','UPDATE')`)).rows;
  const insPol = pol.find(p => p.cmd === 'INSERT'), updPol = pol.find(p => p.cmd === 'UPDATE');
  assert.notEqual(insPol.with_check.trim(), 'true', 'financas_insert ainda é WITH CHECK (true)');
  assert.ok(updPol.with_check && /is_financa_admin/.test(updPol.with_check), 'financas_update sem WITH CHECK');
  col.add('A5', 'CORRIGIDO', 'financas: owner_id imutável; update com WITH CHECK is_financa_admin; insert exige login');
});

test('A14: limites de tamanho — acima do limite é recusado, no limite passa; NOT VALID não falha com dados antigos', async () => {
  const L = (n, ch = 'a') => ch.repeat(n);
  const casos = [
    ['transactions', (v) => [`insert into transactions(user_id,value,type,category,description) values ($1,1,'saida','Outros',$2)`, [A.id, v]], 300],
    ['transactions.notes', (v) => [`insert into transactions(user_id,value,type,category,description,notes) values ($1,1,'saida','Outros','x',$2)`, [A.id, v]], 1000],
    ['categories', (v) => [`insert into categories(user_id,name,emoji,type) values ($1,$2,'📦','saida')`, [A.id, v]], 40],
    ['reminders', (v) => [`insert into reminders(user_id,name,day,category) values ($1,$2,1,'Outros')`, [A.id, v]], 80],
    ['transaction_types', (v) => [`insert into transaction_types(user_id,name,behavior,custom_id) values ($1,$2,'soma',gen_random_uuid()::text)`, [A.id, v]], 40],
  ];
  await db.as(A, async c => {
    for (const [nome, q, max] of casos) {
      assert.equal((await db.try(c, ...q(L(max, 'x')))).ok, true, `${nome}: no limite deveria passar`);
      assert.equal((await db.try(c, ...q(L(max + 1)))).ok, false, `${nome}: acima do limite deveria falhar`);
    }
    assert.equal((await db.try(c, `insert into financas(name,type) values ($1,'individual')`, [L(60)])).ok, true);
    assert.equal((await db.try(c, `insert into financas(name,type) values ($1,'individual')`, [L(61)])).ok, false);
    // sem CHECK em transactions.type (ids de tipos customizados)
    assert.equal((await db.try(c, `insert into transactions(user_id,value,type,category,description) values ($1,1,'ct9z1x','Outros','x')`, [A.id])).ok, true);
  });
  // texto com acento/emoji conta em CARACTERES (não bytes)
  await db.as(A, async c => assert.equal((await db.try(c, `insert into transactions(user_id,value,type,category,description) values ($1,1,'saida','Outros',$2)`, [A.id, 'ç'.repeat(300)])).ok, true));

  // NOT VALID: banco com dado antigo fora do limite → a migration aplica sem erro; novos inserts passam a ser checados
  const velho = await createTestDb({ fixes: false });
  try {
    await seed(velho);
    await velho.admin.query(`insert into transactions(user_id,value,type,category,description) values ($1,1,'saida','Outros',$2)`, [A.id, 'v'.repeat(500)]);
    const fs = require('node:fs'), path = require('node:path');
    const mig = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20261027000013_length_checks.sql'), 'utf8');
    await velho.admin.query(mig); await velho.admin.query(mig);   // idempotente
    const novo = await velho.as(A, c => velho.try(c, `insert into transactions(user_id,value,type,category,description) values ($1,1,'saida','Outros',$2)`, [A.id, 'n'.repeat(301)]));
    assert.equal(novo.ok, false);
    let validou = true; try { await velho.admin.query('alter table transactions validate constraint transactions_description_len'); } catch { validou = false; }
    assert.equal(validou, false, 'VALIDATE deveria acusar a linha antiga (a consulta de verificação existe para isso)');
  } finally { await velho.close(); }
  // front: os mesmos limites no HTML e na importação
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  for (const [id, n] of [['financa-name-input', 60], ['modal-cat-name-input', 40], ['cat-name-input', 40], ['type-name-input', 40], ['reminder-name-input', 80], ['reminder-cat-name', 40]])
    assert.match(html, new RegExp(`<input id="${id}" type="text" maxlength="${n}"`), id);
  col.add('A14', 'CORRIGIDO', 'CHECK de tamanho NOT VALID (description 300, notes 1000, nomes 40/80/40/60); front limita na digitação e na importação');
});
