-- Rode na PRODUÇÃO (somente leitura) ANTES da migration 20261027000013_length_checks.sql.
-- Conta linhas que JÁ violam os limites. Esperado: tudo 0. Com CHECK ... NOT VALID, linhas antigas fora do limite
-- continuam existindo, mas um UPDATE que reescreva uma delas (qualquer coluna) passa a falhar até que o texto seja encurtado.
select 'transactions.description > 300' as limite, count(*) as violacoes from public.transactions where char_length(description) > 300
union all select 'transactions.notes > 1000',          count(*) from public.transactions       where char_length(notes) > 1000
union all select 'categories.name > 40',               count(*) from public.categories         where char_length(name) > 40
union all select 'reminders.name > 80',                count(*) from public.reminders          where char_length(name) > 80
union all select 'transaction_types.name > 40',        count(*) from public.transaction_types  where char_length(name) > 40
union all select 'financas.name > 60',                 count(*) from public.financas           where char_length(name) > 60;

-- Se algum for > 0, encurte antes (exemplo):  update public.transactions set description = left(description, 300) where char_length(description) > 300;

-- DEPOIS de aplicar a migration e com os contadores acima em 0 (uma tabela por vez; pode demorar em tabelas grandes):
--   alter table public.transactions      validate constraint transactions_description_len;
--   alter table public.transactions      validate constraint transactions_notes_len;
--   alter table public.categories        validate constraint categories_name_len;
--   alter table public.reminders         validate constraint reminders_name_len;
--   alter table public.transaction_types validate constraint transaction_types_name_len;
--   alter table public.financas          validate constraint financas_name_len;
