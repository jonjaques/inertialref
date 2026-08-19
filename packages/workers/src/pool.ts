import { getLogger, invariant, type Logger } from '@inertialref/shared'
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
 * fail differently: slow tasks want optimisation, a deep queue wants more
 * workers or fewer requests.
 */

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

  constructor(options: PoolOptions) {
    invariant(options.size > 0, 'A worker pool needs at least one worker')
    this.#now = options.now ?? (() => 0)
    this.#log = getLogger('workers.pool')
    for (let index = 0; index < options.size; index += 1) {
      const port = options.factory(index)
      const worker: PooledWorker = { port, index, job: null }
      port.subscribe((message) => this.#receive(worker, message))
      this.#workers.push(worker)
    }
  }

  /** Submit a job. The handle can be cancelled whether or not it has started. */
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
    for (const job of this.#queue.splice(0)) job.reject(new Error('pool terminated'))
    for (const job of this.#active.values()) job.reject(new Error('pool terminated'))
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
      this.#log.debug('worker ready', { index: worker.index, tasks: message.tasks.length })
      return
    }

    const job = this.#active.get(message.job)
    if (job === undefined) return
    this.#active.delete(message.job)
    if (worker.job?.id === message.job) worker.job = null

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
