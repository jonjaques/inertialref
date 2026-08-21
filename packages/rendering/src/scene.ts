import { type Meters, invariant } from '@inertialref/shared'
import {
  createRenderOrigin,
  directionToRenderSpace,
  maintainOrigin,
  orientationToRenderSpace,
  type Quat,
  type RenderOrigin,
  toRenderSpace,
  UV,
  type UniverseVector,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import type {
  BodySnapshot,
  EntitySnapshot,
  WorldSnapshot,
} from '@inertialref/simulation'
import type { BodyAppearance, EntityId } from '@inertialref/universe'
import { type LodTier, starColor } from './lod.ts'
import { placeAt, type RenderPlacement } from './placement.ts'

/*
 * The scene description.
 *
 * A plain data structure: what to draw, where, at what size, at which level of
 * detail. The React/Three layer turns this into objects and does nothing else
 * of consequence, which is what keeps "how the universe works" out of component
 * lifecycles — and lets all of this be tested in Node.
 */

export interface RenderBody {
  readonly address: string
  readonly name: string
  readonly kind: string
  readonly placement: RenderPlacement
  readonly orientation: Quat
  readonly hasAtmosphere: boolean
  readonly atmosphereScale: number
  readonly trueRadius: Meters
  /**
   * Polar radius over equatorial. 1 for a sphere, 0.902 for Saturn.
   *
   * A ratio rather than a length because the renderer scales a unit sphere and
   * the placement has already compressed the equatorial radius; anything else
   * would have to undo that first.
   */
  readonly flattening: number
  /** Rings in units of the placed radius, or null. */
  readonly rings: {
    readonly innerScale: number
    readonly outerScale: number
    readonly opticalDepth: number
    readonly texture: string | null
  } | null
  readonly appearance: BodyAppearance
}

export interface RenderStar {
  readonly system: string
  readonly name: string
  readonly placement: RenderPlacement
  readonly color: {
    readonly r: number
    readonly g: number
    readonly b: number
  }
  /** Apparent brightness relative to the brightest star in the scene, 0..1. */
  readonly brightness: number
}

export interface RenderEntity {
  readonly id: EntityId
  readonly name: string
  readonly kind: string
  readonly position: Vec3
  readonly orientation: Quat
  readonly isCamera: boolean
}

export interface RenderScene {
  readonly origin: RenderOrigin
  readonly camera: {
    readonly position: Vec3
    readonly orientation: Quat
    readonly universePosition: UniverseVector
    /**
     * Local up in render axes — away from the centre of the nearest body.
     *
     * Not the camera's own up: that rotates with the ship, and the question
     * "which way is away from the ground" has to survive the ship pointing
     * anywhere. Falls back to +Y with no body in reach.
     */
    readonly up: Vec3
    /** Height above the terrain, or null away from any body. */
    readonly altitude: Meters | null
  }
  readonly bodies: readonly RenderBody[]
  /** Brightest apparent first: `stars[0]` is the scene's key light. */
  readonly stars: readonly RenderStar[]
  readonly entities: readonly RenderEntity[]
  /** Bodies close enough to want streamed terrain, nearest first. */
  readonly terrainCandidates: readonly RenderBody[]
}

/** Bodies smaller than this angular radius are dropped entirely. */
const CULL_ANGLE = 1e-5

/** Keep the render origin near the camera. Pure: returns the origin to use. */
export function originForCamera(
  origin: RenderOrigin | null,
  camera: UniverseVector,
): RenderOrigin {
  return origin === null
    ? createRenderOrigin(camera)
    : maintainOrigin(origin, camera)
}

export function buildScene(
  snapshot: WorldSnapshot,
  origin: RenderOrigin,
  cameraEntity: EntityId,
): RenderScene {
  const camera = snapshot.entities.find((entity) => entity.id === cameraEntity)
  invariant(
    camera !== undefined,
    `Camera entity ${cameraEntity} is not in the snapshot`,
  )

  const bodies: RenderBody[] = []
  for (const body of snapshot.bodies) {
    // The datum sphere is drawn a full relief below the datum. Terrain dips
    // below the datum as often as it rises above it, and a sphere at exactly
    // the datum radius hides every valley on the planet — which, with only a
    // few patches streamed, means hiding most of the terrain.
    const sphereRadius = Math.max(body.radius * 0.9, body.radius - body.relief)
    const placement = placeAt(origin, body.position, sphereRadius)
    if (placement.angularRadius < CULL_ANGLE) continue
    bodies.push({
      address: body.address,
      name: body.name,
      kind: body.kind,
      placement,
      orientation: orientationToRenderSpace(origin, body.orientation),
      hasAtmosphere: body.appearance.haze !== null,
      // From the *haze*, not from `atmosphereCeiling`. That ceiling is where the
      // drag model stops integrating, which for a gas giant is a thousand
      // kilometres of "there is no surface" — drawn as a shell it put a halo on
      // Saturn 3% of its own radius wide.
      atmosphereScale:
        body.appearance.haze === null
          ? 1
          : (body.radius + body.appearance.haze.height) / sphereRadius,
      trueRadius: body.radius,
      flattening: body.polarRadius / body.radius,
      // Ring radii arrive in metres from the body's centre and leave as
      // multiples of the drawn sphere — which is not the body's radius, because
      // the datum sphere is sunk by a relief to let terrain sit above it. Doing
      // this conversion here rather than in the renderer keeps that adjustment
      // in the one place that knows about it.
      rings:
        body.appearance.rings === null
          ? null
          : {
              innerScale: body.appearance.rings.innerRadius / sphereRadius,
              outerScale: body.appearance.rings.outerRadius / sphereRadius,
              opticalDepth: body.appearance.rings.opticalDepth,
              texture: body.appearance.rings.texture,
            },
      appearance: body.appearance,
    })
  }

  let brightest = 0
  const rawStars = snapshot.stars.map((star) => {
    const placement = placeAt(origin, star.position, star.radius)
    // Inverse-square apparent brightness; normalised below so the scene always
    // has something at full intensity whatever the player is looking at.
    const apparent =
      star.luminosity / Math.max(1, placement.distance * placement.distance)
    brightest = Math.max(brightest, apparent)
    return { star, placement, apparent }
  })

  // Sorted, because `stars[0]` is what the renderer lights the scene from. The
  // order used to be the snapshot's — the order systems happened to be loaded
  // in — which was invisible while only one system was ever loaded and wrong
  // the moment travelling between them became ordinary: arriving 40 AU from
  // Proxima left the scene lit by Sol, four light years behind, and the star
  // overhead contributing nothing. Apparent brightness rather than distance,
  // because that is what "which star lights this place" means.
  const stars: RenderStar[] = rawStars
    .slice()
    .sort((a, b) => b.apparent - a.apparent)
    .map(({ star, placement, apparent }) => ({
      system: star.system,
      name: star.name,
      placement,
      color: starColor(star.temperature),
      brightness:
        brightest === 0 ? 0 : Math.min(1, (apparent / brightest) ** 0.25),
    }))

  const entities: RenderEntity[] = snapshot.entities.map(
    (entity: EntitySnapshot) => ({
      id: entity.id,
      name: entity.name,
      kind: entity.kind,
      position: toRenderSpace(origin, entity.position),
      orientation: orientationToRenderSpace(origin, entity.orientation),
      isCamera: entity.id === cameraEntity,
    }),
  )

  const terrainCandidates = bodies
    .filter((body) => body.placement.tier === 'surface')
    .sort((a, b) => a.placement.distance - b.placement.distance)

  return {
    origin,
    camera: {
      position: toRenderSpace(origin, camera.position),
      orientation: orientationToRenderSpace(origin, camera.orientation),
      universePosition: camera.position,
      // From the *snapshot's* body positions, not the placed ones: placement
      // compresses distance, and while that leaves the direction intact it is
      // not a property worth depending on from over here.
      up: upFrom(snapshot, origin, camera.position),
      altitude: camera.altitude,
    },
    bodies,
    stars,
    entities,
    terrainCandidates,
  }
}

/** Which way is away from the ground, in render axes. */
function upFrom(
  snapshot: WorldSnapshot,
  origin: RenderOrigin,
  camera: UniverseVector,
): Vec3 {
  let nearest: BodySnapshot | null = null
  let best = Infinity
  for (const body of snapshot.bodies) {
    const surface = UV.distance(camera, body.position) - body.radius
    if (surface < best) {
      best = surface
      nearest = body
    }
  }
  if (nearest === null) return vec3(0, 1, 0)
  const radial = UV.difference(camera, nearest.position)
  const length = Vec.length(radial)
  // Dead centre of a body has no up. Nothing can be there, but the normalise
  // would produce NaN and every consumer would inherit it.
  if (length === 0) return vec3(0, 1, 0)
  return directionToRenderSpace(origin, Vec.scale(radial, 1 / length))
}

/** Nearest body, for HUD readouts and for deciding what to stream. */
export function nearestBody(scene: RenderScene): RenderBody | null {
  let best: RenderBody | null = null
  for (const body of scene.bodies) {
    if (
      best === null ||
      body.placement.distance - body.trueRadius <
        best.placement.distance - best.trueRadius
    ) {
      best = body
    }
  }
  return best
}

export type { LodTier }
