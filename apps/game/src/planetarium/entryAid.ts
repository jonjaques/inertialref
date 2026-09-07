import { Vector3, type PerspectiveCamera } from 'three/webgpu'
import { Quaternion as Q, Vec, type Vec3 } from '@inertialref/spatial'
import type { GameEngine } from '../engine/GameEngine.ts'

/*
 * What the pointer is aiming at, as a direction the world understands.
 *
 * The whole of the drag's coupling to the screen. Everything downstream of
 * this — the arc, its rings, where a release lands — is solved in universe
 * axes by the observatory and drawn in the scene by `scene/EntryTrace.tsx`,
 * which is why nothing here projects anything back: an aid drawn over the
 * frame cannot be occluded by the limb it crosses, and this gesture's whole
 * subject is a curve that goes behind a world.
 */

/** Reused across frames: this runs on every frame of a drag. */
const scratch = new Vector3()

/**
 * Where a screen point is aiming, as a direction in universe axes.
 *
 * The camera's own axes are render axes, and the observatory's hit test speaks
 * universe ones — the two differ by the origin's orientation and by nothing
 * else, because compression is radial and a radial map does not turn a
 * direction. So one rotation converts, and no position is read.
 *
 * `x`/`y` are client pixels, which is the space the pointer arrives in.
 */
export function rayFromScreen(
  engine: GameEngine,
  point: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
): Vec3 | null {
  const scene = engine.scene()
  const view = engine.view
  if (scene === null || view === null) return null
  const camera = view.camera as PerspectiveCamera
  scratch.set(
    (point.x / size.width) * 2 - 1,
    -(point.y / size.height) * 2 + 1,
    0.5,
  )
  scratch.unproject(camera)
  scratch.sub(camera.position)
  if (scratch.lengthSq() === 0) return null
  scratch.normalize()
  return Q.rotate(scene.origin.orientation, {
    x: scratch.x,
    y: scratch.y,
    z: scratch.z,
  })
}

/** The held end on an eye-facing plane in front of the drawn body, in body radii. */
export function heldDropFromScreen(
  engine: GameEngine,
  point: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
): { readonly hold: Vec3; readonly up: Vec3 } | null {
  const scene = engine.scene()
  const view = engine.view
  const drawn = scene?.bodies.find(
    (body) => body.address === engine.harness.observatory.target?.address,
  )
  if (scene === null || view === null || drawn === undefined) return null
  const camera = view.camera as PerspectiveCamera
  scratch
    .set((point.x / size.width) * 2 - 1, (-point.y / size.height) * 2 + 1, 0.5)
    .unproject(camera)
    .sub(camera.position)
    .normalize()
  const ray = { x: scratch.x, y: scratch.y, z: scratch.z }
  const forward = Q.rotate(camera.quaternion, { x: 0, y: 0, z: -1 })
  const centre = drawn.placement.position
  const offset = Vec.sub(centre, camera.position)
  const depth = Vec.dot(offset, forward) - drawn.placement.scale * 1.15
  const along = Vec.dot(ray, forward)
  if (!(depth > 0) || !(along > 0)) return null
  const held = Vec.sub(
    Vec.add(camera.position, Vec.scale(ray, depth / along)),
    centre,
  )
  return {
    hold: Vec.scale(
      Q.rotateInverse(drawn.orientation, held),
      1 / drawn.placement.scale,
    ),
    up: Q.rotateInverse(
      drawn.orientation,
      Q.rotate(camera.quaternion, { x: 0, y: 1, z: 0 }),
    ),
  }
}
