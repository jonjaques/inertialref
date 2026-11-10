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
import { Vec, type Vec3 } from '@inertialref/spatial'
import { timingDetailed } from '../engine/browserTiming.ts'
import { BOOT_PHASE } from '../engine/frameTiming.ts'
import {
  type AirHeights,
  type AtmosphereRecipe,
  atmosphereRecipe,
  bakeMultipleScattering,
  bakeTransmittance,
  type HazeAuthoring,
  type ScatteringLut,
  zenithSkyRadiance,
  type RenderBody,
} from '@inertialref/rendering'
import type { WorkerPool } from '@inertialref/workers'
import {
  type AirTableName,
  type AirTableSet,
  bakeAirTables,
  bakeAtmosphereTask,
  type BakeAtmosphereRequest,
  type BakeAtmosphereResponse,
} from './atmosphereTask.ts'
import { scatteringKey } from './preloadPlan.ts'
import type { Rgb } from './bodyUniforms.ts'

/*
 * The scattering tables, as GPU textures, cached per atmosphere.
 *
 * The bake lives in `@inertialref/rendering` where it is pure arrays and
 * testable; this module is only the wrapping — half-float, because WebGPU
 * guarantees `rgba16float` is filterable and guarantees nothing of the sort
 * for `rgba32float` — and the cache, keyed on everything the recipe reads,
 * so two bodies with the same authored haze and shell share one bake.
 *
 * The set is the transmittance and Ψ, which every surface in the air
 * marches through, and the sky table where it is wanted, which only the
 * clouds read (`bakeSkyMoments`). It is wanted on a page that built the
 * cloud system (`scatteringOf`), and on no other: there nothing reads it,
 * and it would cost about 1.2 times the other two tables' bake and 13 KB a
 * haze for nothing. A haze baked without it and later wanted with it takes
 * it as a job of its own under the same key (`skyFor`, `warmSky`), and the
 * set it lands in is a new object, so the cloud's `air.bind`, which binds
 * on a change of set, binds it on the frame it lands.
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
  /**
   * The sky's light on a cloud (`bakeSkyMoments`), 102 × 16 RGBA16F,
   * 13,056 B: what `AirUniforms.sky` binds through `bind`, which reads this
   * set as `AirTables`. Only the cloud passes read it, so the shell, the
   * sphere, the ground and the sea that bind the same set compile no
   * binding for it. Absent where no ask wanted it (`ScatteringWants`), and
   * the bundle then binds the dark stand-in in its place.
   */
  readonly sky?: Texture
  /**
   * The multiple-scattering table's own floats — ln Ψ — kept for
   * `airOverhead`. 8 KB a haze; the transmittance table is 64 times that and
   * is not kept, because a column straight up is cheaper to march than to
   * look up.
   */
  readonly multiScatterTable: ScatteringLut
}

/** What an ask wants of a bake beyond the air's own two tables. */
export interface ScatteringWants {
  /** The sky table, which only the clouds read. */
  readonly sky?: boolean
}

const NOTHING_MORE: ScatteringWants = {}

function wantedOf(wants: ScatteringWants): readonly AirTableName[] {
  return wants.sky === true ? ['sky'] : []
}

const cache = new Map<string, AtmosphereScattering>()
/** Bakes in flight on the pool, so two asks for one key submit one job. */
const pending = new Map<string, Promise<AtmosphereScattering>>()
/** Sky tables in flight on the pool for a haze already cached without one. */
const pendingSky = new Map<string, Promise<AtmosphereScattering>>()

/**
 * `set` with the derived tables `tables` holds, as a new object when there
 * are any, so a reader comparing sets sees the change; `set` itself when
 * there are none.
 */
function withTables(
  set: AtmosphereScattering,
  tables: AirTableSet,
): AtmosphereScattering {
  return tables.sky === undefined ? set : { ...set, sky: toTexture(tables.sky) }
}

