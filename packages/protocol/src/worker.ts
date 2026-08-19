import { ok } from '@inertialref/shared'
import { decodeInteger, decodeLiteral, decodeObject, decodeString, type Decoder } from './codec.ts'

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

export interface WorkerReady {
  readonly kind: 'ready'
  readonly tasks: readonly string[]
}

export type WorkerInbound = WorkerRequest | WorkerCancel
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
  typeof message === 'object' && message !== null && (message as { kind?: unknown }).kind === 'cancel'
