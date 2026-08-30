import {
  getLogger,
  getTimer,
  invariant,
  type Logger,
  type TimingDetail,
} from '@inertialref/shared'
import type { JobId, WorkerOutbound } from '@inertialref/protocol'
import type { TaskDefinition } from './task.ts'
import type { WorkerFactory, WorkerPort } from './transport.ts'

/*
 * The worker pool.
 *
 * One place in the codebase creates workers, one place routes jobs to them, one
 * place measures them. The spec's rule — no ad-hoc `new Worker()` at call sites
 * — is not fussiness: without a single owner there is nowhere to put
 * cancellation, nowhere to put backpressure, and no way to answer "is the queue
 * the problem?" when the frame rate drops.
 *
 * Instrumentation separates queue latency from execution time on purpose. They
 * fail differently: slow tasks want optimization, a deep queue wants more
 * workers or fewer requests.
 *
 * Both of those are also emitted onto a timeline, from the numbers `PendingJob`
 * already holds — `enqueuedAt`, `dispatchedAt`, and the moment the answer
 * arrives. As `PoolStats` they are two rolling means over the last 64 jobs; as
 * a track they are the *shape* of the queue, and the difference is that you can
 * see which frame the depth started at. A `generateHeightfield` at 37 ms
 * appears in the same recording as the frame that drew coarse ground because it
 * was still waiting, which is a picture this project could not previously draw.
 *
 * `getTimer` is called here directly, exactly as `getLogger` is two lines
 * below, and for the same reason: it is a workspace import at layer 0 rather
 * than a host API. The plan proposed `PoolOptions.timing?: Timer` on the
 * strength of the port rule, but the thing that actually needs a port is the
 * *clock*, and `PoolOptions.now` already is one.
 *
 * **Each side emits only its own numbers.** `console.timeStamp`'s arguments are
 * milliseconds against `performance.timeOrigin`, and a worker's origin is not
 * the page's — so a start time computed on one thread and emitted on another
 * lands on the timeline wrong by however long the worker took to spawn. The
 * pool never emits a worker's run and the worker never emits the pool's queue.
 * The two `run` figures differ by construction and both are wanted: this one is
 * dispatch to answer-in-hand, including the round trip, and the worker's is the
 * task on its own thread.
 */

const timer = getTimer('workers.pool')

/*
 * No `group` on either: the track name is the pool describing itself, which is
 * the same thing the logger scope above already is, while the group is the
 * host's branding. The browser sink fills it in.
 */
const QUEUE_DETAIL: TimingDetail = Object.freeze({
  track: 'Workers',
  color: 'secondary-light',
})

const RUN_DETAIL: TimingDetail = Object.freeze({
  track: 'Workers',
  color: 'secondary-dark',
})

export interface PoolOptions {
  readonly factory: WorkerFactory
  readonly size: number
  /** Injected clock, so the pool has no host API dependency and tests are exact. */
  readonly now?: () => number
}

export interface PoolStats {
  readonly workers: number
  readonly idle: number
  readonly queued: number
  readonly active: number
  readonly completed: number
  readonly failed: number
  readonly cancelled: number
  /** Rolling mean over the last 64 jobs, milliseconds. */
  readonly averageQueueMs: number
  readonly averageRunMs: number
  readonly longestQueueMs: number
}

interface PendingJob {
  readonly id: JobId
  readonly task: string
  readonly taskVersion: number
  readonly payload: unknown
  readonly transfer: readonly ArrayBufferLike[]
  readonly enqueuedAt: number
  readonly resolve: (value: never) => void
  readonly reject: (reason: Error) => void
  dispatchedAt: number
}

interface PooledWorker {
  readonly port: WorkerPort
  readonly index: number
  job: PendingJob | null
}

export interface JobHandle<Response> {
  readonly id: JobId
  readonly result: Promise<Response>
  cancel(): void
}

