// Testes da lógica pura de supabase/functions/push-reminders/handler.ts.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = import(pathToFileURL(path.join(__dirname, '..', '..', 'supabase', 'functions', 'push-reminders', 'handler.ts')).href);

const row = (id, o = {}) => ({ id, user_id: 'u1', reminder_id: 'r' + id, title: 'T', body: 'B', tag: 'reminder_x_d0', action: 'open-reminders', attempts: 1, ...o });
const sub = (e, u = 'u1') => ({ endpoint: e, p256dh: 'p', auth: 'a', user_id: u });

function mk(rows, subs, sendImpl) {
  const log = { done: {}, released: [], deleted: [], sent: [], cleanup: 0, claims: [] };
  let queue = [...rows];
  const deps = {
    claim: async n => { log.claims.push(n); const out = queue.slice(0, n); queue = queue.slice(n); return out; },
    subscriptionsFor: async () => subs,
    send: async (s, payload, opts) => { log.sent.push({ s, payload, opts }); return sendImpl ? sendImpl(s, payload, opts) : {}; },
    deleteSubscription: async e => { log.deleted.push(e); },
    markDone: async (id, r) => { log.done[id] = r; },
    release: async id => { log.released.push(id); },
    cleanup: async () => { log.cleanup++; }
  };
  return { deps, log };
}

test('sucesso: marca ok e envia payload com title/body/tag/action/reminderId', async () => {
  const { processBatch } = await H; const { deps, log } = mk([row(1)], [sub('e1')]);
  const s = await processBatch(deps);
  assert.equal(s.ok, 1); assert.equal(log.done[1], 'ok');
  assert.deepEqual(JSON.parse(log.sent[0].payload), { title: 'T', body: 'B', tag: 'reminder_x_d0', action: 'open-reminders', reminderId: 'r1' });
  assert.equal(log.sent[0].opts.TTL, 10800);
});

test('urgência: reminder_*_d0 e tags não-reminder = high; reminder_* antecipado = normal', async () => {
  const { processBatch } = await H;
  const { deps, log } = mk([row(1, { tag: 'reminder_x_d0' }), row(2, { tag: 'reminder_x_d1' }), row(3, { tag: 'outro' })], [sub('e1')]);
  await processBatch(deps);
  const urg = Object.fromEntries(log.sent.map(x => [JSON.parse(x.payload).tag, x.opts.urgency]));
  assert.deepEqual(urg, { reminder_x_d0: 'high', reminder_x_d1: 'normal', outro: 'high' });
});

test('sem assinatura: no_subscription', async () => {
  const { processBatch } = await H; const { deps, log } = mk([row(1)], []);
  const s = await processBatch(deps);
  assert.equal(s.noSubscription, 1); assert.equal(log.done[1], 'no_subscription'); assert.equal(log.sent.length, 0);
});

test('404/410 removem a assinatura e marcam no_subscription (sem retry)', async () => {
  const { processBatch } = await H;
  for (const code of [404, 410]) {
    const { deps, log } = mk([row(1)], [sub('e1')], async () => { throw { statusCode: code }; });
    const s = await processBatch(deps);
    assert.deepEqual(log.deleted, ['e1']); assert.equal(s.removedSubscriptions, 1); assert.equal(log.done[1], 'no_subscription'); assert.equal(log.released.length, 0);
  }
});

test('erro transitório: release até a última tentativa; na 3ª vira failed', async () => {
  const { processBatch } = await H;
  const falha = async () => { throw { statusCode: 503 }; };
  let t = mk([row(1, { attempts: 1 })], [sub('e1')], falha); let s = await processBatch(t.deps);
  assert.equal(s.retry, 1); assert.deepEqual(t.log.released.map(String), ['1']);
  t = mk([row(1, { attempts: 2 })], [sub('e1')], falha); s = await processBatch(t.deps);
  assert.equal(s.retry, 1);
  t = mk([row(1, { attempts: 3 })], [sub('e1')], falha); s = await processBatch(t.deps);
  assert.equal(s.failed, 1); assert.equal(t.log.done[1], 'failed'); assert.equal(t.log.released.length, 0);
});

test('vários aparelhos: um falha, outro entrega → ok; um 410 é removido uma só vez', async () => {
  const { processBatch } = await H;
  const { deps, log } = mk([row(1), row(2)], [sub('e1'), sub('e2')], async s => { if (s.endpoint === 'e1') throw { statusCode: 410 }; return {}; });
  const s = await processBatch(deps);
  assert.equal(s.ok, 2); assert.deepEqual(log.deleted, ['e1']); assert.equal(s.removedSubscriptions, 1);
});

test('erro inesperado em um item não derruba o lote (release / failed)', async () => {
  const { processBatch } = await H;
  const { deps, log } = mk([row(1, { attempts: 1 }), row(2, { attempts: 3 }), row(3)], [sub('e1')]);
  const orig = deps.markDone; deps.markDone = async (id, r) => { if (id === '1' || id === 1) throw new Error('db'); return orig(id, r); };
  deps.markDone = async (id, r) => { if (String(id) === '1' && r === 'ok') throw new Error('db caiu'); return orig(id, r); };
  const s = await processBatch(deps);
  assert.equal(s.claimed, 3); assert.ok(log.released.includes(1) || log.released.includes('1')); assert.equal(log.done[3], 'ok');
});

test('processAll encadeia lotes (more) até esvaziar', async () => {
  const { processAll } = await H;
  const rows = Array.from({ length: 5 }, (_, i) => row(i + 1));
  const { deps, log } = mk(rows, [sub('e1')]);
  const r = await processAll(deps, { batchSize: 2, maxBatches: 10, cleanup: true });
  assert.equal(r.batches, 3); assert.equal(r.claimed, 5); assert.equal(r.ok, 5); assert.equal(r.more, false); assert.equal(log.cleanup, 1);
});

test('processAll respeita maxBatches (more=true) e o orçamento de tempo', async () => {
  const { processAll } = await H;
  const rows = Array.from({ length: 10 }, (_, i) => row(i + 1));
  let t = mk(rows, [sub('e1')]);
  let r = await processAll(t.deps, { batchSize: 2, maxBatches: 2 });
  assert.equal(r.batches, 2); assert.equal(r.claimed, 4); assert.equal(r.more, true);
  t = mk(rows, [sub('e1')]);
  let clock = 0; r = await processAll(t.deps, { batchSize: 2, maxBatches: 10, budgetMs: 1000, now: () => (clock += 600) });
  assert.ok(r.batches < 5 && r.more === true, 'deveria parar pelo orçamento: ' + r.batches);
});

test('processAll: falha na limpeza não quebra; sem cleanup não chama', async () => {
  const { processAll } = await H; const { deps, log } = mk([], []);
  deps.cleanup = async () => { throw new Error('x'); };
  await processAll(deps, { cleanup: true });
  const t = mk([], []); await processAll(t.deps, {}); assert.equal(t.log.cleanup, 0); void log;
});
