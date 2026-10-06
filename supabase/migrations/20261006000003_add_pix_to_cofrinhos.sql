-- Chave PIX opcional por cofrinho: para onde transferir o dinheiro que será
-- guardado naquele objetivo. Fica no próprio cofrinho (sincroniza entre os
-- membros da carteira) e é protegida pelas mesmas regras de acesso (RLS) dele.
--
-- Requer 20261006000001_create_cofrinhos.sql já aplicada.
-- Como aplicar: cole este arquivo inteiro no SQL Editor do Supabase e execute
-- (é idempotente — pode rodar mais de uma vez).

alter table public.cofrinhos
    add column if not exists pix_key  text check (pix_key  is null or char_length(btrim(pix_key))  between 1 and 100),
    add column if not exists pix_name text check (pix_name is null or char_length(btrim(pix_name)) between 1 and 80),
    add column if not exists pix_bank text check (pix_bank is null or char_length(btrim(pix_bank)) between 1 and 60);

-- Faz a API (PostgREST) enxergar as colunas novas sem esperar o cache expirar.
notify pgrst, 'reload schema';
