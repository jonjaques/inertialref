import type { WebGPURenderer } from 'three/webgpu'
import { type CloudClipmap, createCloudClipmap } from './cloudClipmap.ts'
import { createCloudMedia } from './cloudDensity.ts'
import { type CloudFarAtlas, createCloudFarAtlas } from './cloudFarAtlas.ts'
import type { CloudFrame } from './cloudFrame.ts'
import { type CloudJitter, createCloudJitter } from './cloudJitter.ts'
import { type CloudMaps, createCloudMaps } from './cloudMaps.ts'
import type {
  CloudBudget,
  CloudMediumFn,
  CloudResource,
  CloudSkyNodes,
  CloudSunFn,
} from './cloudNodes.ts'
import { type CloudNoise, createCloudNoise } from './cloudNoise.ts'
import { type CloudPhase, createCloudPhase } from './cloudPhase.ts'
import { type CloudProfile, createCloudProfile } from './cloudProfile.ts'
import { createCloudSky } from './cloudSky.ts'
import { type CloudSource, createCloudSource } from './cloudSource.ts'
import { type CloudSunGrid, createCloudSunGrid } from './cloudSunGrid.ts'
import { cloudSunFn } from './cloudSunlight.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { type CloudVolume, createCloudVolume } from './cloudVolume.ts'

/*
 * The field and everything that reads it: the uniform bundle, the noise,
 * the profile, the maps and the clipmap, the three media, the volume and the
 * sun grid summed through it with the light through that, the phase, the
 * sky, the higher orders' source, the jitter and the two far atlases, each
 * built once and handed to every module that reads it. The trace's 10
 * sampled bindings of WebGPU's 16 are counted on shared nodes: a second
 * medium built over the same textures is a second set of bindings.
 *
 * Each module is built by a factory in its own file, from the parts built
 * before it. The parts grow as the field does, and a factory is handed all
 * of them and names the ones it reads, so a module that comes to need
 * another part changes its own file and not this one.
 *
 * The cloud system builds its frame on one of these, and so does every
 * instrument that scores a part of it on the field the frame draws
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
  /** The field cached around the eye: what the sun grid sums through. */
  readonly volume: CloudVolume
  readonly grid: CloudSunGrid
  readonly phase: CloudPhase
  /** The sky's light at a sample, from a body's own table. */
  readonly sky: CloudSkyNodes
  /** The higher orders' source function. */
  readonly source: CloudSource
  /** What a ray is jittered by. */
  readonly jitter: CloudJitter
  /** The light a cloud sample sees through the sun grid; the taps read the field's own textures. */
  readonly sun: CloudSunFn
  /** The served body's far atlas, baked from the cube's coverage. */
  readonly farAtlas: CloudFarAtlas
  /** The second clouded body's atlas, baked from the analytic medium. */
  readonly farSecond: CloudFarAtlas
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
  const bundle = { uniforms }
  const noise = createCloudNoise(bundle)
  const profile = createCloudProfile(bundle)
  const maps = createCloudMaps(bundle)
  const sources = { ...bundle, noise, profile, maps }
  const clipmap = createCloudClipmap(sources)
  const media = createCloudMedia({ ...sources, clipmap })
  const medium = media.field
  const recipe = { ...sources, clipmap, media, medium }
  const volume = createCloudVolume(recipe)
  const grid = createCloudSunGrid({ ...recipe, volume })
  const sky = createCloudSky()
  const source = createCloudSource()
  const jitter = createCloudJitter(recipe)
  const phase = createCloudPhase(recipe)
  const light = { ...recipe, volume, grid, sky, source, jitter, phase }
  const farAtlas = createCloudFarAtlas(light, 'served')
  const farSecond = createCloudFarAtlas(light, 'second')
  const caches = [noise, maps, clipmap, volume, grid] as const
  const tables = [phase, source, jitter] as const
  const fars = [farAtlas, farSecond] as const
  const bakes = [...caches, ...tables, ...fars] as const
  return {
    uniforms,
    noise,
    profile,
    maps,
    clipmap,
    medium,
    volume,
    grid,
    phase,
    sky,
    source,
    jitter,
    sun: cloudSunFn({ uniforms, medium, depth: grid }),
    farAtlas,
    farSecond,
    bakes,
    write(frame) {
      uniforms.write(frame)
      // The pattern every coverage node reads, before any pass of the
      // frame: the second body's far bake reads it through the analytic
      // medium whatever the maps drew.
      maps.write(frame)
    },
    render(renderer, frame, budget) {
      for (const resource of caches) resource.render(renderer, frame, budget)
      for (const far of fars) far.render(renderer, frame)
    },
    dispose() {
      for (const bake of bakes) bake.dispose()
      profile.dispose()
      uniforms.dispose()
    },
  }
}
