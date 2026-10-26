// Harness de banco para os testes: sobe um Postgres LOCAL descartável (ou usa
// TEST_DATABASE_URL), aplica os stubs + todas as migrations em ordem e entrega
// helpers para simular usuários (role authenticated + JWT claims).
// NUNCA toca o Supabase de produção: só conecta em 127.0.0.1 / socket local.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..', '..');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');

function findPgBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const base = '/usr/lib/postgresql';
  if (fs.existsSync(base)) {
    const v = fs.readdirSync(base).sort((a, b) => Number(b) - Number(a))[0];
    if (v && fs.existsSync(path.join(base, v, 'bin', 'initdb'))) return path.join(base, v, 'bin');
  }
  return null;
}

let cluster = null;
function asPg(cmd, args, opts = {}) {
  // initdb/postgres não rodam como root → usa o usuário "postgres" quando necessário
  if (process.getuid && process.getuid() === 0) return execFileSync('runuser', ['-u', 'postgres', '--', cmd, ...args], { stdio: 'pipe', ...opts });
  return execFileSync(cmd, args, { stdio: 'pipe', ...opts });
}

function startCluster() {
  if (cluster) return cluster;
  const bin = findPgBin();
  if (!bin) throw new Error('Postgres não encontrado. Instale (apt install postgresql) ou defina TEST_DATABASE_URL / PG_BIN.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-pg-'));
  if (process.getuid && process.getuid() === 0) execFileSync('chown', ['postgres:postgres', dir]);
  const data = path.join(dir, 'data');
  const port = 20000 + Math.floor(Math.random() * 30000);
  asPg(path.join(bin, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-sync', '-E', 'UTF8', '--locale=C.UTF-8']);   // UTF8 como no Supabase (char_length conta caracteres)
  asPg(path.join(bin, 'pg_ctl'), ['-D', data, '-w', '-l', path.join(dir, 'pg.log'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, 'start']);
  cluster = { dir, data, port, bin };
  const stop = () => { try { asPg(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop']); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  process.on('exit', stop);
  return cluster;
}

function adminUrl(db) {
  if (process.env.TEST_DATABASE_URL) {
    const u = new URL(process.env.TEST_DATABASE_URL);
    if (!/^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(u.hostname)) throw new Error('TEST_DATABASE_URL precisa apontar para localhost (proteção contra produção).');
    u.pathname = '/' + db; return u.toString();
  }
  const c = startCluster();
  return `postgres://postgres@127.0.0.1:${c.port}/${db}`;
}

const sqlFiles = () => fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();

/** Cria um banco novo e aplica, em ordem: stubs → migrations existentes (< FIX_PREFIX) → [stubs de drift] →
 *  prod-state.sql (estado REAL da produção) → migrations de correção (>= FIX_PREFIX).
 *  Opções: prodState (padrão true) e fixes (padrão true; QA_FIXES=0 desliga → mostra o "antes"). */
const FIX_PREFIX = '20261027';
async function createTestDb({ migrations = true, prodState = true, fixes = process.env.QA_FIXES !== '0' } = {}) {
  const name = 'qa_' + Math.random().toString(36).slice(2, 10);
  const root = new Client({ connectionString: adminUrl('postgres') });
  await root.connect();
  await root.query(`create database ${name}`);
  await root.end();
  const admin = new Client({ connectionString: adminUrl(name) });
  await admin.connect();
  await admin.query(fs.readFileSync(path.join(__dirname, 'stubs.sql'), 'utf8'));

  const applied = [], failed = [];
  const run = async f => {
    try { await admin.query(fs.readFileSync(path.join(MIG_DIR, f), 'utf8')); applied.push(f); }
    catch (e) { failed.push({ file: f, error: e.message }); await admin.query('rollback').catch(() => {}); }
  };
  if (migrations) {
    const driftSql = fs.readFileSync(path.join(__dirname, 'stubs-drift.sql'), 'utf8');   // tabelas criadas "à mão" (sem migration)
    let driftApplied = false;
    const todas = sqlFiles();
    for (const f of todas.filter(x => x < FIX_PREFIX)) {
      if (!driftApplied && f >= '20260901') { driftApplied = true; await admin.query(driftSql); }
      await run(f);
    }
    if (prodState) await admin.query(fs.readFileSync(path.join(__dirname, 'prod-state.sql'), 'utf8'));
    if (fixes) for (const f of todas.filter(x => x >= FIX_PREFIX)) await run(f);
  }

  const ctx = {
    name, admin, applied, failed,
    /** Executa fn(client) como o usuário (role authenticated) numa transação com ROLLBACK. */
    async as(user, fn, { role = 'authenticated' } = {}) {
      const c = new Client({ connectionString: adminUrl(name) });
      await c.connect();
      try {
        await c.query('begin');
        await c.query(`set local role ${role}`);
        if (user) {
          await c.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $3, true), set_config('request.jwt.claims', $2, true)`,
            [user.id, JSON.stringify({ sub: user.id, email: user.email, role }), role]);
        }
        return await fn(c);
      } finally { await c.query('rollback').catch(() => {}); await c.end(); }
    },
    /** Tenta executar; devolve { ok, rows, rowCount, error }. Usa SAVEPOINT p/ não abortar a transação. */
    async try(c, sql, params = []) {
      await c.query('savepoint s');
      try { const r = await c.query(sql, params); await c.query('release savepoint s'); return { ok: true, rows: r.rows, rowCount: r.rowCount }; }
      catch (e) { await c.query('rollback to savepoint s'); return { ok: false, error: e.message, code: e.code }; }
    },
    async close() { await admin.end(); }
  };
  return ctx;
}

module.exports = { createTestDb, sqlFiles, MIG_DIR, ROOT, FIX_PREFIX };
