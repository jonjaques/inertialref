import type { WorkerInbound, WorkerOutbound } from '@inertialref/protocol'
import { serveTasks } from './host.ts'
import type { TaskRegistry } from './task.ts'
import type { HostPort, WorkerPort } from './transport.ts'

/*
 * An in-process "worker".
 *
 * Runs the real host loop against the real registry, with a microtask instead
 * of a thread boundary. Two jobs:
 *
 *   - It makes the pool testable in Node with no worker environment, which is
 *     the spec's "keep worker APIs testable outside the worker" requirement.
 *   - It is the transport the headless runner uses in production.
 *
 * It is *not* the browser's degradation path. A browser without module workers
 * gets no pool at all (see `openSession`), which means main-thread generation
 * for the starfield and no terrain streaming until a pool exists. Saying
 * otherwise here implied a fallback that does not exist.
 *
 * Messages go through `structuredClone`, and `post` honours its transfer list.
 * Neither used to be true — the object was passed by reference and `transfer`
 * was dropped — so a payload holding a `Map`, a class instance or a function
 * passed every Node test and threw `DataCloneError` in Chrome, and a transferred
 * `Float32Array` stayed live on both sides here while being detached there. Two
 * adapters at one seam have to agree about aliasing or the seam is decorative.
 *
 * Delivery is deferred through a resolved promise rather than `queueMicrotask`:
 * same scheduling, but it is plain ECMAScript, and this package deliberately
 * has no host globals available to it.
 */
// Available in every runtime this package targets — browser, worker and Node —
// but not in the ES2023 lib, and `packages/*` deliberately pulls in neither DOM
// nor Node type definitions. `world.test.ts` declares it the same way.
declare const structuredClone: <T>(
  value: T,
  options?: { transfer?: unknown[] },
) => T

const defer = (run: () => void): void => {
  void Promise.resolve().then(run)
}

export function createInlineWorker(
  registry: TaskRegistry,
  now: () => number = () => 0,
): WorkerPort {
  const toWorker = new Set<(message: WorkerInbound) => void>()
  const toHost = new Set<(message: WorkerOutbound) => void>()
  let terminated = false

  const hostSide: HostPort = {
    post(message, transfer = []) {
      if (terminated) return
      const copy = structuredClone(message, { transfer: [...transfer] })
      defer(() => {
        for (const handler of toHost) handler(copy)
      })
    },
    subscribe(handler) {
      toWorker.add(handler)
      return () => toWorker.delete(handler)
    },
  }

  serveTasks(registry, hostSide, { now })

  return {
    post(message, transfer = []) {
      if (terminated) return
      const copy = structuredClone(message, { transfer: [...transfer] })
      defer(() => {
        for (const handler of toWorker) handler(copy)
      })
    },
    subscribe(handler) {
      toHost.add(handler)
      return () => toHost.delete(handler)
    },
    terminate() {
      terminated = true
      toWorker.clear()
      toHost.clear()
    },
  }
}
