import { useFrame } from '@react-three/fiber'
import type { GameEngine } from '../engine/GameEngine.ts'

/**
 * Steps the simulation, once per animation frame, before anything reads it.
 *
 * Its own component with an explicit negative priority rather than a line at the
 * top of `CameraRig`. R3F runs equal-priority `useFrame` callbacks in mount
 * order, so while the tick lived inside `CameraRig` the correctness of every
 * other consumer — `Starfield`, `Bodies`, `TerrainPatches`, `ShipModel`,
 * `NearFieldProps` — rested on `<CameraRig />` appearing first in the fragment
 * above. Moving one JSX line would have made every planet render a frame stale,
 * silently. Priority says it instead.
 */
export function EngineTick({ engine }: { engine: GameEngine }) {
  useFrame((_, delta) => {
    // The one place the wall clock enters the game, and it is handed over raw.
    // It used to be clamped to 0.25 s here, which changed nothing about the
    // spiral of death — `SimulationClock.advance` already caps a step at
    // DEFAULT_MAX_STEPS — and did corrupt the diagnostic: the clock books the
    // excess as `droppedTicks`, so a three-minute background stall was reported
    // in the HUD as 8 dropped ticks instead of 11,520.
    engine.frame(delta)
  }, -1)
  return null
}
