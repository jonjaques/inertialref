import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  accountKeys,
  AccountUnavailableError,
  identify,
  verifySession,
} from './account.ts'
import { now, session, SITE, type Signer, signer } from './testTokens.ts'
import type { AccountKeys } from './account.ts'

/*
 * Real tokens, signed and checked, with no network.
 *
 * Each test mints an RS256 session token the way Clerk does and hands the
 * matching public key over as `jwtKey`, the networkless path. The checks
 * after the signature are the same whichever way the key arrived.
 */

const request = (url: string, headers: Record<string, string> = {}): Request =>
  new Request(url, { headers })

let issuer: Signer
let stranger: Signer
beforeAll(async () => {
  ;[issuer, stranger] = await Promise.all([signer(), signer('ins_stranger')])
})
afterEach(() => {
  vi.unstubAllGlobals()
  // A silenced console left over from one case hides the next one's records.
  vi.restoreAllMocks()
})

describe('identify', () => {
  it('says so when the deployment has no way to check a token', async () => {
    const token = await issuer.sign(session())
    expect(
      await identify(
        request(`${SITE}/api/account`, { authorization: `Bearer ${token}` }),
        {},
      ),
    ).toEqual({ configured: false, signedIn: false, userId: null })
  })

  it('is signed out without a token', async () => {
    expect(
      await identify(request(`${SITE}/api/account`), { jwtKey: issuer.pem }),
    ).toEqual({ configured: true, signedIn: false, userId: null })
  })

  it('names the user a valid token was minted for', async () => {
    const token = await issuer.sign(session())
    expect(
      await identify(
        request(`${SITE}/api/account`, { authorization: `Bearer ${token}` }),
        { jwtKey: issuer.pem },
      ),
    ).toEqual({ configured: true, signedIn: true, userId: 'user_2test' })
  })

  it('ignores the session cookie, which a hostile page can make the browser send', async () => {
    const token = await issuer.sign(session())
    const status = await identify(
      request(`${SITE}/api/account`, { cookie: `__session=${token}` }),
      { jwtKey: issuer.pem },
    )
    expect(status.signedIn).toBe(false)
  })

  it.each([
    ['signed by another key', () => stranger.sign(session())],
    ['expired', () => issuer.sign(session({ exp: now() - 120 }))],
    [
      'for a page on another site',
      () => issuer.sign(session({ azp: 'https://elsewhere.example' })),
    ],
    [
      'for a session still pending its tasks',
      () => issuer.sign(session({ sts: 'pending' })),
    ],
    [
      // A machine token: the instance's key signs those too, and there is
      // no session behind one to sign out of.
      'that names no session',
      () => issuer.sign(session({ sid: undefined, sub: 'mch_test' })),
    ],
  ])('refuses a token %s', async (_, mint) => {
    const status = await identify(
      request(`${SITE}/api/account`, {
        authorization: `Bearer ${await mint()}`,
      }),
      { jwtKey: issuer.pem },
    )
    expect(status).toEqual({ configured: true, signedIn: false, userId: null })
  })

  it('refuses a token whose header names no key, without asking Clerk', async () => {
    // Clerk destructures the header before its own error handling, so a
    // `null` one escaped as a TypeError and read as the deployment's fault: a
    // 503 any visitor could provoke. A header with no `kid` cost a key-set
    // fetch on every request.
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    for (const token of ['bnVsbA.e30.eA', 'e30.e30.eA', 'e30.bnVsbA.eA']) {
      for (const keys of [{ jwtKey: issuer.pem }, { secretKey: 'sk_test_x' }])
        expect(
          await identify(
            request(`${SITE}/api/account`, {
              authorization: `Bearer ${token}`,
            }),
            keys,
          ),
          token,
        ).toEqual({ configured: true, signedIn: false, userId: null })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps production and development apart', async () => {
    // A page on localhost asking the production host, and the reverse: each
    // host accepts only the pages that are its own.
    const local = await issuer.sign(session({ azp: 'http://localhost:5173' }))
    const site = await issuer.sign(session())
    const at = async (url: string, token: string) =>
      (
        await identify(request(url, { authorization: `Bearer ${token}` }), {
          jwtKey: issuer.pem,
        })
      ).signedIn
    expect(await at(`${SITE}/api/account`, local)).toBe(false)
    expect(await at('http://127.0.0.1:8787/api/account', site)).toBe(false)
    expect(await at('http://127.0.0.1:8787/api/account', local)).toBe(true)
  })

  it('accepts nothing on a host it does not recognize', async () => {
    // Clerk skips the party check for an empty list; this must not.
    const token = await issuer.sign(session({ azp: 'https://unknown.example' }))
    const status = await identify(
      request('https://unknown.example/api/account', {
        authorization: `Bearer ${token}`,
      }),
      { jwtKey: issuer.pem },
    )
    expect(status.signedIn).toBe(false)
  })

  it('reports a deployment that cannot load its keys instead of signing everyone out', async () => {
    // The secret-key path fetches the instance's key set; a Clerk outage or a
    // revoked secret must read as the server's fault, not the visitor's.
    const fetcher = vi.fn(
      async () => new Response('unavailable', { status: 503 }),
    )
    vi.stubGlobal('fetch', fetcher)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const token = await issuer.sign(session())
    const ask = () =>
      identify(
        request(`${SITE}/api/account`, { authorization: `Bearer ${token}` }),
        { secretKey: 'sk_test_unusable' },
      )
    await expect(ask()).rejects.toBeInstanceOf(AccountUnavailableError)
    // And the next visitor within the minute is told the same without a
    // second call: an outage is not a reason to call Clerk faster.
    await expect(ask()).rejects.toBeInstanceOf(AccountUnavailableError)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('verifySession', () => {
  it('says who, which session, and until when', async () => {
    const exp = now() + 60
    const token = await issuer.sign(session({ exp }))
    expect(await verifySession(token, { jwtKey: issuer.pem }, [SITE])).toEqual({
      userId: 'user_2test',
      sessionId: 'sess_test',
      expiresAt: exp,
    })
  })
})

describe('the key set', () => {
  /** Clerk's `GET /v1/jwks`, answering with `keys` until told otherwise. */
  function clerkWithKeys(...keys: Signer[]) {
    const state = { keys, status: 200 }
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://api.clerk.com/v1/jwks')
      return state.status === 200
        ? Response.json({ keys: state.keys.map((signer) => signer.jwk) })
        : Response.json(
            { errors: [{ code: 'internal', message: 'unavailable' }] },
            { status: state.status },
          )
    })
    vi.stubGlobal('fetch', fetcher)
    return { fetcher, state }
  }

  /** A fresh instance per test: the set is held per secret key, per isolate. */
  let instances = 0
  const instance = (): AccountKeys => ({
    secretKey: `sk_test_keys_${++instances}`,
  })
  const signedIn = async (keys: AccountKeys, token: string) =>
    (
      await identify(
        request(`${SITE}/api/account`, { authorization: `Bearer ${token}` }),
        keys,
      )
    ).signedIn

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('is fetched once and then verifies with no call to Clerk', async () => {
    const { fetcher } = clerkWithKeys(stranger, issuer)
    const keys = instance()
    const token = await issuer.sign(session())
    const verdicts = await Promise.all(
      Array.from({ length: 4 }, () => signedIn(keys, token)),
    )
    expect(verdicts).toEqual([true, true, true, true])
    expect(await signedIn(keys, token)).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refetches for a key it has not seen at most once a minute', async () => {
    // Under Clerk's own cache an invented `kid` is a key-set fetch per request.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fetcher, state } = clerkWithKeys(issuer)
    const keys = instance()
    expect(await signedIn(keys, await issuer.sign(session()))).toBe(true)
    const rotated = await signer('ins_rotated')
    const next = await rotated.sign(session())
    for (let i = 0; i < 5; i++) expect(await signedIn(keys, next)).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
    // A minute on, the instance has rotated to it, and the first token that
    // names it is the one refetch.
    state.keys = [issuer, rotated]
    vi.advanceTimersByTime(60_000)
    expect(await signedIn(keys, next)).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps verifying with a held key while Clerk is down, for an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fetcher, state } = clerkWithKeys(issuer)
    const keys = instance()
    expect(await signedIn(keys, await issuer.sign(session()))).toBe(true)
    state.status = 503
    // Past the five fresh minutes the refresh fails, and the key still serves.
    vi.advanceTimersByTime(6 * 60_000)
    expect(await signedIn(keys, await issuer.sign(session()))).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
    // An hour after the last confirmation, a check nobody could confirm
    // fails closed.
    vi.advanceTimersByTime(55 * 60_000)
    await expect(
      signedIn(keys, await issuer.sign(session())),
    ).rejects.toBeInstanceOf(AccountUnavailableError)
    // Clerk back: the next refresh restores it.
    state.status = 200
    vi.advanceTimersByTime(60_000)
    expect(await signedIn(keys, await issuer.sign(session()))).toBe(true)
  })

  it('abandons a fetch that never settles, a minute on', async () => {
    // In workerd a shared fetch belongs to the request that started it; when
    // that request is canceled the fetch never settles, and waiting on it
    // for good would wedge every later check in the isolate.
    vi.useFakeTimers({ toFake: ['Date'] })
    const answered = Response.json({ keys: [issuer.jwk] })
    const fetcher = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementation(async () => answered.clone())
    vi.stubGlobal('fetch', fetcher)
    const keys = instance()
    const token = await issuer.sign(session({ exp: now() + 3600 }))
    void signedIn(keys, token)
    vi.advanceTimersByTime(60_000)
    expect(await signedIn(keys, token)).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('drops a key the instance stops listing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { state } = clerkWithKeys(issuer)
    const keys = instance()
    const token = await issuer.sign(session({ exp: now() + 3600 }))
    expect(await signedIn(keys, token)).toBe(true)
    state.keys = [stranger]
    vi.advanceTimersByTime(5 * 60_000)
    expect(await signedIn(keys, token)).toBe(false)
  })
})

describe('accountKeys', () => {
  const env = (enabled: string) =>
    ({
      CLERK_ENABLED: enabled,
      CLERK_SECRET_KEY: 'sk_test_key',
    }) as unknown as Env

  it('checks accounts with this environment’s key while they are on', () => {
    expect(accountKeys(env('true'))).toEqual({ secretKey: 'sk_test_key' })
  })

  it('checks nothing while they are off, which reads as not configured', async () => {
    expect(accountKeys(env('false'))).toEqual({})
    const token = await issuer.sign(session())
    expect(
      await identify(
        request(`${SITE}/api/account`, { authorization: `Bearer ${token}` }),
        accountKeys(env('false')),
      ),
    ).toEqual({ configured: false, signedIn: false, userId: null })
  })
})
