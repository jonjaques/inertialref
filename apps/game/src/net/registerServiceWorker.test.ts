import { describe, expect, it } from 'vitest'
import {
  type RegistrationPage,
  registerServiceWorker,
  serviceWorkerUrl,
} from './registerServiceWorker.ts'

/*
 * The half of offline-first that had no tests, which is where the bug was.
 *
 * `public/sw.js` is exercised for real in `serviceWorker.test.ts` — its
 * handlers installed against stubbed globals and asked what they would do.
 * Putting it there was thirty-six lines nothing covered, and `3ed4872` is what
 * that cost: registration listened for a `load` event that had already fired,
 * so the *first* visit to any origin never installed a worker. Every visit
 * after did, because a registration persists — which is why it looked fine.
 */

/** A page in a stated readiness, whose `load` the test fires by hand. */
function page(readyState: DocumentReadyState): RegistrationPage & {
  load(): void
  listeners: number
} {
  const waiting: (() => void)[] = []
  return {
    readyState: () => readyState,
    onLoad: (run) => waiting.push(run),
    load: () => {
      for (const run of waiting.splice(0)) run()
    },
    get listeners() {
      return waiting.length
    },
  }
}

function recorder(behavior: 'resolves' | 'rejects' = 'resolves') {
  const urls: string[] = []
  return {
    urls,
    register: (url: string) => {
      urls.push(url)
      return behavior === 'resolves'
        ? Promise.resolve({})
        : Promise.reject(new Error('SecurityError'))
    },
  }
}

describe('registering the service worker', () => {
  it('registers immediately when load has already fired', () => {
    /*
     * THE REGRESSION. `main.tsx` awaits the packed catalog at module scope and
     * that await resolves *after* load — measured on a cold visit to a review
     * app: load at 761 ms, the 460 KB catalog at 969 ms. A bare listener here
     * waits for an event that has been and gone, and "works on a plane" is
     * false for exactly the visit it has to be true for.
     */
    const ready = page('complete')
    const { register, urls } = recorder()
    registerServiceWorker({ page: ready, register, buildId: 'abc1234' })

    expect(urls).toEqual(['/sw.js?build=abc1234'])
    // And it does not also attach a listener that would register a second time.
    expect(ready.listeners).toBe(0)
  })

  it('defers while the page is still loading, then registers exactly once', () => {
    // Deferring is still right when load has not fired: the worker's install
    // fetches `/`, `/planetarium`, `/cinema`, `/docs` and the icons, and doing
    // that while the page is pulling its own critical path is bandwidth taken
    // from the player.
    const loading = page('loading')
    const { register, urls } = recorder()
    registerServiceWorker({ page: loading, register, buildId: 'abc1234' })

    expect(urls).toEqual([])
    loading.load()
    expect(urls).toEqual(['/sw.js?build=abc1234'])

    // A second `load` — a listener attached without `once`, a test firing twice
    // — must not install a second worker.
    loading.load()
    expect(urls).toHaveLength(1)
  })

  it('warns on a rejected registration rather than throwing', async () => {
    /*
     * This runs at module scope. A throw here costs the whole session for a
     * feature that is an optimization on the first visit — and `register`
     * rejects for real reasons: an insecure origin, a blocked scope, a user
     * profile with storage disabled.
     */
    const warnings: string[] = []
    const { register } = recorder('rejects')
    expect(() =>
      registerServiceWorker({
        page: page('complete'),
        register,
        buildId: 'abc1234',
        warn: (message) => warnings.push(message),
      }),
    ).not.toThrow()

    await Promise.resolve()
    await Promise.resolve()
    expect(warnings[0]).toContain('still runs online')
  })

  it('carries the build id, which is the contract sw.js reads back', () => {
    /*
     * The other half of a contract the existing suite fakes from one side only:
     * `sw.js` names its cache `inertialref-${build}` from its own location's
     * `?build=`, so a deploy stops inheriting the last one's precached
     * index.html. If this URL stopped carrying the id, every deploy would
     * silently share one cache and the worker's test would still pass.
     */
    expect(serviceWorkerUrl('abc1234')).toBe('/sw.js?build=abc1234')
    expect(
      new URL(serviceWorkerUrl('v2.1+ci'), 'https://x').searchParams.get(
        'build',
      ),
    ).toBe('v2.1+ci')
  })

  it('encodes a build id that would otherwise break the query', () => {
    // Build ids come from CI. One with a `&` in it would truncate the parameter
    // and hand `sw.js` a different cache name than the one it was deployed as.
    const url = serviceWorkerUrl('a&b=c')
    expect(new URL(url, 'https://x').searchParams.get('build')).toBe('a&b=c')
  })
})
