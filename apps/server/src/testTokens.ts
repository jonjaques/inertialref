/*
 * Session tokens minted the way Clerk mints them, for tests.
 *
 * An RS256 JWT over the claims Clerk puts in a session token, and the matching
 * public key twice over: as a PEM, the networkless path the Worker itself does
 * not take, and as the entry Clerk's key set would carry for it, which is the
 * path it does.
 */

export const SITE = 'https://inertialref.app'
const encoder = new TextEncoder()

export interface Signer {
  readonly kid: string
  readonly pem: string
  /** The public key as `GET /v1/jwks` lists it. */
  readonly jwk: JsonWebKey & { readonly kid: string }
  readonly sign: (claims: Record<string, unknown>) => Promise<string>
}

// `btoa` rather than `Buffer`: this project type-checks against workerd's
// globals, where Node's are not declared.
const base64 = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
const base64url = (bytes: ArrayBuffer | Uint8Array): string =>
  base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export async function signer(kid = 'ins_test'): Promise<Signer> {
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
  const { kty, n, e } = (await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )) as JsonWebKey
  const part = (value: unknown): string =>
    base64url(encoder.encode(JSON.stringify(value)))
  return {
    kid,
    pem,
    jwk: { use: 'sig', kty, kid, alg: 'RS256', n, e },
    sign: async (claims) => {
      const body = `${part({ alg: 'RS256', typ: 'JWT', kid })}.${part(claims)}`
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        encoder.encode(body),
      )
      return `${body}.${base64url(signature)}`
    },
  }
}

export const now = (): number => Math.floor(Date.now() / 1000)
export const session = (extra: Record<string, unknown> = {}) => ({
  sub: 'user_2test',
  sid: 'sess_test',
  azp: SITE,
  iat: now() - 5,
  nbf: now() - 5,
  exp: now() + 60,
  ...extra,
})

const CLERK_API = 'https://api.clerk.com/v1'

/** One call the Worker made to Clerk's Backend API. */
export interface ClerkCall {
  readonly url: string
  readonly authorization: string | null
}

/**
 * Clerk's Backend API as the Worker reaches it with only a secret key: the
 * instance's key set, listing `issuer`, and its users, each with the private
 * metadata a person set in the dashboard.
 *
 * `answer` is `null` for a URL that is not Clerk's, so a test can put the
 * provider beside it in one `fetch`. A user absent from `users` does not
 * exist; a `status` other than 200 fails every user lookup with it.
 */
export function fakeClerk(
  issuer: Signer,
  users: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
) {
  const state = {
    users: { ...users } as Record<string, Readonly<Record<string, unknown>>>,
    status: 200,
    calls: [] as ClerkCall[],
  }
  const answer = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Response | null => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.startsWith(CLERK_API)) return null
    state.calls.push({
      url,
      authorization: new Headers(
        input instanceof Request ? input.headers : init?.headers,
      ).get('authorization'),
    })
    if (url === `${CLERK_API}/jwks`)
      return Response.json({ keys: [issuer.jwk] })
    const user = /\/users\/([^/?]+)$/.exec(url)?.[1]
    const metadata = user === undefined ? undefined : state.users[user]
    if (state.status === 200 && metadata !== undefined)
      return Response.json({
        id: user,
        object: 'user',
        private_metadata: metadata,
        public_metadata: {},
        unsafe_metadata: {},
      })
    return Response.json(
      { errors: [{ code: 'resource_not_found', message: 'not found' }] },
      { status: state.status === 200 ? 404 : state.status },
    )
  }
  return {
    state,
    answer,
    /** The user lookups so far, leaving out the key set. */
    lookups: () => state.calls.filter((call) => call.url.includes('/users/')),
  }
}
