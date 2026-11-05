import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { FEATURES, granted, grants } from './grants.ts'

describe('grants', () => {
  it('grants a feature to its own flag', () => {
    for (const feature of FEATURES) {
      expect(grants({ [feature]: true }, feature)).toBe(true)
      expect(granted({ [feature]: true })).toEqual([feature])
    }
  })

  it('grants every feature to an admin', () => {
    expect(granted({ admin: true })).toEqual(FEATURES)
    // An admin whose feature flag says no is still an admin.
    expect(grants({ admin: true, solo: false }, 'solo')).toBe(true)
  })

  it('reads the flags strictly', () => {
    for (const value of ['true', 1, 'yes', {}, [true], null, false])
      expect(granted({ admin: value, tour: value, solo: value })).toEqual([])
    expect(granted({})).toEqual([])
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
