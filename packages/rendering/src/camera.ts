import type { Meters } from '@inertialref/shared'
import { Quaternion as Q, Vec, type Vec3, vec3 } from '@inertialref/spatial'
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
 * see the ship, the metre-scale reference objects beside it and the planet in
 * one frame. This is the offset for the 6 m debug hull; a modelled hull
 * derives its own through `chaseOffsetFor`.
 */
export const CHASE_OFFSET: Vec3 = vec3(0, 2.5, 14)

/**
 * The chase offset for a hull of a given overall length.
 *
 * The framing is a ratio, not a distance: what makes a chase view read is the
 * hull filling roughly the same fraction of the frame regardless of whether it
 * is six metres long or six hundred. 1.4 lengths behind and 0.28 above keeps
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
 * kilometres wide the difference is centimetres, and sampling the heightfield
 * from here would mean the renderer asking the universe a question mid-frame.
 */
export function chaseCameraPosition(
  scene: RenderScene,
  offset: Vec3 = CHASE_OFFSET,
  clearance: Meters = CAMERA_GROUND_CLEARANCE,
): Vec3 {
  const rotated = Q.rotate(scene.camera.orientation, offset)
  const altitude = scene.camera.altitude
  if (altitude === null) return Vec.add(scene.camera.position, rotated)

  // How much of the offset is straight up. Negative when the ship is nose-high,
  // because "behind" has rotated downwards.
  const rise = Vec.dot(rotated, scene.camera.up)
  const shortfall = clearance - (altitude + rise)
  const lifted =
    shortfall > 0
      ? Vec.add(rotated, Vec.scale(scene.camera.up, shortfall))
      : rotated
  return Vec.add(scene.camera.position, lifted)
}
