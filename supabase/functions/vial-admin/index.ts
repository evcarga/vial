// Vial: publicar actualizaciones de la app Android desde el panel admin de la app.
//   publicar_version (admin, desde la app): crea la versión y pide a GitHub Actions compilar la APK.
//   version_lista    (GitHub Actions, con VIAL_CI_SECRET): marca la versión como publicada o fallida;
//                    después vial-cron avisa a todos por push y Telegram.

const ORIGINS = ['https://evcarga.github.io'];
const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GH = Deno.env.get('VIAL_GITHUB_TOKEN')!;
const CI = Deno.env.get('VIAL_CI_SECRET')!;
const REPO = 'evcarga/vial';
const srv = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const db = (path: string, init: RequestInit = {}) => fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...srv, ...(init.headers || {}) } });

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ORIGINS.includes(origin)) Object.assign(headers, {
    'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin',
  });
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  const reply = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers });
  let body: any = {};
  try { body = await req.json(); } catch { return reply({ error: 'Solicitud inválida' }, 400); }

  // ---------- Llamada desde GitHub Actions al terminar la compilación ----------
  if (body.accion === 'version_lista') {
    if (req.headers.get('x-ci-secret') !== CI) return reply({ error: 'No autorizado' }, 401);
    const ok = body.ok === true;
    await db(`vial_app_versiones?version_code=eq.${Number(body.version_code)}`, {
      method: 'PATCH',
      body: JSON.stringify({ estado: ok ? 'publicada' : 'fallida', apk_url: ok ? String(body.apk_url || '') : null, notificado: !ok }),
    });
    return reply({ ok: true });
  }

  // ---------- Desde la app: solo administradores ----------
  if (!ORIGINS.includes(origin)) return reply({ error: 'Origen no permitido' }, 403);
  const me = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: req.headers.get('authorization') || '' } });
  if (!me.ok) return reply({ error: 'Inicia sesión' }, 401);
  const user = await me.json();
  const prof = await (await db(`profiles?select=role&id=eq.${user.id}`)).json();
  if (prof?.[0]?.role !== 'admin') return reply({ error: 'Solo administradores' }, 403);

  if (body.accion === 'publicar_version') {
    const notas = String(body.notas || '').trim().slice(0, 500);
    const obligatoria = body.obligatoria === true;
    const enCurso = await (await db('vial_app_versiones?estado=eq.compilando&creado=gt.' + new Date(Date.now() - 30 * 60000).toISOString() + '&select=id')).json();
    if (enCurso.length) return reply({ error: 'Ya hay una versión compilándose. Espera unos minutos.' }, 409);
    const last = await (await db('vial_app_versiones?select=version_code&order=version_code.desc&limit=1')).json();
    const code = Math.max(1, last?.[0]?.version_code || 1) + 1;
    const name = `1.${code - 1}`;
    const ins = await db('vial_app_versiones', {
      method: 'POST', body: JSON.stringify({ version_code: code, version_name: name, notas, obligatoria, estado: 'compilando' }),
    });
    if (!ins.ok) return reply({ error: 'No se pudo registrar la versión' }, 500);
    const gh = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/android.yml/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GH}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vial-admin' },
      body: JSON.stringify({ ref: 'main', inputs: { version_code: String(code), version_name: name } }),
    });
    if (gh.status !== 204) {
      console.error('github', gh.status, (await gh.text()).slice(0, 200));
      await db(`vial_app_versiones?version_code=eq.${code}`, { method: 'PATCH', body: JSON.stringify({ estado: 'fallida', notificado: true }) });
      return reply({ error: 'GitHub no aceptó la compilación' }, 502);
    }
    return reply({ ok: true, version_code: code, version_name: name });
  }
  return reply({ error: 'Acción no válida' }, 400);
});
