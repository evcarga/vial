// =====================================================================
// Vial Quito: pico y placa, vencimientos y reportes de la comunidad.
// Datos en Supabase (misma base de EvCarga, tablas vial_*). Solo la anon key pública aquí;
// la seguridad está en las políticas RLS y en las funciones del servidor.
// =====================================================================
const SB_URL = 'https://yjnlfewsgksdsvsimdjs.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqbmxmZXdzZ2tzZHN2c2ltZGpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM3NTk4OTgsImV4cCI6MjA3OTMzNTg5OH0.ysDsAdyn3k2i51xnAkJFGKtEWpQ3laxWV7rpjvFIF8E';
const VAPID_PUBLIC = 'BACf_XoL2tbGGzFn6AFnS8os1Bc5N0NHw221rFFeWyZZT0PDEBUusmNb3RuBYdInmftZ42mv_s4GOCtftF7IpsE';
const SITE = 'https://evcarga.github.io/vial/';
const APK_URL = 'https://github.com/evcarga/vial/releases/latest/download/vial.apk';
const QUITO = [-0.1807, -78.4678];

const sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, detectSessionInUrl: true } });

const TIPOS = {
  trafico:   { e: '🚗', n: 'Tráfico pesado',     c: '#fb923c' },
  accidente: { e: '💥', n: 'Accidente',          c: '#ef4444' },
  control:   { e: '👮', n: 'Control de tránsito', c: '#3b82f6' },
  radar:     { e: '📸', n: 'Radar o fotomulta',  c: '#a855f7' },
  obra:      { e: '🚧', n: 'Vía cerrada u obra', c: '#f59e0b' },
  peligro:   { e: '⚠️', n: 'Peligro en la vía',  c: '#eab308' },
  varado:    { e: '🛻', n: 'Vehículo varado',    c: '#64748b' },
};
const VENC = { matricula: 'Matrícula', revision: 'Revisión técnica', seguro: 'Seguro', licencia: 'Licencia', otro: 'Otro' };
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const S = { user: null, perfil: null, admin: false, reglas: [], feriados: [], vehiculos: [], venc: [], zonas: [], reportes: [], radares: [], pos: null, votos: {} };
let map, capaReportes, capaRadares, marcaYo, ultimoReporte = null, fotoArchivo = null;

