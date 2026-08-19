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
      // Radial direction is kept for the normal pass below, which needs it to
      // decide which way is out.
      const radial = Q.rotate(toRender, direction)
      normals[index * 3] = radial.x
      normals[index * 3 + 1] = radial.y
      normals[index * 3 + 2] = radial.z
    }
  }

  computeNormals(positions, normals, resolution)

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

/**
 * Replace the radial normals with real surface normals.
 *
 * This is not a polish detail. Radial normals shade a mountain range exactly
 * like a smooth sphere, so terrain generated at real planetary relief — a few
 * kilometres on a few thousand — is completely invisible. Central differences
 * over the neighbouring vertices cost one extra pass and make the ground
 * actually look like ground.
 *
 * Patch edges use one-sided differences, which leaves a hairline seam between
 * neighbouring patches; stitching needs the neighbours' edge rows and is the
 * natural next step.
 */
function computeNormals(positions: Float32Array, normals: Float32Array, resolution: number): void {
  const at = (row: number, col: number, axis: number): number =>
    positions[(row * resolution + col) * 3 + axis] ?? 0

  for (let row = 0; row < resolution; row += 1) {
    for (let col = 0; col < resolution; col += 1) {
      const index = row * resolution + col
      const left = Math.max(0, col - 1)
      const right = Math.min(resolution - 1, col + 1)
      const up = Math.max(0, row - 1)
      const down = Math.min(resolution - 1, row + 1)

      const du = [at(row, right, 0) - at(row, left, 0), at(row, right, 1) - at(row, left, 1), at(row, right, 2) - at(row, left, 2)]
      const dv = [at(down, col, 0) - at(up, col, 0), at(down, col, 1) - at(up, col, 1), at(down, col, 2) - at(up, col, 2)]

      let nx = (du[1] as number) * (dv[2] as number) - (du[2] as number) * (dv[1] as number)
      let ny = (du[2] as number) * (dv[0] as number) - (du[0] as number) * (dv[2] as number)
      let nz = (du[0] as number) * (dv[1] as number) - (du[1] as number) * (dv[0] as number)
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

