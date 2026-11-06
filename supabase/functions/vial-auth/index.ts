// Vial: registro e ingreso con correo o WhatsApp + PIN de 4 dígitos.
// - La contraseña real en Supabase es HMAC(pimienta, identificador:PIN), larga e imposible de adivinar
//   directamente contra Supabase: el PIN solo sirve a través de esta función, que limita los intentos.
// - Tras 3 PIN incorrectos la cuenta se bloquea 15 min; cada bloqueo siguiente dura el doble (máx. 24 h).
// - También acepta cuentas antiguas de EvCarga (PIN + "99") para que los usuarios compartan cuenta.
// Acciones: registro, ingreso, cambiar_pin (con sesión), admin_pin (admin cambia el PIN de otro usuario).

const ORIGINS = ['https://evcarga.github.io'];
const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PEPPER = Deno.env.get('VIAL_PIN_PEPPER')!;
const WA_DOMAIN = 'wa.vial.evcarga';

const srv = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

// Límite por IP (mejor esfuerzo, por instancia): 20 intentos cada 10 min
const ipHits = new Map<string, number[]>();
function ipLimited(ip: string) {
  const now = Date.now();
  const l = (ipHits.get(ip) || []).filter((t) => now - t < 600_000);
  l.push(now); ipHits.set(ip, l);
  return l.length > 20;
}

async function hmac(text: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return 'V1.' + btoa(String.fromCharCode(...sig)).replace(/=+$/, '');
}

// Correo en minúsculas, o WhatsApp de Ecuador (09xxxxxxxx → 5939xxxxxxxx)
function parseContacto(raw: string): { email: string; id: string; whatsapp?: string } | null {
  const c = String(raw || '').trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(c)) return c.endsWith('@' + WA_DOMAIN) ? null : { email: c, id: c };
  let d = c.replace(/[^\d]/g, '');
  if (/^09\d{8}$/.test(d)) d = '593' + d.slice(1);
  if (/^9\d{8}$/.test(d)) d = '593' + d;
  if (!/^\d{9,15}$/.test(d)) return null;
  return { email: `${d}@${WA_DOMAIN}`, id: d, whatsapp: d };
}

async function rest(path: string, init: RequestInit = {}) {
  return fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...srv, ...(init.headers || {}) } });
}

async function passwordLogin(email: string, password: string) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return r.ok ? await r.json() : null;
}

async function getIntento(id: string) {
  const r = await rest(`vial_login_intentos?identificador=eq.${encodeURIComponent(id)}&select=*`);
  return (await r.json())?.[0] || null;
}
async function setIntento(id: string, v: Record<string, unknown>) {
  await rest('vial_login_intentos', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ identificador: id, actualizado: new Date().toISOString(), ...v }),
  });
}

async function ensurePerfil(userId: string, nombre: string | null, whatsapp?: string, origen?: string) {
  await rest('vial_perfiles?on_conflict=user_id', {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify({ user_id: userId, nombre: nombre ? nombre.slice(0, 40) : null, whatsapp: whatsapp || null, origen: ['web', 'app', 'pwa'].includes(origen || '') ? origen : null }),
  });
}

