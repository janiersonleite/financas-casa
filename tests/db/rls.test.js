// Testes de RLS / funções SQL contra um Postgres LOCAL (nunca produção).
// Cada cenário roda em transação com ROLLBACK. Os achados são registrados no
// coletor (CONFIRMADO / NAO CONFIRMADO / PARCIAL) sem derrubar o runner.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./harness');
const { createCollector } = require('../qa-findings');

const { A, B, C, D, E_UNCONF, F, G, TX_A, seed } = require('./seed');
const col = createCollector('rls-findings.json');
let db;

test.before(async () => {
  db = await createTestDb();
  await seed(db);
});
test.after(async () => { col.flush(); await db.close(); });

test('migrations: todas aplicam em ordem (schema drift registrado)', () => {
  assert.equal(db.failed.length, 0, JSON.stringify(db.failed));
  col.add('DB-00', 'CONFIRMADO', 'Schema drift: tabelas reminders e transaction_types não têm migration de criação',
    'migrations 20260901000001/20260908000001/20260909000001/20260909000002 falham sem o stub tests/db/stubs-drift.sql ("relation does not exist")');
});

test('1. members_insert: estranho NÃO consegue se auto-inserir (admin nem role arbitrário)', async () => {
  const r = await db.as(D, async c => ({
    admin: await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'admin')`, [F, D.id, D.email]),
    membro: await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'membro')`, [F, D.id, D.email]),
    xpto: await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'xpto')`, [F, D.id, D.email]),
    le: (await c.query('select count(*)::int n from transactions where financa_id=$1', [F])).rows[0].n
  }));
  assert.equal(r.admin.ok, false, 'estranho virou admin'); assert.equal(r.membro.ok, false, 'estranho virou membro');
  assert.equal(r.xpto.ok, false); assert.equal(r.le, 0);
  assert.match(r.admin.error, /row-level security/);
  col.add('SEC-01', 'CORRIGIDO', 'Auto-inserção em financa_members bloqueada para quem não é dono', r.admin.error);
});

test('1b. ex-membro removido e convidado "visualizador" NÃO viram admin; role vem do convite', async () => {
  await db.admin.query('delete from financa_members where financa_id=$1 and user_id=$2', [F, C.id]);
  const volta = await db.as(C, c => db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'admin')`, [F, C.id, C.email]));
  await db.admin.query(`insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'membro')`, [F, C.id, C.email]);   // restaura
  assert.equal(volta.ok, false, 'ex-membro voltou sozinho');
  await db.admin.query(`insert into financa_invites(financa_id,email,role,invited_by) values ($1,$2,'visualizador',$3)`, [F, D.email, A.id]);
  const r = await db.as(D, async c => {
    const direto = await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'admin')`, [F, D.id, D.email]);
    const edita = await db.try(c, `update financa_invites set role='admin' where lower(email)=lower($1) returning id`, [D.email]);
    const inv = (await c.query('select id from get_my_pending_invites()')).rows[0];
    const aceita = await c.query('select accept_invite($1) f', [inv.id]);
    const papel = (await c.query('select role from financa_members where financa_id=$1 and user_id=$2', [F, D.id])).rows[0].role;
    return { direto, edita, f: aceita.rows[0].f, papel };
  });
  await db.admin.query('delete from financa_members where financa_id=$1 and user_id=$2', [F, D.id]);
  await db.admin.query('delete from financa_invites where email=$1', [D.email]);
  assert.equal(r.direto.ok, false); assert.equal(r.f, F);
  assert.ok(!r.edita.ok || r.edita.rowCount === 0, 'convidado conseguiu editar o próprio convite');
  assert.equal(r.papel, 'visualizador', 'o papel deve vir do convite');
  col.add('SEC-01b', 'CORRIGIDO', 'Ex-membro e convidado não se promovem; accept_invite usa o papel do convite', 'papel final=' + r.papel);
});

test('1c. fluxos legítimos: dono cria carteira (se registra admin) e admin adiciona outra pessoa', async () => {
  const Nova = '00000000-0000-0000-0000-0000000000f9';
  await db.as(B, async c => {
    // o trigger financas_set_owner força owner_id = auth.uid()
    await c.query(`insert into financas(id,name,type) values ($1,'Nova','compartilhada')`, [Nova]);
    const eu = await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'admin')`, [Nova, B.id, B.email]);
    assert.equal(eu.ok, true, 'dono não conseguiu se registrar: ' + eu.error);
    const outro = await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'membro')`, [Nova, C.id, C.email]);
    assert.equal(outro.ok, true, 'admin não conseguiu adicionar: ' + outro.error);
    const como_membro = await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'membro')`, [Nova, B.id, B.email]);
    assert.equal(como_membro.ok, false);   // dono só se registra como admin (e já existe)
  });
  // membro comum não adiciona ninguém; sair da carteira (delete da própria linha) continua valendo
  await db.as(C, async c => {
    const x = await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'membro')`, [F, D.id, D.email]);
    assert.equal(x.ok, false);
    const sair = await db.try(c, 'delete from financa_members where financa_id=$1 and user_id=$2', [F, C.id]);
    assert.equal(sair.rowCount, 1, 'sair da carteira deve continuar funcionando');
  });
});

test('2. convite com e-mail NÃO confirmado não é aceito/visível; ao confirmar, é aceito', async () => {
  await db.admin.query(`insert into financa_invites(financa_id,email,role,invited_by) values ($1,$2,'admin',$3)`, [F, E_UNCONF.email, A.id]);
  const antes = await db.as(E_UNCONF, async c => ({
    n: (await c.query('select auto_accept_my_invites() n')).rows[0].n,
    pend: (await c.query('select count(*)::int n from get_my_pending_invites()')).rows[0].n,
    vendo: (await c.query('select count(*)::int n from financa_invites where lower(email)=lower($1)', [E_UNCONF.email])).rows[0].n,
    aceita: await db.try(c, 'select accept_invite(id) from (select id from financa_invites limit 1) x'),
    m: (await c.query('select count(*)::int n from financa_members where financa_id=$1 and user_id=$2', [F, E_UNCONF.id])).rows[0].n
  }));
  assert.equal(antes.n, 0); assert.equal(antes.pend, 0); assert.equal(antes.vendo, 0); assert.equal(antes.m, 0);
  assert.equal(antes.aceita.ok === false || antes.aceita.rows.length === 0, true);
  // depois de confirmar o e-mail, o login aceita o convite com o papel do convite
  await db.admin.query('update auth.users set email_confirmed_at=now() where id=$1', [E_UNCONF.id]);
  const depois = await db.as(E_UNCONF, async c => ({
    n: (await c.query('select auto_accept_my_invites() n')).rows[0].n,
    role: (await c.query('select role from financa_members where financa_id=$1 and user_id=$2', [F, E_UNCONF.id])).rows[0]?.role
  }));
  // restaura o cenário
  await db.admin.query('update auth.users set email_confirmed_at=null where id=$1', [E_UNCONF.id]);
  await db.admin.query('delete from financa_members where user_id=$1', [E_UNCONF.id]);
  await db.admin.query('delete from financa_invites where email=$1', [E_UNCONF.email]);
  assert.equal(depois.n, 1); assert.equal(depois.role, 'admin');
  col.add('SEC-02', 'CORRIGIDO', 'Convites exigem e-mail confirmado (auto_accept, pending, accept_invite, add_member_by_email)', `antes: aceitos=${antes.n}; depois de confirmar: ${depois.n}`);
});

test('3. transactions: não move/insere em carteira alheia; user_id imutável; fluxos legítimos seguem', async () => {
  const r = await db.as(A, async c => ({
    moveAlheia: await db.try(c, 'update transactions set financa_id=$1 where id=$2 returning id', [G, TX_A]),
    insereAlheia: await db.try(c, `insert into transactions(user_id,financa_id,value,type,category,description) values ($1,$2,1,'saida','Outros','x')`, [A.id, G]),
    trocaUser: await db.try(c, 'update transactions set user_id=$1 where id=$2 returning id', [B.id, TX_A]),
    editaPropria: await db.try(c, `update transactions set description='ok' where id=$1 returning id`, [TX_A]),
    paraPessoal: await db.try(c, 'update transactions set financa_id=null where id=$1 returning id', [TX_A]),
    volta: await db.try(c, 'update transactions set financa_id=$1 where id=$2 returning id', [F, TX_A]),
    insereMinha: await db.try(c, `insert into transactions(user_id,financa_id,value,type,category,description) values ($1,$2,1,'saida','Outros','x')`, [A.id, F]),
  }));
  assert.ok(!r.moveAlheia.ok || r.moveAlheia.rowCount === 0, 'moveu para carteira alheia');
  assert.equal(r.insereAlheia.ok, false, 'inseriu em carteira alheia');
  assert.equal(r.trocaUser.ok, false, 'trocou user_id');
  assert.ok(r.editaPropria.ok && r.editaPropria.rowCount === 1 && r.paraPessoal.rowCount === 1 && r.volta.rowCount === 1 && r.insereMinha.ok);
  // admin edita lançamento de outro membro (ex.: ajustar autor); membro comum não edita o de outro
  const adm = await db.as(B, c => db.try(c, `update transactions set inserted_by_email='x@y.com' where id=$1 returning id`, [TX_A]));
  const comum = await db.as(C, c => db.try(c, `update transactions set description='hack' where id=$1 returning id`, [TX_A]));
  assert.equal(adm.rowCount, 1); assert.equal(comum.rowCount, 0);
  // admin não consegue levar o lançamento de outro para carteira em que não é admin
  const admMove = await db.as(B, c => db.try(c, 'update transactions set financa_id=$1 where id=$2 returning id', [G, TX_A]));
  assert.ok(!admMove.ok || admMove.rowCount === 0);
  col.add('SEC-03', 'CORRIGIDO', 'UPDATE/INSERT de transactions validam pertencimento; user_id imutável', 'moveAlheia=' + (r.moveAlheia.error || 'bloqueado') + ' | insereAlheia=' + r.insereAlheia.error);
});

const ISOLA = [
  ['financas', 'id', F], ['financa_members', 'financa_id', F], ['financa_invites', 'financa_id', F], ['transactions', 'financa_id', F],
  ['cofrinhos', 'financa_id', F], ['cofrinho_movs', 'cofrinho_id', '00000000-0000-0000-0000-0000000000c1'],
  ['push_queue', 'user_id', A.id], ['push_subscriptions', 'user_id', A.id]
];
test('4. isolamento: estranho (D) não lê/edita/exclui dados de A', async () => {
  const a = db.admin;
  await a.query(`insert into financa_invites(financa_id,email,role,invited_by) values ($1,'x@x.com','membro',$2) on conflict do nothing`, [F, A.id]);
  await a.query(`insert into cofrinhos(id,user_id,financa_id,name,target_amount) values ('00000000-0000-0000-0000-0000000000c1',$1,$2,'Cof',100) on conflict do nothing`, [A.id, F]);
  await a.query(`insert into cofrinho_movs(cofrinho_id,user_id,kind,amount) values ('00000000-0000-0000-0000-0000000000c1',$1,'deposito',10)`, [A.id]);
  await a.query(`insert into push_queue(user_id,scope,reminder_id,fire_at,title,tag) values ($1,'s','r',now()+interval '1 day','t','tg')`, [A.id]);
  await a.query(`insert into push_subscriptions(user_id,endpoint,p256dh,auth) values ($1,'https://e/1','p','a')`, [A.id]);
  const vazamentos = [];
  await db.as(D, async c => {
    for (const [t, k, v] of ISOLA) {
      const sel = (await c.query(`select count(*)::int n from public.${t} where ${k}=$1`, [v])).rows[0].n;
      const upd = t === 'transactions' ? await db.try(c, `update public.${t} set description='x' where ${k}=$1`, [v])
        : t === 'financas' ? await db.try(c, `update public.${t} set name='x' where ${k}=$1`, [v])
        : { ok: true, rowCount: 0 };
      const del = await db.try(c, `delete from public.${t} where ${k}=$1`, [v]);
      if (sel > 0 || (upd.rowCount || 0) > 0 || (del.rowCount || 0) > 0) vazamentos.push(`${t}: sel=${sel} upd=${upd.rowCount} del=${del.rowCount}`);
    }
  });
  if (vazamentos.length) col.add('SEC-04', 'CONFIRMADO', 'Isolamento quebrado para usuário estranho', vazamentos.join(' | '));
  else col.add('SEC-04', 'NAO CONFIRMADO', 'D não lê/edita/exclui nada de A nas 8 tabelas verificadas', ISOLA.map(x => x[0]).join(', '));
  assert.equal(vazamentos.length, 0, vazamentos.join(' | '));
});

test('5. membro comum (C): não convida, não remove, não exclui carteira, não se promove', async () => {
  const r = await db.as(C, async c => ({
    convida: await db.try(c, `insert into financa_invites(financa_id,email,role,invited_by) values ($1,'z@z.com','membro',$2)`, [F, C.id]),
    removeB: await db.try(c, 'delete from financa_members where financa_id=$1 and user_id=$2', [F, B.id]),
    excluiF: await db.try(c, 'delete from financas where id=$1', [F]),
    renomeia: await db.try(c, `update financas set name='x' where id=$1`, [F]),
    promove: await db.try(c, `update financa_members set role='admin' where financa_id=$1 and user_id=$2`, [F, C.id]),
    reinsere: await db.try(c, `insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'admin') on conflict (financa_id,user_id) do update set role='admin'`, [F, C.id, C.email]),
  }));
  const falhas = [];
  if (r.convida.ok) falhas.push('C convidou');
  if (r.removeB.ok && r.removeB.rowCount) falhas.push('C removeu B');
  if (r.excluiF.ok && r.excluiF.rowCount) falhas.push('C excluiu a carteira');
  if (r.renomeia.ok && r.renomeia.rowCount) falhas.push('C renomeou a carteira');
  if (r.promove.ok && r.promove.rowCount) falhas.push('C se promoveu via UPDATE');
  if (r.reinsere.ok) falhas.push('C se promoveu via INSERT ... ON CONFLICT DO UPDATE');
  if (falhas.length) col.add('SEC-05', 'CONFIRMADO', 'Membro comum consegue ação de admin', falhas.join('; '));
  else col.add('SEC-05', 'NAO CONFIRMADO', 'C não convida, não remove, não exclui, não se promove (UPDATE nem INSERT..ON CONFLICT)', 'sem policy de UPDATE em financa_members; upsert exigiria UPDATE');
  assert.equal(falhas.length, 0, falhas.join('; '));
});

test('6. add_member_by_email: não-admin recebe "Sem permissão"', async () => {
  for (const [nome, u] of [['membro C', C], ['estranho D', D]]) {
    const r = await db.as(u, c => db.try(c, `select add_member_by_email($1,'novo@x.com','membro')`, [F]));
    assert.equal(r.ok, false, nome + ' conseguiu chamar');
    assert.match(r.error, /Sem permiss/);
  }
  const ok = await db.as(B, c => db.try(c, `select add_member_by_email($1,'novo@x.com','membro') r`, [F]));
  assert.equal(ok.ok, true); assert.equal(ok.rows[0].r, 'invited');
  col.add('SEC-06', 'NAO CONFIRMADO', "add_member_by_email nega não-admin ('Sem permissão') e permite admin", 'C e D bloqueados; B (admin) ok');
});

test('7. register_push_subscription: só hosts de push conhecidos (sem SSRF)', async () => {
  const BONS = ['https://fcm.googleapis.com/fcm/send/abc:123', 'https://fcm.googleapis.com/wp/abc', 'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/Qabc', 'https://api.push.apple.com/3/device/x', 'https://wns2-par02p.notify.windows.com/w/?token=abc', 'https://fcm.googleapis.com:443/fcm/send/a'];
  const RUINS = ['https://169.254.169.254/latest/meta-data', 'https://localhost/x', 'https://10.0.0.5/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'http://fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com@evil.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://evil.com/fcm.googleapis.com/x',
    'https://evil.com\\@fcm.googleapis.com/x', 'https://user:pw@fcm.googleapis.com/x', 'https://notify.windows.com.evil.com/x', 'https://fcm.googleapis.com', 'https://example.com/push'];
  const res = {};
  await db.as(C, async c => {
    for (const ep of [...BONS, ...RUINS]) res[ep] = (await db.try(c, `select register_push_subscription($1,'p','a','ua')`, [ep])).ok;
  });
  const bonsRecusados = BONS.filter(e => !res[e]), ruinsAceitos = RUINS.filter(e => res[e]);
  assert.deepEqual(bonsRecusados, [], 'endpoints legítimos recusados');
  assert.deepEqual(ruinsAceitos, [], 'endpoints perigosos aceitos');
  col.add('SEC-07', 'CORRIGIDO', 'register_push_subscription usa allowlist de hosts de push', `${BONS.length} legítimos aceitos, ${RUINS.length} perigosos recusados`);
});

test('8. sync_push_queue: limites e isolamento entre usuários', async () => {
  const item = (i, s = 'r') => ({ reminder_id: `${s}${i}`, fire_at: new Date(Date.now() + 3600e3 + i * 1000).toISOString(), title: 't', body: 'b', tag: `${s}${i}` });
  const out = {};
  await db.as(C, async c => {
    out.mais500 = await db.try(c, `select sync_push_queue('s', $1::jsonb)`, [JSON.stringify(Array.from({ length: 501 }, (_, i) => item(i)))]);
    out.ok500 = await db.try(c, `select sync_push_queue('s500', $1::jsonb) n`, [JSON.stringify(Array.from({ length: 500 }, (_, i) => item(i, 'a')))]);
  });
  await db.as(C, async c => {
    // 20 escopos com 1 item; o 21º deve falhar
    for (let s = 0; s < 20; s++) await c.query(`select sync_push_queue($1, $2::jsonb)`, ['sc' + s, JSON.stringify([item(s, 'e')])]);
    out.escopo21 = await db.try(c, `select sync_push_queue('sc20', $1::jsonb)`, [JSON.stringify([item(99, 'e')])]);
  });
  await db.as(D, async c => {
    // 1.500 pendentes: 3 escopos de 500 passam; o 4º estoura
    for (let s = 0; s < 3; s++) await c.query(`select sync_push_queue($1, $2::jsonb)`, ['L' + s, JSON.stringify(Array.from({ length: 500 }, (_, i) => item(i, 'l' + s)))]);
    out.total1500 = await db.try(c, `select sync_push_queue('L3', $1::jsonb)`, [JSON.stringify([item(1, 'z')])]);
  });
  // escrita direta na fila de outro usuário
  await db.admin.query(`insert into push_queue(user_id,scope,reminder_id,fire_at,title,tag) values ($1,'alheio','r1',now()+interval '1 day','t','tg')`, [A.id]);
  const dir = await db.as(C, async c => ({
    insere: await db.try(c, `insert into push_queue(user_id,scope,reminder_id,fire_at,title,tag) values ($1,'x','r',now()+interval '1h','t','t')`, [A.id]),
    apaga: await db.try(c, `delete from push_queue where user_id=$1`, [A.id]),
    sync: (await c.query(`select sync_push_queue('alheio', '[]'::jsonb)`)).rows.length
  }));
  const aindaTem = (await db.admin.query(`select count(*)::int n from push_queue where user_id=$1 and scope='alheio'`, [A.id])).rows[0].n;
  const problemas = [];
  if (out.mais500.ok) problemas.push('501 itens aceito');
  if (!out.ok500.ok) problemas.push('500 itens recusado');
  if (out.escopo21.ok) problemas.push('21º escopo aceito');
  if (out.total1500.ok) problemas.push('>1500 pendentes aceito');
  if (dir.insere.ok) problemas.push('inseriu na fila de outro usuário');
  if (dir.apaga.rowCount) problemas.push('apagou fila de outro');
  if (aindaTem !== 1) problemas.push('sync de C apagou fila de A');
  if (problemas.length) col.add('SEC-08', 'CONFIRMADO', 'Limites/isolamento do sync_push_queue falham', problemas.join('; '));
  else col.add('SEC-08', 'NAO CONFIRMADO', 'sync_push_queue respeita 500 itens / 20 escopos / 1500 pendentes e não escreve na fila alheia',
    `msgs: ${out.mais500.error} | ${out.escopo21.error} | ${out.total1500.error}`);
  assert.equal(problemas.length, 0, problemas.join('; '));
});

test('9. claim_due_push / cleanup_push_queue: só service_role', async () => {
  const q = await db.admin.query(`
    select p.proname, r.rolname, has_function_privilege(r.oid, p.oid, 'execute') as pode
      from pg_proc p, pg_roles r
     where p.pronamespace='public'::regnamespace and p.proname in ('claim_due_push','cleanup_push_queue')
       and r.rolname in ('anon','authenticated','service_role')`);
  const por = Object.fromEntries(q.rows.map(x => [x.proname + ':' + x.rolname, x.pode]));
  const call = await db.as(C, c => db.try(c, 'select * from claim_due_push(10)'));
  const call2 = await db.as(null, c => db.try(c, 'select cleanup_push_queue()'), { role: 'anon' });
  const erro = [];
  for (const fn of ['claim_due_push', 'cleanup_push_queue']) {
    if (por[fn + ':authenticated'] || por[fn + ':anon']) erro.push(`${fn} executável por authenticated/anon`);
    if (!por[fn + ':service_role']) erro.push(`${fn} NÃO executável por service_role`);
  }
  if (call.ok) erro.push('authenticated executou claim_due_push'); if (call2.ok) erro.push('anon executou cleanup_push_queue');
  col.add('SEC-09', erro.length ? 'CONFIRMADO' : 'NAO CONFIRMADO', erro.length ? 'Funções de serviço expostas' : 'claim_due_push/cleanup_push_queue só executáveis por service_role', erro.join('; ') || JSON.stringify(por));
  assert.equal(erro.length, 0, erro.join('; '));
});

test('10. toda função SECURITY DEFINER do schema public tem search_path fixo', async () => {
  const r = await db.admin.query(`
    select p.proname, pg_get_function_identity_arguments(p.oid) args,
           coalesce((select c from unnest(p.proconfig) c where c like 'search_path=%'), '') sp
      from pg_proc p where p.pronamespace='public'::regnamespace and p.prosecdef order by 1`);
  const sem = r.rows.filter(x => !x.sp).map(x => `${x.proname}(${x.args})`);
  assert.deepEqual(sem, [], 'SECURITY DEFINER sem search_path: ' + sem.join(', '));
  // as 8 funções do achado F8 (inclui as que não são SECURITY DEFINER) têm search_path fixo
  const F8 = ['is_financa_admin', 'is_financa_member', 'financa_members_set_user', 'financas_set_owner', 'handle_updated_at', 'transactions_set_inserted_by', 'can_access_cofrinho', 'update_updated_at_column'];
  const f8 = await db.admin.query(`select p.proname, coalesce(array_to_string(p.proconfig, ','), '') cfg from pg_proc p where p.pronamespace='public'::regnamespace and p.proname = any($1)`, [F8]);
  assert.equal(f8.rows.length, F8.length, 'função(ões) F8 não encontrada(s)');
  assert.deepEqual(f8.rows.filter(x => !/search_path=/.test(x.cfg)).map(x => x.proname), []);
  // as funções continuam funcionando (RLS depende delas)
  const ok = await db.as(B, async c => (await c.query('select is_financa_admin($1) a, is_financa_member($1) m', [F])).rows[0]);
  assert.deepEqual(ok, { a: true, m: true });
  col.add('SEC-10', 'CORRIGIDO', `${r.rows.length} funções SECURITY DEFINER, todas com search_path fixo`);
});

test('11. transactions: 1 policy por comando e acesso legítimo inalterado', async () => {
  const r = await db.admin.query(`select policyname, cmd from pg_policies where schemaname='public' and tablename='transactions' order by cmd, policyname`);
  const porCmd = {};
  for (const p of r.rows) (porCmd[p.cmd] ||= []).push(p.policyname);
  for (const [cmd, nomes] of Object.entries(porCmd)) assert.equal(nomes.length, 1, `${cmd} tem policies duplicadas: ${nomes}`);
  assert.deepEqual(Object.keys(porCmd).sort(), ['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  // matriz de acesso (mesmo resultado de antes da remoção das _own)
  const PESSOAL = '00000000-0000-0000-0000-0000000000a9';
  await db.admin.query(`insert into transactions(id,user_id,financa_id,value,type,category,description) values ($1,$2,null,5,'saida','Outros','pessoal do A')`, [PESSOAL, A.id]);
  const ve = async u => (await db.as(u, c => c.query('select id from transactions where id = any($1)', [[PESSOAL, TX_A]]))).rows.map(x => x.id).sort();
  assert.deepEqual(await ve(A), [PESSOAL, TX_A].sort());   // dono vê as duas
  assert.deepEqual(await ve(B), [TX_A]);                   // admin vê só a da carteira
  assert.deepEqual(await ve(C), [TX_A]);                   // membro vê só a da carteira
  assert.deepEqual(await ve(D), []);                       // estranho não vê nada
  const del = await db.as(A, c => db.try(c, 'delete from transactions where id=$1 returning id', [PESSOAL]));
  assert.equal(del.rowCount, 1, 'dono deve poder excluir a própria');
  const delComum = await db.as(C, c => db.try(c, 'delete from transactions where id=$1 returning id', [TX_A]));
  assert.equal(delComum.rowCount, 0, 'membro comum não exclui lançamento alheio');
  const delAdmin = await db.as(B, c => db.try(c, 'delete from transactions where id=$1 returning id', [TX_A]));   // ROLLBACK ao fim
  assert.equal(delAdmin.rowCount, 1, 'admin exclui lançamento da carteira');
  col.add('SEC-11', 'CORRIGIDO', 'Uma policy por comando em transactions; matriz dono/admin/membro/estranho preservada', JSON.stringify(porCmd));
});

test('12. [extra] papel "visualizador" consegue escrever em recursos da carteira?', async () => {
  await db.admin.query(`update financa_members set role='visualizador' where financa_id=$1 and user_id=$2`, [F, C.id]);
  try {
    const r = await db.as(C, async c => ({
      insereTx: await db.try(c, `insert into transactions(user_id,financa_id,value,type,category,description) values ($1,$2,1,'saida','Outros','viz')`, [C.id, F]),
      editaTxAlheia: await db.try(c, `update transactions set description='viz' where id=$1`, [TX_A]),
      apagaCofrinho: await db.try(c, `delete from cofrinhos where financa_id=$1 returning id`, [F]),
      criaCofrinho: await db.try(c, `insert into cofrinhos(user_id,financa_id,name,target_amount) values ($1,$2,'viz',1)`, [C.id, F]),
    }));
    const pode = Object.entries(r).filter(([, v]) => v.ok && (v.rowCount ?? 1) > 0).map(([k]) => k);
    col.add('SEC-12', pode.length ? 'PARCIAL' : 'NAO CONFIRMADO', 'O papel "visualizador" não é aplicado no banco (somente na interface?)',
      'visualizador consegue: ' + (pode.join(', ') || 'nada') + ' (RLS só checa is_financa_member)');
  } finally { await db.admin.query(`update financa_members set role='membro' where financa_id=$1 and user_id=$2`, [F, C.id]); }
});

test('13. [extra] colunas usadas pelo app que não existem nas migrations (drift de colunas)', async () => {
  const ESPERADO = {
    categories: ['financa_id', 'name', 'emoji', 'keywords', 'type', 'no_person'],
    transactions: ['financa_id', 'inserted_by_email', 'reminder_id', 'installment_group_id', 'installment_current', 'installment_total', 'notes', 'type', 'category'],
    transaction_types: ['custom_id', 'name', 'behavior', 'emoji', 'color', 'no_person', 'invest_role', 'financa_id'],
    reminders: ['financa_id', 'name', 'day', 'category', 'notify_time', 'notify_date']
  };
  const faltando = [];
  for (const [t, cols] of Object.entries(ESPERADO)) {
    const r = await db.admin.query(`select column_name from information_schema.columns where table_schema='public' and table_name=$1`, [t]);
    const have = new Set(r.rows.map(x => x.column_name));
    for (const c of cols) if (!have.has(c)) faltando.push(`${t}.${c}`);
  }
  col.add('DB-01', faltando.length ? 'CONFIRMADO' : 'NAO CONFIRMADO', 'Colunas usadas pelo app e ausentes das migrations (drift de schema)',
    faltando.join(', ') || 'todas presentes' + ' | (reminders/transaction_types usam stub mínimo: as colunas "faltando" nelas são reais em produção mas sem migration)');
});

test('14. [A7] role só aceita admin|membro|visualizador (e a migration repõe o CHECK se faltar)', async () => {
  const bad = await db.admin.query(`select 1 from financa_members where role not in ('admin','membro','visualizador')`);
  assert.equal(bad.rowCount, 0);
  const invalidos = [];
  for (const t of ['financa_members', 'financa_invites']) {
    const cols = t === 'financa_members' ? `(financa_id,user_id,email,role)` : `(financa_id,email,role,invited_by)`;
    const vals = t === 'financa_members' ? `($1,$2,'x@x.com','xpto')` : `($1,'y@x.com','xpto',$2)`;
    try { await db.admin.query(`insert into ${t}${cols} values ${vals}`, [F, D.id]); invalidos.push(t); } catch (_) { /* esperado: viola o CHECK */ }
  }
  assert.deepEqual(invalidos, []);
  const viaRpc = await db.as(A, c => db.try(c, `select add_member_by_email($1,'z@x.com','xpto')`, [F]));
  assert.equal(viaRpc.ok, false);
  // F10: o CHECK de role JÁ EXISTE em produção (nenhuma migration nova foi necessária)
  const checks = (await db.admin.query(`select conrelid::regclass::text t from pg_constraint where contype='c' and conrelid in ('public.financa_members'::regclass,'public.financa_invites'::regclass) and pg_get_constraintdef(oid) ilike '%role%'`)).rows.map(r => r.t).sort();
  assert.deepEqual(checks, ['financa_invites', 'financa_members']);
  col.add('F10', 'INFO', 'CHECK de role já existe em financa_members e financa_invites (admin|membro|visualizador); nada a criar');
});

test('15. [D1] mark_invite_emailed: incremento atômico, só service_role', async () => {
  await db.admin.query(`insert into financa_invites(financa_id,email,role,invited_by) values ($1,'atomico@x.com','membro',$2)`, [F, A.id]);
  const id = (await db.admin.query(`select id from financa_invites where email='atomico@x.com'`)).rows[0].id;
  // 20 chamadas simultâneas (conexões separadas, como service_role) → email_count = 20 exatos
  await Promise.all(Array.from({ length: 20 }, () => db.as(null, async c => { await c.query('select mark_invite_emailed($1)', [id]); await c.query('commit'); }, { role: 'service_role' })));
  const n = (await db.admin.query('select email_count, emailed_at is not null as marcado from financa_invites where id=$1', [id])).rows[0];
  await db.admin.query('delete from financa_invites where id=$1', [id]);
  assert.equal(n.email_count, 20); assert.equal(n.marcado, true);
  const negado = await db.as(C, c => db.try(c, 'select mark_invite_emailed($1)', [id]));
  const negadoAnon = await db.as(null, c => db.try(c, 'select mark_invite_emailed($1)', [id]), { role: 'anon' });
  assert.equal(negado.ok, false); assert.equal(negadoAnon.ok, false);
  col.add('FN-04', 'CORRIGIDO', 'email_count incrementado de forma atômica (20 chamadas paralelas = 20); authenticated/anon sem acesso');
});
