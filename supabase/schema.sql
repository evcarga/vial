-- =====================================================================
-- VIAL (Quito): pico y placa, vencimientos y reportes de la comunidad.
-- Vive en la misma base de EvCarga. Todo dato de este proyecto:
--   * está en tablas con prefijo vial_
--   * lleva la columna proyecto = 'vial'
--   * las fotos van en el bucket "vial"
--   * los usuarios creados desde Vial llevan user_metadata.proyecto = 'vial'
-- La seguridad va en RLS; el frontend solo usa la anon key.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------- Perfiles (solo primer nombre y, si quiere, WhatsApp) ----------
create table if not exists public.vial_perfiles (
  user_id uuid primary key references auth.users on delete cascade,
  nombre text check (char_length(nombre) between 1 and 40),
  whatsapp text check (whatsapp ~ '^[0-9]{9,15}$'),
  telegram_chat_id bigint unique,
  aviso_noche boolean not null default true,
  bloqueado boolean not null default false,
  creado timestamptz not null default now(),
  proyecto text not null default 'vial' check (proyecto = 'vial')
);

-- ---------- Vehículos ----------
create table if not exists public.vial_vehiculos (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  placa text not null check (placa ~ '^[A-Z0-9-]{5,9}$'),
  alias text check (char_length(alias) <= 30),
  marca text check (char_length(marca) <= 30),
  modelo text check (char_length(modelo) <= 30),
  anio int check (anio between 1950 and 2100),
  exento boolean not null default false,          -- declarado por el usuario
  ciudad text not null default 'Quito',
  creado timestamptz not null default now(),
  proyecto text not null default 'vial' check (proyecto = 'vial')
);

-- ---------- Vencimientos ----------
create table if not exists public.vial_vencimientos (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  vehiculo_id bigint references public.vial_vehiculos on delete cascade,
  tipo text not null check (tipo in ('matricula','revision','seguro','licencia','otro')),
  fecha date not null,
  nota text check (char_length(nota) <= 80),
  avisado_15 boolean not null default false,
  avisado_3 boolean not null default false,
  proyecto text not null default 'vial' check (proyecto = 'vial')
);

-- ---------- Reglas de pico y placa y feriados ----------
create table if not exists public.vial_reglas_pico_placa (
  id bigserial primary key,
  ciudad text not null,
  dia int not null check (dia between 1 and 7),   -- 1 = lunes
  digitos int[] not null,
  franjas text not null,                          -- '06:00-09:30,16:00-20:00'
  activo boolean not null default true,
  proyecto text not null default 'vial' check (proyecto = 'vial'),
  unique (ciudad, dia)
);
create table if not exists public.vial_feriados (
  fecha date not null,
  ciudad text not null default 'todas',
  nombre text not null,
  proyecto text not null default 'vial' check (proyecto = 'vial'),
  primary key (fecha, ciudad)
);

-- ---------- Reportes de la comunidad ----------
create table if not exists public.vial_reportes (
  id bigserial primary key,
  user_id uuid default auth.uid() references auth.users on delete set null,
  tipo text not null check (tipo in ('trafico','accidente','control','radar','obra','peligro','varado')),
  lat double precision not null check (lat between -5.1 and 1.7),
  lng double precision not null check (lng between -92.1 and -75.1),
  zona text check (char_length(zona) <= 80),
  descripcion text check (char_length(descripcion) <= 280),
  foto text check (foto ~ '^reportes/[0-9a-f-]{36}/[A-Za-z0-9_-]+\.(webp|jpg)$'),
  creado timestamptz not null default now(),
  expira timestamptz not null default now(),
  confirmaciones int not null default 0,
  negaciones int not null default 0,
  origen text not null default 'app' check (origen in ('app','telegram')),
  telegram_user_id bigint,
  autor text check (char_length(autor) <= 40),     -- primer nombre visible
  oculto boolean not null default false,
  publicado_tg boolean not null default false,
  notificado boolean not null default false,
  proyecto text not null default 'vial' check (proyecto = 'vial')
);
create index if not exists vial_reportes_expira on public.vial_reportes (expira);
create index if not exists vial_reportes_user on public.vial_reportes (user_id, creado);

