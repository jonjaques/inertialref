import { type Brand, invariant, type Seconds } from '@inertialref/shared'
import * as Q from './quat.ts'
import type { Quat } from './quat.ts'
import * as V from './vec3.ts'
import type { Vec3 } from './vec3.ts'
import { difference, translate, UNIVERSE_ORIGIN, type UniverseVector } from './universeVector.ts'

/*
 * Reference frames.
 *
 * Precision is *not* what frames are for here — UniverseVector already gives
 * sub-millimetre resolution everywhere, so unlike most engines we do not need a
 * frame hierarchy to rescue floating-point error (ADR-0002). Frames exist for
 * the other two jobs:
 *
 *   1. Semantics of motion. "3 m above the launch pad" has to stay 3 m above
 *      the launch pad while the planet orbits at 30 km/s and rotates under it.
 *      Expressing that as an absolute position recomputed every tick would be
 *      both awkward and lossy in velocity terms.
 *   2. A stable origin for rendering and for local physics, which want small
 *      numbers near zero.
 *
 * Because precision does not depend on the frame you are in, a frame change is
 * a pure re-expression: `reframe` provably preserves canonical position, which
 * is exactly the property the vertical slice has to demonstrate.
 */

export type FrameId = Brand<string, 'frame'>

export const frameId = (id: string): FrameId => id as FrameId

/** Descriptive only — devtools group by it and streaming policies key off it. */
export type FrameKind = 'root' | 'system' | 'body' | 'orbit' | 'surface' | 'entity'

/** Pose of a frame relative to its parent. */
export interface LocalPose {
  /** Meters, in parent axes. */
  readonly position: Vec3
  /** Rotation taking this frame's axes into parent axes. */
  readonly orientation: Quat
  /** m/s of this frame's origin, in parent axes. */
  readonly velocity: Vec3
  /** rad/s of this frame's axes, in parent axes. */
  readonly angularVelocity: Vec3
}

export const REST_POSE: LocalPose = Object.freeze({
  position: V.ZERO,
  orientation: Q.IDENTITY,
  velocity: V.ZERO,
  angularVelocity: V.ZERO,
})

/** Fully resolved pose of a frame in universe coordinates and universe axes. */
export interface FramePose {
  readonly position: UniverseVector
  readonly orientation: Quat
  readonly velocity: Vec3
  readonly angularVelocity: Vec3
}

export const UNIVERSE_POSE: FramePose = Object.freeze({
  position: UNIVERSE_ORIGIN,
  orientation: Q.IDENTITY,
  velocity: V.ZERO,
  angularVelocity: V.ZERO,
})

export type FrameAnchor =
  /** The universe itself. Exactly one frame may use this. */
  | { readonly kind: 'root' }
  /**
   * Pinned to an absolute universe position. Star systems use this: their
   * position relative to the galactic root is ~1e20 m, which a parent-relative
   * Vec3 could only express to ~16 km.
   */
  | { readonly kind: 'fixed'; readonly position: UniverseVector; readonly orientation: Quat }
  /**
   * Pose is a pure function of simulation time. Orbits and rotating bodies use
   * this; the function is supplied by the universe/simulation layer so this
   * package stays free of orbital mechanics.
   */
  | { readonly kind: 'dynamic'; readonly evaluate: (t: Seconds) => LocalPose }

export interface FrameDefinition {
  readonly id: FrameId
  readonly parent: FrameId | null
  readonly kind: FrameKind
  readonly anchor: FrameAnchor
}

export const ROOT_FRAME = frameId('universe')

export function rootFrame(): FrameDefinition {
  return { id: ROOT_FRAME, parent: null, kind: 'root', anchor: { kind: 'root' } }
}

/**
 * The frame tree, plus a one-tick pose cache.
 *
 * Resolution walks to the root and composes, which is O(depth) — depth is 4-6
 * in practice. The cache exists because a tick resolves the same handful of
 * frames for every entity in them, and `evaluate` for an orbital frame runs a
 * Kepler solve.
 */
