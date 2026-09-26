import type { Quat, Vec3 } from '@inertialref/spatial'

/** Presentation only, sampled from a character at the frame's instant. */
export interface CharacterView {
  readonly id: string
  readonly position: Vec3
  readonly orientation: Quat
  readonly visible: boolean
  readonly animation:
    'idle' | 'walk' | 'run' | 'crouch' | 'crouchWalk' | 'jump' | 'fall' | 'fly'
  readonly speed: number
  readonly forward: number
  readonly right: number
}
