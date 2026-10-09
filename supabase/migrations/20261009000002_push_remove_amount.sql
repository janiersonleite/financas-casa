-- Tira o valor (R$) do texto dos avisos que ainda estão na fila: o valor cadastrado no lembrete é só uma
-- previsão e podia não ser o da conta. Idempotente.
update public.push_queue
   set body = regexp_replace(body, ' — R\$ ?[0-9.,]+$', '')
 where sent_at is null and body ~ ' — R\$ ?[0-9.,]+$';
