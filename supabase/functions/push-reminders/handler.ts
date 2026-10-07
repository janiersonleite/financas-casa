// Lógica pura do envio de lembretes por Web Push (sem dependências externas → testável em Node/Deno).

export interface QueueRow {
    id: string; user_id: string; reminder_id: string;
    title: string; body: string; tag: string; action: string; attempts: number;
}
export interface Sub { endpoint: string; p256dh: string; auth: string; user_id: string }
export interface Deps {
    claim(limit: number): Promise<QueueRow[]>;
    subscriptionsFor(userIds: string[]): Promise<Sub[]>;
    /** Deve rejeitar com { statusCode } quando o serviço de push recusar. */
    send(sub: Sub, payload: string, opts: { TTL: number; urgency: 'high' | 'normal' }): Promise<unknown>;
    deleteSubscription(endpoint: string): Promise<void>;
    markDone(id: string, result: 'ok' | 'no_subscription' | 'failed'): Promise<void>;
    release(id: string): Promise<void>;
    cleanup(): Promise<void>;
}
export interface Summary { claimed: number; ok: number; noSubscription: number; retry: number; failed: number; removedSubscriptions: number }

const MAX_ATTEMPTS = 3;            // tem de bater com claim_due_push (attempts < 3)
const TTL_SECONDS = 3 * 60 * 60;   // se o aparelho estiver desligado, descarta após 3 h
const CHUNK = 20;                  // envios em paralelo

const isGone = (e: unknown) => { const c = (e as { statusCode?: number })?.statusCode; return c === 404 || c === 410; };

export function buildPayload(r: QueueRow): string {
    return JSON.stringify({ title: r.title, body: r.body, tag: r.tag, action: r.action || 'open-reminders', reminderId: r.reminder_id });
}

/** Processa UM lote (reserva até `limit` avisos e envia). Não faz limpeza. */
export async function processBatch(deps: Deps, limit = 200): Promise<Summary> {
    const out: Summary = { claimed: 0, ok: 0, noSubscription: 0, retry: 0, failed: 0, removedSubscriptions: 0 };
    const rows = await deps.claim(limit);
    out.claimed = rows.length;
    if (rows.length) {
        const userIds = [...new Set(rows.map(r => r.user_id))];
        const subs = await deps.subscriptionsFor(userIds);
        const byUser = new Map<string, Sub[]>();
        for (const s of subs) (byUser.get(s.user_id) ?? byUser.set(s.user_id, []).get(s.user_id)!).push(s);
        const removed = new Set<string>();

        const handle = async (row: QueueRow) => {
            const mine = byUser.get(row.user_id) ?? [];
            if (!mine.length) { await deps.markDone(row.id, 'no_subscription'); out.noSubscription++; return; }
            const payload = buildPayload(row);
            const results = await Promise.allSettled(
                mine.map(s => deps.send(s, payload, { TTL: TTL_SECONDS, urgency: row.tag.startsWith('reminder_') && !row.tag.endsWith('_d0') ? 'normal' : 'high' })));
            let delivered = 0, transient = 0;
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                if (r.status === 'fulfilled') { delivered++; continue; }
                if (isGone(r.reason)) {
                    if (!removed.has(mine[i].endpoint)) { removed.add(mine[i].endpoint); await deps.deleteSubscription(mine[i].endpoint); out.removedSubscriptions++; }
                } else transient++;
            }
            if (delivered > 0)      { await deps.markDone(row.id, 'ok'); out.ok++; }
            else if (transient > 0) {
                if (row.attempts >= MAX_ATTEMPTS) { await deps.markDone(row.id, 'failed'); out.failed++; }
                else { await deps.release(row.id); out.retry++; }
            } else { await deps.markDone(row.id, 'no_subscription'); out.noSubscription++; } // todas as assinaturas haviam expirado
        };

        for (let i = 0; i < rows.length; i += CHUNK) {
            await Promise.all(rows.slice(i, i + CHUNK).map(r => handle(r).catch(async () => {
                // erro inesperado neste item: tenta de novo na próxima rodada (ou desiste na última)
                if (r.attempts >= MAX_ATTEMPTS) { await deps.markDone(r.id, 'failed').catch(() => {}); out.failed++; }
                else { await deps.release(r.id).catch(() => {}); out.retry++; }
            })));
        }
    }
    return out;
}

export interface RunOptions {
    batchSize?: number;   // avisos reservados por lote (o SQL limita a 500)
    maxBatches?: number;  // lotes por execução (cada execução tem limite de CPU)
    budgetMs?: number;    // para de abrir lotes novos depois deste tempo
    cleanup?: boolean;    // limpeza da fila (feita só de vez em quando)
    now?: () => number;
}
export interface RunSummary extends Summary { batches: number; /** o último lote veio cheio → ainda pode haver avisos vencidos */ more: boolean }

/** Processa lotes em sequência até esvaziar a fila, esgotar `maxBatches` ou o tempo. */
export async function processAll(deps: Deps, opts: RunOptions = {}): Promise<RunSummary> {
    const batchSize = opts.batchSize ?? 250, maxBatches = opts.maxBatches ?? 2, budget = opts.budgetMs ?? 30_000;
    const now = opts.now ?? Date.now, start = now();
    const total: RunSummary = { claimed: 0, ok: 0, noSubscription: 0, retry: 0, failed: 0, removedSubscriptions: 0, batches: 0, more: false };
    for (let i = 0; i < maxBatches; i++) {
        const s = await processBatch(deps, batchSize);
        total.batches++;
        total.claimed += s.claimed; total.ok += s.ok; total.noSubscription += s.noSubscription;
        total.retry += s.retry; total.failed += s.failed; total.removedSubscriptions += s.removedSubscriptions;
        total.more = s.claimed >= batchSize;
        if (!total.more || now() - start > budget) break;
    }
    if (opts.cleanup) await deps.cleanup().catch(() => {});
    return total;
}
