import {
  cameraFar,
  cameraNear,
  cameraProjectionMatrixInverse,
  clipSpace,
  float,
  Fn,
  viewZToLogarithmicDepth,
} from 'three/tsl'

/** Far means zero in the WebGPU scene and one in the logarithmic fallback. */
export const sceneFarDepth = Fn((builder) =>
  float(builder.renderer.reversedDepthBuffer ? 0 : 1),
)()

/** Expanded line ribbons must use their emitted vertex, not the template origin. */
export const expandedLineDepth = Fn((builder) => {
  if (builder.renderer.logarithmicDepthBuffer) {
    const view = cameraProjectionMatrixInverse.mul(clipSpace)
    return viewZToLogarithmicDepth(view.z.div(view.w), cameraNear, cameraFar)
  }
  const projected = clipSpace.z.div(clipSpace.w)
  return builder.renderer.reversedDepthBuffer
    ? projected
    : projected.mul(0.5).add(0.5)
})()
