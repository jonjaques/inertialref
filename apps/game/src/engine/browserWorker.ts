import type { WorkerInbound, WorkerOutbound } from '@inertialref/protocol'
import type { WorkerPort } from '@inertialref/workers'

/*
 * The one place in the codebase that constructs a Worker.
 *
 * `packages/workers` defines the port; this adapts a real browser Worker to it.
 * Keeping the construction here rather than at call sites is the spec's rule,
 * and the practical benefit is that the worker URL, the module type and the
 * transfer list are decided once.
 */
export function createBrowserWorkerPort(): WorkerPort {
  const worker = new Worker(
    new URL('../workers/universe.worker.ts', import.meta.url),
    {
      type: 'module',
      name: 'inertialref-universe',
    },
  )

  return {
    post(message: WorkerInbound, transfer: readonly ArrayBufferLike[] = []) {
      worker.postMessage(message, transfer as Transferable[])
    },
    subscribe(handler: (message: WorkerOutbound) => void) {
      const listener = (event: MessageEvent): void =>
        handler(event.data as WorkerOutbound)
      worker.addEventListener('message', listener)
      return () => worker.removeEventListener('message', listener)
    },
    terminate() {
      worker.terminate()
    },
  }
}

/** How many workers to spawn. Leaves the main thread and one core for the browser. */
export function poolSize(): number {
  const cores = navigator.hardwareConcurrency ?? 4
  return Math.max(1, Math.min(4, cores - 2))
}
