-- ─────────────────────────────────────────────────────────────────────────────
-- 1. add_member_by_email
--    Tenta adicionar diretamente como membro se o usuário já existe no Supabase.
--    Se não existir, cria um convite pendente.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION add_member_by_email(
    fid          UUID,
    member_email TEXT,
    member_role  TEXT DEFAULT 'membro'
)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v_user_id UUID;
BEGIN
    IF NOT is_financa_admin(fid) THEN
        RAISE EXCEPTION 'Sem permissão';
    END IF;

    SELECT id INTO v_user_id
    FROM auth.users
    WHERE lower(email) = lower(member_email);

    IF v_user_id IS NOT NULL THEN
        INSERT INTO financa_members (financa_id, user_id, email, role, invited_by)
        VALUES (fid, v_user_id, lower(member_email), member_role, auth.uid())
        ON CONFLICT (financa_id, user_id) DO UPDATE SET role = EXCLUDED.role;
        RETURN 'added';
    ELSE
        INSERT INTO financa_invites (financa_id, email, role, invited_by)
        VALUES (fid, lower(member_email), member_role, auth.uid())
        ON CONFLICT (financa_id, email) DO UPDATE SET role = EXCLUDED.role;
        RETURN 'invited';
    END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. auto_accept_my_invites
--    Chamada no login: varre financa_invites pelo e-mail do usuário e insere
--    em financa_members automaticamente — sem depender de JWT claims no RLS.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION auto_accept_my_invites()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v_email TEXT;
    v_count INTEGER := 0;
    rec     RECORD;
BEGIN
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    IF v_email IS NULL THEN RETURN 0; END IF;

    FOR rec IN
        SELECT id, financa_id, role
        FROM financa_invites
        WHERE lower(email) = lower(v_email)
          AND accepted_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
    LOOP
        INSERT INTO financa_members (financa_id, user_id, email, role)
        VALUES (rec.financa_id, auth.uid(), v_email, rec.role)
        ON CONFLICT (financa_id, user_id) DO NOTHING;

        UPDATE financa_invites
        SET accepted_at = NOW()
        WHERE id = rec.id;

        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$;
