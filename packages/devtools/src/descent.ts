import type { Meters, Radians } from '@inertialref/shared'
import {
  type Body,
  formatAddress,
  generateHeightfield,
  geodeticDirection,
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  type RegionAddress,
  surfaceDetailFloor,
  surfaceRadius,
  type SurveySite,
  surveySites,
} from '@inertialref/universe'
import {
  DEFAULT_LENS,
  DEFAULT_MAX_PATCHES,
  DEFAULT_VIEWPORT,
  clampLatitude,
  type Lens,
  type LensView,
  MIN_STANCE_HEIGHT,
  selectTerrain,
  surfaceHeightBounds,
  type TerrainSelectOptions,
  terrainPatchKey,
  verticalFovDegrees,
  type Viewport,
} from '@inertialref/rendering'

/*
 * A descent, as arithmetic.
 *
 * The plan's unit of measurement: fly a camera from orbit to two meters over a
 * named site and record what the terrain streamer is asked for on the way down.
 * It runs with no world, no worker pool, no renderer and no GPU, because
 * everything it needs is a `Body` and the selection rule — which is why
 * `selectTerrain` lives in `packages/rendering` rather than in the streamer.
 * The same call therefore runs in a browser console, in `pnpm sim`, and in a
 * Node test, and all three get the same numbers.
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
  /** The streamer's heightfield cache size. Default: the streamer's own cap. */
  readonly cacheSize?: number
  /**
   * Deepest level to refine to. Default is the body's own `surfaceDetailFloor`
   * — the level past which a patch is an upsample of its parent.
   */
  readonly maxLevel?: number
  /** Pixels a grid cell may subtend before refining. Default 16. */
  readonly cellPixels?: number
  /**
   * The lens the descent is flown behind. Default: the flight lens.
   *
   * Every figure a descent reports is a function of it — measured over the zoo,
   * two to three times the patches between the two ends of the field-of-view
   * slider — so a baseline that did not say which lens it was taken through is
   * a number nobody can reproduce. The report carries it back out for exactly
   * that reason.
   */
  readonly lens?: Lens
  /** Display pixels, supersampling already divided out. Default: 1920×1080. */
  readonly viewport?: Viewport
  /**
   * The patch cap, for asking what a selection *wants* rather than what it gets.
   *
   * The streamer's own default is a safety net that degrades the whole disk by
   * a level when it bites, and the only way to find out how hard it is biting
   * is to raise it and re-fly. That is how the telephoto end of the slider got
   * a number instead of an adjective.
   */
  readonly maxPatches?: number
}

export interface DescentStep {
  readonly index: number
  /** Above the ground below the camera, meters. */
  readonly height: Meters
  /** From the body's center, meters. */
  readonly distance: Meters
  readonly latitude: Radians
  readonly longitude: Radians
  /** Deepest and shallowest levels drawn together this step. */
  readonly level: number
  readonly shallowestLevel: number
  /** Patches the selection wants this step. */
  readonly wanted: number
  /** Nodes the traversal looked at — what the selection cost. */
  readonly visited: number
  /** Nodes dropped beyond the horizon. Most of a planet, most of the time. */
  readonly culled: number
  /** True when the patch budget stopped the refinement a level early. */
  readonly saturated: boolean
  /** Of `wanted`, how many are not in the cache — the worker queue this step. */
  readonly requested: number
  /** Which ones. What `measurePatchGeneration` is handed to time the field. */
  readonly requestedRegions: readonly RegionAddress[]
}

export interface DescentReport {
  readonly body: string
  readonly site: string
  /** The optics every number below is a function of. */
  readonly lens: Lens
  readonly viewport: Viewport
  readonly steps: readonly DescentStep[]
  /** Every level the descent's *deepest* patch passed through, deduplicated. */
  readonly levels: readonly number[]
  /**
   * How many times the deepest level changed.
   *
   * The headline number of the window this replaced, because a level change
   * there threw away all nine patches and asked for nine more. Here it is a
   * far weaker signal and is kept for exactly that comparison: the quadtree
   * refines one ring at a time, so a level change costs the patches at the new
   * level near the camera rather than the whole set.
   */
  readonly levelChanges: number
  readonly uniqueRegions: number
  readonly totalRequests: number
  readonly cacheHits: number
  /** The largest number of patches asked for in one step. Phase 1's budget. */
  readonly peakBurst: number
  /** The largest number drawn at once — the frame's terrain, at its worst. */
  readonly peakDrawn: number
  /** Steps where the patch budget bit. Should be none. */
  readonly saturatedSteps: number
  /** The most nodes the traversal ever walked, for the selection's own cost. */
  readonly peakVisited: number
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
  /**
   * The optics the selection was made against.
   *
   * Every count below is a function of it — the patch demand goes as the square
   * of the pixels-per-radian — so a terrain readout that did not say which lens
   * produced it was a number nobody could compare with the one they took
   * yesterday. Null before the host has drawn a frame.
   */
  readonly lens: LensView | null
  /** Deepest and shallowest levels drawn together this frame. */
  readonly level: number
  readonly shallowestLevel: number
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
  /** Nodes the traversal walked, and how many the horizon took. */
  readonly visited: number
  readonly culled: number
  /** Nodes drawn coarse because a child's heightfield had not arrived yet. */
  readonly starved: number
  /** True when the patch budget stopped the refinement a level early. */
  readonly saturated: boolean
}