export class WorkerPool {
  #nextJobId: JobId = 1
  readonly #workers: PooledWorker[] = []
  readonly #queue: PendingJob[] = []
  readonly #active = new Map<JobId, PendingJob>()
  readonly #now: () => number
  readonly #log: Logger
  readonly #queueSamples: number[] = []
  readonly #runSamples: number[] = []
  #completed = 0
  #failed = 0
  #cancelled = 0
  #longestQueueMs = 0
  #terminated = false
  /**
   * The level last broadcast, so a worker that has not heard yet can be told.
   *
   * Every worker is spawned in the constructor here, so in practice this is
   * only the ordering between construction and the host's first
   * `setTimingLevel`. A worker that has not heard is `off`, which is the right
   * default for the frame or two it lasts.
   */
  #timingLevel = 'off'

  /**
   * Whether `#now` is a clock or the zero stand-in.
   *
   * The zero default is harmless in a `PoolStats` figure — an average of 0 ms
   * is obviously untimed — and not harmless on a shared axis, where it stacks
   * every `queue` and `run` entry at t=0 beside entries the host is timing with
   * `performance.now()`. That is the case `AttachOptions.now` refuses outright
   * by throwing; a pool cannot throw, because a pool without a clock is a
   * supported thing that simply has no timeline coordinates to offer. It keeps
   * its stats and emits nothing.
   */
  readonly #timed: boolean

