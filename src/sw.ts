/// <reference lib="webworker" />

/**
 * CrepeLite service worker (vite-plugin-pwa `injectManifest`).
 *
 * Minimal, dependency-free app-shell precache: enough to boot the PWA offline
 * and to drive the "update available" prompt. Runtime caching strategies for
 * media and Firestore payloads are part of the Phase 10 work.
 */
type PrecacheEntry = string | { url: string; revision?: string | null };
declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: PrecacheEntry[] };

const MANIFEST = self.__WB_MANIFEST;
const first = MANIFEST[0];
const CACHE = `crepelite-shell-v${(typeof first === 'object' ? first?.revision : null) ?? '1'}`;
const SHELL = MANIFEST.map((e: PrecacheEntry) => (typeof e === 'string' ? e : e.url));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Individually, so one missing asset cannot fail the whole install.
      Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('crepelite-shell-') && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // App shell: serve index.html for navigations so deep links work offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(async () => (await caches.match('/index.html')) ?? Response.error()));
    return;
  }

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

// The app shows its own prompt and posts this when the user accepts.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

export {};
