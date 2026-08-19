import type { WorkerInbound, WorkerOutbound } from '@inertialref/protocol'

/*
 * The host boundary.
 *
 * `packages/*` has no DOM lib, deliberately, so this package cannot mention
 * `Worker`. It does not need to: a Worker structurally satisfies `WorkerPort`
 * once the host wraps it, and defining the port rather than the class is what
 * lets the pool be driven by an in-process fake in tests, by a real Worker in
 * the browser, and by `node:worker_threads` on a server, with no branching in
 * the pool itself.
 */

export interface WorkerPort {
  post(message: WorkerInbound, transfer?: readonly ArrayBufferLike[]): void
  /** Returns an unsubscribe function. */
  subscribe(handler: (message: WorkerOutbound) => void): () => void
  terminate(): void
}

export type WorkerFactory = (index: number) => WorkerPort

/** The other side: what a worker entry point implements. */
export interface HostPort {
  post(message: WorkerOutbound, transfer?: readonly ArrayBufferLike[]): void
  subscribe(handler: (message: WorkerInbound) => void): () => void
}
