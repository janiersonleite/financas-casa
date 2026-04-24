-- Convites para participar de uma finança compartilhada
CREATE TABLE IF NOT EXISTS financa_invites (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    financa_id UUID NOT NULL REFERENCES financas(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'membro'
        CHECK (role IN ('admin', 'membro', 'visualizador')),
    token UUID DEFAULT gen_random_uuid() UNIQUE,
    invited_by UUID NOT NULL REFERENCES auth.users(id),
    accepted_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(financa_id, email)
);

CREATE INDEX idx_financa_invites_email ON financa_invites(email);
