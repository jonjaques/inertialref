import type { Meters } from '@inertialref/shared'
import type { World } from '@inertialref/simulation'
import {
  findBody,
  formatAddress,
  HEIGHTFIELD_RESOLUTION,
  parseAddress,
  type Body,
  type SurfaceArchetype,
  surfaceDetailFloor,
  surveySites,
} from '@inertialref/universe'
import {
  type DescentReport,
  descentRegions,
  type GenerationCost,
  measurePatchGeneration,
  simulateDescent,
  summarizeDescent,
} from './descent.ts'
import {
  missingArchetypes,
  terrainZoo,
  type ZooEntry,
  type ZooOptions,
} from './terrainZoo.ts'

/*
 * The Phase 0 baseline: what terrain costs on the build that exists.
 *
 * One command that walks the zoo, flies a descent over each member's summit,
 * and times the generation of the patches the descent asked for. Its whole
 * purpose is to turn the plan's designed numbers into measured ones before a
 * single band of geology is added, so that the phase which triples the
 * per-sample cost has something to be a regression against.
 *
 * **It measures the CPU half and says so.** Patch generation, the request
 * pattern, the level churn and the cache behavior are all arithmetic and all
 * honest here. Frame cost, draw calls and the worker queue's real depth are
 * browser facts — the pool, the geometry build and the placement pass are not
 * in this process — and reporting an invented figure for them would be worse
 * than reporting none. `summarizeBaseline` names the gap rather than papering
 * over it.
 */

/** What a descent onto one survey site does, without generating anything. */
export interface SiteProbe {
  readonly id: string
  readonly name: string
  readonly elevation: Meters
  readonly steps: number
  /** The deepest level the descent reaches. */
  readonly finalLevel: number
  /**
   * The level the field itself says is the floor.
   *
   * Reaching it is the successor to "was terrain drawn at all", which was the
   * question when the streamer faded out an octave above the ground and two of
   * Miranda's six sites were ground that could not be looked at from any
   * altitude. Terrain is now drawn everywhere, so the failure worth watching is
   * a site that *bottoms out short* — ground the streaming rule refuses to
   * resolve, for whatever reason the next one turns out to be.
   */
  readonly floorLevel: number
  /** The most patches drawn at once on the way down — the frame at its worst. */
  readonly peakDrawn: number
}

export interface BaselineEntry {
  readonly zoo: ZooEntry
  /**
   * The profile the timings come from: a descent into the basin.
   *
   * The basin rather than the summit, which was forced when the streaming rules
   * measured altitude from the datum: a summit could sit above the fade line
   * and draw nothing at all — Miranda's did — so timing generation from it
   * reported zero and read as free. Nothing measures from the datum any more
   * and every site draws, but the basin is kept as the timed profile so the
   * figure stays comparable with the one the rig first recorded.
   */
  readonly descent: DescentReport
  readonly generation: GenerationCost
  /** Every survey site, flown, so the holes are visible rather than implied. */
  readonly sites: readonly SiteProbe[]
}

export interface TerrainBaseline {
  readonly seed: string
  readonly resolution: number
  readonly entries: readonly BaselineEntry[]
  /** Empty is the only passing answer. See `missingArchetypes`. */
  readonly missing: readonly SurfaceArchetype[]
  /** False when the host supplied no clock, in which case the timings are zero. */
  readonly timed: boolean
}

/**
 * How many patches to time per body.
 *
 * A descent asks for a few hundred distinct patches and generating all of them
 * is seconds, which is too long for something run from a panel. Forty-eight is
 * a fifth of a second and is already far more than a percentile needs; the
 * first four are discarded as warm-up, because the first call into
 * `generateHeightfield` in a fresh process pays for the JIT and reads three
 * times slower than the next one.
 */
const TIMED_PATCHES = 48
/**
 * Patches generated and thrown away before the clock starts.
 *
 * Twelve rather than four, because the timed set is no longer 48 neighbors at
 * one level: a whole-disk selection asks for every level between the horizon
 * and the ground, and the first few are the coarse ones.
 */
const WARMUP_PATCHES = 12

export interface BaselineOptions extends ZooOptions {
  readonly steps?: number
  readonly resolution?: number
  readonly timedPatches?: number
}

/** Resolve a zoo entry's address back to the body it names. */
function bodyFor(world: World, address: string): Body | null {
  const parsed = parseAddress(address)
  if (parsed.kind !== 'body') return null
  const system = world.loadSystem(parsed.system)
  return findBody(system, parsed.body) ?? null
}

/**
 * Walk the zoo, fly each descent, time each field.
 *
 * `now` is a parameter for the reason every clock in this repository is one:
 * nothing below `apps/` may reach for a host clock. A host that supplies none
 * still gets the request pattern — which is the half that is deterministic —
 * and `timed` comes back false.
 */
