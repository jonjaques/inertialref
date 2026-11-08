import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Vec3 } from '@inertialref/spatial'
import {
  CUBE_FACES,
  type CubeFace,
  cubeDirection,
  cubeFaceOf,
  cubeTexelCoordinate,
  cubeTexelMeters,
} from './cubeSphere.ts'

/*
 * The weather cube's addressing: what the maps bake into, what the far
 * atlases read, and what `cloudGeometry.ts`'s `cubeAtlasUv` reproduces on the
 * GPU. The face rule and the warp are the contract between the two sides, so
 * they are pinned here as properties of every direction, not of a few.
 */

const FACES = [0, 1, 2, 3, 4, 5] as const

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})

const direction = fc
  .tuple(
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
  )
  .filter(([x, y, z]) => Math.hypot(x, y, z) > 1e-3)
  .map(([x, y, z]) => {
    const length = Math.hypot(x, y, z)
    return { x: x / length, y: y / length, z: z / length }
  })

/** The solid angle of the spherical triangle a, b, c (Van Oosterom and Strackee). */
function triangle(a: Vec3, b: Vec3, c: Vec3): number {
  const numerator = Math.abs(dot(a, cross(b, c)))
  const denominator = 1 + dot(a, b) + dot(b, c) + dot(c, a)
  return 2 * Math.atan2(numerator, denominator)
}

