import type { Meters } from '@inertialref/shared'
import { invariant } from '@inertialref/shared'
import { Quaternion as Q, Vec, type Vec3 } from '@inertialref/spatial'
import {
  heightfieldStride,
  type RegionAddress,
  regionDirection,
} from '@inertialref/universe'
import { regionSpacing } from './terrainSelect.ts'

/*
 * Terrain patch geometry.
 *
 * A pure function from (heightfield, region, body radius) to vertex buffers.
 * Deliberately not a React component and not a Three.js call: it is the
 * expensive part, it is the part worth testing, and keeping it here means the
 * same code could run in a worker later without moving anything.
 *
 * Vertices are emitted in **body-fixed axes, relative to the patch's own
 * anchor** — the point on the datum sphere at the middle of the patch. Two
 * things follow, and both matter:
 *
 *   - The geometry does not depend on where the planet is or which way it is
 *     facing, so it is built once and never rebuilt. It used to bake the body's
 *     pose and the render origin into every vertex, which made it wrong the
 *     instant the planet moved — and a planet is always moving. Landed on a
 *     world orbiting at 52 km/s, the ground slid ~865 m *per frame* away from
 *     the ship and snapped back on the next rebase, ten times a second.
 *   - The numbers stay small. Vertices measured from the body's center are
 *     ~10^6 m, where float32 resolves 0.17 m and meter-scale relief disappears;
 *     measured from the patch anchor they are a few hundred meters.
 *
 * The pose goes back on at draw time, as a position and a rotation, which is
 * what `patchPlacement` computes and exactly what the datum sphere beside it
 * has always done.
 *
 * Every patch also carries where each of its vertices goes when it hands over
 * to its parent. That is the CDLOD morph (Strugar 2009): a vertex slides toward
 * the position the parent's coarser grid holds for it, arriving exactly as the
 * parent takes over, so the switch has nothing left to pop. The arithmetic is
 * here rather than in the shader because the endpoint is a claim that can be
 * tested — a fully morphed child *equals* its parent, vertex for vertex — and a
 * TSL graph cannot be evaluated in Node. The shader's whole share of it is one
 * `mix`.
 */

export interface PatchInput {
  readonly region: RegionAddress
  /** Vertices per side of the patch itself, excluding the border. */
  readonly resolution: number
  /** Rings of samples outside the patch, as generated. */
  readonly border: number
  readonly elevations: Float32Array
  readonly bodyRadius: Meters
}

export interface RenderPatch {
  readonly region: RegionAddress
  readonly resolution: number
  /** xyz triples in body-fixed axes, relative to `anchor`. */
  readonly positions: Float32Array
  /** Unit normals in body-fixed axes, exact everywhere including the edge. */
  readonly normals: Float32Array
  /** Where each vertex sits once fully morphed onto the parent's grid. */
  readonly morphPositions: Float32Array
  /** The normal it shades with there — the parent's, over the parent's cells. */
  readonly morphNormals: Float32Array
  /** Shared between every patch of this resolution; see `patchIndices`. */
  readonly indices: Uint32Array
  /**
   * The patch's origin: the datum-sphere point at its center, in body-fixed
   * axes. Every vertex is measured from here, and `patchPlacement` turns it
   * back into a render-space position.
   */
  readonly anchor: Vec3
  /** Bounding sphere in the same anchor-relative axes the vertices are in. */
  readonly boundsCentre: Vec3
  readonly boundsRadius: Meters
  /** Ground one grid cell covers: the patch's own LOD error, in meters. */
  readonly spacing: Meters
}

/**
 * The triangle list for a patch, shared by every patch of that resolution.
 *
 * It is a function of the resolution and nothing else — 24,576 indices, 98 KB —
 * and a whole-disk selection holds two hundred patches. Handing each of them
 * its own copy was 20 MB of identical numbers and, worse, 200 GPU buffers where
 * one will do: the renderer keys its buffers on the attribute, so one shared
 * `BufferAttribute` over this array is one upload for the session.
 *
 * Winding is counter-clockwise seen from *outside* the planet, because the
 * material is single-sided and the GPU culls by winding, not by the normal
 * attribute. These triangles were (a, c, b) / (b, c, d) — clockwise from
 * outside on every cube face — so every patch was invisible from above and the
 * "ground" on screen was the datum sphere 11 km below it, with the far slopes
 * of distant ridges leaking through as a band floating over the horizon.
 * `faceToDirection` gives ∂/∂s × ∂/∂t = outward on all six faces, so one order
 * is right everywhere; the test asserts it face by face.
 */
