import { CloudFarAtlas } from './cloudFarAtlas.ts'
import { CloudFarSpheres } from './cloudFarSpheres.ts'
import type { CloudFarKind } from './cloudLevers.ts'
import type {
  CloudFarFn,
  CloudMediumFn,
  CloudPhaseNodes,
  CloudResource,
} from './cloudNodes.ts'
import type { CloudUniforms } from './cloudUniforms.ts'

/*
 * The far field: the march past the handover, where a trace texel spans more
 * than `farFootprint` and the fine march's steps would be finer than the
 * picture. Two candidates, the layer atlas and the sphere caches, baked from
 * the same field the fine march reads; the second clouded body always takes
 * an atlas.
 *
 * This file selects. The arithmetic both candidates share lives in
 * `cloudFarAtlas.ts`, which the spheres import: this file constructs both, so
 * a value either of them read back from here would be an import cycle, and a
 * value read across a cycle at module scope throws on import (knip refuses
 * one, `knip.jsonc`). The constants are re-exported so the contract still
 * names them here.
 */

export { FAR_BLOCK, FAR_STEPS_A_LAYER } from './cloudFarAtlas.ts'

export interface CloudFarField extends CloudResource {
  /** The march past the handover, for the body these uniforms describe. Level-0 reads. */
  readonly far: CloudFarFn
}

export interface CloudFarDeps {
  readonly uniforms: CloudUniforms
  /**
   * What it bakes from: `synopticMedium` for the served body (the cube's
   * coverage, the whole body), `analyticMedium` for the second (§3.10).
   */
  readonly field: CloudMediumFn
  readonly phase: CloudPhaseNodes
  readonly body: 'served' | 'second'
}

export function createFarField(
  kind: CloudFarKind,
  deps: CloudFarDeps,
): CloudFarField {
  return kind === 'atlas' ? new CloudFarAtlas(deps) : new CloudFarSpheres(deps)
}
