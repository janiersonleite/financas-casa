-- RLS para tabelas de finanças

ALTER TABLE financas        ENABLE ROW LEVEL SECURITY;
ALTER TABLE financa_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE financa_invites ENABLE ROW LEVEL SECURITY;

-- Funções auxiliares (SECURITY DEFINER para evitar recursão RLS)
CREATE OR REPLACE FUNCTION is_financa_member(fid UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
    SELECT EXISTS (
        SELECT 1 FROM financas WHERE id = fid AND owner_id = auth.uid()
    ) OR EXISTS (
        SELECT 1 FROM financa_members WHERE financa_id = fid AND user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION is_financa_admin(fid UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
    SELECT EXISTS (
        SELECT 1 FROM financas WHERE id = fid AND owner_id = auth.uid()
    ) OR EXISTS (
        SELECT 1 FROM financa_members
        WHERE financa_id = fid AND user_id = auth.uid() AND role = 'admin'
    );
$$;

-- Políticas: financas
CREATE POLICY "financas_select" ON financas FOR SELECT USING (is_financa_member(id));
CREATE POLICY "financas_insert" ON financas FOR INSERT WITH CHECK (owner_id = auth.uid());
CREATE POLICY "financas_update" ON financas FOR UPDATE USING (is_financa_admin(id));
CREATE POLICY "financas_delete" ON financas FOR DELETE USING (owner_id = auth.uid());

-- Políticas: financa_members
CREATE POLICY "members_select" ON financa_members FOR SELECT
    USING (is_financa_member(financa_id));
CREATE POLICY "members_insert" ON financa_members FOR INSERT
    WITH CHECK (is_financa_admin(financa_id) OR user_id = auth.uid());
CREATE POLICY "members_delete" ON financa_members FOR DELETE
    USING (user_id = auth.uid() OR is_financa_admin(financa_id));

-- Políticas: financa_invites
CREATE POLICY "invites_select" ON financa_invites FOR SELECT
    USING (
        is_financa_admin(financa_id) OR
        lower(email) = lower(coalesce(auth.jwt()->>'email', ''))
    );
CREATE POLICY "invites_insert" ON financa_invites FOR INSERT
    WITH CHECK (is_financa_admin(financa_id) AND invited_by = auth.uid());
CREATE POLICY "invites_update" ON financa_invites FOR UPDATE
    USING (
        lower(email) = lower(coalesce(auth.jwt()->>'email', '')) OR
        is_financa_admin(financa_id)
    );
CREATE POLICY "invites_delete" ON financa_invites FOR DELETE
    USING (is_financa_admin(financa_id));

-- Atualiza RLS de transactions para suportar membros de finanças compartilhadas
DROP POLICY IF EXISTS "Users can view own transactions"   ON transactions;
DROP POLICY IF EXISTS "Users can insert own transactions" ON transactions;
DROP POLICY IF EXISTS "Users can update own transactions" ON transactions;
DROP POLICY IF EXISTS "Users can delete own transactions" ON transactions;

CREATE POLICY "transactions_select" ON transactions FOR SELECT
    USING (
        user_id = auth.uid() OR
        (financa_id IS NOT NULL AND is_financa_member(financa_id))
    );
CREATE POLICY "transactions_insert" ON transactions FOR INSERT
    WITH CHECK (
        user_id = auth.uid() AND
        (financa_id IS NULL OR is_financa_member(financa_id))
    );
CREATE POLICY "transactions_update" ON transactions FOR UPDATE
    USING (
        user_id = auth.uid() OR
        (financa_id IS NOT NULL AND is_financa_admin(financa_id))
    );
CREATE POLICY "transactions_delete" ON transactions FOR DELETE
    USING (
        user_id = auth.uid() OR
        (financa_id IS NOT NULL AND is_financa_admin(financa_id))
    );
