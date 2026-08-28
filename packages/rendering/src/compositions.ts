import type { Meters } from '@inertialref/shared'
import {
  type Quat,
  Quaternion as Q,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import { lookAlong } from './cinematic.ts'
import {
  anglesForPhase,
  clampElevation,
  framingDistance,
  type LookOffset,
  lookToward,
  MIN_DISTANCE_RADII,
  NO_LOOK,
  observerOffset,
} from './observer.ts'
import { localTriad } from './surfaceStance.ts'

/*
 * Named pictures of a body, as one list.
 *
 * There were two, sharing a vocabulary and not a mechanism: nine framings that
 * moved the planetarium's camera and seven bookmarks that teleported the ship,
 * with `gibbous` in both meaning the same picture through two different solvers.
 * Three of the seven existed only for the ship — `glint`, `sunset` and
 * `oblique` — not because a hull is needed to take them but because they aim
 * somewhere other than the body's center and the observatory's pose is
 * `lookAlong(−offset, up)`, always. The aim solve below is what removes that
 * asymmetry, and with it the reason for two lists.
 *
 * A composition is relative to whatever is under the camera. It says how the
 * light falls, how far out to stand, and what sits in the middle of the frame;
 * it does not say *where*. A picture of a particular place is a preset, which
 * is a composition plus an address (`planetarium/pictures.ts`).
 *
 * The photographer's terms throughout, which is what makes the list editable
 * by somebody holding a photograph:
 *
 *   phase  the sun–body–camera angle: 0° is a full face, 90° half lit, 180°
 *          behind. `anglesForPhase` solves it against where the star actually
 *          is, so a composition means the same picture in every season.
 *   tilt   how far the swing plane is rolled out of the star's own plane. Not
 *          the camera's elevation: at phase 90 the two coincide, at phase 10 a
 *          60° tilt barely lifts the camera at all. It is what stops every
 *          framing from being flat-on.
 *   aim    what is in the middle of the frame — the center, the sunward
 *          horizon, or the specular point where the star mirrors off the
 *          surface.
 *
 * **The standoff is one of two things and never both.** A `fill` is a fraction
 * of the frame's height, so it holds a composition across a change of lens and
 * moves with one; a `radii` is a multiple of the body's own radius, so no lens
 * can move it. Both are wanted and they are not interchangeable: a drawn
 * framing is a claim about the picture, and a bookmark composed against a
 * specific photograph is a claim about where the camera stood.
 * `compositions.test.ts` holds the seven photographic ones to their radii for
 * exactly that reason.
 */

/** What sits in the middle of the frame. */
export type CompositionAim = 'centre' | 'limb' | 'specular'

/** How far out the camera stands. Exactly one of the two. */
export type Standoff =
  | { readonly kind: 'fill'; readonly fill: number }
  | { readonly kind: 'radii'; readonly radii: number }

export interface Composition {
  /** Stable across a rename of the label — this is what `ir.shot` takes. */
  readonly id: string
  readonly label: string
  /** One line, for a tooltip and for `ir.shots()`. */
  readonly why: string
  /** Sun–body–camera angle, degrees. */
  readonly phaseDeg: number
  /** Roll of the swing plane out of the star's own, degrees. */
  readonly tiltDeg: number
  readonly standoff: Standoff
  readonly aim: CompositionAim
  /**
   * Radial lift of the aim point, in body radii.
   *
   * Positive tilts the camera toward space, dropping the horizon into the
   * frame's lower third — the ISS dusk composition, where the sun sits low
   * rather than dead center.
   */
  readonly aimLift?: number
}

export const fill = (value: number): Standoff => ({ kind: 'fill', fill: value })
export const radii = (value: number): Standoff => ({
  kind: 'radii',
  radii: value,
})

/**
 * The list. Sixteen, and no two of them make a thumbnail that could be
 * mistaken for another.
 *
 * The first nine are drawn framings and spread across both axes; the last
 * seven are each composed against a specific photograph, which is what makes
 * "does the render match the photo" a question that can be answered by looking.
 *
 * There is no `earthrise` here, and its absence is the point. The composition
 * that carried the name was `{phase: 132, tilt: 8, fill: 0.32}` — a small low
 * crescent of the subject, which is a fine picture and is not what the word
 * means. The photograph is taken from over Luna with Earth a few degrees above
 * the limb: two bodies, the subject being the one *not* stood on. That is a
 * `riseStance`, it is a preset rather than a composition because it names which
 * two bodies, and the framing below keeps the picture under the name it is.
 */
export const COMPOSITIONS: readonly Composition[] = [
  {
    id: 'portrait',
    label: 'Portrait',
    why: 'the whole body with sky around it — where a new target opens',
    phaseDeg: 20,
    tiltDeg: 10,
    standoff: fill(0.55),
    aim: 'centre',
  },
  {
    id: 'blue-marble',
    label: 'Blue Marble',
    why: 'the whole lit face, north a little high — the Apollo framing',
    phaseDeg: 12,
    tiltDeg: 10,
    standoff: fill(0.72),
    aim: 'centre',
  },
  {
    id: 'close',
    label: 'Close',
    why: 'the disk overflowing the frame, as near as the camera will go',
    phaseDeg: 35,
    tiltDeg: 12,
    standoff: fill(0.95),
    aim: 'centre',
  },
  {
    id: 'wide',
    label: 'Wide',
    why: 'the body small and the sky large — scale, rather than surface',
    phaseDeg: 25,
    tiltDeg: 15,
    standoff: fill(0.18),
    aim: 'centre',
  },
  {
    id: 'half-lit',
    label: 'Half Lit',
    why: 'the terminator straight down the middle',
    phaseDeg: 90,
    tiltDeg: 6,
    standoff: fill(0.6),
    aim: 'centre',
  },
  {
    id: 'raking',
    label: 'Raking',
    why: 'light along the surface at its lowest, where relief is longest',
    phaseDeg: 88,
    tiltDeg: 30,
    standoff: fill(0.88),
    aim: 'centre',
  },
  {
    id: 'high-angle',
    label: 'High Angle',
    why: 'up over the plane, looking down across the pole',
    phaseDeg: 62,
    tiltDeg: 72,
    standoff: fill(0.66),
    aim: 'centre',
  },
  {
    id: 'far-crescent',
    label: 'Far Crescent',
    why: 'a crescent small and low, most of the frame left to the dark',
    phaseDeg: 132,
    tiltDeg: 8,
    standoff: fill(0.32),
    aim: 'centre',
  },
  {
    id: 'backlit',
    label: 'Backlit',
    why: 'the star straight behind it, the atmosphere doing all the work',
    phaseDeg: 172,
    tiltDeg: 5,
    standoff: fill(0.58),
    aim: 'centre',
  },

  {
    id: 'full-face',
    label: 'Full Face',
    why: 'the whole lit disk, north up — the Blue Marble standoff',
    phaseDeg: 12,
    tiltDeg: 8,
    standoff: radii(5.2),
    aim: 'centre',
  },
  {
    id: 'gibbous',
    label: 'Gibbous',
    why: 'three-quarter lit, shadow sculpting the terrain',
    phaseDeg: 55,
    tiltDeg: 10,
    standoff: radii(3.4),
    aim: 'centre',
  },
  {
    id: 'half',
    label: 'Half',
    why: 'terminator down the middle of the disk',
    phaseDeg: 90,
    tiltDeg: 5,
    standoff: radii(3.2),
    aim: 'centre',
  },
  {
    id: 'crescent',
    label: 'Crescent',
    why: 'thin crescent, atmosphere ringing the dark limb',
    phaseDeg: 147,
    tiltDeg: 5,
    standoff: radii(4.0),
    aim: 'centre',
  },
  {
    id: 'glint',
    label: 'Glint',
    why: 'the star mirrored off the surface, oceans if it has them',
    phaseDeg: 38,
    tiltDeg: 12,
    standoff: radii(2.3),
    aim: 'specular',
  },
  {
    id: 'sunset',
    label: 'Sunset',
    why: 'low over the night side, sun on the horizon — the ISS limb',
    phaseDeg: 104,
    tiltDeg: 0,
    standoff: radii(1.04),
    aim: 'limb',
    aimLift: 0.045,
  },
  {
    id: 'oblique',
    label: 'Oblique',
    why: 'low and slanted, surface receding into the haze at the limb',
    phaseDeg: 62,
    tiltDeg: 0,
    standoff: radii(1.35),
    aim: 'limb',
  },
]

export const compositionIds = (): readonly string[] =>
  COMPOSITIONS.map((one) => one.id)

export function findComposition(id: string): Composition {
  const found = COMPOSITIONS.find((one) => one.id === id)
  if (found === undefined) {
    throw new Error(
      `Unknown composition "${id}". Try: ${compositionIds().join(', ')}`,
    )
  }
  return found
}

/**
 * The standoff in body radii, which is the one number both placers want.
 *
 * `framingDistance` is linear in the radius, so solving it at a unit sphere is
 * the ratio itself — no body needed, and no chance of a placer solving against
 * one radius and clamping against another.
 */
export function standoffRadii(
  composition: Composition,
  fovDeg: number,
): number {
  const standoff = composition.standoff
  return standoff.kind === 'radii'
    ? standoff.radii
    : framingDistance(1, fovDeg, standoff.fill)
}

/**
 * Where the aim point sits, in the body's frame.
 *
 * Exported because both placers need it and the ship's has had it inline
 * since before the observatory could aim at all.
 */
export function aimPoint(
  aim: CompositionAim,
  position: Vec3,
  bodyRadius: Meters,
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
  // the sub-camera point, along the great circle toward the star.
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

/** The aim point a composition asks for, lift included, in the body's frame. */
export function compositionAim(
  composition: Composition,
  position: Vec3,
  bodyRadius: Meters,
  sun: Vec3,
): Vec3 {
  return Vec.add(
    aimPoint(composition.aim, position, bodyRadius, sun),
    Vec.scale(Vec.normalize(position), (composition.aimLift ?? 0) * bodyRadius),
  )
}

/**
 * Which arm a composition lands on, and the numbers that arm needs.
 *
 * One decision in one place, because the two arms meet exactly at
 * `MIN_DISTANCE_RADII` and a composition that named 1.04 radii previously had
 * nowhere to go: the orbit arm clamps at 1.5 and the surface arm was reached
 * only by a site picker. `sunset` *is* a stance 0.04 radii up, and saying so is
 * what makes it a planetarium picture rather than something only a hull can
 * take.
 *
 * `toStar` is the unit vector from the body toward its star in the axes the
 * result is wanted in — the reference plane's, for the orbit arm; the body's
 * own rotating axes, for the surface arm, since a stance is a place on the
 * ground.
 */
export type CompositionPlacement =
  | {
      readonly kind: 'orbit'
      readonly azimuth: number
      readonly elevation: number
      readonly distance: Meters
      /** Zero for a centre-aimed composition, and exactly zero. */
      readonly look: LookOffset
    }
  | {
      readonly kind: 'surface'
      /** The stance's up direction, in the axes `toStar` was given in. */
      readonly up: Vec3
      readonly height: Meters
      readonly heading: number
      readonly pitch: number
    }

export function placeComposition(
  composition: Composition,
  bodyRadius: Meters,
  toStar: Vec3,
  fovDeg: number,
): CompositionPlacement {
  const sun = Vec.normalize(toStar)
  const { azimuth, elevation } = anglesForPhase(
    sun,
    composition.phaseDeg,
    composition.tiltDeg,
  )
  const ratio = standoffRadii(composition, fovDeg)
  const distance = ratio * bodyRadius
  const position = observerOffset({ azimuth, elevation, distance })
  const aim = compositionAim(composition, position, bodyRadius, sun)

  if (ratio < MIN_DISTANCE_RADII) {
    /*
     * Below the orbit floor, so it is a stance rather than a framing.
     *
     * The sub-camera point is where the eye stands, which makes the standoff a
     * height above the ground and the aim a heading and a pitch. The horizon
     * levelling comes free: `surfaceStancePose` levels against the *local* up,
     * which is what a limb shot wants and what `placeShot` has to ask for
     * explicitly through its `upHint`.
     */
    const up = Vec.normalize(position)
    const triad = localTriad(up)
    const forward = Vec.normalize(Vec.sub(aim, position))
    return {
      kind: 'surface',
      up,
      height: Math.max(0, distance - bodyRadius),
      heading: Math.atan2(
        Vec.dot(forward, triad.east),
        Vec.dot(forward, triad.north),
      ),
      pitch: clampElevation(
        Math.asin(Math.max(-1, Math.min(1, Vec.dot(forward, triad.up)))),
      ),
    }
  }

  return {
    kind: 'orbit',
    azimuth,
    elevation,
    distance,
    look: compositionLook(composition, position, bodyRadius, sun),
  }
}

/**
 * The free-look offset an aimed composition needs from the orbit arm's pose.
 *
 * `NO_LOOK` for a centre-aimed one, and by construction rather than by
 * rounding: `aimPoint` returns the origin, the forward is the negated offset,
 * and putting that back through the solve would return zeros to within an ulp
 * rather than exactly. The nine drawn framings are all centre-aimed, so this is
 * also what keeps them bit-identical to the pose they had before free look
 * existed.
 */
export function compositionLook(
  composition: Composition,
  position: Vec3,
  bodyRadius: Meters,
  sun: Vec3,
): LookOffset {
  if (composition.aim === 'centre' && (composition.aimLift ?? 0) === 0) {
    return NO_LOOK
  }
  const base = observerBase(position)
  const aim = compositionAim(composition, position, bodyRadius, sun)
  const forward = Vec.normalize(Vec.sub(aim, position))
  return lookToward(Q.rotateInverse(base, forward))
}

/** The orbit arm's centre-aimed orientation for a camera at this offset. */
const observerBase = (position: Vec3): Quat =>
  lookAlong(Vec.negate(position), vec3(0, 1, 0))
