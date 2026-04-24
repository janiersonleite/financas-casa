-- Membros de cada finança (dono + convidados)
CREATE TABLE IF NOT EXISTS financa_members (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    financa_id UUID NOT NULL REFERENCES financas(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    email VARCHAR(255),
    role VARCHAR(20) NOT NULL DEFAULT 'membro'
        CHECK (role IN ('admin', 'membro', 'visualizador')),
    invited_by UUID REFERENCES auth.users(id),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(financa_id, user_id)
);

CREATE INDEX idx_financa_members_user    ON financa_members(user_id);
CREATE INDEX idx_financa_members_financa ON financa_members(financa_id);
