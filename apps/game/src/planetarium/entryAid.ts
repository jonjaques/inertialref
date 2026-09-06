import { Vector3, type PerspectiveCamera } from 'three/webgpu'
import { Quaternion as Q, type Vec3 } from '@inertialref/spatial'
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
