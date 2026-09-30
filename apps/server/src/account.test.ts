import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { accountKeys, AccountUnavailableError, identify } from './account.ts'
import { now, session, SITE, type Signer, signer } from './testTokens.ts'

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
  ;[issuer, stranger] = await Promise.all([signer(), signer()])
})
afterEach(() => {
  vi.unstubAllGlobals()
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
  ])('refuses a token %s', async (_, mint) => {
    const status = await identify(
      request(`${SITE}/api/account`, {
        authorization: `Bearer ${await mint()}`,
      }),
      { jwtKey: issuer.pem },
    )
    expect(status).toEqual({ configured: true, signedIn: false, userId: null })
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    )
    const token = await issuer.sign(session())
    await expect(
      identify(
        request(`${SITE}/api/account`, { authorization: `Bearer ${token}` }),
        { secretKey: 'sk_test_unusable' },
      ),
    ).rejects.toBeInstanceOf(AccountUnavailableError)
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
