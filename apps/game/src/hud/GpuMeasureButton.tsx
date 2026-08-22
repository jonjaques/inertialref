import type { GameEngine } from '../engine/GameEngine.ts'
import { canMeasureGpu } from '../render/measure.ts'
import { Action } from './Action.tsx'

/**
 * Submit forty frames and time them across a drained queue.
 *
 * `Action`, rather than the hand-rolled button this used to be. Its classes
 * were byte-identical to `Action`'s normal tone, which is what made it
 * invisible drift: nothing looked wrong, and it simply did not receive the
 * 24 px target minimum when `Action` did. The shared control owns this
 * pattern, including `releaseFocus` and the disabled treatment.
 */
export function GpuMeasureButton({
  engine,
  busy,
  onMeasure,
}: {
  engine: GameEngine
  busy: boolean
  onMeasure: () => void
}) {
  // Reads `engine.gl`, which arrives after the first render. See `PerfPanel`.
  'use no memo'

  const gl = engine.gl
  const ready =
    gl !== null && engine.view !== null && canMeasureGpu(gl.renderer)
  return (
    <Action
      label={busy ? 'measuring…' : 'measure gpu'}
      title="Submit 40 frames and time them across a drained queue — the only measurement three's own timestamp does not exaggerate"
      disabled={!ready || busy}
      onClick={onMeasure}
    />
  )
}
