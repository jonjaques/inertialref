import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  basis,
  fromAxisAngle,
  fromBasis,
  IDENTITY,
  integrate,
  multiply,
  normalize,
  rotate,
  rotateInverse,
  slerp,
  approxEquals,
} from './quat.ts'
import * as V from './vec3.ts'
import { vec3 } from './vec3.ts'

const anyRotation = fc
  .record({
    ax: fc.double({ min: -1, max: 1, noNaN: true }),
    ay: fc.double({ min: -1, max: 1, noNaN: true }),
    az: fc.double({ min: -1, max: 1, noNaN: true }),
    angle: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
  })
  .filter((r) => Math.hypot(r.ax, r.ay, r.az) > 1e-6)
  .map((r) => fromAxisAngle(vec3(r.ax, r.ay, r.az), r.angle))

describe('Quat', () => {
  it('rotates and un-rotates (property)', () => {
    fc.assert(
      fc.property(anyRotation, (q) => {
        const v = vec3(3, -4, 5)
        expect(V.distance(rotateInverse(q, rotate(q, v)), v)).toBeLessThan(
          1e-12,
        )
        // Rotation preserves length.
        expect(V.length(rotate(q, v))).toBeCloseTo(V.length(v), 12)
      }),
    )
  })

  it('composes in the documented order', () => {
    const yaw = fromAxisAngle(vec3(0, 1, 0), Math.PI / 2)
    const pitch = fromAxisAngle(vec3(1, 0, 0), Math.PI / 2)
    // multiply(a, b) applies b first, then a.
    const combined = multiply(yaw, pitch)
    expect(
      V.approxEquals(
        rotate(combined, vec3(0, 0, -1)),
        rotate(yaw, rotate(pitch, vec3(0, 0, -1))),
        1e-12,
      ),
    ).toBe(true)
  })

  it('round-trips through a basis (property)', () => {
    fc.assert(
      fc.property(anyRotation, (q) => {
        const b = basis(q)
        // basis() reports right/up/forward, where forward is -Z.
        const recovered = fromBasis(b.right, b.up, V.negate(b.forward))
        expect(approxEquals(recovered, q, 1e-9)).toBe(true)
      }),
    )
  })

  it('builds a stable basis for 180-degree rotations', () => {
    const flipped = fromBasis(vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, 0, -1))
    expect(
      V.approxEquals(rotate(flipped, vec3(1, 0, 0)), vec3(-1, 0, 0), 1e-12),
    ).toBe(true)
    expect(Number.isFinite(flipped.w)).toBe(true)
  })

  it('integrates a full turn back to identity', () => {
    let q = IDENTITY
    const rate = 2 * Math.PI
    for (let i = 0; i < 64; i += 1) q = integrate(q, vec3(0, rate, 0), 1 / 64)
    expect(approxEquals(q, IDENTITY, 1e-12)).toBe(true)
  })

  it('slerps the short way round', () => {
    const a = fromAxisAngle(vec3(0, 1, 0), 0.1)
    const b = normalize({ x: -a.x, y: -a.y, z: -a.z, w: -a.w })
    // -q is the same orientation; slerping to it must not spin 360 degrees.
    expect(approxEquals(slerp(a, b, 0.5), a, 1e-9)).toBe(true)
  })
})
