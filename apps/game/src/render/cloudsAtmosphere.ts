import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import type { Renderer, StructNode, VarNode } from 'three/webgpu'

/**
 * The port defers freeing its tables until the idle-sliced bake settles. A
 * canvas rebuild can release the device in the meantime, so end the bake's
 * iterator at the next slice after this context is disposed. The port's own
 * `finally` still releases its compute context and drains its disposal.
 */
export function createCloudsAtmosphere(): AtmosphereContext {
  const atmosphere = new AtmosphereContext()
  // A laid-out function reads its parameter's type from the current shader
  // stage. The port uses this one constant in both vertex and fragment light.
  // Three runs the constant's setup once, so register its declared type each
  // time it is passed to a function. https://github.com/mrdoob/three.js/issues/34721
  const parameters = atmosphere.parametersNode as unknown as VarNode<
    'struct',
    StructNode
  >
  const build = parameters.build.bind(parameters)
  parameters.build = (builder, output) => {
    parameters.node.getNodeType(builder)
    return build(builder, output)
  }
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