const indexCache = new Map<number, Uint32Array>()

export function patchIndices(resolution: number): Uint32Array {
  const held = indexCache.get(resolution)
  if (held !== undefined) return held
  const quads = (resolution - 1) * (resolution - 1)
  const indices = new Uint32Array(quads * 6)
  let cursor = 0
  for (let row = 0; row < resolution - 1; row += 1) {
    for (let col = 0; col < resolution - 1; col += 1) {
      const a = row * resolution + col
      const b = a + 1
      const c = a + resolution
      const d = c + 1
      indices[cursor++] = a
      indices[cursor++] = b
      indices[cursor++] = c
      indices[cursor++] = b
      indices[cursor++] = d
      indices[cursor++] = c
    }
  }
  indexCache.set(resolution, indices)
  return indices
}

export function buildPatch(input: PatchInput): RenderPatch {
  const { region, resolution, border, elevations, bodyRadius } = input
  invariant(
    border >= 2,
    `A patch needs two rings of border to morph; got ${border}`,
  )
  const stride = heightfieldStride({ resolution, border })
  invariant(
    elevations.length === stride * stride,
    `Heightfield is ${elevations.length} samples, expected ${stride * stride}`,
  )

  // The datum point at the middle of the patch. Subtracting it is what keeps
  // the vertices small enough for float32 to hold meter-scale relief.
  const anchor = Vec.scale(regionDirection(region, 0.5, 0.5), bodyRadius)

  /*
   * The border rows carry positions too, and they are needed only to difference
   * against — so they live in a scratch grid in float64 rather than in the
   * patch. Float64 because a normal is a difference of two nearby numbers and
   * the whole point of the anchor is that those numbers are close together.
   */
  const extended = new Float64Array(stride * stride * 3)
  const step = resolution - 1
  for (let row = -border; row < resolution + border; row += 1) {
    const t = row / step
    for (let col = -border; col < resolution + border; col += 1) {
      const s = col / step
      const sample = (row + border) * stride + (col + border)
      const direction = regionDirection(region, s, t)
      const elevation = elevations[sample] ?? 0
      const local = Vec.sub(
        Vec.scale(direction, bodyRadius + elevation),
        anchor,
      )
      extended[sample * 3] = local.x
      extended[sample * 3 + 1] = local.y
      extended[sample * 3 + 2] = local.z
    }
  }

  const at = (row: number, col: number, axis: number): number =>
    extended[((row + border) * stride + (col + border)) * 3 + axis] ?? 0

  const count = resolution * resolution
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  const morphPositions = new Float32Array(count * 3)
  const morphNormals = new Float32Array(count * 3)

  let lowX = Infinity
  let lowY = Infinity
  let lowZ = Infinity
  let highX = -Infinity
  let highY = -Infinity
  let highZ = -Infinity

  for (let row = 0; row < resolution; row += 1) {
    for (let col = 0; col < resolution; col += 1) {
      const index = row * resolution + col
      const x = at(row, col, 0)
      const y = at(row, col, 1)
      const z = at(row, col, 2)
      positions[index * 3] = x
      positions[index * 3 + 1] = y
      positions[index * 3 + 2] = z
      if (x < lowX) lowX = x
      if (y < lowY) lowY = y
      if (z < lowZ) lowZ = z
      if (x > highX) highX = x
      if (y > highY) highY = y
      if (z > highZ) highZ = z

      writeNormal(at, anchor, row, col, 1, normals, index)

      /*
       * The parent's grid holds a vertex at every *even* index of this one:
       * a patch covers half its parent's side, and 64 quads halved is 32, so
       * the child's even columns land on the parent's columns exactly. Snapping
       * each vertex to the even index below it therefore lands every vertex on
       * a parent vertex — which is what makes the fully morphed tessellation
       * equal to the parent's rather than merely close to it.
       */
      const evenRow = row & ~1
      const evenCol = col & ~1
      morphPositions[index * 3] = at(evenRow, evenCol, 0)
      morphPositions[index * 3 + 1] = at(evenRow, evenCol, 1)
      morphPositions[index * 3 + 2] = at(evenRow, evenCol, 2)
      // Two cells, because that is one of the parent's. Shading has to hand
      // over with the geometry or the switch trades a pop for a shimmer.
      writeNormal(at, anchor, evenRow, evenCol, 2, morphNormals, index)
    }
  }

  return {
    region,
    resolution,
    positions,
    normals,
    morphPositions,
    morphNormals,
    indices: patchIndices(resolution),
    anchor,
    boundsCentre: {
      x: (lowX + highX) / 2,
      y: (lowY + highY) / 2,
      z: (lowZ + highZ) / 2,
    },
    boundsRadius: Math.hypot(highX - lowX, highY - lowY, highZ - lowZ) / 2 || 1,
    spacing: regionSpacing(bodyRadius, region, resolution),
  }
}

