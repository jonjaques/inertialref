import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { API_PREFIX, HEALTH_PATH, SOCKET_PATH } from '@inertialref/protocol'

/*
 * The service worker's routing, executed rather than described.
 *
 * `public/sw.js` is plain JavaScript that never goes through the bundler, so it
 * cannot import the paths it has to agree with — it repeats them, and a comment
 * asks whoever changes `net.ts` to change it too. That is precisely the sort of
 * agreement that quietly stops holding, and the failure when it does is the
 * worst kind: the first `/api` response is pinned in a cache that survives
 * reloads, so the game reports a broken server that is in perfect health.
 *
 * So this loads the real file, installs its real handlers against stubbed
 * globals, and asks it what it would do. It is not a mirror of the policy — a
 * mirror would pass while the thing it claims to describe drifted.
 */

const SOURCE = readFileSync(
  new URL('../../public/sw.js', import.meta.url),
  'utf8',
)

const ORIGIN = 'https://inertialref.test'
const BUILD = 'testbuild'

interface FakeRequest {
  readonly url: string
  readonly method: string
  readonly mode: string
  readonly cache: string
  readonly headers: { has: (name: string) => boolean }
}

const request = (
  path: string,
  overrides: Partial<Omit<FakeRequest, 'headers'>> & {
    readonly range?: boolean
  } = {},
): FakeRequest => ({
  url: path.startsWith('http') ? path : `${ORIGIN}${path}`,
  method: overrides.method ?? 'GET',
  mode: overrides.mode ?? 'no-cors',
  cache: overrides.cache ?? 'default',
  headers: { has: (name) => name === 'range' && overrides.range === true },
})

/** A response the worker considers worth storing. */
const okResponse = () => ({
  ok: true,
  type: 'basic',
  clone: () => ({ body: 'copy' }),
})

interface Harness {
  readonly listeners: Map<string, (event: unknown) => void>
  readonly opened: string[]
  readonly deleted: string[]
  readonly put: string[]
  cacheKeys: string[]
  /** Per-cache contents, keyed by cache name then request URL. */
  readonly stores: Map<string, Map<string, unknown>>
}

function loadServiceWorker(): Harness {
  const listeners = new Map<string, (event: unknown) => void>()
  const harness: Harness = {
    listeners,
    opened: [],
    deleted: [],
    put: [],
    cacheKeys: [],
    stores: new Map(),
  }

  const self = {
    location: { href: `${ORIGIN}/sw.js?build=${BUILD}`, origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) =>
      listeners.set(type, fn),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  }

  const caches = {
    open: (name: string) => {
      harness.opened.push(name)
      let store = harness.stores.get(name)
      if (store === undefined) {
        store = new Map()
        harness.stores.set(name, store)
      }
      const contents = store
      return Promise.resolve({
        add: (url: string) => {
          harness.put.push(url)
          contents.set(url, 'added')
          return Promise.resolve()
        },
        put: (req: FakeRequest | string, response?: unknown) => {
          const url = typeof req === 'string' ? req : req.url
          harness.put.push(url)
          contents.set(url, response ?? 'copy')
          return Promise.resolve()
        },
        match: (req: FakeRequest | string) =>
          Promise.resolve(
            contents.get(typeof req === 'string' ? req : req.url),
          ),
        // The activate migration walks old caches entry by entry, so the fake
        // has to answer `keys()` with request-shaped objects.
        keys: () =>
          Promise.resolve([...contents.keys()].map((u) => request(u))),
      })
    },
    keys: () => Promise.resolve(harness.cacheKeys),
    delete: (name: string) => {
      harness.deleted.push(name)
      return Promise.resolve(true)
    },
    match: () => Promise.resolve(undefined),
  }

  // The file is a script, not a module, so this is how it gets evaluated with
  // its globals replaced. Everything it reaches for is a parameter here.
  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, () =>
    Promise.resolve(okResponse()),
  )
  return harness
}

/** Whether the worker took responsibility for a request, or let it through. */
function handled(harness: Harness, req: FakeRequest): boolean {
  const listener = harness.listeners.get('fetch')
  if (listener === undefined) throw new Error('no fetch listener registered')
  let responded = false
  listener({
    request: req,
    respondWith: () => {
      responded = true
    },
    waitUntil: () => {},
  })
  return responded
}

