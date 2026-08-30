import { ok } from '@inertialref/shared'
import {
  decodeInteger,
  decodeLiteral,
  decodeObject,
  decodeString,
  type Decoder,
} from './codec.ts'

/*
 * Worker protocol.
 *
 * Every message across a worker boundary is one of these envelopes: a request
 * with a job id and a task name, or a response referring back to it. Ad-hoc
 * `postMessage({type: 'doThing'})` calls are what make worker code impossible
 * to instrument, cancel or test, so there is exactly one shape and one place
 * that knows it.
 *
 * `taskVersion` travels with the request so a page that has been open across a
 * deploy — a service-worker-updated app is the normal case for an offline-first
 * game — can detect that its worker is running older code rather than silently
 * mixing two generation algorithms in one universe.
 */

export type JobId = number

export interface WorkerRequest<T = unknown> {
  readonly kind: 'request'
  readonly job: JobId
  readonly task: string
  readonly taskVersion: number
  readonly payload: T
}

export interface WorkerSuccess<T = unknown> {
  readonly kind: 'success'
  readonly job: JobId
  readonly payload: T
  /** Milliseconds spent inside the task, measured in the worker. */
  readonly durationMs: number
}

export interface WorkerFailure {
  readonly kind: 'failure'
  readonly job: JobId
  readonly error: string
}

export interface WorkerCancel {
  readonly kind: 'cancel'
  readonly job: JobId
}

/**
 * How much of itself the worker should describe on its own timeline.
 *
 * A message rather than a query on the worker's URL, and the four reasons are
 * worth keeping because the URL idea comes back:
 *
 *   - `browserWorker.ts` uses the statically analyzed
 *     `new Worker(new URL('…', import.meta.url))` form. Interpolating a runtime
 *     value defeats Vite's detection and the worker chunk stops being emitted.
 *   - `apps/game/public/sw.js` treats `/assets/` as cache-first with a bare
 *     `caches.match(request)` and no `ignoreSearch`, so a query-suffixed worker
 *     misses the cache on an offline launch.
 *   - Inside a module worker the query is on `self.location.search`, not on
 *     `new URL(import.meta.url).searchParams`.
 *   - And the premise is false anyway. A URL is read once at spawn, while the
 *     level changes mid-session from `ir.timing()` and from the performance
 *     panel — which would leave the worker tracks silently empty for the rest
 *     of the session.
 *
 * `level` is a bare string here on purpose. Which levels exist is the host's
 * vocabulary, not the protocol's; this validates that a string arrived and the
 * worker entry decides whether it names anything.
 */
export interface WorkerTiming {
  readonly kind: 'timing'
  readonly level: string
}

export interface WorkerReady {
  readonly kind: 'ready'
  readonly tasks: readonly string[]
}

export type WorkerInbound = WorkerRequest | WorkerCancel | WorkerTiming
export type WorkerOutbound = WorkerSuccess | WorkerFailure | WorkerReady

/**
 * Validate an inbound request envelope.
 *
 * `payload` stays `unknown` on purpose — its shape is the task's business, and
 * the task registry is what knows which task expects what. Everything the host
 * loop itself dereferences (`job`, `task`, `taskVersion`) is checked here,
 * which it previously was not: the loop read them off an unvalidated object and
 * handed `payload` to `task.run` as `never`.
 */
export const decodeWorkerRequest: Decoder<WorkerRequest> = decodeObject({
  kind: decodeLiteral('request'),
  job: decodeInteger,
  task: decodeString,
  taskVersion: decodeInteger,
  payload: (value) => ok(value),
})

export const isWorkerCancel = (message: unknown): message is WorkerCancel =>
  typeof message === 'object' &&
  message !== null &&
  (message as { kind?: unknown }).kind === 'cancel'

export const isWorkerTiming = (message: unknown): message is WorkerTiming =>
  typeof message === 'object' &&
  message !== null &&
  (message as { kind?: unknown }).kind === 'timing' &&
  typeof (message as { level?: unknown }).level === 'string'