async function userFromToken(auth: string) {
  const r = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } });
  return r.ok ? await r.json() : null;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  if (!ORIGINS.includes(origin)) return new Response('Origen no permitido', { status: 403 });
  const headers = {
    'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin', 'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  const reply = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

  let body: Record<string, string> = {};
  try { body = await req.json(); } catch { return reply({ error: 'Solicitud inválida' }, 400); }
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || '?';
  if (ipLimited(ip)) return reply({ error: 'Demasiados intentos desde tu conexión. Espera 10 minutos.' }, 429);

  const accion = body.accion;
  const pin = String(body.pin || '');

  // ---------- Cambiar mi PIN (con sesión) ----------
  if (accion === 'cambiar_pin' || accion === 'admin_pin') {
    if (!/^\d{4}$/.test(pin)) return reply({ error: 'El PIN debe tener 4 dígitos' }, 400);
    const me = await userFromToken(req.headers.get('authorization') || '');
    if (!me) return reply({ error: 'Inicia sesión' }, 401);
    let target = me;
    if (accion === 'admin_pin') {
      const prof = await (await rest(`profiles?select=role&id=eq.${me.id}`)).json();
      if (prof?.[0]?.role !== 'admin') return reply({ error: 'Solo administradores' }, 403);
      const r = await fetch(`${URL_}/auth/v1/admin/users/${encodeURIComponent(body.user_id)}`, { headers: srv });
      if (!r.ok) return reply({ error: 'Usuario no encontrado' }, 404);
      target = await r.json();
    }
    const id = target.email?.endsWith('@' + WA_DOMAIN) ? target.email.split('@')[0] : target.email;
    const r = await fetch(`${URL_}/auth/v1/admin/users/${target.id}`, {
      method: 'PUT', headers: srv, body: JSON.stringify({ password: await hmac(`${id}:${pin}`) }),
    });
    if (!r.ok) return reply({ error: 'No se pudo cambiar el PIN' }, 500);
    await setIntento(id, { fallos: 0, nivel: 0, bloqueado_hasta: null });
    return reply({ ok: true });
  }

  const c = parseContacto(body.contacto);
  if (!c) return reply({ error: 'Escribe un correo válido o tu número de WhatsApp (09…)' }, 400);
  if (!/^\d{4}$/.test(pin)) return reply({ error: 'El PIN debe tener 4 dígitos' }, 400);
  if (/^(\d)\1{3}$/.test(pin) || ['1234', '4321', '0123', '9876'].includes(pin)) {
    if (accion === 'registro') return reply({ error: 'Ese PIN es muy fácil de adivinar. Elige otro.' }, 400);
  }

  // ---------- Registro ----------
  if (accion === 'registro') {
    const nombre = String(body.nombre || '').trim().split(/\s+/)[0]?.slice(0, 40);
    if (!nombre) return reply({ error: 'Escribe tu primer nombre' }, 400);
    const r = await fetch(`${URL_}/auth/v1/admin/users`, {
      method: 'POST', headers: srv,
      body: JSON.stringify({
        email: c.email, password: await hmac(`${c.id}:${pin}`), email_confirm: true,
        user_metadata: { full_name: nombre, nombre, phone: c.whatsapp || null, proyecto: 'vial' },
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      if (/already|registered|exists/i.test(t)) return reply({ error: 'Ya existe una cuenta con ese dato. Usa "Ingresar".' }, 409);
      console.error('registro', r.status, t.slice(0, 200));
      return reply({ error: 'No se pudo crear la cuenta' }, 500);
    }
    const u = await r.json();
    await ensurePerfil(u.id, nombre, c.whatsapp, body.origen);
    const s = await passwordLogin(c.email, await hmac(`${c.id}:${pin}`));
    return reply({ access_token: s?.access_token, refresh_token: s?.refresh_token });
  }

  // ---------- Ingreso ----------
  if (accion === 'ingreso') {
    const it = await getIntento(c.id);
    if (it?.bloqueado_hasta && new Date(it.bloqueado_hasta) > new Date()) {
      const min = Math.ceil((new Date(it.bloqueado_hasta).getTime() - Date.now()) / 60000);
      return reply({ error: `Demasiados intentos. Tu cuenta está bloqueada ${min} min.`, bloqueado_min: min }, 429);
    }
    let s = await passwordLogin(c.email, await hmac(`${c.id}:${pin}`));
    if (!s && !c.whatsapp) s = await passwordLogin(c.email, pin + '99'); // cuenta antigua de EvCarga
    if (!s) {
      const fallos = (it?.fallos || 0) + 1;
      if (fallos >= 3) {
        const nivel = (it?.nivel || 0) + 1;
        const min = Math.min(15 * 2 ** (nivel - 1), 1440);
        await setIntento(c.id, { fallos: 0, nivel, bloqueado_hasta: new Date(Date.now() + min * 60000).toISOString() });
        return reply({ error: `PIN incorrecto 3 veces. Cuenta bloqueada ${min} min.`, bloqueado_min: min }, 429);
      }
      await setIntento(c.id, { fallos, nivel: it?.nivel || 0 });
      return reply({ error: `Datos incorrectos. Te ${3 - fallos === 1 ? 'queda 1 intento' : `quedan ${3 - fallos} intentos`}.`, restantes: 3 - fallos }, 401);
    }
    await setIntento(c.id, { fallos: 0, nivel: 0, bloqueado_hasta: null });
    await ensurePerfil(s.user.id, s.user.user_metadata?.nombre || s.user.user_metadata?.full_name?.split(' ')[0] || null, c.whatsapp);
    return reply({ access_token: s.access_token, refresh_token: s.refresh_token });
  }

  return reply({ error: 'Acción no válida' }, 400);
});
