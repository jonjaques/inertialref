import type { Node } from 'three/webgpu'
import { float, vec3 } from 'three/tsl'
import {
  type AirUniforms,
  airMediumAt,
  type Marched,
  phasesToward,
  sunTableAt,
} from './air.ts'

/*
 * The air a composite pixel already carries, split at the cloud span's start
 * (§5.11). The class is the shell's own depth test — sky where the scene's
 * depth lies at or past the air's outer far wall — and each class reproduces
 * its own air: the shell's twelve crowded samples unclear, or `airToward`'s
 * four with the beam cleared from orbit. Built from `airMediumAt` reading at
 * level 0, because the class is chosen per pixel and the marches therefore
 * sit in non-uniform control flow.
 *
 * Neutral here: every pixel sky, no air in front of a cloud, read through
 * both of the air's tables at level 0 as the real marches will.
 */

export interface CompositeAir {
  /** The shell's own depth test: D at or past the air's outer far wall. */
  readonly sky: Node<'bool'>
  /** L_a(0, t₀), T_a(0, t₀): physical throughput, the beam cleared as the class's. */
  readonly toStart: Marched
  /** L_a(0, min(t₁, D)) built from the two segments. */
  readonly toEnd: Node<'vec3'>
  /** T'_a(0, t₀): what the cloud's own light is dimmed by (cleared on surfaces under Enhanced from orbit). */
  readonly seen: Node<'vec3'>
}

/** The class test alone, which the trace calls for its own texel too (§5.11). */
export function skyClass(
  _air: AirUniforms,
  _eye: Node<'vec3'>,
  _direction: Node<'vec3'>,
  depth: Node<'float'>,
  _units: Node<'float'>,
): Node<'bool'> {
  return depth.greaterThanEqual(0)
}

export function compositeAir(
  air: AirUniforms,
  eye: Node<'vec3'>,
  direction: Node<'vec3'>,
  _t0: Node<'float'>,
  _t1: Node<'float'>,
  depth: Node<'float'>,
  sun: Node<'vec3'>,
  _cleared: Node<'float'>,
  units: Node<'float'>,
): CompositeAir {
  const beam = sunTableAt(air, float(1), float(0), { level: true })
  const medium = airMediumAt(
    air,
    float(0),
    float(1),
    phasesToward(direction, sun),
    beam,
    { level: true },
  )
  const reads = medium.multiple.add(beam).mul(0)
  return {
    sky: skyClass(air, eye, direction, depth, units),
    toStart: { inscatter: reads, transmittance: vec3(1) },
    toEnd: vec3(0),
    seen: vec3(1),
  }
}
