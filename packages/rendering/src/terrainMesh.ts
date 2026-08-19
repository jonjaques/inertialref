import type { Meters } from '@inertialref/shared'
import {
  Quaternion as Q,
  type RenderOrigin,
  toRenderSpace,
  UV,
  type UniverseVector,
  Vec,
  type Vec3,
} from '@inertialref/spatial'
import { type RegionAddress, regionDirection } from '@inertialref/universe'

/*
 * Terrain patch geometry.
 *
 * A pure function from (heightfield, region, body pose, render origin) to
 * vertex buffers. Deliberately not a React component and not a Three.js call:
 * it is the expensive part, it is the part worth testing, and keeping it here
 * means the same code could run in a worker later without moving anything.
 *
 * Vertices are emitted in render space, relative to the current origin, so they
 * are small numbers that float32 holds exactly. A rebase invalidates them —
 * which is why `RenderPatch` records the origin generation it was built for.
 */

export interface PatchInput {
  readonly region: RegionAddress
  readonly resolution: number
  readonly elevations: Float32Array
  readonly bodyRadius: Meters
  /** Universe position of the body's centre. */
  readonly bodyCentre: UniverseVector
  /** Body-fixed orientation, so the patch turns with the planet. */
  readonly bodyOrientation: Q.Quat
}

export interface RenderPatch {
  readonly region: RegionAddress
  readonly resolution: number
  /** xyz triples in render space. */
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly indices: Uint32Array
  /** Render origin generation this was built against. */
  readonly originGeneration: number
  /** Centre of the patch in render space, for culling and sorting. */
  readonly centre: Vec3
}

export function buildPatch(input: PatchInput, origin: RenderOrigin): RenderPatch {
  const { region, resolution, elevations, bodyRadius, bodyCentre, bodyOrientation } = input
  const count = resolution * resolution
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)

  const centreUniverse = toRenderSpace(origin, bodyCentre)
  // Body-fixed → render axes, applied once per patch rather than per vertex.
  const toRender = Q.multiply(Q.conjugate(origin.orientation), bodyOrientation)

  for (let row = 0; row < resolution; row += 1) {
    const t = row / (resolution - 1)
    for (let col = 0; col < resolution; col += 1) {
      const s = col / (resolution - 1)
      const index = row * resolution + col
      const direction = regionDirection(region, s, t)
      const elevation = elevations[index] ?? 0
      const local = Vec.scale(direction, bodyRadius + elevation)
      const rendered = Vec.add(centreUniverse, Q.rotate(toRender, local))
      positions[index * 3] = rendered.x
      positions[index * 3 + 1] = rendered.y
      positions[index * 3 + 2] = rendered.z
      // Spherical normal. Good enough at these slopes; a finite-difference
      // normal is a later refinement and needs the neighbouring patches' edges.
      const normal = Q.rotate(toRender, direction)
      normals[index * 3] = normal.x
      normals[index * 3 + 1] = normal.y
      normals[index * 3 + 2] = normal.z
    }
  }

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
      indices[cursor++] = c
      indices[cursor++] = b
      indices[cursor++] = b
      indices[cursor++] = c
      indices[cursor++] = d
    }
  }

  const centreIndex = (Math.floor(resolution / 2) * resolution + Math.floor(resolution / 2)) * 3
  return {
    region,
    resolution,
    positions,
    normals,
    indices,
    originGeneration: origin.generation,
    centre: {
      x: positions[centreIndex] ?? 0,
      y: positions[centreIndex + 1] ?? 0,
      z: positions[centreIndex + 2] ?? 0,
    },
  }
}

/** Universe position of a point on a patch, for placing objects on the ground. */
export function patchPointToUniverse(
  input: PatchInput,
  s: number,
  t: number,
  elevation: Meters,
): UniverseVector {
  const direction = regionDirection(input.region, s, t)
  const local = Vec.scale(direction, input.bodyRadius + elevation)
  return UV.translate(input.bodyCentre, Q.rotate(input.bodyOrientation, local))
}
