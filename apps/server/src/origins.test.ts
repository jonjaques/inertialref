import { describe, expect, it } from 'vitest'
import { allowedOrigin, siteOrigins } from './origins.ts'

describe('allowedOrigin', () => {
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
        new Request('http://localhost:8787/api/tour/sessions', {
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
        new Request(`${preview}/api/tour/sessions`, {
          method: 'POST',
          headers: { origin: preview },
        }),
      ),
    ).toBe(true)
    expect(
      allowedOrigin(
        new Request(`${preview}/api/tour/sessions`, {
          method: 'POST',
          headers: { origin: 'https://inertialref.app' },
        }),
      ),
    ).toBe(false)
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
        new Request('http://localhost/api/tour/sessions', {
          method: 'POST',
          headers: { origin: 'http://localhost' },
        }),
      ),
    ).toBe(true)
  })
})

describe('siteOrigins', () => {
  it('names the pages of the host a request arrived at, and nothing else', () => {
    expect(siteOrigins(new Request('https://inertialref.app/x'))).toEqual([
      'https://inertialref.app',
      'https://inertialref.jonjaques.com',
    ])
    expect(siteOrigins(new Request('http://127.0.0.1:8787/x'))).toContain(
      'http://localhost:5173',
    )
    const preview = 'https://a67318ec-inertialrefd.jaquers.workers.dev'
    expect(siteOrigins(new Request(`${preview}/x`))).toEqual([preview])
    expect(siteOrigins(new Request('https://unknown.example/x'))).toEqual([])
  })
})
