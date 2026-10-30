import { getLogger } from '@inertialref/shared'
import {
  type DepositSlopeTable,
  drains,
  HEIGHTFIELD_RESOLUTION,
  type HeightfieldRequest,
  seedDrainageGraph,
  surfaceDetailFloor,
  type SurfaceParameters,
} from '@inertialref/universe'
import type { JobHandle, JobLane, WorkerPool } from './pool.ts'
import {
  type ArchivedSource,
  depositSlopesTask,
  encodeSurface,
  type HeightfieldResponse,
  prepareSurfaceTask,
} from './tasks.ts'

/*
 * A body's ground, made readable on this thread without stalling it.
 *
 * Two things about a surface are cold once per body per thread and too slow
 * for a frame: the detail floor, 33-43 ms of probe search, and the drainage
 * graph, 57 to 103 ms of lattice and flood in the browser. Everything that
 * reads a wet body's ground on the draw thread reads the graph — the site
 * list, the scatter field's one sample a frame, the GPU producer's pack — and
 * each is the first asker somewhere: the site list on focusing a body in the
 * planetarium, the scatter field as the ground arrives under a ship, the
 * producer for the orbital bake on arriving at a generated world. So the
 * answer cannot live in any one of them.
 *
 * A worker prepares the surface: the floor, and the graph the floor search
 * builds on its way. The answer seeds this thread's drainage memo before the
 * floor is published, so whatever asks after "is it prepared" finds the graph
 * a lookup. The streamer holds the ground back until then, the GPU producer's
 * requests are held through `holding`, and the site list waits on
 * `whenPrepared` — each the shape it already had for the heightfields
 * themselves. Only the streamer waits on a body that does not drain: its
 * graph is a null nothing has to build, and the floor is the streamer's alone.
 *
 * What it cannot hold back is canonical code. The contact test and the flight
 * model sample the field synchronously, and a body reached by teleport rather
 * than flown to can be sampled before any worker has answered; that pays the
 * build here, once, in the frame of a cut.
 */

const log = getLogger('workers.preparation')

/** A surface this thread can read without building anything. */
export interface Prepared {
  /** The region level past which a patch is an upsample of its parent. */
  readonly floor: number
}

interface Waiting {
  readonly promise: Promise<Prepared | null>
  readonly resolve: (prepared: Prepared | null) => void
}

export class SurfacePreparation {
  readonly #pool: WorkerPool | null
  readonly #resolution: number
  /*
   * Keyed on the `SurfaceParameters` object: it is immutable, it belongs to the
   * loaded body, and a reseed under the same address produces a new one — so a
   * new world cannot inherit the old one's answer, and nothing has to clear
   * this.
   */
  readonly #prepared = new WeakMap<SurfaceParameters, Prepared>()
  readonly #jobs = new Map<SurfaceParameters, JobHandle<unknown>>()
  readonly #waiting = new WeakMap<SurfaceParameters, Waiting>()
  /*
   * Surfaces neither thread could prepare. Held, not released: the search
   * that failed here fails the same way on the next ask, and a released
   * surface is resubmitted by the next frame's `prepare` — a job, a warning
   * and a partial search on this thread every frame, for a body whose field
   * throws for every reader anyway.
   */
  readonly #failed = new WeakSet<SurfaceParameters>()
  /*
   * The deposit slope table (`depositSlope.ts`), a second answer about the
   * same surface and a later one: the ground waits on the floor and must not
   * wait on this, so it is asked for only once the surface is prepared, and
   * the deposits read the mesh's own slope until it lands.
   */
  readonly #slopes = new WeakMap<SurfaceParameters, DepositSlopeTable>()
  readonly #slopeJobs = new Map<SurfaceParameters, JobHandle<unknown>>()
  readonly #slopeWaiting = new WeakMap<
    SurfaceParameters,
    {
      readonly promise: Promise<DepositSlopeTable | null>
      readonly resolve: (table: DepositSlopeTable | null) => void
    }
  >()
  readonly #slopesFailed = new WeakSet<SurfaceParameters>()
  // Asked for through `slopes`, the material's ask, for `slopesPending`.
  readonly #slopesAsked = new WeakSet<SurfaceParameters>()

