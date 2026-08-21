/*
 * Service worker.
 *
 * The game is offline-first: once the application assets are cached, a
 * single-player universe needs no server at all. It does not need one for
 * *content* either — the universe is a pure function of a seed, so there is
 * nothing to download beyond the code itself, and saves live in IndexedDB.
 *
 * Deliberately hand-written rather than generated. The whole policy is one
 * screen, it has no build-manifest dependency to go stale, and being able to
 * read it matters more than being able to configure it.
 *
 * Four strategies, chosen by what the request is:
 *
 *   - /api and /ws: not touched at all. Live state.
 *   - Navigations: network first, cache as fallback. A deploy should reach a
 *     player who is online; a player who is offline should still get in.
 *   - /assets/*: cache first. Vite content-hashes those filenames, so a cached
 *     one can never be stale — a changed file has a different name.
 *   - Everything else same-origin: stale-while-revalidate. Fast like the cache,
 *     eventually correct like the network.
 *
 * This file is copied verbatim out of `public/` and never goes through the
 * bundler, so it cannot import anything. Every constant it shares with the rest
 * of the client is repeated here with a pointer to the original.
 */

/*
 * The cache is named after the build that installed it.
 *
 * A fixed name has to be bumped by hand, and the failure mode of forgetting is
 * invisible: dead chunks from every past deploy accumulate forever, and a
 * precached `/index.html` outlives the build it describes. There is no way to
 * inject a constant into this file, because it is not compiled — so the build
 * id arrives on the registration URL, which `main.tsx` supplies. `dev` is the
 * fallback for anyone who opens `/sw.js` directly.
 */
const BUILD = new URL(self.location.href).searchParams.get('build') ?? 'dev'
const CACHE_PREFIX = 'inertialref-'
const CACHE = `${CACHE_PREFIX}${BUILD}`
const PRECACHE = ['/', '/index.html', '/favicon.svg', '/icons.svg']

/*
 * Paths that are state rather than content, kept in step by hand with
 * `API_PREFIX` and `SOCKET_PATH` in packages/protocol/src/net.ts.
 *
 * Without this the cache-first branch below pins the first `/api` response for
 * the lifetime of the cache — and because the cache survives a reload, that
 * presents as "the server is stuck" with a perfectly healthy server. The Worker
 * also sends `no-store` and the client also asks for `no-store`; three layers,
 * because this failure is silent, durable, and indistinguishable from an
 * outage.
 *
 * An `api.` subdomain would have avoided it for free — the handler already
 * returns early for cross-origin requests — but a second hostname means CORS
 * preflights, a second deploy target and a second origin for the socket, which
 * is a permanent cost in place of these three lines.
 */
const isLive = (pathname) =>
  pathname === '/api' || pathname.startsWith('/api/') || pathname === '/ws'

/** Vite emits content-hashed filenames here, so these are immutable by name. */
const isImmutable = (pathname) => pathname.startsWith('/assets/')

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one missing optional file cannot fail the whole install.
      .then((cache) =>
        Promise.allSettled(PRECACHE.map((url) => cache.add(url))),
      )
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          // Only this application's caches. Deleting every key would be a
          // service worker reaching outside its own concern, and this origin
          // may not always hold one app.
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  /*
   * A request Chrome's devtools makes while inspecting the cache. Answering it
   * from a normal fetch throws, and the throw surfaces as a failed page load
   * rather than as anything to do with devtools.
   */
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin')
    return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (isLive(url.pathname)) return
  /*
   * Range requests, for the material sets the design admits later. A 206 stored
   * whole is served back as if it were the complete resource, which corrupts
   * every subsequent range read of it — and nothing about that looks like a
   * caching bug from the outside.
   */
  if (request.headers.has('range')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          event.waitUntil(caches.open(CACHE).then((c) => c.put(request, copy)))
          return response
        })
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached ?? caches.match('/index.html'))
            .then(
              (cached) =>
                cached ??
                new Response('offline, and nothing cached to start from', {
                  status: 503,
                  headers: { 'content-type': 'text/plain' },
                }),
            ),
        ),
    )
    return
  }

  if (isImmutable(url.pathname)) {
    event.respondWith(
      caches
        .match(request)
        .then((cached) => cached ?? fetchAndStore(request, event)),
    )
    return
  }

  /*
   * Stale-while-revalidate for everything else — the hand-written files in
   * `public/`, which have no hash in their names and therefore *can* go stale.
   * Cache-first here was correct while `favicon.svg` was the only one; the
   * moment a second unhashed asset changes, cache-first means it never reaches
   * anyone who has already loaded the game once.
   */
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetchAndStore(request, event).catch(
        () =>
          cached ??
          new Response('', { status: 504, statusText: 'offline, not cached' }),
      )
      if (cached === undefined) return network
      event.waitUntil(network)
      return cached
    }),
  )
})

/** Fetch, and keep the answer if it is one worth keeping. */
function fetchAndStore(request, event) {
  return fetch(request).then((response) => {
    // Only real, complete, same-origin responses. An opaque or error response
    // stored here would be served forever in place of the thing it failed to be.
    if (response.ok && response.type === 'basic') {
      const copy = response.clone()
      event.waitUntil(caches.open(CACHE).then((c) => c.put(request, copy)))
    }
    return response
  })
}
