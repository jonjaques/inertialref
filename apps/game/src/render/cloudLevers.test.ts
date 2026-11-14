import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { SCENARIO_IDS } from '@inertialref/rendering'
import {
  CLOUD_COMPOSITES,
  CLOUD_FAR_BLOCKS,
  CLOUD_FORCES,
  CLOUD_JITTERS,
  CLOUD_LEVER_KINDS,
  CLOUD_LIGHT_TAPS,
  CLOUD_MAX_STEPS,
  CLOUD_OVERS,
  CLOUD_PHASE_BINS,
  CLOUD_PHASE_MODES,
  CLOUD_STEERING_LEVERS,
  CLOUD_SUN_RAMPS,
  CLOUD_SUN_SLICES,
  CLOUD_TRANSPORTS,
  CLOUD_WEATHERS,
  cloudFieldKey,
  type CloudLevers,
  cloudLeversHash,
  cloudResetKey,
  DEFAULT_CLOUD_LEVERS,
  isCloudLevers,
  resolveCloudLevers,
} from './cloudLevers.ts'
import { CLOUD_MAX_STEPS_COUNTED } from './cloudKinds.ts'

/** The levers a history texel's meaning depends on (§3.4). */
const RESET_LEVERS = [
  'weather',
  'farFootprint',
  'composite',
  'traceScale',
  'served',
  'second',
] as const satisfies readonly (keyof CloudLevers)[]

/** The levers a cache's contents depend on (phase 1 design §4.7). */
const FIELD_LEVERS = [
  'weather',
  'served',
  'second',
  'farFootprint',
  'traceScale',
] as const satisfies readonly (keyof CloudLevers)[]

/** Values each field must refuse: the wrong type, and a plausible miss of its set. */
const MALFORMED: Record<keyof CloudLevers, readonly unknown[]> = {
  on: [1, 'true', null],
  weather: ['cumulus', '', null, 'Climate'],
  farFootprint: [0, -400, Infinity, Number.NaN, '400'],
  lightTaps: [1, 3, 10, '2'],
  composite: ['over', null],
  force: ['teleport', 1],
  warp: [0, -1, Number.NaN, Infinity],
  scrubSeconds: [Number.NaN, Infinity, '10800'],
  flySpeed: [-1, Number.NaN],
  traceScale: [0.25, 4, '1'],
  // Past what a ray's counts by kind hold (`CLOUD_MAX_STEPS_COUNTED`).
  maxSteps: [0, -8, 1.5, Infinity, 1024, 4096],
  jitterFrame: [-1, 2.5, Number.NaN, '0', undefined],
  served: [0, undefined, {}],
  second: [false, undefined],
  deck: ['shown', true],
  stats: ['false', 0],
  phaseMode: ['binned', 1],
  phaseBins: [1, 5, '2'],
  jitter: ['blue', null],
  transport: ['table', 0],
  handoverBand: [0.5, 0, Number.NaN, Infinity, '2'],
  clip: [0, -1, Number.NaN, '1.25'],
  over: ['split', true],
  sunSlices: [0, 2, 32, '8'],
  sunRamp: [0, 4, 64],
  farBlocks: [0, 3, '1'],
}

/** Every lever set the guard accepts. */
const levers: fc.Arbitrary<CloudLevers> = fc.record({
  on: fc.boolean(),
  weather: fc.constantFrom(...CLOUD_WEATHERS),
  farFootprint: fc.constantFrom(100, 400, 1600),
  lightTaps: fc.constantFrom(...CLOUD_LIGHT_TAPS),
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
  phaseMode: fc.constantFrom(...CLOUD_PHASE_MODES),
  phaseBins: fc.constantFrom(...CLOUD_PHASE_BINS),
  jitter: fc.constantFrom(...CLOUD_JITTERS),
  transport: fc.constantFrom(...CLOUD_TRANSPORTS),
  handoverBand: fc.constantFrom(1, 2, 4),
  clip: fc.constantFrom(0.75, 1.25),
  over: fc.constantFrom(...CLOUD_OVERS),
  sunSlices: fc.constantFrom(...CLOUD_SUN_SLICES),
  sunRamp: fc.constantFrom(...CLOUD_SUN_RAMPS),
  farBlocks: fc.constantFrom(...CLOUD_FAR_BLOCKS),
})

