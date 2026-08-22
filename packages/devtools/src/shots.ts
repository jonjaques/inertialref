import { type Quat, Vec, type Vec3, vec3 } from '@inertialref/spatial'
import { lookAlong } from '@inertialref/rendering'

/*
 * Camera bookmarks: named, repeatable compositions of a body.
 *
 * The debug orbit parks one radius up, where the body subtends 60° in a 65°
 * field of view — the framing for *flying at* a planet, and the wrong one for
 * looking at it. From two radii you see a magnified 60° cap of the globe, so
 * the continents read enormous and the limb foreshortens; every photograph
 * anyone recognises was taken from much further back. Blue Marble is a 4.5
 * body-radii shot. These bookmarks put the ship where the photographs were
 * taken, which is what makes "does the render match the photo" a question that
 * can be answered by looking.
 *
 * Pure geometry in the body's frame, so the placement is testable in Node and
 * the same bookmark works on any body in any system. The angles are the
 * photographer's terms:
 *
 * - `phase` is the sun–body–camera angle: 0° is full face, 90° half lit,
 *   150° a crescent.
 * - `elevation` lifts the camera out of the body's equatorial plane, which
 *   keeps a pole in the shot and stops every framing from being flat-on.
 * - `aim` decides what sits in the middle of the frame: the body's centre, the
 *   sunward horizon (the ISS sunset composition), or the specular point where
 *   the star reflects off the surface (the sun-glint composition).
 */

export type ShotAim = 'centre' | 'limb' | 'specular'

export interface ShotDefinition {
  readonly name: string
  /** One line for the dock and `ir.shots()`. */
  readonly description: string
  /** Camera distance from the body's centre, in body radii. */
  readonly distanceRadii: number
  /** Sun–body–camera angle, degrees. */
  readonly phaseDeg: number
  /** Lift out of the body's equatorial plane, degrees. */
  readonly elevationDeg: number
  readonly aim: ShotAim
  /**
   * Radial lift of the aim point, in body radii. Positive tilts the camera
   * towards space, dropping the horizon into the frame's lower third — the
   * ISS dusk composition, where the sun sits low, not dead centre.
   */
  readonly aimLift?: number
}

/**
 * The bookmark list. Each is composed against a specific photographic
 * reference; the point is that the render can be held next to the photograph.
 */
export const SHOTS: readonly ShotDefinition[] = [
  {
    name: 'full-face',
    description: 'the whole lit disc, north up — the Blue Marble framing',
    distanceRadii: 5.2,
    phaseDeg: 12,
    elevationDeg: 8,
    aim: 'centre',
  },
  {
    name: 'gibbous',
    description: 'three-quarter lit, shadow sculpting the terrain',
    distanceRadii: 3.4,
    phaseDeg: 55,
    elevationDeg: 10,
    aim: 'centre',
  },
  {
    name: 'half',
    description: 'terminator down the middle of the disc',
    distanceRadii: 3.2,
    phaseDeg: 90,
    elevationDeg: 5,
    aim: 'centre',
  },
  {
    name: 'crescent',
    description: 'thin crescent, atmosphere ringing the dark limb',
    distanceRadii: 4.0,
    phaseDeg: 147,
    elevationDeg: 5,
    aim: 'centre',
  },
  {
    name: 'glint',
    description: 'the star mirrored off the surface, oceans if it has them',
    distanceRadii: 2.3,
    phaseDeg: 38,
    elevationDeg: 12,
    aim: 'specular',
  },
  {
    name: 'sunset',
    description: 'low over the night side, sun on the horizon — the ISS limb',
    distanceRadii: 1.04,
    phaseDeg: 104,
    elevationDeg: 0,
    aim: 'limb',
    aimLift: 0.045,
  },
  {
    name: 'oblique',
    description: 'low and slanted, surface receding into the haze at the limb',
    distanceRadii: 1.35,
    phaseDeg: 62,
    elevationDeg: 0,
    aim: 'limb',
  },
]

export const shotNames = (): readonly string[] => SHOTS.map((s) => s.name)

export function findShot(name: string): ShotDefinition {
  const shot = SHOTS.find((candidate) => candidate.name === name)
  if (shot === undefined) {
    throw new Error(`Unknown shot "${name}". Try: ${shotNames().join(', ')}`)
  }
  return shot
}

export interface ShotPlacement {
  /** Camera position in the body's frame, metres from its centre. */
  readonly position: Vec3
  /** Frame-local orientation: −Z looks at the aim point, horizon level. */
  readonly orientation: Quat
  /** Unit direction of a circular orbit through `position`. */
  readonly along: Vec3
}

