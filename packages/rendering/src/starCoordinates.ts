import { SECTOR_SIZE, type UniverseVector } from '@inertialref/spatial'

/** A sector-local fraction and its float32 residual retain nearby-star parallax. */
export function writeStarCoordinates(
  position: UniverseVector,
  cells: Int32Array,
  offsets: Float32Array,
  residuals: Float32Array,
  index: number,
): void {
  const base = index * 4
  cells[base] = position.sx
  cells[base + 1] = position.sy
  cells[base + 2] = position.sz
  const local = [position.ox, position.oy, position.oz]
  for (let axis = 0; axis < 3; axis++) {
    const fraction = local[axis]! / SECTOR_SIZE
    const high = Math.fround(fraction)
    offsets[base + axis] = high
    residuals[base + axis] = fraction - high
  }
}