describe('the weather cube', () => {
  it('lays each face out with a × b = normal, so every tile is drawn the same way round', () => {
    for (const { normal, a, b } of CUBE_FACES) {
      expect(cross(a, b)).toEqual(normal)
      expect(dot(a, normal)).toBe(0)
      expect(dot(b, normal)).toBe(0)
    }
  })

  it('takes a direction back from its face and warped coordinates to 10⁻¹²', () => {
    fc.assert(
      fc.property(direction, (d) => {
        const { face, a, b } = cubeFaceOf(d)
        expect(Math.abs(a)).toBeLessThanOrEqual(1)
        expect(Math.abs(b)).toBeLessThanOrEqual(1)
        const back = cubeDirection(face, a, b)
        expect(Math.abs(back.x - d.x)).toBeLessThan(1e-12)
        expect(Math.abs(back.y - d.y)).toBeLessThan(1e-12)
        expect(Math.abs(back.z - d.z)).toBeLessThan(1e-12)
      }),
      { numRuns: 10_000 },
    )
  })

  it('gives a tie to the earlier axis and counts a zero as positive, as the GPU does', () => {
    expect(cubeFaceOf({ x: 1, y: 1, z: 0 }).face).toBe(0)
    expect(cubeFaceOf({ x: -1, y: 1, z: 1 }).face).toBe(1)
    expect(cubeFaceOf({ x: 0, y: 1, z: 1 }).face).toBe(2)
    expect(cubeFaceOf({ x: 0, y: -1, z: 1 }).face).toBe(3)
    expect(cubeFaceOf({ x: 0, y: 0, z: 1 }).face).toBe(4)
    expect(cubeFaceOf({ x: 0, y: 0, z: -1 }).face).toBe(5)
    expect(cubeFaceOf({ x: -0, y: 0, z: 0 }).face).toBe(0)
  })

  it('is the warp u = tan(a·π/4) on the face plane', () => {
    fc.assert(
      fc.property(direction, (d) => {
        const { face, a, b } = cubeFaceOf(d)
        const axes = CUBE_FACES[face]!
        const depth = dot(d, axes.normal)
        expect(Math.tan((a * Math.PI) / 4)).toBeCloseTo(
          dot(d, axes.a) / depth,
          12,
        )
        expect(Math.tan((b * Math.PI) / 4)).toBeCloseTo(
          dot(d, axes.b) / depth,
          12,
        )
      }),
    )
  })

  it('varies a texel’s solid angle across a face by no more than 1.42', () => {
    /*
     * √2 in the limit: the density is (π/4)²(1 + u²)(1 + v²)/(1 + u² + v²)^1.5,
     * 1 at the center and 1/√2 at an edge's midpoint. A finite texel averages
     * it, so the ratio comes in under √2 = 1.4142.
     */
    const size = 64
    let least = Infinity
    let most = 0
    let total = 0
    for (let i = 0; i < size; i += 1)
      for (let j = 0; j < size; j += 1) {
        const at = (di: number, dj: number) =>
          cubeDirection(
            0,
            -1 + (2 * (i + di)) / size,
            -1 + (2 * (j + dj)) / size,
          )
        const corners = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)] as const
        const solid =
          triangle(corners[0], corners[1], corners[2]) +
          triangle(corners[0], corners[2], corners[3])
        least = Math.min(least, solid)
        most = Math.max(most, solid)
        total += solid
      }
    // 1.397 at 64 texels a face, closing on √2 as the texels shrink.
    expect(most / least).toBeLessThanOrEqual(1.42)
    expect(most / least).toBeGreaterThan(1.39)
    // Six faces tile the sphere.
    expect(total * 6).toBeCloseTo(4 * Math.PI, 10)
  })

  it('puts a texel’s center at −1 + (2(i − gutter) + 1)/size', () => {
    expect(cubeTexelCoordinate(512, 1, 1)).toBe(-1 + 1 / 512)
    expect(cubeTexelCoordinate(512, 1, 512)).toBe(1 - 1 / 512)
    expect(cubeTexelCoordinate(512, 1, 0)).toBe(-1 - 1 / 512)
    expect(cubeTexelCoordinate(512, 1, 513)).toBe(1 + 1 / 512)
  })

  it('fills each gutter with directions inside the neighbor face, a half texel in', () => {
    /*
     * Past an edge of face f the direction belongs to the face whose normal is
     * that edge's axis, and its coordinate across the shared edge there is the
     * neighbor's own first texel center: the tangent warp is one function of
     * the angle on both sides of an edge. What the bake writes in a gutter is
     * therefore the neighbor's interior, so a bilinear read across the edge
     * never mixes in anything the neighbor does not hold.
     */
    const size = 512
    const gutter = 1
    const negate = (v: Vec3): Vec3 => ({ x: -v.x, y: -v.y, z: -v.z })
    for (const face of FACES) {
      const axes = CUBE_FACES[face]!
      for (let index = gutter; index < gutter + size; index += 7) {
        const along = cubeTexelCoordinate(size, gutter, index)
        const edges: readonly [Vec3, Vec3][] = [
          [
            cubeDirection(face, cubeTexelCoordinate(size, gutter, 0), along),
            negate(axes.a),
          ],
          [
            cubeDirection(
              face,
              cubeTexelCoordinate(size, gutter, size + 1),
              along,
            ),
            axes.a,
          ],
          [
            cubeDirection(face, along, cubeTexelCoordinate(size, gutter, 0)),
            negate(axes.b),
          ],
          [
            cubeDirection(
              face,
              along,
              cubeTexelCoordinate(size, gutter, size + 1),
            ),
            axes.b,
          ],
        ]
        for (const [held, outward] of edges) {
          const there = cubeFaceOf(held)
          const neighbor = CUBE_FACES[there.face]!
          // By the dot product, not `toEqual`: a negated axis carries −0
          // where the neighbor's normal has 0, and `toEqual` tells them apart.
          expect(dot(neighbor.normal, outward)).toBe(1)
          // The neighbor's axis that points back across the shared edge.
          const back =
            dot(neighbor.a, CUBE_FACES[face]!.normal) !== 0 ? there.a : there.b
          const toward =
            dot(neighbor.a, axes.normal) + dot(neighbor.b, axes.normal)
          expect(back).toBeCloseTo(toward * (1 - 1 / size), 12)
          expect(Math.abs(there.a)).toBeLessThan(1)
          expect(Math.abs(there.b)).toBeLessThan(1)
        }
      }
    }
  })

  it('sizes a texel at 19.6 km at the face’s center on Earth, and 2√2/3 of that at its corner', () => {
    const R = 6_371_000
    const size = 512
    const { center, corner } = cubeTexelMeters(size, R)
    expect(center).toBeCloseTo(19_546, 0)
    // Measured: the arc between neighboring texel centers there.
    const arc = (face: CubeFace, a0: number, a1: number, b: number) =>
      R * Math.acos(dot(cubeDirection(face, a0, b), cubeDirection(face, a1, b)))
    const step = 2 / size
    expect(arc(4, -step / 2, step / 2, 0) / center).toBeCloseTo(1, 6)
    expect(
      arc(4, 1 - 1.5 * step, 1 - 0.5 * step, 1 - 0.5 * step) / corner,
    ).toBeCloseTo(1, 2)
    expect(corner / center).toBeCloseTo((2 * Math.SQRT2) / 3, 12)
  })
})
