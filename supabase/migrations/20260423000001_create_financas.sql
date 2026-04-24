-- Garante que a função existe (pode ter sido criada em outra migration)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

-- Tabela de finanças (projetos de controle financeiro)
CREATE TABLE IF NOT EXISTS financas (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL DEFAULT 'individual'
        CHECK (type IN ('individual', 'compartilhada')),
    emoji VARCHAR(10) NOT NULL DEFAULT '💰',
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER update_financas_updated_at
    BEFORE UPDATE ON financas
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