describe('the service worker', () => {
  it('never touches live state', () => {
    const sw = loadServiceWorker()
    // The paths the client and the Worker actually use. If `net.ts` renames one
    // and sw.js is not updated with it, this is where it is caught.
    for (const path of [
      HEALTH_PATH,
      SOCKET_PATH,
      API_PREFIX.slice(0, -1),
      `${API_PREFIX}discoveries`,
      `${API_PREFIX}anything/at/all`,
    ]) {
      expect(handled(sw, request(path)), path).toBe(false)
    }
  })

  it('takes responsibility for the application itself', () => {
    const sw = loadServiceWorker()
    for (const path of ['/assets/index-a1b2c3d4.js', '/favicon.svg', '/']) {
      expect(handled(sw, request(path)), path).toBe(true)
    }
    expect(handled(sw, request('/', { mode: 'navigate' }))).toBe(true)
  })

  it('leaves alone what it cannot safely store', () => {
    const sw = loadServiceWorker()
    // A 206 stored whole is served back as the complete resource, which
    // corrupts every later range read of it.
    expect(handled(sw, request('/assets/big.bin', { range: true }))).toBe(false)
    expect(handled(sw, request('/', { method: 'POST' }))).toBe(false)
    expect(handled(sw, request('https://cdn.example.com/thing.js'))).toBe(false)
    // Source maps live next to hashed chunks, so `/assets/` would otherwise
    // cache-first them. They are a debugger fetch, not a cold-start asset.
    expect(handled(sw, request('/assets/index-a1b2c3d4.js.map'))).toBe(false)
    // Chrome's devtools issues this while inspecting a cache; answering it with
    // a normal fetch throws, and the throw looks like a failed page load.
    expect(
      handled(sw, request('/assets/x.js', { cache: 'only-if-cached' })),
    ).toBe(false)
  })

  it('names its cache after the build that installed it', async () => {
    const sw = loadServiceWorker()
    const install = sw.listeners.get('install')
    if (install === undefined) throw new Error('no install listener')
    let pending: Promise<unknown> = Promise.resolve()
    install({ waitUntil: (p: Promise<unknown>) => (pending = p) })
    await pending
    expect(sw.opened).toContain(`inertialref-${BUILD}`)
    // Precaching an /api path would defeat the bypass above at install time.
    for (const url of sw.put) expect(url.startsWith('/api')).toBe(false)
  })

  it('evicts its own past builds and nothing else', async () => {
    const sw = loadServiceWorker()
    sw.cacheKeys = [
      'inertialref-oldbuild',
      `inertialref-${BUILD}`,
      // Another application on the same origin. A service worker deleting this
      // would be reaching well outside its own concern.
      'someone-elses-cache',
    ]
    const activate = sw.listeners.get('activate')
    if (activate === undefined) throw new Error('no activate listener')
    let pending: Promise<unknown> = Promise.resolve()
    activate({ waitUntil: (p: Promise<unknown>) => (pending = p) })
    await pending
    expect(sw.deleted).toEqual(['inertialref-oldbuild'])
  })

  it('rescues immutable assets from the build it replaces', async () => {
    const sw = loadServiceWorker()
    sw.cacheKeys = ['inertialref-oldbuild', `inertialref-${BUILD}`]
    // What the old worker cached during the visit that fetched the new build:
    // the new hashed chunks and catalog went into *its* cache, because it
    // was still the controlling worker. Deleting that cache unread is what
    // left the next offline launch with an index.html and none of its code.
    sw.stores.set(
      'inertialref-oldbuild',
      new Map<string, unknown>([
        [`${ORIGIN}/assets/index-e5f6a7b8.js`, 'new chunk'],
        [`${ORIGIN}/assets/stars-150ly-c9d0.irsc`, 'catalogue'],
        // Unhashed, so a copy *could* be stale — it must not migrate.
        [`${ORIGIN}/index.html`, 'old shell'],
      ]),
    )
    const activate = sw.listeners.get('activate')
    if (activate === undefined) throw new Error('no activate listener')
    let pending: Promise<unknown> = Promise.resolve()
    activate({ waitUntil: (p: Promise<unknown>) => (pending = p) })
    await pending

    const rescued = sw.stores.get(`inertialref-${BUILD}`)
    expect(rescued?.get(`${ORIGIN}/assets/index-e5f6a7b8.js`)).toBe('new chunk')
    expect(rescued?.get(`${ORIGIN}/assets/stars-150ly-c9d0.irsc`)).toBe(
      'catalogue',
    )
    expect(rescued?.has(`${ORIGIN}/index.html`)).toBe(false)
    expect(sw.deleted).toEqual(['inertialref-oldbuild'])
  })
})
