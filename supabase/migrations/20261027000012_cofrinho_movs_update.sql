-- [A11 / F12] cofrinho_movs_update: mantida (o front edita movimentações) com colunas-chave imutáveis.
--
-- CONTEXTO
--   A migration original dizia que a ausência de UPDATE em cofrinho_movs era proposital ("exclui e lança de novo"), mas o app agora
--   tem "editar movimentação" (js/cofrinhos.js Cofrinhos.updateMov → UPDATE em cofrinho_movs) e a policy cofrinho_movs_update existe
--   em produção. Por isso a policy é MANTIDA — recriada de forma determinística — e endurecida.
-- O QUE CORRIGE
--   O UPDATE não impedia trocar user_id (autor), kind (depósito↔retirada) nem cofrinho_id. Um trigger passa a bloquear essas mudanças;
--   o app só altera valor, data e observação. Acesso continua: quem acessa o cofrinho (dono ou membro da carteira).
-- O QUE PODE QUEBRAR: nada no app. Mudar kind/user_id/cofrinho_id de uma movimentação passa a dar erro (excluir e lançar de novo).
-- COMO REVERTER: drop trigger if exists cofrinho_movs_lock_keys_trigger on public.cofrinho_movs;
--   drop function if exists public.cofrinho_movs_lock_keys();  (a policy pode permanecer)

do $$
declare r record;
begin
    for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'cofrinho_movs' and cmd in ('UPDATE', 'ALL') loop
        execute format('drop policy if exists %I on public.cofrinho_movs', r.policyname);
    end loop;
end $$;
drop policy if exists "cofrinho_movs_update" on public.cofrinho_movs;

create policy "cofrinho_movs_update" on public.cofrinho_movs for update
    using (exists (select 1 from public.cofrinhos c where c.id = cofrinho_id and public.can_access_cofrinho(c.user_id, c.financa_id)))
    with check (exists (select 1 from public.cofrinhos c where c.id = cofrinho_id and public.can_access_cofrinho(c.user_id, c.financa_id)));
grant update on public.cofrinho_movs to authenticated;

create or replace function public.cofrinho_movs_lock_keys() returns trigger
language plpgsql set search_path = public as $$
begin
    if new.user_id is distinct from old.user_id or new.cofrinho_id is distinct from old.cofrinho_id or new.kind is distinct from old.kind then
        raise exception 'cofrinho_movs: user_id, cofrinho_id e kind não podem ser alterados';
    end if;
    return new;
end $$;

drop trigger if exists cofrinho_movs_lock_keys_trigger on public.cofrinho_movs;
create trigger cofrinho_movs_lock_keys_trigger before update on public.cofrinho_movs
    for each row execute function public.cofrinho_movs_lock_keys();
revoke all on function public.cofrinho_movs_lock_keys() from public, anon, authenticated;
