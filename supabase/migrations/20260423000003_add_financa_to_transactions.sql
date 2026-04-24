-- Vincula transações às finanças (nullable para compatibilidade com dados antigos)
ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS financa_id UUID REFERENCES financas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_financa
    ON transactions(financa_id) WHERE financa_id IS NOT NULL;
