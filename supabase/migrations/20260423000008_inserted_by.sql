-- Adiciona coluna inserted_by_email em transactions
ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS inserted_by_email TEXT;

-- Trigger: preenche automaticamente com o e-mail do JWT ao inserir
CREATE OR REPLACE FUNCTION transactions_set_inserted_by()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF NEW.inserted_by_email IS NULL THEN
        NEW.inserted_by_email = auth.jwt()->>'email';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transactions_set_inserted_by_trigger ON transactions;
CREATE TRIGGER transactions_set_inserted_by_trigger
    BEFORE INSERT ON transactions
    FOR EACH ROW EXECUTE FUNCTION transactions_set_inserted_by();
