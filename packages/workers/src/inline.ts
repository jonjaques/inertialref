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
 *   - It is the fallback when a host has no workers at all, so the game
 *     degrades to running generation on the main thread rather than failing.
 *
 * Messages are still serialised through the same envelopes, so a bug that only
 * appears once something is not structured-cloneable still shows up here.
 *
 * Delivery is deferred through a resolved promise rather than `queueMicrotask`:
 * same scheduling, but it is plain ECMAScript, and this package deliberately
 * has no host globals available to it.
 */
const defer = (run: () => void): void => {
  void Promise.resolve().then(run)
}

export function createInlineWorker(registry: TaskRegistry, now: () => number = () => 0): WorkerPort {
  const toWorker = new Set<(message: WorkerInbound) => void>()
  const toHost = new Set<(message: WorkerOutbound) => void>()
  let terminated = false

  const hostSide: HostPort = {
    post(message) {
      if (terminated) return
      defer(() => {
        for (const handler of toHost) handler(message)
      })
    },
    subscribe(handler) {
      toWorker.add(handler)
      return () => toWorker.delete(handler)
    },
  }

  serveTasks(registry, hostSide, { now })

  return {
    post(message) {
      if (terminated) return
      defer(() => {
        for (const handler of toWorker) handler(message)
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
