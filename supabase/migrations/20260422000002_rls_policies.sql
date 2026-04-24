-- Migration: Row Level Security — users access only their own data

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

-- SELECT: only own rows
CREATE POLICY "transactions_select_own"
    ON public.transactions FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- INSERT: only for the authenticated user themselves
CREATE POLICY "transactions_insert_own"
    ON public.transactions FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- UPDATE: only own rows
CREATE POLICY "transactions_update_own"
    ON public.transactions FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- DELETE: only own rows
CREATE POLICY "transactions_delete_own"
    ON public.transactions FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);