  constructor(
    pool: WorkerPool | null,
    resolution: number = HEIGHTFIELD_RESOLUTION,
  ) {
    this.#pool = pool
    this.#resolution = resolution
  }

  /**
   * The surface's deposit slope table, or null until a worker has measured
   * it. Asking starts the measurement, once the surface is prepared and
   * nothing waits in the pool's queue: the measurement holds one worker for
   * seconds, and a tile the ground is waiting for comes first. The streamer
   * asks every frame, so it starts at the first frame the queue is empty.
   *
   * Null for good with no pool: the table is the material's alone, a host
   * without a pool has no material, and the measurement is seconds of a
   * worker that no frame may pay.
   */
  slopes(surface: SurfaceParameters): DepositSlopeTable | null {
    const held = this.#slopes.get(surface)
    if (held !== undefined) return held
    this.#slopesAsked.add(surface)
    if (this.#pool !== null && this.#pool.queued === 0) this.#measure(surface)
    return null
  }

  /**
   * Whether a table `slopes` has been asked for is still to come: asked, not
   * yet measured, not failed, and a pool to measure it. A readout, so it
   * starts nothing — for a capture, which has to wait for the ground's last
   * change of tone the way it waits for the ground's last tile.
   */
  slopesPending(surface: SurfaceParameters): boolean {
    const pool = this.#pool
    return (
      pool !== null &&
      !pool.terminated &&
      this.#slopesAsked.has(surface) &&
      !this.#slopes.has(surface) &&
      !this.#slopesFailed.has(surface)
    )
  }

  /**
   * Settles with the table once `slopes` has one, null where it never will —
   * no pool, a failed measurement, a `clear`. For the orbital bake, which
   * draws a body once and has to draw it with its table, and which starts
   * the measurement whatever is queued: it may be drawing a body whose ground
   * nothing streams, so no frame would ask again.
   */
  whenSlopes(surface: SurfaceParameters): Promise<DepositSlopeTable | null> {
    const held = this.#slopes.get(surface)
    if (held !== undefined) return Promise.resolve(held)
    if (this.#pool === null || this.#slopesFailed.has(surface))
      return Promise.resolve(null)
    let waiting = this.#slopeWaiting.get(surface)
    if (waiting === undefined) {
      let resolve!: (table: DepositSlopeTable | null) => void
      const promise = new Promise<DepositSlopeTable | null>((settle) => {
        resolve = settle
      })
      waiting = { promise, resolve }
      this.#slopeWaiting.set(surface, waiting)
    }
    void this.whenPrepared(surface).then((prepared) => {
      if (prepared === null) this.#settleSlopes(surface, null)
      else this.#measure(surface)
    })
    return waiting.promise
  }

  #measure(surface: SurfaceParameters): void {
    const pool = this.#pool
    if (
      pool === null ||
      pool.terminated ||
      this.#slopes.has(surface) ||
      this.#slopeJobs.has(surface) ||
      this.#slopesFailed.has(surface) ||
      this.prepare(surface) === null
    )
      return
    const job = pool.submit(depositSlopesTask, {
      surface: encodeSurface(surface),
      resolution: this.#resolution,
    })
    this.#slopeJobs.set(surface, job)
    job.result
      .then((table) => {
        this.#slopeJobs.delete(surface)
        this.#slopes.set(surface, table)
        this.#settleSlopes(surface, table)
      })
      .catch((cause: unknown) => {
        this.#slopeJobs.delete(surface)
        const message = cause instanceof Error ? cause.message : String(cause)
        // Canceled by `clear`: released, so the next ask measures again.
        if (message === 'canceled') {
          this.#settleSlopes(surface, null)
          return
        }
        if (message === 'pool terminated') return
        // Held as failed rather than retried every frame; the deposits keep
        // reading the mesh's slope, which is a picture rather than an error.
        this.#slopesFailed.add(surface)
        this.#settleSlopes(surface, null)
        log.warn('deposit slope table failed', { cause: message })
      })
  }

  #settleSlopes(
    surface: SurfaceParameters,
    table: DepositSlopeTable | null,
  ): void {
    this.#slopeWaiting.get(surface)?.resolve(table)
    this.#slopeWaiting.delete(surface)
  }

