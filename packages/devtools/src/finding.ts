import { getLogger, LIGHT_YEAR } from '@inertialref/shared'
import { formatSeed } from '@inertialref/procedural'
import { type UniverseVector, UV } from '@inertialref/spatial'
import type { World } from '@inertialref/simulation'
import {
  type EntityId,
  type SystemStub,
  systemsWithin,
  type WorldMatch,
  type WorldQuery,
} from '@inertialref/universe'
import {
  encodeStub,
  findWorldsTask,
  type WorkerPool,
} from '@inertialref/workers'
import { encodeUniverseVector } from '@inertialref/protocol'
import {
  currentSystemOf,
  DEFAULT_SEARCH_LIGHT_YEARS,
  DEFAULT_SEARCH_LIMIT,
  SEARCH_BATCH,
  searchTargets,
  targetsFor,
  type TravelTarget,
  type TravelTargetOptions,
  travelTargets,
} from './travel.ts'

/*
 * Finding somewhere: the questions a console asks of the volume.
 *
 * `travel.ts` answers each question from a fixed point — a sweep, an index
 * lookup, a set of rows. This decides the point. A search is asked from the
 * ship, or from the planetarium's eye when the question is about what the
 * camera is looking at, and the two are nowhere near each other in that mode.
 * Everything here is a function of the world, the vantage and the options,
 * with no harness state in it, so the harness forwards and the tests call
 * these directly.
 */

const log = getLogger('devtools.finding')

/** Where a search is asked from. */
export interface Vantage {
  readonly world: World
  /** The entity the ship-side questions are about, if there is one. */
  readonly player: EntityId | null
  /** The planetarium's eye, while it holds a target. */
  readonly observer: UniverseVector | null
}

/** Where the listing is taken from: the player, or the first system loaded. */
export function hereOf(world: World, player: EntityId | null): UniverseVector {
  if (player === null)
    return world.loadedSystems()[0]?.position ?? UV.UNIVERSE_ORIGIN
  return world.canonicalPositionOf(player)
}

/**
 * The point a listing measures from.
 *
 * `origin: 'observer'` falls back to the player rather than returning
 * nothing, and that is not defensiveness — the observatory holds no target
 * until the planetarium's first focus lands, which is several frames after
 * the panel's first poll. A listing that was empty for those frames would
 * flash a "nothing within 16 ly" empty state on every entry to the mode.
 */
function originOf(
  vantage: Vantage,
  options: TravelTargetOptions,
): UniverseVector {
  return (
    (options.origin === 'observer' ? vantage.observer : null) ??
    hereOf(vantage.world, vantage.player)
  )
}

/** A 500 ly box fits the 200,000-cell travel budget at every grid alignment. */
export function boundedTravelRadius(lightYears: number): number {
  const bounded = Number.isNaN(lightYears)
    ? 0
    : Math.max(0, Math.min(500, lightYears))
  if (bounded !== lightYears)
    log.warn('Travel query radius is bounded to 0–500 light-years', {
      requested: lightYears,
      applied: bounded,
    })
  return bounded * LIGHT_YEAR
}

/** Star systems within `lightYears` of the player, nearest first. */
export function systemsNearby(
  vantage: Vantage,
  lightYears = 8,
): readonly { id: string; name: string; lightYears: number }[] {
  const { world } = vantage
  const center = hereOf(world, vantage.player)
  return systemsWithin(
    world.galaxySeed,
    world.catalog,
    center,
    boundedTravelRadius(lightYears),
  )
    .map((stub) => ({
      id: stub.id as string,
      name: stub.name,
      lightYears: UV.distance(stub.position, center) / LIGHT_YEAR,
    }))
    .sort((a, b) => a.lightYears - b.lightYears)
}

/**
 * Everywhere the player can be sent right now, nearest system first, each
 * system followed by its bodies if it is loaded.
 *
 * The one call that answers "where can I go?": every other verb takes an
 * address and none of them would tell you one. The debug overlay renders this
 * list and the console prints it.
 */
export function nearbyTargets(
  vantage: Vantage,
  options: TravelTargetOptions = {},
): readonly TravelTarget[] {
  return travelTargets(vantage.world, originOf(vantage, options), options)
}

/**
 * Everywhere matching what somebody typed, nearest first — the *whole*
 * catalog, not the survey.
 *
 * Split from `nearbyTargets` by question rather than by cost: that one asks
 * "what is near me", which is a star sweep and cannot run per keystroke; this
 * asks "what is called this", which is an index lookup and must. Filtering the
 * survey's result could only ever find what was already within a few light
 * years of the camera.
 */
export function searchByName(
  vantage: Vantage,
  text: string,
  options: TravelTargetOptions = {},
): readonly TravelTarget[] {
  return searchTargets(vantage.world, originOf(vantage, options), text)
}

/**
 * Rows for addresses the caller already holds, nearest first not implied —
 * the order is the caller's.
 *
 * The third question, after the sweep and the name: a fuzzy index in the
 * navigator answers with addresses, and this turns them back into the rows
 * the survey draws, measured from the same eye. `b:2` and friends resolve
 * against the system the player is in, exactly as `goTo` reads them; an
 * address that names nothing is dropped rather than thrown, so one stale
 * entry cannot empty the list.
 */
export function rowsFor(
  vantage: Vantage,
  addresses: readonly string[],
  options: TravelTargetOptions = {},
): readonly TravelTarget[] {
  return targetsFor(
    vantage.world,
    originOf(vantage, options),
    addresses,
    currentSystemOf(vantage.world, vantage.player),
  )
}

