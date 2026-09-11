import { type RootState, useFrame } from '@react-three/fiber'
import { getTimer } from '@inertialref/shared'
import { framesHeld } from '../engine/frameHold.ts'
import { RENDER_PHASE } from '../engine/frameTiming.ts'
import { runGraphicsFrame } from '../runtimeFailure.ts'

/*
 * `useFrame`, with the callback's own time on the Render track.
 *
 * `frameMetrics.ts` states the boundary this exists to make visible:
 * *"everything the GPU does happens after this returns, and conflating the two
 * is how a renderer problem gets diagnosed as a simulation one."* The same
 * conflation runs the other way for scene components. Bodies, terrain, ships,
 * traces and optical effects all do main-thread work that `engineMs` excludes.
 * Each callback owns a span so the timeline can account for that work.
 * `EngineTick` is the Engine track and does not use this wrapper.
 *
 * A span rather than the `PhaseClock` used inside the engine, because these are
 * not adjacent: R3F interleaves them with its own work and each has to stand on
 * its own start. Off, this is one property read and a direct call — no closure
 * allocated, no clock read, and `NO_SPAN` never even reached.
 *
 * Every consumer goes through here, which is what makes `frameHold.ts` one
 * check rather than fourteen: a measurement that has taken the loop gets a
 * frame in which no consumer writes a uniform, hides a mesh or presents.
 */
const timer = getTimer('game.render')

export function useTimedFrame(
  name: string,
  callback: (state: RootState, delta: number) => void,
  priority = 0,
): void {
  useFrame((state, delta) => {
    if (framesHeld()) return
    if (!timer.on) {
      runGraphicsFrame(() => callback(state, delta))
      return
    }
    const started = performance.now()
    runGraphicsFrame(() => callback(state, delta))
    timer.measure(name, started, performance.now(), RENDER_PHASE)
  }, priority)
}