// ---------- utilidades ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(t, ms = 2800) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), ms); }
function abrir(id) { $(id).classList.remove('hidden'); }
function cerrar(el) { (typeof el === 'string' ? $(el) : el).classList.add('hidden'); }
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
// Hora de Quito (UTC-5 fijo) como objeto Date "desplazado": usar getUTC*
const ahoraQ = () => new Date(Date.now() - 5 * 3600e3);
const isoQ = (d) => d.toISOString().slice(0, 10);
function haceTxt(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'ahora'; if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60); if (h < 24) return `hace ${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `hace ${Math.floor(h / 24)} d`;
}
function dur(min) { const h = Math.floor(min / 60), m = min % 60; return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`; }
const km = (a, b, c, d) => { const r = Math.PI / 180, h = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };
const normPlaca = (p) => String(p || '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9-]/g, '');
const ultimoDigito = (p) => { const m = String(p).match(/\d(?=\D*$)/); return m ? Number(m[0]) : null; };
const fotoUrl = (path) => `${SB_URL}/storage/v1/object/public/vial/${path}`;
function errTxt(e) { return (e && (e.message || e.error_description || e.error)) || 'Ocurrió un error'; }

// ---------- navegación ----------
function irA(tab) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${tab}`));
  document.querySelectorAll('nav.bottom [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'mapa') { iniciarMapa(); setTimeout(() => map.invalidateSize(), 50); }
  if (tab === 'cuenta' && S.user) { cargarRanking(); if (S.admin) cargarAdmin(); }
  window.scrollTo(0, 0);
}
document.querySelectorAll('nav.bottom [data-tab]').forEach((b) => b.addEventListener('click', () => irA(b.dataset.tab)));

// =====================================================================
// PICO Y PLACA
// =====================================================================
function reglaDe(fechaQ) {
  const iso = isoQ(fechaQ);
  const fer = S.feriados.find((f) => f.fecha === iso && (f.ciudad === 'todas' || f.ciudad === 'Quito'));
  const dow = fechaQ.getUTCDay(); const dia = dow === 0 ? 7 : dow;
  if (fer) return { feriado: fer.nombre, digitos: [], franjas: [] };
  const r = S.reglas.find((x) => x.ciudad === 'Quito' && x.dia === dia && x.activo);
  if (!r) return { digitos: [], franjas: [] };
  const franjas = r.franjas.split(',').map((f) => f.split('-').map((h) => { const [a, b] = h.split(':').map(Number); return a * 60 + b; }));
  return { digitos: r.digitos, franjas, texto: r.franjas.split(',').map((f) => f.replace('-', ' a ')).join(' y ') };
}
// Estado para un dígito ahora: {restringido, txt}
function estadoDigito(d) {
  const q = ahoraQ(); const r = reglaDe(q); const min = q.getUTCHours() * 60 + q.getUTCMinutes();
  if (r.feriado) return { libre: true, txt: `Feriado (${r.feriado}): circulas libre` };
  if (!r.digitos.includes(d)) return { libre: true, txt: 'Hoy puedes circular todo el día' };
  const act = r.franjas.find(([a, b]) => min >= a && min < b);
  if (act) return { libre: false, ahora: true, txt: `No circules ahora · termina en ${dur(act[1] - min)}` };
  const prox = r.franjas.find(([a]) => min < a);
  if (prox) return { libre: false, txt: `Hoy tienes pico y placa · empieza en ${dur(prox[0] - min)}` };
  return { libre: true, txt: 'Tu pico y placa de hoy ya terminó' };
}
function pintarPicoPlaca() {
  const q = ahoraQ(); const r = reglaDe(q); const min = q.getUTCHours() * 60 + q.getUTCMinutes();
  $('pp-fecha').textContent = `Quito · ${DIAS[q.getUTCDay()]} ${q.getUTCDate()} de ${MESES[q.getUTCMonth()]}`;
  const est = $('pp-estado');
  if (r.feriado || !r.digitos.length) {
    $('pp-titulo').textContent = r.feriado ? `Feriado: ${r.feriado}` : 'Hoy no hay pico y placa';
    $('pp-digitos').innerHTML = ''; est.textContent = '✅ Circulan todos los vehículos'; est.className = 'estado off'; $('pp-franjas').textContent = '';
  } else {
    $('pp-titulo').textContent = 'Hoy no circulan placas terminadas en';
    $('pp-digitos').innerHTML = r.digitos.map((d) => `<b>${d}</b>`).join('');
    const act = r.franjas.find(([a, b]) => min >= a && min < b);
    const prox = r.franjas.find(([a]) => min < a);
    if (act) { est.textContent = `⛔ Restricción activa · termina en ${dur(act[1] - min)}`; est.className = 'estado on'; }
    else if (prox) { est.textContent = `🟢 Libre ahora · siguiente restricción en ${dur(prox[0] - min)}`; est.className = 'estado off'; }
    else { est.textContent = '🟢 La restricción de hoy terminó'; est.className = 'estado off'; }
    $('pp-franjas').textContent = `Horario: ${r.texto}`;
  }
  // semana
  const lunes = new Date(q.getTime() - ((q.getUTCDay() + 6) % 7) * 86400e3);
  $('pp-semana').innerHTML = [0, 1, 2, 3, 4].map((i) => {
    const d = new Date(lunes.getTime() + i * 86400e3); const rr = reglaDe(d);
    return `<div class="${isoQ(d) === isoQ(q) ? 'hoy' : ''}">${DIAS[d.getUTCDay()].slice(0, 3)}<b>${rr.feriado ? '🎉' : rr.digitos.join('·') || '—'}</b></div>`;
  }).join('');
  pintarPlacaRapida(); pintarVehiculosHoy();
}
function resultadoPlaca(placa, nombre) {
  const d = ultimoDigito(placa);
  if (d === null) return '<div class="res no">Placa no válida</div>';
  const e = estadoDigito(d);
  return `<div class="res ${e.libre ? 'si' : 'no'}">${nombre ? `<b>${esc(nombre)}</b> · ` : ''}${esc(placa)}<br>${e.libre ? '✅' : '⛔'} ${esc(e.txt)}</div>`;
}
function pintarPlacaRapida() { const p = ls.get('placa'); if (p && !S.vehiculos.length) $('placa-resultado').innerHTML = resultadoPlaca(p); }
$('form-placa').addEventListener('submit', (e) => {
  e.preventDefault(); const p = normPlaca($('placa-rapida').value); if (!p) return;
  ls.set('placa', p); $('placa-resultado').innerHTML = resultadoPlaca(p);
});
function pintarVehiculosHoy() {
  $('mis-vehiculos-hoy').innerHTML = S.vehiculos.map((v) => v.exento
    ? `<div class="res si"><b>${esc(v.alias || v.marca || 'Vehículo')}</b> · ${esc(v.placa)}<br>✅ Exento de pico y placa</div>`
    : resultadoPlaca(v.placa, v.alias || [v.marca, v.modelo].filter(Boolean).join(' '))).join('');
}

// =====================================================================
// SESIÓN
// =====================================================================
let modoRegistro = false;
$('toggle-auth').addEventListener('click', (e) => {
  e.preventDefault(); modoRegistro = !modoRegistro;
  $('lbl-nombre').classList.toggle('hidden', !modoRegistro); $('lbl-pin2').classList.toggle('hidden', !modoRegistro);
  $('btn-auth').textContent = modoRegistro ? 'Crear cuenta' : 'Ingresar';
  $('toggle-auth').textContent = modoRegistro ? '¿Ya tienes cuenta? Ingresar' : '¿Nuevo? Crear cuenta';
  $('auth-pin').autocomplete = modoRegistro ? 'new-password' : 'current-password';
});
async function llamarFuncion(nombre, body) {
  const { data: { session } } = await sb.auth.getSession();
  const r = await fetch(`${SB_URL}/functions/v1/${nombre}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: `Bearer ${session?.access_token || SB_KEY}` },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'No se pudo completar');
  return j;
}
$('form-auth').addEventListener('submit', async (e) => {
  e.preventDefault(); $('auth-error').textContent = '';
  const contacto = $('auth-contacto').value.trim(), pin = $('auth-pin').value.trim();
  if (!/^\d{4}$/.test(pin)) return ($('auth-error').textContent = 'El PIN debe tener 4 dígitos');
  const body = { accion: modoRegistro ? 'registro' : 'ingreso', contacto, pin };
  if (modoRegistro) {
    body.nombre = $('auth-nombre').value.trim();
    if (!body.nombre) return ($('auth-error').textContent = 'Escribe tu primer nombre');
    if (pin !== $('auth-pin2').value.trim()) return ($('auth-error').textContent = 'Los PIN no coinciden');
  }
  const b = $('btn-auth'); b.disabled = true;
  try {
    const s = await llamarFuncion('vial-auth', body);
    await sb.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
    $('form-auth').reset(); toast(modoRegistro ? '¡Cuenta creada!' : '¡Bienvenido!');
  } catch (err) { $('auth-error').textContent = err.message; }
  b.disabled = false;
});
async function loginGoogle() {
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: SITE + (enApp() ? '?app=1' : '') } });
  if (error) toast(errTxt(error));
}
async function salir() { await sb.auth.signOut(); location.reload(); }

async function alCambiarSesion(session) {
  S.user = session?.user || null;
  $('cuenta-anon').classList.toggle('hidden', !!S.user);
  $('cuenta-user').classList.toggle('hidden', !S.user);
  if (!S.user) { S.vehiculos = []; S.venc = []; S.zonas = []; pintarVehiculosHoy(); pintarVencimientos(); return; }
  // Perfil de Vial (se crea al primer ingreso, también con Google)
  let { data: p } = await sb.from('vial_perfiles').select('*').eq('user_id', S.user.id).maybeSingle();
  if (!p) {
    const md = S.user.user_metadata || {};
    const nombre = String(md.nombre || md.full_name || md.name || '').split(' ')[0].slice(0, 40) || null;
    await sb.from('vial_perfiles').insert({ user_id: S.user.id, nombre });
    ({ data: p } = await sb.from('vial_perfiles').select('*').eq('user_id', S.user.id).maybeSingle());
  }
  S.perfil = p || {};
  $('u-nombre').textContent = S.perfil.nombre || 'conductor';
  const em = S.user.email || '';
  $('u-contacto').textContent = em.endsWith('@wa.vial.evcarga') ? `Celular +${em.split('@')[0]}` : em;
  $('sw-noche').checked = S.perfil.aviso_noche !== false;
  $('btn-telegram').textContent = S.perfil.telegram_chat_id ? 'Desvincular' : 'Vincular';
  $('telegram-txt').textContent = S.perfil.telegram_chat_id ? '✅ Recibes avisos por Telegram.' : 'Si prefieres recibir los avisos en Telegram.';
  const { data: bot } = await sb.from('vial_config').select('valor').eq('clave', 'telegram_bot').maybeSingle();
  $('fila-telegram').classList.toggle('hidden', !bot && !S.perfil.telegram_chat_id);
  const { data: adm } = await sb.rpc('is_admin'); S.admin = !!adm;
  $('admin').classList.toggle('hidden', !S.admin);
  await Promise.all([cargarVehiculos(), cargarVencimientos(), cargarZonas(), cargarVotos()]);
  estadoPush();
  if (document.querySelector('#tab-cuenta.active')) { cargarRanking(); if (S.admin) cargarAdmin(); }
  if (pendienteReportar) { const t = pendienteReportar; pendienteReportar = null; if (t !== true) reportar(t); else abrirReportar(); }
}
function requiereSesion() { if (S.user) return true; toast('Ingresa para continuar (solo nombre, correo o celular y PIN)'); irA('cuenta'); return false; }

