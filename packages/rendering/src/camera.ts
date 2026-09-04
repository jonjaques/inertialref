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
  clampElevation,
  type LookOffset,
  NO_LOOK,
  type ObserverState,
  turn,
} from './observer.ts'
import type { RenderScene } from './scene.ts'

/*
 * The chase camera.
 *
 * A rule rather than a Three.js call, because it is a rule: the offset is
 * expressed in ship axes so the view swings with the ship, and the camera must
 * not end up underground. Both halves belong together and neither belongs in a
 * component — this way the ground clearance can be tested in Node, which is
 * where the bug it exists for was measured.
 */

/**
 * Camera offset from the ship, in ship axes: behind and slightly above.
 *
 * A chase view rather than a cockpit, because the point of this milestone is to
 * see the ship, the meter-scale reference objects beside it and the planet in
 * one frame. This is the offset for the 6 m debug hull; a modeled hull
 * derives its own through `chaseOffsetFor`.
 */
export const CHASE_OFFSET: Vec3 = vec3(0, 2.5, 14)

/**
 * The chase offset for a hull of a given overall length.
 *
 * The framing is a ratio, not a distance: what makes a chase view read is the
 * hull filling roughly the same fraction of the frame regardless of whether it
 * is six meters long or six hundred. 1.4 lengths behind and 0.28 above keeps
 * the whole hull inside the default field of view with sky around it —
 * slightly tighter than the debug cone's hand-tuned offset, because a big ship
 * shot from 2.3 lengths reads as a photograph of a model rather than a ship
 * you are flying.
 */
export function chaseOffsetFor(length: Meters): Vec3 {
  return vec3(0, length * 0.28, length * 1.4)
}

/**
 * Never let the camera get closer to the ground than this.
 *
 * 14 m behind the ship is 14 m of lever arm: pitching up 10° on the pad already
 * puts the camera at ground level and 40° puts it 7 m under, which renders as
 * the world seen from inside the crust — near terrain vanishes to backface
 * culling, stars show through the ground, and the far terrain reads as a second
 * band of land above the hole. It looks like broken geometry and it is a camera
 * with no floor.
 */
export const CAMERA_GROUND_CLEARANCE: Meters = 2

/**
 * Where to put the camera this frame, in render space.
 *
 * The clearance is measured against the *ship's* altitude, not the ground
 * directly under the camera. At 14 m of separation on terrain whose features are
 * kilometers wide the difference is centimeters, and sampling the heightfield
 * from here would mean the renderer asking the universe a question mid-frame.
 */
export function chaseCameraPosition(
  scene: RenderScene,
  offset: Vec3 = CHASE_OFFSET,
  clearance: Meters = CAMERA_GROUND_CLEARANCE,
): Vec3 {
  const rotated = Q.rotate(scene.camera.orientation, offset)
  return Vec.add(scene.camera.position, clearGround(scene, rotated, clearance))
}

/**
 * A displacement from the ship, lifted until the eye at its end clears the
 * ground — the floor `chaseCameraPosition` documents, as one rule for every
 * arm that places a camera beside the hull.
 */
function clearGround(
  scene: RenderScene,
  offset: Vec3,
  clearance: Meters,
): Vec3 {
  const altitude = scene.camera.altitude
  if (altitude === null) return offset
  // How much of the offset is straight up. Negative when the ship is nose-high,
  // because "behind" has rotated downwards.
  const rise = Vec.dot(offset, scene.camera.up)
  const shortfall = clearance - (altitude + rise)
  return shortfall > 0
    ? Vec.add(offset, Vec.scale(scene.camera.up, shortfall))
    : offset
}

/* ------------------------------------------------------------------------- */
/* The flight camera's views                                                  */
/* ------------------------------------------------------------------------- */

/*
 * The ship arm of the camera precedence has two views, and both are the same
 * arm: `GameEngine.#step` still orders cutscene, then observatory, then the
 * ship, and what changes here is only where the ship's own camera stands.
 *
 * *Chase* is the view flight is played in — behind and above, swinging with
 * the hull, so the frame says where the nose points. *Orbit* is the view the
 * hull is looked at in: the camera holds still in the world while the ship
 * turns inside the frame, which is the only way to watch a maneuvering
 * system fire — a camera bolted to the hull would show every plume in the
 * same place on screen whatever the ship did. Both take a look offset, so a
 * pilot in the chase view can turn their head without giving up the chase.
 *
 * The orbit is measured in *hull lengths*, not meters. The camera's distance
 * is a framing decision and framing is a ratio: two lengths back shows a 46 m
 * frigate and a 642 m starship the same way, and a script that says
 * `distance: 2` means the same picture on either. The host multiplies by the
 * hull it has; this arithmetic never learns what a hull is.
 */

export type FlightView = 'chase' | 'orbit'

export interface FlightCameraState {
  readonly view: FlightView
  /**
   * The orbit arm, about the ship in the world's own axes — the pole is the
   * scene's local up, so "above the ship" stays above the ground when the
   * ship rolls. `distance` is in hull lengths.
   */
  readonly orbit: ObserverState
  /** Where the head is turned from the view's own aim. */
  readonly look: LookOffset
}

