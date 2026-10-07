import {
  bodyGround,
  type CharacterCameraMemory,
  type CharacterCameraPose,
  characterCameraPose,
  characterFeet,
} from '@inertialref/rendering'
import type { EntitySnapshot, WorldSnapshot } from '@inertialref/simulation'
import { type Quat, type UniverseVector, Vec } from '@inertialref/spatial'
import type { EntityId } from '@inertialref/universe'
import type { CharacterView } from './characterView.ts'

/*
 * What the frame shows of the walkers: the player's eye and every suit.
 *
 * A function of the shot and what the camera remembers, so the gait, the
 * cut rule and the views are tested without an engine. The engine calls it
 * once a frame, keeps the memory it hands back, and carries the result into
 * render space once it has placed the origin.
 *
 * **A cut drops the camera's memory.** The memory is keyed by the picture
 * epoch it was made in and the walker it was made for, so every cut — a
 * cutscene starting, the observatory taking the picture, `ir.view` — and
 * every new walker start the eye's filters at their targets without anyone
 * clearing them by hand. Switching between the first- and third-person views is the one cut
 * that keeps them: the boom eases out from the head, which is the transition
 * between the two that reads as a camera move rather than a jump.
 */

/** The camera's memory, and the picture and the walker it was made for. */
export interface HeldMemory {
  readonly epoch: number
  readonly view: 'first' | 'third'
  readonly walker: EntityId
  readonly memory: CharacterCameraMemory
}

/** One suit, in universe space; the engine places it. */
export interface WalkerPresentation {
  readonly id: EntityId
  /** Whether this is the player's own suit, drawn only from outside its head. */
  readonly own: boolean
  readonly feet: UniverseVector
  readonly orientation: Quat
  readonly animation: CharacterView['animation']
  readonly speed: number
  readonly forward: number
  readonly right: number
}

export interface OnFootFrame {
  readonly shot: WorldSnapshot
  readonly player: EntityId | null
  readonly view: 'first' | 'third'
  readonly pitch: number
  /** Seconds of presentation since the last frame. */
  readonly delta: number
  readonly epoch: number
  readonly memory: HeldMemory | null
}

export interface OnFootPresentation {
  /** The player's eye on foot, or null when the player is not walking. */
  readonly pose: CharacterCameraPose | null
  readonly walkers: readonly WalkerPresentation[]
  readonly memory: HeldMemory | null
}

/** Which clip a suit plays, from what the world says it is doing. */
export function gaitFor(
  entity: Pick<EntitySnapshot, 'character' | 'localVelocity' | 'localPosition'>,
): CharacterView['animation'] {
  const walker = entity.character
  if (walker == null) return 'idle'
  if (walker.flying) return 'fly'
  if (!walker.grounded)
    return Vec.dot(entity.localVelocity, Vec.normalize(entity.localPosition)) >
      0
      ? 'jump'
      : 'fall'
  if (walker.crouched) return walker.speed > 0.1 ? 'crouchWalk' : 'crouch'
  if (walker.speed < 0.1) return 'idle'
  return walker.input.sprint ? 'run' : 'walk'
}

/**
 * The memory this frame starts from: none for another walker, and none across
 * a cut unless the one cut since is the view switch itself.
 *
 * The walker key is what covers stepping out and the pad fixture: each spawns
 * a walker with a fresh id. The epoch rule covers a cut the same walker lives
 * through — a switch that lands in the same frame as `ir.view` or a cutscene's
 * shot change, or a second switch — and drops the memory there, because the
 * filters describe a picture that is gone: the step detector would read the
 * jump as a step and hold the eye where the feet used to be.
 */
function carried(
  held: HeldMemory | null,
  frame: Pick<OnFootFrame, 'epoch' | 'view' | 'player'>,
): CharacterCameraMemory | null {
  if (held === null || held.walker !== frame.player) return null
  if (held.epoch === frame.epoch) return held.memory
  return held.view !== frame.view && frame.epoch === held.epoch + 1
    ? { ...held.memory, boom: 0 }
    : null
}

export function presentOnFoot(frame: OnFootFrame): OnFootPresentation {
  const { shot, player } = frame
  const own =
    player === null
      ? undefined
      : shot.entities.find((entity) => entity.id === player)
  const walker = own?.character
  const pose =
    own === undefined || walker == null
      ? null
      : characterCameraPose({
          position: own.position,
          orientation: own.orientation,
          spin: walker.spin,
          ground: bodyGround(walker.body, shot.structures),
          eyeHeight: walker.eyeHeight,
          pitch: frame.pitch,
          view: frame.view,
          grounded: walker.grounded,
          verticalSpeed: Vec.dot(
            own.localVelocity,
            Vec.normalize(own.localPosition),
          ),
          delta: frame.delta,
          memory: carried(frame.memory, frame),
        })

  const walkers: WalkerPresentation[] = []
  for (const entity of shot.entities) {
    const suit = entity.character
    if (suit == null) continue
    const mine = entity.id === player
    walkers.push({
      id: entity.id,
      own: mine,
      // The player's feet carry the lift the camera is absorbing, so the
      // suit and the eye stay in step; another suit has no camera of its own.
      feet:
        mine && pose !== null
          ? pose.feet
          : characterFeet({
              position: entity.position,
              spin: suit.spin,
              ground: bodyGround(suit.body, shot.structures),
            }),
      orientation: entity.orientation,
      animation: gaitFor(entity),
      speed: suit.speed,
      forward: suit.input.forward,
      right: suit.input.right,
    })
  }

  return {
    pose,
    walkers,
    memory:
      pose === null || player === null
        ? null
        : {
            epoch: frame.epoch,
            view: frame.view,
            walker: player,
            memory: pose.memory,
          },
  }
}
