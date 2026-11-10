import type { WebGPURenderer } from 'three/webgpu'
import { mieDroplets } from '@inertialref/rendering'
import { CloudClipmap } from './cloudClipmap.ts'
import {
  analyticMedium,
  fieldMedium,
  sweepMedium,
  synopticMedium,
} from './cloudDensity.ts'
import { type CloudFarField, createFarField } from './cloudFar.ts'
import type { CloudFrame } from './cloudFrame.ts'
import type { CloudSunDepth } from './cloudLevers.ts'
import { CloudMaps, writeScenarioPattern } from './cloudMaps.ts'
import type {
  CloudBudget,
  CloudMediumFn,
  CloudResource,
  CloudSunFn,
} from './cloudNodes.ts'
import { CloudNoise } from './cloudNoise.ts'
import { CloudPhase } from './cloudPhase.ts'
import { CloudProfile } from './cloudProfile.ts'
import { CloudSunCascades } from './cloudSunCascades.ts'
import { CloudSunGrid } from './cloudSunGrid.ts'
import { cloudSunFn } from './cloudSunlight.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { CloudVolume } from './cloudVolume.ts'

/*
 * The field and everything that reads it: the uniform bundle, the noise,
 * the profile, the maps and the clipmap, the four media, the volume, both
 * sun depths with the light through each, the droplets' phase and the far
 * fields, each built once and handed to every module that reads it. The
 * trace's 13 sampled bindings (15 with the volume) of WebGPU's 16 are counted
 * on shared nodes: a second medium built over the same textures is a second
 * set of bindings, and the volume's kernels would not compile.
 *
 * The cloud system builds its frame on one of these, and so does every
 * instrument that scores a choice on the field the frame draws
 * (`cloudFarCompare.gpu.test.ts`, `cloudSunAccuracy.gpu.test.ts`): one
 * construction, so the two cannot drift into two fields.
 */

export interface CloudField {
  readonly uniforms: CloudUniforms
  readonly noise: CloudNoise
  readonly profile: CloudProfile
  readonly maps: CloudMaps
  readonly clipmap: CloudClipmap
  /** The fine march's medium: the clipmap's coverage (§5.6). */
  readonly medium: CloudMediumFn
  readonly volume: CloudVolume
  readonly cascades: CloudSunCascades
  readonly grid: CloudSunGrid
  readonly phase: CloudPhase
  /** The light a cloud sample sees through each sun depth; the taps read the field's own textures. */
  readonly sun: Readonly<Record<CloudSunDepth, CloudSunFn>>
  /** The sweep's constant-work medium (§8.4). */
  readonly sweep: CloudMediumFn
  readonly farAtlas: CloudFarField
  readonly farSpheres: CloudFarField
  /** The second clouded body's atlas, baked from the analytic medium. */
  readonly farSecond: CloudFarField
  /** Every bake and cache, in the frame's order: §3.16's run up to the depth copy. */
  readonly bakes: readonly CloudResource[]
  /** The frame's numbers on everything the field's passes read, before any of them draws. */
  write(frame: CloudFrame): void
  /** This frame's share of every bake and cache, in order. */
  render(renderer: WebGPURenderer, frame: CloudFrame, budget: CloudBudget): void
  dispose(): void
}

export function createCloudField(): CloudField {
  const uniforms = createCloudUniforms()
  const noise = new CloudNoise()
  const profile = new CloudProfile()
  const maps = new CloudMaps(uniforms)
  const clipmap = new CloudClipmap(uniforms, maps.nodes)
  const recipe = { uniforms, noise: noise.nodes, profile }
  const medium = fieldMedium({ ...recipe, clipmap: clipmap.nodes })
  const volume = new CloudVolume({
    uniforms,
    bake: medium,
    detail: noise.nodes,
  })
  const cascades = new CloudSunCascades(uniforms, medium)
  const grid = new CloudSunGrid(uniforms, volume)
  const phase = new CloudPhase(mieDroplets())
  const synoptic = synopticMedium({ ...recipe, maps: maps.nodes })
  const farAtlas = createFarField('atlas', {
    uniforms,
    field: synoptic,
    phase,
    body: 'served',
  })
  const farSpheres = createFarField('spheres', {
    uniforms,
    field: synoptic,
    phase,
    body: 'served',
  })
  const farSecond = createFarField('atlas', {
    uniforms,
    field: analyticMedium(recipe),
    phase,
    body: 'second',
  })
  const caches = [noise, maps, clipmap, volume, cascades, grid] as const
  const fars = [farAtlas, farSpheres, farSecond] as const
  const bakes = [...caches, phase, ...fars] as const
  return {
    uniforms,
    noise,
    profile,
    maps,
    clipmap,
    medium,
    volume,
    cascades,
    grid,
    phase,
    sun: {
      cascades: cloudSunFn({ uniforms, medium, depth: cascades }),
      grid: cloudSunFn({ uniforms, medium, depth: grid }),
    },
    sweep: sweepMedium({ ...recipe, clipmap: clipmap.nodes }),
    farAtlas,
    farSpheres,
    farSecond,
    bakes,
    write(frame) {
      uniforms.write(frame)
      // The pattern every scenarioCoverageNode reads, before any pass of the
      // frame: the maps write it too, but the second body's far bake reads it
      // through the analytic medium whatever the maps did.
      writeScenarioPattern(uniforms, frame.scenario)
    },
    render(renderer, frame, budget) {
      for (const resource of caches) resource.render(renderer, frame, budget)
      for (const far of fars) far.render(renderer, frame, budget)
    },
    dispose() {
      for (const bake of bakes) bake.dispose()
      profile.dispose()
      uniforms.dispose()
    },
  }
}