create table if not exists public.vial_votos (
  reporte_id bigint not null references public.vial_reportes on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  sigue boolean not null,
  creado timestamptz not null default now(),
  proyecto text not null default 'vial' check (proyecto = 'vial'),
  primary key (reporte_id, user_id)
);

-- ---------- Radares fijos (cargados por admin, sugeridos por usuarios) ----------
create table if not exists public.vial_radares (
  id bigserial primary key,
  lat double precision not null check (lat between -5.1 and 1.7),
  lng double precision not null check (lng between -92.1 and -75.1),
  velocidad int check (velocidad between 10 and 130),
  descripcion text check (char_length(descripcion) <= 120),
  aprobado boolean not null default false,
  sugerido_por uuid default auth.uid() references auth.users on delete set null,
  creado timestamptz not null default now(),
  proyecto text not null default 'vial' check (proyecto = 'vial')
);

-- ---------- Zonas de alerta y suscripciones push ----------
create table if not exists public.vial_zonas (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  nombre text not null check (char_length(nombre) between 1 and 30),
  lat double precision not null,
  lng double precision not null,
  radio_m int not null default 2000 check (radio_m between 300 and 20000),
  proyecto text not null default 'vial' check (proyecto = 'vial')
);
create table if not exists public.vial_push (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://'),
  p256dh text not null,
  auth text not null,
  creado timestamptz not null default now(),
  proyecto text not null default 'vial' check (proyecto = 'vial')
);

-- ---------- Versiones de la app Android ----------
create table if not exists public.vial_app_versiones (
  id bigserial primary key,
  version_code int not null unique,
  version_name text not null,
  notas text check (char_length(notas) <= 500),
  obligatoria boolean not null default false,
  estado text not null default 'compilando' check (estado in ('compilando','publicada','fallida')),
  apk_url text,
  notificado boolean not null default false,
  creado timestamptz not null default now(),
  proyecto text not null default 'vial' check (proyecto = 'vial')
);

-- ---------- Tablas internas (solo funciones del servidor) ----------
create table if not exists public.vial_login_intentos (
  identificador text primary key,
  fallos int not null default 0,
  nivel int not null default 0,
  bloqueado_hasta timestamptz,
  actualizado timestamptz not null default now(),
  proyecto text not null default 'vial' check (proyecto = 'vial')
);
create table if not exists public.vial_tg_vinculos (
  codigo text primary key,
  user_id uuid not null references auth.users on delete cascade,
  expira timestamptz not null default now() + interval '15 minutes',
  proyecto text not null default 'vial' check (proyecto = 'vial')
);
create table if not exists public.vial_tg_pendientes (
  telegram_user_id bigint primary key,
  chat_id bigint not null,
  tipo text not null,
  creado timestamptz not null default now(),
  proyecto text not null default 'vial' check (proyecto = 'vial')
);
create table if not exists public.vial_config (
  clave text primary key,
  valor text not null,
  proyecto text not null default 'vial' check (proyecto = 'vial')
);

-- =====================================================================
-- Funciones auxiliares
-- =====================================================================
create or replace function public.vial_duracion(t text) returns interval
language sql immutable as $$
  select case t
    when 'trafico' then interval '45 minutes'
    when 'accidente' then interval '2 hours'
    when 'control' then interval '90 minutes'
    when 'radar' then interval '2 hours'
    when 'obra' then interval '3 days'
    when 'peligro' then interval '6 hours'
    when 'varado' then interval '1 hour'
  end $$;

create or replace function public.vial_km(lat1 float8, lng1 float8, lat2 float8, lng2 float8) returns float8
language sql immutable as $$
  select 2 * 6371 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))) $$;

