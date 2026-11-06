// Vial: webhook del bot de Telegram.
// - /reporte <tipo>  → pide la ubicación y crea el reporte en el mapa.
// - Enviar una ubicación → el bot pregunta "¿Qué pasa aquí?" con botones (2 toques).
// - /hoy → pico y placa de hoy.   /mapa → link al mapa.
// - /start <código> → vincula la cuenta de Vial para recibir avisos personales.
// Telegram envía la cabecera X-Telegram-Bot-Api-Secret-Token, que se valida con TELEGRAM_WEBHOOK_SECRET.

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TG = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')!;
const SITE = 'https://evcarga.github.io/vial/';
const srv = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const db = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...srv, ...(init.headers || {}) } });
  if (!r.ok) { console.error('db', r.status, (await r.text()).slice(0, 200)); return null; }
  return r.status === 204 ? [] : r.json();
};
const api = (method: string, body: unknown) => fetch(`https://api.telegram.org/bot${TG}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const send = (chat: number, text: string, extra: Record<string, unknown> = {}) =>
  api('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

const TIPOS: Record<string, string> = {
  trafico: '🚗 Tráfico', accidente: '💥 Accidente', control: '👮 Control', radar: '📸 Radar',
  obra: '🚧 Vía cerrada/obra', peligro: '⚠️ Peligro', varado: '🛻 Varado',
};
const ALIAS: Record<string, string> = {
  trafico: 'trafico', tráfico: 'trafico', trancon: 'trafico', accidente: 'accidente', choque: 'accidente',
  control: 'control', operativo: 'control', radar: 'radar', fotomulta: 'radar', obra: 'obra', cerrada: 'obra', cierre: 'obra',
  peligro: 'peligro', bache: 'peligro', inundacion: 'peligro', inundación: 'peligro', varado: 'varado', dañado: 'varado',
};
const teclado = (lat: number, lng: number) => ({
  inline_keyboard: Object.entries(TIPOS).reduce((rows: unknown[][], [k, v], i) => {
    if (i % 2 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: v, callback_data: `r|${k}|${lat.toFixed(5)}|${lng.toFixed(5)}` });
    return rows;
  }, []),
});

async function zona(lat: number, lng: number) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${lat}&lon=${lng}&accept-language=es`,
      { headers: { 'User-Agent': 'Vial-Quito/1.0 (https://evcarga.github.io/vial/)' } });
    const a = (await r.json()).address || {};
    return [a.road, a.neighbourhood || a.suburb || a.quarter].filter(Boolean).join(', ').slice(0, 80) || null;
  } catch { return null; }
}

async function crear(from: { id: number; first_name?: string }, chat: number, tipo: string, lat: number, lng: number) {
  const hace1h = new Date(Date.now() - 3600_000).toISOString();
  const n = await db(`vial_reportes?telegram_user_id=eq.${from.id}&creado=gt.${hace1h}&select=id`);
  if ((n || []).length >= 5) return send(chat, 'Máximo 5 reportes por hora. Gracias por ayudar 🙌');
  if (lat < -5.1 || lat > 1.7 || lng < -92.1 || lng > -75.1) return send(chat, 'Esa ubicación está fuera de Ecuador.');
  const vinc = await db(`vial_perfiles?telegram_chat_id=eq.${from.id}&select=user_id,nombre,bloqueado`);
  const perfil = vinc?.[0];
  if (perfil?.bloqueado) return send(chat, 'Tu cuenta está bloqueada para reportar.');
  const r = await db('vial_reportes', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      tipo, lat, lng, zona: await zona(lat, lng), origen: 'telegram', telegram_user_id: from.id,
      user_id: perfil?.user_id || null, autor: (perfil?.nombre || from.first_name || '').split(' ')[0].slice(0, 40) || null,
    }),
  });
  if (!r?.[0]) return send(chat, 'No se pudo crear el reporte.');
  return send(chat, `✅ ${TIPOS[tipo]} reportado. <a href="${SITE}?r=${r[0].id}">Ver en el mapa</a>`);
}

async function hoy(chat: number) {
  const q = new Date(Date.now() - 5 * 3600_000);
  const dia = q.getUTCDay() === 0 ? 7 : q.getUTCDay();
  const fer = await db(`vial_feriados?fecha=eq.${q.toISOString().slice(0, 10)}&select=nombre`);
  if (fer?.length) return send(chat, `🎉 Hoy es feriado (${fer[0].nombre}): sin pico y placa.`);
  const reg = await db(`vial_reglas_pico_placa?ciudad=eq.Quito&dia=eq.${dia}&activo=eq.true&select=digitos,franjas`);
  if (!reg?.length) return send(chat, '✅ Hoy no hay pico y placa en Quito.');
  return send(chat, `🚦 Hoy no circulan placas terminadas en <b>${reg[0].digitos.join(' y ')}</b>\n🕒 ${reg[0].franjas.split(',').map((x: string) => x.replace('-', ' a ')).join(' y ')}`);
}

