import type { Node } from 'three/webgpu'
import {
  mrt,
  nodeObject,
  output,
  positionView,
  vec4,
  velocity,
} from 'three/tsl'

/** Two half-float attachments: radiance and velocity.xy / reciprocal view metres. */
export function sensorMrt() {
  return mrt({
    output,
    motion: vec4(
      nodeObject(velocity) as unknown as Node<'vec2'>,
      positionView.z.negate().max(1e-4).reciprocal(),
      1,
    ),
  })
}
