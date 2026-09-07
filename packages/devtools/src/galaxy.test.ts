import { expect, it } from 'vitest'
import { PARSEC } from '@inertialref/shared'
import { UV } from '@inertialref/spatial'
import type { GalaxyPopulation } from '@inertialref/universe'
import { openSession } from './session.ts'
it('makes repeatable CPU plates through a session without changing canonical state', () => {
  const session = openSession({ seed: 'galaxy-plate' })
  try {
    const before = session.world.stateHash()
    const inspector = session.harness.galaxy()
    for (const view of ['face-on', 'edge-on', 'observer'] as const) {
      const a = inspector.plate({ view, width: 12, height: 8 })
      expect(a.rgb).toEqual(inspector.plate({ view, width: 12, height: 8 }).rgb)
      expect(a.maxRadiance).toBeGreaterThan(0)
      expect(
        [...a.rgb].every((value) => Number.isFinite(value) && value >= 0),
      ).toBe(true)
    }
    expect(session.world.stateHash()).toBe(before)
    const a = inspector.plate({ view: 'observer', width: 8, height: 4 })
    expect(a.rgb).not.toEqual(
      inspector.plate({
        view: 'observer',
        width: 8,
        height: 4,
        observer: UV.fromMeters(0, 30000 * PARSEC, 0),
      }).rgb,
    )
    expect(inspector.sample().generationVersions).not.toHaveProperty(
      'galaxy-field',
    )
  } finally {
    session.dispose()
  }
})

it.each([
  ['face-on', 7467.533615960387, 30824.638347876065],
  ['edge-on', 13467.419656853888, 62747.68437106824],
  ['observer', 11347.873133070729, 144661.7075324133],
] as const)(
  'pins galaxy-field@2 numeric plate values for %s',
  (view, max, sum) => {
    const session = openSession()
    try {
      const plate = session.harness
        .galaxy()
        .plate({ view, width: 12, height: 8 })
      expect(plate.fieldVersions).toEqual({ 'galaxy-field': 2 })
      expect(plate.maxRadiance).toBeCloseTo(max, 6)
      expect([...plate.rgb].reduce((a, b) => a + b, 0)).toBeCloseTo(sum, 6)
    } finally {
      session.dispose()
    }
  },
)

it('rejects a runtime population typo instead of returning a mislabeled composite', () => {
  const session = openSession()
  try {
    expect(() =>
      session.harness.galaxy().plate({
        width: 1,
        height: 1,
        population: 'youngArm' as GalaxyPopulation,
      }),
    ).toThrow('Unknown galaxy population')
  } finally {
    session.dispose()
  }
})
it.each([
  ['face-on', 12],
  ['edge-on', 6],
  ['observer', 6],
] as const)(
  'derives the %s default height from the requested width',
  (view, height) => {
    const session = openSession()
    try {
      const inspector = session.harness.galaxy()
      const plate = inspector.plate({ view, width: 12 })
      expect(plate.height).toBe(height)
      expect(plate.rgb).toEqual(
        inspector.plate({ view, width: 12, height }).rgb,
      )
    } finally {
      session.dispose()
    }
  },
)
