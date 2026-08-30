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
import { atmosphereShellRatio, ringScales, sunkSphereRadius } from './datum.ts'
import { terminatorFor } from './terrainPalette.ts'
import {
  LOD_THRESHOLDS,
  type LodThresholds,
  type LodTier,
  starColor,
} from './lod.ts'
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
  /**
   * Half-width of this body's terminator, in cosine of the incidence angle.
   *
   * Derived here so the disk and the terrain streamed in front of it read one
   * number: they are the same body, a descent crosses between them at the
   * eight-pixel relief gate, and a terminator each derived for itself is a step
   * at the switch. `terminatorFor` is the producer; this carries it to the
   * material, which has a `RenderBody` and not a `Body`.
   */
  readonly terminator: number
  readonly atmosphereScale: number
  readonly trueRadius: Meters
  /**
   * Sidereal rotation period, seconds, negative for retrograde. A cloud
   * deck's drift is measured against the surface's own turn rate, so the
   * renderer cannot substitute any fixed day length here.
   */
  readonly rotationPeriod: number
  /**
   * Polar radius over equatorial. 1 for a sphere, 0.902 for Saturn.
   *
   * A ratio rather than a length because the renderer scales a unit sphere and
   * the placement has already compressed the equatorial radius; anything else
   * would have to undo that first.
   */
  readonly flattening: number
  /**
   * The measured figure, for a body that is not a spheroid, or null.
   *
   * Half-extents in meters rather than as ratios, because the shape field the
   * renderer builds from them is in meters and the mesh is then normalized by
   * `trueRadius` — which is `a`. `flattening` is *not* applied to a body that
   * has one of these: the figure already carries the polar squash, and
   * applying both squashes it twice.
   */
  readonly figure: {
    readonly model: string | null
    readonly irregularity: number
    /** a >= b >= c, meters. `a` is `trueRadius`. */
    readonly semiAxes: readonly [Meters, Meters, Meters]
  } | null
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
     * Local up in render axes — away from the center of the nearest body.
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
  /**
   * A presentation-only eye, overriding the camera entity's pose — the
   * cinematic director's seam. It must come through here rather than being
   * applied at the Three.js camera, because everything in this scene is
   * *relative to the eye*: star brightness is apparent brightness, `up` and
   * `altitude` are asked from the eye's position, and a cinematic camera an AU
   * from the ship would otherwise light and sort the scene for a viewpoint
   * nobody is looking from.
   */
  eye?: { readonly position: UniverseVector; readonly orientation: Quat },
  /**
   * The lens the frame is composed through, as thresholds.
   *
   * Passed rather than read, because `packages/rendering` holds no state and
   * the lens has exactly one producer — `GameEngine`, under the pose's own
   * precedence. Omitted is the flight lens, which is what a host without a
   * camera panel is looking through anyway.
   */
  thresholds?: LodThresholds,
): RenderScene {
  const entity = snapshot.entities.find((e) => e.id === cameraEntity)
  invariant(
    entity !== undefined,
    `Camera entity ${cameraEntity} is not in the snapshot`,
  )
  const camera = {
    position: eye?.position ?? entity.position,
    orientation: eye?.orientation ?? entity.orientation,
    // The entity's measured altitude belongs to the entity. A cinematic eye
    // flies far from any contact test, and `null` is the honest answer — it
    // also keeps the chase camera's ground-clearance rule out of the shot.
    altitude: eye === undefined ? entity.altitude : null,
  }

  /*
   * The eye in render space, computed once and handed to every `placeAt`.
   *
   * Render compression is radial about whatever point it is given, and the
   * render origin is a snapped grid point up to `REBASE_THRESHOLD` from the
   * camera — so compressing about the origin gives every distant object a
   * parallax error that sawtooths as the origin rebases. `placeAt` carries the
   * full account; the short version is that it made Phobos and Deimos vibrate.
   */
  const eyeRender = toRenderSpace(origin, camera.position)

  /*
   * Never cull something the lens says should draw.
   *
   * `CULL_ANGLE` was safely an order of magnitude under a fixed billboard
   * threshold; the threshold now follows the optics, and the shipped controls
   * reach a 2.5° field where it is 6.8e-6 — below the constant. Past that
   * crossing a narrower lens buys nothing, because every body it newly promotes
   * to a billboard has already been dropped here, one step earlier and for a
   * reason that has nothing to do with the picture.
   */
  const cullAngle = Math.min(
    CULL_ANGLE,
    (thresholds ?? LOD_THRESHOLDS).billboard,
  )

  const bodies: RenderBody[] = []
  for (const body of snapshot.bodies) {
    // `datum.ts` owns why the sphere is sunk and by how much. It is a
    // function rather than a subtraction here because the boot preloader has
    // to predict this exact number to prebake against it.
    const sphereRadius = sunkSphereRadius(body.radius, body.relief)
    const placement = placeAt(
      origin,
      body.position,
      sphereRadius,
      eyeRender,
      thresholds,
    )
    if (placement.angularRadius < cullAngle) continue
    // Ring radii are authored in meters from the body's center and leave as
    // multiples of the drawn sphere, which is not the body's radius.
    const rings = body.appearance.rings
    const ringSpan =
      rings === null ? null : ringScales(body.radius, body.relief, rings)
    bodies.push({
      address: body.address,
      name: body.name,
      kind: body.kind,
      placement,
      orientation: orientationToRenderSpace(origin, body.orientation),
      hasAtmosphere: body.appearance.haze !== null,
      terminator: terminatorFor(body.hasAtmosphere, body.relief, body.radius),
      // From the *haze*, not from `atmosphereCeiling`. That ceiling is where the
      // drag model stops integrating, which for a gas giant is a thousand
      // kilometers of "there is no surface" — drawn as a shell it put a halo on
      // Saturn 3% of its own radius wide.
      atmosphereScale:
        body.appearance.haze === null
          ? 1
          : atmosphereShellRatio(
              body.radius,
              body.relief,
              body.appearance.haze.height,
            ),
      trueRadius: body.radius,
      rotationPeriod: body.rotationPeriod,
      flattening: body.polarRadius / body.radius,
      figure:
        body.figure === null
          ? null
          : {
              model: body.figure.model,
              irregularity: body.figure.irregularity,
              semiAxes: [
                body.radius,
                body.figure.intermediateRadius,
                body.polarRadius,
              ],
            },
      rings:
        rings === null || ringSpan === null
          ? null
          : {
              innerScale: ringSpan.inner,
              outerScale: ringSpan.outer,
              opticalDepth: rings.opticalDepth,
              texture: rings.texture,
            },
      appearance: body.appearance,
    })
  }

  let brightest = 0
  const rawStars = snapshot.stars.map((star) => {
    const placement = placeAt(
      origin,
      star.position,
      star.radius,
      eyeRender,
      thresholds,
    )
    // Inverse-square apparent brightness; normalized below so the scene always
    // has something at full intensity whatever the player is looking at.
    const apparent =
      star.luminosity / Math.max(1, placement.distance * placement.distance)
    brightest = Math.max(brightest, apparent)
    return { star, placement, apparent }
  })

  // Sorted, because `stars[0]` is what the renderer lights the scene from. The
  // order used to be the snapshot's — the order systems happened to be loaded
  // in — which was invisible while only one system was ever loaded and wrong
  // the moment traveling between them became ordinary: arriving 40 AU from
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

  /*
   * `sphere` as well as `surface`, which is the whole "one field at every
   * distance" claim in one filter.
   *
   * The surface tier begins at an angular radius of 0.12, which is a body
   * already filling a good part of the view. Below it a procedural body was a
   * smooth colored ball, and the relief only appeared once you were close
   * enough to stream — so the world you approached was not the world you landed
   * on. The quadtree answers the sphere tier with its own level 0–2 shell,
   * which is six to a few dozen patches, so the cost of extending the range is
   * a rounding error against what the surface tier already asks for.
   */
  const terrainCandidates = bodies
    .filter(
      (body) =>
        body.placement.tier === 'surface' || body.placement.tier === 'sphere',
    )
    .sort((a, b) => a.placement.distance - b.placement.distance)

  return {
    origin,
    camera: {
      position: eyeRender,
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
  // Dead center of a body has no up. Nothing can be there, but the normalize
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
