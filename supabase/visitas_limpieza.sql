-- =====================================================================
-- Visitas (web / app) y origen del registro de usuarios
-- =====================================================================
create table if not exists public.vial_visitas (
  id bigserial primary key,
  creado timestamptz not null default now(),
  origen text not null check (origen in ('web','app','pwa')),
  visitante uuid not null,                 -- id aleatorio del dispositivo (no es dato personal)
  user_id uuid default auth.uid() references auth.users on delete set null,
  pagina text check (char_length(pagina) <= 60),
  proyecto text not null default 'vial' check (proyecto = 'vial')
);
create index if not exists vial_visitas_creado on public.vial_visitas (creado);
alter table public.vial_visitas enable row level security;
revoke all on public.vial_visitas from anon, authenticated;
drop policy if exists registrar on public.vial_visitas;
create policy registrar on public.vial_visitas for insert to anon, authenticated with check (user_id is not distinct from auth.uid());
grant insert (origen, visitante, pagina) on public.vial_visitas to anon, authenticated;
grant usage on sequence public.vial_visitas_id_seq to anon, authenticated;
-- Anti-spam: máximo 1 visita cada 10 min por dispositivo
create or replace function public.vial_visita_antes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.user_id := auth.uid(); new.creado := now();
  if exists (select 1 from vial_visitas where visitante = new.visitante and creado > now() - interval '10 minutes') then
    return null;   -- se ignora en silencio
  end if;
  return new;
end $$;
drop trigger if exists vial_visita_antes on public.vial_visitas;
create trigger vial_visita_antes before insert on public.vial_visitas for each row execute function public.vial_visita_antes();

alter table public.vial_perfiles add column if not exists origen text check (origen in ('web','app','pwa'));
grant insert (user_id, nombre, aviso_noche, origen) on public.vial_perfiles to authenticated;

-- =====================================================================
-- Reportes: se borran a las 24 h. Antes se guardan los puntos y la
-- confiabilidad para que el ranking semanal y el anti-spam no se pierdan.
-- =====================================================================
create table if not exists public.vial_puntos (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  puntos int not null,
  motivo text not null check (motivo in ('reporte','voto')),
  confirmado boolean not null default false,
  desmentido boolean not null default false,
  creado timestamptz not null,
  proyecto text not null default 'vial' check (proyecto = 'vial')
);
create index if not exists vial_puntos_user on public.vial_puntos (user_id, creado);
alter table public.vial_puntos enable row level security;
revoke all on public.vial_puntos from anon, authenticated;

-- Obra: también dura como máximo 1 día
create or replace function public.vial_duracion(t text) returns interval
language sql immutable as $$
  select case t
    when 'trafico' then interval '45 minutes'
    when 'accidente' then interval '2 hours'
    when 'control' then interval '90 minutes'
    when 'radar' then interval '2 hours'
    when 'obra' then interval '23 hours'
    when 'peligro' then interval '6 hours'
    when 'varado' then interval '1 hour'
  end $$;
update public.vial_reportes set expira = least(expira, creado + interval '23 hours');

-- Devuelve las fotos a borrar y elimina los reportes de más de 24 h
create or replace function public.vial_limpiar_reportes() returns text[]
language plpgsql security definer set search_path = public as $$
declare fotos text[];
begin
  with viejos as (select * from vial_reportes where creado < now() - interval '24 hours')
  insert into vial_puntos (user_id, puntos, motivo, confirmado, desmentido, creado)
  select user_id,
         case when negaciones >= 2 and negaciones > confirmaciones then 0 else 2 + 5 * least(confirmaciones, 5) end,
         'reporte', confirmaciones >= 1 and confirmaciones >= negaciones, negaciones >= 2 and negaciones > confirmaciones, creado
  from viejos where user_id is not null;
  insert into vial_puntos (user_id, puntos, motivo, creado)
  select v.user_id, 1, 'voto', v.creado from vial_votos v join vial_reportes r on r.id = v.reporte_id
  where r.creado < now() - interval '24 hours';
  select coalesce(array_agg(foto) filter (where foto is not null), '{}') into fotos
  from vial_reportes where creado < now() - interval '24 hours';
  delete from vial_reportes where creado < now() - interval '24 hours';
  delete from vial_puntos where creado < now() - interval '60 days';
  return fotos;
end $$;
revoke execute on function public.vial_limpiar_reportes from public, anon, authenticated;

