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

/*
 * A structure's walkable relief, in the asset's own meters about its datum.
 *
 * Axes are the glTF's: +X is the asset's east before its heading turns it,
 * +Z its south, and a height is measured up from the datum the placement's
 * `height` lifts above the ground. Every feature is the *top* of something
 * that can be stood on, and where features overlap the tallest wins, so a
 * plinth on an apron is a plinth and the apron under it never shows through.
 *
 * Tops rather than volumes because contact is a function of a ray from the
 * body's center: the controller asks how high the ground is under a point,
 * and a box 1.9 m tall answers "1.9 m" for every point inside its footprint.
 * That is what makes a service enclosure a wall — a rise a step cannot take
 * — without any mesh being a collider. Ceilings, overhangs and the underside
 * of the ramp are outside what a height field can say, deliberately.
 */
export type SupportFeature =
  | {
      readonly kind: 'disk'
      readonly radius: Meters
      /** A ring when set: the feature has no top inside this radius. */
      readonly inner?: Meters
      readonly height: Meters
    }
  | {
      /** A regular polygon with a corner on +X, the pad's octagonal skirts. */
      readonly kind: 'polygon'
      readonly sides: number
      readonly apothem: Meters
      readonly height: Meters
    }
  | {
      /** An axis-aligned box about `x`,`z`, turned by `turn` about the datum's up. */
      readonly kind: 'box'
      readonly x: Meters
      readonly z: Meters
      /** Full extents along the box's own turned X and Z. */
      readonly width: Meters
      readonly depth: Meters
      readonly turn: Radians
      readonly height: Meters
    }
  | {
      /**
       * A slab whose top falls linearly along +Z, from `height` at `from` to
       * `heightTo` at `to`, `width` wide about `x`.
       */
      readonly kind: 'ramp'
      readonly x: Meters
      readonly width: Meters
      readonly from: Meters
      readonly to: Meters
      readonly height: Meters
      readonly heightTo: Meters
    }

/** Physical dimensions of reusable scenery; the host chooses its artwork. */
export interface SurfaceAssetDefinition {
  readonly id: string
  readonly name: string
  /** Nothing of the asset lies beyond this, so a ray outside it misses. */
  readonly footprintRadius: Meters
  /** Walkable tops; an asset with none is scenery the ground shows through. */
  readonly support: readonly SupportFeature[]
}

/**
 * The height of the tallest feature under a point of the asset's plane, or
 * null where nothing supports a foot. The tallest wins on purpose; see the
 * header. Blender's XY plane maps to glTF's XZ with `z = -Y`, which is why a
 * polygon's angle is `atan2(-z, x)`: the pad's skirts were authored with a
 * corner on Blender's +X, and that corner is at +X here too.
 */
export function supportHeightAt(
  asset: SurfaceAssetDefinition,
  x: Meters,
  z: Meters,
): Meters | null {
  let top: Meters | null = null
  for (const feature of asset.support) {
    const height = featureHeight(feature, x, z)
    if (height !== null && (top === null || height > top)) top = height
  }
  return top
}

/** The highest top the asset can offer, for the band a tick must examine. */
export function supportCeiling(asset: SurfaceAssetDefinition): Meters {
  let ceiling = -Infinity
  for (const feature of asset.support)
    ceiling = Math.max(
      ceiling,
      feature.kind === 'ramp'
        ? Math.max(feature.height, feature.heightTo)
        : feature.height,
    )
  return ceiling === -Infinity ? 0 : Math.max(0, ceiling)
}

