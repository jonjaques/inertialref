import {
  AnimationMixer,
  type AnimationClip,
  type AnimationAction,
  type Group,
  LoopRepeat,
} from 'three/webgpu'

export type AstronautAnimation =
  'idle' | 'walk' | 'run' | 'crouch' | 'crouchWalk' | 'jump' | 'fall' | 'fly'

export interface AstronautMotion {
  readonly animation: AstronautAnimation
  readonly forward: number
  readonly right: number
  readonly speed: number
}

const CLIPS: Record<AstronautAnimation, string> = {
  idle: 'Idle',
  walk: 'Walk',
  run: 'Run',
  crouch: 'Crouch',
  crouchWalk: 'CrouchWalk',
  jump: 'Jump',
  fall: 'Fall',
  fly: 'Fly',
}

/** Each avatar owns its mixer, so two suits never borrow each other's pose. */
export function createAstronautAnimation(
  root: Group,
  clips: readonly AnimationClip[],
) {
  const mixer = new AnimationMixer(root)
  const actions = new Map<string, AnimationAction>()
  for (const name of [...Object.values(CLIPS), 'StrafeLeft', 'StrafeRight']) {
    const clip = clips.find((candidate) => candidate.name === name)
    if (clip === undefined) throw new Error(`astronaut lacks ${name} animation`)
    actions.set(name, mixer.clipAction(clip).setLoop(LoopRepeat, Infinity))
  }
  let current = actions.get('Idle')!
  let heldName = 'Idle'
  current.play()
  mixer.update(0)

  return {
    update(motion: AstronautMotion, delta: number): void {
      let name = CLIPS[motion.animation]
      if (
        (motion.animation === 'walk' || motion.animation === 'run') &&
        Math.abs(motion.right) > Math.abs(motion.forward) * 1.5
      ) {
        name = motion.right > 0 ? 'StrafeRight' : 'StrafeLeft'
      }
      if (name !== heldName) {
        const next = actions.get(name)!
        next.reset().setEffectiveWeight(1).play()
        next.crossFadeFrom(current, 0.16, false)
        current = next
        heldName = name
      }
      const moving = [
        'Walk',
        'Run',
        'CrouchWalk',
        'StrafeLeft',
        'StrafeRight',
      ].includes(name)
      const nominal = name === 'Run' ? 6 : name === 'CrouchWalk' ? 1.25 : 2.5
      const rate = moving
        ? Math.max(0.35, Math.min(2, motion.speed / nominal))
        : 1
      const backwards =
        moving && !name.startsWith('Strafe') && motion.forward < -0.1
      current.setEffectiveTimeScale(backwards ? -rate : rate)
      mixer.update(Math.max(0, delta))
      root.updateMatrixWorld(true)
    },
    dispose(): void {
      mixer.stopAllAction()
      mixer.uncacheRoot(root)
    },
  }
}
