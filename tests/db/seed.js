// Usuários e dados-base compartilhados pelos testes de banco (nenhum dado real: UUIDs/e-mails fictícios).
'use strict';
const U = n => ({ id: `00000000-0000-0000-0000-00000000000${n}`, email: `u${n}@teste.com` });
const A = U(1), B = U(2), C = U(3), D = U(4), E_UNCONF = U(5);     // dono, admin, membro, estranho, e-mail não confirmado
const F = '00000000-0000-0000-0000-0000000000f1';                    // carteira compartilhada do A (B admin, C membro)
const G = '00000000-0000-0000-0000-0000000000f2';                    // carteira do D (A NÃO é membro)
const TX_A = '00000000-0000-0000-0000-0000000000a1';

async function seed(db) {
  const a = db.admin;
  for (const u of [A, B, C, D]) await a.query('insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())', [u.id, u.email]);
  await a.query('insert into auth.users(id,email,email_confirmed_at) values ($1,$2,null)', [E_UNCONF.id, E_UNCONF.email]);
  // trigger financas_set_owner força owner_id = auth.uid() → semeia "como" cada dono
  for (const [id, nome, dono] of [[F, 'Casa', A], [G, 'Do D', D]]) {
    await a.query(`select set_config('request.jwt.claim.sub', $1, false)`, [dono.id]);
    await a.query(`insert into financas(id,name,type) values ($1,$2,'compartilhada')`, [id, nome]);
  }
  await a.query(`select set_config('request.jwt.claim.sub', '', false)`);
  await a.query(`insert into financa_members(financa_id,user_id,email,role) values ($1,$2,$3,'admin'),($1,$4,$5,'membro')`, [F, B.id, B.email, C.id, C.email]);
  await a.query(`insert into transactions(id,user_id,financa_id,value,type,category,description) values ($1,$2,$3,10,'saida','Outros','tx do A')`, [TX_A, A.id, F]);
}
module.exports = { U, A, B, C, D, E_UNCONF, F, G, TX_A, seed };
