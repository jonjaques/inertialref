import type { Node } from 'three/webgpu'

/*
 * What a transparent object between two layers needs of the trace: up to four
 * knots a ray, each a segment's entry and exit depth with the transmittance
 * and light so far at its exit (§5.12). The march records one at each
 * segment close whose transmittance falls under 0.98; past four, the fourth
 * absorbs the rest. `cloudFront` reads them directly, with no history between,
 * so they are written through `finiteOr`.
 */

export interface CloudKnotWriter {
  record(
    entry: Node<'float'>,
    exit: Node<'float'>,
    transmittance: Node<'float'>,
    light: Node<'vec3'>,
  ): void
  /**
   * Writes the four knots through `finiteOr`, so a NaN the history would have
   * caught cannot reach `cloudFront`, which reads the knots directly.
   */
  flush(texel: Node<'uvec2'>): void
}
