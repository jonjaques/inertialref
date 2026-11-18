import { describe, expect, it } from 'vitest'
import { FOV_MAX, FOV_MIN, verticalFovDegrees } from '@inertialref/rendering'
import { TEST_CATALOG } from '@inertialref/universe'
import { openSession } from './session.ts'
import { AIR_CHECKS, CORNERSTONES, findPicture, PICTURES } from './pictures.ts'
import { sunAt } from './solarTime.ts'

/*
 * The air checks: Mars's air under the clouds' page, in their own list. Held
 * as the cornerstones are, to ids no other list uses, to a lens the
 * instrument reaches, and to the sun each says it stands under, since an
 * instant is a claim nobody can check by reading it.
 */

/** A solved sun's tolerance, degrees: the cornerstone ledger's. */
const SUN_TOLERANCE = 0.5

describe('the air checks', () => {
  it('are two pictures of Mars, with ids no other list uses, and no weather', () => {
    expect(AIR_CHECKS.map((one) => one.id)).toEqual([
      'mars-ground-dusk',
      'mars-orbit-limb',
    ])
    const others = new Set([...PICTURES, ...CORNERSTONES].map((one) => one.id))
    for (const one of AIR_CHECKS) {
      expect(others.has(one.id), one.id).toBe(false)
      expect(findPicture(one.id)).toBe(one)
      expect(one.address, one.id).toBe('s:SOL/b:3')
      expect(one.weather, one.id).toBeUndefined()
      const fov = verticalFovDegrees({
        ...one.lens!,
        focus: one.lens!.focus ?? Infinity,
      })
      expect(fov, one.id).toBeGreaterThanOrEqual(FOV_MIN)
      expect(fov, one.id).toBeLessThanOrEqual(FOV_MAX)
    }
  })

  it('stand under the sun each says: two degrees and setting on Elysium, twelve over the limb’s sub-point', () => {
    const session = openSession({ catalog: TEST_CATALOG, workers: null })
    try {
      const expected = { 'mars-ground-dusk': 2, 'mars-orbit-limb': 12 }
      for (const one of AIR_CHECKS) {
        expect(
          session.harness.preset(one.id).status.target?.address,
          one.id,
        ).toContain(one.address)
        if (one.framing.kind !== 'camera' || one.framing.surface === null)
          throw new Error(`${one.id} is not a surface stance`)
        const place = one.framing.surface
        const now = sunAt(session.harness.world, one.address, place, one.time)
        const later = sunAt(
          session.harness.world,
          one.address,
          place,
          one.time + 600,
        )
        expect(
          Math.abs(now.elevation - expected[one.id as keyof typeof expected]),
          one.id,
        ).toBeLessThan(SUN_TOLERANCE)
        // Falling: both are late in the day.
        expect(later.elevation, one.id).toBeLessThan(now.elevation)
        // Each faces the sun, so the sky round it is the one in frame.
        const heading = (place.heading * 180) / Math.PI
        expect(Math.abs(heading - now.azimuth), one.id).toBeLessThan(
          SUN_TOLERANCE,
        )
      }
    } finally {
      session.dispose()
    }
  })
})
