import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Quaternion as Q, Vec, type Vec3, vec3 } from '@inertialref/spatial'
import { type ArrayRotor, sunTracking } from './solarArrays.ts'

/*
 * The ISS's layout as its model states it: two alpha joints on the truss
 * (station +X), masts fore and aft at rest, blankets facing along the truss.
 * Wings on one rotor point their masts both ways and face both ways, which
 * is the case a sign error hides in.
 */
const rotor = (name: string, side: 1 | -1): ArrayRotor => ({
  name,
  axis: vec3(side, 0, 0),
  mast: vec3(0, 0, 1),
  wings: [
    { name: `${name}.aft`, axis: vec3(0, 0, 1), normal: vec3(side, 0, 0) },
    { name: `${name}.fore`, axis: vec3(0, 0, -1), normal: vec3(-side, 0, 0) },
  ],
})
const ROTORS = [rotor('port', -1), rotor('starboard', 1)]

/** Where a wing's cell side faces once both joints have turned. */
function facing(
  rotor: ArrayRotor,
  wing: ArrayRotor['wings'][number],
  angles: ReadonlyMap<string, number>,
): Vec3 {
  const beta = Q.fromAxisAngle(Vec.normalize(wing.axis), angles.get(wing.name)!)
  const alpha = Q.fromAxisAngle(
    Vec.normalize(rotor.axis),
    angles.get(rotor.name)!,
  )
  return Q.rotate(alpha, Q.rotate(beta, wing.normal))
}

const direction = fc
  .tuple(
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
  )
  .map(([x, y, z]) => vec3(x, y, z))
  .filter((v) => Vec.length(v) > 0.1)
  .map((v) => Vec.normalize(v))

describe('solar arrays track the Sun', () => {
  it('faces every wing at the Sun, wherever it is (property)', () => {
    fc.assert(
      fc.property(direction, (sun) => {
        const angles = sunTracking(sun, ROTORS)
        for (const rotor of ROTORS)
          for (const wing of rotor.wings)
            expect(Vec.dot(facing(rotor, wing, angles), sun)).toBeCloseTo(1, 9)
      }),
    )
  })

  it('turns alpha once an orbit as the Sun goes round the masts’ plane', () => {
    // Nadir attitude carries the Sun round the truss once an orbit: alpha
    // follows it through a whole turn, and beta, with the Sun in the plane
    // the masts sweep, holds still — a quarter turn from a rest pose that
    // faces the blankets along the truss.
    let previous: number | null = null
    let travel = 0
    const held = new Set<number>()
    for (let step = 0; step <= 360; step += 1) {
      const phase = (step * Math.PI) / 180
      const sun = vec3(0, Math.cos(phase), Math.sin(phase))
      const angles = sunTracking(sun, ROTORS)
      const alpha = angles.get('starboard')!
      if (previous !== null) {
        const delta = Math.atan2(
          Math.sin(alpha - previous),
          Math.cos(alpha - previous),
        )
        expect(Math.abs(delta)).toBeLessThan(0.02)
        travel += delta
      }
      previous = alpha
      held.add(Math.round(angles.get('starboard.aft')! * 1e9))
    }
    expect(Math.abs(travel)).toBeCloseTo(2 * Math.PI, 9)
    expect([...held].map((beta) => Math.abs(beta / 1e9))).toEqual([
      Math.round((Math.PI / 2) * 1e9) / 1e9,
    ])
  })

  it('leaves alpha alone and tilts the blanket for a Sun along the truss', () => {
    const angles = sunTracking(vec3(1, 0, 0), ROTORS)
    expect(Math.abs(angles.get('starboard')!)).toBe(0)
    const wing = ROTORS[1]!.wings[0]!
    expect(
      Vec.dot(facing(ROTORS[1]!, wing, angles), vec3(1, 0, 0)),
    ).toBeCloseTo(1, 12)
  })
})
