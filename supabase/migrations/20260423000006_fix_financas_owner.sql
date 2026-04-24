-- Trigger que define owner_id automaticamente a partir do JWT do usuário
CREATE OR REPLACE FUNCTION financas_set_owner()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    NEW.owner_id = auth.uid();
    RETURN NEW;
END;
$$;

CREATE TRIGGER financas_set_owner_trigger
    BEFORE INSERT ON financas
    FOR EACH ROW EXECUTE FUNCTION financas_set_owner();

-- Também define user_id em financa_members automaticamente
CREATE OR REPLACE FUNCTION financa_members_set_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF NEW.user_id IS NULL THEN
        NEW.user_id = auth.uid();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER financa_members_set_user_trigger
    BEFORE INSERT ON financa_members
    FOR EACH ROW EXECUTE FUNCTION financa_members_set_user();

-- Relaxa a política de INSERT: basta estar autenticado
DROP POLICY IF EXISTS "financas_insert" ON financas;
CREATE POLICY "financas_insert" ON financas FOR INSERT
    WITH CHECK (auth.uid() IS NOT NULL);
