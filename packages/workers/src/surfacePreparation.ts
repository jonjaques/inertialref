import { getLogger } from '@inertialref/shared'
import {
  HEIGHTFIELD_RESOLUTION,
  type HeightfieldRequest,
  seedDrainageGraph,
  surfaceDetailFloor,
  type SurfaceParameters,
} from '@inertialref/universe'
import type { JobHandle, WorkerPool } from './pool.ts'
import {
  type ArchivedSource,
  encodeSurface,
  type HeightfieldResponse,
  prepareSurfaceTask,
} from './tasks.ts'

/*
 * A body's ground, made readable on this thread without stalling it.
 *
 * Two things about a surface are cold once per body per thread and too slow
 * for a frame: the detail floor, 33-43 ms of probe search, and the drainage
 * graph, 50 to 140 ms of lattice and flood. Everything that reads a wet body's
 * ground on the draw thread reads the graph — the site list, the scatter
 * field's one sample a frame, the GPU producer's pack — and each is the first
 * asker somewhere: the site list on focusing a body in the planetarium, the
 * scatter field as the ground arrives under a ship, the producer for the
 * orbital bake on arriving at a generated world. So the answer cannot live in
 * any one of them.
 *
 * A worker prepares the surface: the floor, and the graph the floor search
 * builds on its way. The answer seeds this thread's drainage memo before the
 * floor is published, so whatever asks after "is it prepared" finds the graph
 * a lookup. The streamer holds the ground back until then, the GPU producer's
 * requests are held through `holding`, and the site list waits on
 * `whenPrepared` — each the shape it already had for the heightfields
 * themselves.
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
  readonly promise: Promise<Prepared>
  readonly resolve: (prepared: Prepared) => void
}

export class SurfacePreparation {
  readonly #pool: WorkerPool | null
  readonly #resolution: number
  /*
   * Keyed on the `SurfaceParameters` object, for the reason the streamer kept
   * its floors that way: it is immutable, it belongs to the loaded body, and a
   * reseed under the same address produces a new one — so a new world cannot
   * inherit the old one's answer, and nothing has to clear this.
   */
  readonly #prepared = new WeakMap<SurfaceParameters, Prepared>()
  readonly #jobs = new Map<SurfaceParameters, JobHandle<unknown>>()
  readonly #waiting = new WeakMap<SurfaceParameters, Waiting>()
  readonly #listeners = new Set<(surface: SurfaceParameters) => void>()
  #terminated = false

  constructor(
    pool: WorkerPool | null,
    resolution: number = HEIGHTFIELD_RESOLUTION,
  ) {
    this.#pool = pool
    this.#resolution = resolution
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
    if (this.#jobs.has(surface) || this.#terminated) return null
    this.#submit(this.#pool, surface)
    return null
  }

  /**
   * Settles once `prepare` answers for `surface`, and starts the preparation
   * if nothing has. It never rejects, and after the pool is terminated it
   * never settles: there is no frame left to spend an answer on.
   */
  whenPrepared(surface: SurfaceParameters): Promise<Prepared> {
    const held = this.prepare(surface)
    if (held !== null) return Promise.resolve(held)
    let waiting = this.#waiting.get(surface)
    if (waiting === undefined) {
      let resolve!: (prepared: Prepared) => void
      const promise = new Promise<Prepared>((settle) => {
        resolve = settle
      })
      waiting = { promise, resolve }
      this.#waiting.set(surface, waiting)
    }
    return waiting.promise
  }

  /** Hear about every surface as it becomes prepared. */
  subscribe(listener: (surface: SurfaceParameters) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
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
  }

  #submit(pool: WorkerPool, surface: SurfaceParameters): void {
    const job = pool.submit(prepareSurfaceTask, {
      surface: encodeSurface(surface),
      resolution: this.#resolution,
    })
    this.#jobs.set(surface, job)
    job.result
      .then((answer) => {
        this.#jobs.delete(surface)
        // The graph before the floor: a floor is what lets the streamer walk,
        // and the first walk reads the graph through the scatter field.
        seedDrainageGraph(surface, answer.drainage)
        this.#arrived(surface, this.#settle(surface, answer.level))
      })
      .catch((cause: unknown) => {
        this.#jobs.delete(surface)
        const message = cause instanceof Error ? cause.message : String(cause)
        // This module's own decision arriving back at it — `clear` — so the
        // surface is released and the next ask submits again. Held instead,
        // the surface has no answer and no job, and that body never streams
        // again for the life of the session.
        if (message === 'canceled') return
        // The pool is gone, which is a disposed session and nothing else:
        // `terminate` rejects everything pending with this. Not measured —
        // there is no frame left to spend the answer on, and measuring would
        // put the whole cold cost on the teardown of every session that had a
        // preparation outstanding — and nothing is submitted again, because
        // `submit` on a terminated pool throws its invariant into the frame.
        if (message === 'pool terminated') {
          this.#terminated = true
          return
        }
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
        this.#arrived(
          surface,
          this.#settle(surface, surfaceDetailFloor(surface, this.#resolution)),
        )
      })
  }

  #settle(surface: SurfaceParameters, floor: number): Prepared {
    const prepared: Prepared = { floor }
    this.#prepared.set(surface, prepared)
    return prepared
  }

  /*
   * Only an answer that arrives later is announced. The synchronous one is
   * returned to the caller that asked, inside its own frame, and a listener
   * bumping the streamer's epoch from inside the update that asked would
   * stale a selection that has not been made yet.
   */
  #arrived(surface: SurfaceParameters, prepared: Prepared): void {
    this.#waiting.get(surface)?.resolve(prepared)
    this.#waiting.delete(surface)
    for (const listener of this.#listeners) listener(surface)
  }
}

/**
 * A source that asks the preparation before it asks the producer.
 *
 * A prepared surface goes straight through, with the producer's own handle. A
 * held one waits; canceling it while it waits rejects at once and never
 * reaches the producer, the way a canceled pool job never reaches a worker.
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
  ): JobHandle<HeightfieldResponse> {
    if (this.#preparation.prepare(surface) !== null) {
      return this.#source.submit(surface, request)
    }
    const id = this.#nextId++
    let active: JobHandle<HeightfieldResponse> | null = null
    let settled = false
    let reject!: (cause: unknown) => void
    const result = new Promise<HeightfieldResponse>((resolve, fail) => {
      reject = fail
      void this.#preparation.whenPrepared(surface).then(() => {
        if (settled) return
        try {
          active = this.#source.submit(surface, request)
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
