import { describe, expect, it } from 'vitest'
import { HEALTH_PATH, SOCKET_PATH, mediaPath } from '@inertialref/protocol'
import { MEDIA, resolveRange } from './media.ts'
import { routeFor } from './routes.ts'

describe('worker routing', () => {
  it('sends the two live paths to the script', () => {
    expect(routeFor(HEALTH_PATH).kind).toBe('health')
    expect(routeFor(SOCKET_PATH).kind).toBe('socket')
  })

  it('answers anything else under /api from the API, not the page', () => {
    // Each of these is served by the SPA fallback if it reaches the asset
    // store, so the client would receive 200 and a document — a healthy-looking
    // server it cannot actually talk to. The bare `/api` case is why
    // run_worker_first lists `/api` as well as `/api/*`.
    for (const path of [
      '/api',
      '/api/',
      '/api/health/',
      '/api/heath',
      '/api/discoveries',
      '/api/v2/anything',
    ]) {
      expect(routeFor(path).kind, path).toBe('api-not-found')
    }
  })

  it('leaves everything else to the asset store', () => {
    for (const path of [
      '/',
      '/index.html',
      '/assets/index-a1b2c3d4.js',
      '/favicon.svg',
      '/apibut-not-really',
      '/ws/extra',
      '/SOL',
    ]) {
      expect(routeFor(path).kind, path).toBe('asset')
    }
  })

  it('serves the media it lists, and only that', () => {
    for (const object of MEDIA) {
      const route = routeFor(mediaPath(object.name))
      expect(route.kind, object.name).toBe('media')
      if (route.kind === 'media') expect(route.object.key).toBe(object.key)
    }
  })

  it('404s an unlisted media name rather than handing it the page', () => {
    /*
     * The allow-list is a bucket-read boundary and an honesty boundary at once.
     * Without the second branch each of these gets `index.html` and a 200 from
     * the SPA fallback, and an `<audio>` element handed a page of markup fails
     * as though it could not decode the file.
     *
     * The traversal cases matter because the alternative design — map
     * `/media/*` onto a key prefix — would have turned them into reads of
     * whatever else the site keeps in that bucket.
     */
    for (const path of [
      '/media/',
      '/media/nothing.mp3',
      '/media/../secret.txt',
      '/media/dropbox/tng-intro.mp3',
      `${mediaPath('tng-intro.mp3')}/`,
    ]) {
      expect(routeFor(path).kind, path).toBe('media-not-found')
    }
  })
})

describe('range arithmetic', () => {
  /*
   * Every one of R2's three range shapes is a different subtraction, and the
   * failure is silent: a `Content-Range` that is off by one byte does not
   * error, it corrupts the tail of whatever is playing.
   */
  const SIZE = 2_747_091

  it('reads an offset with an explicit length', () => {
    expect(resolveRange({ offset: 0, length: 1024 }, SIZE)).toEqual({
      offset: 0,
      length: 1024,
      contentRange: `bytes 0-1023/${SIZE}`,
    })
  })

  it('runs an open-ended offset to the end of the object', () => {
    const range = resolveRange({ offset: SIZE - 10 }, SIZE)
    expect(range?.length).toBe(10)
    expect(range?.contentRange).toBe(`bytes ${SIZE - 10}-${SIZE - 1}/${SIZE}`)
  })

  it('counts a suffix back from the end', () => {
    const range = resolveRange({ suffix: 500 }, SIZE)
    expect(range?.offset).toBe(SIZE - 500)
    expect(range?.length).toBe(500)
  })

  it('clamps a length that runs past the end', () => {
    // A player asking for more than exists gets the rest, which is what the
    // spec says. Naming a byte that does not exist is worse than either.
    const range = resolveRange({ offset: SIZE - 5, length: 4096 }, SIZE)
    expect(range?.length).toBe(5)
    expect(range?.contentRange).toBe(`bytes ${SIZE - 5}-${SIZE - 1}/${SIZE}`)
  })

  it('clamps a suffix larger than the object to the whole object', () => {
    const range = resolveRange({ suffix: SIZE * 2 }, SIZE)
    expect(range?.offset).toBe(0)
    expect(range?.length).toBe(SIZE)
  })

  it('refuses a range that starts at or past the end', () => {
    expect(resolveRange({ offset: SIZE }, SIZE)).toBeNull()
    expect(resolveRange({ offset: SIZE + 1, length: 10 }, SIZE)).toBeNull()
    expect(resolveRange({ suffix: 0 }, SIZE)).toBeNull()
  })

  it('narrows on the value, because workerd sets every key', () => {
    /*
     * THE REGRESSION. `R2Range` is published as a union of three exclusive
     * shapes, so the obvious implementation asks `'suffix' in range`. The
     * object workerd actually hands over has all three keys present with two
     * of them `undefined` — so that test is true for a range with no suffix,
     * `size - undefined` is `NaN`, and every number falls out `NaN`.
     *
     * It shipped as `Content-Range: bytes NaN-NaN/2747091` on a response whose
     * body was correct and whose `Content-Length` the runtime had quietly
     * replaced from the real byte count. Nothing threw. Reintroduce the `in`
     * check and this is the test that goes red.
     */
    const asWorkerdSendsIt = { offset: 0, length: 1024, suffix: undefined }
    expect(resolveRange(asWorkerdSendsIt, SIZE)).toEqual({
      offset: 0,
      length: 1024,
      contentRange: `bytes 0-1023/${SIZE}`,
    })

    const suffixShape = { offset: undefined, length: undefined, suffix: 500 }
    expect(resolveRange(suffixShape, SIZE)?.offset).toBe(SIZE - 500)

    // Every key undefined is "the whole object", not a broken range.
    const nothing = { offset: undefined, length: undefined, suffix: undefined }
    expect(resolveRange(nothing, SIZE)).toEqual({
      offset: 0,
      length: SIZE,
      contentRange: `bytes 0-${SIZE - 1}/${SIZE}`,
    })
  })
})