async function editarNombre() {
  formulario('Tu primer nombre', `<label>Primer nombre<input name="nombre" maxlength="40" required value="${esc(S.perfil.nombre || '')}"></label><button class="btn full">Guardar</button>`, async (f) => {
    const nombre = f.nombre.value.trim().split(/\s+/)[0];
    const { error } = await sb.from('vial_perfiles').update({ nombre }).eq('user_id', S.user.id);
    if (error) throw error; S.perfil.nombre = nombre; $('u-nombre').textContent = nombre;
  });
}
function cambiarPin() {
  formulario('Cambiar PIN', `<label>Nuevo PIN<input name="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required></label>
    <label>Repite el PIN<input name="pin2" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required></label><button class="btn full">Cambiar</button>`, async (f) => {
    if (f.pin.value !== f.pin2.value) throw new Error('Los PIN no coinciden');
    await llamarFuncion('vial-auth', { accion: 'cambiar_pin', pin: f.pin.value }); toast('PIN cambiado');
  });
}

// Formulario genérico en hoja inferior
function formulario(titulo, html, onSubmit) {
  $('form-titulo').textContent = titulo;
  const f = $('form-generico'); f.innerHTML = html + '<div class="error" id="fg-error"></div>';
  f.onsubmit = async (e) => {
    e.preventDefault(); const b = f.querySelector('button.btn'); if (b) b.disabled = true;
    try { await onSubmit(f); cerrar('hoja-form'); } catch (err) { $('fg-error').textContent = errTxt(err); }
    if (b) b.disabled = false;
  };
  abrir('hoja-form');
}

