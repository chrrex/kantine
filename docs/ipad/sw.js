'use strict';
/* Service Worker der iPad-Version.
   Hält alle Dateien der App auf dem Gerät, damit die Kantine ohne WLAN läuft.
   Updates gibt es nur auf Knopfdruck in der Verwaltung („Nach Update suchen“):
   Diese Datei bleibt bei jedem Update gleich, die Version steht in version.json.
   Die Daten (Mitarbeitende, Buchungen) liegen nicht hier, sondern in IndexedDB. */
const META = 'kantine-meta';
const PREFIX = 'kantine-app-';
let current = null;

const base = () => self.registration.scope;
async function getCurrent() {
  if (current) return current;
  const r = await (await caches.open(META)).match('current');
  current = r ? await r.text() : null;
  return current;
}
async function setCurrent(v) {
  await (await caches.open(META)).put('current', new Response(v));
  current = v;
}
async function fetchManifest() {
  const res = await fetch(new URL('version.json', base()), { cache: 'no-store' });
  if (!res.ok) throw new Error(`Update-Server antwortet nicht (${res.status}).`);
  return res.json();
}
async function installVersion(man) {
  const name = PREFIX + man.version;
  const cache = await caches.open(name);
  await cache.addAll(man.files.map((f) => new Request(new URL(f, base()), { cache: 'reload' })));
  await setCurrent(man.version);
  for (const key of await caches.keys()) {
    if ((key.startsWith(PREFIX) && key !== name) || key.startsWith('kantine-ipad-')) await caches.delete(key);
  }
  return man;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Nur beim allerersten Einrichten automatisch laden
    if (!(await getCurrent())) await installVersion(await fetchManifest());
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('/version.json')) return;
  event.respondWith((async () => {
    const v = await getCurrent();
    if (v) {
      const hit = await (await caches.open(PREFIX + v)).match(req, { ignoreSearch: true });
      if (hit) return hit;
    }
    try { return await fetch(req); } catch (err) {
      if (req.mode === 'navigate' && v) {
        const fallback = await (await caches.open(PREFIX + v)).match(new URL('kiosk/', base()));
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});

self.addEventListener('message', (event) => {
  const port = event.ports[0];
  if (!port) return;
  event.waitUntil((async () => {
    try {
      if (event.data?.type === 'check') {
        const man = await fetchManifest();
        const cur = await getCurrent();
        port.postMessage({ ok: true, current: cur, latest: man.version, label: man.label, available: man.version !== cur });
      } else if (event.data?.type === 'install') {
        const man = await installVersion(await fetchManifest());
        port.postMessage({ ok: true, version: man.version, label: man.label });
      }
    } catch (err) {
      port.postMessage({ ok: false, error: String(err?.message || err) });
    }
  })());
});
