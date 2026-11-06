// Service worker de Vial: funciona sin conexión (pantalla principal) y muestra notificaciones push.
const CACHE = 'vial-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'privacidad.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Archivos propios: primero la red (siempre lo último), si no hay red, la copia guardada
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !u.pathname.startsWith('/vial/')) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Vial', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Vial Quito', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    tag: d.tag, renotify: !!d.tag, data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
    for (const w of ws) if (w.url.includes('/vial/') && 'focus' in w) { w.navigate(url); return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
