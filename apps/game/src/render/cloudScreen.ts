import type { Node } from 'three/webgpu'
import { clamp, float, floor, ivec2, vec2 } from 'three/tsl'

/**
 * The image point of trace texel `pixel`, row 0 at the top:
 * x = 2(i + ½ + jx)/W − 1, y = 1 − 2(j + ½ + jy)/H.
 *
 * `jitter` is an offset from the texel's center, in [−½, ½)²; (0, 0) is the
 * center. Every reader of a trace, history or depth texel goes through this
 * and `screenTexel`, so none of them flips: a compute pass has no quad to put
 * `v = 0` at the top for it.
 */
export function traceScreen(
  pixel: Node<'uvec2'>,
  jitter: Node<'vec2'>,
  extent: Node<'vec2'>,
): Node<'vec2'> {
  const point = vec2(pixel).add(0.5).add(jitter)
  return vec2(
    point.x.mul(2).div(extent.x).sub(1),
    float(1).sub(point.y.mul(2).div(extent.y)),
  )
}

/** An image point → the integer texel of a texture of `extent`, row 0 at the top. */
export function screenTexel(
  screen: Node<'vec2'>,
  extent: Node<'vec2'>,
): Node<'ivec2'> {
  const x = screen.x.add(1).mul(0.5).mul(extent.x)
  const y = float(1).sub(screen.y).mul(0.5).mul(extent.y)
  return ivec2(
    vec2(
      clamp(floor(x), 0, extent.x.sub(1)),
      clamp(floor(y), 0, extent.y.sub(1)),
    ),
  )
}
