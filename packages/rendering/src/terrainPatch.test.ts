import { describe, expect, it } from 'vitest'
import { Vec, vec3, type Vec3 } from '@inertialref/spatial'
import { World } from '@inertialref/simulation'
import {
  type Body,
  generateHeightfield,
  HEIGHTFIELD_RESOLUTION,
  type RegionAddress,
  regionAddress,
  regionChildren,
  regionNeighbor,
  systemId,
  TEST_CATALOG,
  walkBodies,
} from '@inertialref/universe'
import { buildPatch, patchIndices, type RenderPatch } from './terrainMesh.ts'

/*
 * What a patch has to be true about, for the quadtree not to crack or pop.
 *
 * Both properties are geometry rather than shader, which is the point: the
 * morph is arranged so that the shader's whole share of it is one `mix`
 * between two attributes this file checks, on any Node and with no GPU. If
 * the endpoints are right, the interpolation between them cannot be wrong.
 */

const RESOLUTION = 33

function solidBody(): Body {
  const world = new World({ seed: 'inertialref', catalog: TEST_CATALOG })
  const system = world.loadSystem(systemId('SOL'))
  const body = [...walkBodies(system)].find((b) => b.surface.maxElevation > 0)
  if (body === undefined) throw new Error('no solid body')
  return body
}

function patchOf(body: Body, region: RegionAddress): RenderPatch {
  const field = generateHeightfield(body.surface, {
    region,
    resolution: RESOLUTION,
  })
  return buildPatch({
    region,
    resolution: RESOLUTION,
    border: field.border,
    elevations: field.elevations,
    cover: field.cover,
    bodyRadius: body.radius,
  })
}

/** A vertex in body-fixed axes: anchor-relative plus the anchor. */
const vertexOf = (patch: RenderPatch, index: number, of = 'positions'): Vec3 =>
  Vec.add(
    patch.anchor,
    vec3(
      (of === 'positions' ? patch.positions : patch.morphPositions)[
        index * 3
      ] as number,
      (of === 'positions' ? patch.positions : patch.morphPositions)[
        index * 3 + 1
      ] as number,
      (of === 'positions' ? patch.positions : patch.morphPositions)[
        index * 3 + 2
      ] as number,
    ),
  )

const normalOf = (patch: RenderPatch, index: number, of = 'normals'): Vec3 =>
  vec3(
    (of === 'normals' ? patch.normals : patch.morphNormals)[
      index * 3
    ] as number,
    (of === 'normals' ? patch.normals : patch.morphNormals)[
      index * 3 + 1
    ] as number,
    (of === 'normals' ? patch.normals : patch.morphNormals)[
      index * 3 + 2
    ] as number,
  )

