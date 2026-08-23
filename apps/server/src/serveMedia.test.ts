import { describe, expect, it } from 'vitest'
import { mediaPath } from '@inertialref/protocol'
import { type MediaObject } from './media.ts'
import {
  type MediaStores,
  type StoredObject,
  type StoredObjectBody,
  serveMedia,
} from './serveMedia.ts'

/*
 * Every case below is a shipped bug or a near miss.
 *
 * Four consecutive fix commits — d189341, 51f4bd1, 5a6eff3 and the R2 fallback
 * in 6cf684a — touched this decision logic and no test file, because the logic
 * was reachable only through `env`, a whole workerd binding object. That is
 * what `MediaStores` is for: the fake below is the second adapter, and it is
 * the second adapter that makes the seam real.
 */

const OBJECT: MediaObject = {
  name: 'tng-intro.mp3',
  key: 'dropbox/tng-intro.mp3',
  type: 'audio/mpeg',
  what: 'the cutscene reference audio',
}

const SIZE = 2_747_091
const ETAG = '"a1b2c3d4"'

/* ------------------------------------------------------------------------- */
/* The fake                                                                   */
/* ------------------------------------------------------------------------- */

/** How the asset store behaves for one request. */
type AssetBehavior =
  /** The bundle has the file: a 200 with the right type, ranges honored. */
  | 'serves'
  /** The bundle does not: `not_found_handling` answers index.html and a 200. */
  | 'spa-fallback'
  /** The bundle has it, but answers the whole object to a `Range` request. */
  | 'ignores-range'

interface FakeOptions {
  readonly asset: AssetBehavior
  /** `head()` fails too — the bucket is down behind an unsatisfiable range. */
  readonly headFails?: boolean
  /** The precondition held: R2 hands back metadata and no bytes. */
  readonly notModified?: boolean
}

function body(): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0x49, 0x44, 0x33]))
      controller.close()
    },
  })
}

function meta(range?: StoredObject['range']): StoredObject {
  return {
    size: SIZE,
    httpEtag: ETAG,
    range,
    writeHttpMetadata(headers) {
      headers.set('content-type', OBJECT.type)
    },
  }
}

function withBody(range?: StoredObject['range']): StoredObjectBody {
  return { ...meta(range), body: body() }
}

/**
 * The in-memory store.
 *
 * `get` reproduces the two behaviors that matter: it *throws* on a range past
 * the end (R2 does, and the 416 branch exists because of it) and it reports
 * `range` on every answer, ranged or not — the trap `.claude/rules/server.md`
 * names and the reason a plain GET must not read its status from that field.
 */
