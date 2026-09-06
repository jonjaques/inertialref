import type { GameEngine } from '../engine/GameEngine.ts'

/** Buttons and keyboard commands act on the clock that supplies the picture. */
export function presentationClock(
  engine: Pick<GameEngine, 'harness' | 'world'>,
) {
  const observer = engine.harness.observatory
  if (observer.heldTime === null || engine.harness.cutsceneStatus() !== null)
    return engine.world.clock
  return {
    paused: observer.timePaused,
    timeScale: observer.timeScale,
    setPaused: (paused: boolean) => observer.setTimePaused(paused),
    setTimeScale: (scale: number) => observer.setTimeScale(scale),
  }
}
