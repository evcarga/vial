// Vial: tareas programadas (pg_cron llama esta función con la cabecera x-cron-key).
//   ?tarea=cada   (cada 2 min) publica reportes nuevos en Telegram, avisa por zona (push + Telegram)
//                              y avisa de nuevas versiones de la app.
//   ?tarea=manana (6:30 Quito) resumen al grupo: dígitos de hoy y reportes activos.
//   ?tarea=noche  (20:00 Quito) aviso personal: pico y placa de mañana y vencimientos a 15 y 3 días.
// Telegram es opcional: si faltan TELEGRAM_BOT_TOKEN / TELEGRAM_GROUP_ID simplemente no se envía.

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_KEY = Deno.env.get('VIAL_CRON_KEY')!;
const TG = Deno.env.get('TELEGRAM_BOT_TOKEN');
const GROUP = Deno.env.get('TELEGRAM_GROUP_ID');
const VAPID_PUB = Deno.env.get('VIAL_VAPID_PUBLIC')!;
const VAPID_PRIV = Deno.env.get('VIAL_VAPID_PRIVATE')!;
const SITE = 'https://evcarga.github.io/vial/';

const srv = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const db = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...srv, ...(init.headers || {}) } });
  if (!r.ok) { console.error('db', path, r.status, (await r.text()).slice(0, 200)); return []; }
  return r.status === 204 ? [] : r.json();
};

const TIPOS: Record<string, string> = {
  trafico: '🚗 Tráfico pesado', accidente: '💥 Accidente', control: '👮 Control de tránsito', radar: '📸 Radar o fotomulta',
  obra: '🚧 Vía cerrada u obra', peligro: '⚠️ Peligro en la vía', varado: '🛻 Vehículo varado',
};
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const esc = (s: string) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
// Hora de Quito (UTC-5, sin horario de verano)
const quito = (d = new Date()) => new Date(d.getTime() - 5 * 3600_000);
const hora = (iso: string) => quito(new Date(iso)).toISOString().slice(11, 16);
const km = (a: number, b: number, c: number, d: number) => {
  const r = Math.PI / 180, h = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

async function tg(chat: string | number, text: string, extra: Record<string, unknown> = {}) {
  if (!TG || !chat) return false;
  const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
  });
  if (!r.ok) console.error('telegram', r.status, (await r.text()).slice(0, 200));
  return r.ok;
}