function fake(options: FakeOptions): MediaStores {
  return {
    async asset(request) {
      switch (options.asset) {
        case 'spa-fallback':
          return new Response('<!doctype html><title>InertialRef</title>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        case 'ignores-range':
          return new Response('all of it', {
            status: 200,
            headers: { 'content-type': OBJECT.type },
          })
        case 'serves':
          return request.headers.has('range')
            ? new Response('a slice', {
                status: 206,
                headers: { 'content-type': OBJECT.type },
              })
            : new Response('all of it', {
                status: 200,
                headers: { 'content-type': OBJECT.type },
              })
      }
    },
    async get(key, get) {
      expect(key).toBe(OBJECT.key)
      const header = get.range.get('range')
      if (header === null) return withBody({ offset: 0, length: SIZE })
      if (options.notModified) return meta({ offset: 0, length: SIZE })
      const match = /^bytes=(\d+)-(\d*)$/.exec(header)
      const offset = Number(match?.[1] ?? 0)
      if (offset >= SIZE) throw new Error('range not satisfiable')
      const last = match?.[2] === '' ? SIZE - 1 : Number(match?.[2])
      return withBody({ offset, length: last - offset + 1 })
    },
    async head(key) {
      expect(key).toBe(OBJECT.key)
      if (options.headFails) throw new Error('bucket is unreachable')
      return meta()
    },
  }
}

function get(headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(
    `https://inertialref.jonjaques.com${mediaPath(OBJECT.name)}`,
    {
      method,
      headers,
    },
  )
}

/* ------------------------------------------------------------------------- */

describe('serveMedia', () => {
  it('returns the asset store’s own answer when the bundle has the file', async () => {
    // The free path, and the reason the order is asset-then-bucket: this
    // request never leaves the asset store and is never billed.
    const response = await serveMedia(get(), OBJECT, fake({ asset: 'serves' }))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('all of it')
  })

  it('falls through to R2 when the asset store answers the page', async () => {
    /*
     * `not_found_handling: single-page-application` returns index.html with a
     * **200**, so there is no status code to test. Handing that to an `<audio>`
     * element fails as though the file could not be decoded — which is what
     * makes the content-type test a rule rather than a heuristic.
     */
    const response = await serveMedia(
      get(),
      OBJECT,
      fake({ asset: 'spa-fallback' }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(OBJECT.type)
    expect(response.headers.get('content-length')).toBe(String(SIZE))
  })

  it('falls through to R2 with a 206 when the asset store ignores the range', async () => {
    // Measured: `env.ASSETS` answers `Range: bytes=0-1023` with 200 and all
    // 2.7 MB. The cutscene overlay seeks against a reference clock, so every
    // seek would wait for a download a 206 makes unnecessary.
    const response = await serveMedia(
      get({ range: 'bytes=0-1023' }),
      OBJECT,
      fake({ asset: 'ignores-range' }),
    )
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 0-1023/${SIZE}`)
    expect(response.headers.get('content-length')).toBe('1024')
  })

  it('answers a plain GET with 200, never 206', async () => {
    /*
     * THE REGRESSION. `stored.range` is populated with or without a `Range`
     * header, so keying the status off it alone makes every plain GET a partial
     * response. Nothing errors and the bytes are right; what breaks is every
     * cache in between, which may not reuse a partial response as a whole one.
     */
    const response = await serveMedia(
      get(),
      OBJECT,
      fake({ asset: 'spa-fallback' }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBeNull()
  })

  it('answers a conditional GET with 304 and no body', async () => {
    // A conditional `get` whose precondition holds returns metadata without a
    // body. `'body' in stored` is the only thing that distinguishes it.
    const response = await serveMedia(
      get({ range: 'bytes=0-1023', 'if-none-match': ETAG }),
      OBJECT,
      fake({ asset: 'spa-fallback', notModified: true }),
    )
    expect(response.status).toBe(304)
    expect(response.body).toBeNull()
    expect(response.headers.get('etag')).toBe(ETAG)
  })

  it('answers a range past the end with 416 and the length to retry within', async () => {
    /*
     * The alternative — answering 200 — is the bug this replaced: the stored
     * body is the *slice*, so a 200 carrying the whole object's length
     * describes bytes nobody is going to send, and a player waits forever.
     */
    const response = await serveMedia(
      get({ range: `bytes=${SIZE + 10}-` }),
      OBJECT,
      fake({ asset: 'spa-fallback' }),
    )
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe(`bytes */${SIZE}`)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
  })

  it('still answers 416 when head() cannot name the length either', async () => {
    // The second round trip is allowed to fail: an unsatisfiable range is still
    // unsatisfiable when the bucket will not say how long the object is. What
    // must not happen is a 500, which reads in the logs as the bucket being
    // down rather than as bad client input.
    const response = await serveMedia(
      get({ range: `bytes=${SIZE + 10}-` }),
      OBJECT,
      fake({ asset: 'spa-fallback', headFails: true }),
    )
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBeNull()
  })

  it('answers HEAD with the headers of the GET and none of the bytes', async () => {
    // Written once now. It used to be written on each of the 200 and 206
    // branches, one edit away from a HEAD that streams a body.
    const response = await serveMedia(
      get({ range: 'bytes=0-1023' }, 'HEAD'),
      OBJECT,
      fake({ asset: 'spa-fallback' }),
    )
    expect(response.status).toBe(206)
    expect(response.headers.get('content-length')).toBe('1024')
    expect(response.body).toBeNull()
  })

  it('404s an object the bucket does not have', async () => {
    const stores: MediaStores = {
      ...fake({ asset: 'spa-fallback' }),
      async get() {
        return null
      },
    }
    const response = await serveMedia(get(), OBJECT, stores)
    expect(response.status).toBe(404)
  })
})
