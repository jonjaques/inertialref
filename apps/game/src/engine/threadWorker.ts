import { Worker } from 'node:worker_threads'
import type { WorkerInbound, WorkerOutbound } from '@inertialref/protocol'
import type { WorkerPort } from '@inertialref/workers'

/*
 * The one place that constructs a `node:worker_threads` Worker.
 *
 * `browserWorker.ts` adapts a browser Worker to `WorkerPort`; this adapts a
 * Node one, for the tests that drive `GameEngine` through `headlessEngine`.
 * A thread's `postMessage` is the same structured clone with the same transfer
 * list, so a payload a browser Worker would refuse is refused here too. Only
 * Node test code imports this file; the browser bundle never reaches it.
 */
export function createThreadWorkerPort(): WorkerPort {
  const worker = new Worker(
    new URL('../workers/universe.thread.ts', import.meta.url),
    { name: 'inertialref-universe' },
  )
  return {
    post(message: WorkerInbound, transfer: readonly ArrayBufferLike[] = []) {
      worker.postMessage(message, transfer as ArrayBuffer[])
    },
    subscribe(handler: (message: WorkerOutbound) => void) {
      const listener = (message: WorkerOutbound): void => handler(message)
      worker.on('message', listener)
      return () => worker.off('message', listener)
    },
    terminate() {
      void worker.terminate()
    },
  }
}
