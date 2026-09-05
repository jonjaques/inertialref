import { expect, it } from 'vitest'
import { PARSEC } from '@inertialref/shared'
import { UV } from '@inertialref/spatial'
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