export class FrameGraph {
  readonly #frames = new Map<FrameId, FrameDefinition>()
  readonly #cache = new Map<FrameId, FramePose>()
  #cacheTime: Seconds | null = null

  constructor() {
    this.#frames.set(ROOT_FRAME, rootFrame())
  }

  define(definition: FrameDefinition): void {
    if (definition.anchor.kind === 'root') {
      invariant(definition.id === ROOT_FRAME, `Only ${ROOT_FRAME} may be the root frame`)
    } else {
      invariant(definition.parent !== null, `Frame ${definition.id} needs a parent`)
      invariant(
        this.#frames.has(definition.parent),
        `Frame ${definition.id} references unknown parent ${definition.parent}`,
      )
      if (definition.anchor.kind === 'fixed') {
        invariant(
          definition.parent === ROOT_FRAME,
          `Fixed frame ${definition.id} must hang off ${ROOT_FRAME}; its position is absolute`,
        )
      }
    }
    this.#frames.set(definition.id, definition)
    this.#cache.clear()
  }

  remove(id: FrameId): void {
    invariant(id !== ROOT_FRAME, 'Cannot remove the root frame')
    for (const frame of this.#frames.values()) {
      invariant(frame.parent !== id, `Frame ${id} still has child ${frame.id}`)
    }
    this.#frames.delete(id)
    this.#cache.clear()
  }

  has(id: FrameId): boolean {
    return this.#frames.has(id)
  }

  get(id: FrameId): FrameDefinition {
    const frame = this.#frames.get(id)
    invariant(frame !== undefined, `Unknown frame ${id}`)
    return frame
  }