/** What the bakes have made: tables, and the bytes their textures hold. */
export function scatteringCensus(): {
  readonly hazes: number
  readonly skies: number
  readonly skyBytes: number
} {
  let skies = 0
  let skyBytes = 0
  for (const set of cache.values()) {
    if (set.sky === undefined) continue
    skies += 1
    const image = set.sky.image as { readonly data: Uint16Array }
    skyBytes += image.data.byteLength
  }
  return { hazes: cache.size, skies, skyBytes }
}

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

/**
 * The tables for one body's haze, baking them on the first ask, and the sky
 * table on the first ask that wants it.
 */
export function scatteringFor(
  haze: HazeAuthoring,
  topRatio: number,
  heights: AirHeights,
  wants: ScatteringWants = NOTHING_MORE,
): AtmosphereScattering {
  const { thickness } = haze
  // The key lives in `preloadPlan.ts` so the boot prebake and this cache
  // cannot disagree about what "the same atmosphere" means.
  const key = scatteringKey(haze, topRatio, heights)
  const cached = cache.get(key)
  if (cached !== undefined)
    return wants.sky === true && cached.sky === undefined
      ? skyFor(key, cached)
      : cached

  const started = performance.now()
  const recipe = atmosphereRecipe(haze, topRatio, heights)
  const transmittance = bakeTransmittance(recipe)
  const multiScatter = bakeMultipleScattering(recipe, transmittance)
  // The derived tables' own share, read from one more clock read: the sky
  // table is new to this bake and its cost is a figure the design leaves to
  // measure.
  const airBaked = performance.now()
  const tables = bakeAirTables(
    recipe,
    transmittance,
    multiScatter,
    wantedOf(wants),
  )
  const skyBaked = performance.now()
  const set = withTables(
    {
      recipe,
      transmittance: toTexture(transmittance),
      multiScatter: toTexture(multiScatter),
      multiScatterTable: multiScatter,
    },
    tables,
  )
  cache.set(key, set)
  const finished = performance.now()
  /*
   * A ~50 ms synchronous bake, on the main thread. One label, and the
   * atmosphere it was for rides as a property.
   *
   * The label was `bake ${key}`, on the argument that the cache bounds the set.
   * It does not bound it usefully: `scatteringKey` is a colon-joined composite
   * of six floats, a thickness, `topRatio.toFixed(6)` and the two scale
   * heights, the cache is a module
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
    skyMs: Math.round(skyBaked - airBaked),
    topRatio: Number(topRatio.toFixed(4)),
    thickness,
  })
  return set
}

/**
 * The sky table for a haze cached without one, on this thread. Ψ's floats
 * are kept and the transmittance's are not, so the transmittance is marched
 * again: deterministic, so the table is the one a whole bake would have
 * made.
 */
function skyFor(
  key: string,
  cached: AtmosphereScattering,
): AtmosphereScattering {
  const started = performance.now()
  const transmittance = bakeTransmittance(cached.recipe)
  const set = withTables(
    cached,
    bakeAirTables(cached.recipe, transmittance, cached.multiScatterTable, [
      'sky',
    ]),
  )
  cache.set(key, set)
  log.info('sky table baked', { ms: Math.round(performance.now() - started) })
  return set
}

/**
 * The sky table for a haze cached without one, on the pool: the whole bake
 * asked again with the sky wanted, of which the sky alone is kept, since
 * the task has no form that takes the air's tables in. Dropped if the set
 * has gained a sky by the time it lands, by either path.
 */
function warmSky(
  pool: WorkerPool,
  request: Omit<BakeAtmosphereRequest, 'wanted'>,
  key: string,
): Promise<AtmosphereScattering> {
  const inFlight = pendingSky.get(key)
  if (inFlight !== undefined) return inFlight
  let job: Promise<AtmosphereScattering>
  try {
    job = pool
      .submit(bakeAtmosphereTask, { ...request, wanted: ['sky'] })
      .result.then((baked) => {
        const current = cache.get(key)
        // The set is cached before a sky is ever asked of it, and nothing
        // evicts it, so `current` is there; a sky it already has stands.
        if (current === undefined || current.sky !== undefined)
          return current ?? fromBake(baked)
        const set = withTables(current, baked.tables)
        cache.set(key, set)
        return set
      })
      .finally(() => pendingSky.delete(key))
  } catch (cause: unknown) {
    return Promise.reject(
      cause instanceof Error ? cause : new Error(String(cause)),
    )
  }
  pendingSky.set(key, job)
  return job
}

/** A pool's answer as a set, its derived tables included. */
function fromBake(baked: BakeAtmosphereResponse): AtmosphereScattering {
  return withTables(
    {
      recipe: baked.recipe,
      transmittance: toTexture(baked.transmittance),
      multiScatter: toTexture(baked.multiScatter),
      multiScatterTable: baked.multiScatter,
    },
    baked.tables,
  )
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
  heights: AirHeights,
  wants: ScatteringWants = NOTHING_MORE,
): Promise<AtmosphereScattering> {
  const key = scatteringKey(haze, topRatio, heights)
  const cached = cache.get(key)
  if (cached !== undefined)
    return wants.sky === true && cached.sky === undefined
      ? warmSky(pool, { haze, topRatio, heights }, key)
      : Promise.resolve(cached)
  const inFlight = pending.get(key)
  if (inFlight !== undefined) return inFlight

  const started = performance.now()
  /*
   * The `try` is around `submit` and nothing else, and it is not decoration:
   * a terminated pool is an `invariant` inside `WorkerPool.submit`, so it
   * *throws* where every caller here hangs a `.catch` on the promise. A
   * synchronous throw walks straight past that and out of whatever asked —
   * a frame callback in `Bodies.tsx`, the interval in `preload.ts`. Handing
   * back a rejected promise makes the failure the shape both callers already
   * handle. `submit` stays inside the expression rather than behind a
   * microtask so the bake keeps its place in the queue ahead of the tiles a
   * later frame asks for.
   */
  let job: Promise<AtmosphereScattering>
  try {
    job = pool
      .submit(bakeAtmosphereTask, {
        haze,
        topRatio,
        heights,
        wanted: wantedOf(wants),
      })
      .result.then((baked) => {
        const raced = cache.get(key)
        if (raced !== undefined) {
          // The set this thread baked stands, as every material holds it;
          // a sky the answer carries and it lacks joins it.
          if (raced.sky !== undefined || baked.tables.sky === undefined)
            return raced
          const joined = withTables(raced, baked.tables)
          cache.set(key, joined)
          return joined
        }
        const set = fromBake(baked)
        cache.set(key, set)
        log.info('scattering tables baked on the pool', {
          ms: Math.round(performance.now() - started),
          topRatio: Number(topRatio.toFixed(4)),
          thickness: haze.thickness,
        })
        return set
      })
      .finally(() => pending.delete(key))
  } catch (cause: unknown) {
    return Promise.reject(
      cause instanceof Error ? cause : new Error(String(cause)),
    )
  }
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
  heights: AirHeights,
  wants: ScatteringWants = NOTHING_MORE,
): AtmosphereScattering | null {
  const key = scatteringKey(haze, topRatio, heights)
  const cached = cache.get(key)
  if (cached !== undefined) {
    // The set without its sky until the sky lands: the cloud binds the
    // stand-in meanwhile, which draws no sky light, and everything else
    // never reads it.
    if (wants.sky === true && cached.sky === undefined)
      void warmSky(pool, { haze, topRatio, heights }, key).catch(() => {
        // As below: a pool gone away, and the next frame asks again.
      })
    return cached
  }
  void warmScattering(pool, haze, topRatio, heights, wants).catch(() => {
    // The one rejection is a pool that has gone away — a dispose during a
    // reload, which `warmScattering` turns into a rejection because `submit`
    // raises it as a throw. The next frame asks again, and a session that
    // ends has no frame to draw the haze in anyway.
  })
  return null
}

/** Where an eye stands in one body's air, in the tables' own units. */
export interface Standing {
  /** Radius from the body's center over sea level, which is 1; never under it. */
  readonly radius: number
  /** Unit render-space vector from the center through the eye. */
  readonly up: Vec3
}

/** The shell's render-space geometry, as `bodyUniforms` hands it over. */
export interface ShellGeometry {
  readonly innerRadius: number
  readonly outerRadius: number
  readonly seaLevel: number
  readonly flattening: number
}

/**
 * The eye the shell marches from, on the CPU: its radius over sea level in
 * the space the shell works in, which is stretched along the spin axis for
 * a giant's oblate shell and is the geometry for a round one. Clamped at sea
 * level, because the air under the datum — over a sea that lies under it,
 * in a basin — is sea-level air. Null above the air, where there is no sky
 * overhead and nothing between the eye and a star.
 */
export function standingIn(
  shell: ShellGeometry,
  eye: Vec3,
  center: Vec3,
  spinAxis: Vec3,
): Standing | null {
  const relative = Vec.sub(eye, center)
  const distance = Vec.length(relative)
  if (distance === 0 || shell.seaLevel <= 0) return null
  const stretch = 1 / Math.max(shell.flattening, 1e-3) - 1
  const stretched = Vec.length(
    Vec.add(
      relative,
      Vec.scale(spinAxis, Vec.dot(relative, spinAxis) * stretch),
    ),
  )
  const radius = stretched / shell.seaLevel
  if (radius >= shell.outerRadius / shell.seaLevel) return null
  return {
    radius: Math.max(radius, 1),
    up: Vec.scale(relative, 1 / distance),
  }
}

/**
 * The luminance of the sky straight over a standing eye, in scene units.
 * Positions are render space, as the shell's own uniforms are.
 */
export function airOverhead(
  scattering: AtmosphereScattering,
  standing: Standing,
  sun: Vec3 | null,
  sunColor: Rgb,
): number {
  const [r, g, b] = airOverheadRgb(scattering, standing, sun, sunColor)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** The same zenith in color, the star's light in it; black with no sun. */
export function airOverheadRgb(
  scattering: AtmosphereScattering,
  standing: Standing,
  sun: Vec3 | null,
  sunColor: Rgb,
): readonly [number, number, number] {
  if (sun === null) return [0, 0, 0]
  const [r, g, b] = zenithSkyRadiance(
    scattering.recipe,
    scattering.multiScatterTable,
    standing.radius,
    Vec.dot(standing.up, sun),
  )
  return [r * sunColor.r, g * sunColor.g, b * sunColor.b]
}

/**
 * One body's tables: from the pool when there is one — null until that bake
 * lands, and the material draws a vacuum meanwhile, because a 40 ms bake
 * inside a frame is the largest single thing an arrival would pay — and
 * baked here when there is none. Cached after the first ask either way, so
 * the shell, the sphere, the ground and the sea asking every frame share
 * one bake; each ask still builds the key, so a caller drawing several of
 * them asks once. Null for a body with no haze.
 *
 * The sky table is wanted where the page built the cloud system, which the
 * engine says by holding `?clouds=1`'s factory (`cloudSystemFactory`, set
 * before anything that asks here is mounted, and for the page's lifetime).
 * A caller that knows better, a rig with no engine, says so in `wants`.
 */
export function scatteringOf(
  engine: {
    pool(): WorkerPool | null
    readonly cloudSystemFactory?: unknown
  },
  body: RenderBody,
  wants: ScatteringWants = {
    sky: (engine.cloudSystemFactory ?? null) !== null,
  },
): AtmosphereScattering | null {
  const haze = body.appearance.haze
  if (haze === null) return null
  const pool = engine.pool()
  return pool === null
    ? scatteringFor(haze, body.airTop, body.airHeights, wants)
    : scatteringVia(pool, haze, body.airTop, body.airHeights, wants)
}
