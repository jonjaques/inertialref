import type { Meters } from '@inertialref/shared'

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
