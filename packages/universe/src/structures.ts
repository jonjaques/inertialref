import type { Meters, Radians } from '@inertialref/shared'

/** Authored state only. Geometry and body-fixed poses derive from this record. */
export interface SurfacePlacement {
  readonly id: string
  readonly assetId: string
  readonly bodyAddress: string
  readonly latitude: Radians
  readonly longitude: Radians
  /** Asset origin above the canonical ground, meters. */
  readonly height: Meters
  /** Compass heading, radians clockwise from north. */
  readonly heading: Radians
}

/**
 * The facility every Sol game starts with: a surveyed basin in the game's
 * Mars relief, not a named real-world site. A new Sol session places it, and
 * a save written before structures existed receives it on migration, so the
 * pad the landing scene stages is one the player can land on in every world
 * that has a Mars.
 */
export const MARS_PAD: SurfacePlacement = Object.freeze({
  id: 'mars-basin-pad',
  assetId: 'mars-pad',
  bodyAddress: 'g:milky-way/s:SOL/b:3',
  latitude: 0.6031917532451286,
  longitude: 1.4844702100937137,
  height: 2,
  heading: (246 * Math.PI) / 180,
})

/** Physical dimensions of reusable scenery; the host chooses its artwork. */
export interface SurfaceAssetDefinition {
  readonly id: string
  readonly name: string
  readonly footprintRadius: Meters
  /** Horizontal contact disk at the placed origin; null has no support surface. */
  readonly supportRadius: Meters | null
}

export const SURFACE_ASSETS: readonly SurfaceAssetDefinition[] = Object.freeze([
  Object.freeze({
    id: 'mars-pad',
    name: 'Mars landing pad',
    footprintRadius: 58,
    supportRadius: 25,
  }),
])

export const surfaceAsset = (id: string): SurfaceAssetDefinition | undefined =>
  SURFACE_ASSETS.find((asset) => asset.id === id)