export interface FindWorldsOptions {
  readonly lightYears?: number
  /**
   * How many of the nearest matches to keep.
   *
   * A sweep is bounded by the volume, and the volume is not bounded by
   * anything a reader will read: "rocky, within 150 light years" answers
   * with over a hundred thousand bodies. Keeping them all is twenty
   * megabytes of records nobody scrolls to, and re-sorting them on every
   * batch is the main thread's whole budget — measured, it dropped the
   * simulation clock to a fifth of real time while the sweep ran. So the
   * nearest are kept and the rest are counted.
   */
  readonly limit?: number
  /**
   * Called as each batch answers: the nearest matches so far, how far
   * through the sweep it is, and how many were found in total — which is
   * not `found.length` once the cap has bitten, and saying so is the
   * difference between a list that is short and a search that found little.
   */
  readonly onBatch?: (
    found: readonly WorldMatch[],
    progress: number,
    total: number,
  ) => void
}

/** A sweep in flight. */
export interface WorldSweep {
  /** How many systems the sweep will walk. Zero means there is nothing to do. */
  readonly systems: number
  readonly cancel: () => void
  readonly done: Promise<readonly WorldMatch[]>
}

/**
 * Search the volume for bodies that answer a query, in batches.
 *
 * The other question a catalog can be asked. `searchByName` answers "what is
 * called this" from an index; this answers "what is out there *like* this",
 * and it cannot come from an index because the bodies do not exist until
 * they are generated. So it is a sweep, and the sweep is the cost: a system
 * is milliseconds to build and a body is microseconds to test. It is asked
 * from the planetarium's eye when there is one, and from the player when not.
 *
 * **It answers in batches rather than once.** The volume is cut into jobs
 * and each is submitted separately, so rows arrive while the search is still
 * running and a fifty-light-year question is not a blank panel for two
 * seconds. That shape is forced as well as chosen: a job is one request and
 * one response, with no partial-result message in the protocol, so streaming
 * has to be several jobs rather than one job that reports as it goes.
 *
 * `cancel` stops it — the queued jobs are dropped and the running ones are
 * told through `TaskContext.canceled`, which `findWorldsTask` polls once per
 * system. A second question therefore does not wait behind the first one's
 * whole volume.
 *
 * With no pool the batches run inline, on this thread, in order. That is the
 * headless runner and it is slow rather than wrong, which is the same
 * bargain every other task here makes.
 */
export function findWorlds(
  vantage: Vantage,
  pool: WorkerPool | null,
  query: WorldQuery,
  options: FindWorldsOptions = {},
): WorldSweep {
  const { world } = vantage
  const from = vantage.observer ?? hereOf(world, vantage.player)
  const stubs = systemsWithin(
    world.galaxySeed,
    world.catalog,
    from,
    boundedTravelRadius(options.lightYears ?? DEFAULT_SEARCH_LIGHT_YEARS),
  )
  /*
   * Nearest first, so the batches that answer first are the ones a reader
   * cares about most. `systemsWithin` sorts by id to stay a pure function of
   * its query; the ordering that matters *here* is a display decision and is
   * made here, which is the same split `orbitalOrder` makes.
   */
  const ordered = [...stubs].sort(
    (a, b) => UV.distance(a.position, from) - UV.distance(b.position, from),
  )
  const jobs: {
    readonly result: Promise<{ readonly matches: readonly WorldMatch[] }>
    readonly cancel: () => void
  }[] = []
  const limit = Math.max(1, options.limit ?? DEFAULT_SEARCH_LIMIT)
  let stopped = false
  let total = 0
  let found: WorldMatch[] = []
  const wire = encodeUniverseVector(from)
  const seed = formatSeed(world.rootSeed)

  const batches: (readonly SystemStub[])[] = []
  for (let at = 0; at < ordered.length; at += SEARCH_BATCH)
    batches.push(ordered.slice(at, at + SEARCH_BATCH))

  let answered = 0
  const run = async (): Promise<readonly WorldMatch[]> => {
    for (const batch of batches) {
      if (stopped) break
      const payload = {
        seed,
        galaxy: world.galaxy as string,
        stubs: batch.map(encodeStub),
        query,
        from: wire,
      }
      const job =
        pool === null
          ? {
              result: Promise.resolve(
                findWorldsTask.run(payload, {
                  canceled: () => stopped,
                }),
              ),
              cancel: () => {},
            }
          : pool.submit(findWorldsTask, payload)
      jobs.push(job)
      void Promise.resolve(job.result)
        .then((answer) => {
          if (stopped) return
          total += answer.matches.length
          found.push(...answer.matches)
          /*
           * Trimmed at twice the cap rather than at the cap, so the sort is
           * amortized: cutting on every batch would sort a nearly-full array
           * every time, and cutting at twice it sorts once per capful.
           */
          if (found.length > limit * 2) {
            found.sort((a, b) => a.lightYears - b.lightYears)
            found = found.slice(0, limit)
          }
          answered += 1
          options.onBatch?.(found, answered / batches.length, total)
        })
        .catch(() => {
          // A batch that failed is a gap in an answer, not a failed search.
          // Counting it keeps the progress honest about being finished.
          answered += 1
        })
    }
    await Promise.allSettled(jobs.map((job) => job.result))
    found.sort((a, b) => a.lightYears - b.lightYears)
    return found.slice(0, limit)
  }

  return {
    systems: ordered.length,
    cancel: () => {
      stopped = true
      for (const job of jobs) job.cancel()
    },
    done: run(),
  }
}
