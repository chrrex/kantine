'use strict';
/* Service Worker der iPad-Version: hält alle Dateien der App auf dem Gerät,
   damit die Kantine auch ohne WLAN startet. Daten liegen nicht hier, sondern in IndexedDB. */
const VERSION = 'mwoomcvk';
const FILES = ["./","./kiosk/","./admin/","./admin/admin.css","./admin/admin.js","./admin/index.html","./index.html","./ipad/Beispiel_Mitarbeiterliste.csv","./ipad/apple-touch-icon.png","./ipad/exceljs.min.js","./ipad/icon-512.png","./ipad/local-admin.js","./ipad/local-api.js","./ipad/local-kiosk.js","./ipad/local.css","./kiosk/index.html","./kiosk/kiosk.css","./kiosk/kiosk.js","./kiosk/manifest.webmanifest","./shared/datenschutz.css","./shared/datenschutz.html","./shared/datenschutz.js","./shared/fonts/source-sans-3-latin-300-normal.woff2","./shared/fonts/source-sans-3-latin-400-normal.woff2","./shared/fonts/source-sans-3-latin-600-normal.woff2","./shared/fonts/source-sans-3-latin-700-normal.woff2","./shared/fonts.css","./shared/privacy-default.txt","./shared/privacy-render.js","./shared/sgl-logo.svg"];
const CACHE = `kantine-ipad-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('kantine-ipad-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(req); } catch (err) {
      if (req.mode === 'navigate') return (await cache.match('./kiosk/')) || Response.error();
      throw err;
    }
  })());
});
