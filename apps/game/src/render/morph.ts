import type { Node } from 'three/webgpu'
import { float, floor, length, max, saturate, step } from 'three/tsl'
import { HEIGHTFIELD_RESOLUTION } from '@inertialref/universe'

/*
 * How far a patch vertex has slid onto its parent's grid: the one expression
 * the ground and the sea both take in the vertex stage.
 *
 * Its own module because it is two materials' and one rule's. The factor is
 * the distance from the eye through the patch's band — zero inside
 * `morphStart`, one past `morphEnd` — and it is zero on an edge the selection
 * says finer ground shares (`SelectedPatch.finerEdges`). That second half is
 * the coarser side of a level boundary: the finer patch arrives on this
 * patch's grid, so this patch has to be drawing it there, and a patch is
 * wider than its band, so the far end of such an edge would otherwise be
 * sliding. A sheet over a patch has the patch's vertices and the same edges,
 * so it holds the same ones.
 *
 * `patchGround.ts`'s `vertexMorph` is the same rule on the CPU, for the rocks
 * that stand on the drawn ground; `morph.gpu.test.ts` holds this graph to it.
 */

const LAST = HEIGHTFIELD_RESOLUTION - 1

/**
 * The morph factor of the vertex at `index` in a patch's row-major grid.
 *
 * `held` is the selection's `finerEdges` as four flags, one per lane in
 * `PATCH_EDGE`'s order: x the last column, y the first, z the last row, w the
 * first. The index arrives as a float — `vertexIndex` in a material, a test's
 * own count in a kernel — and the grid is 4,225 vertices, which float32 holds
 * exactly; the half added before the divide keeps the quotient at least
 * 0.5/65 of a row, about 0.008, from an integer on either side, which is
 * thousands of float32 steps at a row index under 65.
 */
export function vertexMorphFactor(
  index: Node<'float'>,
  position: Node<'vec3'>,
  eye: Node<'vec3'>,
  band: Node<'vec2'>,
  held: Node<'vec4'>,
): Node<'float'> {
  const distance = length(position.sub(eye))
  // `max` on the denominator rather than a branch: a patch at level 0 has no
  // parent and arrives with both ends of its band at the same enormous
  // number, which has to read as "never morph" rather than as a divide.
  const k = saturate(
    distance.sub(band.x).div(max(band.y.sub(band.x), float(1))),
  )
  const row = floor(index.add(0.5).div(HEIGHTFIELD_RESOLUTION))
  const col = index.sub(row.mul(HEIGHTFIELD_RESOLUTION))
  const onHeldEdge = max(
    max(step(LAST - 0.5, col).mul(held.x), step(col, 0.5).mul(held.y)),
    max(step(LAST - 0.5, row).mul(held.z), step(row, 0.5).mul(held.w)),
  )
  return k.mul(float(1).sub(onHeldEdge))
}
