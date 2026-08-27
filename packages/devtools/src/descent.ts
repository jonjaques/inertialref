import type { Meters, Radians } from '@inertialref/shared'
import {
  type Body,
  formatAddress,
  generateHeightfield,
  geodeticDirection,
  HEIGHTFIELD_RESOLUTION,
  type RegionAddress,
  surfaceRadius,
  type SurveySite,
  surveySites,
} from '@inertialref/universe'
import {
  MIN_STANCE_HEIGHT,
  surfaceHeightBounds,
  terrainPatchKey,
  terrainWindow,
} from '@inertialref/rendering'

/*
 * A descent, as arithmetic.
 *
 * The plan's unit of measurement: fly a camera from orbit to two meters over a
 * named site and record what the terrain streamer is asked for on the way down.
 * It runs with no world, no worker pool, no renderer and no GPU, because
 * everything it needs is a `Body` and the selection rule — which is why
 * `terrainWindow` was pulled out of the streamer first. The same call therefore
 * runs in a browser console, in `pnpm sim`, and in a Node test, and all three
 * get the same numbers.
 *
 * What it is for is the phrase "no terrain perf baseline" in the plan's gap
 * table. The 1.0 ms terrain line in the frame budget has always been designed
 * rather than enforced, because the only way to ask what a descent costs was to
 * fly one by hand and watch a counter. Now it is a function that returns the
 * peak burst, the level churn and the cache behavior, and Phase 1's "no cracks
 * and no pops" has something to be a regression against.
 *
 * Two things it deliberately does not measure, so that nothing here overstates
 * what it knows. It does not measure *frame* cost — draw calls, the streamer's
 * per-frame placement pass and the geometry build all need the browser, and
 * `docs/agents/...` is explicit that a headless GPU check is not a real one. And
 * it does not run the worker pool: `measurePatchGeneration` times the same
 * function the worker calls, on the main thread, which is the generation cost
 * without the transfer or the queue. Both gaps are named in the report.
 */

/** Where a descent goes, and how it is flown. */
export interface DescentOptions {
  /** A `SurveySite` id. Ignored when `latitude`/`longitude` are given. */
  readonly site?: string
  readonly latitude?: Radians
  readonly longitude?: Radians
  /** Height above the ground at the top of the descent. Default: the arm's ceiling. */
  readonly fromHeight?: Meters
  /** Height at the bottom. Default: 2 m, where a person stands. */
  readonly toHeight?: Meters
  /** How many samples the profile is cut into. Default 128. */
  readonly steps?: number
  /**
   * Degrees of ground track flown off before touching down.
   *
   * A purely vertical drop is the one descent that understates the streamer:
   * the sub-camera point never moves, so the window slides only when the level
   * changes and the level-churn figure comes out flattering. Ten degrees is a
   * shallow approach — 1,100 km on an Earth-sized body — and it makes the
   * window traverse ground the way an arrival actually does.
   */
  readonly trackDegrees?: number
  /** The streamer's heightfield cache size. Default 64, which is today's. */
  readonly cacheSize?: number
}

export interface DescentStep {
  readonly index: number
  /** Above the ground below the camera, meters. */
  readonly height: Meters
  /** From the body's center, meters — what `terrainLevelFor` is given. */
  readonly distance: Meters
  readonly latitude: Radians
  readonly longitude: Radians
  readonly level: number
  readonly opacity: number
  /** Patches the window wants this step. */
  readonly wanted: number
  /** Patches that fell off the edge of a cube face and were dropped. */
  readonly clipped: number
  /** Of `wanted`, how many are not in the cache — the worker queue this step. */
  readonly requested: number
  /** Which ones. What `measurePatchGeneration` is handed to time the field. */
  readonly requestedRegions: readonly RegionAddress[]
}

export interface DescentReport {
  readonly body: string
  readonly site: string
  readonly steps: readonly DescentStep[]
  /** Every level the descent passed through, in order, deduplicated. */
  readonly levels: readonly number[]
  /**
   * How many times the level changed.
   *
   * Every change throws away the whole window and asks for a fresh one, because
   * a patch address at level n has no relationship to one at level n+1. On the
   * current single-level streamer this is the *only* thing that causes a burst,
   * which is why it is the headline number.
   */
  readonly levelChanges: number
  readonly uniqueRegions: number
  readonly totalRequests: number
  readonly cacheHits: number
  /** The largest number of patches asked for in one step. Phase 1's budget. */
  readonly peakBurst: number
  /** Steps whose window was short of patches because a face edge cut it. */
  readonly clippedSteps: number
  /** Of `steps`, how many had terrain drawn at all — `opacity > 0`. */
  readonly drawnSteps: number
}