/**
 * How far the orbit may stand from the hull, in hull lengths.
 *
 * The near bound is the chase offset's own reach, so an orbit never dollies
 * inside the hull it is looking at; the far bound is a tether, and it is a
 * design rule rather than a limit of the arithmetic: `docs/design/art.md`
 * bounds the free camera to a tether from the ship so that the camera stays
 * a drone the player deployed rather than a second viewpoint on the
 * universe. Eight lengths is where the hull is still the subject of the frame
 * at the default lens.
 */
export const ORBIT_LENGTHS = Object.freeze({ min: 0.6, max: 8 })

export const clampOrbitDistance = (lengths: number): number =>
  lengths < ORBIT_LENGTHS.min
    ? ORBIT_LENGTHS.min
    : lengths > ORBIT_LENGTHS.max
      ? ORBIT_LENGTHS.max
      : lengths

/** The orbit a session opens with: the chase's own standoff, from the quarter. */
export const DEFAULT_ORBIT: ObserverState = Object.freeze({
  azimuth: 0,
  elevation: 0.2,
  distance: 2.2,
})

export const DEFAULT_FLIGHT_CAMERA: FlightCameraState = Object.freeze({
  view: 'chase',
  orbit: DEFAULT_ORBIT,
  look: NO_LOOK,
})

/**
 * The horizontal frame the orbit's azimuth is measured in, about `up`.
 *
 * `east` is the world's +Y turned about the up direction, which is the one
 * reference the scene carries everywhere; where up *is* +Y — deep space, or
 * a body's pole — any perpendicular is as good as any other and +X stands in.
 * The frame is a function of `up` alone, so a camera that has stopped moving
 * stays still while the ship underneath it does anything at all.
 */
export function orbitFrame(up: Vec3): {
  readonly east: Vec3
  readonly north: Vec3
  readonly up: Vec3
} {
  const pole = Vec.normalize(up)
  const across = Vec.cross(vec3(0, 1, 0), pole)
  // The stand-in is projected off the pole before it is used: an up a
  // millionth off +Y takes the stand-in, and +X is then a millionth off
  // perpendicular, which `camera.test.ts` measured as a frame that was not
  // orthonormal by exactly that much.
  const seed = Vec.length(across) > 1e-6 ? across : vec3(1, 0, 0)
  const east = Vec.normalize(
    Vec.sub(seed, Vec.scale(pole, Vec.dot(seed, pole))),
  )
  return { east, north: Vec.cross(pole, east), up: pole }
}

/** The camera's displacement from the ship for an orbit, in render axes. */
export function orbitOffset(
  up: Vec3,
  orbit: ObserverState,
  hullLength: Meters,
): Vec3 {
  const frame = orbitFrame(up)
  const distance = orbit.distance * hullLength
  const level = distance * Math.cos(orbit.elevation)
  return Vec.add(
    Vec.add(
      Vec.scale(frame.east, level * Math.cos(orbit.azimuth)),
      Vec.scale(frame.north, level * Math.sin(orbit.azimuth)),
    ),
    Vec.scale(frame.up, distance * Math.sin(orbit.elevation)),
  )
}

/**
 * The orbit that stands the camera along `direction` from the ship.
 *
 * The inverse of `orbitOffset`, and what makes switching views a cut nobody
 * sees: the orbit opens where the chase camera was standing, and the first
 * drag moves it from there rather than from wherever it was left.
 */
export function orbitToward(
  up: Vec3,
  direction: Vec3,
  distance: number,
): ObserverState {
  const frame = orbitFrame(up)
  const d = Vec.normalize(direction)
  const height = Math.max(-1, Math.min(1, Vec.dot(d, frame.up)))
  return {
    azimuth: Math.atan2(Vec.dot(d, frame.north), Vec.dot(d, frame.east)),
    elevation: clampElevation(Math.asin(height)),
    distance: clampOrbitDistance(distance),
  }
}

/**
 * Where the flight camera stands and looks this frame, in render space.
 *
 * The chase view with no look offset is `chaseCameraPosition` and the ship's
 * own orientation, exactly — the frame every screenshot in the repository is
 * measured against. The orbit view looks at the ship's centre with the
 * horizon levelled to the local up, and both views lift the eye off the
 * ground by the same rule.
 */
export function flightCameraPose(
  scene: RenderScene,
  state: FlightCameraState,
  hullLength: Meters,
  /**
   * The chase standoff, when it is not the hull's own. The debug cone has a
   * hand-tuned one that predates `chaseOffsetFor`, and a modeled hull never
   * passes this.
   */
  chaseOffset: Vec3 = chaseOffsetFor(hullLength),
  clearance: Meters = CAMERA_GROUND_CLEARANCE,
): { readonly position: Vec3; readonly orientation: Quat } {
  const ship = scene.camera
  if (state.view === 'chase') {
    return {
      position: chaseCameraPosition(scene, chaseOffset, clearance),
      orientation: turn(ship.orientation, state.look),
    }
  }
  const offset = clearGround(
    scene,
    orbitOffset(ship.up, state.orbit, hullLength),
    clearance,
  )
  return {
    position: Vec.add(ship.position, offset),
    orientation: turn(lookAlong(Vec.negate(offset), ship.up), state.look),
  }
}
