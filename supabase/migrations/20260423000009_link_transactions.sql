-- Função para vincular transações pessoais (financa_id NULL) a uma finança
-- Só o dono/admin da finança pode chamar
CREATE OR REPLACE FUNCTION link_my_transactions_to_financa(fid UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    updated_count INTEGER;
BEGIN
    IF NOT is_financa_member(fid) THEN
        RAISE EXCEPTION 'Sem permissão';
    END IF;

    UPDATE transactions
    SET financa_id = fid
    WHERE user_id = auth.uid()
      AND financa_id IS NULL;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;