// ================= Web Push (RFC 8291 aes128gcm + VAPID), solo Web Crypto =================
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const te = (s: string) => new TextEncoder().encode(s);
async function hmacSha(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
let vapidKey: CryptoKey | null = null;
async function vapidHeader(endpoint: string) {
  if (!vapidKey) vapidKey = await crypto.subtle.importKey('jwk', JSON.parse(VAPID_PRIV), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const aud = new URL(endpoint).origin;
  const h = b64u(te(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u(te(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://evcarga.github.io/vial/' })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapidKey, te(`${h}.${p}`)));
  return `vapid t=${h}.${p}.${b64u(sig)}, k=${VAPID_PUB}`;
}
async function encrypt(p256dh: string, authSecret: string, payload: Uint8Array) {
  const uaPub = unb64u(p256dh);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const prkKey = await hmacSha(unb64u(authSecret), shared);
  const ikm = await hmacSha(prkKey, cat(te('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha(salt, ikm);
  const cek = (await hmacSha(prk, cat(te('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmacSha(prk, cat(te('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
type Sub = { id: number; endpoint: string; p256dh: string; auth: string; user_id: string };
async function push(sub: Sub, msg: { title: string; body: string; url?: string; tag?: string }) {
  try {
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: await vapidHeader(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high' },
      body: await encrypt(sub.p256dh, sub.auth, te(JSON.stringify(msg))),
    });
    if (r.status === 404 || r.status === 410) await db(`vial_push?id=eq.${sub.id}`, { method: 'DELETE' });
    else if (!r.ok) console.error('push', r.status, (await r.text()).slice(0, 150));
  } catch (e) { console.error('push', String(e)); }
}

// ================= Pico y placa =================
async function picoPlaca(fecha: Date) {
  const q = quito(fecha);
  const iso = q.toISOString().slice(0, 10);
  const dia = q.getUTCDay() === 0 ? 7 : q.getUTCDay();
  const fer = await db(`vial_feriados?fecha=eq.${iso}&select=nombre`);
  if (fer.length) return { iso, dia, feriado: fer[0].nombre, digitos: [] as number[], franjas: '' };
  const reg = await db(`vial_reglas_pico_placa?ciudad=eq.Quito&dia=eq.${dia}&activo=eq.true&select=digitos,franjas`);
  return { iso, dia, feriado: null, digitos: (reg[0]?.digitos || []) as number[], franjas: reg[0]?.franjas || '' };
}
const franjasTxt = (f: string) => f.split(',').map((x) => x.replace('-', ' a ')).join(' y ');
const ultimoDigito = (placa: string) => Number((placa.match(/\d(?=\D*$)/) || ['-1'])[0]);

// ================= Tareas =================
async function cada() {
  // 1) Reportes nuevos → grupo de Telegram + alertas por zona
  const nuevos = await db(`vial_reportes?or=(publicado_tg.eq.false,notificado.eq.false)&oculto=eq.false&expira=gt.${new Date().toISOString()}&creado=gt.${new Date(Date.now() - 3600_000).toISOString()}&select=id,tipo,lat,lng,zona,descripcion,creado,user_id,origen,autor,publicado_tg,notificado&order=id&limit=30`);
  if (nuevos.length) {
    const zonas = await db('vial_zonas?select=user_id,nombre,lat,lng,radio_m');
    for (const r of nuevos) {
      const titulo = TIPOS[r.tipo] || r.tipo;
      const link = `${SITE}?r=${r.id}`;
      if (!r.publicado_tg) {
        const ok = !TG || !GROUP || await tg(GROUP,
          `<b>${titulo}</b>\n📍 ${esc(r.zona || 'Ubicación en el mapa')}\n🕒 ${hora(r.creado)}${r.descripcion ? `\n💬 ${esc(r.descripcion)}` : ''}${r.autor ? `\n👤 ${esc(r.autor)}` : ''}\n<a href="${link}">Ver en el mapa</a>`);
        if (ok) await db(`vial_reportes?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ publicado_tg: true }) });
      }
      if (!r.notificado) {
        const users = new Map<string, string>();
        for (const z of zonas) if (z.user_id !== r.user_id && km(z.lat, z.lng, r.lat, r.lng) * 1000 <= z.radio_m) users.set(z.user_id, z.nombre);
        if (users.size) {
          const ids = [...users.keys()].join(',');
          const subs: Sub[] = await db(`vial_push?user_id=in.(${ids})&select=id,endpoint,p256dh,auth,user_id`);
          await Promise.all(subs.map((s) => push(s, { title: `${titulo} · ${users.get(s.user_id)}`, body: `${r.zona || 'Cerca de tu zona'} · ${hora(r.creado)}`, url: link, tag: `r${r.id}` })));
          const perfiles = await db(`vial_perfiles?user_id=in.(${ids})&telegram_chat_id=not.is.null&select=user_id,telegram_chat_id`);
          for (const p of perfiles) await tg(p.telegram_chat_id, `<b>${titulo}</b> en tu zona «${esc(users.get(p.user_id)!)}»\n📍 ${esc(r.zona || '')} · ${hora(r.creado)}\n<a href="${link}">Ver en el mapa</a>`);
        }
        await db(`vial_reportes?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ notificado: true }) });
      }
    }
  }
  // 2) Nueva versión de la app publicada → aviso a todos
  const vers = await db('vial_app_versiones?estado=eq.publicada&notificado=eq.false&select=id,version_name,notas,obligatoria');
  for (const v of vers) {
    const subs: Sub[] = await db('vial_push?select=id,endpoint,p256dh,auth,user_id');
    await Promise.all(subs.map((s) => push(s, { title: `Nueva versión de Vial ${v.version_name}`, body: v.notas || 'Toca para actualizar la app', url: `${SITE}?actualizar=1`, tag: 'version' })));
    if (GROUP) await tg(GROUP, `📲 <b>Nueva versión de la app Vial ${esc(v.version_name)}</b>\n${esc(v.notas || '')}\nDescárgala: ${SITE}?actualizar=1`);
    await db(`vial_app_versiones?id=eq.${v.id}`, { method: 'PATCH', body: JSON.stringify({ notificado: true }) });
  }
  // 3) Limpieza: códigos de Telegram y pendientes viejos
  await db(`vial_tg_vinculos?expira=lt.${new Date().toISOString()}`, { method: 'DELETE' });
  await db(`vial_tg_pendientes?creado=lt.${new Date(Date.now() - 900_000).toISOString()}`, { method: 'DELETE' });
  return { reportes: nuevos.length, versiones: vers.length };
}

async function manana() {
  const pp = await picoPlaca(new Date());
  const activos = await db(`vial_reportes?oculto=eq.false&expira=gt.${new Date().toISOString()}&select=tipo,zona,creado&order=creado.desc&limit=15`);
  const cab = pp.feriado ? `🎉 Hoy es feriado (${esc(pp.feriado)}): <b>sin pico y placa</b>.`
    : pp.digitos.length ? `🚦 <b>Pico y placa hoy ${DIAS[pp.dia % 7]}</b>: placas terminadas en <b>${pp.digitos.join(' y ')}</b>\n🕒 ${franjasTxt(pp.franjas)}`
    : '✅ Hoy no hay pico y placa en Quito.';
  const lista = activos.length ? activos.map((r: { tipo: string; zona: string; creado: string }) => `• ${TIPOS[r.tipo]} — ${esc(r.zona || 'ver mapa')} (${hora(r.creado)})`).join('\n') : 'Sin reportes activos por ahora.';
  const txt = `☀️ <b>Buenos días, Quito</b>\n\n${cab}\n\n<b>Reportes activos</b>\n${lista}\n\n🗺️ Mapa: ${SITE}\n⚡ Cargadores: https://evcarga.github.io/`;
  const ok = await tg(GROUP || '', txt);
  return { enviado: ok };
}

async function noche() {
  const manana_ = await picoPlaca(new Date(Date.now() + 24 * 3600_000));
  const hoy = quito().toISOString().slice(0, 10);
  const en = (d: number) => new Date(Date.parse(hoy) + d * 86400_000).toISOString().slice(0, 10);
  const avisos = new Map<string, string[]>();
  const add = (u: string, t: string) => avisos.set(u, [...(avisos.get(u) || []), t]);

  if (!manana_.feriado && manana_.digitos.length) {
    const vehs = await db('vial_vehiculos?exento=eq.false&ciudad=eq.Quito&select=user_id,placa,alias');
    const off = new Set((await db('vial_perfiles?aviso_noche=eq.false&select=user_id')).map((p: { user_id: string }) => p.user_id));
    for (const v of vehs) if (!off.has(v.user_id) && manana_.digitos.includes(ultimoDigito(v.placa)))
      add(v.user_id, `🚫 Mañana ${v.alias || v.placa} (${v.placa}) tiene pico y placa: ${franjasTxt(manana_.franjas)}`);
  }
  const NOM: Record<string, string> = { matricula: 'Matrícula', revision: 'Revisión técnica', seguro: 'Seguro', licencia: 'Licencia', otro: 'Trámite' };
  for (const [dias, col] of [[15, 'avisado_15'], [3, 'avisado_3']] as const) {
    const vs = await db(`vial_vencimientos?fecha=eq.${en(dias)}&${col}=eq.false&select=id,user_id,tipo,nota`);
    for (const v of vs) {
      add(v.user_id, `📅 ${NOM[v.tipo]}${v.nota ? ` (${v.nota})` : ''} vence en ${dias} días (${en(dias)})`);
      await db(`vial_vencimientos?id=eq.${v.id}`, { method: 'PATCH', body: JSON.stringify({ [col]: true }) });
    }
  }
  if (!avisos.size) return { avisos: 0 };
  const ids = [...avisos.keys()].join(',');
  const subs: Sub[] = await db(`vial_push?user_id=in.(${ids})&select=id,endpoint,p256dh,auth,user_id`);
  await Promise.all(subs.map((s) => { const l = avisos.get(s.user_id)!; return push(s, { title: 'Vial · recordatorio', body: l.join('\n'), url: SITE, tag: 'noche' }); }));
  const perfiles = await db(`vial_perfiles?user_id=in.(${ids})&telegram_chat_id=not.is.null&select=user_id,telegram_chat_id`);
  for (const p of perfiles) await tg(p.telegram_chat_id, `🌙 <b>Recordatorio</b>\n${avisos.get(p.user_id)!.map(esc).join('\n')}`);
  return { avisos: avisos.size };
}

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-key') !== CRON_KEY) return new Response('No autorizado', { status: 401 });
  const tarea = new URL(req.url).searchParams.get('tarea') || 'cada';
  try {
    const out = tarea === 'manana' ? await manana() : tarea === 'noche' ? await noche() : await cada();
    return Response.json({ ok: true, tarea, ...out });
  } catch (e) {
    console.error(tarea, String(e));
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
