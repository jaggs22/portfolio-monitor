/* Service worker: offline shell plus fresh data.
   Bump VERSION whenever a shell file changes so installed copies pick it up. */
const VERSION = 'v23';
const SHELL_CACHE = 'shell-' + VERSION;
const DATA_CACHE = 'data-' + VERSION;
const SHELL = [
  './',
  'styles.css',
  'app.js',
  'lib.js',
  'engine.js',
  'ui.js',
  'company.js',
  'report.js',
  'onboard.js',
  'chat.js',
  'icons/favicon.svg',
  'fin.js',
  'charts.js',
  'dataapi.js',
  'config.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Only this app's own old caches. The on-device model's weights live in other caches and must survive updates.
      .then((keys) => Promise.all(keys.filter((k) => /^(shell|data)-/.test(k) && k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Data files: network first so the digest is fresh, cache as the offline fallback.
  // Live quotes are never served from cache: a stale price is worse than none.
  if (url.pathname === '/api/live') return;
  if (url.pathname.includes('/data/') || url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Page loads: network first, cached shell as the offline fallback. Cloudflare redirects /index.html to /,
  // and a browser refuses to show a redirected response for a page load, so every navigation is answered
  // with the shell stored under './' (never a redirected copy).
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => (res.redirected ? clean(res) : res))
        .catch(() => caches.match('./'))
    );
    return;
  }

  // Other shell files: serve from cache immediately, refresh in the background.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const refresh = fetch(req)
        .then((res) => {
          if (res.ok && !res.redirected) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || refresh;
    })
  );
});

/* A redirected response cannot answer a navigation, so copy its body into a fresh, non-redirected one. */
function clean(res) {
  return res.blob().then((body) => new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers }));
}
