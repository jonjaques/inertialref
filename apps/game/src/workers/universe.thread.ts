/*
 * The worker entry, for `node:worker_threads`.
 *
 * `universe.worker.ts` with `parentPort` for the global scope: the same
 * registry, the same host loop, and a thread boundary that structured-clones
 * every message and honors the transfer list exactly as a browser Worker's
 * does. Node loads it directly under type stripping, outside vitest's module
 * graph, so it imports nothing a bare Node resolution cannot reach.
 */
import { parentPort } from 'node:worker_threads'
import { serveTasks } from '@inertialref/workers'
import type { WorkerInbound, WorkerOutbound } from '@inertialref/protocol'
import { createGameTaskRegistry } from './registry.ts'

const port = parentPort
if (port === null) throw new Error('universe.thread.ts runs as a worker thread')

serveTasks(createGameTaskRegistry(), {
  post(message: WorkerOutbound, transfer: readonly ArrayBufferLike[] = []) {
    port.postMessage(message, transfer as ArrayBuffer[])
  },
  subscribe(handler: (message: WorkerInbound) => void) {
    const listener = (message: WorkerInbound): void => handler(message)
    port.on('message', listener)
    return () => port.off('message', listener)
  },
})
