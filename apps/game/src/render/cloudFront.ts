import type { Node } from 'three/webgpu'
import { float, textureLoad, vec3 } from 'three/tsl'
import { screenTexel } from './cloudGeometry.ts'
import type { CloudTraceTextures } from './cloudTrace.ts'
import type { CloudUniforms } from './cloudUniforms.ts'

/*
 * What a transparent object at `distance` along its own pixel's ray sees of
 * the clouds in front of it, from the trace's four knots: the transmittance
 * and the light of every layer nearer than it, linear inside a layer it
 * stands in (§5.12). Span-relative: the air in front of the span is the
 * object's own material's.
 *
 * Neutral here: nothing in front, read through the knots' two textures, the
 * bindings the real lookup has.
 */
export function cloudFront(
  trace: () => CloudTraceTextures,
  uniforms: CloudUniforms,
  screen: Node<'vec2'>,
  _distance: Node<'float'>,
): { readonly transmittance: Node<'float'>; readonly light: Node<'vec3'> } {
  const { knotDepth, knotLight } = trace()
  const texel = screenTexel(screen, uniforms.trace.size)
  const reads = textureLoad(knotDepth, texel)
    .x.add(textureLoad(knotLight, texel).x)
    .mul(0)
  return { transmittance: float(1).add(reads), light: vec3(0) }
}
