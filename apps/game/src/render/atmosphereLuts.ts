import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  type Texture,
} from 'three/webgpu'
import { getLogger, getTimer } from '@inertialref/shared'
import { timingDetailed } from '../engine/browserTiming.ts'
import { BOOT_PHASE } from '../engine/frameTiming.ts'
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
const timer = getTimer('game.atmosphere')

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
  const finished = performance.now()
  /*
   * A ~50 ms synchronous bake, on the main thread. One label, and the
   * atmosphere it was for rides as a property.
   *
   * The label was `bake ${key}`, on the argument that the cache bounds the set.
   * It does not bound it usefully: `scatteringKey` is a colon-joined composite
   * of six floats, a thickness and `topRatio.toFixed(6)`, the cache is a module
   * `Map` with no eviction, and Sol alone produces **nine** distinct keys — so
   * the set is every atmosphere the session has ever met, growing as it travels,
   * with each name retained for the life of the page. That is one aggregation
   * bucket per atmosphere in `ir.profile`, a `clearEmitted` loop that only
   * grows, and 44 characters of float in a flame chart.
   *
   * `regionDetail` in `packages/workers/src/host.ts` makes exactly this trade
   * for exactly this reason, and this file made the opposite one four files
   * away. A cache *hit* returns above without an entry, which stays the honest
   * picture: nothing was baked.
   */
  if (timer.on)
    timer.measure(
      'bake atmosphere',
      started,
      finished,
      timingDetailed()
        ? { ...BOOT_PHASE, properties: [['key', key]] }
        : BOOT_PHASE,
    )
  log.info('scattering tables baked', {
    ms: Math.round(finished - started),
    topRatio: Number(topRatio.toFixed(4)),
    thickness,
  })
  return set
}
