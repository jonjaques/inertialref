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
    expect(inspector.sample().generationVersions).toHaveProperty(
      'galaxy-field',
      5,
    )
  } finally {
    session.dispose()
  }
})

it.each([
  ['face-on', 717.214480614703, 7487.652652469748],
  ['edge-on', 1590.5710188003495, 21423.440947345145],
  ['observer', 1181.1187820142607, 31539.958563673834],
] as const)(
  'retains the dust-free numeric plate reference for %s',
  (view, max, sum) => {
    const session = openSession()
    try {
      const plate = session.harness
        .galaxy()
        .plate({ view, width: 12, height: 8, dustScale: 0 })
      expect(plate.fieldVersions).toEqual({ 'galaxy-field': 5 })
      expect(plate.emissionOnly).toBe(true)
      expect(plate.maxRadiance).toBeCloseTo(max, 6)
      expect([...plate.rgb].reduce((a, b) => a + b, 0)).toBeCloseTo(sum, 6)
    } finally {
      session.dispose()
    }
  },
)

it.each([
  ['face-on', 575.8589556097868, 6259.954182128778],
  ['edge-on', 1571.0587561538625, 20997.910904522727],
  ['observer', 827.2060659471728, 25474.868167374992],
] as const)(
  'pins galaxy-field@5 dust transport plates for %s',
  (view, max, sum) => {
    const session = openSession()
    try {
      const inspector = session.harness.galaxy()
      const plate = inspector.plate({ view, width: 12, height: 8 })
      expect(plate.fieldVersions).toEqual({ 'galaxy-field': 5 })
      expect(plate.emissionOnly).toBe(false)
      expect(plate.maxStepParsecs).toBe(10)
      expect(plate.maxRadiance).toBeCloseTo(max, 6)
      expect([...plate.rgb].reduce((a, b) => a + b, 0)).toBeCloseTo(sum, 6)
      const ray = inspector.ray({ x: 1, y: 0, z: 0 }, { distanceParsecs: 100 })
      expect(ray.transmittanceRgb[0]).toBeLessThan(1)
      expect(ray.transmittanceRgb[2]).toBeLessThan(ray.transmittanceRgb[0])
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