-- Usuario poco confiable: 3 o más reportes desmentidos en 30 días y más desmentidos que confirmados
create or replace function public.vial_poco_confiable(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select count(*) filter (where negaciones >= 2 and negaciones > confirmaciones) >= 3
       and count(*) filter (where negaciones >= 2 and negaciones > confirmaciones)
         > count(*) filter (where confirmaciones >= 1 and confirmaciones >= negaciones)
    from vial_reportes where user_id = uid and creado > now() - interval '30 days'), false) $$;

-- Antes de insertar un reporte: expiración por tipo, límites y anti-spam
create or replace function public.vial_reporte_antes() returns trigger
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n int;
begin
  new.creado := now();
  new.expira := now() + vial_duracion(new.tipo);
  new.confirmaciones := 0; new.negaciones := 0;
  new.publicado_tg := false; new.notificado := false;
  if coalesce(auth.role(), '') <> 'service_role' then
    if uid is null then raise exception 'Inicia sesión para reportar'; end if;
    new.user_id := uid; new.origen := 'app'; new.telegram_user_id := null; new.oculto := false;
    if exists (select 1 from vial_perfiles where user_id = uid and bloqueado) then
      raise exception 'Tu cuenta está bloqueada para reportar';
    end if;
    select count(*) into n from vial_reportes where user_id = uid and creado > now() - interval '1 hour';
    if n >= 5 then raise exception 'Máximo 5 reportes por hora. Intenta más tarde.'; end if;
    select nombre into new.autor from vial_perfiles where user_id = uid;
  end if;
  if new.user_id is not null and vial_poco_confiable(new.user_id) then new.oculto := true; end if;
  return new;
end $$;
drop trigger if exists vial_reporte_antes on public.vial_reportes;
create trigger vial_reporte_antes before insert on public.vial_reportes
  for each row execute function public.vial_reporte_antes();

-- "¿Sigue ahí?": confirmar o desmentir (cerca del reporte)
create or replace function public.vial_votar(p_reporte bigint, p_sigue boolean, p_lat float8, p_lng float8)
returns json language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); r vial_reportes;
begin
  if uid is null then raise exception 'Inicia sesión para votar'; end if;
  if exists (select 1 from vial_perfiles where user_id = uid and bloqueado) then raise exception 'Cuenta bloqueada'; end if;
  select * into r from vial_reportes where id = p_reporte and expira > now() and not oculto;
  if not found then raise exception 'El reporte ya no está activo'; end if;
  if r.user_id = uid then raise exception 'No puedes votar tu propio reporte'; end if;
  if p_lat is null or vial_km(p_lat, p_lng, r.lat, r.lng) > 3 then
    raise exception 'Debes estar a menos de 3 km del reporte para confirmarlo';
  end if;
  insert into vial_votos (reporte_id, user_id, sigue) values (p_reporte, uid, p_sigue)
    on conflict (reporte_id, user_id) do update set sigue = excluded.sigue, creado = now();
  update vial_reportes set
    confirmaciones = (select count(*) from vial_votos where reporte_id = p_reporte and sigue),
    negaciones = (select count(*) from vial_votos where reporte_id = p_reporte and not sigue)
  where id = p_reporte returning * into r;
  if r.negaciones >= 2 and r.negaciones > r.confirmaciones then
    update vial_reportes set expira = now() where id = p_reporte;          -- se borra del mapa
  elsif p_sigue and r.tipo <> 'obra' then
    update vial_reportes set expira = greatest(expira, now() + vial_duracion(tipo) / 2) where id = p_reporte;
  end if;
  return json_build_object('confirmaciones', r.confirmaciones, 'negaciones', r.negaciones);
end $$;