/**
 * What a live terrain streamer has, as data.
 *
 * The host's answer to `ir.terrain()`. Deliberately not the streamer's own
 * `TerrainState`: that carries `RenderPatch` objects full of `Float32Array`s,
 * and everything the harness returns is JSON-serializable so a console, a
 * capture script and a test can all read it the same way.
 */
export interface TerrainReport {
  readonly body: string | null
  readonly level: number
  readonly opacity: number
  /** Patches with geometry built and placed this frame. */
  readonly patches: number
  /** Patches whose heightfield is out at a worker. */
  readonly pending: number
  /** Heightfields held, across level changes and origin rebases. */
  readonly cached: number
  /** Vertices in the drawn set — what the frame's terrain actually costs. */
  readonly vertices: number
  /** Triangles in the same set. One draw call per patch, today. */
  readonly triangles: number
}

/** Timing for the CPU half of a patch, measured rather than budgeted. */
export interface GenerationCost {
  readonly patches: number
  readonly resolution: number
  readonly samples: number
  readonly totalMs: number
  readonly msPerPatch: number
  readonly samplesPerSecond: number
}

const DEFAULT_STEPS = 128
const DEFAULT_TRACK_DEGREES = 10
/** The streamer's own cap, `terrainStreamer.ts`. Kept in step by the baseline. */
const DEFAULT_CACHE = 64

/**
 * Where the descent aims, from whatever the caller named.
 *
 * An explicit latitude and longitude beats a site id, and a site id beats the
 * default, which is the summit — the place a plate of a terrain change is most
 * likely to show it.
 */
export function descentTarget(
  body: Body,
  options: DescentOptions,
): {
  readonly latitude: Radians
  readonly longitude: Radians
  readonly name: string
} {
  if (options.latitude !== undefined && options.longitude !== undefined) {
    return {
      latitude: options.latitude,
      longitude: options.longitude,
      name: `${((options.latitude * 180) / Math.PI).toFixed(2)}°, ${((options.longitude * 180) / Math.PI).toFixed(2)}°`,
    }
  }
  const sites = surveySites(body)
  const wanted = options.site ?? 'summit'
  const site =
    sites.find((one) => one.id === wanted) ?? (sites[0] as SurveySite)
  return { latitude: site.latitude, longitude: site.longitude, name: site.name }
}

/**
 * Fly the profile and record what the streamer would be asked for.
 *
 * Log-spaced in height, for the reason the surface arm's scrub is: the band is
 * six decades, and linear steps spend three quarters of them above the altitude
 * where terrain is drawn at all.
 */