  constructor(options: PoolOptions) {
    invariant(options.size > 0, 'A worker pool needs at least one worker')
    this.#now = options.now ?? (() => 0)
    this.#timed = options.now !== undefined
    this.#log = getLogger('workers.pool')
    for (let index = 0; index < options.size; index += 1) {
      const port = options.factory(index)
      const worker: PooledWorker = { port, index, job: null }
      port.subscribe((message) => this.#receive(worker, message))
      this.#workers.push(worker)
    }
  }

  /** Submit a job. The handle can be canceled whether or not it has started. */
  submit<Request, Response>(
    task: TaskDefinition<Request, Response>,
    payload: Request,
    transfer: readonly ArrayBufferLike[] = [],
  ): JobHandle<Response> {
    invariant(!this.#terminated, 'Worker pool has been terminated')
    const id = this.#nextJobId++
    let resolve!: (value: never) => void
    let reject!: (reason: Error) => void
    const result = new Promise<Response>((res, rej) => {
      resolve = res as unknown as (value: never) => void
      reject = rej
    })
    const job: PendingJob = {
      id,
      task: task.name,
      taskVersion: task.version,
      payload,
      transfer,
      enqueuedAt: this.#now(),
      dispatchedAt: 0,
      resolve,
      reject,
    }
    this.#queue.push(job)
    this.#pump()
    return { id, result, cancel: () => this.cancel(id) }
  }

  run<Request, Response>(
    task: TaskDefinition<Request, Response>,
    payload: Request,
    transfer: readonly ArrayBufferLike[] = [],
  ): Promise<Response> {
    return this.submit(task, payload, transfer).result
  }

  cancel(id: JobId): void {
    const queuedIndex = this.#queue.findIndex((job) => job.id === id)
    if (queuedIndex >= 0) {
      const [job] = this.#queue.splice(queuedIndex, 1)
      this.#cancelled += 1
      job?.reject(new Error('cancelled'))
      return
    }
    const active = this.#active.get(id)
    if (active === undefined) return
    for (const worker of this.#workers) {
      if (worker.job?.id === id) worker.port.post({ kind: 'cancel', job: id })
    }
  }

  /**
   * Jobs waiting for a worker.
   *
   * Beside `stats()` because the performance overlay samples it every frame and
   * `stats()` allocates — an object, and an array to count the idle workers.
   */
  get queued(): number {
    return this.#queue.length
  }

  /**
   * Tell every worker how much of itself to describe.
   *
   * Broadcast on every change rather than read once at spawn, because the level
   * changes mid-session — `ir.timing()`, the performance panel — and a value
   * fixed at construction would leave the worker tracks empty for the rest of
   * it. `WorkerTiming` in the protocol package carries the rest of the argument,
   * including the three other reasons a query on the worker's URL does not work.
   */
  setTimingLevel(level: string): void {
    if (level === this.#timingLevel) return
    this.#timingLevel = level
    for (const worker of this.#workers)
      worker.port.post({ kind: 'timing', level })
  }

  stats(): PoolStats {
    return {
      workers: this.#workers.length,
      idle: this.#workers.filter((w) => w.job === null).length,
      queued: this.#queue.length,
      active: this.#active.size,
      completed: this.#completed,
      failed: this.#failed,
      cancelled: this.#cancelled,
      averageQueueMs: mean(this.#queueSamples),
      averageRunMs: mean(this.#runSamples),
      longestQueueMs: this.#longestQueueMs,
    }
  }

  terminate(): void {
    this.#terminated = true
    for (const job of this.#queue.splice(0))
      job.reject(new Error('pool terminated'))
    for (const job of this.#active.values())
      job.reject(new Error('pool terminated'))
    this.#active.clear()
    for (const worker of this.#workers) worker.port.terminate()
  }

  #pump(): void {
    for (const worker of this.#workers) {
      if (worker.job !== null) continue
      const job = this.#queue.shift()
      if (job === undefined) return
      job.dispatchedAt = this.#now()
      const waited = job.dispatchedAt - job.enqueuedAt
      sample(this.#queueSamples, waited)
      this.#longestQueueMs = Math.max(this.#longestQueueMs, waited)
      // From the two numbers the job already carries; no clock read of its own.
      if (this.#timed && timer.on)
        timer.measure(
          `queue ${job.task}`,
          job.enqueuedAt,
          job.dispatchedAt,
          QUEUE_DETAIL,
        )
      worker.job = job
      this.#active.set(job.id, job)
      try {
        worker.port.post(
          {
            kind: 'request',
            job: job.id,
            task: job.task,
            taskVersion: job.taskVersion,
            payload: job.payload,
          },
          job.transfer,
        )
      } catch (cause) {
        // `postMessage` throws synchronously on a payload that is not
        // structured-cloneable. Without this the job stayed in `#active` with
        // nobody ever settling its promise, so the caller hung and the failure
        // only surfaced later as an unhandled rejection from `terminate`.
        this.#active.delete(job.id)
        worker.job = null
        job.reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    }
  }

  #receive(worker: PooledWorker, message: WorkerOutbound): void {
    if (message.kind === 'ready') {
      this.#log.debug('worker ready', {
        index: worker.index,
        tasks: message.tasks.length,
      })
      return
    }

    const job = this.#active.get(message.job)
    if (job === undefined) return
    this.#active.delete(message.job)
    if (worker.job?.id === message.job) worker.job = null

    /*
     * Dispatch to answer-in-hand, on the page's clock.
     *
     * Deliberately not `message.durationMs`: that is the task's own time,
     * measured on the worker's thread against the worker's `timeOrigin`, and
     * plotting it against page time would place it wrong by however long the
     * worker took to spawn. The worker emits that one itself. The difference
     * between the two entries is the round trip and the structured clone, which
     * is a cost nothing here previously attributed to anything.
     *
     * Cancellations and failures are timed too — a job that took 40 ms to fail
     * occupied a worker for 40 ms, and a track that only showed successes would
     * make a thrashing streamer look idle.
     */
    if (this.#timed && timer.on)
      timer.measure(
        `run ${job.task}`,
        job.dispatchedAt,
        this.#now(),
        RUN_DETAIL,
      )

    if (message.kind === 'success') {
      sample(this.#runSamples, message.durationMs)
      this.#completed += 1
      job.resolve(message.payload as never)
    } else if (message.error === 'cancelled') {
      this.#cancelled += 1
      job.reject(new Error('cancelled'))
    } else {
      this.#failed += 1
      job.reject(new Error(message.error))
    }
    this.#pump()
  }
}

const SAMPLE_WINDOW = 64

function sample(samples: number[], value: number): void {
  samples.push(value)
  if (samples.length > SAMPLE_WINDOW) samples.shift()
}

function mean(samples: readonly number[]): number {
  if (samples.length === 0) return 0
  let total = 0
  for (const value of samples) total += value
  return total / samples.length
}
