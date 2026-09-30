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