/** Every lever at a value that is not its default's. */
const CHANGED: CloudLevers = {
  on: true,
  weather: 'anvil',
  farFootprint: 1600,
  lightTaps: 2,
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
  phaseMode: 'sample',
  phaseBins: 2,
  jitter: 'stbn',
  transport: 'octaves',
  handoverBand: 4,
  clip: 0.75,
  over: 'chain',
  sunSlices: 16,
  sunRamp: 32,
  farBlocks: 2,
}

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

  it('take every step budget a ray counts exactly, every rung among them, and refuse the next', () => {
    const take = (maxSteps: number): boolean =>
      isCloudLevers({ ...DEFAULT_CLOUD_LEVERS, maxSteps })
    expect(CLOUD_MAX_STEPS_COUNTED).toBe(1006)
    for (const rung of CLOUD_MAX_STEPS) expect(take(rung)).toBe(true)
    expect(take(CLOUD_MAX_STEPS_COUNTED)).toBe(true)
    expect(take(CLOUD_MAX_STEPS_COUNTED + 1)).toBe(false)
  })

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

  it('take a climate or any regime as the weather, and six and eight light taps', () => {
    expect(DEFAULT_CLOUD_LEVERS.weather).toBe('climate')
    expect(CLOUD_WEATHERS).toEqual(['climate', ...SCENARIO_IDS])
    expect(CLOUD_LIGHT_TAPS).toEqual([0, 2, 4, 6, 8])
    for (const lightTaps of CLOUD_LIGHT_TAPS)
      expect(isCloudLevers({ ...DEFAULT_CLOUD_LEVERS, lightTaps })).toBe(true)
  })

  it('differ from the defaults at every lever of the changed set', () => {
    // What the key and hash tests below lean on: a lever left at its default
    // there would be a lever no test moves.
    for (const field of Object.keys(
      DEFAULT_CLOUD_LEVERS,
    ) as (keyof CloudLevers)[])
      expect(CHANGED[field], field).not.toBe(DEFAULT_CLOUD_LEVERS[field])
    expect(isCloudLevers(CHANGED)).toBe(true)
  })

  it('name each lever a quality step, a measurement control or a measured choice', () => {
    expect(Object.keys(CLOUD_LEVER_KINDS).sort()).toEqual(
      Object.keys(DEFAULT_CLOUD_LEVERS).sort(),
    )
    // A lever that only steers a measurement is a control.
    for (const field of CLOUD_STEERING_LEVERS)
      expect(CLOUD_LEVER_KINDS[field], field).toBe('control')
  })
})

describe('the reset key', () => {
  it('changes exactly with the reset levers, one lever at a time', () => {
    const base = cloudResetKey(DEFAULT_CLOUD_LEVERS)
    for (const [field, value] of Object.entries(CHANGED)) {
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

describe('the field key', () => {
  it('changes exactly with the field levers, one lever at a time', () => {
    const base = cloudFieldKey(DEFAULT_CLOUD_LEVERS)
    for (const [field, value] of Object.entries(CHANGED)) {
      const key = cloudFieldKey({ ...DEFAULT_CLOUD_LEVERS, [field]: value })
      expect(key !== base, field).toBe(
        (FIELD_LEVERS as readonly string[]).includes(field),
      )
    }
  })

  it('is equal for two lever sets exactly when their field levers are', () => {
    fc.assert(
      fc.property(levers, levers, (a, b) => {
        const same = FIELD_LEVERS.every((field) => a[field] === b[field])
        return (cloudFieldKey(a) === cloudFieldKey(b)) === same
      }),
    )
  })

  it('moves the history’s key with it: a change of field is a change of what a texel means', () => {
    fc.assert(
      fc.property(levers, levers, (a, b) => {
        if (cloudFieldKey(a) === cloudFieldKey(b)) return true
        return cloudResetKey(a) !== cloudResetKey(b)
      }),
    )
  })
})

describe('the levers’ hash', () => {
  const steering: readonly string[] = CLOUD_STEERING_LEVERS

  it('is eight hex digits', () => {
    expect(cloudLeversHash(DEFAULT_CLOUD_LEVERS)).toMatch(/^[0-9a-f]{8}$/)
    fc.assert(
      fc.property(levers, (set) => /^[0-9a-f]{8}$/.test(cloudLeversHash(set))),
    )
  })

  it('changes with every shipped lever and with no steering one, one lever at a time', () => {
    const base = cloudLeversHash(DEFAULT_CLOUD_LEVERS)
    for (const [field, value] of Object.entries(CHANGED)) {
      const hash = cloudLeversHash({ ...DEFAULT_CLOUD_LEVERS, [field]: value })
      expect(hash !== base, field).toBe(!steering.includes(field))
    }
  })

  it('is equal for two lever sets exactly when their shipped levers are', () => {
    const shipped = (
      Object.keys(DEFAULT_CLOUD_LEVERS) as (keyof CloudLevers)[]
    ).filter((field) => !steering.includes(field))
    fc.assert(
      fc.property(levers, levers, (a, b) => {
        const same = shipped.every((field) => a[field] === b[field])
        return (cloudLeversHash(a) === cloudLeversHash(b)) === same
      }),
      { numRuns: 1000 },
    )
  })

  it('does not depend on the order a script wrote the levers in', () => {
    const reversed = Object.fromEntries(
      Object.entries(CHANGED).reverse(),
    ) as unknown as CloudLevers
    expect(Object.keys(reversed)).not.toEqual(Object.keys(CHANGED))
    expect(cloudLeversHash(reversed)).toBe(cloudLeversHash(CHANGED))
  })

  it('keeps an address whole, whatever it holds', () => {
    const a = { ...DEFAULT_CLOUD_LEVERS, served: 'a","b', second: null }
    const b = { ...DEFAULT_CLOUD_LEVERS, served: 'a', second: 'b' }
    expect(cloudLeversHash(a)).not.toBe(cloudLeversHash(b))
  })
})

describe('the resolved levers', () => {
  it('are the set’s own at every size', () => {
    const sizes = [
      { width: 1920, height: 1080, dpr: 1 },
      { width: 2880, height: 1800, dpr: 2 },
      { width: 64, height: 48, dpr: 1 },
    ]
    fc.assert(
      fc.property(levers, fc.constantFrom(...sizes), (set, size) => {
        const resolved = resolveCloudLevers(set, size)
        return (
          isCloudLevers(resolved) &&
          cloudLeversHash(resolved) === cloudLeversHash(set) &&
          (Object.keys(set) as (keyof CloudLevers)[]).every(
            (field) => resolved[field] === set[field],
          )
        )
      }),
    )
  })
})
