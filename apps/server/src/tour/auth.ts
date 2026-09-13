const encoder = new TextEncoder()
const COOKIE = 'tour_access'
const SESSION_MS = 86_400_000
const HOSTS = new Set([
  'https://inertialref.app',
  'https://inertialref.jonjaques.com',
])
const DEVELOPMENT = new Set([
  'http://localhost',
  'http://127.0.0.1',
  'http://localhost:5173',
  'http://localhost:8787',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8787',
])

export function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  const target = new URL(request.url).origin
  if (!origin) {
    // Browsers omit Origin on same-origin GETs. Mutations and WebSocket
    // upgrades still require the exact origin and the signed cookie.
    return (
      request.method === 'GET' &&
      request.headers.get('upgrade') === null &&
      request.headers.get('sec-fetch-site') === 'same-origin' &&
      (HOSTS.has(target) || DEVELOPMENT.has(target))
    )
  }
  if (HOSTS.has(target)) return origin === target
  if (DEVELOPMENT.has(target)) return DEVELOPMENT.has(origin)
  // Version preview origins are exact: the request cannot choose another host.
  return (
    new URL(request.url).hostname.endsWith(
      '-inertialrefd.jonjaques.workers.dev',
    ) &&
    origin === target &&
    target.startsWith('https://')
  )
}

export async function passwordMatches(
  input: string,
  expected: string,
): Promise<boolean> {
  if (!input || !expected || input.length > 1024) return false
  const key = await signingKey(expected)
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(expected),
  )
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(input))
}

export async function loginCookie(
  password: string,
  origin: string,
  now: number,
): Promise<string> {
  const payload = `${now + SESSION_MS}.${crypto.randomUUID()}`
  const signature = hex(
    await crypto.subtle.sign(
      'HMAC',
      await signingKey(password),
      encoder.encode(payload),
    ),
  )
  return `${COOKIE}=${payload}.${signature}; Path=/api/tour; HttpOnly; SameSite=Strict; Max-Age=86400${origin.startsWith('https://') ? '; Secure' : ''}`
}

export async function authenticate(
  request: Request,
  password: string,
  now: number,
): Promise<string | null> {
  if (!password) return null
  const value = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1)
  if (!value || value.length > 200) return null
  const match = /^(\d+)\.([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(value)
  if (!match || Number(match[1]) <= now || Number(match[1]) > now + SESSION_MS)
    return null
  const signature = Uint8Array.from(match[3]!.match(/../g)!, (part) =>
    Number.parseInt(part, 16),
  )
  const valid = await crypto.subtle.verify(
    'HMAC',
    await signingKey(password),
    signature,
    encoder.encode(`${match[1]}.${match[2]}`),
  )
  // The shared alpha password identifies one quota principal, even after clearing cookies.
  return valid ? 'alpha' : null
}

export async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

const signingKey = (password: string) =>
  crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
const hex = (value: ArrayBuffer) =>
  [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
