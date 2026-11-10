import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { SCENARIO_IDS } from '@inertialref/rendering'
import {
  CLOUD_COMPOSITES,
  CLOUD_FORCES,
  type CloudLevers,
  cloudResetKey,
  DEFAULT_CLOUD_LEVERS,
  isCloudLevers,
} from './cloudLevers.ts'

/** The levers a history texel's meaning depends on (§3.4). */
const RESET_LEVERS = [
  'scenario',
  'farFootprint',
  'composite',
  'traceScale',
  'served',
  'second',
] as const satisfies readonly (keyof CloudLevers)[]

/** Values each field must refuse: the wrong type, and a plausible miss of its set. */
const MALFORMED: Record<keyof CloudLevers, readonly unknown[]> = {
  on: [1, 'true', null],
  scenario: ['cumulus', '', null],
  farFootprint: [0, -400, Infinity, Number.NaN, '400'],
  lightTaps: [1, 3, 8, '2'],
  composite: ['over', null],
  force: ['teleport', 1],
  warp: [0, -1, Number.NaN, Infinity],
  scrubSeconds: [Number.NaN, Infinity, '10800'],
  flySpeed: [-1, Number.NaN],
  traceScale: [0.25, 4, '1'],
  maxSteps: [0, -8, 1.5, Infinity],
  jitterFrame: [-1, 2.5, Number.NaN, '0', undefined],
  served: [0, undefined, {}],
  second: [false, undefined],
  deck: ['shown', true],
  stats: ['false', 0],
}

/** Every lever set the guard accepts. */
const levers: fc.Arbitrary<CloudLevers> = fc.record({
  on: fc.boolean(),
  scenario: fc.constantFrom(...SCENARIO_IDS),
  farFootprint: fc.constantFrom(100, 400, 1600),
  lightTaps: fc.constantFrom(0 as const, 2 as const, 4 as const),
  composite: fc.constantFrom(...CLOUD_COMPOSITES),
  force: fc.constantFrom(...CLOUD_FORCES),
  warp: fc.constantFrom(1, 1000),
  scrubSeconds: fc.constantFrom(-3600, 10_800),
  flySpeed: fc.constantFrom(0, 250, 7700),
  traceScale: fc.constantFrom(0.5 as const, 1 as const, 2 as const),
  maxSteps: fc.constantFrom(64, 192),
  jitterFrame: fc.constantFrom(null, 0, 41, 2 ** 32 + 5),
  served: fc.constantFrom(null, 's:3/b:2', 'b:4.0'),
  second: fc.constantFrom(null, 'b:4'),
  deck: fc.constantFrom('auto' as const, 'hidden' as const),
  stats: fc.boolean(),
})

describe('the cloud levers', () => {
  it('default to off, and the defaults are levers', () => {
    expect(DEFAULT_CLOUD_LEVERS.on).toBe(false)
    expect(isCloudLevers(DEFAULT_CLOUD_LEVERS)).toBe(true)
    // Shared by every engine: a script writes a new object, never into this one.
    expect(Object.isFrozen(DEFAULT_CLOUD_LEVERS)).toBe(true)
  })

  it.each(Object.keys(MALFORMED) as (keyof CloudLevers)[])(
    'refuse a malformed %s',
    (field) => {
      for (const value of MALFORMED[field]) {
        expect(isCloudLevers({ ...DEFAULT_CLOUD_LEVERS, [field]: value })).toBe(
          false,
        )
      }
    },
  )

  it('refuse a missing lever and a misspelled one', () => {
    const { traceScale: _, ...missing } = DEFAULT_CLOUD_LEVERS
    expect(isCloudLevers(missing)).toBe(false)
    expect(isCloudLevers({ ...DEFAULT_CLOUD_LEVERS, tracescale: 2 })).toBe(
      false,
    )
    expect(isCloudLevers(null)).toBe(false)
    expect(isCloudLevers('on')).toBe(false)
  })

  it("refuse an inherited name in a lever's place", () => {
    // `toString` counts as a key and finds Object.prototype's function, which
    // answers 1 with a truthy string; only an own-key test refuses it.
    const { stats: _, ...missing } = DEFAULT_CLOUD_LEVERS
    for (const name of ['toString', 'constructor', 'valueOf'])
      expect(isCloudLevers({ ...missing, [name]: 1 })).toBe(false)
  })

  it('accept every lever set the generator draws', () => {
    fc.assert(fc.property(levers, (set) => isCloudLevers(set)))
  })
})

describe('the reset key', () => {
  it('changes exactly with the reset levers, one lever at a time', () => {
    const changed: Partial<CloudLevers> = {
      on: true,
      scenario: 'anvil',
      farFootprint: 800,
      lightTaps: 4,
      composite: 'thin',
      force: 'cut',
      warp: 10,
      scrubSeconds: 60,
      flySpeed: 7700,
      traceScale: 2,
      maxSteps: 64,
      jitterFrame: 7,
      served: 'b:2',
      second: 'b:4',
      deck: 'hidden',
      stats: true,
    }
    const base = cloudResetKey(DEFAULT_CLOUD_LEVERS)
    for (const [field, value] of Object.entries(changed)) {
      const key = cloudResetKey({ ...DEFAULT_CLOUD_LEVERS, [field]: value })
      expect(key !== base, field).toBe(
        (RESET_LEVERS as readonly string[]).includes(field),
      )
    }
  })

  it('is equal for two lever sets exactly when their reset levers are', () => {
    fc.assert(
      fc.property(levers, levers, (a, b) => {
        const same = RESET_LEVERS.every((field) => a[field] === b[field])
        return (cloudResetKey(a) === cloudResetKey(b)) === same
      }),
    )
  })

  it('keeps an address whole, whatever it holds', () => {
    // A key joined on a separator would read these two as one.
    const a = { ...DEFAULT_CLOUD_LEVERS, served: 'a","b', second: null }
    const b = { ...DEFAULT_CLOUD_LEVERS, served: 'a', second: 'b' }
    expect(cloudResetKey(a)).not.toBe(cloudResetKey(b))
  })
})