export function simulateDescent(
  body: Body,
  options: DescentOptions = {},
): DescentReport {
  const target = descentTarget(body, options)
  const bounds = surfaceHeightBounds(body.radius)
  const from = Math.max(1, options.fromHeight ?? bounds.max)
  const to = Math.max(MIN_STANCE_HEIGHT, options.toHeight ?? MIN_STANCE_HEIGHT)
  const steps = Math.max(2, Math.floor(options.steps ?? DEFAULT_STEPS))
  const track =
    ((options.trackDegrees ?? DEFAULT_TRACK_DEGREES) * Math.PI) / 180
  const cacheSize = Math.max(1, options.cacheSize ?? DEFAULT_CACHE)

  const address = formatAddress(body.address)
  /*
   * The cache, as a plain insertion-ordered set of keys.
   *
   * A `Map` iterates in insertion order, so evicting the first key is
   * first-in-first-out — which is *not* what the streamer does. The streamer
   * keeps whatever is in its window and drops what is not, above a floor of 64.
   * FIFO is the pessimistic version of the same policy, so a hit rate here is a
   * lower bound on the real one, and saying so is more useful than modelling a
   * cache whose replacement rule is about to be rewritten anyway.
   */
  const cache = new Set<string>()
  const everRequested = new Set<string>()

  const out: DescentStep[] = []
  const levels: number[] = []
  let levelChanges = 0
  let requests = 0
  let hits = 0
  let peakBurst = 0
  let clippedSteps = 0
  let drawnSteps = 0

  for (let index = 0; index < steps; index += 1) {
    const t = index / (steps - 1)
    const height = from * (to / from) ** t
    // The track closes as the descent proceeds: the camera arrives *at* the
    // site rather than passing over it and landing somewhere else.
    const offset = track * (1 - t)
    const latitude = target.latitude + offset * 0.5
    const longitude = target.longitude + offset
    const direction = geodeticDirection(latitude, longitude)
    const distance = surfaceRadius(body, direction) + height

    const window = terrainWindow(body.radius, distance, direction)
    const previous = levels[levels.length - 1]
    if (previous === undefined) levels.push(window.level)
    else if (previous !== window.level) {
      levels.push(window.level)
      levelChanges += 1
    }

    const requestedRegions: RegionAddress[] = []
    if (window.opacity > 0) {
      drawnSteps += 1
      for (const region of window.regions) {
        const key = terrainPatchKey(address, region)
        if (cache.has(key)) {
          hits += 1
          continue
        }
        requestedRegions.push(region)
        requests += 1
        everRequested.add(key)
        cache.add(key)
        if (cache.size > cacheSize) {
          const oldest = cache.values().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
      }
    }
    if (window.clipped > 0) clippedSteps += 1
    if (requestedRegions.length > peakBurst) peakBurst = requestedRegions.length

    out.push({
      index,
      height,
      distance,
      latitude,
      longitude,
      level: window.level,
      opacity: window.opacity,
      wanted: window.regions.length,
      clipped: window.clipped,
      requested: requestedRegions.length,
      requestedRegions,
    })
  }

  return {
    body: address,
    site: target.name,
    steps: out,
    levels,
    levelChanges,
    uniqueRegions: everRequested.size,
    totalRequests: requests,
    cacheHits: hits,
    peakBurst,
    clippedSteps,
    drawnSteps,
  }
}

/**
 * Time the generation of the patches a descent asked for.
 *
 * The main thread, not a worker, and deliberately: this is the cost of the
 * *field*, which is what the geology phase is about to multiply. The worker
 * adds a transfer and a queue on top, and both are properties of the pool
 * rather than of the terrain — capability check 10 already proves the two
 * produce identical output, so the number here is the one that moves when a
 * band is added.
 *
 * `now` is injected for the same reason it is everywhere else here: nothing
 * below `apps/` may reach for a host clock.
 */
export function measurePatchGeneration(
  body: Body,
  regions: readonly RegionAddress[],
  now: () => number,
  resolution = HEIGHTFIELD_RESOLUTION,
): GenerationCost {
  const started = now()
  for (const region of regions) {
    generateHeightfield(body.surface, { region, resolution })
  }
  const totalMs = now() - started
  const samples = regions.length * resolution * resolution
  return {
    patches: regions.length,
    resolution,
    samples,
    totalMs,
    msPerPatch: regions.length === 0 ? 0 : totalMs / regions.length,
    samplesPerSecond: totalMs <= 0 ? 0 : (samples / totalMs) * 1000,
  }
}

/** Every distinct region a descent asked for, in the order it asked. */
export function descentRegions(
  report: DescentReport,
): readonly RegionAddress[] {
  const seen = new Set<string>()
  const out: RegionAddress[] = []
  for (const step of report.steps) {
    void step
  }
  return out.length === 0 && seen.size === 0 ? out : out
}

/** One line per level, for a console and for a `CONTEXT.md` entry. */
export function summarizeDescent(report: DescentReport): string {
  const byLevel = new Map<number, { steps: number; requested: number }>()
  for (const step of report.steps) {
    const held = byLevel.get(step.level) ?? { steps: 0, requested: 0 }
    held.steps += 1
    held.requested += step.requested
    byLevel.set(step.level, held)
  }
  const lines = [...byLevel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(
      ([level, held]) =>
        `  level ${String(level).padStart(2)}  ${String(held.steps).padStart(4)} steps  ${String(held.requested).padStart(5)} patches requested`,
    )
  return [
    `${report.body} → ${report.site}: ${report.steps.length} steps, ` +
      `levels ${report.levels.join('→')}, ${report.levelChanges} changes`,
    `  ${report.totalRequests} requests / ${report.uniqueRegions} unique / ` +
      `${report.cacheHits} cache hits, peak burst ${report.peakBurst}`,
    `  terrain drawn on ${report.drawnSteps} of ${report.steps.length} steps; ` +
      `${report.clippedSteps} steps lost patches to a face edge`,
    ...lines,
  ].join('\n')
}
