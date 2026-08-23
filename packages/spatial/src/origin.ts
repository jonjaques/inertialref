import type { Meters, Seconds } from '@inertialref/shared'
import {
  type FrameGraph,
  type FrameId,
  type FramePose,
  ROOT_FRAME,
} from './frame.ts'
import * as Q from './quat.ts'
import type { Quat } from './quat.ts'
import { difference, translate, type UniverseVector } from './universeVector.ts'
import { type Vec3, vec3 } from './vec3.ts'

/*
 * Floating origin.
 *
 * Render space is a right-handed metric space whose origin sits at some
 * UniverseVector and whose axes are those of an anchor frame. Everything the
 * GPU sees is expressed relative to it, so vertex coordinates stay small enough
 * for float32 no matter where in the galaxy the player is (ADR-0003).
 *
 * Two properties make this safe to do continuously:
 *
 *   - Rebasing is snapped to a power-of-two meter grid, so the shift applied to
 *     every render coordinate is exactly representable in both float64 and
 *     float32. Ten thousand rebases introduce exactly zero drift, rather than
 *     ten thousand roundings — `origin.test.ts` asserts bit-equality.
 *   - The origin is a *view* onto canonical state. Nothing is written back, so
 *     a rebase cannot move an entity. That is the point of the exercise.
 */

/** Render coordinates are kept inside this radius, in meters. */
export const REBASE_THRESHOLD: Meters = 4096
/** Rebase target is snapped to this grid. Must be a power of two ≤ the threshold. */
export const REBASE_SNAP: Meters = 1024

export interface RenderOrigin {
  /** Universe position of render-space (0, 0, 0). */
  readonly position: UniverseVector
  /** Rotation taking render axes into universe axes. */
  readonly orientation: Quat
  /** Frame whose axes render space borrows; devtools display it. */
  readonly anchorFrame: FrameId
  /** Increments on every rebase. Renderers use it to detect that they must re-place static geometry. */
  readonly generation: number
}

export function createRenderOrigin(
  position: UniverseVector,
  orientation: Quat = Q.IDENTITY,
  anchorFrame: FrameId = ROOT_FRAME,
): RenderOrigin {
  return { position, orientation, anchorFrame, generation: 0 }
}

/** Anchor render space to a frame's origin and axes (used on planetary surfaces). */
export function originForFrame(
  graph: FrameGraph,
  frame: FrameId,
  t: Seconds,
  generation = 0,
): RenderOrigin {
  const pose: FramePose = graph.pose(frame, t)
  return {
    position: pose.position,
    orientation: pose.orientation,
    anchorFrame: frame,
    generation,
  }
}

export const toRenderSpace = (
  origin: RenderOrigin,
  position: UniverseVector,
): Vec3 =>
  Q.rotateInverse(origin.orientation, difference(position, origin.position))

export const fromRenderSpace = (
  origin: RenderOrigin,
  render: Vec3,
): UniverseVector =>
  translate(origin.position, Q.rotate(origin.orientation, render))

/** Rotate a universe-axes direction or velocity into render axes. */
export const directionToRenderSpace = (
  origin: RenderOrigin,
  direction: Vec3,
): Vec3 => Q.rotateInverse(origin.orientation, direction)

/** Orientation of an object with universe orientation `q`, in render axes. */
export const orientationToRenderSpace = (origin: RenderOrigin, q: Quat): Quat =>
  Q.normalize(Q.multiply(Q.conjugate(origin.orientation), q))

export function needsRebase(
  origin: RenderOrigin,
  camera: UniverseVector,
  threshold: Meters = REBASE_THRESHOLD,
): boolean {
  const d = difference(camera, origin.position)
  return (
    Math.abs(d.x) > threshold ||
    Math.abs(d.y) > threshold ||
    Math.abs(d.z) > threshold
  )
}

const snap = (value: number, grid: number): number =>
  Math.round(value / grid) * grid

/**
 * Move the origin to the snapped grid point nearest the camera.
 *
 * Snapping is what keeps this exact: the delta is an integer multiple of a
 * power of two, so `translate` adds it without rounding and every render
 * coordinate shifts by a value float32 can hold exactly.
 */
export function rebase(
  origin: RenderOrigin,
  camera: UniverseVector,
  grid: Meters = REBASE_SNAP,
): RenderOrigin {
  const d = difference(camera, origin.position)
  const delta = vec3(snap(d.x, grid), snap(d.y, grid), snap(d.z, grid))
  if (delta.x === 0 && delta.y === 0 && delta.z === 0) return origin
  return {
    position: translate(origin.position, Q.rotate(origin.orientation, delta)),
    orientation: origin.orientation,
    anchorFrame: origin.anchorFrame,
    generation: origin.generation + 1,
  }
}

/** Rebase only when the camera has drifted past the threshold. */
export function maintainOrigin(
  origin: RenderOrigin,
  camera: UniverseVector,
  threshold: Meters = REBASE_THRESHOLD,
  grid: Meters = REBASE_SNAP,
): RenderOrigin {
  return needsRebase(origin, camera, threshold)
    ? rebase(origin, camera, grid)
    : origin
}

/** Re-anchor render axes to another frame, keeping the origin point put. */
export function reanchor(
  origin: RenderOrigin,
  graph: FrameGraph,
  frame: FrameId,
  t: Seconds,
): RenderOrigin {
  if (origin.anchorFrame === frame) return origin
  const pose = graph.pose(frame, t)
  return {
    position: origin.position,
    orientation: pose.orientation,
    anchorFrame: frame,
    generation: origin.generation + 1,
  }
}
