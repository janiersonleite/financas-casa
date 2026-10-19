-- Permite editar uma movimentação (valor, data, observação) de um cofrinho.
-- Mesmo critério de acesso do INSERT/DELETE. Idempotente.
drop policy if exists cofrinho_movs_update on public.cofrinho_movs;
create policy cofrinho_movs_update on public.cofrinho_movs for update
    using (exists (
        select 1 from public.cofrinhos c
        where c.id = cofrinho_id and public.can_access_cofrinho(c.user_id, c.financa_id)
    ))
    with check (exists (
        select 1 from public.cofrinhos c
        where c.id = cofrinho_id and public.can_access_cofrinho(c.user_id, c.financa_id)
    ));

grant update on public.cofrinho_movs to authenticated;
notify pgrst, 'reload schema';
