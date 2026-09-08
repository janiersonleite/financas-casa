-- Notificação de lembretes com horário e data única (pontual).
--   notify_time: horário do dia (HH:MM) em que a notificação deve tocar.
--   notify_date: quando preenchido, o lembrete é PONTUAL (dispara uma vez
--                nessa data). Quando nulo, o lembrete é recorrente por `day`.
alter table public.reminders
    add column if not exists notify_time text,
    add column if not exists notify_date date;