  /**
   * The surface, once this thread can read it; null while a worker prepares
   * it. Asking is what starts the preparation, and asking again is free.
   *
   * Synchronous with no pool — the headless runner, the tests and the Node
   * benchmarks, none of which have frames to drop.
   */
  prepare(surface: SurfaceParameters): Prepared | null {
    const held = this.#prepared.get(surface)
    if (held !== undefined) return held
    if (this.#pool === null) {
      return this.#settle(
        surface,
        surfaceDetailFloor(surface, this.#resolution),
      )
    }
    // A terminated pool is asked rather than inferred from a rejection: with
    // nothing in flight at `dispose()` there is no rejection to infer it from,
    // and `submit` would throw its invariant into the frame that asked.
    if (
      this.#jobs.has(surface) ||
      this.#failed.has(surface) ||
      this.#pool.terminated
    )
      return null
    this.#submit(this.#pool, surface)
    return null
  }

  /**
   * Settles with the answer once `prepare` has one for `surface`, and starts
   * the preparation if nothing has. It never rejects.
   *
   * Settles with null when `clear` cancels the preparation: the world it was
   * asked for is gone, and the waiter asks again about whatever its address
   * names now. Left pending instead, a waiter on a replaced world's surface
   * waits for an answer nothing will ever ask for.
   *
   * Never settles after the pool is terminated — there is no frame left to
   * spend an answer on — nor for a surface neither thread could prepare,
   * whose field throws for every reader.
   */
  whenPrepared(surface: SurfaceParameters): Promise<Prepared | null> {
    const held = this.prepare(surface)
    if (held !== null) return Promise.resolve(held)
    let waiting = this.#waiting.get(surface)
    if (waiting === undefined) {
      let resolve!: (prepared: Prepared | null) => void
      const promise = new Promise<Prepared | null>((settle) => {
        resolve = settle
      })
      waiting = { promise, resolve }
      this.#waiting.set(surface, waiting)
    }
    return waiting.promise
  }

  /**
   * A source whose requests wait for their surface to be prepared.
   *
   * For a producer that reads the field on this thread — the GPU producer
   * packs the surface for its kernel, and the pack reads the graph. The pool
   * needs none of this: a worker builds its own graph, off this thread.
   */
  holding(source: ArchivedSource): ArchivedSource {
    return new HeldHeightfieldSource(source, this)
  }