// =====================================================================
// VEHÍCULOS Y VENCIMIENTOS
// =====================================================================
async function cargarVehiculos() {
  const { data } = await sb.from('vial_vehiculos').select('*').order('id');
  S.vehiculos = data || [];
  $('lista-vehiculos').innerHTML = S.vehiculos.length ? S.vehiculos.map((v) => `<div><span><b>${esc(v.placa)}</b> ${esc(v.alias || '')}<br><span class="muted small">${esc([v.marca, v.modelo, v.anio].filter(Boolean).join(' '))}${v.exento ? ' · exento' : ''}</span></span>
    <span class="acc"><button class="btn sm ghost" onclick="abrirVehiculo(${v.id})">Editar</button><button class="btn sm danger" onclick="borrar('vial_vehiculos',${v.id},cargarVehiculos)">✕</button></span></div>`).join('')
    : '<div class="vacio">Agrega tu placa para saber al instante si puedes circular.</div>';
  pintarVehiculosHoy();
}
function abrirVehiculo(id) {
  const v = S.vehiculos.find((x) => x.id === id) || {};
  formulario(id ? 'Editar vehículo' : 'Nuevo vehículo', `
    <label>Placa<input name="placa" required maxlength="9" placeholder="PBA-1234" value="${esc(v.placa || '')}" autocapitalize="characters"></label>
    <label>Nombre corto (opcional)<input name="alias" maxlength="30" placeholder="Mi carro" value="${esc(v.alias || '')}"></label>
    <div class="grid2"><label>Marca<input name="marca" maxlength="30" value="${esc(v.marca || '')}"></label><label>Modelo<input name="modelo" maxlength="30" value="${esc(v.modelo || '')}"></label></div>
    <label>Año<input name="anio" type="number" min="1950" max="2100" value="${esc(v.anio || '')}"></label>
    <label class="switch"><input type="checkbox" name="exento" ${v.exento ? 'checked' : ''}> Exento de pico y placa (solo si te corresponde)</label>
    <button class="btn full">Guardar</button>`, async (f) => {
    const row = { placa: normPlaca(f.placa.value), alias: f.alias.value.trim() || null, marca: f.marca.value.trim() || null, modelo: f.modelo.value.trim() || null, anio: f.anio.value ? Number(f.anio.value) : null, exento: f.exento.checked };
    if (!/^[A-Z0-9-]{5,9}$/.test(row.placa)) throw new Error('Placa no válida');
    const { error } = id ? await sb.from('vial_vehiculos').update(row).eq('id', id) : await sb.from('vial_vehiculos').insert(row);
    if (error) throw error; await cargarVehiculos(); cargarVencimientos();
  });
}
async function borrar(tabla, id, recargar) {
  if (!confirm('¿Eliminar?')) return;
  const { error } = await sb.from(tabla).delete().eq('id', id);
  if (error) return toast(errTxt(error)); recargar();
}
async function cargarVencimientos() {
  if (!S.user) return pintarVencimientos();
  const { data } = await sb.from('vial_vencimientos').select('*').order('fecha');
  S.venc = data || []; pintarVencimientos();
}
function pintarVencimientos() {
  const el = $('lista-vencimientos');
  if (!S.user) { el.innerHTML = '<div class="vacio">Ingresa para guardar matrícula, revisión, seguro y licencia.</div>'; return; }
  const hoy = Date.parse(isoQ(ahoraQ()));
  el.innerHTML = S.venc.length ? S.venc.map((v) => {
    const d = Math.round((Date.parse(v.fecha) - hoy) / 86400e3);
    const veh = S.vehiculos.find((x) => x.id === v.vehiculo_id);
    const color = d < 0 ? 'var(--bad)' : d <= 15 ? '#b45309' : 'var(--ok)';
    return `<div><span><b>${VENC[v.tipo]}</b>${veh ? ` · ${esc(veh.placa)}` : ''}${v.nota ? ` · ${esc(v.nota)}` : ''}<br><span class="small" style="color:${color}">${d < 0 ? `Venció hace ${-d} días` : d === 0 ? 'Vence hoy' : `Vence en ${d} días`} (${v.fecha.split('-').reverse().join('/')})</span></span>
      <span class="acc"><button class="btn sm ghost" onclick="abrirVencimiento(${v.id})">Editar</button><button class="btn sm danger" onclick="borrar('vial_vencimientos',${v.id},cargarVencimientos)">✕</button></span></div>`;
  }).join('') : '<div class="vacio">Sin vencimientos guardados.</div>';
}
function abrirVencimiento(id) {
  if (!requiereSesion()) return;
  const v = S.venc.find((x) => x.id === id) || {};
  formulario(id ? 'Editar vencimiento' : 'Nuevo vencimiento', `
    <label>Tipo<select name="tipo">${Object.entries(VENC).map(([k, n]) => `<option value="${k}" ${v.tipo === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label>Vehículo<select name="veh"><option value="">— Ninguno (p. ej. licencia) —</option>${S.vehiculos.map((x) => `<option value="${x.id}" ${v.vehiculo_id === x.id ? 'selected' : ''}>${esc(x.placa)} ${esc(x.alias || '')}</option>`).join('')}</select></label>
    <label>Fecha de vencimiento<input name="fecha" type="date" required value="${esc(v.fecha || '')}"></label>
    <label>Nota (opcional)<input name="nota" maxlength="80" value="${esc(v.nota || '')}"></label>
    <button class="btn full">Guardar</button>`, async (f) => {
    const row = { tipo: f.tipo.value, vehiculo_id: f.veh.value ? Number(f.veh.value) : null, fecha: f.fecha.value, nota: f.nota.value.trim() || null };
    const { error } = id ? await sb.from('vial_vencimientos').update(row).eq('id', id) : await sb.from('vial_vencimientos').insert(row);
    if (error) throw error; cargarVencimientos();
  });
}

// =====================================================================
// MAPA Y REPORTES
// =====================================================================
function iniciarMapa() {
  if (map) return;
  map = L.map('map', { zoomControl: false }).setView(QUITO, 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  capaRadares = L.layerGroup().addTo(map); capaReportes = L.layerGroup().addTo(map);
  pintarReportes(); pintarRadares();
  if (S.pos) ponerYo(); else ubicar(false);
}
const icono = (t) => L.divIcon({ className: '', html: `<div class="pin" style="background:${TIPOS[t].c}">${TIPOS[t].e}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] });
async function cargarReportes() {
  const { data, error } = await sb.from('vial_reportes').select('id,tipo,lat,lng,zona,descripcion,foto,creado,expira,confirmaciones,negaciones,origen,autor,user_id')
    .gt('expira', new Date().toISOString()).eq('oculto', false).order('creado', { ascending: false }).limit(300);
  if (!error) { S.reportes = data || []; pintarReportes(); }
}
async function cargarRadares() {
  const { data } = await sb.from('vial_radares').select('*').eq('aprobado', true);
  S.radares = data || []; pintarRadares();
}
async function cargarVotos() {
  if (!S.user) return; const { data } = await sb.from('vial_votos').select('reporte_id,sigue');
  S.votos = Object.fromEntries((data || []).map((v) => [v.reporte_id, v.sigue]));
}
function popupHtml(r) {
  const t = TIPOS[r.tipo]; const mio = S.user && r.user_id === S.user.id; const voto = S.votos[r.id];
  return `<div class="pop"><h3>${t.e} ${t.n}</h3>
    <p class="muted small">${esc(r.zona || '')} · ${haceTxt(r.creado)}${r.autor ? ` · ${esc(r.autor)}` : ''}${r.origen === 'telegram' ? ' · vía Telegram' : ''}</p>
    ${r.descripcion ? `<p>${esc(r.descripcion)}</p>` : ''}${r.foto ? `<img src="${fotoUrl(r.foto)}" alt="Foto del reporte" loading="lazy">` : ''}
    <p class="small">👍 ${r.confirmaciones} siguen · 👎 ${r.negaciones} ya no</p>
    <div class="row">${mio ? `<button class="btn sm danger" onclick="borrarReporte(${r.id})">Borrar</button>`
      : `<button class="btn sm ${voto === true ? '' : 'ghost'}" onclick="votar(${r.id},true)">✔ Sigue ahí</button><button class="btn sm ${voto === false ? '' : 'ghost'}" onclick="votar(${r.id},false)">✖ Ya no está</button>`}
    <button class="btn sm ghost" onclick="compartirReporte(${r.id})">📤 Compartir</button></div></div>`;
}
function pintarReportes() {
  if (!capaReportes) { pintarCerca(); return; }
  capaReportes.clearLayers();
  for (const r of S.reportes) L.marker([r.lat, r.lng], { icon: icono(r.tipo) }).bindPopup(() => popupHtml(r), { maxWidth: 260 }).addTo(capaReportes);
  pintarCerca();
}
function pintarRadares() {
  if (!capaRadares) return; capaRadares.clearLayers();
  for (const r of S.radares) L.marker([r.lat, r.lng], { icon: L.divIcon({ className: '', html: '<div class="pin radar-fijo">📸</div>', iconSize: [30, 30], iconAnchor: [15, 15] }) })
    .bindPopup(`<div class="pop"><h3>📸 Radar fijo${r.velocidad ? ` · ${r.velocidad} km/h` : ''}</h3>${r.descripcion ? `<p>${esc(r.descripcion)}</p>` : ''}</div>`).addTo(capaRadares);
}
function enfocarReporte(id) {
  const r = S.reportes.find((x) => x.id === id); if (!r) return toast('Ese reporte ya expiró');
  irA('mapa'); map.setView([r.lat, r.lng], 16);
  capaReportes.eachLayer((m) => { const ll = m.getLatLng(); if (ll.lat === r.lat && ll.lng === r.lng) m.openPopup(); });
}
function toggleCerca() { $('cerca').classList.toggle('hidden'); pintarCerca(); }
function pintarCerca() {
  const el = $('cerca'); if (el.classList.contains('hidden')) return;
  const ref = S.pos || (map ? [map.getCenter().lat, map.getCenter().lng] : QUITO);
  const l = S.reportes.map((r) => ({ r, d: km(ref[0], ref[1], r.lat, r.lng) }))
    .sort((a, b) => (a.d + (Date.now() - new Date(a.r.creado)) / 3.6e6) - (b.d + (Date.now() - new Date(b.r.creado)) / 3.6e6)).slice(0, 40);
  el.innerHTML = `<div class="row between"><b>Cerca de ${S.pos ? 'mí' : 'el centro del mapa'}</b><button class="x" onclick="toggleCerca()">✕</button></div>` +
    (l.length ? `<div class="lista">${l.map(({ r, d }) => `<div onclick="enfocarReporte(${r.id})"><span>${TIPOS[r.tipo].e} <b>${TIPOS[r.tipo].n}</b><br><span class="muted small">${esc(r.zona || '')} · ${haceTxt(r.creado)}</span></span><span class="small">${d < 1 ? Math.round(d * 1000) + ' m' : d.toFixed(1) + ' km'}</span></div>`).join('')}</div>`
      : '<p class="vacio">No hay reportes activos. ¡Sé el primero en reportar!</p>');
}
function ubicar(centrar = true) {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition((p) => {
      S.pos = [p.coords.latitude, p.coords.longitude]; ponerYo(); if (centrar && map) map.setView(S.pos, 15); res(S.pos);
    }, () => res(null), { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 });
  });
}
function ponerYo() {
  if (!map || !S.pos) return;
  if (marcaYo) marcaYo.setLatLng(S.pos);
  else marcaYo = L.marker(S.pos, { icon: L.divIcon({ className: '', html: '<div class="pin yo"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).addTo(map);
}
async function centrarEnMi() { const p = await ubicar(true); if (!p) toast('Activa la ubicación del teléfono'); }

// ---------- reportar (2 toques) ----------
let pendienteReportar = null;
$('tipos').innerHTML = Object.entries(TIPOS).map(([k, t]) => `<button style="background:${t.c}22" onclick="reportar('${k}')"><span>${t.e}</span>${t.n}</button>`).join('');
function abrirReportar() {
  if (!S.user) { pendienteReportar = true; return requiereSesion(); }
  abrir('hoja-reportar'); ubicar(false);
}
async function zonaDe(lat, lng) {
  try {
    const c = new AbortController(); setTimeout(() => c.abort(), 3500);
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${lat}&lon=${lng}&accept-language=es`, { signal: c.signal });
    const a = (await r.json()).address || {};
    return [a.road, a.neighbourhood || a.suburb || a.quarter].filter(Boolean).join(', ').slice(0, 80) || null;
  } catch { return null; }
}
async function reportar(tipo) {
  if (!S.user) { pendienteReportar = tipo; return requiereSesion(); }
  cerrar('hoja-reportar'); toast('Obteniendo ubicación…', 9000);
  let pos = await ubicar(false);
  if (!pos) {
    if (!map) { irA('mapa'); }
    if (!confirm('No pudimos leer tu GPS. ¿Reportar en el centro del mapa?')) return;
    const c = map.getCenter(); pos = [c.lat, c.lng];
  }
  const zona = await zonaDe(pos[0], pos[1]);
  const { data, error } = await sb.from('vial_reportes').insert({ tipo, lat: pos[0], lng: pos[1], zona }).select('id,tipo,lat,lng,zona,creado').single();
  if (error) return toast(errTxt(error), 4000);
  ultimoReporte = data; fotoArchivo = null;
  $('enviado-txt').textContent = `${TIPOS[tipo].e} ${TIPOS[tipo].n}${zona ? ` · ${zona}` : ''}. Gracias por avisar.`;
  $('env-coment').value = ''; $('env-prev').classList.add('hidden'); $('env-foto').value = '';
  toast('¡Reportado!'); abrir('hoja-enviado'); cargarReportes();
}
$('env-foto').addEventListener('change', () => {
  const f = $('env-foto').files[0]; if (!f) return; fotoArchivo = f;
  const p = $('env-prev'); p.src = URL.createObjectURL(f); p.classList.remove('hidden');
});
async function comprimir(file) {
  const img = await createImageBitmap(file); const max = 1280; const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob((b) => res(b), 'image/webp', 0.72));
}
$('env-guardar').addEventListener('click', async () => {
  if (!ultimoReporte) return cerrar('hoja-enviado');
  const b = $('env-guardar'); b.disabled = true;
  try {
    const cambios = {}; const com = $('env-coment').value.trim(); if (com) cambios.descripcion = com;
    if (fotoArchivo) {
      const blob = await comprimir(fotoArchivo);
      const path = `reportes/${S.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
      const { error } = await sb.storage.from('vial').upload(path, blob, { contentType: 'image/webp' });
      if (error) throw error; cambios.foto = path;
    }
    if (Object.keys(cambios).length) { const { error } = await sb.from('vial_reportes').update(cambios).eq('id', ultimoReporte.id); if (error) throw error; }
    cerrar('hoja-enviado'); toast('Guardado'); cargarReportes();
  } catch (e) { toast(errTxt(e), 4000); }
  b.disabled = false;
});
$('env-wa').addEventListener('click', () => ultimoReporte && compartirReporte(ultimoReporte.id, ultimoReporte));
function compartirReporte(id, r0) {
  const r = r0 || S.reportes.find((x) => x.id === id); if (!r) return;
  const hora = new Date(r.creado).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Guayaquil' });
  const txt = `${TIPOS[r.tipo].e} *${TIPOS[r.tipo].n}*${r.zona ? ` en ${r.zona}` : ''} (${hora})\nMapa en vivo: ${SITE}?r=${r.id}`;
  compartir('Vial Quito', txt);
}
// Compartir con la hoja nativa del teléfono; si no existe, copiar el texto
function compartir(title, text) {
  if (navigator.share) return navigator.share({ title, text }).catch(() => {});
  navigator.clipboard?.writeText(text).then(() => toast('Texto copiado. Pégalo donde quieras.'), () => prompt('Copia este texto:', text));
}
async function votar(id, sigue) {
  if (!requiereSesion()) return;
  const p = await ubicar(false); if (!p) return toast('Necesitamos tu ubicación para confirmar (debes estar cerca)');
  const { error } = await sb.rpc('vial_votar', { p_reporte: id, p_sigue: sigue, p_lat: p[0], p_lng: p[1] });
  if (error) return toast(errTxt(error), 4000);
  S.votos[id] = sigue; toast(sigue ? '¡Gracias! Confirmado' : '¡Gracias! Lo marcamos'); map && map.closePopup(); cargarReportes();
}
async function borrarReporte(id) {
  if (!confirm('¿Borrar tu reporte?')) return;
  const { error } = await sb.from('vial_reportes').delete().eq('id', id);
  if (error) return toast(errTxt(error)); map && map.closePopup(); cargarReportes();
}

// =====================================================================
// ZONAS, AVISOS, TELEGRAM, RANKING
// =====================================================================
async function cargarZonas() {
  const { data } = await sb.from('vial_zonas').select('*').order('id'); S.zonas = data || [];
  $('lista-zonas').innerHTML = S.zonas.length ? S.zonas.map((z) => `<div><span><b>${esc(z.nombre)}</b><br><span class="muted small">Radio ${z.radio_m >= 1000 ? z.radio_m / 1000 + ' km' : z.radio_m + ' m'}</span></span>
    <span class="acc"><button class="btn sm danger" onclick="borrar('vial_zonas',${z.id},cargarZonas)">✕</button></span></div>`).join('')
    : '<div class="vacio">Aún no tienes zonas. Agrega casa o trabajo.</div>';
}
function abrirZona() {
  formulario('Nueva zona de alerta', `
    <label>Nombre<input name="nombre" maxlength="30" required placeholder="Casa, Trabajo, Av. Simón Bolívar…"></label>
    <label>Radio<select name="radio"><option value="1000">1 km</option><option value="2000" selected>2 km</option><option value="5000">5 km</option><option value="10000">10 km</option></select></label>
    <label>Ubicación<select name="donde"><option value="yo">Donde estoy ahora (GPS)</option><option value="mapa">Centro del mapa</option></select></label>
    <button class="btn full">Guardar zona</button>`, async (f) => {
    let p = null;
    if (f.donde.value === 'yo') { p = await ubicar(false); if (!p) throw new Error('No pudimos leer tu GPS. Elige "Centro del mapa".'); }
    else { if (!map) throw new Error('Abre primero el mapa y céntralo donde quieras'); const c = map.getCenter(); p = [c.lat, c.lng]; }
    const { error } = await sb.from('vial_zonas').insert({ nombre: f.nombre.value.trim(), radio_m: Number(f.radio.value), lat: p[0], lng: p[1] });
    if (error) throw error; cargarZonas();
    if (!$('sw-push').checked) toast('Activa las notificaciones para recibir los avisos', 4000);
  });
}
const b64ToBytes = (b) => { const s = atob((b + '==='.slice((b.length + 3) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
async function estadoPush() {
  const sw = $('sw-push');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { sw.disabled = true; sw.parentElement.title = 'No disponible en este navegador'; return; }
  const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
  sw.checked = !!sub && Notification.permission === 'granted';
}
$('sw-push').addEventListener('change', async (e) => {
  const on = e.target.checked;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (on) {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Permiso de notificaciones denegado');
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC) });
      const j = sub.toJSON();
      await sb.from('vial_push').delete().eq('endpoint', j.endpoint);
      const { error } = await sb.from('vial_push').insert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
      if (error && error.code !== '23505') throw error;
      toast('Notificaciones activadas');
    } else if (sub) {
      await sb.from('vial_push').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); toast('Notificaciones desactivadas');
    }
  } catch (err) { e.target.checked = !on; toast(errTxt(err), 4000); }
});
$('sw-noche').addEventListener('change', async (e) => {
  const { error } = await sb.from('vial_perfiles').update({ aviso_noche: e.target.checked }).eq('user_id', S.user.id);
  if (error) { e.target.checked = !e.target.checked; toast(errTxt(error)); }
});
async function vincularTelegram() {
  if (S.perfil.telegram_chat_id) {
    const { error } = await sb.from('vial_perfiles').update({ telegram_chat_id: null }).eq('user_id', S.user.id);
    if (error) return toast(errTxt(error)); S.perfil.telegram_chat_id = null; return alCambiarSesion((await sb.auth.getSession()).data.session);
  }
  const { data: cfg } = await sb.from('vial_config').select('valor').eq('clave', 'telegram_bot').maybeSingle();
  if (!cfg) return toast('El bot de Telegram estará disponible pronto');
  const { data: code, error } = await sb.rpc('vial_codigo_telegram'); if (error) return toast(errTxt(error));
  window.open(`https://t.me/${encodeURIComponent(cfg.valor)}?start=${code}`, '_blank');
  toast('Pulsa "Iniciar" en Telegram para vincular', 5000);
}
async function cargarRanking() {
  const { data } = await sb.rpc('vial_ranking');
  $('ranking').innerHTML = (data || []).length ? data.map((r, i) => `<div><span>${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} ${esc(r.nombre)}</span><b>${r.puntos} pts</b></div>`).join('')
    : '<div class="vacio">Esta semana aún no hay puntos. ¡Reporta y gana!</div>';
}

// =====================================================================
// SUGERENCIAS (con o sin cuenta; WhatsApp opcional para ser contactado)
// =====================================================================
function abrirSugerencia() {
  formulario('💡 Tu sugerencia', `
    <p class="muted small">¿Qué mejorarías, qué falta o qué falló? Todo nos ayuda.</p>
    <label>Sugerencia<textarea name="msg" rows="4" maxlength="1000" required></textarea></label>
    ${S.user ? '' : '<label>Tu nombre (opcional)<input name="nombre" maxlength="40"></label>'}
    <label>WhatsApp (opcional, solo si quieres que te contactemos)<input name="wa" inputmode="tel" maxlength="16" placeholder="09XXXXXXXX"></label>
    <button class="btn full">Enviar</button>`, async (f) => {
    const wa = f.wa.value.replace(/[^0-9+ ]/g, '').trim();
    if (wa && !/^[0-9+ ]{9,16}$/.test(wa)) throw new Error('Número de WhatsApp no válido');
    const nombre = S.user ? (S.perfil?.nombre || null) : (f.nombre.value.trim() || null);
    const { error } = await sb.from('vial_sugerencias').insert({ mensaje: f.msg.value.trim(), nombre, whatsapp: wa || null });
    if (error) throw error; toast('¡Gracias! Recibimos tu sugerencia');
  });
}

// =====================================================================
// ADMIN
// =====================================================================
let usuarios = [];
async function cargarAdmin() {
  const [rep, us, rad, fer, ver, tg, sug] = await Promise.all([
    sb.from('vial_reportes').select('id,tipo,zona,creado,expira,oculto,confirmaciones,negaciones,autor,origen').order('id', { ascending: false }).limit(40),
    sb.rpc('vial_admin_usuarios'),
    sb.from('vial_radares').select('*').order('aprobado').order('id', { ascending: false }),
    sb.from('vial_feriados').select('*').gte('fecha', isoQ(ahoraQ())).order('fecha'),
    sb.from('vial_app_versiones').select('*').order('version_code', { ascending: false }).limit(5),
    sb.from('vial_config').select('valor').eq('clave', 'telegram_bot').maybeSingle(),
    sb.from('vial_sugerencias').select('*').order('leida').order('id', { ascending: false }).limit(50),
  ]);
  const waLink = (n) => { let d = String(n).replace(/\D/g, ''); if (/^09\d{8}$/.test(d)) d = '593' + d.slice(1); return `https://wa.me/${d}`; };
  $('adm-sugerencias').innerHTML = (sug.data || []).map((s) => `<div><span>${s.leida ? '' : '🆕 '}<b>${esc(s.nombre || 'Anónimo')}</b> · <span class="muted small">${haceTxt(s.creado)}</span><br>${esc(s.mensaje)}${s.whatsapp ? `<br><a href="${waLink(s.whatsapp)}" target="_blank" rel="noopener">📞 ${esc(s.whatsapp)}</a>` : ''}</span>
    <span class="acc">${s.leida ? '' : `<button class="btn sm ghost" onclick="admLeida(${s.id})">Leída</button>`}<button class="btn sm danger" onclick="borrar('vial_sugerencias',${s.id},cargarAdmin)">✕</button></span></div>`).join('') || '<div class="vacio">Sin sugerencias</div>';
  $('adm-reportes').innerHTML = (rep.data || []).map((r) => {
    const activo = new Date(r.expira) > new Date();
    return `<div><span>${TIPOS[r.tipo].e} #${r.id} ${esc(r.zona || '')}<br><span class="muted small">${haceTxt(r.creado)} · ${esc(r.autor || '?')}${r.origen === 'telegram' ? ' (TG)' : ''} · 👍${r.confirmaciones} 👎${r.negaciones} · ${r.oculto ? 'OCULTO' : activo ? 'activo' : 'expirado'}</span></span>
    <span class="acc"><button class="btn sm ghost" onclick="admOcultar(${r.id},${!r.oculto})">${r.oculto ? 'Mostrar' : 'Ocultar'}</button><button class="btn sm danger" onclick="borrar('vial_reportes',${r.id},cargarAdmin)">✕</button></span></div>`;
  }).join('') || '<div class="vacio">Sin reportes</div>';
  usuarios = us.data || []; pintarUsuarios();
  $('adm-radares').innerHTML = (rad.data || []).map((r) => `<div><span>📸 ${r.velocidad ? r.velocidad + ' km/h · ' : ''}${esc(r.descripcion || '')}<br><span class="muted small">${r.aprobado ? 'aprobado' : 'SUGERIDO por usuario'} · ${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}</span></span>
    <span class="acc">${r.aprobado ? '' : `<button class="btn sm" onclick="admAprobarRadar(${r.id})">Aprobar</button>`}<button class="btn sm danger" onclick="borrar('vial_radares',${r.id},cargarAdmin)">✕</button></span></div>`).join('') || '<div class="vacio">Sin radares. Centra el mapa en uno y pulsa "+ En el mapa".</div>';
  $('adm-feriados').innerHTML = (fer.data || []).map((f) => `<div><span>${f.fecha.split('-').reverse().join('/')} · ${esc(f.nombre)}</span><button class="btn sm danger" onclick="admBorrarFeriado('${f.fecha}','${f.ciudad}')">✕</button></div>`).join('') || '<div class="vacio">Sin feriados próximos</div>';
  $('adm-versiones').innerHTML = (ver.data || []).map((v) => `<div><span><b>v${esc(v.version_name)}</b> (${v.version_code}) · ${v.estado}${v.obligatoria ? ' · obligatoria' : ''}<br><span class="muted small">${esc(v.notas || '')}</span></span></div>`).join('') || '<div class="vacio">Versión inicial 1.0</div>';
  $('tg-bot').value = tg.data?.valor || '';
}
function pintarUsuarios() {
  const q = ($('adm-buscar').value || '').toLowerCase();
  $('adm-usuarios').innerHTML = usuarios.filter((u) => !q || `${u.nombre} ${u.contacto}`.toLowerCase().includes(q)).slice(0, 50).map((u) => `<div><span><b>${esc(u.nombre || '—')}</b> ${u.bloqueado ? '⛔' : ''}<br><span class="muted small">${esc(u.contacto || '')} · ${u.reportes} reportes</span></span>
    <span class="acc"><button class="btn sm ghost" onclick="admPin('${u.user_id}')">PIN</button><button class="btn sm ${u.bloqueado ? '' : 'danger'}" onclick="admBloquear('${u.user_id}',${!u.bloqueado})">${u.bloqueado ? 'Desbloquear' : 'Bloquear'}</button></span></div>`).join('') || '<div class="vacio">Sin usuarios</div>';
}
async function admLeida(id) { const { error } = await sb.from('vial_sugerencias').update({ leida: true }).eq('id', id); if (error) toast(errTxt(error)); cargarAdmin(); }
async function admOcultar(id, oc) { const { error } = await sb.rpc('vial_admin_ocultar', { p_reporte: id, p_oculto: oc }); if (error) toast(errTxt(error)); cargarAdmin(); cargarReportes(); }
async function admBloquear(uid, b) { if (!confirm(b ? '¿Bloquear a este usuario? No podrá reportar.' : '¿Desbloquear?')) return; const { error } = await sb.rpc('vial_admin_bloquear', { p_user: uid, p_bloq: b }); if (error) toast(errTxt(error)); cargarAdmin(); }
function admPin(uid) {
  formulario('Nuevo PIN para el usuario', `<label>PIN de 4 dígitos<input name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" required></label><button class="btn full">Cambiar PIN</button>`, async (f) => {
    await llamarFuncion('vial-auth', { accion: 'admin_pin', user_id: uid, pin: f.pin.value }); toast('PIN cambiado. Compártelo con el usuario.');
  });
}
async function admAprobarRadar(id) { const { error } = await sb.from('vial_radares').update({ aprobado: true }).eq('id', id); if (error) toast(errTxt(error)); cargarAdmin(); cargarRadares(); }
async function admBorrarFeriado(fecha, ciudad) { const { error } = await sb.from('vial_feriados').delete().eq('fecha', fecha).eq('ciudad', ciudad); if (error) toast(errTxt(error)); cargarAdmin(); cargarReglas(); }
function abrirRadar(admin) {
  if (!requiereSesion()) return;
  if (!map) { irA('mapa'); return toast('Centra el mapa sobre el radar y vuelve a pulsar'); }
  const c = map.getCenter();
  formulario(admin ? 'Radar fijo (centro del mapa)' : 'Sugerir radar fijo', `<p class="muted small">Ubicación: ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)} (centro del mapa)</p>
    <label>Velocidad máxima (km/h)<input name="vel" type="number" min="10" max="130"></label>
    <label>Descripción<input name="desc" maxlength="120" placeholder="Av. Simón Bolívar sentido sur"></label><button class="btn full">Guardar</button>`, async (f) => {
    const { error } = await sb.from('vial_radares').insert({ lat: c.lat, lng: c.lng, velocidad: f.vel.value ? Number(f.vel.value) : null, descripcion: f.desc.value.trim() || null, aprobado: !!admin && S.admin });
    if (error) throw error; toast(admin ? 'Radar agregado' : 'Gracias, el admin lo revisará'); if (S.admin) cargarAdmin(); cargarRadares();
  });
}
$('form-feriado').addEventListener('submit', async (e) => {
  e.preventDefault(); const { error } = await sb.from('vial_feriados').insert({ fecha: $('fer-fecha').value, nombre: $('fer-nombre').value.trim() });
  if (error) return toast(errTxt(error)); e.target.reset(); cargarAdmin(); cargarReglas();
});
$('form-tg').addEventListener('submit', async (e) => {
  e.preventDefault(); const v = $('tg-bot').value.trim().replace(/^@/, '');
  const { error } = v ? await sb.from('vial_config').upsert({ clave: 'telegram_bot', valor: v }) : await sb.from('vial_config').delete().eq('clave', 'telegram_bot');
  toast(error ? errTxt(error) : 'Guardado');
});
$('form-version').addEventListener('submit', async (e) => {
  e.preventDefault(); if (!confirm('¿Compilar una nueva versión de la app y avisar a todos al terminar?')) return;
  const b = e.target.querySelector('button'); b.disabled = true;
  try {
    const r = await llamarFuncion('vial-admin', { accion: 'publicar_version', notas: $('ver-notas').value.trim(), obligatoria: $('ver-obligatoria').checked });
    toast(`Compilando v${r.version_name}… avisaremos al terminar`, 5000); e.target.reset(); cargarAdmin();
  } catch (err) { toast(err.message, 5000); }
  b.disabled = false;
});

// =====================================================================
// APP ANDROID: descarga, instalación y actualizaciones
// =====================================================================
function enApp() { return ls.get('app') === '1' || document.referrer.startsWith('android-app://'); }
async function revisarVersion() {
  const { data } = await sb.from('vial_app_versiones').select('version_code,version_name,notas,obligatoria,apk_url').eq('estado', 'publicada').order('version_code', { ascending: false }).limit(1);
  const v = data?.[0]; const mia = Number(ls.get('appv') || 1);
  const pide = new URLSearchParams(location.search).has('actualizar');
  if (!v || (!enApp() && !pide)) return;
  if (v.version_code <= mia && !pide) return;
  const url = v.apk_url || APK_URL;
  $('banner-update-txt').textContent = `📲 Nueva versión ${v.version_name}${v.notas ? `: ${v.notas}` : ''}`;
  $('banner-update-btn').href = url; $('banner-update').classList.remove('hidden');
  if (v.obligatoria && enApp() && v.version_code > mia && confirm(`Hay una actualización obligatoria (v${v.version_name}). ¿Descargar ahora?`)) location.href = url;
}
let promptInstalar = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); promptInstalar = e; if (!enApp()) $('btn-instalar').classList.remove('hidden'); });
$('btn-instalar').addEventListener('click', async () => { if (!promptInstalar) return; promptInstalar.prompt(); await promptInstalar.userChoice; promptInstalar = null; $('btn-instalar').classList.add('hidden'); });
function compartirApp() {
  const txt = `🚦 Vial Quito: pico y placa, vencimientos y reportes de tránsito en vivo.\n${SITE}\n⚡ Cargadores EV: https://evcarga.github.io/`;
  compartir('Vial Quito', txt);
}

