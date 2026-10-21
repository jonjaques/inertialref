import type { Meters } from '@inertialref/shared'
import type { Vec3 } from '@inertialref/spatial'
import { directionToFace } from '@inertialref/universe'
import type { RenderPatch } from './terrainMesh.ts'

/*
 * The ground a patch draws, read back along a direction.
 *
 * A rock is generated from the field — `regionScatter` is a pure function of
 * its address and knows nothing of which level is drawn — and the ground under
 * it is a triangulation of that field at whatever level the selection chose.
 * The two differ by the mesh's own interpolation error: 2 to 11 cm in the mean
 * at the detail floor across the zoo and 79 cm at the worst cell on Miranda,
 * and up to 1.9 m two levels coarser, which is the ground a rock 150 m off is
 * standing on. No constant seat covers that, and no byte of cover can carry
 * it: at every vertex the mesh *is* the field, so the difference lives only
 * between vertices, and only for the level actually drawn.
 *
 * So the rock reads the triangle. This is the surface `buildPatch` emits and
 * the index buffer draws — the quad split along the same diagonal, each vertex
 * slid toward its parent's grid by its own morph factor exactly as the
 * material slides it — as a radius from the body's center, which is what a
 * rock's instance is placed by.
 */

/**
 * The morph factor the material gives a vertex at `distance` from the eye:
 * zero inside `morphStart`, one past `morphEnd`. The same expression as the
 * `positionNode` in `render/terrain.ts`, including the floor of a meter on the
 * band's width that makes a root patch's enormous band read as "never".
 */
export const patchMorph = (
  distance: Meters,
  morphStart: Meters,
  morphEnd: Meters,
): number =>
  Math.min(
    1,
    Math.max(0, (distance - morphStart) / Math.max(morphEnd - morphStart, 1)),
  )

/** Where the patch is being morphed from: the eye and the patch's band. */
export interface PatchMorphBand {
  /** The eye in body-fixed axes, from the body's center. */
  readonly eye: Vec3
  readonly start: Meters
  readonly end: Meters
}

/**
 * The radius of the ground a patch draws along `direction`, or null where the
 * direction is outside the patch. `morph` null draws the patch unmorphed.
 *
 * Barycentric in the patch's own grid coordinates rather than a ray against
 * the triangle's plane. A chord across a cell sags under the sphere by
 * `cell² / 8R`, a micrometer at a six-meter cell on a four-thousand-kilometer
 * body, and the gnomonic map is linear to the same order across one cell.
 */
export function patchGroundRadius(
  patch: RenderPatch,
  direction: Vec3,
  morph: PatchMorphBand | null,
): Meters | null {
  const { region, resolution } = patch
  const { face, u, v } = directionToFace(direction)
  if (face !== region.face) return null
  const span = 2 ** region.level
  const step = resolution - 1
  const col = (((u + 1) / 2) * span - region.i) * step
  const row = (((v + 1) / 2) * span - region.j) * step
  if (!(col >= 0 && row >= 0 && col <= step && row <= step)) return null
  const r0 = Math.min(step - 1, Math.floor(row))
  const c0 = Math.min(step - 1, Math.floor(col))
  /*
   * The cell's own triangle wherever none of its corners has begun to morph,
   * which on a stance is every rock nearer than the first band.
   */
  if (
    morph === null ||
    (factor(patch, morph, r0, c0) === 0 &&
      factor(patch, morph, r0, c0 + 1) === 0 &&
      factor(patch, morph, r0 + 1, c0) === 0 &&
      factor(patch, morph, r0 + 1, c0 + 1) === 0)
  ) {
    return triangle(patch, null, row, col, r0, c0)
  }
  /*
   * In a band, each vertex slides toward the even index below it by its own
   * factor, so the triangle over a point may be a neighbor's that has
   * stretched across it — an odd vertex moves a whole cell at the band's far
   * end. The cells either side are searched in the slid coordinates.
   */
  for (let r = Math.max(0, r0 - 1); r <= Math.min(step - 1, r0 + 1); r += 1) {
    for (let c = Math.max(0, c0 - 1); c <= Math.min(step - 1, c0 + 1); c += 1) {
      const hit = triangle(patch, morph, row, col, r, c)
      if (hit !== null) return hit
    }
  }
  return null
}

/** One vertex's morph factor, from its unmorphed distance to the eye. */
function factor(
  patch: RenderPatch,
  morph: PatchMorphBand,
  row: number,
  col: number,
): number {
  const at = (row * patch.resolution + col) * 3
  return patchMorph(
    Math.hypot(
      patch.anchor.x + (patch.positions[at] as number) - morph.eye.x,
      patch.anchor.y + (patch.positions[at + 1] as number) - morph.eye.y,
      patch.anchor.z + (patch.positions[at + 2] as number) - morph.eye.z,
    ),
    morph.start,
    morph.end,
  )
}

/** A vertex as drawn: its grid coordinates and radius, slid by its factor. */
interface Slid {
  readonly row: number
  readonly col: number
  readonly radius: Meters
}

function slid(
  patch: RenderPatch,
  morph: PatchMorphBand | null,
  row: number,
  col: number,
): Slid {
  const radius = radiusOf(patch, row, col)
  const k = morph === null ? 0 : factor(patch, morph, row, col)
  if (k === 0) return { row, col, radius }
  // `buildPatch`'s morph target: the vertex at the even index below.
  const evenRow = row & ~1
  const evenCol = col & ~1
  return {
    row: row + (evenRow - row) * k,
    col: col + (evenCol - col) * k,
    radius: radius + (radiusOf(patch, evenRow, evenCol) - radius) * k,
  }
}

/**
 * The radius over (row, col) in one cell's two triangles — split along the
 * diagonal `patchIndices` draws, from the (r, c + 1) corner to (r + 1, c) —
 * or null where the point is in neither.
 */
function triangle(
  patch: RenderPatch,
  morph: PatchMorphBand | null,
  row: number,
  col: number,
  r: number,
  c: number,
): Meters | null {
  const a = slid(patch, morph, r, c)
  const b = slid(patch, morph, r, c + 1)
  const cc = slid(patch, morph, r + 1, c)
  const first = barycentric(a, b, cc, row, col)
  if (first !== null) return first
  return barycentric(b, slid(patch, morph, r + 1, c + 1), cc, row, col)
}

const SLACK = 1e-9

function barycentric(
  a: Slid,
  b: Slid,
  c: Slid,
  row: number,
  col: number,
): Meters | null {
  const x1 = b.col - a.col
  const y1 = b.row - a.row
  const x2 = c.col - a.col
  const y2 = c.row - a.row
  const det = x1 * y2 - x2 * y1
  // A collapsed triangle covers nothing; its neighbors cover the point.
  if (Math.abs(det) < 1e-12) return null
  const px = col - a.col
  const py = row - a.row
  const wb = (px * y2 - x2 * py) / det
  const wc = (x1 * py - px * y1) / det
  if (wb < -SLACK || wc < -SLACK || wb + wc > 1 + SLACK) return null
  return a.radius + wb * (b.radius - a.radius) + wc * (c.radius - a.radius)
}

/** A vertex's distance from the body's center, in float64 off its float32 offset. */
function radiusOf(patch: RenderPatch, row: number, col: number): Meters {
  const at = (row * patch.resolution + col) * 3
  return Math.hypot(
    patch.anchor.x + (patch.positions[at] as number),
    patch.anchor.y + (patch.positions[at + 1] as number),
    patch.anchor.z + (patch.positions[at + 2] as number),
  )
}
