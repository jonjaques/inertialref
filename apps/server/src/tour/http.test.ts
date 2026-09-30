import { describe, expect, it } from 'vitest'
import { readJson, TourHttpError } from './http.ts'

describe('readJson', () => {
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