// =====================================================================
// INICIO
// =====================================================================
async function cargarReglas() {
  const [r, f] = await Promise.all([sb.from('vial_reglas_pico_placa').select('*'), sb.from('vial_feriados').select('*')]);
  S.reglas = r.data || []; S.feriados = f.data || [];
  try { ls.set('reglas', JSON.stringify({ r: S.reglas, f: S.feriados })); } catch {}
  pintarPicoPlaca();
}
(async function inicio() {
  const qs = new URLSearchParams(location.search);
  if (qs.get('app') === '1') { ls.set('app', '1'); if (qs.get('v')) ls.set('appv', qs.get('v')); }
  if (!enApp() && /android/i.test(navigator.userAgent)) $('btn-apk').classList.remove('hidden');
  try { const c = JSON.parse(ls.get('reglas') || 'null'); if (c) { S.reglas = c.r; S.feriados = c.f; } } catch {}
  pintarPicoPlaca(); pintarVencimientos();
  setInterval(pintarPicoPlaca, 30000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  sb.auth.onAuthStateChange((ev, session) => { if (['SIGNED_IN', 'SIGNED_OUT', 'INITIAL_SESSION'].includes(ev)) setTimeout(() => alCambiarSesion(session), 0); });
  await Promise.all([cargarReglas(), cargarReportes(), cargarRadares()]);
  sb.channel('vial-reportes').on('postgres_changes', { event: '*', schema: 'public', table: 'vial_reportes' }, () => {
    clearTimeout(cargarReportes.t); cargarReportes.t = setTimeout(cargarReportes, 800);
  }).subscribe();
  setInterval(cargarReportes, 120000); // por si se pierde la conexión en vivo
  revisarVersion();

  if (qs.get('r')) enfocarReporte(Number(qs.get('r')));
  else if (qs.get('tab')) irA(qs.get('tab'));
  if (qs.get('reportar')) abrirReportar();
  if (location.hash.includes('access_token') || qs.has('code')) history.replaceState(null, '', location.pathname + (enApp() ? '?app=1' : ''));
})();