Deno.serve(async (req) => {
  if (!TG || req.headers.get('x-telegram-bot-api-secret-token') !== SECRET) return new Response('No autorizado', { status: 401 });
  let u: any;
  try { u = await req.json(); } catch { return new Response('ok'); }
  try {
    // Botón de tipo tras enviar una ubicación
    if (u.callback_query) {
      const cq = u.callback_query;
      const [k, tipo, lat, lng] = String(cq.data || '').split('|');
      const dueño = cq.message?.reply_to_message?.from?.id;
      if (k === 'r' && TIPOS[tipo] && (!dueño || dueño === cq.from.id)) {
        await api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Reporte enviado' });
        await api('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
        await crear(cq.from, cq.message.chat.id, tipo, Number(lat), Number(lng));
      } else {
        await api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Solo quien envió la ubicación puede elegir' });
      }
      return new Response('ok');
    }
    const m = u.message;
    if (!m?.from || m.from.is_bot) return new Response('ok');
    const chat = m.chat.id;

    if (m.location) {
      const p = await db(`vial_tg_pendientes?telegram_user_id=eq.${m.from.id}&select=tipo`);
      if (p?.[0]) {
        await db(`vial_tg_pendientes?telegram_user_id=eq.${m.from.id}`, { method: 'DELETE' });
        await crear(m.from, chat, p[0].tipo, m.location.latitude, m.location.longitude);
      } else {
        await send(chat, '¿Qué pasa aquí?', { reply_to_message_id: m.message_id, reply_markup: teclado(m.location.latitude, m.location.longitude) });
      }
      return new Response('ok');
    }

    const text: string = m.text || '';
    const [cmd0, ...args] = text.trim().split(/\s+/);
    const cmd = cmd0.toLowerCase().split('@')[0];
    if (cmd === '/start' && args[0]) {
      const v = await db(`vial_tg_vinculos?codigo=eq.${encodeURIComponent(args[0].toUpperCase())}&expira=gt.${new Date().toISOString()}&select=user_id`);
      if (!v?.[0] || m.chat.type !== 'private') { await send(chat, 'Código no válido o vencido. Genéralo de nuevo en la app.'); return new Response('ok'); }
      await db(`vial_perfiles?telegram_chat_id=eq.${m.from.id}`, { method: 'PATCH', body: JSON.stringify({ telegram_chat_id: null }) });
      await db(`vial_perfiles?user_id=eq.${v[0].user_id}`, { method: 'PATCH', body: JSON.stringify({ telegram_chat_id: m.from.id }) });
      await db(`vial_tg_vinculos?codigo=eq.${encodeURIComponent(args[0].toUpperCase())}`, { method: 'DELETE' });
      await send(chat, '✅ Cuenta vinculada. Te avisaré aquí de tus zonas, pico y placa y vencimientos.');
    } else if (cmd === '/reporte' || cmd === '/reportar') {
      const tipo = ALIAS[(args[0] || '').toLowerCase()];
      if (!tipo) {
        await send(chat, 'Uso: /reporte <tipo>\nTipos: trafico, accidente, control, radar, obra, peligro, varado.\n\nO más fácil: envía tu ubicación (📎 → Ubicación) y elige el tipo.');
      } else {
        await db('vial_tg_pendientes', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ telegram_user_id: m.from.id, chat_id: chat, tipo, creado: new Date().toISOString() }) });
        await send(chat, `📍 Ahora envía tu ubicación (📎 → Ubicación) para reportar ${TIPOS[tipo]}.`, { reply_to_message_id: m.message_id });
      }
    } else if (cmd === '/hoy') {
      await hoy(chat);
    } else if (cmd === '/mapa' || cmd === '/start' || cmd === '/ayuda' || cmd === '/help') {
      await send(chat, `🗺️ Mapa en vivo: ${SITE}\n⚡ Cargadores EV: https://evcarga.github.io/\n\nComandos:\n/reporte accidente (y luego tu ubicación)\n/hoy — pico y placa de hoy\nO envía tu ubicación y elige qué pasa.`);
    }
  } catch (e) { console.error('telegram', String(e)); }
  return new Response('ok');
});
