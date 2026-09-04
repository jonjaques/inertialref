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
import type { WorkerPool } from '@inertialref/workers'
import { bakeAtmosphereTask } from './atmosphereTask.ts'
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
 * Baking is lazy, on the first ask for a body's shell, and it runs in one of
 * two places. On the pool, through `render.bakeAtmosphere` — `warmScattering`
 * and `scatteringVia` — for a page that has one, where this thread pays only
 * the half-float conversion and the upload. On this thread — `scatteringFor`
 * — for the boot prebake behind the overlay and for a page with no pool.
 * 20–40 ms of CPU either way, at most once per haze per session; the
 * difference is whether a frame pays it, which for a haze first met on an
 * arrival was 39.7 ms inside a 43.3 ms frame. ADR-0028.
 */

const log = getLogger('game.atmosphere')
const timer = getTimer('game.atmosphere')

export interface AtmosphereScattering {
  readonly recipe: AtmosphereRecipe
  readonly transmittance: Texture
  readonly multiScatter: Texture
}

const cache = new Map<string, AtmosphereScattering>()
/** Bakes in flight on the pool, so two asks for one key submit one job. */
const pending = new Map<string, Promise<AtmosphereScattering>>()

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

/**
 * The tables for one body's haze, baked on the pool.
 *
 * The same recipe and the same two tables `scatteringFor` makes, made by
 * `render.bakeAtmosphere` on a worker and converted and uploaded here, where
 * the GPU is. Cached under the same key, so whichever of the two paths fills
 * the cache first wins and the other reads it: a shell drawn before the
 * worker answers may bake on this thread as before, and the worker's copy is
 * then dropped rather than bound over the set the material already holds.
 */
export function warmScattering(
  pool: WorkerPool,
  haze: HazeAuthoring,
  topRatio: number,
): Promise<AtmosphereScattering> {
  const key = scatteringKey(haze, topRatio)
  const cached = cache.get(key)
  if (cached !== undefined) return Promise.resolve(cached)
  const inFlight = pending.get(key)
  if (inFlight !== undefined) return inFlight

  const started = performance.now()
  const job = pool
    .submit(bakeAtmosphereTask, { haze, topRatio })
    .result.then((baked) => {
      const raced = cache.get(key)
      if (raced !== undefined) return raced
      const set: AtmosphereScattering = {
        recipe: baked.recipe,
        transmittance: toTexture(baked.transmittance),
        multiScatter: toTexture(baked.multiScatter),
      }
      cache.set(key, set)
      log.info('scattering tables baked on the pool', {
        ms: Math.round(performance.now() - started),
        topRatio: Number(topRatio.toFixed(4)),
        thickness: haze.thickness,
      })
      return set
    })
    .finally(() => pending.delete(key))
  pending.set(key, job)
  return job
}

/**
 * The tables if they are cached, else `null` with a bake submitted to the
 * pool — the draw-time ask for a page that has one.
 *
 * A shell asks every frame it is drawn, so `null` costs it the haze for the
 * frames the bake is in flight and nothing else: the material keeps its
 * stand-ins, which draw a vacuum, and binds the tables on the frame they
 * land. The alternative is the bake inside this frame.
 */
export function scatteringVia(
  pool: WorkerPool,
  haze: HazeAuthoring,
  topRatio: number,
): AtmosphereScattering | null {
  const cached = cache.get(scatteringKey(haze, topRatio))
  if (cached !== undefined) return cached
  void warmScattering(pool, haze, topRatio).catch(() => {
    // The one rejection is a pool that has gone away — a dispose during a
    // reload. The next frame asks again, and a session that ends has no
    // frame to draw the haze in anyway.
  })
  return null
}
