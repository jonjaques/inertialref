import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Vec, vec3, type Vec3 } from '@inertialref/spatial'
import { World } from '@inertialref/simulation'
import {
  type Body,
  generateHeightfield,
  type RegionAddress,
  regionAddress,
  regionChildren,
  regionDirection,
  systemId,
  TEST_CATALOG,
  walkBodies,
} from '@inertialref/universe'
import { patchGroundRadius, patchMorph } from './patchGround.ts'
import { buildPatch, type RenderPatch } from './terrainMesh.ts'

/*
 * The ground a rock stands on is the triangle the patch draws, and this is
 * what says so: read back along a direction, the answer is the plane of the
 * triangle the index buffer emits there, and with the morph complete it is
 * the parent's — the same endpoint the geometry itself is held to.
 */

function solidBody(): Body {
  const world = new World({ seed: 'inertialref', catalog: TEST_CATALOG })
  const system = world.loadSystem(systemId('SOL'))
  const body = [...walkBodies(system)].find((b) => b.surface.maxElevation > 0)
  if (body === undefined) throw new Error('no solid body')
  return body
}

const BODY = solidBody()

function patchOf(region: RegionAddress, resolution: number): RenderPatch {
  const field = generateHeightfield(BODY.surface, { region, resolution })
  return buildPatch({ ...field, bodyRadius: BODY.radius })
}

const vertex = (patch: RenderPatch, row: number, col: number): Vec3 => {
  const at = (row * patch.resolution + col) * 3
  return Vec.add(
    patch.anchor,
    vec3(
      patch.positions[at] as number,
      patch.positions[at + 1] as number,
      patch.positions[at + 2] as number,
    ),
  )
}

/** Where a ray from the body's center along `d` meets the plane of a, b, c. */
function planeRadius(d: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const n = Vec.cross(Vec.sub(b, a), Vec.sub(c, a))
  return Vec.dot(n, a) / Vec.dot(n, d)
}

/** The cube face's outward axis: the direction's dominant component, signed. */
function faceAxis(d: Vec3): Vec3 {
  const ax = Math.abs(d.x)
  const ay = Math.abs(d.y)
  const az = Math.abs(d.z)
  if (ax >= ay && ax >= az) return vec3(Math.sign(d.x), 0, 0)
  if (ay >= az) return vec3(0, Math.sign(d.y), 0)
  return vec3(0, 0, Math.sign(d.z))
}

/**
 * How far linear interpolation of a, b and c's radii over face coordinates
 * can stand from their plane: the chord's cut plus the projection's lean.
 */
function planeDeparture(a: Vec3, b: Vec3, c: Vec3): number {
  const edge = Math.max(
    Vec.distance(a, b),
    Vec.distance(b, c),
    Vec.distance(c, a),
  )
  const depths = [a, b, c].map((p) => Vec.dot(p, FACE_AXIS))
  const radii = [a, b, c].map(Vec.length)
  const lean = Math.max(...depths) / Math.min(...depths) - 1
  return (
    (edge * edge) / (6 * BODY.radius) +
    lean * (Math.max(...radii) - Math.min(...radii))
  )
}

// Deep enough that a float32 offset from the anchor resolves a millimeter.
const PARENT = regionAddress(4, 11, 1300, 700)
/** The outward axis of the patch's cube face, along which depth is taken. */
const FACE_AXIS = faceAxis(regionDirection(PARENT, 0.5, 0.5))

