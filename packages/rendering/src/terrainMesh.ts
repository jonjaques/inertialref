import type { Meters } from '@inertialref/shared'
import { invariant } from '@inertialref/shared'
import { Quaternion as Q, Vec, type Vec3 } from '@inertialref/spatial'
import {
  COVER_CHANNELS,
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
 * tested on any Node, with no GPU — a fully morphed child *equals* its parent,
 * vertex for vertex. The shader's whole share of it is one `mix`.
 */

export interface PatchInput {
  readonly region: RegionAddress
  /** Vertices per side of the patch itself, excluding the border. */
  readonly resolution: number
  /** Rings of samples outside the patch, as generated. */
  readonly border: number
  readonly elevations: Float32Array
  /**
   * Four bytes of surface cover per vertex, row-major, **unbordered**.
   *
   * The asymmetry with `elevations` is deliberate and it is the border's own
   * reason restated: those rings exist to be differenced against, and nothing
   * differences the cover. `resolution²` entries where the heightfield has
   * `(resolution + 2·border)²`. See `cover.ts` in `packages/universe`.
   */
  readonly cover: Uint8Array
  readonly bodyRadius: Meters
  /**
   * The elevation of the sea datum, or null where no sheet is drawn.
   *
   * Null on a dry world and on a mapped one — a photograph's sea is in the
   * photograph — so the caller decides whether a sheet exists and this only
   * decides whether *this patch* needs one, which is whether the ground under
   * it goes below the datum anywhere.
   */
  readonly seaLevel?: Meters | null
}

/**
 * The sea over a patch: the datum sphere, meshed on the patch's own grid.
 *
 * A second surface rather than a colour on the first, because a shore seen
 * from a landed ship is a flat sheet meeting a slope, and the ground under it
 * is a seabed the sheet is looked *through*. The vertices are anchor-relative
 * for the reason the patch's are, and they morph onto the parent's grid for
 * the reason the patch's do: the parent's sheet is the parent's chord of the
 * same sphere, and a child whose sheet did not slide onto it would show a
 * sliver of seabed along every level boundary. `depths` is the one thing the
 * material cannot derive — the ground under the sheet — and it morphs with
 * the rest so the shallows do not shimmer at the handover.
 */
export interface WaterPatch {
  /** xyz triples in body-fixed axes, relative to the patch's `anchor`, on the datum. */
  readonly positions: Float32Array
  /** Where each vertex sits once fully morphed onto the parent's grid. */
  readonly morphPositions: Float32Array
  /** Sea datum minus the ground, meters, never negative. Zero where the ground is dry. */
  readonly depths: Float32Array
  readonly morphDepths: Float32Array
  /** Bounding sphere in the same anchor-relative axes the vertices are in. */
  readonly boundsCentre: Vec3
  readonly boundsRadius: Meters
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
  /**
   * Surface cover per vertex, four bytes, as generated.
   *
   * The one buffer here that is `PatchInput`'s own array rather than a fresh
   * one — the heightfield's, which the caller may still be holding in a field
   * cache. Nothing writes to it, and copying 17 KB a patch to say so is the
   * expensive half of terrain's memory paid twice; but a producer that ever
   * pools or rewrites a heightfield has to know this attribute is a view of it.
   */
  readonly cover: Uint8Array
  /**
   * And the cover it wears once morphed: the parent's, at the parent's vertex.
   *
   * The material has to hand over with the geometry for the same reason the
   * normal does. A fully morphed child sits exactly where its parent sits, so
   * if it is still wearing its own vertex's cover there, the frame the parent
   * takes over is the frame every ray and every mare edge jumps by one child
   * cell — a shimmering ring at the morph band rather than a pop, which is
   * worse because it does not stop.
   */
  readonly morphCover: Uint8Array
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
  /** The sea over this patch, or null where the sea reaches none of it. */
  readonly water: WaterPatch | null
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
  const { region, resolution, border, elevations, cover, bodyRadius } = input
  const seaLevel = input.seaLevel ?? null
  invariant(
    border >= 2,
    `A patch needs two rings of border to morph; got ${border}`,
  )
  /*
   * The morph snaps to `index & ~1`, which lands on a parent vertex only
   * because a child covers half its parent's side and `resolution - 1` is even
   * — 64 quads halved is 32. An even resolution would leave the snapped index
   * somewhere the parent has no vertex, and the morph would silently stop
   * being exact rather than fail.
   */
  invariant(
    resolution % 2 === 1,
    `A patch resolution must be odd so the morph lands on the parent's grid; got ${resolution}`,
  )
  const stride = heightfieldStride({ resolution, border })
  invariant(
    elevations.length === stride * stride,
    `Heightfield is ${elevations.length} samples, expected ${stride * stride}`,
  )
  invariant(
    cover.length === resolution * resolution * COVER_CHANNELS,
    `Cover is ${cover.length} bytes, expected ${resolution * resolution * COVER_CHANNELS}`,
  )

  // The datum point at the middle of the patch. Subtracting it is what keeps
  // the vertices small enough for float32 to hold meter-scale relief.
  const anchor = Vec.scale(regionDirection(region, 0.5, 0.5), bodyRadius)
  const anchorX = anchor.x
  const anchorY = anchor.y
  const anchorZ = anchor.z

  /*
   * The border rows carry positions too, and they are needed only to difference
   * against — so they live in a scratch grid in float64 rather than in the
   * patch. Float64 because a normal is a difference of two nearby numbers and
   * the whole point of the anchor is that those numbers are close together.
   *
   * Everything below this line is written in scalars against flat arrays, which
   * is not a style choice. A patch is 4,761 samples, and the readable version —
   * a `Vec3` per direction, per scaled position, per difference, and a pair of
   * three-element arrays per normal — allocated about 40,000 short-lived
   * objects and cost **6.26 ms**. That is six frames' worth of terrain budget
   * for one patch, on the main thread, in the middle of a descent that wants
   * four hundred of them.
   */
  const extended = new Float64Array(stride * stride * 3)
  /*
   * The datum sheet's vertices, kept beside the ground's over the interior
   * only — the sheet has no normals to difference and so no border — and
   * only while some interior sample is under the sea. `wet` is decided in
   * the same pass so the sheet costs nothing on a patch the sea never
   * reaches, which on an ocean world is still most of the land.
   */
  const sheet =
    seaLevel === null ? null : new Float64Array(resolution * resolution * 3)
  const seaRadius = bodyRadius + (seaLevel ?? 0)
  let wet = false
  const step = resolution - 1
  for (let row = -border; row < resolution + border; row += 1) {
    const t = row / step
    for (let col = -border; col < resolution + border; col += 1) {
      const sample = (row + border) * stride + (col + border)
      // `regionDirection` rather than the face arithmetic inlined: it is the
      // named producer of a body-fixed direction and the one place the cube
      // convention lives. It is also the only allocation left in this loop.
      const direction = regionDirection(region, col / step, t)
      const elevation = elevations[sample] ?? 0
      const radius = bodyRadius + elevation
      extended[sample * 3] = direction.x * radius - anchorX
      extended[sample * 3 + 1] = direction.y * radius - anchorY
      extended[sample * 3 + 2] = direction.z * radius - anchorZ
      if (
        sheet !== null &&
        row >= 0 &&
        col >= 0 &&
        row < resolution &&
        col < resolution
      ) {
        const at = (row * resolution + col) * 3
        sheet[at] = direction.x * seaRadius - anchorX
        sheet[at + 1] = direction.y * seaRadius - anchorY
        sheet[at + 2] = direction.z * seaRadius - anchorZ
        if (elevation < (seaLevel as number)) wet = true
      }
    }
  }

  const count = resolution * resolution
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  const morphPositions = new Float32Array(count * 3)
  const morphNormals = new Float32Array(count * 3)
  const morphCover = new Uint8Array(count * COVER_CHANNELS)

  let lowX = Infinity
  let lowY = Infinity
  let lowZ = Infinity
  let highX = -Infinity
  let highY = -Infinity
  let highZ = -Infinity

  for (let row = 0; row < resolution; row += 1) {
    for (let col = 0; col < resolution; col += 1) {
      const index = row * resolution + col
      const sample = ((row + border) * stride + (col + border)) * 3
      const x = extended[sample] as number
      const y = extended[sample + 1] as number
      const z = extended[sample + 2] as number
      positions[index * 3] = x
      positions[index * 3 + 1] = y
      positions[index * 3 + 2] = z
      if (x < lowX) lowX = x
      if (y < lowY) lowY = y
      if (z < lowZ) lowZ = z
      if (x > highX) highX = x
      if (y > highY) highY = y
      if (z > highZ) highZ = z

      writeNormal(extended, stride, border, row, col, 1, normals, index, anchor)

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
      const even = ((evenRow + border) * stride + (evenCol + border)) * 3
      morphPositions[index * 3] = extended[even] as number
      morphPositions[index * 3 + 1] = extended[even + 1] as number
      morphPositions[index * 3 + 2] = extended[even + 2] as number
      // The cover is unbordered, so it indexes off the patch's own grid rather
      // than the extended one — the same even vertex, a different stride.
      const evenCover = (evenRow * resolution + evenCol) * COVER_CHANNELS
      const target = index * COVER_CHANNELS
      for (let channel = 0; channel < COVER_CHANNELS; channel += 1) {
        morphCover[target + channel] = cover[evenCover + channel] as number
      }
      // Two cells, because that is one of the parent's. Shading has to hand
      // over with the geometry or the switch trades a pop for a shimmer.
      writeNormal(
        extended,
        stride,
        border,
        evenRow,
        evenCol,
        2,
        morphNormals,
        index,
        anchor,
      )
    }
  }

  return {
    region,
    resolution,
    positions,
    normals,
    morphPositions,
    morphNormals,
    cover,
    morphCover,
    indices: patchIndices(resolution),
    anchor,
    boundsCentre: {
      x: (lowX + highX) / 2,
      y: (lowY + highY) / 2,
      z: (lowZ + highZ) / 2,
    },
    boundsRadius: Math.hypot(highX - lowX, highY - lowY, highZ - lowZ) / 2 || 1,
    spacing: regionSpacing(bodyRadius, region, resolution),
    water:
      sheet !== null && wet
        ? buildWater(
            sheet,
            elevations,
            stride,
            border,
            resolution,
            seaLevel as number,
          )
        : null,
  }
}

/**
 * The sheet's attributes from the datum grid the main loop filled: the
 * positions, their morph targets at the parent's vertices, and the depth of
 * water over every vertex with its own morph target.
 */
function buildWater(
  sheet: Float64Array,
  elevations: Float32Array,
  stride: number,
  border: number,
  resolution: number,
  seaLevel: Meters,
): WaterPatch {
  const count = resolution * resolution
  const positions = new Float32Array(count * 3)
  const morphPositions = new Float32Array(count * 3)
  const depths = new Float32Array(count)
  const morphDepths = new Float32Array(count)
  let lowX = Infinity
  let lowY = Infinity
  let lowZ = Infinity
  let highX = -Infinity
  let highY = -Infinity
  let highZ = -Infinity
  const depthAt = (row: number, col: number): number =>
    Math.max(
      0,
      seaLevel - (elevations[(row + border) * stride + (col + border)] ?? 0),
    )
  for (let row = 0; row < resolution; row += 1) {
    for (let col = 0; col < resolution; col += 1) {
      const index = row * resolution + col
      const x = sheet[index * 3] as number
      const y = sheet[index * 3 + 1] as number
      const z = sheet[index * 3 + 2] as number
      positions[index * 3] = x
      positions[index * 3 + 1] = y
      positions[index * 3 + 2] = z
      if (x < lowX) lowX = x
      if (y < lowY) lowY = y
      if (z < lowZ) lowZ = z
      if (x > highX) highX = x
      if (y > highY) highY = y
      if (z > highZ) highZ = z
      // The same even-index snap the ground makes; see `buildPatch`.
      const evenRow = row & ~1
      const evenCol = col & ~1
      const even = (evenRow * resolution + evenCol) * 3
      morphPositions[index * 3] = sheet[even] as number
      morphPositions[index * 3 + 1] = sheet[even + 1] as number
      morphPositions[index * 3 + 2] = sheet[even + 2] as number
      depths[index] = depthAt(row, col)
      morphDepths[index] = depthAt(evenRow, evenCol)
    }
  }
  return {
    positions,
    morphPositions,
    depths,
    morphDepths,
    boundsCentre: {
      x: (lowX + highX) / 2,
      y: (lowY + highY) / 2,
      z: (lowZ + highZ) / 2,
    },
    boundsRadius: Math.hypot(highX - lowX, highY - lowY, highZ - lowZ) / 2 || 1,
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
  extended: Float64Array,
  stride: number,
  border: number,
  row: number,
  col: number,
  reach: number,
  out: Float32Array,
  index: number,
  anchor: Vec3,
): void {
  const here = (row + border) * stride + (col + border)
  const east = (here + reach) * 3
  const west = (here - reach) * 3
  const north = (here + reach * stride) * 3
  const south = (here - reach * stride) * 3

  const dux = (extended[east] as number) - (extended[west] as number)
  const duy = (extended[east + 1] as number) - (extended[west + 1] as number)
  const duz = (extended[east + 2] as number) - (extended[west + 2] as number)
  const dvx = (extended[north] as number) - (extended[south] as number)
  const dvy = (extended[north + 1] as number) - (extended[south + 1] as number)
  const dvz = (extended[north + 2] as number) - (extended[south + 2] as number)

  let nx = duy * dvz - duz * dvy
  let ny = duz * dvx - dux * dvz
  let nz = dux * dvy - duy * dvx
  const length = Math.hypot(nx, ny, nz)

  const centre = here * 3
  const rx = anchor.x + (extended[centre] as number)
  const ry = anchor.y + (extended[centre + 1] as number)
  const rz = anchor.z + (extended[centre + 2] as number)

  if (length === 0) {
    // Degenerate only where the field is exactly flat over five samples, and
    // then radial is the answer rather than a fallback.
    const radial = Math.hypot(rx, ry, rz) || 1
    out[index * 3] = rx / radial
    out[index * 3 + 1] = ry / radial
    out[index * 3 + 2] = rz / radial
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
  const sign = nx * rx + ny * ry + nz * rz < 0 ? -1 : 1
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
