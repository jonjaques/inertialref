/*
 * Service worker.
 *
 * The game is offline-first: once the application assets are cached, a
 * single-player universe needs no server at all. Nearly all of the content is a
 * pure function of a seed, so there is very little to download beyond the code —
 * the one exception is the packed star catalog, which is a content-hashed
 * asset under /assets and is therefore covered by the cache-first branch below
 * like any other. Saves live in IndexedDB.
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
/*
 * The handful of unhashed files a cold offline launch cannot start without.
 *
 * Deliberately short. Every other unhashed file in `public/` — the icons, the
 * share card, robots.txt, llms.txt — is reached by something that is already
 * online when it asks, and the stale-while-revalidate branch below covers them
 * the first time they are. Precaching them would trade a slower install for
 * nothing. `/manifest.webmanifest` is in, because an installed application is
 * launched *from* the manifest and that launch may be the offline one.
 */
const PRECACHE = ['/', '/index.html', '/favicon.svg', '/manifest.webmanifest']

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

/**
 * Cache-first, because the content at these paths cannot change under the name.
 *
 * `/assets/` is Vite's content-hashed output, immutable by construction.
 * `/media/` is the build-time pull from R2 (`scripts/media.mjs`) — a fixed
 * reference track, not a hashed name, and it is here for a second reason:
 * stale-while-revalidate would re-fetch 2.7 MB of audio in the background on
 * every single load of the site to discover it had not changed.
 */
const isImmutable = (pathname) =>
  pathname.startsWith('/assets/') || pathname.startsWith('/media/')

/*
 * Source maps sit next to hashed chunks, so `/assets/` would otherwise
 * cache-first them. They are a debugger fetch, not a cold-start asset:
 * DevTools asks the network when a breakpoint needs them, and pinning the
 * original source in every player's Cache Storage buys nothing the game
 * uses offline.
 */
const isSourceMap = (pathname) => pathname.endsWith('.map')

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
    caches.keys().then(async (keys) => {
      // Only this application's caches. Deleting every key would be a
      // service worker reaching outside its own concern, and this origin
      // may not always hold one app.
      const old = keys.filter(
        (key) => key.startsWith(CACHE_PREFIX) && key !== CACHE,
      )
      /*
       * Rescue the immutable assets before the old caches go. On the first
       * online visit after a deploy the page is still controlled by the
       * *previous* worker, so the new build's hashed chunks — and the star
       * catalog — were fetched through it and stored under the previous
       * build's cache name. Deleting that cache outright threw away exactly
       * the files the next offline launch needs, so offline-first only
       * recovered on a second online visit. Content-hashed names cannot be
       * stale, which is what makes the copy unconditionally safe.
       */
      const target = await caches.open(CACHE)
      for (const key of old) {
        const source = await caches.open(key)
        for (const request of await source.keys()) {
          if (!isImmutable(new URL(request.url).pathname)) continue
          if ((await target.match(request)) !== undefined) continue
          const response = await source.match(request)
          if (response !== undefined) await target.put(request, response)
        }
      }
      await Promise.all(old.map((key) => caches.delete(key)))
      await self.clients.claim()
    }),
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
  if (isSourceMap(url.pathname)) return
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

/**
 * Whether a 200 is actually the application shell wearing another file's URL.
 *
 * The Worker serves this origin with `not_found_handling:
 * single-page-application`, so a request for a staged file the asset store does
 * not have yet comes back as `index.html` with a **200** — and every navigation
 * is answered in its own branch above, so nothing that reaches here is
 * legitimately HTML. Stored, that shell is served from Cache Storage in place
 * of the file for the life of the cache: `docs/content.ts` asks for a page's
 * JSON, gets markup, and the reader sees "no such page" for a page that exists
 * until the next deploy rotates the cache name.
 */
const isShell = (response) =>
  (response.headers.get('content-type') ?? '').startsWith('text/html')

/** Fetch, and keep the answer if it is one worth keeping. */
function fetchAndStore(request, event) {
  return fetch(request).then((response) => {
    // Only real, complete, same-origin responses. An opaque or error response
    // stored here would be served forever in place of the thing it failed to be.
    if (response.ok && response.type === 'basic' && !isShell(response)) {
      const copy = response.clone()
      event.waitUntil(caches.open(CACHE).then((c) => c.put(request, copy)))
    }
    return response
  })
}
