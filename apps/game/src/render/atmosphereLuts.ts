import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  type Texture,
} from 'three/webgpu'
import { getLogger } from '@inertialref/shared'
import {
  type AtmosphereRecipe,
  atmosphereRecipe,
  bakeMultipleScattering,
  bakeTransmittance,
  type HazeAuthoring,
  type ScatteringLut,
} from '@inertialref/rendering'
import { scatteringKey } from './preloadPlan.ts'

/*
 * The scattering tables, as GPU textures, cached per atmosphere.
 *
 * The bake lives in `@inertialref/rendering` where it is pure arrays and
 * testable; this module is only the wrapping — half-float, because WebGPU
 * guarantees `rgba16float` is filterable and guarantees nothing of the sort
 * for `rgba32float` — and the cache, keyed on everything the recipe reads,
 * so two bodies with the same authored haze and shell share one bake.
 *
 * Baking is lazy, on the first frame a body's shell is actually drawn:
 * ~50 ms of CPU, at most once per body per session, spent at the same moment
 * the surface maps start streaming in. A worker would hide even that; the
 * seam is this function's signature.
 */

const log = getLogger('game.atmosphere')

export interface AtmosphereScattering {
  readonly recipe: AtmosphereRecipe
  readonly transmittance: Texture
  readonly multiScatter: Texture
}

const cache = new Map<string, AtmosphereScattering>()

function toTexture(lut: ScatteringLut): DataTexture {
  const half = new Uint16Array(lut.data.length)
  for (let i = 0; i < lut.data.length; i += 1) {
    half[i] = DataUtils.toHalfFloat(lut.data[i] as number)
  }
  const map = new DataTexture(
    half,
    lut.width,
    lut.height,
    RGBAFormat,
    HalfFloatType,
  )
  map.magFilter = LinearFilter
  map.minFilter = LinearFilter
  map.wrapS = ClampToEdgeWrapping
  map.wrapT = ClampToEdgeWrapping
  map.generateMipmaps = false
  map.needsUpdate = true
  return map
}

/** The tables for one body's haze, baking them on the first ask. */
export function scatteringFor(
  haze: HazeAuthoring,
  topRatio: number,
): AtmosphereScattering {
  const { thickness } = haze
  // The key lives in `preloadPlan.ts` so the boot prebake and this cache
  // cannot disagree about what "the same atmosphere" means.
  const key = scatteringKey(haze, topRatio)
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const started = performance.now()
  const recipe = atmosphereRecipe(haze, topRatio)
  const transmittance = bakeTransmittance(recipe)
  const multiScatter = bakeMultipleScattering(recipe, transmittance)
  const set: AtmosphereScattering = {
    recipe,
    transmittance: toTexture(transmittance),
    multiScatter: toTexture(multiScatter),
  }
  cache.set(key, set)
  log.info('scattering tables baked', {
    ms: Math.round(performance.now() - started),
    topRatio: Number(topRatio.toFixed(4)),
    thickness,
  })
  return set
}