function featureHeight(
  feature: SupportFeature,
  x: Meters,
  z: Meters,
): Meters | null {
  switch (feature.kind) {
    case 'disk': {
      const r2 = x * x + z * z
      if (r2 > feature.radius * feature.radius) return null
      if (feature.inner !== undefined && r2 < feature.inner * feature.inner)
        return null
      return feature.height
    }
    case 'polygon': {
      const r = Math.hypot(x, z)
      if (r <= feature.apothem) return feature.height
      const sector = (Math.PI * 2) / feature.sides
      const angle = Math.atan2(-z, x)
      const face = (Math.floor(angle / sector) + 0.5) * sector
      return r * Math.cos(angle - face) <= feature.apothem
        ? feature.height
        : null
    }
    case 'box': {
      const dx = x - feature.x
      const dz = z - feature.z
      // The turn is a Blender angle from +X toward +Y, so toward -Z here.
      const c = Math.cos(feature.turn)
      const s = Math.sin(feature.turn)
      const along = dx * c - dz * s
      const across = -dx * s - dz * c
      return Math.abs(along) <= feature.width / 2 &&
        Math.abs(across) <= feature.depth / 2
        ? feature.height
        : null
    }
    case 'ramp': {
      if (Math.abs(x - feature.x) > feature.width / 2) return null
      if (z < feature.from || z > feature.to) return null
      const t = (z - feature.from) / (feature.to - feature.from)
      return feature.height + (feature.heightTo - feature.height) * t
    }
  }
}

/**
 * The Mars pad's relief, transcribed from `apps/ingest/models/build_mars_pad.py`
 * — the same numbers, in the same order, so a change to the model is a change
 * here. The deck is the landing datum at height 0. Everything on the aprons is
 * a top a boot can find: a drain grille is 0.145 m of grating, a lamp mount
 * half a meter of housing, and a service enclosure two meters of wall.
 */
function marsPadSupport(): readonly SupportFeature[] {
  const features: SupportFeature[] = [
    // Refractory tiles, clipped to a 64-gon of this radius.
    { kind: 'disk', radius: 26.6, height: 0 },
    { kind: 'disk', radius: 27.25, inner: 26.65, height: -0.03 },
    { kind: 'disk', radius: 37.2, inner: 27.3, height: -0.08 },
    // The warning bands stand a hand's width proud of the apron panels.
    { kind: 'disk', radius: 29.1, inner: 27.8, height: 0.02 },
    // The outer apron is octagonal: 44.64 m to a corner, this much to a face.
    {
      kind: 'polygon',
      sides: 8,
      apothem: 44.64 * Math.cos(Math.PI / 8),
      height: -0.18,
    },
    // The access ramp leaves the apron's south corner for the ground: a
    // landing flush with the apron fills the corner's notch, then the slope.
    {
      kind: 'box',
      x: 0,
      z: 43.7,
      width: 9.2,
      depth: 2.0,
      turn: 0,
      height: -0.18,
    },
    {
      kind: 'ramp',
      x: 0,
      width: 9.2,
      from: 44.7,
      to: 57,
      height: -0.18,
      heightTo: -3.5,
    },
  ]
  const box = (
    radial: number,
    tangent: number,
    theta: number,
    width: number,
    depth: number,
    height: number,
  ): SupportFeature => ({
    kind: 'box',
    x: radial * Math.cos(theta) - tangent * Math.sin(theta),
    z: -(radial * Math.sin(theta) + tangent * Math.cos(theta)),
    width,
    depth,
    turn: theta,
    height,
  })
  for (let side = 0; side < 8; side += 1) {
    const theta = ((side + 0.5) * Math.PI * 2) / 8
    for (const track of [-1, 1])
      features.push(box(33.2, track * 5.8, theta, 4.5, 1.1, 0.145))
    features.push(box(38.5, 0, theta, 3.4, 6.0, 0.405))
    features.push(box(38.5, 0, theta, 2.9, 4.8, 2.0))
  }
  for (let lamp = 0; lamp < 32; lamp += 1) {
    const theta = ((lamp + 0.5) * Math.PI * 2) / 32
    const side = (Math.floor(theta / (Math.PI / 4)) + 0.5) * (Math.PI / 4)
    features.push(
      box(40.1 / Math.cos(theta - side), 0, theta, 0.8, 1.45, 0.325),
    )
  }
  return Object.freeze(features)
}

export const SURFACE_ASSETS: readonly SurfaceAssetDefinition[] = Object.freeze([
  Object.freeze({
    id: 'mars-pad',
    name: 'Mars landing pad',
    footprintRadius: 58,
    support: marsPadSupport(),
  }),
])

export const surfaceAsset = (id: string): SurfaceAssetDefinition | undefined =>
  SURFACE_ASSETS.find((asset) => asset.id === id)
