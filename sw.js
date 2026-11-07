/* SampledHeadApp 1.51: funciona sin conexión.
   - Archivos de la app: primero la red (así siempre ves la última versión) y, si no hay conexión, la copia guardada.
   - Tipografías de Google: se guardan la primera vez y después salen de la copia.
   Los kits NO pasan por aquí: están en la base de datos local del navegador (IndexedDB). */
const VERSION = 'sampledhead-v1.51';
const SHELL = ['./', 'index.html', 'manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req.url, { cache: 'reload' }).then(res => {   // salta la caché HTTP (GitHub Pages guarda 10 min)
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
    );
  } else if (/(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }))
    );
  }
  // el resto (por ejemplo, audio cargado desde un enlace) va directo a la red
});
