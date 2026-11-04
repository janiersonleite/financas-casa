-- Reverte supabase/migrations/20261104000001_favorite_entries.sql (Onda 1: favoritos).
-- ATENÇÃO: apaga a tabela public.favorite_entries e, portanto, TODOS os favoritos dos usuários. Nenhuma outra tabela é tocada.
drop table if exists public.favorite_entries cascade;               -- policies, índices e triggers saem junto
drop function if exists public.favorite_entries_limit();
drop function if exists public.favorite_entries_lock_keys();
drop function if exists public.can_write_financa(uuid);
