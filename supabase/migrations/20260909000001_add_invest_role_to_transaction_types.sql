-- Papel do tipo de lançamento no módulo de Investimentos:
--   'aporte'  → dinheiro ENTRA na carteira (aplicação)
--   'resgate' → dinheiro SAI da carteira (resgate)
--   NULL      → tipo não participa da carteira de investimentos
-- A carteira por produto usa a CATEGORIA do lançamento como "produto".
alter table public.transaction_types
    add column if not exists invest_role text;
