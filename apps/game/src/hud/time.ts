import type { GameEngine } from '../engine/GameEngine.ts'
import { nextWarp } from './warp.ts'

/*
 * The time controls, written once.
 *
 * Every pause, warp and return to real time in the game — the keys, the
 * dock's transport, the planetarium's time panel, a walker stepping out —
 * goes through `timeCommands`, and this is the one file in `apps/game/src`
 * that sets the world clock's rate or pause (`time.test.ts` holds that). A
 * second writer is a button that changes the clock without the notice the
 * same key gives. The guide's executor turns the observatory's own clock,
 * which is presentation and is not this one.
 */

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

export interface TimeCommands {
  readonly togglePause: () => void
  readonly warp: (direction: number) => void
  /**
   * Back to one second per second, in one press.
   *
   * Not `warp(-1)` repeated: the ladder is seven rungs, so leaving 100,000×
   * costs six presses and six notices.
   */
  readonly realTime: () => void
  /**
   * The world clock at 1× and running, for a walker that has just stepped
   * out: the walk is tuned for real time, and under warp a walker covers
   * kilometers a frame. The world's clock rather than the picture's, because
   * the walker is the world's. Says so only when it changed something.
   */
  readonly walkingPace: () => void
}

/** The commands, saying what each did through `say`. */
export function timeCommands(
  engine: Pick<GameEngine, 'harness' | 'world'>,
  say: (message: string) => void,
): TimeCommands {
  return {
    togglePause: () => {
      const clock = presentationClock(engine)
      const paused = !clock.paused
      clock.setPaused(paused)
      say(paused ? 'paused' : 'running')
    },
    warp: (direction) => {
      const clock = presentationClock(engine)
      const next = nextWarp(clock.timeScale, direction)
      clock.setTimeScale(next)
      say(`time warp ${next}×`)
    },
    realTime: () => {
      presentationClock(engine).setTimeScale(1)
      say('time warp 1×')
    },
    walkingPace: () => {
      const clock = engine.world.clock
      if (clock.timeScale === 1 && !clock.paused) return
      clock.setTimeScale(1)
      clock.setPaused(false)
      say('real time, on foot')
    },
  }
}
