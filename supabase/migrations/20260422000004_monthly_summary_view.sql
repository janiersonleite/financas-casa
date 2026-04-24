-- Migration: View for monthly summary (optional, useful for dashboards)

CREATE OR REPLACE VIEW public.monthly_summary AS
SELECT
    user_id,
    TO_CHAR(date, 'YYYY-MM')                         AS month,
    SUM(CASE WHEN type = 'entrada' THEN value ELSE 0 END) AS total_income,
    SUM(CASE WHEN type = 'saida'   THEN value ELSE 0 END) AS total_expense,
    SUM(CASE WHEN type = 'entrada' THEN value ELSE -value END) AS balance,
    COUNT(*)                                          AS transaction_count
FROM public.transactions
GROUP BY user_id, TO_CHAR(date, 'YYYY-MM');

-- RLS on the view (inherits from base table via security_invoker)
ALTER VIEW public.monthly_summary SET (security_invoker = true);
