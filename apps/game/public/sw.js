/*
 * Offline delivery for the static site. Saves live in IndexedDB; generated
 * terrain, galaxy and renderer caches belong to their runtime producers.
 *
 * HTML is network-first and keyed by route. Hashed assets are cache-first;
 * unhashed media is cache-first within one build. Other public files use
 * stale-while-revalidate. Live state and explicit cache bypasses go to network.
 * This file is copied verbatim, so the build id arrives on the script URL.
 */
const BUILD = new URL(self.location.href).searchParams.get('build') ?? 'dev'
const CACHE_PREFIX = 'inertialref-'
const CACHE = `${CACHE_PREFIX}${BUILD}`
const PRECACHE = [
  '/',
  '/play/solo',
  '/planetarium',
  '/cinema',
  '/favicon.svg',
  '/manifest.webmanifest',
]

// Keep these paths in step with packages/protocol/src/net.ts.
const isLive = (pathname) =>
  pathname === '/api' || pathname.startsWith('/api/') || pathname === '/ws'
const isImmutable = (pathname) => pathname.startsWith('/assets/')
const isShell = (response) =>
  (response.headers.get('content-type') ?? '').startsWith('text/html')
const canStore = (response) =>
  response.status === 200 &&
  response.type === 'basic' &&
  !/\b(?:no-store|private)\b/i.test(response.headers.get('cache-control') ?? '')

/** Queries select client state; each pathname has one prerendered document. */
const navigationKey = (url) =>
  `${url.origin}${url.pathname.replace(/\/+$/, '') || '/'}`
const pastBuilds = async () =>
  (await caches.keys()).filter(
    (key) => key.startsWith(CACHE_PREFIX) && key !== CACHE,
  )

// Storage denial or quota pressure must not turn a successful fetch into an
// outage. Cache writes are best effort; IndexedDB saves are never involved.
const read = async (key, name = CACHE) => {
  try {
    return await (await caches.open(name)).match(key)
  } catch {
    return undefined
  }
}
const store = async (key, response) => {
  try {
    await (await caches.open(CACHE)).put(key, response)
  } catch {
    // The online response still belongs to the caller.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      const current = clients
        .map((client) => new URL(client.url))
        .filter(
          (url) => url.origin === self.location.origin && !isLive(url.pathname),
        )
        .map(navigationKey)
      // Fetch with reload so an HTTP-cached document cannot seed a new build.
      // A missing route or unavailable storage must not reject installation.
      await Promise.allSettled(
        [...new Set([...PRECACHE, ...current])].map(async (url) => {
          const response = await fetch(url, { cache: 'reload' })
          if (canStore(response)) await store(url, response)
        }),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        await caches.open(CACHE)
        const old = await pastBuilds()
        // A new page can load through the previous controller during an
        // update. Keep that cache for its hashed assets, then promote only
        // requested files. Copying everything retains every obsolete model
        // and chunk forever. CacheStorage keys are in creation order.
        await Promise.all(old.slice(0, -1).map((key) => caches.delete(key)))
      } catch {
        // Claim still permits online use when browser storage is unavailable.
      }
      await self.clients.claim()
    })(),
  )
})

/** Only hashed assets may cross a build boundary. */
async function immutable(request, background) {
  const cached = await read(request)
  if (cached !== undefined) return cached
  try {
    const previous = (await pastBuilds()).at(-1)
    if (previous !== undefined) {
      const inherited = await read(request, previous)
      if (inherited !== undefined) {
        background.push(store(request, inherited.clone()))
        return inherited
      }
    }
  } catch {
    // Cache discovery can fail independently of a network request.
  }
  return fetchAndStore(request, background)
}

async function fetchAndStore(request, background) {
  const response = await fetch(request)
  if (canStore(response) && !isShell(response))
    background.push(store(request, response.clone()))
  return response
}

async function navigation(request, url, background) {
  const key = navigationKey(url)
  let response
  try {
    response = await fetch(request)
    if (canStore(response) && isShell(response))
      background.push(store(key, response.clone()))
    // A real 404 must remain a 404; only outages use an offline document.
    if (response.status < 500) return response
  } catch {
    // The route's own HTML is the only safe hydration fallback.
  }
  return (
    (await read(key)) ??
    response ??
    new Response('offline, and nothing cached to start from', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    })
  )
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    isLive(url.pathname) ||
    url.pathname === '/sw.js' ||
    url.pathname.endsWith('.map') ||
    request.headers.has('range') ||
    request.cache === 'no-store' ||
    request.cache === 'reload' ||
    (request.cache === 'only-if-cached' && request.mode !== 'same-origin')
  )
    return

  const background = []
  const response = (async () => {
    if (request.mode === 'navigate') return navigation(request, url, background)
    if (isImmutable(url.pathname)) return immutable(request, background)
    const cached = await read(request)
    if (url.pathname.startsWith('/media/') && cached !== undefined)
      return cached
    const network = fetchAndStore(request, background).catch(
      () =>
        cached ??
        new Response('', { status: 504, statusText: 'offline, not cached' }),
    )
    background.push(network)
    return cached ?? network
  })()
  event.respondWith(response)
  // Register the lifetime extension during dispatch, including cache hits
  // whose revalidation appends a storage write after the response resolves.
  event.waitUntil(
    (async () => {
      try {
        await response
      } catch {
        /* respondWith reports network failure. */
      }
      for (let index = 0; index < background.length; index++) {
        try {
          await background[index]
        } catch {
          /* Caching is best effort. */
        }
      }
    })(),
  )
})

// Startup requests can finish before claim, including a model still in flight
// at load. The window reports resource timing names; only hashed same-origin
// files are eligible. Serial warming avoids duplicating large downloads at once.
let warming = Promise.resolve()
self.addEventListener('message', (event) => {
  if (
    event.source?.type !== 'window' ||
    new URL(event.source.url).origin !== self.location.origin ||
    event.data?.type !== 'CACHE_ASSETS' ||
    !Array.isArray(event.data.urls)
  )
    return
  const urls = event.data.urls.slice(0, 64).filter((name) => {
    if (typeof name !== 'string') return false
    try {
      const url = new URL(name)
      return (
        url.origin === self.location.origin &&
        isImmutable(url.pathname) &&
        !url.pathname.endsWith('.map')
      )
    } catch {
      return false
    }
  })
  warming = warming.then(async () => {
    for (const url of new Set(urls)) {
      const background = []
      try {
        await immutable(new Request(url), background)
        await Promise.all(background)
      } catch {
        // Offline or quota-limited warming does not invalidate the install.
      }
    }
  })
  event.waitUntil(warming)
})