/**
 * Where the camera goes and what it looks at, in the body's frame.
 *
 * @param shot        the composition
 * @param bodyRadius  metres
 * @param toStar      unit vector from the body towards its star, body frame
 * @param maxDistance ceiling on the camera's distance from the centre, metres —
 *   the sphere-of-influence clamp, so a bookmark on a small moon does not park
 *   the ship outside the frame it is being parked in. The floor always wins:
 *   there is no composition from inside the ground.
 */
export function placeShot(
  shot: ShotDefinition,
  bodyRadius: number,
  toStar: Vec3,
  maxDistance = Infinity,
): ShotPlacement {
  const pole = vec3(0, 1, 0)
  const sun = Vec.normalize(toStar)

  /*
   * The camera direction is built in a basis around the *sun line*, not by
   * rotating about the frame's pole. The first version rotated about the pole,
   * and the phase came out wrong whenever the sun sat out of the equatorial
   * plane — rotation about the pole preserves a vector's poleward component,
   * so the sun–body–camera angle it produced was `acos(s_y² + (1 − s_y²)·cos φ)`
   * rather than φ. In this basis the phase is exact for any sun direction, and
   * the elevation spends its degrees tilting the swing plane instead, which is
   * all it was ever for: getting a pole into frame so the composition is not
   * dead flat.
   */
  const horizontal = Vec.cross(pole, sun)
  const east =
    Vec.length(horizontal) > 1e-6
      ? Vec.normalize(horizontal)
      : Vec.normalize(Vec.cross(vec3(1, 0, 0), sun))
  const poleward = Vec.cross(sun, east)

  const phase = (shot.phaseDeg * Math.PI) / 180
  const elevation = (shot.elevationDeg * Math.PI) / 180
  const swing = Vec.add(
    Vec.scale(east, Math.cos(elevation)),
    Vec.scale(poleward, Math.sin(elevation)),
  )
  const direction = Vec.normalize(
    Vec.add(Vec.scale(sun, Math.cos(phase)), Vec.scale(swing, Math.sin(phase))),
  )

  const floor = bodyRadius * 1.03
  const distance = Math.max(
    floor,
    Math.min(shot.distanceRadii * bodyRadius, maxDistance),
  )
  const position = Vec.scale(direction, distance)

  const aim = Vec.add(
    aimPoint(shot.aim, position, bodyRadius, sun),
    Vec.scale(Vec.normalize(position), (shot.aimLift ?? 0) * bodyRadius),
  )
  const forward = Vec.normalize(Vec.sub(aim, position))

  // Horizon-level roll. Centre-aimed shots hang the frame on the pole — north
  // up, like every printed photograph — but a limb shot looks *along* the
  // ground, where "level" means the local vertical, not the planet's axis.
  const upHint = shot.aim === 'centre' ? pole : direction
  const orientation = lookAlong(forward, upHint)

  // A tangential direction for a circular orbit, so the bookmark holds its
  // composition instead of falling. Along the direction the camera faces for
  // limb shots, so the ground scrolls under the frame rather than across it —
  // but a centre-aimed camera faces straight down the radial, whose tangential
  // part is zero, and there the equatorial track is as good as any.
  const facing = Vec.sub(
    forward,
    Vec.scale(direction, Vec.dot(forward, direction)),
  )
  const along = Vec.normalize(
    Vec.length(facing) > 1e-6 ? facing : Vec.cross(pole, direction),
  )

  return { position, orientation, along }
}

/** What sits in the middle of the frame. */
function aimPoint(
  aim: ShotAim,
  position: Vec3,
  bodyRadius: number,
  sun: Vec3,
): Vec3 {
  if (aim === 'centre') return Vec.ZERO

  const radial = Vec.normalize(position)
  if (aim === 'specular') {
    // The star's reflection sits where the surface normal bisects the view and
    // sun directions. Halfway between the sub-camera and sub-solar points is
    // exact for a distant camera and within a degree everywhere a shot goes.
    const normal = Vec.normalize(Vec.lerp(radial, sun, 0.5))
    return Vec.scale(normal, bodyRadius)
  }

  // The horizon, in the sun's direction: the point of the limb a low camera
  // actually sees the sun set behind. The horizon sits `acos(R/r)` away from
  // the sub-camera point, along the great circle towards the star.
  const towardSun = Vec.normalize(
    Vec.sub(sun, Vec.scale(radial, Vec.dot(sun, radial))),
  )
  const horizon = Math.acos(
    Math.min(1, bodyRadius / Math.max(Vec.length(position), bodyRadius)),
  )
  return Vec.scale(
    Vec.add(
      Vec.scale(radial, Math.cos(horizon)),
      Vec.scale(towardSun, Math.sin(horizon)),
    ),
    bodyRadius,
  )
}

/*
 * `lookAlong` moved to `@inertialref/rendering`'s cinematic module — the
 * scripted-scene evaluator needs it and the layering only allows the import in
 * that direction. Re-exported here because it is part of this module's public
 * face and every existing caller reads naturally at this address.
 */
export { lookAlong }