-- Ranking semanal (solo primer nombre)
create or replace function public.vial_ranking() returns table (nombre text, puntos int, reportes int)
language sql stable security definer set search_path = public as $$
  with r as (
    select user_id, case when negaciones >= 2 and negaciones > confirmaciones then 0
                         else 2 + 5 * least(confirmaciones, 5) end pts
    from vial_reportes where user_id is not null and creado > now() - interval '7 days'
  ), v as (
    select user_id, count(*) pts from vial_votos where creado > now() - interval '7 days' group by 1
  ), t as (
    select user_id, sum(pts) pts, count(*) n from r group by 1
  )
  select coalesce(p.nombre, 'Anónimo'), (coalesce(t.pts, 0) + coalesce(v.pts, 0))::int, coalesce(t.n, 0)::int
  from t full join v using (user_id) left join vial_perfiles p using (user_id)
  where not coalesce(p.bloqueado, false)
  order by 2 desc limit 20 $$;

-- Código de un solo uso para vincular Telegram
create or replace function public.vial_codigo_telegram() returns text
language plpgsql security definer set search_path = public as $$
declare c text := upper(substr(md5(gen_random_uuid()::text), 1, 8));
begin
  if auth.uid() is null then raise exception 'Inicia sesión'; end if;
  delete from vial_tg_vinculos where user_id = auth.uid() or expira < now();
  insert into vial_tg_vinculos (codigo, user_id) values (c, auth.uid());
  return c;
end $$;

-- Máximo 5 zonas y 6 vehículos por usuario
create or replace function public.vial_limite() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  execute format('select count(*) from %I where user_id = $1', tg_table_name) into n using new.user_id;
  if n >= tg_argv[0]::int then raise exception 'Límite alcanzado (%)', tg_argv[0]; end if;
  return new;
end $$;
drop trigger if exists vial_limite on public.vial_zonas;
create trigger vial_limite before insert on public.vial_zonas for each row execute function public.vial_limite('5');
drop trigger if exists vial_limite on public.vial_vehiculos;
create trigger vial_limite before insert on public.vial_vehiculos for each row execute function public.vial_limite('6');
drop trigger if exists vial_limite on public.vial_push;
create trigger vial_limite before insert on public.vial_push for each row execute function public.vial_limite('5');

-- Lista de usuarios para el admin (sin datos de más)
create or replace function public.vial_admin_usuarios() returns table
  (user_id uuid, nombre text, contacto text, bloqueado boolean, reportes bigint, creado timestamptz)
language sql stable security definer set search_path = public as $$
  select p.user_id, p.nombre,
         coalesce(case when u.email like '%@wa.vial.evcarga' then '+' || p.whatsapp end, u.email),
         p.bloqueado, (select count(*) from vial_reportes r where r.user_id = p.user_id), p.creado
  from vial_perfiles p join auth.users u on u.id = p.user_id
  where is_admin() order by p.creado desc limit 300 $$;

