import { useFrame } from '@react-three/fiber'
import { frameDelta } from '../engine/frameHold.ts'
import type { GameEngine } from '../engine/GameEngine.ts'
import { runGraphicsFrame } from '../runtimeFailure.ts'

/**
 * Steps the simulation, once per animation frame, before anything reads it.
 *
 * Its own component with an explicit negative priority rather than a line at the
 * top of `CameraRig`. R3F runs equal-priority `useFrame` callbacks in mount
 * order, so while the tick lived inside `CameraRig` the correctness of every
 * other consumer — `Starfield`, `Bodies`, `TerrainPatches`, `ShipModel` — rested on `<CameraRig />` appearing first in the fragment
 * above. Moving one JSX line would have made every planet render a frame stale,
 * silently. Priority says it instead.
 */
export function EngineTick({ engine }: { engine: GameEngine }) {
  useFrame((_, delta) => {
    // A held frame steps nothing. A frame the page's pace skipped hands its
    // `delta` to the next drawn one, where the clock books it: R3F takes each
    // callback's `delta` afresh, so without the bank a page paced at 60 on a
    // 120 Hz display would live through half of wall time. See
    // `engine/frameHold.ts`.
    const step = frameDelta(delta)
    if (step === null) return
    // The one place the wall clock enters the game, and it is handed over raw.
    // It used to be clamped to 0.25 s here, which changed nothing about the
    // spiral of death — `clock.plan` already caps a frame's integration at
    // DEFAULT_MAX_STEPS — and did corrupt the diagnostic: the clock books the
    // excess as `droppedTicks`, so a three-minute background stall was reported
    // in the HUD as 8 dropped ticks instead of 11,520.
    runGraphicsFrame(() => engine.frame(step))
  }, -1)
  return null
}
