import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Quaternion as Q, UV, Vec, vec3 } from '@inertialref/spatial'
import { World } from '@inertialref/simulation'
import {
  SOL_ONLY_CATALOG,
  systemId,
  bodyFixedFrameId,
  geodeticDirection,
  drawnSurfaceRadius,
  surfaceRadius,
} from '@inertialref/universe'
import { characterCameraPose } from './characterCamera.ts'
import { localTriad } from './surfaceStance.ts'

const world = new World({ seed: 'inertialref', catalog: SOL_ONLY_CATALOG })
const body = world.loadSystem(systemId('SOL')).planets[3]!
const spin = world.frames.pose(bodyFixedFrameId(body.address), 0)

describe('the character eye', () => {
  it('stands above the drawn ground at any latitude, including the poles', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -Math.PI / 2, max: Math.PI / 2, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        (latitude, longitude) => {
          const d = geodeticDirection(latitude, longitude)
          const triad = localTriad(d)
          const orientation = Q.multiply(
            spin.orientation,
            Q.fromBasis(triad.east, triad.up, Vec.scale(triad.north, -1)),
          )
          const position = UV.translate(
            spin.position,
            Q.rotate(spin.orientation, Vec.scale(d, surfaceRadius(body, d))),
          )
          const result = characterCameraPose({
            position,
            orientation,
            body,
            spin,
            structures: [],
            eyeHeight: 1.68,
            pitch: 0,
            view: 'first',
          })
          expect(
            UV.distance(result.position, spin.position) -
              drawnSurfaceRadius(body, d),
          ).toBeCloseTo(1.68, 3)
          expect(UV.distance(result.position, result.feet)).toBeCloseTo(1.68, 3)
          expect(
            Vec.dot(
              Q.rotate(result.orientation, vec3(0, 0, -1)),
              Q.rotate(spin.orientation, d),
            ),
          ).toBeCloseTo(0, 8)
        },
      ),
      { numRuns: 30 },
    )
  })

  it('shortens the third-person boom when looking down would put it underground', () => {
    const d = geodeticDirection(0, 0)
    const triad = localTriad(d)
    const orientation = Q.multiply(
      spin.orientation,
      Q.fromBasis(triad.east, triad.up, Vec.scale(triad.north, -1)),
    )
    const position = UV.translate(
      spin.position,
      Q.rotate(spin.orientation, Vec.scale(d, surfaceRadius(body, d))),
    )
    const input = {
      position,
      orientation,
      body,
      spin,
      structures: [],
      eyeHeight: 1.04,
      pitch: 1.4,
      view: 'third' as const,
    }
    const result = characterCameraPose(input)
    expect(UV.distance(result.position, result.feet)).toBeLessThan(2)
    expect(
      UV.distance(result.position, spin.position) - drawnSurfaceRadius(body, d),
    ).toBeGreaterThan(0.15)
  })
})
