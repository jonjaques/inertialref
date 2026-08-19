import { type Meters, invariant } from '@inertialref/shared'
import {
  createRenderOrigin,
  maintainOrigin,
  orientationToRenderSpace,
  type Quat,
  type RenderOrigin,
  toRenderSpace,
  UV,
  type UniverseVector,
  Vec,
  type Vec3,
} from '@inertialref/spatial'
import type { EntitySnapshot, WorldSnapshot } from '@inertialref/simulation'
import type { EntityId } from '@inertialref/universe'
import { type LodTier, starColor } from './lod.ts'
import { DEFAULT_PLACEMENT, placeAt, type PlacementConfig, type RenderPlacement } from './placement.ts'

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
}

export interface RenderStar {
  readonly system: string
  readonly name: string
  readonly placement: RenderPlacement
  readonly color: { readonly r: number; readonly g: number; readonly b: number }
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
  }
  readonly bodies: readonly RenderBody[]
  readonly stars: readonly RenderStar[]
  readonly entities: readonly RenderEntity[]
  /** Bodies close enough to want streamed terrain, nearest first. */
  readonly terrainCandidates: readonly RenderBody[]
}

export interface SceneConfig {
  readonly placement: PlacementConfig
  /** Bodies dimmer/smaller than this angular radius are dropped entirely. */
  readonly cullAngle: number
}

export const DEFAULT_SCENE: SceneConfig = {
  placement: DEFAULT_PLACEMENT,
  cullAngle: 1e-5,
}

/** Keep the render origin near the camera. Pure: returns the origin to use. */
export function originForCamera(
  origin: RenderOrigin | null,
  camera: UniverseVector,
): RenderOrigin {
  return origin === null ? createRenderOrigin(camera) : maintainOrigin(origin, camera)
}

export function buildScene(
  snapshot: WorldSnapshot,
  origin: RenderOrigin,
  cameraEntity: EntityId,
  config: SceneConfig = DEFAULT_SCENE,
): RenderScene {
  const camera = snapshot.entities.find((entity) => entity.id === cameraEntity)
  invariant(camera !== undefined, `Camera entity ${cameraEntity} is not in the snapshot`)

  const bodies: RenderBody[] = []
  for (const body of snapshot.bodies) {
    // The datum sphere is drawn a full relief below the datum. Terrain dips
    // below the datum as often as it rises above it, and a sphere at exactly
    // the datum radius hides every valley on the planet — which, with only a
    // few patches streamed, means hiding most of the terrain.
    const sphereRadius = Math.max(body.radius * 0.9, body.radius - body.relief)
    const placement = placeAt(origin, body.position, sphereRadius, config.placement)
    if (placement.angularRadius < config.cullAngle) continue
    bodies.push({
      address: body.address,
      name: body.name,
      kind: body.kind,
      placement,
      orientation: orientationToRenderSpace(origin, body.orientation),
      hasAtmosphere: body.hasAtmosphere,
      atmosphereScale: body.hasAtmosphere ? (body.radius + body.atmosphereCeiling) / sphereRadius : 1,
      trueRadius: body.radius,
    })
  }

  let brightest = 0
  const rawStars = snapshot.stars.map((star) => {
    const placement = placeAt(origin, star.position, star.radius, config.placement)
    // Inverse-square apparent brightness; normalised below so the scene always
    // has something at full intensity whatever the player is looking at.
    const apparent = star.luminosity / Math.max(1, placement.distance * placement.distance)
    brightest = Math.max(brightest, apparent)
    return { star, placement, apparent }
  })

  const stars: RenderStar[] = rawStars.map(({ star, placement, apparent }) => ({
    system: star.system,
    name: star.name,
    placement,
    color: starColor(star.temperature),
    brightness: brightest === 0 ? 0 : Math.min(1, (apparent / brightest) ** 0.25),
  }))

  const entities: RenderEntity[] = snapshot.entities.map((entity: EntitySnapshot) => ({
    id: entity.id,
    name: entity.name,
    kind: entity.kind,
    position: toRenderSpace(origin, entity.position),
    orientation: orientationToRenderSpace(origin, entity.orientation),
    isCamera: entity.id === cameraEntity,
  }))

  const terrainCandidates = bodies
    .filter((body) => body.placement.tier === 'surface')
    .sort((a, b) => a.placement.distance - b.placement.distance)

  return {
    origin,
    camera: {
      position: toRenderSpace(origin, camera.position),
      orientation: orientationToRenderSpace(origin, camera.orientation),
      universePosition: camera.position,
    },
    bodies,
    stars,
    entities,
    terrainCandidates,
  }
}

/** Nearest body, for HUD readouts and for deciding what to stream. */
export function nearestBody(scene: RenderScene): RenderBody | null {
  let best: RenderBody | null = null
  for (const body of scene.bodies) {
    if (best === null || body.placement.distance - body.trueRadius < best.placement.distance - best.trueRadius) {
      best = body
    }
  }
  return best
}

/** Distance between two render-space points, for debug readouts. */
export const renderDistance = (a: Vec3, b: Vec3): number => Vec.distance(a, b)

export const universeDistance = (a: UniverseVector, b: UniverseVector): number => UV.distance(a, b)

export type { LodTier }
