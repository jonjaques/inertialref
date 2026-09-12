import type { Meters, Radians } from '@inertialref/shared'
import type { GalaxyId } from './address.ts'
import { MILKY_WAY } from './galaxy.ts'

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
 * The facility every Milky Way game starts with: a surveyed basin in the
 * game's Mars relief, not a named real-world site. A new session places it
 * through `initialStructures`, and a save written before structures existed
 * receives it on migration, so the pad the landing scene stages is one the
 * player can land on in every world that has a Mars.
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

/**
 * The structures a world in this galaxy begins with; a galaxy without a Mars
 * has none. The one predicate for a new session and for a migrating save —
 * the two decide separately, and deciding on the start system at one and the
 * galaxy at the other leaves a world started outside Sol without the pad its
 * own save then migrates into.
 */
export const initialStructures = (
  galaxy: GalaxyId,
): readonly SurfacePlacement[] => (galaxy === MILKY_WAY ? [MARS_PAD] : [])

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
