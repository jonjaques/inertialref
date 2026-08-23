import type { Meters } from '@inertialref/shared'
import {
  Quaternion as Q,
  type RenderOrigin,
  toRenderSpace,
  type UniverseVector,
  Vec,
  type Vec3,
} from '@inertialref/spatial'
import { type RegionAddress, regionDirection } from '@inertialref/universe'

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
 */

export interface PatchInput {
  readonly region: RegionAddress
  readonly resolution: number
  readonly elevations: Float32Array
  readonly bodyRadius: Meters
}

export interface RenderPatch {
  readonly region: RegionAddress
  readonly resolution: number
  /** xyz triples in body-fixed axes, relative to `anchor`. */
  readonly positions: Float32Array
  /** Unit normals in body-fixed axes. */
  readonly normals: Float32Array
  readonly indices: Uint32Array
  /**
   * The patch's origin: the datum-sphere point at its center, in body-fixed
   * axes. Every vertex is measured from here, and `patchPlacement` turns it
   * back into a render-space position.
   */
  readonly anchor: Vec3
}

export function buildPatch(input: PatchInput): RenderPatch {
  const { region, resolution, elevations, bodyRadius } = input
  const count = resolution * resolution
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)

  // The datum point at the middle of the patch. Subtracting it is what keeps
  // the vertices small enough for float32 to hold meter-scale relief.
  const anchor = Vec.scale(regionDirection(region, 0.5, 0.5), bodyRadius)

  for (let row = 0; row < resolution; row += 1) {
    const t = row / (resolution - 1)
    for (let col = 0; col < resolution; col += 1) {
      const s = col / (resolution - 1)
      const index = row * resolution + col
      const direction = regionDirection(region, s, t)
      const elevation = elevations[index] ?? 0
      const local = Vec.sub(
        Vec.scale(direction, bodyRadius + elevation),
        anchor,
      )
      positions[index * 3] = local.x
      positions[index * 3 + 1] = local.y
      positions[index * 3 + 2] = local.z
      // Radial direction is kept for the normal pass below, which needs it to
      // decide which way is out.
      normals[index * 3] = direction.x
      normals[index * 3 + 1] = direction.y
      normals[index * 3 + 2] = direction.z
    }
  }

  computeNormals(positions, normals, resolution)

  /*
   * Winding must be counter-clockwise seen from *outside* the planet, because
   * the renderer's material is single-sided and the GPU culls by winding, not
   * by the normal attribute. These triangles were (a, c, b) / (b, c, d) —
   * clockwise from outside on every cube face — so every patch was invisible
   * from above and the "ground" on screen was the datum sphere 11 km below it,
   * with the far slopes of distant ridges leaking through as a band floating
   * over the horizon. `faceToDirection` gives ∂/∂s × ∂/∂t = outward on all six
   * faces, so one order is right everywhere; the test asserts it face by face.
   */
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

  return { region, resolution, positions, normals, indices, anchor }
}

/** Where a patch sits, and which way it faces, in render space right now. */
export interface PatchPlacement {
  readonly position: Vec3
  readonly orientation: Q.Quat
}

/**
 * Put a body-fixed patch back into render space.
 *
 * Called once per patch per frame, and that frequency is the point: the body's
 * pose changes every tick, so anything that bakes it into vertex data is stale
 * before it is drawn. This is the same two lines the datum sphere gets from
 * `placeAt`, which is why the sphere tracked the planet correctly while the
 * terrain in front of it did not.
 */
export function patchPlacement(
  patch: RenderPatch,
  origin: RenderOrigin,
  bodyCentre: UniverseVector,
  bodyOrientation: Q.Quat,
): PatchPlacement {
  const orientation = Q.multiply(
    Q.conjugate(origin.orientation),
    bodyOrientation,
  )
  return {
    position: Vec.add(
      toRenderSpace(origin, bodyCentre),
      Q.rotate(orientation, patch.anchor),
    ),
    orientation,
  }
}

/**
 * Replace the radial normals with real surface normals.
 *
 * This is not a polish detail. Radial normals shade a mountain range exactly
 * like a smooth sphere, so terrain generated at real planetary relief — a few
 * kilometers on a few thousand — is completely invisible. Central differences
 * over the neighboring vertices cost one extra pass and make the ground
 * actually look like ground.
 *
 * Patch edges use one-sided differences, which leaves a hairline seam between
 * neighboring patches; stitching needs the neighbors' edge rows and is the
 * natural next step.
 */
function computeNormals(
  positions: Float32Array,
  normals: Float32Array,
  resolution: number,
): void {
  const at = (row: number, col: number, axis: number): number =>
    positions[(row * resolution + col) * 3 + axis] ?? 0

  for (let row = 0; row < resolution; row += 1) {
    for (let col = 0; col < resolution; col += 1) {
      const index = row * resolution + col
      const left = Math.max(0, col - 1)
      const right = Math.min(resolution - 1, col + 1)
      const up = Math.max(0, row - 1)
      const down = Math.min(resolution - 1, row + 1)

      const du = [
        at(row, right, 0) - at(row, left, 0),
        at(row, right, 1) - at(row, left, 1),
        at(row, right, 2) - at(row, left, 2),
      ]
      const dv = [
        at(down, col, 0) - at(up, col, 0),
        at(down, col, 1) - at(up, col, 1),
        at(down, col, 2) - at(up, col, 2),
      ]

      let nx =
        (du[1] as number) * (dv[2] as number) -
        (du[2] as number) * (dv[1] as number)
      let ny =
        (du[2] as number) * (dv[0] as number) -
        (du[0] as number) * (dv[2] as number)
      let nz =
        (du[0] as number) * (dv[1] as number) -
        (du[1] as number) * (dv[0] as number)
      const length = Math.hypot(nx, ny, nz)
      if (length === 0) continue

      nx /= length
      ny /= length
      nz /= length
      // The radial direction is still sitting in the normals array; use it to
      // decide the winding-independent outward sense.
      const rx = normals[index * 3] ?? 0
      const ry = normals[index * 3 + 1] ?? 0
      const rz = normals[index * 3 + 2] ?? 0
      const sign = nx * rx + ny * ry + nz * rz < 0 ? -1 : 1
      normals[index * 3] = nx * sign
      normals[index * 3 + 1] = ny * sign
      normals[index * 3 + 2] = nz * sign
    }
  }
}
