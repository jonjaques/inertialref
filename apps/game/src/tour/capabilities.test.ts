import { describe, expect, it } from 'vitest'
import { grantsGuide, readCapabilities } from './capabilities.ts'

const ANSWER = {
  available: true,
  signedIn: true,
  authorized: true,
  voices: ['marin', 'cedar'],
  reason: null,
}

describe('readCapabilities', () => {
  it('reads the Worker’s answer', () => {
    expect(readCapabilities(ANSWER)).toEqual(ANSWER)
    expect(
      readCapabilities({ ...ANSWER, available: false, reason: 'off' }),
    ).toEqual({ ...ANSWER, available: false, reason: 'off' })
  })

  it('refuses anything that is not that answer', () => {
    for (const value of [
      null,
      '<!doctype html>',
      { ...ANSWER, authorized: 'true' },
      { ...ANSWER, voices: [1] },
      // The password-era shape.
      { available: true, authenticated: true, voices: [], reason: null },
    ])
      expect(readCapabilities(value)).toBeNull()
  })
})

describe('grantsGuide', () => {
  it('grants only an available guide to an authorized account', () => {
    expect(grantsGuide(ANSWER)).toBe(true)
    expect(grantsGuide({ ...ANSWER, authorized: false })).toBe(false)
    expect(grantsGuide({ ...ANSWER, available: false })).toBe(false)
    expect(grantsGuide(null)).toBe(false)
  })
})
