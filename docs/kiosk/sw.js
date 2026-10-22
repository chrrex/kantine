'use strict';
/**
 * Service Worker für das Kantinen-Tablet: Die Seite startet auch ohne WLAN
 * (z. B. nach einem Neustart des Tablets während eines WLAN-Ausfalls).
 * Immer zuerst das Netz, nur bei Ausfall die gespeicherte Kopie.
 */
const CACHE = 'kantine-kiosk-v1';
const ASSETS = [
  '/kiosk',
  '/kiosk/kiosk.css',
  '/kiosk/kiosk.js',
  '/shared/fonts.css',
  '/shared/datenschutz.css',
  '/shared/privacy-render.js',
  '/shared/sgl-logo.svg',
  '/shared/fonts/source-sans-3-latin-300-normal.woff2',
  '/shared/fonts/source-sans-3-latin-400-normal.woff2',
  '/shared/fonts/source-sans-3-latin-600-normal.woff2',
  '/shared/fonts/source-sans-3-latin-700-normal.woff2',
];
const CACHE_API = ['/api/privacy'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const isPage = req.mode === 'navigate' && (url.pathname === '/kiosk' || url.pathname === '/kiosk/');
  const key = isPage ? '/kiosk' : url.pathname;
  if (!isPage && !ASSETS.includes(key) && !CACHE_API.includes(key)) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return res;
    } catch {
      const cached = await caches.match(key);
      if (cached) return cached;
      throw new Error('offline');
    }
  })());
});
