-- Migration: Performance indexes

-- Primary lookup: user + date descending (main list query)
CREATE INDEX IF NOT EXISTS idx_transactions_user_date
    ON public.transactions (user_id, date DESC);

-- Monthly filter (WHERE date >= '2026-04-01' AND date < '2026-05-01')
CREATE INDEX IF NOT EXISTS idx_transactions_date
    ON public.transactions (date DESC);

-- Category breakdown (GROUP BY category)
CREATE INDEX IF NOT EXISTS idx_transactions_user_category
    ON public.transactions (user_id, category);

-- Type filter (entrada / saida totals)
CREATE INDEX IF NOT EXISTS idx_transactions_user_type
    ON public.transactions (user_id, type);