export function terrainBaseline(
  world: World,
  now: (() => number) | null,
  options: BaselineOptions = {},
): TerrainBaseline {
  const resolution = options.resolution ?? HEIGHTFIELD_RESOLUTION
  const limit = options.timedPatches ?? TIMED_PATCHES
  const clock = now ?? ((): number => 0)
  const zoo = terrainZoo(world, options)

  const entries: BaselineEntry[] = []
  for (const entry of zoo) {
    const body = bodyFor(world, entry.address)
    if (body === null) continue
    const profile = {
      ...(options.steps === undefined ? {} : { steps: options.steps }),
    }
    const descent = simulateDescent(body, { ...profile, site: 'basin' })
    const regions = descentRegions(descent)
    /*
     * No clock, no generation.
     *
     * With `now === null` every timing is zero by construction and the summary
     * says "not timed" — so running the pass anyway spent about 0.7 s per zoo
     * body, 2.8 s a call, generating heightfields for numbers that were going
     * to be zero. The request pattern is the half that is deterministic and it
     * costs nothing; that is what an untimed caller gets.
     *
     * The warm-up is thrown away rather than counted, because including the
     * first few calls into `generateHeightfield` in a fresh process biases the
     * mean by ~15% on a 48-patch sample — larger than the difference a band
     * would make.
     */
    let generation: GenerationCost = {
      patches: 0,
      resolution,
      samples: 0,
      totalMs: 0,
      msPerPatch: 0,
      samplesPerSecond: 0,
    }
    if (now !== null) {
      measurePatchGeneration(
        body,
        regions.slice(0, WARMUP_PATCHES),
        clock,
        resolution,
      )
      generation = measurePatchGeneration(
        body,
        regions.slice(WARMUP_PATCHES, WARMUP_PATCHES + limit),
        clock,
        resolution,
      )
    }
    entries.push({
      zoo: entry,
      descent,
      generation,
      // Every site flown, not just the one that was timed. A descent with no
      // generation in it is a few hundred noise samples, so the whole survey
      // costs less than one patch — and it is the only way the holes in the
      // fade line show up as data rather than as a screenshot of a datum
      // sphere that somebody has to notice.
      sites: surveySites(body).map((site) => {
        const flown = simulateDescent(body, {
          ...profile,
          site: site.id,
          trackDegrees: 0,
        })
        return {
          id: site.id,
          name: site.name,
          elevation: site.elevation,
          steps: flown.steps.length,
          finalLevel: flown.levels[flown.levels.length - 1] ?? -1,
          floorLevel: surfaceDetailFloor(body.radius, body.surface),
          peakDrawn: flown.peakDrawn,
        }
      }),
    })
  }

  return {
    seed: world.seedText,
    resolution,
    entries,
    missing: missingArchetypes(zoo),
    timed: now !== null,
  }
}

/** The baseline as a block of text, for a console and for `CONTEXT.md`. */
export function summarizeBaseline(baseline: TerrainBaseline): string {
  const lines: string[] = [
    `terrain baseline — seed "${baseline.seed}", ${baseline.resolution}×${baseline.resolution} patches`,
  ]
  if (baseline.missing.length > 0) {
    lines.push(
      `  MISSING ARCHETYPES: ${baseline.missing.join(', ')} — the zoo is short`,
    )
  }
  for (const entry of baseline.entries) {
    lines.push('')
    lines.push(
      `${entry.zoo.archetype} — ${entry.zoo.name} (${entry.zoo.address})`,
    )
    lines.push(`  ${entry.zoo.detail}`)
    lines.push(summarizeDescent(entry.descent))
    const g = entry.generation
    lines.push(
      baseline.timed
        ? `  generation: ${g.msPerPatch.toFixed(2)} ms/patch over ${g.patches} patches ` +
            `(${(g.samplesPerSecond / 1e6).toFixed(2)} M samples/s)`
        : `  generation: not timed — the host supplied no clock`,
    )
    lines.push('  sites, dropped straight onto:')
    for (const site of entry.sites) {
      const hole =
        site.finalLevel < site.floorLevel ? '  ← SHORT OF THE FLOOR' : ''
      lines.push(
        `    ${site.id.padEnd(7)} ${String(Math.round(site.elevation)).padStart(7)} m  ` +
          `bottoms out at level ${site.finalLevel} of ${site.floorLevel}, ` +
          `peak ${String(site.peakDrawn).padStart(3)} patches${hole}`,
      )
    }
  }
  lines.push('')
  lines.push(
    'not measured here: frame cost, draw calls, worker queue depth — all browser facts',
  )
  return lines.join('\n')
}

/** Just the zoo's addresses, for a capture script's loop. */
export const baselineAddresses = (
  baseline: TerrainBaseline,
): readonly string[] =>
  baseline.entries.map((entry) =>
    formatAddress(parseAddress(entry.zoo.address)),
  )
