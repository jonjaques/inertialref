import { describe, expect, it } from 'vitest'
import {
  FOV_MAX,
  FOV_MIN,
  SCENARIO_IDS,
  verticalFovDegrees,
} from '@inertialref/rendering'
import { TEST_CATALOG } from '@inertialref/universe'
import { openSession } from './session.ts'
import { CORNERSTONES, findPicture, PICTURES } from './pictures.ts'

/*
 * The cornerstones' counterparts of the every-picture loops over
 * `PICTURES`, which they are deliberately left out of: the lists a player
 * sees, "Export all", the tour and `presets:check` read that list alone.
 * The link round trip is `scripts/driveUrl.test.mjs`'s, since the link is
 * the app's.
 */

describe('the cornerstones', () => {
  it('are the nine pictures and the overlay guard, in their own list, with ids no shipped picture uses', () => {
    expect(CORNERSTONES.map((one) => one.id)).toEqual([
      'weather-e1-cumulus-orbit',
      'weather-e2-limb-dusk',
      'weather-e3-whole-face',
      'weather-g1-fair',
      'weather-g2-overcast-shore',
      'weather-g3-underlit-dusk',
      'weather-g4-over-deck',
      'weather-g5-inside',
      'weather-g6-descent',
      'weather-guard-station',
    ])
    const shipped = new Set(PICTURES.map((one) => one.id))
    for (const one of CORNERSTONES) {
      expect(shipped.has(one.id), one.id).toBe(false)
      expect(one.id.startsWith('weather-'), one.id).toBe(true)
      // Found by the same verb as a shipped picture, and only after them.
      expect(findPicture(one.id)).toBe(one)
    }
  })

  it('each hold a regime this build draws, and the build’s own processing', () => {
    for (const one of CORNERSTONES) {
      expect(SCENARIO_IDS, one.id).toContain(one.weather?.regime)
      expect(one.processing, one.id).toBeDefined()
    }
  })

  it('each name a lens inside the instrument’s range', () => {
    for (const one of CORNERSTONES) {
      const fov =
        one.lens === undefined
          ? one.fovDeg!
          : verticalFovDegrees({
              ...one.lens,
              focus: one.lens.focus ?? Infinity,
            })
      // To a rounding of the floor: E1 and E2 sit on it exactly.
      expect(fov, one.id).toBeGreaterThanOrEqual(FOV_MIN - 1e-9)
      expect(fov, one.id).toBeLessThanOrEqual(FOV_MAX)
    }
  })

  it('each resolve an address the catalog has', () => {
    // Earth's three resolve against the test catalog; the generated world's
    // need the real one, and the cornerstone ledger takes all nine there.
    const session = openSession({ catalog: TEST_CATALOG, workers: null })
    try {
      for (const one of CORNERSTONES.filter((p) => p.address.includes('SOL')))
        expect(
          session.harness.preset(one.id).status.target?.address,
          one.id,
        ).toContain(one.address)
    } finally {
      session.dispose()
    }
  })

  it('hand their weather to the host with the body’s full address, a station’s to the body it goes round, and a picture without weather hands none', () => {
    const calls: [unknown, string][] = []
    const session = openSession({
      catalog: TEST_CATALOG,
      workers: null,
      render: {
        setWeather: (weather, address) => {
          calls.push([weather, address])
          return weather === null ? 'none' : 'drawn'
        },
      },
    })
    try {
      const taken = session.harness.preset('weather-e1-cumulus-orbit')
      expect(taken.weather).toBe('drawn')
      expect(calls.at(-1)).toEqual([
        { regime: 'fair-cumulus' },
        'g:milky-way/s:SOL/b:2',
      ])
      // The guard stands at the ISS, and its clouds are Earth's: a station's
      // own address names no body the clouds could be served on.
      const guard = session.harness.preset('weather-guard-station')
      expect(guard.status.target?.kind).toBe('station')
      expect(guard.weather).toBe('drawn')
      expect(calls.at(-1)).toEqual([
        { regime: 'fair-cumulus' },
        'g:milky-way/s:SOL/b:2',
      ])
      expect(session.harness.preset('earthrise').weather).toBe('none')
      expect(calls.at(-1)?.[0]).toBeNull()
    } finally {
      session.dispose()
    }
  })
})