/**
 * Timing for the CPU half of a patch, measured rather than budgeted.
 *
 * The rate is **not** constant across levels, which is a property of the field
 * rather than of the loop: a level-12 patch's 4,761 samples are clustered
 * inside a handful of the noise's lattice cells, and a level-1 patch's land in
 * a different cell every time. Measured on the same body and the same grid,
 * 14.33 ms at level 12 against 20.69 ms at level 1 — 0.33 against 0.23 M
 * samples per second for identical work.
 *
 * The 3×3 window never saw this, because it only ever generated patches at the
 * camera's own level. A whole-disk selection generates the coarse shell too,
 * so the figure a descent reports is a mixed-level average and is the honest
 * one for the streamer.
 */
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
/*
 * The streamer's own cap: `FIELD_CACHE` is three times the largest selection,
 * derived here from the same `DEFAULT_MAX_PATCHES` rather than copied as a
 * number — the copy shipped stale on the day it was written, so the baseline
 * simulated a cache a quarter of the one that streams, and every cache-hit
 * figure described a configuration that no longer exists. (`devtools` cannot
 * import `apps/game`, so the multiplier is the one thing restated; the
 * streamer's docstring owns why it is three. Exported so the engine's own
 * test can assert the two stay equal — the restated multiplier is exactly
 * the kind of twin that drifts.)
 */
export const DEFAULT_CACHE = DEFAULT_MAX_PATCHES * 3

/**
 * Where the descent aims, from whatever the caller named.
 *
 * An explicit latitude and longitude beats a site id, and a site id beats the
 * default, which is the summit — the place a plate of a terrain change is most
 * likely to show it.
 *
 * Each angle overrides on its own, and an unknown site id throws: both are what
 * `Observatory.stand` does with the same two options, and a probe that answered
 * a different question from the camera would be measuring the wrong ground.
 * Substituting the first site for a typo is the worst of the three, because the
 * first site is the summit and this phase's own finding is that a summit above
 * the fade line requests nothing — a mistyped `basin` would come back as a
 * generation cost of zero and read as free.
 */
