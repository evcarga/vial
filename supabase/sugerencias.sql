-- Sugerencias de los usuarios (con o sin cuenta). WhatsApp opcional, solo si quieren ser contactados.
create table if not exists public.vial_sugerencias (
  id bigserial primary key,
  user_id uuid default auth.uid() references auth.users on delete set null,
  mensaje text not null check (char_length(mensaje) between 3 and 1000),
  nombre text check (char_length(nombre) <= 40),
  whatsapp text check (whatsapp ~ '^[0-9+ ]{9,16}$'),
  leida boolean not null default false,
  creado timestamptz not null default now(),
  proyecto text not null default 'vial' check (proyecto = 'vial')
);
alter table public.vial_sugerencias enable row level security;
revoke all on public.vial_sugerencias from anon, authenticated;
drop policy if exists enviar on public.vial_sugerencias;
create policy enviar on public.vial_sugerencias for insert to anon, authenticated
  with check (user_id is not distinct from auth.uid());
drop policy if exists admin on public.vial_sugerencias;
create policy admin on public.vial_sugerencias for all to authenticated using (is_admin()) with check (is_admin());
grant insert (mensaje, nombre, whatsapp) on public.vial_sugerencias to anon, authenticated;
grant select, update (leida), delete on public.vial_sugerencias to authenticated;
grant usage on sequence public.vial_sugerencias_id_seq to anon, authenticated;
-- Anti-spam: 3 por hora por usuario; 30 por hora en total sin cuenta
create or replace function public.vial_sugerencia_antes() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  new.user_id := auth.uid(); new.leida := false; new.creado := now();
  if new.user_id is not null then
    select count(*) into n from vial_sugerencias where user_id = new.user_id and creado > now() - interval '1 hour';
    if n >= 3 then raise exception 'Gracias, ya recibimos tus sugerencias. Intenta más tarde.'; end if;
  else
    select count(*) into n from vial_sugerencias where user_id is null and creado > now() - interval '1 hour';
    if n >= 30 then raise exception 'Muchas sugerencias por ahora. Intenta más tarde.'; end if;
  end if;
  return new;
end $$;
drop trigger if exists vial_sugerencia_antes on public.vial_sugerencias;
create trigger vial_sugerencia_antes before insert on public.vial_sugerencias for each row execute function public.vial_sugerencia_antes();
