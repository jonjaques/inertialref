/*
 * Worker entry point.
 *
 * Three lines of real code: build the registry, adapt the global scope to the
 * host port, serve. Everything worth testing is in `packages/workers`, which is
 * why this file has no logic to get wrong.
 */
import { serveTasks, createTaskRegistry } from '@inertialref/workers'
import type { WorkerInbound, WorkerOutbound } from '@inertialref/protocol'

const scope = self as unknown as DedicatedWorkerGlobalScope

serveTasks(
  createTaskRegistry(),
  {
    post(message: WorkerOutbound, transfer: readonly ArrayBufferLike[] = []) {
      scope.postMessage(message, transfer as Transferable[])
    },
    subscribe(handler: (message: WorkerInbound) => void) {
      const listener = (event: MessageEvent): void =>
        handler(event.data as WorkerInbound)
      scope.addEventListener('message', listener)
      return () => scope.removeEventListener('message', listener)
    },
  },
  { now: () => performance.now() },
)
