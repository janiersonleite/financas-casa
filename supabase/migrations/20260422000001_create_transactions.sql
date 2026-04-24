-- Migration: Create transactions table
-- Run this in your Supabase SQL Editor

CREATE TABLE IF NOT EXISTS public.transactions (
    id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    value       NUMERIC(12, 2) NOT NULL CHECK (value > 0),
    type        VARCHAR(10) NOT NULL CHECK (type IN ('entrada', 'saida')),
    category    VARCHAR(50) NOT NULL DEFAULT 'Outros',
    description TEXT        NOT NULL DEFAULT '',
    date        DATE        NOT NULL DEFAULT CURRENT_DATE,
    notes       TEXT                 DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_transactions_updated
    BEFORE UPDATE ON public.transactions
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

COMMENT ON TABLE public.transactions IS 'Daily financial transactions for each user';
