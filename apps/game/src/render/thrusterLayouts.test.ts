import { describe, expect, it } from 'vitest'
import { Vec, vec3 } from '@inertialref/spatial'
import {
  driveThrottle,
  nozzleFiring,
  prepareNozzles,
  type ThrusterLayout,
} from '@inertialref/rendering'
import { shipSpec } from './ships.ts'
import { LAID_OUT_SHIPS, thrusterLayoutFor } from './thrusterLayouts.ts'

/*
 * The measured tables, held to what a hull is.
 *
 * None of this checks the artwork — `scripts/nozzles.mjs` is what reads the
 * model — but a table copied by hand can lose a sign or a decimal, and every
 * such slip breaks one of these: a valve outside the hull, a pair that does
 * not mirror, an exhaust that is not a direction.
 */

const fire = (layout: ThrusterLayout, linear: Vec3, angular: Vec3) => {
  const out = new Float32Array(layout.nozzles.length)
  nozzleFiring(prepareNozzles(layout), { linear, angular, drive: 0 }, out)
  return Array.from(out)
}
type Vec3 = ReturnType<typeof vec3>

describe.each(LAID_OUT_SHIPS)('the %s layout', (id) => {
  const layout = thrusterLayoutFor(id)
  const spec = shipSpec(id)
  if (spec === undefined) throw new Error(`${id} is not in the manifest`)
  const half = spec.lengthMetres / 2

  it('is inside the hull it was measured off', () => {
    for (const nozzle of layout.nozzles) {
      expect(Math.abs(nozzle.position.z)).toBeLessThanOrEqual(half)
      // No hull here is wider than it is long.
      expect(Math.abs(nozzle.position.x)).toBeLessThanOrEqual(half)
      expect(Math.abs(nozzle.position.y)).toBeLessThanOrEqual(half)
      expect(nozzle.radius).toBeGreaterThan(0)
      expect(nozzle.radius).toBeLessThan(half)
    }
    if (layout.drive !== null) {
      expect(Math.abs(layout.drive.position.z)).toBeLessThanOrEqual(half)
      expect(layout.drive.radius).toBeLessThan(half)
    }
  })

  it('points every exhaust somewhere, and unit', () => {
    for (const nozzle of layout.nozzles)
      expect(Vec.length(nozzle.exhaust)).toBeCloseTo(1, 2)
  })

  it('is mirror-symmetric about the centreline', () => {
    const key = (v: Vec3) =>
      `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`
    const seen = new Set(
      layout.nozzles.map(
        (n) => `${n.kind}|${key(n.position)}|${key(n.exhaust)}`,
      ),
    )
    for (const n of layout.nozzles) {
      const mirror = `${n.kind}|${key(vec3(-n.position.x, n.position.y, n.position.z))}|${key(vec3(-n.exhaust.x, n.exhaust.y, n.exhaust.z))}`
      expect(seen.has(mirror)).toBe(true)
    }
  })

  it('has a valve for every axis, both ways', () => {
    // Each of the twelve half-axes lights at least one nozzle: a ship that
    // could be commanded to roll left with nothing drawn firing is a ship
    // whose picture cannot be believed.
    const zero = Vec.ZERO
    for (const axis of [0, 1, 2] as const)
      for (const sign of [1, -1]) {
        const linear = vec3(
          axis === 0 ? sign : 0,
          axis === 1 ? sign : 0,
          axis === 2 ? sign : 0,
        )
        // A push ahead is the thrusters' too, and the only valves that
        // lean aft are the stern corners at a quarter, so it is a dim set;
        // every other way has a valve pointing the way it is asked.
        const floor = axis === 2 && sign === -1 ? 0.2 : 0.3
        expect(fire(layout, linear, zero).some((v) => v > floor)).toBe(true)
        expect(fire(layout, zero, linear).some((v) => v > 0.3)).toBe(true)
      }
  })
})

describe('the Rocinante in particular', () => {
  const layout = thrusterLayoutFor('rocinante')
  const at = (x: number, y: number, z: number) =>
    layout.nozzles.findIndex(
      (n) =>
        Math.abs(n.position.x - x) < 0.05 &&
        Math.abs(n.position.y - y) < 0.05 &&
        Math.abs(n.position.z - z) < 0.05,
    )

  it('pitches nose-up with the chin valve and the top corners astern', () => {
    const firing = fire(layout, Vec.ZERO, vec3(1, 0, 0))
    const chin = at(0, -1.139, -16.125)
    const crown = at(0, 1.737, -15.049)
    expect(firing[chin]).toBe(1)
    expect(firing[crown]).toBe(0)
    expect(firing[at(3.272, 3.163, 12.022)]).toBeGreaterThan(0.6)
    expect(firing[at(3.272, -3.163, 12.022)]).toBe(0)
  })

  it('brakes with the nose: a retro lights the tip jet and nothing astern', () => {
    const firing = fire(layout, vec3(0, 0, 1), Vec.ZERO)
    expect(firing[at(0, -0.05, -17.717)]).toBeCloseTo(0.999, 3)
    for (const n of layout.nozzles.keys())
      if ((layout.nozzles[n]?.position.z ?? 0) > 0) expect(firing[n]).toBe(0)
    expect(
      driveThrottle({ linear: vec3(0, 0, 1), angular: Vec.ZERO, drive: 0 }),
    ).toBe(0)
  })

  it('pushes ahead on the stern corners, and burns on the drive alone', () => {
    // The thrusters ahead: the four stern corners lean a quarter aft and
    // take it, nothing forward of the centre opens, and the drive stays cold
    // — it is its own number, and a full burn opens no valve at all.
    const firing = fire(layout, vec3(0, 0, -1), Vec.ZERO)
    for (const n of layout.nozzles.keys())
      if ((layout.nozzles[n]?.position.z ?? 0) < 0) expect(firing[n]).toBe(0)
    expect(firing[at(3.272, -3.163, 12.022)]).toBeGreaterThan(0.2)
    expect(firing[at(-3.272, 3.163, 12.022)]).toBeGreaterThan(0.2)
    const ahead = { linear: vec3(0, 0, -1), angular: Vec.ZERO, drive: 0 }
    expect(driveThrottle(ahead)).toBe(0)
    const burn = { linear: Vec.ZERO, angular: Vec.ZERO, drive: 1 }
    expect(driveThrottle(burn)).toBe(1)
    expect(fire(layout, Vec.ZERO, Vec.ZERO).every((v) => v === 0)).toBe(true)
  })
})

describe('a hull nobody measured', () => {
  it('flies with nothing drawn', () => {
    expect(thrusterLayoutFor('enterprise-d')).toEqual({
      nozzles: [],
      drive: null,
    })
  })
})
