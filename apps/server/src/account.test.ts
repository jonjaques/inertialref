import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AccountUnavailableError, identify } from './account.ts'

/*
 * Real tokens, signed and checked, with no network.
 *
 * Each test mints an RS256 session token the way Clerk does and hands the
 * matching public key over as `jwtKey`, which is the networkless path
 * `identify` takes in production when `CLERK_JWT_KEY` is set. Clerk turns a
 * PEM into a JWK by stripping a fixed 2048-bit, e=65537 SPKI prefix rather
 * than parsing it, so the key here has to be exactly that shape.
 */

const SITE = 'https://inertialref.app'
const encoder = new TextEncoder()

interface Signer {
  readonly pem: string
  readonly sign: (claims: Record<string, unknown>) => Promise<string>
}

// `btoa` rather than `Buffer`: this project type-checks against workerd's
// globals, where Node's are not declared.
const base64 = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
const base64url = (bytes: ArrayBuffer | Uint8Array): string =>
  base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function signer(): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const spki = base64(
    (await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer,
  )
  const pem = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`
  const part = (value: unknown): string =>
    base64url(encoder.encode(JSON.stringify(value)))
  return {
    pem,
    sign: async (claims) => {
      const body = `${part({ alg: 'RS256', typ: 'JWT', kid: 'ins_test' })}.${part(claims)}`
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        encoder.encode(body),
      )
      return `${body}.${base64url(signature)}`
    },
  }
}

const now = (): number => Math.floor(Date.now() / 1000)
const session = (extra: Record<string, unknown> = {}) => ({
  sub: 'user_2test',
  sid: 'sess_test',
  azp: SITE,
  iat: now() - 5,
  nbf: now() - 5,
  exp: now() + 60,
  ...extra,
})

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
