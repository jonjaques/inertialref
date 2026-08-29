import { type Quat, Vec, type Vec3, vec3 } from '@inertialref/spatial'
import {
  aimPoint,
  type Composition,
  COMPOSITIONS,
  compositionIds,
  FLIGHT_FOV,
  findComposition,
  lookAlong,
  standoffRadii,
} from '@inertialref/rendering'

/*
 * The ship's placer for a composition: where a hull goes to take the picture.
 *
 * The list itself lives in `packages/rendering/src/compositions.ts`, and that
 * is the load-bearing part: two lists sharing a vocabulary and not a mechanism
 * is how `gibbous` here and `gibbous` in the planetarium's presets come to mean
 * two pictures. One list and two placers instead — one teleports a hull, the
 * other moves a camera — and this file is one of them. The three that aim
 * somewhere other than the body's center reach both arms because the aim is a
 * look offset rather than something only a hull's orientation can express.
 *
 * What is left here is the placement: pure geometry in the body's frame, so it
 * is testable in Node and the same composition works on any body in any system.
 * The debug orbit parks one radius up, where the body subtends 60° in a 65°
 * field — the framing for *flying at* a planet, and the wrong one for looking
 * at it. From two radii you see a magnified 60° cap of the globe, so the
 * continents read enormous and the limb foreshortens; every photograph anyone
 * recognizes was taken much further back. Blue Marble is a 4.5 body-radii shot.
 * These put the ship where the photographs were taken, which is what makes
 * "does the render match the photo" a question that can be answered by looking.
 */

/**
 * The list, as the ship placer sees it.
 *
 * An alias rather than a copy: two names for one array is how a build ends up
 * with a bookmark the console can frame and the panel cannot.
 */
export type ShotDefinition = Composition
export const SHOTS: readonly Composition[] = COMPOSITIONS

export const shotNames = (): readonly string[] => compositionIds()

export function findShot(name: string): Composition {
  return findComposition(name)
}

export interface ShotPlacement {
  /** Camera position in the body's frame, meters from its center. */
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
 * @param bodyRadius  meters
 * @param toStar      unit vector from the body toward its star, body frame
 * @param maxDistance ceiling on the camera's distance from the center, meters —
 *   the sphere-of-influence clamp, so a bookmark on a small moon does not park
 *   the ship outside the frame it is being parked in. The floor always wins:
 *   there is no composition from inside the ground.
 * @param fovDeg      the field a `fill` standoff is solved against. Unused by a
 *   composition that names its standoff in radii, which is every one of the
 *   seven composed against a photograph — see `compositions.test.ts`, which
 *   holds them to that.
 */
export function placeShot(
  shot: Composition,
  bodyRadius: number,
  toStar: Vec3,
  maxDistance = Infinity,
  fovDeg: number = FLIGHT_FOV,
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
   * the tilt spends its degrees rolling the swing plane instead, which is all
   * it was ever for: getting a pole into frame so the composition is not dead
   * flat.
   */
  const horizontal = Vec.cross(pole, sun)
  const east =
    Vec.length(horizontal) > 1e-6
      ? Vec.normalize(horizontal)
      : Vec.normalize(Vec.cross(vec3(1, 0, 0), sun))
  const poleward = Vec.cross(sun, east)

  const phase = (shot.phaseDeg * Math.PI) / 180
  const tilt = (shot.tiltDeg * Math.PI) / 180
  const swing = Vec.add(
    Vec.scale(east, Math.cos(tilt)),
    Vec.scale(poleward, Math.sin(tilt)),
  )
  const direction = Vec.normalize(
    Vec.add(Vec.scale(sun, Math.cos(phase)), Vec.scale(swing, Math.sin(phase))),
  )

  const floor = bodyRadius * 1.03
  const distance = Math.max(
    floor,
    Math.min(standoffRadii(shot, fovDeg) * bodyRadius, maxDistance),
  )
  const position = Vec.scale(direction, distance)

  const aim = Vec.add(
    aimPoint(shot.aim, position, bodyRadius, sun),
    Vec.scale(Vec.normalize(position), (shot.aimLift ?? 0) * bodyRadius),
  )
  const forward = Vec.normalize(Vec.sub(aim, position))

  // Horizon-level roll. Center-aimed shots hang the frame on the pole — north
  // up, like every printed photograph — but a limb shot looks *along* the
  // ground, where "level" means the local vertical, not the planet's axis.
  const upHint = shot.aim === 'centre' ? pole : direction
  const orientation = lookAlong(forward, upHint)

  // A tangential direction for a circular orbit, so the bookmark holds its
  // composition instead of falling. Along the direction the camera faces for
  // limb shots, so the ground scrolls under the frame rather than across it —
  // but a center-aimed camera faces straight down the radial, whose tangential
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

/**
 * A composition built from a standoff in radii, for a caller with no list.
 *
 * `tng-intro` is the caller: its beats name a distance, a phase and a tilt at
 * the point of use and have no business being in a list of named pictures.
 */
export const standoffShot = (
  distanceRadii: number,
  phaseDeg: number,
  tiltDeg: number,
): Composition => ({
  id: 'cinematic',
  label: 'Cinematic',
  why: '',
  phaseDeg,
  tiltDeg,
  standoff: { kind: 'radii', radii: distanceRadii },
  aim: 'centre',
})

/*
 * `lookAlong` moved to `@inertialref/rendering`'s cinematic module — the
 * scripted-scene evaluator needs it and the layering only allows the import in
 * that direction. Re-exported here because it is part of this module's public
 * face and every existing caller reads naturally at this address.
 */
export { lookAlong }
