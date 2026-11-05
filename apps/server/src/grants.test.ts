import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { FEATURES, grants } from './grants.ts'

describe('grants', () => {
  it('grants a feature to its own flag', () => {
    for (const feature of FEATURES)
      expect(grants({ [feature]: true }, feature)).toBe(true)
  })

  it('grants every feature to an admin', () => {
    for (const feature of FEATURES)
      expect(grants({ admin: true }, feature)).toBe(true)
    // An admin whose feature flag says no is still an admin.
    expect(grants({ admin: true, solo: false }, 'solo')).toBe(true)
  })

  it('reads the flags strictly', () => {
    for (const value of ['true', 1, 'yes', {}, [true], null, false]) {
      const flags = Object.fromEntries(
        ['admin', ...FEATURES].map((name) => [name, value]),
      )
      for (const feature of FEATURES) expect(grants(flags, feature)).toBe(false)
    }
    for (const feature of FEATURES) expect(grants({}, feature)).toBe(false)
  })

  it('never lets one feature’s flag grant another', () => {
    fc.assert(
      fc.property(
        fc.subarray([...FEATURES]),
        fc.constantFrom(...FEATURES),
        (set, feature) => {
          const flags = Object.fromEntries(set.map((name) => [name, true]))
          expect(grants(flags, feature)).toBe(set.includes(feature))
        },
      ),
    )
  })
})
