import { invariant, LIGHT_YEAR, type Meters } from '@inertialref/shared'
import { UV, type UniverseVector, vec3 } from '@inertialref/spatial'

/*
 * The generation grid.
 *
 * A fixed cube lattice over the whole universe. Everything spatial that has to
 * be answered without a global index — which procedural stars exist here, which
 * catalogue stars are near there — is answered by walking cells, so the cost of
 * a query is bounded by the volume asked about rather than by the size of the
 * galaxy.
 *
 * This lives apart from `galaxy.ts` because the star catalogue indexes itself by
 * cell and `galaxy.ts` reads the catalogue. Left together, that is a cycle.
 */

/** Edge length of a generation cell. 20 ly holds a couple of dozen stars locally. */
export const CELL_SIZE: Meters = 20 * LIGHT_YEAR

export interface GalacticCell {
  readonly x: number
  readonly y: number
  readonly z: number
}

export const cellKey = (cell: GalacticCell): string =>
  `${cell.x},${cell.y},${cell.z}`

export function cellOf(position: UniverseVector): GalacticCell {
  const m = UV.approxMeters(position)
  return {
    x: Math.floor(m.x / CELL_SIZE),
    y: Math.floor(m.y / CELL_SIZE),
    z: Math.floor(m.z / CELL_SIZE),
  }
}

export const cellOrigin = (cell: GalacticCell): UniverseVector =>
  UV.fromMeters(cell.x * CELL_SIZE, cell.y * CELL_SIZE, cell.z * CELL_SIZE)

export const cellCentre = (cell: GalacticCell): UniverseVector =>
  UV.translate(
    cellOrigin(cell),
    vec3(CELL_SIZE / 2, CELL_SIZE / 2, CELL_SIZE / 2),
  )

/** Every cell touching the axis-aligned box of `radius` around `centre`. */
export function cellsWithin(
  centre: UniverseVector,
  radius: Meters,
  limit = 200_000,
): readonly GalacticCell[] {
  const min = cellOf(UV.translate(centre, vec3(-radius, -radius, -radius)))
  const max = cellOf(UV.translate(centre, vec3(radius, radius, radius)))
  const count = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1)
  invariant(
    count <= limit,
    `A ${(radius / LIGHT_YEAR).toFixed(0)} ly query spans ${count} cells; narrow the radius`,
  )
  const cells: GalacticCell[] = []
  for (let x = min.x; x <= max.x; x += 1)
    for (let y = min.y; y <= max.y; y += 1)
      for (let z = min.z; z <= max.z; z += 1) cells.push({ x, y, z })
  return cells
}
