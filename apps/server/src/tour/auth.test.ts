import { describe, expect, it } from 'vitest'
import {
  authenticate,
  loginCookie,
  passwordMatches,
  allowedOrigin,
} from './auth.ts'
import { readJson, TourHttpError } from './http.ts'

describe('private guide gate', () => {
  it('authenticates a signed expiring cookie and rejects tampering or a rotated password', async () => {
    const cookie = await loginCookie(
      'a-test-only-password',
      'https://inertialref.app',
      1000,
    )
    const request = new Request('https://inertialref.app/api/tour/sessions', {
      headers: { cookie },
    })
    expect(await authenticate(request, 'a-test-only-password', 1001)).toBe(
      'alpha',
    )
    expect(await authenticate(request, 'changed-password', 1001)).toBeNull()
    expect(
      await authenticate(request, 'a-test-only-password', 1000 + 86_400_001),
    ).toBeNull()
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
    expect(
      await authenticate(
        new Request(request, {
          headers: { cookie: cookie.replace('tour_access=', 'tour_access=x') },
        }),
        'a-test-only-password',
        1001,
      ),
    ).toBeNull()
  })

  it('requires exact approved origins on mutations and websocket upgrade', () => {
    const request = (origin: string) =>
      new Request('https://inertialref.app/api/tour/sessions', {
        headers: { origin },
      })
    expect(allowedOrigin(request('https://inertialref.app'))).toBe(true)
    expect(allowedOrigin(request('https://inertialref.app.evil.test'))).toBe(
      false,
    )
    expect(allowedOrigin(request('null'))).toBe(false)
    expect(allowedOrigin(request('http://localhost:5173'))).toBe(false)
    expect(
      allowedOrigin(
        new Request('http://localhost:8787/api/tour/login', {
          headers: { origin: 'http://localhost:5173' },
        }),
      ),
    ).toBe(true)
    expect(
      allowedOrigin(new Request('https://inertialref.app/api/tour/sessions')),
    ).toBe(false)
    // A version preview lives under the account's own workers.dev subdomain.
    const preview = 'https://a67318ec-inertialrefd.jaquers.workers.dev'
    expect(
      allowedOrigin(
        new Request(`${preview}/api/tour/login`, {
          method: 'POST',
          headers: { origin: preview },
        }),
      ),
    ).toBe(true)
    expect(
      allowedOrigin(
        new Request(`${preview}/api/tour/login`, {
          method: 'POST',
          headers: { origin: 'https://inertialref.app' },
        }),
      ),
    ).toBe(false)
  })

  it('compares password digests and refuses absent credentials', async () => {
    expect(await passwordMatches('test-only', 'test-only')).toBe(true)
    expect(await passwordMatches('bad', 'test-only')).toBe(false)
    expect(await passwordMatches('', '')).toBe(false)
  })

  it('permits same-origin read requests without relaxing mutations or upgrades', () => {
    const read = new Request('https://inertialref.app/api/tour/usage', {
      headers: { 'sec-fetch-site': 'same-origin' },
    })
    expect(allowedOrigin(read)).toBe(true)
    expect(allowedOrigin(new Request(read, { method: 'POST' }))).toBe(false)
    expect(
      allowedOrigin(
        new Request(read, {
          headers: { 'sec-fetch-site': 'same-origin', upgrade: 'websocket' },
        }),
      ),
    ).toBe(false)
    expect(
      allowedOrigin(
        new Request(read, { headers: { 'sec-fetch-site': 'cross-site' } }),
      ),
    ).toBe(false)
    expect(
      allowedOrigin(
        new Request('http://localhost/api/tour/login', {
          method: 'POST',
          headers: { origin: 'http://localhost' },
        }),
      ),
    ).toBe(true)
  })

  it('bounds streaming JSON even without a content-length header', async () => {
    const input = new Request('https://inertialref.app', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(1024) }),
    })
    await expect(readJson(input, 100)).rejects.toBeInstanceOf(TourHttpError)
    await expect(
      readJson(new Request(input.url, { method: 'POST', body: '{}' }), 100),
    ).rejects.toBeInstanceOf(TourHttpError)
  })
})
