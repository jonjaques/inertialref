import fc from 'fast-check'
import { Group, Vector3 } from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { vec3 } from '@inertialref/spatial'
import { stationRig, turnArrays } from './stationArrays.ts'

/*
 * A tree shaped as `build_iss.py` writes one: two alpha joints on the truss,
 * each holding four wings with masts fore and aft and cells facing inboard,
 * every joint at its pivot with no rotation and its extras in `userData`.
 */
function station(): { root: Group; wings: Group[] } {
  const root = new Group()
  const wings: Group[] = []
  for (const [side, x] of [
    ['PORT', -17.78],
    ['STBD', 17.78],
  ] as const) {
    const alpha = new Group()
    alpha.name = `${side}_ALPHA_ROT`
    alpha.position.set(x, 0, 0)
    alpha.userData = {
      joint: { kind: 'alpha', axis: [1, 0, 0], mast: [0, 0, 1] },
    }
    root.add(alpha)
    for (const [index, mast] of [1, -1, 1, -1].entries()) {
      const wing = new Group()
      wing.name = `${side}_BETA_ROT_${index}`
      wing.position.set(
        Math.sign(x) * (15.6 + 15 * (index >> 1)),
        0.66,
        2.7 * mast,
      )
      wing.userData = {
        joint: {
          kind: 'beta',
          axis: [0, 0, mast],
          normal: [side === 'PORT' ? 1 : -1, 0, 0],
        },
      }
      alpha.add(wing)
      wings.push(wing)
    }
  }
  return { root, wings }
}

describe('a station model’s arrays', () => {
  it('finds both rotors and the four wings each carries', () => {
    const { root } = station()
    const rig = stationRig(root)
    expect(rig.rotors.map((rotor) => rotor.name).sort()).toEqual([
      'PORT_ALPHA_ROT',
      'STBD_ALPHA_ROT',
    ])
    for (const rotor of rig.rotors) expect(rotor.wings).toHaveLength(4)
    expect(rig.nodes.size).toBe(10)
    expect(stationRig(new Group()).rotors).toEqual([])
  })

  it('faces every wing’s cells at the Sun through the scene graph (property)', () => {
    const direction = fc
      .tuple(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
      )
      .filter(([x, y, z]) => Math.hypot(x, y, z) > 0.1)
    fc.assert(
      fc.property(direction, ([x, y, z]) => {
        const { root, wings } = station()
        const length = Math.hypot(x, y, z)
        const sun = vec3(x / length, y / length, z / length)
        turnArrays(stationRig(root), sun)
        root.updateMatrixWorld(true)
        for (const wing of wings) {
          // The rest normal, carried through the wing's own turn and its
          // alpha joint's, the way the renderer composes them.
          const [nx, ny, nz] = (
            wing.userData as { joint: { normal: [number, number, number] } }
          ).joint.normal
          const facing = new Vector3(nx, ny, nz).transformDirection(
            wing.matrixWorld,
          )
          expect(facing.dot(new Vector3(sun.x, sun.y, sun.z))).toBeCloseTo(1, 9)
        }
      }),
    )
  })
})