export function descentTarget(
  body: Body,
  options: DescentOptions,
): {
  readonly latitude: Radians
  readonly longitude: Radians
  readonly name: string
} {
  const sites = surveySites(body)
  const site =
    options.site === undefined
      ? undefined
      : sites.find((one) => one.id === options.site)
  if (options.site !== undefined && site === undefined) {
    throw new Error(
      `${body.name} has no site "${options.site}" — try ${sites
        .map((one) => one.id)
        .join(', ')}`,
    )
  }
  if (options.latitude !== undefined || options.longitude !== undefined) {
    const latitude = options.latitude ?? site?.latitude ?? 0
    const longitude = options.longitude ?? site?.longitude ?? 0
    return {
      latitude,
      longitude,
      name: `${((latitude * 180) / Math.PI).toFixed(2)}°, ${((longitude * 180) / Math.PI).toFixed(2)}°`,
    }
  }
  const chosen =
    site ?? (sites.find((one) => one.id === 'summit') as SurveySite)
  return {
    latitude: chosen.latitude,
    longitude: chosen.longitude,
    name: chosen.name,
  }
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
   * A `Set` iterates in insertion order, so evicting the first key is
   * first-in-first-out — which is *not* what the streamer does. The streamer
   * keeps whatever either of its two selections wants and drops the oldest of
   * the rest, above a floor. FIFO is the pessimistic version of the same
   * policy, so a hit rate here is a lower bound on the real one.
   */
  const cache = new Set<string>()
  const everRequested = new Set<string>()
  /*
   * The level floor the streamer would use: measured from the field rather than
   * fixed at 12, because past it a patch is a bilinear upsample of its parent.
   * Passed explicitly so a descent report says which floor produced it.
   */
  const lens = options.lens ?? DEFAULT_LENS
  const viewport = options.viewport ?? DEFAULT_VIEWPORT
  const select: TerrainSelectOptions = {
    maxLevel: options.maxLevel ?? surfaceDetailFloor(body.radius, body.surface),
    cellPixels: options.cellPixels,
    lens,
    viewport,
    ...(options.maxPatches === undefined
      ? {}
      : { maxPatches: options.maxPatches }),
  }

  const out: DescentStep[] = []
  const levels: number[] = []
  let levelChanges = 0
  let requests = 0
  let hits = 0
  let peakBurst = 0
  let peakDrawn = 0
  let peakVisited = 0
  let saturatedSteps = 0

  for (let index = 0; index < steps; index += 1) {
    const t = index / (steps - 1)
    const height = from * (to / from) ** t
    // The track closes as the descent proceeds: the camera arrives *at* the
    // site rather than passing over it and landing somewhere else.
    const offset = track * (1 - t)
    /*
     * Clamped, because a track that runs past a pole is not a track.
     *
     * Through `clampLatitude`, the same limit `Observatory.stand` holds a stance
     * to, so a latitude means the same place in the probe and in the camera it
     * predicts. `geodeticDirection` takes `cos(latitude)`, which goes negative
     * past ±90° and reflects the direction through the axis onto the opposite
     * meridian.
     * A descent onto the `pole` site with the default 10° of track would
     * otherwise start at 95° — five degrees past the pole on the anti-meridian
     * — and every level and patch figure for those steps would describe ground
     * the caller never asked about. Longitude is left to run:
     * a wrap is what a meridian is for.
     */
    const latitude = clampLatitude(target.latitude + offset * 0.5)
    const longitude = target.longitude + offset
    const direction = geodeticDirection(latitude, longitude)
    const distance = surfaceRadius(body, direction) + height

    const selection = selectTerrain(
      {
        radius: body.radius,
        relief: body.surface.maxElevation,
        distance,
        direction,
      },
      select,
    )
    const previous = levels[levels.length - 1]
    if (previous === undefined) levels.push(selection.deepestLevel)
    else if (previous !== selection.deepestLevel) {
      levels.push(selection.deepestLevel)
      levelChanges += 1
    }

    const requestedRegions: RegionAddress[] = []
    for (const patch of selection.patches) {
      const key = terrainPatchKey(address, patch.region)
      if (cache.has(key)) {
        hits += 1
        continue
      }
      requestedRegions.push(patch.region)
      requests += 1
      everRequested.add(key)
      cache.add(key)
      if (cache.size > cacheSize) {
        const oldest = cache.values().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
    }
    if (requestedRegions.length > peakBurst) peakBurst = requestedRegions.length
    if (selection.patches.length > peakDrawn)
      peakDrawn = selection.patches.length
    if (selection.visited > peakVisited) peakVisited = selection.visited
    if (selection.saturated) saturatedSteps += 1

    out.push({
      index,
      height,
      distance,
      latitude,
      longitude,
      level: selection.deepestLevel,
      shallowestLevel: selection.shallowestLevel,
      wanted: selection.patches.length,
      visited: selection.visited,
      culled: selection.culled,
      saturated: selection.saturated,
      requested: requestedRegions.length,
      requestedRegions,
    })
  }

  return {
    body: address,
    site: target.name,
    lens,
    viewport,
    steps: out,
    levels,
    levelChanges,
    uniqueRegions: everRequested.size,
    totalRequests: requests,
    cacheHits: hits,
    peakBurst,
    peakDrawn,
    saturatedSteps,
    peakVisited,
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
    generateHeightfield(body.surface, {
      region,
      resolution,
      border: HEIGHTFIELD_BORDER,
    })
  }
  const totalMs = now() - started
  // The border is generated too — 12.7% more samples than the patch's own grid
  // — and a rate quoted against the interior would flatter the generator by
  // exactly that, which is the kind of drift the baseline exists to catch.
  const stride = resolution + 2 * HEIGHTFIELD_BORDER
  const samples = regions.length * stride * stride
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
    for (const region of step.requestedRegions) {
      const key = `${region.face}.${region.level}.${region.i}.${region.j}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(region)
    }
  }
  return out
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
      `deepest level ${report.levels.join('→')}, ${report.levelChanges} changes`,
    // The lens, on the line above the counts it produced. Every one of them is
    // a function of it, so a patch figure without it is a number nobody can
    // reproduce.
    `  through ${report.lens.focalLength.toFixed(2)} mm ` +
      `(${verticalFovDegrees(report.lens).toFixed(1)}°) over ` +
      `${report.viewport.width}×${report.viewport.height}`,
    `  ${report.totalRequests} requests / ${report.uniqueRegions} unique / ` +
      `${report.cacheHits} cache hits, peak burst ${report.peakBurst}`,
    `  peak ${report.peakDrawn} patches drawn, ${report.peakVisited} nodes ` +
      `walked; budget bit on ${report.saturatedSteps} steps`,
    ...lines,
  ].join('\n')
}
