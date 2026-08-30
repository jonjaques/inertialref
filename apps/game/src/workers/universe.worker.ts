/*
 * Worker entry point.
 *
 * Three lines of real code: build the registry, adapt the global scope to the
 * host port, serve. Everything worth testing is in `packages/workers`, which is
 * why this file has no logic to get wrong.
 */
import { serveTasks, createTaskRegistry } from '@inertialref/workers'
import type { WorkerInbound, WorkerOutbound } from '@inertialref/protocol'
import { isTimingLevel, setTimingLevel } from '../engine/browserTiming.ts'

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
  {
    now: () => performance.now(),
    /*
     * This scope has its own module registry and therefore its own timing hub,
     * so the page's level does not reach it — the pool sends it. The same sink
     * module runs here: it names only `console.timeStamp` and `performance`,
     * both of which a worker has, and it never touches `window`.
     *
     * A level this build does not know is ignored rather than defaulted, which
     * is what makes a page open across a deploy safe: an older worker meeting a
     * newer level stays at whatever it was, instead of guessing.
     */
    onTimingLevel: (level) => {
      if (isTimingLevel(level)) setTimingLevel(level)
    },
  },
)
