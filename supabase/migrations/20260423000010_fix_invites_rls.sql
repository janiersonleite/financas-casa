-- Função SECURITY DEFINER para buscar convites do usuário logado
-- Evita o problema de auth.jwt()->>'email' não estar disponível no RLS
CREATE OR REPLACE FUNCTION get_my_pending_invites()
RETURNS TABLE (
    id            UUID,
    financa_id    UUID,
    email         VARCHAR,
    role          VARCHAR,
    invited_by    UUID,
    accepted_at   TIMESTAMPTZ,
    expires_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ,
    financa_name  TEXT,
    financa_emoji TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v_email TEXT;
BEGIN
    SELECT u.email INTO v_email
    FROM auth.users u
    WHERE u.id = auth.uid();

    IF v_email IS NULL THEN RETURN; END IF;

    RETURN QUERY
        SELECT
            i.id, i.financa_id, i.email, i.role, i.invited_by,
            i.accepted_at, i.expires_at, i.created_at,
            f.name::TEXT  AS financa_name,
            f.emoji::TEXT AS financa_emoji
        FROM financa_invites i
        JOIN financas f ON f.id = i.financa_id
        WHERE lower(i.email) = lower(v_email)
          AND i.accepted_at IS NULL
          AND (i.expires_at IS NULL OR i.expires_at > NOW());
END;
$$;

-- Também corrige a política de SELECT nos invites para usar a função segura
DROP POLICY IF EXISTS "invites_select" ON financa_invites;

CREATE OR REPLACE FUNCTION my_invite_email_matches(inv_email TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v_email TEXT;
BEGIN
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    RETURN lower(inv_email) = lower(coalesce(v_email, ''));
END;
$$;

CREATE POLICY "invites_select" ON financa_invites FOR SELECT
    USING (
        is_financa_admin(financa_id) OR
        my_invite_email_matches(email)
    );