-- =====================================================================
-- RLS y permisos
-- =====================================================================
do $$ declare t text; begin
  foreach t in array array['vial_perfiles','vial_vehiculos','vial_vencimientos','vial_reglas_pico_placa','vial_feriados',
    'vial_reportes','vial_votos','vial_radares','vial_zonas','vial_push','vial_app_versiones','vial_login_intentos',
    'vial_tg_vinculos','vial_tg_pendientes','vial_config'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Perfiles: cada uno el suyo; admin todos
drop policy if exists vp_sel on public.vial_perfiles;
create policy vp_sel on public.vial_perfiles for select to authenticated using (user_id = auth.uid() or is_admin());
drop policy if exists vp_ins on public.vial_perfiles;
create policy vp_ins on public.vial_perfiles for insert to authenticated with check (user_id = auth.uid());
drop policy if exists vp_upd on public.vial_perfiles;
create policy vp_upd on public.vial_perfiles for update to authenticated using (user_id = auth.uid() or is_admin());
grant select on public.vial_perfiles to authenticated;
grant insert (user_id, nombre, aviso_noche) on public.vial_perfiles to authenticated;
grant update (nombre, aviso_noche, telegram_chat_id) on public.vial_perfiles to authenticated;
-- bloquear solo admin (columna aparte con política propia vía función)
create or replace function public.vial_admin_bloquear(p_user uuid, p_bloq boolean) returns void
language sql security definer set search_path = public as $$
  update vial_perfiles set bloqueado = p_bloq where user_id = p_user and is_admin() $$;
-- El usuario solo puede borrar su telegram_chat_id (no poner uno ajeno)
create or replace function public.vial_perfil_guard() returns trigger
language plpgsql as $$ begin
  if coalesce(auth.role(), '') <> 'service_role' and new.telegram_chat_id is not null
     and new.telegram_chat_id is distinct from old.telegram_chat_id then
    raise exception 'No permitido';
  end if;
  return new; end $$;
drop trigger if exists vial_perfil_guard on public.vial_perfiles;
create trigger vial_perfil_guard before update on public.vial_perfiles for each row execute function public.vial_perfil_guard();

-- Vehículos, vencimientos, zonas, push: solo el dueño
do $$ declare t text; begin
  foreach t in array array['vial_vehiculos','vial_vencimientos','vial_zonas','vial_push'] loop
    execute format('drop policy if exists own on public.%I', t);
    execute format('create policy own on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant usage on sequence public.%I_id_seq to authenticated', t);
  end loop;
end $$;
revoke update on public.vial_vencimientos from authenticated;
grant update (vehiculo_id, tipo, fecha, nota) on public.vial_vencimientos to authenticated;

-- Reglas y feriados: lectura pública, escritura admin
do $$ declare t text; begin
  foreach t in array array['vial_reglas_pico_placa','vial_feriados','vial_app_versiones'] loop
    execute format('drop policy if exists leer on public.%I', t);
    execute format('create policy leer on public.%I for select to anon, authenticated using (true)', t);
    execute format('drop policy if exists admin on public.%I', t);
    execute format('create policy admin on public.%I for all to authenticated using (is_admin()) with check (is_admin())', t);
    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('grant insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
grant usage on sequence public.vial_reglas_pico_placa_id_seq to authenticated;

-- Reportes: ver sin sesión; reportar con sesión; editar foto/comentario los primeros 15 min
drop policy if exists vr_sel on public.vial_reportes;
create policy vr_sel on public.vial_reportes for select to anon, authenticated
  using ((not oculto and expira > now()) or user_id = auth.uid() or is_admin());
drop policy if exists vr_ins on public.vial_reportes;
create policy vr_ins on public.vial_reportes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists vr_upd on public.vial_reportes;
create policy vr_upd on public.vial_reportes for update to authenticated
  using ((user_id = auth.uid() and creado > now() - interval '15 minutes') or is_admin());
drop policy if exists vr_del on public.vial_reportes;
create policy vr_del on public.vial_reportes for delete to authenticated using (user_id = auth.uid() or is_admin());
grant select (id, tipo, lat, lng, zona, descripcion, foto, creado, expira, confirmaciones, negaciones, origen, autor, user_id, oculto)
  on public.vial_reportes to anon, authenticated;
grant insert (tipo, lat, lng, zona, descripcion, foto) on public.vial_reportes to authenticated;
grant update (descripcion, foto) on public.vial_reportes to authenticated;
grant delete on public.vial_reportes to authenticated;
grant usage on sequence public.vial_reportes_id_seq to authenticated;
-- Ocultar / restaurar: solo admin
create or replace function public.vial_admin_ocultar(p_reporte bigint, p_oculto boolean) returns void
language sql security definer set search_path = public as $$
  update vial_reportes set oculto = p_oculto where id = p_reporte and is_admin() $$;

-- Votos: cada uno ve los suyos (se crean solo con vial_votar)
drop policy if exists vv_sel on public.vial_votos;
create policy vv_sel on public.vial_votos for select to authenticated using (user_id = auth.uid());
grant select on public.vial_votos to authenticated;

-- Radares: ver aprobados; sugerir con sesión; admin aprueba
drop policy if exists vra_sel on public.vial_radares;
create policy vra_sel on public.vial_radares for select to anon, authenticated
  using (aprobado or sugerido_por = auth.uid() or is_admin());
drop policy if exists vra_ins on public.vial_radares;
create policy vra_ins on public.vial_radares for insert to authenticated
  with check (sugerido_por = auth.uid() and (not aprobado or is_admin()));
drop policy if exists vra_adm on public.vial_radares;
create policy vra_adm on public.vial_radares for update to authenticated using (is_admin());
drop policy if exists vra_del on public.vial_radares;
create policy vra_del on public.vial_radares for delete to authenticated using (is_admin() or (sugerido_por = auth.uid() and not aprobado));
grant select on public.vial_radares to anon, authenticated;
grant insert (lat, lng, velocidad, descripcion, aprobado) on public.vial_radares to authenticated;
grant update (aprobado, velocidad, descripcion) on public.vial_radares to authenticated;
grant delete on public.vial_radares to authenticated;
grant usage on sequence public.vial_radares_id_seq to authenticated;

-- Funciones expuestas
revoke execute on function public.vial_votar, public.vial_codigo_telegram, public.vial_admin_usuarios,
  public.vial_admin_bloquear, public.vial_admin_ocultar, public.vial_poco_confiable from public, anon;
grant execute on function public.vial_votar, public.vial_codigo_telegram, public.vial_admin_usuarios,
  public.vial_admin_bloquear, public.vial_admin_ocultar to authenticated;
grant execute on function public.vial_ranking to anon, authenticated;

-- Realtime para que los reportes aparezcan al instante
do $$ begin
  alter publication supabase_realtime add table public.vial_reportes;
exception when duplicate_object then null; end $$;

-- =====================================================================
-- Fotos: bucket "vial" (WebP/JPG, máx. 2 MB, carpeta del usuario)
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vial', 'vial', true, 2097152, array['image/webp','image/jpeg'])
on conflict (id) do update set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/webp','image/jpeg'];
drop policy if exists vial_fotos_subir on storage.objects;
create policy vial_fotos_subir on storage.objects for insert to authenticated
  with check (bucket_id = 'vial' and (storage.foldername(name))[1] = 'reportes'
              and (storage.foldername(name))[2] = auth.uid()::text);
drop policy if exists vial_fotos_borrar on storage.objects;
create policy vial_fotos_borrar on storage.objects for delete to authenticated
  using (bucket_id = 'vial' and ((storage.foldername(name))[2] = auth.uid()::text or is_admin()));

-- =====================================================================
-- Datos iniciales: pico y placa de Quito (lunes a viernes)
-- =====================================================================
insert into public.vial_reglas_pico_placa (ciudad, dia, digitos, franjas) values
  ('Quito', 1, '{1,2}', '06:00-09:30,16:00-20:00'),
  ('Quito', 2, '{3,4}', '06:00-09:30,16:00-20:00'),
  ('Quito', 3, '{5,6}', '06:00-09:30,16:00-20:00'),
  ('Quito', 4, '{7,8}', '06:00-09:30,16:00-20:00'),
  ('Quito', 5, '{9,0}', '06:00-09:30,16:00-20:00')
on conflict (ciudad, dia) do nothing;
insert into public.vial_feriados (fecha, ciudad, nombre) values
  ('2026-12-25', 'todas', 'Navidad')
on conflict do nothing;

-- Configuración pública (usuario del bot de Telegram, etc.): lectura pública, escritura admin
drop policy if exists leer on public.vial_config;
create policy leer on public.vial_config for select to anon, authenticated using (clave in ('telegram_bot','telegram_grupo'));
drop policy if exists admin on public.vial_config;
create policy admin on public.vial_config for all to authenticated using (is_admin()) with check (is_admin());
grant select on public.vial_config to anon, authenticated;
grant insert, update, delete on public.vial_config to authenticated;
