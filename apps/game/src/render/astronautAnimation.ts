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
  /** The held axes, so a walk backward or aside picks its clip. */
  readonly forward: number
  readonly right: number
  /** Ground speed, m/s, which locks the gait to the distance covered. */
  readonly speed: number
}

/**
 * Meters one cycle of each moving clip covers, as `scripts/models/astronaut.py`
 * authors it: two steps of the stride the clip was built with. The runtime
 * advances a cycle by the distance the entity actually moves divided by
 * this, so the planted foot stays planted at any speed the controller reaches
 * rather than sliding at every speed but the nominal one.
 */
const CYCLE_METERS: Readonly<Record<string, number>> = {
  Walk: 1.4,
  Run: 2.0,
  CrouchWalk: 1.0,
  StrafeLeft: 1.0,
  StrafeRight: 1.0,
}

/** The walk gives way to the run across this band of ground speed. */
const RUN_BLEND = { from: 3.6, to: 5.2 } as const
/** Standing still, for the gait's purposes. */
const STILL = 0.15
/** Seconds a clip takes to arrive at its full weight. */
const FADE = 0.15

const CLIPS = [
  'Idle',
  'Walk',
  'Run',
  'Crouch',
  'CrouchWalk',
  'StrafeLeft',
  'StrafeRight',
  'Jump',
  'Fall',
  'Fly',
] as const
type ClipName = (typeof CLIPS)[number]

/**
 * Each avatar owns its mixer, so two suits never borrow each other's pose.
 *
 * Every clip plays at once and the picture is their weighted sum: the
 * targets below say which ones carry it, weights ramp toward the targets
 * over `FADE`, and the moving clips share one cycle phase that the ground
 * speed advances. The mixer advances only the clips whose time is the
 * clock's — a breath, a fall, a tuck — while a gait's time is written from
 * the phase each frame, which is what synchronizes a walk into a run at the
 * same point of the stride.
 */
export function createAstronautAnimation(
  root: Group,
  clips: readonly AnimationClip[],
) {
  const mixer = new AnimationMixer(root)
  const actions = new Map<ClipName, AnimationAction>()
  const durations = new Map<ClipName, number>()
  for (const name of CLIPS) {
    const clip = clips.find((candidate) => candidate.name === name)
    if (clip === undefined) throw new Error(`astronaut lacks ${name} animation`)
    const action = mixer.clipAction(clip).setLoop(LoopRepeat, Infinity)
    action.play()
    action.setEffectiveWeight(name === 'Idle' ? 1 : 0)
    if (name in CYCLE_METERS) action.setEffectiveTimeScale(0)
    actions.set(name, action)
    durations.set(name, clip.duration)
  }
  const weights = new Map<ClipName, number>(
    CLIPS.map((name) => [name, name === 'Idle' ? 1 : 0]),
  )
  let phase = 0
  mixer.update(0)

  return {
    update(motion: AstronautMotion, delta: number): void {
      const targets = new Map<ClipName, number>()
      const sideways = Math.abs(motion.right) > Math.abs(motion.forward) * 1.5
      const moving = motion.speed > STILL
      let cycle: ClipName | null = null
      if (motion.animation === 'fly') targets.set('Fly', 1)
      else if (motion.animation === 'jump') targets.set('Jump', 1)
      else if (motion.animation === 'fall') targets.set('Fall', 1)
      else if (
        motion.animation === 'crouch' ||
        motion.animation === 'crouchWalk'
      ) {
        if (moving) {
          cycle = 'CrouchWalk'
          targets.set('CrouchWalk', 1)
        } else targets.set('Crouch', 1)
      } else if (!moving) targets.set('Idle', 1)
      else if (sideways) {
        cycle = motion.right > 0 ? 'StrafeRight' : 'StrafeLeft'
        targets.set(cycle, 1)
      } else {
        const run = Math.max(
          0,
          Math.min(
            1,
            (motion.speed - RUN_BLEND.from) / (RUN_BLEND.to - RUN_BLEND.from),
          ),
        )
        cycle = run > 0.5 ? 'Run' : 'Walk'
        targets.set('Walk', 1 - run)
        targets.set('Run', run)
      }

      // A walk backward plays its cycle backward; a walk aside plays the
      // side step forward whichever way it faces. Distance, not time,
      // advances the cycle, so the feet plant where the ground is.
      if (cycle !== null && delta > 0) {
        const direction = !sideways && motion.forward < -0.1 ? -1 : 1
        phase =
          (((phase +
            (direction * motion.speed * delta) / CYCLE_METERS[cycle]!) %
            1) +
            1) %
          1
      }
      const rate = delta > 0 ? Math.min(1, delta / FADE) : 0
      for (const name of CLIPS) {
        const target = targets.get(name) ?? 0
        const held = weights.get(name)!
        const next =
          Math.abs(target - held) <= rate
            ? target
            : held + Math.sign(target - held) * rate
        weights.set(name, next)
        const action = actions.get(name)!
        action.setEffectiveWeight(next)
        if (name in CYCLE_METERS) action.time = phase * durations.get(name)!
      }
      mixer.update(Math.max(0, delta))
      root.updateMatrixWorld(true)
    },
    dispose(): void {
      mixer.stopAllAction()
      mixer.uncacheRoot(root)
    },
  }
}
