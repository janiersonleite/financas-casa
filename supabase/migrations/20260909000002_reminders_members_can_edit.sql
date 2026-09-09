-- Permite que membros de uma finança compartilhada editem/excluam os lembretes
-- daquela finança — não apenas quem criou. Antes, só existia a policy
-- "Users manage own reminders" (auth.uid() = user_id), que impedia editar
-- lembretes criados por outros membros da mesma carteira.
create policy reminders_update_members on public.reminders for update
  using (financa_id is not null and is_financa_member(financa_id))
  with check (financa_id is not null and is_financa_member(financa_id));

create policy reminders_delete_members on public.reminders for delete
  using (financa_id is not null and is_financa_member(financa_id));
