import { SECTOR_SIZE, type UniverseVector } from '@inertialref/spatial'

/** Each float32 position spans one kilometer, including at the galactic rim. */
export const STAR_POSITION_QUANTUM = 1024
export const STAR_SUBCELLS = SECTOR_SIZE / STAR_POSITION_QUANTUM

/** Integer subcells prevent shader reassociation from rebuilding an absolute float. */
export function writeStarCoordinates(
  position: UniverseVector,
  cells: Int32Array,
  offsets: Float32Array,
  subcells: Int32Array,
  index: number,
): void {
  const base = index * 4
  cells[base] = position.sx
  cells[base + 1] = position.sy
  cells[base + 2] = position.sz
  writeLocal(position.ox, offsets, subcells, base)
  writeLocal(position.oy, offsets, subcells, base + 1)
  writeLocal(position.oz, offsets, subcells, base + 2)
}

function writeLocal(
  value: number,
  offsets: Float32Array,
  subcells: Int32Array,
  index: number,
): void {
  const cell = Math.floor(value / STAR_POSITION_QUANTUM)
  subcells[index] = cell
  offsets[index] = value / STAR_POSITION_QUANTUM - cell
}