/**
 * A surface normal by central difference over `reach` cells either side.
 *
 * This is not a polish detail. Radial normals shade a mountain range exactly
 * like a smooth sphere, so terrain generated at real planetary relief — a few
 * kilometers on a few thousand — is completely invisible. And the difference
 * has to be central *everywhere*: a one-sided difference at the patch's edge is
 * half the gradient over half the span, which draws as a lit hairline along
 * every patch boundary. The border rows exist so that this loop never has to
 * ask where the edge is.
 */
function writeNormal(
  at: (row: number, col: number, axis: number) => number,
  anchor: Vec3,
  row: number,
  col: number,
  reach: number,
  out: Float32Array,
  index: number,
): void {
  const du = [
    at(row, col + reach, 0) - at(row, col - reach, 0),
    at(row, col + reach, 1) - at(row, col - reach, 1),
    at(row, col + reach, 2) - at(row, col - reach, 2),
  ] as const
  const dv = [
    at(row + reach, col, 0) - at(row - reach, col, 0),
    at(row + reach, col, 1) - at(row - reach, col, 1),
    at(row + reach, col, 2) - at(row - reach, col, 2),
  ] as const

  let nx = du[1] * dv[2] - du[2] * dv[1]
  let ny = du[2] * dv[0] - du[0] * dv[2]
  let nz = du[0] * dv[1] - du[1] * dv[0]
  const length = Math.hypot(nx, ny, nz)
  if (length === 0) {
    // Degenerate only where the field is exactly flat over five samples, and
    // then radial is the answer rather than a fallback.
    const radial = Vec.normalize(
      Vec.add(anchor, {
        x: at(row, col, 0),
        y: at(row, col, 1),
        z: at(row, col, 2),
      }),
    )
    out[index * 3] = radial.x
    out[index * 3 + 1] = radial.y
    out[index * 3 + 2] = radial.z
    return
  }

  nx /= length
  ny /= length
  nz /= length
  /*
   * `∂/∂s × ∂/∂t` is outward on all six cube faces, so the sign is a formality
   * — but it is a cheap one, and the one thing that would silently invert a
   * patch is a face convention changing under it.
   */
  const radial = Vec.add(anchor, {
    x: at(row, col, 0),
    y: at(row, col, 1),
    z: at(row, col, 2),
  })
  const sign = nx * radial.x + ny * radial.y + nz * radial.z < 0 ? -1 : 1
  out[index * 3] = nx * sign
  out[index * 3 + 1] = ny * sign
  out[index * 3 + 2] = nz * sign
}

/** Where a patch sits, which way it faces, and how big it is drawn. */
export interface PatchPlacement {
  readonly position: Vec3
  readonly orientation: Q.Quat
  /** The body's own render scale. 1 in the near field. */
  readonly scale: number
}

/**
 * Put a body-fixed patch back into render space, on the body it belongs to.
 *
 * Called once per patch per frame, and that frequency is the point: the body's
 * pose changes every tick, so anything that bakes it into vertex data is stale
 * before it is drawn. This is the same two lines the datum sphere gets from
 * `placeAt`, which is why the sphere tracked the planet correctly while the
 * terrain in front of it did not.
 *
 * `bodyPosition` and `scale` come from that same `placeAt`, and the patch has
 * to wear both. Beyond `NEAR_LIMIT` — two thousand kilometers, which the
 * surface tier reaches out to more than eight radii — a body is drawn at a
 * compressed distance and a matching scale, so its angular size survives and
 * its depth does not. Terrain placed at true meters against a sphere placed at
 * compressed ones is not slightly wrong, it is somewhere else. The old opacity
 * fade hid this by drawing no terrain above about an octave of altitude; with
 * the fade retired the patches reach the compressed range on every approach.
 */
export function patchPlacement(
  patch: RenderPatch,
  bodyPosition: Vec3,
  bodyOrientation: Q.Quat,
  scale: number,
): PatchPlacement {
  return {
    position: Vec.add(
      bodyPosition,
      Vec.scale(Q.rotate(bodyOrientation, patch.anchor), scale),
    ),
    orientation: bodyOrientation,
    scale,
  }
}
