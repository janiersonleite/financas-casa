# Resultado de docs/qa/verificacao-favoritos.sql

Executado em Postgres 16 LOCAL (estado de produção reproduzido + migrations de correção + 20261104000001_favorite_entries.sql), pelo teste `tests/db/favorites.test.js` (CI). **Nunca em produção.** Resultado: 33 de 33 casos aprovados.

| # | Caso | Esperado | Obtido | OK |
|---|---|---|---|---|
| 1 | 1. admin cria favorito de SAÍDA com categoria de saída | `ok:1` | `ok:1` | ✅ |
| 2 | 2. (b) mesmo nome no MESMO tipo é rejeitado (ignora caixa e espaços) | `erro:` | `erro:duplicate key value violates unique constraint "favorite_entries_uniq"` | ✅ |
| 3 | 3. (a) mesmo nome em tipo DIFERENTE (entrada) é aceito | `ok:1` | `ok:1` | ✅ |
| 4 | 4. (c) categoria de tipo incompatível (entrada + categoria de saída) é rejeitada | `erro:` | `erro:new row violates row-level security policy for table "favorite_entries"` | ✅ |
| 5 | 5. (c) categoria de tipo incompatível (saída + categoria de entrada) é rejeitada | `erro:` | `erro:new row violates row-level security policy for table "favorite_entries"` | ✅ |
| 6 | 6. categoria "both" é compatível com os dois tipos | `ok:1` | `ok:1` | ✅ |
| 7 | 7. categoria de OUTRA carteira é rejeitada (anti-injeção entre carteiras) | `erro:` | `erro:new row violates row-level security policy for table "favorite_entries"` | ✅ |
| 8 | 8. editar para categoria incompatível é rejeitado | `erro:` | `erro:new row violates row-level security policy for table "favorite_entries"` | ✅ |
| 9 | 9. editar o nome para um já existente no mesmo tipo é rejeitado | `erro:` | `erro:duplicate key value violates unique constraint "favorite_entries_uniq"` | ✅ |
| 10 | 10. (d) tipo NULO é rejeitado | `erro:` | `erro:null value in column "type" of relation "favorite_entries" violates not-null constraint` | ✅ |
| 11 | 11. (d) tipo INVÁLIDO ("xpto") é rejeitado | `erro:` | `erro:new row for relation "favorite_entries" violates check constraint "favorite_entries_type_check"` | ✅ |
| 12 | 12. tipo "both" (válido só em categorias) é rejeitado no favorito | `erro:` | `erro:new row for relation "favorite_entries" violates check constraint "favorite_entries_type_check"` | ✅ |
| 13 | 13. nome vazio é rejeitado | `erro:` | `erro:new row for relation "favorite_entries" violates check constraint "favorite_entries_name_len"` | ✅ |
| 14 | 14. nome com 41 caracteres é rejeitado | `erro:` | `erro:new row for relation "favorite_entries" violates check constraint "favorite_entries_name_len"` | ✅ |
| 15 | 15. nome com 40 caracteres é aceito | `ok:1` | `ok:1` | ✅ |
| 16 | 16. 5º favorito (misturando tipos) é aceito | `ok:1` | `ok:1` | ✅ |
| 17 | 17. 6º favorito é aceito | `ok:1` | `ok:1` | ✅ |
| 18 | 18. (e) 7º favorito (misturando tipos) é rejeitado pelo trigger | `erro:limite de 6` | `erro:limite de 6 favoritos por carteira (entradas e saídas juntas)` | ✅ |
| 19 | 19. o limite conta o TOTAL: o 7º também é rejeitado se for do outro tipo | `erro:limite de 6` | `erro:limite de 6 favoritos por carteira (entradas e saídas juntas)` | ✅ |
| 20 | 20. apagar um libera a vaga (nova inserção volta a ser aceita) | `ok:1` | `ok:1` | ✅ |
| 21 | 21. …e a vaga liberada é aceita | `ok:1` | `ok:1` | ✅ |
| 22 | 22. o limite é POR usuário: o membro B cria o seu 1º favorito na mesma carteira | `ok:1` | `ok:1` | ✅ |
| 23 | 23. B (membro) NÃO lê favoritos de A (só os dele: 1) | `n:1` | `n:1` | ✅ |
| 24 | 24. A vê só os dele (6) | `n:6` | `n:6` | ✅ |
| 25 | 25. B NÃO insere favorito em nome de A (user_id forjado) | `erro:` | `erro:new row violates row-level security policy for table "favorite_entries"` | ✅ |
| 26 | 26. B NÃO edita favorito de A (0 linhas afetadas) | `ok:0` | `ok:0` | ✅ |
| 27 | 27. B NÃO apaga favorito de A (0 linhas afetadas) | `ok:0` | `ok:0` | ✅ |
| 28 | 28. user_id é imutável (A tenta passar o favorito para B) | `erro:` | `erro:favorite_entries.user_id e financa_id não podem ser alterados` | ✅ |
| 29 | 29. financa_id é imutável (A tenta mover o favorito para outra carteira) | `erro:` | `erro:favorite_entries.user_id e financa_id não podem ser alterados` | ✅ |
| 30 | 30. NÃO MEMBRO (D) é barrado ao inserir na carteira F1 | `erro:` | `erro:new row violates row-level security policy for table "favorite_entries"` | ✅ |
| 31 | 31. VISUALIZADOR (C) é barrado ao inserir (papel sem permissão de lançar) | `erro:` | `erro:new row violates row-level security policy for table "favorite_entries"` | ✅ |
| 32 | 32. ANON é negado (sem permissão na tabela) | `erro:` | `erro:permission denied for table favorite_entries` | ✅ |
| 33 | 33. ANON também não insere | `erro:` | `erro:permission denied for table favorite_entries` | ✅ |
