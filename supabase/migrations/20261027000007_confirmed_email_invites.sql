-- [A6 / F9 / SEC-02] Convites só valem para e-mail CONFIRMADO (auth.users.email_confirmed_at não nulo).
--
-- SEVERIDADE BAIXA em produção: "Confirm email" está LIGADO no Supabase Auth (verificado em 26/10), então ninguém
-- consegue sessão com e-mail alheio sem confirmar. Esta checagem em SQL é DEFESA EM PROFUNDIDADE caso a opção seja desligada.
--
-- O QUE CORRIGE
--   auto_accept_my_invites, get_my_pending_invites e my_invite_email_matches (usada pela policy de leitura de convites) não
--   checavam email_confirmed_at. accept_invite (20261027000001) já checa. add_member_by_email NÃO foi alterada.
--
-- O QUE PODE QUEBRAR: usuário com email_confirmed_at NULL não vê/aceita convites até confirmar (com "Confirm email" ligado
--   isso não existe em produção). Assinaturas das funções idênticas (create or replace).
-- COMO REVERTER: reaplicar as definições de 20260423000010_fix_invites_rls.sql e 20260423000011_robust_members.sql.

create or replace function public.my_invite_email_matches(inv_email text)
returns boolean language plpgsql security definer set search_path = public, auth as $$
declare v_email text; v_conf timestamptz;
begin
    select email, email_confirmed_at into v_email, v_conf from auth.users where id = auth.uid();
    return v_conf is not null and lower(inv_email) = lower(coalesce(v_email, ''));
end $$;

create or replace function public.get_my_pending_invites()
returns table (
    id uuid, financa_id uuid, email varchar, role varchar, invited_by uuid,
    accepted_at timestamptz, expires_at timestamptz, created_at timestamptz,
    financa_name text, financa_emoji text
)
language plpgsql security definer set search_path = public, auth as $$
declare v_email text; v_conf timestamptz;
begin
    select u.email, u.email_confirmed_at into v_email, v_conf from auth.users u where u.id = auth.uid();
    if v_email is null or v_conf is null then return; end if;

    return query
        select i.id, i.financa_id, i.email, i.role, i.invited_by,
               i.accepted_at, i.expires_at, i.created_at,
               f.name::text as financa_name, f.emoji::text as financa_emoji
          from public.financa_invites i
          join public.financas f on f.id = i.financa_id
         where lower(i.email) = lower(v_email)
           and i.accepted_at is null
           and (i.expires_at is null or i.expires_at > now());
end $$;

create or replace function public.auto_accept_my_invites()
returns integer language plpgsql security definer set search_path = public, auth as $$
declare v_email text; v_conf timestamptz; v_count integer := 0; rec record;
begin
    select email, email_confirmed_at into v_email, v_conf from auth.users where id = auth.uid();
    if v_email is null or v_conf is null then return 0; end if;

    for rec in
        select id, financa_id, role from public.financa_invites
         where lower(email) = lower(v_email) and accepted_at is null
           and (expires_at is null or expires_at > now())
    loop
        insert into public.financa_members (financa_id, user_id, email, role)
        values (rec.financa_id, auth.uid(), v_email, rec.role)
        on conflict (financa_id, user_id) do nothing;

        update public.financa_invites set accepted_at = now() where id = rec.id;
        v_count := v_count + 1;
    end loop;
    return v_count;
end $$;
