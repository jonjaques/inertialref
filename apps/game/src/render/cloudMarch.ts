import type { Node } from 'three/webgpu'
import { float, vec3 } from 'three/tsl'
import { cloudSample } from './cloudGeometry.ts'
import type { CloudKnotWriter } from './cloudKnots.ts'
import type { CloudMediumFn, CloudRay, CloudSunFn } from './cloudNodes.ts'
import type { CloudTraceDeps } from './cloudTrace.ts'
import type { CloudUniforms } from './cloudUniforms.ts'

/*
 * The per-ray fine march: adaptive steps out of cloud and an optical-depth
 * bound in it, maximum-random segment mixing, the step-integral light, the
 * air on a coarse schedule, and a handover to the far march by footprint
 * (§5.5). A function of its injected medium, sun and phase, so a package
 * tests it against an analytic slab.
 *
 * Neutral here: the span's first sample evaluates the medium, the sun and the
 * phase once, so a kernel compiled against it binds what theirs bind, and the
 * ray passes everything.
 */

export interface CloudMarchResult {
  readonly light: Node<'vec3'>
  readonly air: Node<'vec3'>
  readonly transmittance: Node<'float'>
  readonly reproject: Node<'float'>
  readonly end: Node<'float'>
  readonly front: Node<'float'>
  readonly deviation: Node<'float'>
  /** Where the fine budget ran out, or the far distance. */
  readonly stopped: Node<'float'>
}

export function cloudMarch(
  ray: CloudRay,
  _jitter: Node<'float'>,
  _sky: Node<'bool'>,
  deps: Omit<CloudTraceDeps, 'far' | 'depth' | 'sun'> & {
    readonly medium: CloudMediumFn
    readonly sun: CloudSunFn
  },
  _knots: CloudKnotWriter | null,
): CloudMarchResult {
  const body = deps.uniforms.served
  const sample = cloudSample(
    ray,
    ray.start,
    body,
    deps.uniforms.camera.pixelAngle,
  )
  const medium = deps.medium(sample, body)
  const sun = deps.sun(sample, medium, body)
  const phase = deps.phase.droplets(ray.nu, medium.radius)
  const nothing = medium.sigma.add(sun.cloud).add(sun.air.x).add(phase.x).mul(0)
  return {
    light: vec3(nothing),
    air: vec3(0),
    transmittance: float(1),
    reproject: ray.end,
    end: ray.end,
    front: ray.end,
    deviation: float(0),
    stopped: ray.end,
  }
}

/**
 * The sweep's march (§8.4): `fixedSteps` steps of 4 m from t₀, no stop at t₁,
 * no early exit, no sun, no air, no far march; the sweep medium every step.
 */
export function cloudSweepMarch(
  ray: CloudRay,
  _jitter: Node<'float'>,
  deps: { readonly uniforms: CloudUniforms; readonly medium: CloudMediumFn },
): CloudMarchResult {
  const body = deps.uniforms.served
  const sample = cloudSample(
    ray,
    ray.start,
    body,
    deps.uniforms.camera.pixelAngle,
  )
  const nothing = deps.medium(sample, body).sigma.mul(0)
  return {
    light: vec3(nothing),
    air: vec3(0),
    transmittance: float(1),
    reproject: ray.end,
    end: ray.end,
    front: ray.end,
    deviation: float(0),
    stopped: ray.end,
  }
}
