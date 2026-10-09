-- Convites: controla o envio do e-mail de convite (limites e "reenviar"). Idempotente.
alter table public.financa_invites
    add column if not exists emailed_at timestamptz,
    add column if not exists email_count integer not null default 0;
