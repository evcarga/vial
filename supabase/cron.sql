-- Tareas programadas de Vial (la clave se lee del Vault, no está en el código)
create or replace function public.vial_llamar_cron(tarea text) returns void
language sql security definer set search_path = public as $$
  select net.http_post(
    url := 'https://yjnlfewsgksdsvsimdjs.supabase.co/functions/v1/vial-cron?tarea=' || tarea,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'vial_cron_key')),
    body := '{}'::jsonb, timeout_milliseconds := 25000) $$;
revoke execute on function public.vial_llamar_cron from public, anon, authenticated;
select cron.schedule('vial-cada-2min', '*/2 * * * *', $$select public.vial_llamar_cron('cada')$$);
select cron.schedule('vial-manana', '30 11 * * *', $$select public.vial_llamar_cron('manana')$$);  -- 06:30 Quito
select cron.schedule('vial-noche', '0 1 * * *', $$select public.vial_llamar_cron('noche')$$);      -- 20:00 Quito
-- Limpieza: reportes vencidos hace más de 60 días
select cron.schedule('vial-limpieza', '0 8 * * *', $$delete from public.vial_reportes where expira < now() - interval '60 days'$$);