  /**
   * Cancel the preparations in flight. The world they were for is gone, and a
   * job left running is a worker the new world's ground queues behind.
   */
  clear(): void {
    for (const job of [...this.#jobs.values()]) job.cancel()
    for (const job of [...this.#slopeJobs.values()]) job.cancel()
  }

  #submit(pool: WorkerPool, surface: SurfaceParameters): void {
    const job = pool.submit(prepareSurfaceTask, {
      surface: encodeSurface(surface),
      resolution: this.#resolution,
    })
    this.#jobs.set(surface, job)
    // One chain rather than `then(ok, fail)`: an answer this thread cannot
    // seed is a failure like any other, and is prepared here.
    job.result
      .then((answer) => {
        this.#jobs.delete(surface)
        // The graph before the floor: a floor is what lets the streamer walk,
        // and the first walk reads the graph through the scatter field.
        seedDrainageGraph(surface, answer.drainage)
        this.#release(surface, this.#settle(surface, answer.level))
      })
      .catch((cause: unknown) => {
        this.#jobs.delete(surface)
        const message = cause instanceof Error ? cause.message : String(cause)
        // This module's own decision arriving back at it — `clear` — so the
        // surface is released and the next ask submits again. Held instead,
        // the surface has no answer and no job, and that body never streams
        // again for the life of the session.
        if (message === 'canceled') {
          this.#release(surface, null)
          return
        }
        // The pool is gone, which is a disposed session and nothing else:
        // `terminate` rejects everything pending with this. Not measured —
        // there is no frame left to spend the answer on, and measuring would
        // put the whole cold cost on the teardown of every session that had a
        // preparation outstanding.
        if (message === 'pool terminated') return
        /*
         * A task failure that will not fix itself on a retry: a worker bundle
         * without `universe.prepareSurface`, a version mismatch across a
         * deploy, a throw inside the search. Releasing the surface instead is
         * a retry with no bound and no backoff — asked once a frame, sixty
         * submissions and sixty warnings a second of a job queued ahead of
         * every heightfield the player is waiting for, while the body never
         * streams at all. So it is answered here, which builds the graph here:
         * one hitch, on a path that runs only when the worker path is broken.
         */
        log.warn('surface preparation failed; preparing it on this thread', {
          cause: message,
        })
        let floor: number
        try {
          floor = surfaceDetailFloor(surface, this.#resolution)
        } catch (failure) {
          this.#failed.add(surface)
          log.error('surface preparation failed on this thread too', {
            cause: failure instanceof Error ? failure.message : String(failure),
          })
          return
        }
        this.#release(surface, this.#settle(surface, floor))
      })
  }

  #settle(surface: SurfaceParameters, floor: number): Prepared {
    const prepared: Prepared = { floor }
    this.#prepared.set(surface, prepared)
    return prepared
  }

  #release(surface: SurfaceParameters, prepared: Prepared | null): void {
    this.#waiting.get(surface)?.resolve(prepared)
    this.#waiting.delete(surface)
  }
}

/**
 * A source that asks the preparation before it asks the producer.
 *
 * A prepared surface goes straight through, with the producer's own handle,
 * and so does one that does not drain: its pack reads a null graph, and
 * holding it would put the orbital bake of a dry world behind a floor search
 * the producer never reads. A held one waits; canceling it while it waits
 * rejects at once and never reaches the producer, the way a canceled pool job
 * never reaches a worker, and so does a preparation `clear` cancels under it.
 */
class HeldHeightfieldSource implements ArchivedSource {
  readonly #source: ArchivedSource
  readonly #preparation: SurfacePreparation
  #nextId = 1
  constructor(source: ArchivedSource, preparation: SurfacePreparation) {
    this.#source = source
    this.#preparation = preparation
  }
  get kind(): string {
    return this.#source.kind
  }
  get archive(): string {
    return this.#source.archive
  }
  get available(): boolean {
    return this.#source.available
  }
  get maxLevel(): number | undefined {
    return this.#source.maxLevel
  }
  supports(request: HeightfieldRequest): boolean {
    return this.#source.supports?.(request) ?? true
  }
  submit(
    surface: SurfaceParameters,
    request: HeightfieldRequest,
    lane?: JobLane,
  ): JobHandle<HeightfieldResponse> {
    if (!drains(surface) || this.#preparation.prepare(surface) !== null) {
      return this.#source.submit(surface, request, lane)
    }
    const id = this.#nextId++
    let active: JobHandle<HeightfieldResponse> | null = null
    let settled = false
    let reject!: (cause: unknown) => void
    const result = new Promise<HeightfieldResponse>((resolve, fail) => {
      reject = fail
      void this.#preparation.whenPrepared(surface).then((prepared) => {
        if (settled) return
        if (prepared === null) {
          settled = true
          fail(new Error('canceled'))
          return
        }
        try {
          active = this.#source.submit(surface, request, lane)
        } catch (cause) {
          settled = true
          fail(cause)
          return
        }
        active.result.then(
          (field) => {
            settled = true
            resolve(field)
          },
          (cause: unknown) => {
            settled = true
            fail(cause)
          },
        )
      })
    })
    return {
      id,
      result,
      cancel: () => {
        if (settled) return
        settled = true
        reject(new Error('canceled'))
        active?.cancel()
      },
    }
  }
}