describe('the ground a patch draws, read along a direction', () => {
  for (const resolution of [33, 65]) {
    const patch = patchOf(PARENT, resolution)
    const step = resolution - 1

    it(`is each vertex's own radius at its vertex, at ${resolution}`, () => {
      for (let row = 0; row < resolution; row += 7) {
        for (let col = 0; col < resolution; col += 5) {
          const d = regionDirection(PARENT, col / step, row / step)
          const radius = patchGroundRadius(patch, d, null) as number
          expect(radius).toBeCloseTo(Vec.length(vertex(patch, row, col)), 6)
        }
      }
    })

    /*
     * The independent statement: the plane of the triangle `patchIndices`
     * emits for that cell, met by the ray from the center. The read
     * interpolates the corners' radii linearly in face coordinates, and the
     * plane is linear in neither, for two reasons. First, the plane cuts
     * under the chord between its corners, by at most the longest edge
     * squared over 6R. Second, the face's central projection is projective,
     * so the weights a point takes from the face coordinates lean by the
     * spread of the corners' depths along the face axis. That spread times
     * the corners' spread in radius bounds the second error. Together they
     * are 2.2 mm on this body's steepest level-11 triangle at 33 vertices a
     * side, and the worst over 200,000 directions is 0.75 of the sum at
     * either resolution. A bound from the face's mean cell alone is exceeded
     * by 2.8 times once fast-check strays from the vertices, because relief
     * lengthens the edges and the lean is first order in it.
     */
    it(`is the plane of the triangle drawn there, at ${resolution}`, () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 1, noNaN: true }),
          fc.double({ min: 0, max: 1, noNaN: true }),
          (s, t) => {
            const d = regionDirection(PARENT, s, t)
            const col = Math.min(step - 1e-9, s * step)
            const row = Math.min(step - 1e-9, t * step)
            const c0 = Math.floor(col)
            const r0 = Math.floor(row)
            const upper = col - c0 + (row - r0) <= 1
            const [a, b, c] = upper
              ? [
                  vertex(patch, r0, c0),
                  vertex(patch, r0, c0 + 1),
                  vertex(patch, r0 + 1, c0),
                ]
              : [
                  vertex(patch, r0, c0 + 1),
                  vertex(patch, r0 + 1, c0 + 1),
                  vertex(patch, r0 + 1, c0),
                ]
            const drawn = patchGroundRadius(patch, d, null) as number
            expect(Math.abs(drawn - planeRadius(d, a, b, c))).toBeLessThan(
              planeDeparture(a, b, c),
            )
          },
        ),
        { numRuns: 300 },
      )
    })
  }

  /*
   * The morph's endpoint, the property the CDLOD handover rests on: a child
   * fully morphed onto its parent's grid draws the parent's ground, so a rock
   * standing in the band stands on what the frame shows at either end of it.
   * Float32 offsets from two different anchors are what separate them.
   */
  it('is the parent’s ground once the morph is complete', () => {
    const parent = patchOf(PARENT, 65)
    for (const child of regionChildren(PARENT)) {
      const patch = patchOf(child, 65)
      for (let k = 0; k < 64; k += 1) {
        const s = ((k * 0.618034) % 1) * 0.999
        const t = ((k * 0.754877) % 1) * 0.999
        const d = regionDirection(child, s, t)
        // A band behind the eye: every vertex is past its end.
        const morphed = patchGroundRadius(patch, d, {
          eye: patch.anchor,
          start: -2,
          end: -1,
        }) as number
        const drawn = patchGroundRadius(parent, d, null) as number
        expect(Math.abs(morphed - drawn)).toBeLessThan(1e-3)
      }
    }
  })

  /*
   * And between the ends, where each vertex slides by its own factor and the
   * triangle over a point can be a neighbor stretched across it. The check is
   * the morphed mesh itself: every vertex moved toward its target by the
   * material's factor, and the ray met against the triangles around the
   * point, keeping the one it passes inside.
   */
  it('is the morphed mesh inside a band', () => {
    const patch = patchOf(PARENT, 65)
    const size = (64 * (Math.PI * BODY.radius)) / 2 / 2 ** PARENT.level / 64
    // The eye on the ground at the patch's middle, so the band crosses it.
    const band = {
      eye: vertex(patch, 32, 32),
      start: size * 0.2,
      end: size * 0.45,
    }
    const morphed = (r: number, c: number): Vec3 => {
      const at = (r * 65 + c) * 3
      const own = vertex(patch, r, c)
      const target = Vec.add(
        patch.anchor,
        vec3(
          patch.morphPositions[at] as number,
          patch.morphPositions[at + 1] as number,
          patch.morphPositions[at + 2] as number,
        ),
      )
      const k = patchMorph(Vec.distance(own, band.eye), band.start, band.end)
      return Vec.add(own, Vec.scale(Vec.sub(target, own), k))
    }
    const inside = (d: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null => {
      const n = Vec.cross(Vec.sub(b, a), Vec.sub(c, a))
      if (Vec.dot(n, n) < 1e-12) return null
      const radius = Vec.dot(n, a) / Vec.dot(n, d)
      const p = Vec.scale(d, radius)
      const edge = (x: Vec3, y: Vec3): number =>
        Vec.dot(Vec.cross(Vec.sub(y, x), Vec.sub(p, x)), n)
      const slack = -1e-9 * Vec.dot(n, n)
      return edge(a, b) >= slack && edge(b, c) >= slack && edge(c, a) >= slack
        ? radius
        : null
    }
    let banded = 0
    fc.assert(
      // Uniform over the patch: `fc.double` crowds its ends, and the band is
      // in the middle.
      fc.property(
        fc.integer({ min: 20, max: 980 }).map((x) => x / 1000),
        fc.integer({ min: 20, max: 980 }).map((x) => x / 1000),
        (s, t) => {
          const d = regionDirection(PARENT, s, t)
          const r0 = Math.floor(t * 64)
          const c0 = Math.floor(s * 64)
          let mesh: number | null = null
          for (let r = r0 - 1; r <= r0 + 1 && mesh === null; r += 1) {
            for (let c = c0 - 1; c <= c0 + 1 && mesh === null; c += 1) {
              mesh =
                inside(
                  d,
                  morphed(r, c),
                  morphed(r, c + 1),
                  morphed(r + 1, c),
                ) ??
                inside(
                  d,
                  morphed(r, c + 1),
                  morphed(r + 1, c + 1),
                  morphed(r + 1, c),
                )
            }
          }
          if (mesh === null) return
          const k = patchMorph(
            Vec.distance(vertex(patch, r0, c0), band.eye),
            band.start,
            band.end,
          )
          if (k > 0 && k < 1) banded += 1
          const drawn = patchGroundRadius(patch, d, band) as number
          expect(Math.abs(drawn - mesh)).toBeLessThan(1e-3)
        },
      ),
      { numRuns: 400 },
    )
    // The band crosses the patch, so the property was asked inside it.
    expect(banded).toBeGreaterThan(50)
  })

  it('answers nothing outside the patch', () => {
    const patch = patchOf(PARENT, 33)
    const beside = regionAddress(4, 11, 1302, 700)
    expect(
      patchGroundRadius(patch, regionDirection(beside, 0.5, 0.5), null),
    ).toBe(null)
    // Another face entirely.
    expect(patchGroundRadius(patch, vec3(1, 0, 0), null)).toBe(null)
  })

  it('morphs by the factor the material takes', () => {
    expect(patchMorph(10, 20, 30)).toBe(0)
    expect(patchMorph(25, 20, 30)).toBeCloseTo(0.5, 12)
    expect(patchMorph(40, 20, 30)).toBe(1)
    // A root's band is both ends at one enormous distance: never morphs.
    expect(patchMorph(1e9, 1e30, 1e30)).toBe(0)
  })
})