-- Ranking semanal: reportes vivos + puntos guardados
create or replace function public.vial_ranking() returns table (nombre text, puntos int, reportes int)
language sql stable security definer set search_path = public as $$
  with p as (
    select user_id, case when negaciones >= 2 and negaciones > confirmaciones then 0 else 2 + 5 * least(confirmaciones, 5) end pts, 1 n
    from vial_reportes where user_id is not null and creado > now() - interval '7 days'
    union all
    select user_id, 1, 0 from vial_votos where creado > now() - interval '7 days'
    union all
    select user_id, puntos, (motivo = 'reporte')::int from vial_puntos where creado > now() - interval '7 days'
  )
  select coalesce(pf.nombre, 'Anónimo'), sum(p.pts)::int, sum(p.n)::int
  from p left join vial_perfiles pf using (user_id)
  where not coalesce(pf.bloqueado, false)
  group by pf.nombre, p.user_id order by 2 desc limit 20 $$;

-- Confiabilidad: reportes vivos + historial de 30 días
create or replace function public.vial_poco_confiable(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  with h as (
    select (negaciones >= 2 and negaciones > confirmaciones) des, (confirmaciones >= 1 and confirmaciones >= negaciones) conf
    from vial_reportes where user_id = uid and creado > now() - interval '30 days'
    union all
    select desmentido, confirmado from vial_puntos where user_id = uid and motivo = 'reporte' and creado > now() - interval '30 days'
  )
  select coalesce((select count(*) filter (where des) >= 3 and count(*) filter (where des) > count(*) filter (where conf) from h), false) $$;

-- =====================================================================
-- Estadísticas para el admin
-- =====================================================================
create or replace function public.vial_admin_estadisticas() returns json
language plpgsql stable security definer set search_path = public as $$
declare hoy date := (now() at time zone 'America/Guayaquil')::date;
begin
  if not is_admin() then raise exception 'Solo administradores'; end if;
  return json_build_object(
    'visitas', (select json_build_object(
        'hoy', count(*) filter (where (creado at time zone 'America/Guayaquil')::date = hoy),
        'semana', count(*) filter (where creado > now() - interval '7 days'),
        'mes', count(*) filter (where creado > now() - interval '30 days'),
        'unicos_semana', count(distinct visitante) filter (where creado > now() - interval '7 days'),
        'unicos_mes', count(distinct visitante) filter (where creado > now() - interval '30 days'),
        'app_mes', count(*) filter (where origen = 'app' and creado > now() - interval '30 days'),
        'web_mes', count(*) filter (where origen = 'web' and creado > now() - interval '30 days'),
        'pwa_mes', count(*) filter (where origen = 'pwa' and creado > now() - interval '30 days'))
      from vial_visitas),
    'dias', (select coalesce(json_agg(d order by d.dia desc), '[]') from (
        select g::date dia,
          (select count(*) from vial_visitas v where (v.creado at time zone 'America/Guayaquil')::date = g::date and origen = 'web') web,
          (select count(*) from vial_visitas v where (v.creado at time zone 'America/Guayaquil')::date = g::date and origen in ('app','pwa')) app,
          (select count(*) from vial_perfiles p where (p.creado at time zone 'America/Guayaquil')::date = g::date) registros
        from generate_series(hoy - 13, hoy, interval '1 day') g) d),
    'usuarios', (select json_build_object(
        'total', count(*),
        'semana', count(*) filter (where creado > now() - interval '7 days'),
        'desde_app', count(*) filter (where origen in ('app','pwa')),
        'desde_web', count(*) filter (where origen = 'web'),
        'con_google', (select count(*) from vial_perfiles p join auth.users u on u.id = p.user_id where u.raw_app_meta_data->>'provider' = 'google'))
      from vial_perfiles),
    'reportes_hoy', (select count(*) from vial_reportes where (creado at time zone 'America/Guayaquil')::date = hoy)
  );
end $$;
revoke execute on function public.vial_admin_estadisticas from public, anon;
grant execute on function public.vial_admin_estadisticas to authenticated;

-- La limpieza ahora la hace vial-cron cada hora (borra también las fotos)
select cron.unschedule('vial-limpieza');
select cron.schedule('vial-limpieza', '7 * * * *', $$select public.vial_llamar_cron('limpieza')$$);
-- Comentarios revisados con IA (Groq) por vial-cron; si se edita el comentario se vuelve a revisar
alter table public.vial_reportes add column if not exists moderado boolean not null default false;
create or replace function public.vial_reporte_moderar() returns trigger
language plpgsql as $$ begin
  if new.descripcion is distinct from old.descripcion and coalesce(auth.role(), '') <> 'service_role' then new.moderado := false; end if;
  return new; end $$;
drop trigger if exists vial_reporte_moderar on public.vial_reportes;
create trigger vial_reporte_moderar before update on public.vial_reportes for each row execute function public.vial_reporte_moderar();
