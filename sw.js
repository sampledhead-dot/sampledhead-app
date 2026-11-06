/* SampledHeadApp 1.36: funciona sin conexión.
   - Archivos de la app: primero la red (así siempre ves la última versión) y, si no hay conexión, la copia guardada.
   - Ficheros kit_*.bin, inst_*.bin y kits_index.json (kits de batería y muestras de bajos y teclas): se guardan la primera vez que se usan y después salen de la copia;
     esta copia se conserva al cambiar de versión (cada fichero lleva ?v=… para renovarlo cuando cambie). kits_index.json va primero por la red.
   - Tipografías de Google: se guardan la primera vez y después salen de la copia.
   Los kits del usuario NO pasan por aquí: están en la base de datos local del navegador (IndexedDB). */
const VERSION = 'sampledhead-v1.36';
const KITS = 'sampledhead-kits';
const SHELL = ['./', 'index.html', 'manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== KITS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    const isKit = /\/(kit|inst)_[^/]+\.bin$/.test(url.pathname), isIdx = /\/kits_index\.json$/.test(url.pathname);
    if (isKit) {
      // muestras: primero la copia guardada; si no está, se baja y se guarda
      e.respondWith(
        caches.open(KITS).then(c => c.match(req).then(hit => hit || fetch(req).then(res => {
          if (res.ok) c.put(req, res.clone());
          return res;
        })))
      );
      return;
    }
    const cacheName = isIdx ? KITS : VERSION;
    e.respondWith(
      fetch(req.url, { cache: 'reload' }).then(res => {   // salta la caché HTTP (GitHub Pages guarda 10 min)
        if (res.ok) { const copy = res.clone(); caches.open(cacheName).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => caches.open(cacheName).then(c => c.match(req, { ignoreSearch: cacheName === VERSION })).then(r => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
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
