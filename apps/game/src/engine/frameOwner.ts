import type { ObserverPose } from '@inertialref/devtools'
import type { EntityId } from '@inertialref/universe'

/*
 * Who owns the frame, decided once.
 *
 * Four arms, in the precedence ADR-0047 keeps: a cutscene, then the
 * observatory, then the walker, then the ship. A scripted scene is the one
 * thing allowed to take the camera from whatever holds it — that is what makes
 * `ir.play()` work from inside the planetarium — and only the last arm needs
 * an entity, so no arm may depend on a later one resolving.
 *
 * The eye, the pose the galaxy reads, the eye `buildScene` is handed and the
 * camera rig's choice were each a separate spelling of this order, and a
 * consumer that wanted to know whether a script held the camera asked
 * `engine.cinematic === null` for itself. Everything now reads the arm this
 * returns.
 */

type FrameArm = 'cutscene' | 'observatory' | 'walker' | 'ship'

export interface FrameOwnerInput {
  /** The director's camera this frame, universe space. */
  readonly cutscene: ObserverPose | null
  /** The observatory's eye; never sampled while a cutscene plays. */
  readonly observatory: ObserverPose | null
  /** The walker camera's pose, when the player is on foot. */
  readonly walker: ObserverPose | null
  /** The player's entity in this frame's snapshot, if there is one. */
  readonly player: {
    readonly id: EntityId
    readonly position: ObserverPose['position']
    readonly orientation: ObserverPose['orientation']
  } | null
  /** The ship a walker stepped out of; `OnFoot.ship()`. */
  readonly walkerShip: EntityId | null
  /** Whether the player is a walker rather than a ship. */
  readonly walking: boolean
}

export interface FrameOwner {
  readonly arm: FrameArm
  /** The eye this frame is drawn from, universe space. */
  readonly pose: ObserverPose
  /**
   * The eye `buildScene` takes in place of the entity's. Undefined on the
   * ship arm: there the entity *is* the eye, and it carries the measured
   * altitude a presentation eye honestly does not have.
   */
  readonly eye: ObserverPose | undefined
  /**
   * The player's ship, whichever arm holds the camera: the one the walker
   * stepped out of on foot, the player otherwise. Null with no player.
   */
  readonly ship: EntityId | null
}

/** The frame's owner, or null when no arm can supply an eye. */
export function resolveFrameOwner(input: FrameOwnerInput): FrameOwner | null {
  const ship = input.walking ? input.walkerShip : (input.player?.id ?? null)
  const owned = (arm: FrameArm, pose: ObserverPose): FrameOwner => ({
    arm,
    pose,
    eye: pose,
    ship,
  })
  if (input.cutscene !== null) return owned('cutscene', input.cutscene)
  if (input.observatory !== null) return owned('observatory', input.observatory)
  if (input.walker !== null) return owned('walker', input.walker)
  if (input.player !== null)
    return {
      arm: 'ship',
      pose: {
        position: input.player.position,
        orientation: input.player.orientation,
      },
      eye: undefined,
      ship,
    }
  return null
}
