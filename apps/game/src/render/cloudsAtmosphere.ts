import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import type { Renderer } from 'three/webgpu'

/**
 * The port defers freeing its tables until the idle-sliced bake settles. A
 * canvas rebuild can release the device in the meantime, so end the bake's
 * iterator at the next slice after this context is disposed. The port's own
 * `finally` still releases its compute context and drains its disposal.
 */
export function createCloudsAtmosphere(): AtmosphereContext {
  const atmosphere = new AtmosphereContext()
  const lut = atmosphere.lutNode
  let retired = false
  const dispose = lut.dispose.bind(lut)
  lut.dispose = () => {
    retired = true
    dispose()
  }

  // fork.7 has no cancellation input. Its compiled LUT node keeps this
  // method on the instance's prototype and advances it once per idle callback.
  const bake = lut as unknown as {
    performCompute(renderer: Renderer, context: unknown): Iterable<boolean>
  }
  const slices = bake.performCompute.bind(lut)
  bake.performCompute = function* (renderer, context) {
    const steps = slices(renderer, context)[Symbol.iterator]()
    while (!retired) {
      const step = steps.next()
      if (step.done) return
      yield step.value
    }
  }
  return atmosphere
}
