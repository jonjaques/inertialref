import type { Node } from 'three/webgpu'
import { float, int, vec2 } from 'three/tsl'
import type { CloudClipmapNodes } from './cloudClipmap.ts'
import type { CloudMapNodes } from './cloudMaps.ts'
import {
  CLOUD_VACUUM,
  type CloudMedium,
  type CloudMediumFn,
  type CloudSample,
} from './cloudNodes.ts'
import type { CloudNoiseNodes } from './cloudNoise.ts'
import type { CloudProfile } from './cloudProfile.ts'
import type { CloudBodyUniforms, CloudUniforms } from './cloudUniforms.ts'

/*
 * The placeholder's density: coverage × the genus's profile × eroded noise,
 * with the unresolved share of a cell carried as a fraction rather than a
 * mean density (§5.6). The three media below differ only in where the
 * coverage comes from — the clipmap near, the weather cube for the far
 * bakes, the analytic function for a second body — so the far field is the
 * same field at every distance.
 *
 * Neutral here: a vacuum, read through every node the real recipe reads, so
 * a kernel compiled against it binds the field's textures.
 */

export interface FieldMediumDeps {
  readonly uniforms: CloudUniforms
  readonly clipmap: CloudClipmapNodes
  readonly noise: CloudNoiseNodes
  readonly profile: CloudProfile
}

export interface SynopticMediumDeps {
  readonly uniforms: CloudUniforms
  readonly maps: CloudMapNodes
  readonly noise: CloudNoiseNodes
  readonly profile: CloudProfile
}

/** A vacuum whose extinction carries `reads`, which add nothing. */
function vacuumThrough(
  sample: CloudSample,
  body: CloudBodyUniforms,
  reads: Node<'float'>,
): CloudMedium {
  const vacuum = CLOUD_VACUUM(sample, body)
  return { ...vacuum, sigma: vacuum.sigma.add(reads.mul(0)) }
}

/** The noises and the profile a step of every medium reads. */
function noiseReads(
  noise: CloudNoiseNodes,
  profile: CloudProfile,
  sample: CloudSample,
): Node<'float'> {
  const cells = sample.offset
  return noise
    .base(cells)
    .add(noise.detail(cells))
    .add(noise.curl(vec2(cells.x, cells.z)).x)
    .add(profile.profile(float(0), sample.altitude))
}

/** The fine march's medium: the clipmap's coverage × profile × eroded noise (§5.6). */
export function fieldMedium(deps: FieldMediumDeps): CloudMediumFn {
  return (sample, body) =>
    vacuumThrough(
      sample,
      body,
      deps.clipmap
        .coverage(sample, body)
        .x.add(deps.clipmap.column(sample, body, int(0)).x)
        .add(noiseReads(deps.noise, deps.profile, sample)),
    )
}

/**
 * The same recipe with its coverage read from the weather cube: the whole
 * body, for the served body's far bakes, which reach the limb (1,830 km of
 * gnomonic plane on far-shore from 400 km, 2,290 km on Earth), past the
 * clipmap's ±1,024 km.
 */
export function synopticMedium(deps: SynopticMediumDeps): CloudMediumFn {
  return (sample, body) =>
    vacuumThrough(
      sample,
      body,
      deps.maps
        .synoptic(body.up)
        .x.add(noiseReads(deps.noise, deps.profile, sample)),
    )
}

/**
 * The same recipe with its coverage from `scenarioCoverageNode`: the second
 * body, which has no cube.
 */
export function analyticMedium(deps: {
  readonly uniforms: CloudUniforms
  readonly noise: CloudNoiseNodes
  readonly profile: CloudProfile
}): CloudMediumFn {
  return (sample, body) =>
    vacuumThrough(sample, body, noiseReads(deps.noise, deps.profile, sample))
}

/**
 * The sweep's medium (§8.4): `sweepReads` base-noise fetches at decorrelated
 * offsets, summed so none can be dropped, plus one read of `sweepExtra`'s
 * type.
 */
export function sweepMedium(deps: FieldMediumDeps): CloudMediumFn {
  return fieldMedium(deps)
}