describe('a terrain patch', () => {
  it('is exactly its parent once fully morphed', () => {
    /*
     * The claim CDLOD makes and the one this whole phase's "no pops" rests on:
     * a patch whose morph has run to one is not *approximately* its parent, it
     * is its parent, vertex for vertex — so the frame where the parent takes
     * over draws the same triangles as the frame before it.
     *
     * It holds because a child covers half its parent's side, 64 quads halved
     * is 32, and every even index of the child therefore lands on a parent grid
     * point. Snapping each vertex to the even index below it puts all of them
     * on parent vertices, and the field is a pure function of direction, so the
     * elevation there is the same number both patches computed.
     */
    const body = solidBody()
    const parentRegion = regionAddress(2, 8, 130, 97)
    const parent = patchOf(body, parentRegion)

    for (const [quadrant, childRegion] of regionChildren(
      parentRegion,
    ).entries()) {
      const child = patchOf(body, childRegion)
      const qi = quadrant % 2
      const qj = quadrant < 2 ? 0 : 1
      const half = (RESOLUTION - 1) / 2

      let worst = 0
      let worstNormal = 0
      for (let row = 0; row < RESOLUTION; row += 1) {
        for (let col = 0; col < RESOLUTION; col += 1) {
          const index = row * RESOLUTION + col
          // Where the parent keeps this vertex: the child's own even index,
          // expressed in the parent's grid.
          const parentIndex =
            (half * qj + (row & ~1) / 2) * RESOLUTION +
            (half * qi + (col & ~1) / 2)
          worst = Math.max(
            worst,
            Vec.distance(
              vertexOf(child, index, 'morphPositions'),
              vertexOf(parent, parentIndex),
            ),
          )
          const mine = normalOf(child, index, 'morphNormals')
          const theirs = normalOf(parent, parentIndex)
          /*
           * Compared component-wise rather than as an angle. `acos` of the dot
           * product of two float32 unit vectors reports 3.5e-4 radians for
           * vectors that are *bit-identical*, because it amplifies the
           * quantization by its own square root — which is a measurement
           * artifact of exactly the size a real disagreement would be.
           */
          worstNormal = Math.max(
            worstNormal,
            Math.abs(mine.x - theirs.x),
            Math.abs(mine.y - theirs.y),
            Math.abs(mine.z - theirs.z),
          )
        }
      }
      /*
       * The bound is float32 over a patch half-span and nothing else. At level
       * 8 on this body a patch is tens of kilometers across, where a float32
       * step is a few millimeters; the two patches subtract different anchors
       * from the same float64 position, so that rounding is the whole
       * disagreement.
       */
      expect(worst).toBeLessThan(0.05)
      /*
       * Normals agree *exactly* — the morph normal is a two-cell difference,
       * which is one of the parent's cells, taken over the same samples the
       * parent takes it over. Both patches compute it in float64 from the same
       * field and round once, so the bound is one float32 step in a unit
       * vector and not a tolerance for a near miss.
       */
      expect(worstNormal).toBeLessThan(1e-6)
    }
  })

  it("wears exactly its parent's cover once fully morphed", () => {
    /*
     * The same claim, for the material. Geometry that hands over exactly while
     * the albedo does not is worse than a pop: the ray edges and the mare
     * margins slide by one child cell across the whole morph band and keep
     * sliding as the camera moves, which reads as a shimmering ring around the
     * viewer rather than as a single switch.
     *
     * **Bit-exact, not close.** The cover is bytes, both patches evaluate the
     * same pure function of the same direction, and the child's snapped vertex
     * *is* a parent vertex — so there is no rounding for a tolerance to
     * absorb, and any disagreement at all is the two grids having been indexed
     * differently.
     */
    const body = solidBody()
    const parentRegion = regionAddress(2, 8, 130, 97)
    const parent = patchOf(body, parentRegion)

    for (const [quadrant, childRegion] of regionChildren(
      parentRegion,
    ).entries()) {
      const child = patchOf(body, childRegion)
      const qi = quadrant % 2
      const qj = quadrant < 2 ? 0 : 1
      const half = (RESOLUTION - 1) / 2

      for (let row = 0; row < RESOLUTION; row += 1) {
        for (let col = 0; col < RESOLUTION; col += 1) {
          const index = row * RESOLUTION + col
          const parentIndex =
            (half * qj + (row & ~1) / 2) * RESOLUTION +
            (half * qi + (col & ~1) / 2)
          for (let channel = 0; channel < 4; channel += 1) {
            expect(child.morphCover[index * 4 + channel]).toBe(
              parent.cover[parentIndex * 4 + channel],
            )
          }
        }
      }
    }
  })

  it('shares its edge vertices and its edge normals with its neighbor', () => {
    /*
     * Two patches at the same level meeting inside a cube face. The vertices
     * have to be identical rather than close, and so do the normals — a normal
     * that disagrees across a boundary is the hairline the one-sided edge
     * difference used to draw, which the border row exists to remove.
     */
    const body = solidBody()
    const left = regionAddress(4, 8, 100, 60)
    const right = regionNeighbor(left, 1, 0)
    expect(right.face).toBe(left.face)

    const a = patchOf(body, left)
    const b = patchOf(body, right)
    for (let row = 0; row < RESOLUTION; row += 1) {
      const mine = row * RESOLUTION + (RESOLUTION - 1)
      const theirs = row * RESOLUTION
      expect(Vec.distance(vertexOf(a, mine), vertexOf(b, theirs))).toBeLessThan(
        0.05,
      )
      // Bit-identical, in fact: inside a face a patch's border sample is the
      // same expression its neighbor evaluates for its own first interior row.
      expect(normalOf(a, mine)).toEqual(normalOf(b, theirs))
    }
  })

  it('meets its neighbor across a cube-face edge', () => {
    /*
     * The same thing where the addressing rotates. Which of the neighbor's four
     * edges this one is, and in which direction, is the arithmetic under test —
     * so the assertion is that exactly one of them matches, rather than naming
     * one and agreeing with a wrong answer.
     */
    const body = solidBody()
    const span = 2 ** 8
    for (let face = 0; face < 6; face += 1) {
      const mine = regionAddress(face, 8, span - 1, 120)
      const theirs = regionNeighbor(mine, 1, 0)
      expect(theirs.face).not.toBe(face)

      const a = patchOf(body, mine)
      const b = patchOf(body, theirs)
      const edge = (patch: RenderPatch, which: number): Vec3[] => {
        const out: Vec3[] = []
        for (let k = 0; k < RESOLUTION; k += 1) {
          const index =
            which === 0
              ? k * RESOLUTION
              : which === 1
                ? k * RESOLUTION + (RESOLUTION - 1)
                : which === 2
                  ? k
                  : (RESOLUTION - 1) * RESOLUTION + k
          out.push(vertexOf(patch, index))
        }
        return out
      }
      const target = edge(a, 1)
      /*
       * Matched by distance rather than by an equality on rounded coordinates.
       * The two patches subtract different anchors from the same float64
       * point, so their float32 vertices differ by millimeters — and a
       * quantized comparison turns a millimeter into a miss whenever the two
       * land either side of a bucket boundary.
       */
      const gap = (one: readonly Vec3[], other: readonly Vec3[]): number =>
        one.reduce(
          (worst, point, k) =>
            Math.max(worst, Vec.distance(point, other[k] as Vec3)),
          0,
        )
      const matches = [0, 1, 2, 3].filter((which) => {
        const other = edge(b, which)
        return (
          gap(target, other) < 0.05 || gap(target, [...other].reverse()) < 0.05
        )
      })
      expect(matches).toHaveLength(1)
    }
  })

  it('shares one index buffer across every patch of a resolution', () => {
    /*
     * 24,576 indices is 98 KB, a whole-disk selection is a couple of hundred
     * patches, and the triangle list is a function of the resolution alone. One
     * array means one GPU buffer for the session rather than one per patch.
     */
    const body = solidBody()
    const one = patchOf(body, regionAddress(0, 6, 12, 40))
    const two = patchOf(body, regionAddress(3, 9, 300, 12))
    expect(one.indices).toBe(two.indices)
    expect(one.indices).toBe(patchIndices(RESOLUTION))
    expect(patchIndices(HEIGHTFIELD_RESOLUTION)).not.toBe(one.indices)
  })

  it('refuses a heightfield that is the wrong size or has no border', () => {
    const body = solidBody()
    const region = regionAddress(1, 5, 7, 7)
    const field = generateHeightfield(body.surface, {
      region,
      resolution: RESOLUTION,
      border: 0,
    })
    expect(() =>
      buildPatch({
        region,
        resolution: RESOLUTION,
        border: 0,
        elevations: field.elevations,
        cover: field.cover,
        bodyRadius: body.radius,
      }),
    ).toThrow(/two rings/)
  })
})
