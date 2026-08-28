import { Vector3, type PerspectiveCamera } from 'three/webgpu'
import {
  type Lens,
  type RenderScene,
  verticalFov,
} from '@inertialref/rendering'
import type { PickCandidate } from './pick.ts'

/*
 * The scene, as things on screen.
 *
 * One projection pass feeds both the labels and the hit test, and that is
 * deliberate: a name drawn at one place and a click resolved against another is
 * the most quietly infuriating bug an interface of this kind can have, and two
 * projection paths is how it happens. `pick.ts` decides *which* candidate wins
 * and knows nothing about cameras; this decides where they are and knows
 * nothing about intent.
 *
 * Bodies are drawn from the scene description rather than from the Three.js
 * objects, because the scene description is the thing that has an address in
 * it — and the address is what a click has to produce for the observatory to
 * act on it.
 */

/** Reused across frames: this runs on every pointer move and every label pass. */
const scratch = new Vector3()

/**
 * Everything nameable on screen, nearest-first within each kind.
 *
 * Screen radius is computed from the *rendered* geometry — the placed scale
 * over the distance to the camera — rather than from `placement.angularRadius`,
 * which is measured from the render origin. The two agree to within the rebase
 * window in almost every frame and disagree exactly when the camera has just
 * moved a long way, which is when a click is most likely to be aimed at
 * something that has visibly changed size.
 */
export function projectScene(
  scene: RenderScene,
  camera: PerspectiveCamera,
  size: { readonly width: number; readonly height: number },
  /**
   * The lens the frame is composed through — `engine.lens`, never the camera's
   * own `fov`.
   *
   * A label drawn at one radius and a click resolved against another is the bug
   * this module's header is about, and reading the optics from a different
   * producer than the one that set the projection is how it happens. A default
   * would be worst exactly where it fires — on a camera that is not a
   * `PerspectiveCamera`, which is when the picture is least like the one any
   * fixed angle describes.
   */
  lens: Lens,
): PickCandidate[] {
  const halfHeight = size.height / 2
  const tanHalfFov = Math.tan(verticalFov(lens) / 2)
  const candidates: PickCandidate[] = []

  const add = (
    address: string,
    name: string,
    kind: string,
    position: { x: number; y: number; z: number },
    worldRadius: number,
  ): void => {
    scratch.set(position.x, position.y, position.z)
    const range = scratch.distanceTo(camera.position)
    scratch.project(camera)
    // `z` outside [−1, 1] is behind the eye or past the far plane. Behind is
    // the one that matters: it projects to a perfectly plausible pair of screen
    // coordinates, so without this a click on empty sky selects a planet on the
    // far side of the star.
    const offscreen = scratch.z < -1 || scratch.z > 1
    candidates.push({
      address,
      name,
      kind,
      x: (scratch.x * 0.5 + 0.5) * size.width,
      y: (1 - (scratch.y * 0.5 + 0.5)) * size.height,
      radius: range > 0 ? (worldRadius / range / tanHalfFov) * halfHeight : 0,
      offscreen,
    })
  }

  for (const body of scene.bodies) {
    add(
      body.address,
      body.name,
      body.kind,
      body.placement.position,
      body.placement.scale,
    )
  }
  for (const star of scene.stars) {
    // A bare designation, which `resolveDestination` accepts and turns into a
    // system address — the same string a person types into the search box.
    add(
      star.system,
      star.name,
      'star',
      star.placement.position,
      star.placement.scale,
    )
  }
  return candidates
}