  ids(): readonly FrameId[] {
    return [...this.#frames.keys()]
  }

  /** Root-first chain down to `id`, for devtools breadcrumbs. */
  chain(id: FrameId): readonly FrameId[] {
    const path: FrameId[] = []
    let cursor: FrameId | null = id
    while (cursor !== null) {
      path.push(cursor)
      cursor = this.get(cursor).parent
    }
    return path.reverse()
  }

  /** Resolve `id` to universe coordinates at simulation time `t`. */
  pose(id: FrameId, t: Seconds): FramePose {
    if (this.#cacheTime !== t) {
      this.#cache.clear()
      this.#cacheTime = t
    }
    const cached = this.#cache.get(id)
    if (cached !== undefined) return cached

    const definition = this.get(id)
    let pose: FramePose
    switch (definition.anchor.kind) {
      case 'root':
        pose = UNIVERSE_POSE
        break
      case 'fixed':
        pose = {
          position: definition.anchor.position,
          orientation: definition.anchor.orientation,
          velocity: V.ZERO,
          angularVelocity: V.ZERO,
        }
        break
      case 'dynamic': {
        invariant(definition.parent !== null, `Dynamic frame ${id} has no parent`)
        pose = composePose(this.pose(definition.parent, t), definition.anchor.evaluate(t))
        break
      }
    }
    this.#cache.set(id, pose)
    return pose
  }

  /** Drop cached poses. Call after mutating a dynamic frame's closure state. */
  invalidate(): void {
    this.#cache.clear()
    this.#cacheTime = null
  }
}

/** Compose a parent's universe pose with a child's parent-relative pose. */
export function composePose(parent: FramePose, local: LocalPose): FramePose {
  const offset = Q.rotate(parent.orientation, local.position)
  return {
    position: translate(parent.position, offset),
    orientation: Q.normalize(Q.multiply(parent.orientation, local.orientation)),
    // Transport theorem: the child's origin also inherits the tangential
    // velocity from the parent's rotation, which is what makes a point on a
    // rotating planet's surface move at 465 m/s without anyone integrating it.
    velocity: V.add(
      V.add(parent.velocity, Q.rotate(parent.orientation, local.velocity)),
      V.cross(parent.angularVelocity, offset),
    ),
    angularVelocity: V.add(
      parent.angularVelocity,
      Q.rotate(parent.orientation, local.angularVelocity),
    ),
  }
}

/* ------------------------------------------------------------------------- */
/* Point and vector transforms                                                */
/* ------------------------------------------------------------------------- */

export const localToUniverse = (pose: FramePose, local: Vec3): UniverseVector =>
  translate(pose.position, Q.rotate(pose.orientation, local))

export const universeToLocal = (pose: FramePose, position: UniverseVector): Vec3 =>
  Q.rotateInverse(pose.orientation, difference(position, pose.position))

/** Velocity of a point that is moving at `localVelocity` within `pose`. */
export function localVelocityToUniverse(pose: FramePose, local: Vec3, localVelocity: Vec3): Vec3 {
  const offset = Q.rotate(pose.orientation, local)
  return V.add(
    V.add(pose.velocity, Q.rotate(pose.orientation, localVelocity)),
    V.cross(pose.angularVelocity, offset),
  )
}

/** Inverse of `localVelocityToUniverse`, given the point's universe position. */
export function universeVelocityToLocal(
  pose: FramePose,
  position: UniverseVector,
  velocity: Vec3,
): Vec3 {
  const offset = difference(position, pose.position)
  const relative = V.sub(V.sub(velocity, pose.velocity), V.cross(pose.angularVelocity, offset))
  return Q.rotateInverse(pose.orientation, relative)
}

/* ------------------------------------------------------------------------- */
/* Frame-relative state                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Where something is and how it is moving, expressed in one frame.
 *
 * This is the canonical form for entity kinematics: an absolute position is
 * derived from it, never stored alongside it, so the two cannot disagree.
 */
export interface FrameState {
  readonly frame: FrameId
  readonly position: Vec3
  readonly orientation: Quat
  readonly velocity: Vec3
  readonly angularVelocity: Vec3
}

export const restState = (frame: FrameId): FrameState => ({
  frame,
  position: V.ZERO,
  orientation: Q.IDENTITY,
  velocity: V.ZERO,
  angularVelocity: V.ZERO,
})

export function canonicalPosition(graph: FrameGraph, state: FrameState, t: Seconds): UniverseVector {
  return localToUniverse(graph.pose(state.frame, t), state.position)
}

export function canonicalVelocity(graph: FrameGraph, state: FrameState, t: Seconds): Vec3 {
  return localVelocityToUniverse(graph.pose(state.frame, t), state.position, state.velocity)
}

export function canonicalOrientation(graph: FrameGraph, state: FrameState, t: Seconds): Quat {
  return Q.normalize(Q.multiply(graph.pose(state.frame, t).orientation, state.orientation))
}

/**
 * Re-express a state in a different frame at the same instant.
 *
 * This is the frame transition the vertical slice has to prove: entering a
 * planet's frame on approach changes the numbers an entity carries but not
 * where or how fast it actually is. Round-tripping through here is
 * position-exact to well under a millimetre and velocity-exact to floating
 * point, which `frame.test.ts` asserts.
 */
export function reframe(
  graph: FrameGraph,
  state: FrameState,
  target: FrameId,
  t: Seconds,
): FrameState {
  if (state.frame === target) return state
  const from = graph.pose(state.frame, t)
  const to = graph.pose(target, t)

  const universePosition = localToUniverse(from, state.position)
  const universeVelocity = localVelocityToUniverse(from, state.position, state.velocity)
  const universeOrientation = Q.multiply(from.orientation, state.orientation)
  const universeAngular = V.add(
    from.angularVelocity,
    Q.rotate(from.orientation, state.angularVelocity),
  )

  return {
    frame: target,
    position: universeToLocal(to, universePosition),
    orientation: Q.normalize(Q.multiply(Q.conjugate(to.orientation), universeOrientation)),
    velocity: universeVelocityToLocal(to, universePosition, universeVelocity),
    angularVelocity: Q.rotateInverse(to.orientation, V.sub(universeAngular, to.angularVelocity)),
  }
}
