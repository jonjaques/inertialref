/*
 * Service worker.
 *
 * The game is offline-first: once the application assets are cached, a
 * single-player universe needs no server at all. It does not need one for
 * *content* either — the universe is a pure function of a seed, so there is
 * nothing to download beyond the code itself, and saves live in IndexedDB.
 *
 * Deliberately hand-written rather than generated. The whole policy is fifteen
 * lines, it has no build-manifest dependency to go stale, and being able to read
 * it matters more than being able to configure it.
 *
 * Two strategies, chosen by what the request is:
 *
 *   - Navigations: network first, cache as fallback. A deploy should reach a
 *     player who is online; a player who is offline should still get in.
 *   - Everything else same-origin: cache first. Vite content-hashes asset
 *     filenames, so a cached asset can never be stale — a changed file has a
 *     different name.
 */

const CACHE = 'inertialref-v1'
const PRECACHE = ['/', '/index.html', '/favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one missing optional file cannot fail the whole install.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          void caches.open(CACHE).then((cache) => cache.put(request, copy))
          return response
        })
        .catch(() => caches.match(request).then((cached) => cached ?? caches.match('/index.html'))),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached !== undefined) return cached
      return fetch(request).then((response) => {
        // Only cache real, complete responses; an opaque or error response
        // cached here would be served forever.
        if (response.ok && response.type === 'basic') {
          const copy = response.clone()
          void caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
    }),
  )
})
