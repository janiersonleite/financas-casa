-- Verificação da migration 20261104000001_favorite_entries.sql (favoritos). SOMENTE em banco LOCAL ou BRANCH de teste — NUNCA em produção.
-- Cria usuários/carteiras/categorias FICTÍCIOS (UUIDs 00000000-…), roda 33 casos e devolve a tabela de resultado (coluna ok = true em todos).
-- Tudo fica numa transação aberta: depois de ler o resultado, execute  ROLLBACK;  (o teste automático tests/db/favorites.test.js faz isso).
-- Papéis: A = dono/admin da carteira F1 · B = membro · C = visualizador · D = estranho (não participa) · F2 = carteira do D.
begin;
create temp table _r (n serial, caso text, esperado text, obtido text, ok boolean);

-- ── fixtures (como superusuário) ──────────────────────────────────────────────────────────────────────────────────────────
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@teste.com'), ('00000000-0000-0000-0000-0000000000b1', 'b@teste.com'),
  ('00000000-0000-0000-0000-0000000000c1', 'c@teste.com'), ('00000000-0000-0000-0000-0000000000d1', 'd@teste.com');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
insert into public.financas(id, name, type) values ('00000000-0000-0000-0000-0000000000f1', 'F1 (do A)', 'compartilhada');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
insert into public.financas(id, name, type) values ('00000000-0000-0000-0000-0000000000f2', 'F2 (do D)', 'compartilhada');
select set_config('request.jwt.claim.sub', '', true);
insert into public.financa_members(financa_id, user_id, email, role) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'a@teste.com', 'admin'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'b@teste.com', 'membro'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1', 'c@teste.com', 'visualizador');
insert into public.categories(id, user_id, financa_id, name, emoji, type) values
  ('00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'Mercado',  '🛒', 'saida'),
  ('00000000-0000-0000-0000-00000000ca02', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'Salário',  '💰', 'entrada'),
  ('00000000-0000-0000-0000-00000000ca03', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'Outros',   '📦', 'both'),
  ('00000000-0000-0000-0000-00000000ca04', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f2', 'Do D',     '📦', 'saida');

-- ── ajudantes (rodam a consulta COMO o usuário/papel, sem derrubar a transação) ─────────────────────────────────────────────
create function pg_temp.tenta(uid uuid, rl text, q text) returns text language plpgsql as $f$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  perform set_config('request.jwt.claim.role', rl, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', rl)::text, true);
  execute format('set local role %I', rl);
  begin
    execute q; get diagnostics n = row_count; reset role; return 'ok:' || n;
  exception when others then reset role; return 'erro:' || sqlerrm;
  end;
end $f$;
create function pg_temp.conta(uid uuid, rl text, q text) returns text language plpgsql as $f$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  perform set_config('request.jwt.claim.role', rl, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', rl)::text, true);
  execute format('set local role %I', rl);
  begin
    execute 'select count(*) from (' || q || ') s' into n; reset role; return 'n:' || n;
  exception when others then reset role; return 'erro:' || sqlerrm;
  end;
end $f$;
create function pg_temp.caso(descricao text, esperado text, obtido text) returns void language sql as $f$
  insert into _r(caso, esperado, obtido, ok) values (descricao, esperado, obtido, obtido like esperado || '%');
$f$;

-- ── casos ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
select pg_temp.caso('1. admin cria favorito de SAÍDA com categoria de saída', 'ok:1', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type, category_id, position) values ('00000000-0000-0000-0000-0000000000f1', 'Mercado', 'saida', '00000000-0000-0000-0000-00000000ca01', 1)$q$));
select pg_temp.caso('2. (b) mesmo nome no MESMO tipo é rejeitado (ignora caixa e espaços)', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type) values ('00000000-0000-0000-0000-0000000000f1', '  mercado ', 'saida')$q$));
select pg_temp.caso('3. (a) mesmo nome em tipo DIFERENTE (entrada) é aceito', 'ok:1', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type, category_id, position) values ('00000000-0000-0000-0000-0000000000f1', 'Mercado', 'entrada', '00000000-0000-0000-0000-00000000ca02', 2)$q$));
select pg_temp.caso('4. (c) categoria de tipo incompatível (entrada + categoria de saída) é rejeitada', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type, category_id) values ('00000000-0000-0000-0000-0000000000f1', 'Incompat 1', 'entrada', '00000000-0000-0000-0000-00000000ca01')$q$));
select pg_temp.caso('5. (c) categoria de tipo incompatível (saída + categoria de entrada) é rejeitada', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type, category_id) values ('00000000-0000-0000-0000-0000000000f1', 'Incompat 2', 'saida', '00000000-0000-0000-0000-00000000ca02')$q$));
select pg_temp.caso('6. categoria "both" é compatível com os dois tipos', 'ok:1', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type, category_id, position) values ('00000000-0000-0000-0000-0000000000f1', 'Diversos', 'entrada', '00000000-0000-0000-0000-00000000ca03', 3)$q$));
select pg_temp.caso('7. categoria de OUTRA carteira é rejeitada (anti-injeção entre carteiras)', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type, category_id) values ('00000000-0000-0000-0000-0000000000f1', 'De outra', 'saida', '00000000-0000-0000-0000-00000000ca04')$q$));
select pg_temp.caso('8. editar para categoria incompatível é rejeitado', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$update public.favorite_entries set category_id = '00000000-0000-0000-0000-00000000ca01' where name = 'Diversos' and type = 'entrada'$q$));
select pg_temp.caso('9. editar o nome para um já existente no mesmo tipo é rejeitado', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$update public.favorite_entries set name = 'MERCADO' where name = 'Diversos' and type = 'entrada'$q$));
select pg_temp.caso('10. (d) tipo NULO é rejeitado', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type) values ('00000000-0000-0000-0000-0000000000f1', 'Sem tipo', null)$q$));
select pg_temp.caso('11. (d) tipo INVÁLIDO ("xpto") é rejeitado', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type) values ('00000000-0000-0000-0000-0000000000f1', 'Tipo ruim', 'xpto')$q$));
select pg_temp.caso('12. tipo "both" (válido só em categorias) é rejeitado no favorito', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type) values ('00000000-0000-0000-0000-0000000000f1', 'Both', 'both')$q$));
select pg_temp.caso('13. nome vazio é rejeitado', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type) values ('00000000-0000-0000-0000-0000000000f1', '   ', 'saida')$q$));
select pg_temp.caso('14. nome com 41 caracteres é rejeitado', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  format($q$insert into public.favorite_entries(financa_id, name, type) values ('00000000-0000-0000-0000-0000000000f1', %L, 'saida')$q$, repeat('x', 41))));
select pg_temp.caso('15. nome com 40 caracteres é aceito', 'ok:1', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  format($q$insert into public.favorite_entries(financa_id, name, type, position) values ('00000000-0000-0000-0000-0000000000f1', %L, 'saida', 4)$q$, repeat('y', 40))));
select pg_temp.caso('16. 5º favorito (misturando tipos) é aceito', 'ok:1', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type, position) values ('00000000-0000-0000-0000-0000000000f1', 'Quinto', 'entrada', 5)$q$));
select pg_temp.caso('17. 6º favorito é aceito', 'ok:1', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type, position) values ('00000000-0000-0000-0000-0000000000f1', 'Sexto', 'saida', 6)$q$));
select pg_temp.caso('18. (e) 7º favorito (misturando tipos) é rejeitado pelo trigger', 'erro:limite de 6', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type, position) values ('00000000-0000-0000-0000-0000000000f1', 'Setimo', 'entrada', 7)$q$));
select pg_temp.caso('19. o limite conta o TOTAL: o 7º também é rejeitado se for do outro tipo', 'erro:limite de 6', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type, position) values ('00000000-0000-0000-0000-0000000000f1', 'Setimo', 'saida', 7)$q$));
select pg_temp.caso('20. apagar um libera a vaga (nova inserção volta a ser aceita)', 'ok:1', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$delete from public.favorite_entries where name = 'Sexto'$q$) || '' );
select pg_temp.caso('21. …e a vaga liberada é aceita', 'ok:1', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type, position) values ('00000000-0000-0000-0000-0000000000f1', 'Novo sexto', 'entrada', 6)$q$));
select pg_temp.caso('22. o limite é POR usuário: o membro B cria o seu 1º favorito na mesma carteira', 'ok:1', pg_temp.tenta('00000000-0000-0000-0000-0000000000b1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type) values ('00000000-0000-0000-0000-0000000000f1', 'Mercado', 'saida')$q$));
select pg_temp.caso('23. B (membro) NÃO lê favoritos de A (só os dele: 1)', 'n:1', pg_temp.conta('00000000-0000-0000-0000-0000000000b1', 'authenticated', $q$select 1 from public.favorite_entries$q$));
select pg_temp.caso('24. A vê só os dele (6)', 'n:6', pg_temp.conta('00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select 1 from public.favorite_entries$q$));
select pg_temp.caso('25. B NÃO insere favorito em nome de A (user_id forjado)', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000b1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, user_id, name, type) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'Forjado', 'saida')$q$));
select pg_temp.caso('26. B NÃO edita favorito de A (0 linhas afetadas)', 'ok:0', pg_temp.tenta('00000000-0000-0000-0000-0000000000b1', 'authenticated',
  $q$update public.favorite_entries set name = 'Hackeado' where user_id = '00000000-0000-0000-0000-0000000000a1'$q$));
select pg_temp.caso('27. B NÃO apaga favorito de A (0 linhas afetadas)', 'ok:0', pg_temp.tenta('00000000-0000-0000-0000-0000000000b1', 'authenticated',
  $q$delete from public.favorite_entries where user_id = '00000000-0000-0000-0000-0000000000a1'$q$));
select pg_temp.caso('28. user_id é imutável (A tenta passar o favorito para B)', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$update public.favorite_entries set user_id = '00000000-0000-0000-0000-0000000000b1' where name = 'Mercado' and type = 'saida'$q$));
select pg_temp.caso('29. financa_id é imutável (A tenta mover o favorito para outra carteira)', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000a1', 'authenticated',
  $q$update public.favorite_entries set financa_id = '00000000-0000-0000-0000-0000000000f2' where name = 'Mercado' and type = 'saida'$q$));
select pg_temp.caso('30. NÃO MEMBRO (D) é barrado ao inserir na carteira F1', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000d1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type) values ('00000000-0000-0000-0000-0000000000f1', 'Intruso', 'saida')$q$));
select pg_temp.caso('31. VISUALIZADOR (C) é barrado ao inserir (papel sem permissão de lançar)', 'erro:', pg_temp.tenta('00000000-0000-0000-0000-0000000000c1', 'authenticated',
  $q$insert into public.favorite_entries(financa_id, name, type) values ('00000000-0000-0000-0000-0000000000f1', 'Visual', 'saida')$q$));
select pg_temp.caso('32. ANON é negado (sem permissão na tabela)', 'erro:', pg_temp.tenta(null, 'anon', $q$select * from public.favorite_entries$q$));
select pg_temp.caso('33. ANON também não insere', 'erro:', pg_temp.tenta(null, 'anon',
  $q$insert into public.favorite_entries(financa_id, user_id, name, type) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'Anon', 'saida')$q$));

select n, caso, esperado, obtido, ok from _r order by n;
-- (resumo) select count(*) filter (where ok) as aprovados, count(*) filter (where not ok) as reprovados from _r;
-- Agora execute:  ROLLBACK;
