/* Service worker: rende l'app apribile e istantanea anche senza rete.
   Il guscio (HTML/CSS/JS/icone) sta in cache; le previsioni no —
   quelle le conserva l'app in localStorage, così sa dirti quanto
   sono vecchie invece di spacciarle per fresche. */

const CACHE = 'meteo-v2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './fonts/manrope-var.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // le API passano dirette

  /* Rete per prima, cache come rete di salvataggio.
     Così una modifica ai file si vede subito al ricaricamento,
     e senza campo l'app si apre lo stesso con l'ultima copia.
     Il timeout evita che una rete lenta blocchi l'avvio. */
  e.respondWith((async () => {
    const fresh = fetch(req).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    });
    try {
      return await Promise.race([
        fresh,
        new Promise((_, rej) => setTimeout(() => rej(new Error('rete lenta')), 2500)),
      ]);
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try { return await fresh; } catch (e2) { return Response.error(); }
    }
  })());
});
