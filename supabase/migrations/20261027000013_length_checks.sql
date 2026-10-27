-- [A14] Limites de tamanho de texto livre (CHECK ... NOT VALID).
--
-- O QUE CORRIGE
--   Não havia limite de tamanho em transactions.description/notes nem nos nomes: um cliente malicioso (ou um erro) podia gravar
--   megabytes de texto, que depois são renderizados para todos os membros da carteira.
--     transactions.description <= 300   transactions.notes <= 1000   categories.name <= 40
--     reminders.name <= 80              transaction_types.name <= 40  financas.name <= 60
--   Criados como NOT VALID: NÃO falham por dados existentes e valem para INSERT/UPDATE novos. Depois da verificação
--   (docs/qa/verificacao-limites.sql) rode os VALIDATE CONSTRAINT listados lá.
--   NÃO cria CHECK em transactions.type (guarda ids de tipos customizados).
--
-- O QUE PODE QUEBRAR: texto acima do limite passa a ser recusado; o front limita a digitação (maxlength) e corta a importação nos mesmos
--   limites (a descrição de parcelas usa 290 + sufixo "(n/N)"). UPDATE em linha ANTIGA já fora do limite falha até encurtar o texto.
-- COMO REVERTER: alter table public.<tabela> drop constraint if exists <nome>;  (nomes abaixo)

do $$
declare c record;
begin
    for c in select * from (values
        ('transactions', 'transactions_description_len', 'char_length(description) <= 300'),
        ('transactions', 'transactions_notes_len',       'char_length(notes) <= 1000'),
        ('categories',   'categories_name_len',          'char_length(name) <= 40'),
        ('reminders',    'reminders_name_len',           'char_length(name) <= 80'),
        ('transaction_types', 'transaction_types_name_len', 'char_length(name) <= 40'),
        ('financas',     'financas_name_len',            'char_length(name) <= 60')
    ) as t(tab, nome, regra) loop
        if to_regclass('public.' || c.tab) is not null and not exists (
            select 1 from pg_constraint where conname = c.nome and conrelid = to_regclass('public.' || c.tab)) then
            execute format('alter table public.%I add constraint %I check (%s) not valid', c.tab, c.nome, c.regra);
        end if;
    end loop;
end $$;
