import type { WorkerInbound, WorkerOutbound } from '@inertialref/protocol'
import { QUERY } from '../pages/paths.ts'
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

/**
 * How many workers to spawn. Leaves the main thread and one core for the browser.
 *
 * The ceiling is eight because four was leaving convergence on the table and
 * nothing had measured it. `IN_FLIGHT_CAP` over `poolSize()` workers times the
 * run time *is* the queue, by construction, so the only question that mattered
 * was whether extra workers dilate each job by more than the parallelism buys.
 * Measured on an Apple M5 (4P+6E, `hardwareConcurrency` 10), landing on Mars
 * and letting it converge for twenty seconds:
 *
 * | workers | jobs/s | mean run | mean queue | drawn level |
 * | ------: | -----: | -------: | ---------: | ----------: |
 * |       4 |   30.4 |   129 ms |    4,037 ms |          10 |
 * |       6 |   34.2 |   175 ms |    3,730 ms |          11 |
 * |       8 |   41.6 |   187 ms |    2,876 ms |          13 |
 *
 * Runs do dilate — 45% from four to eight, the extra threads landing on
 * E-cores — and it is not close: throughput is up 37%, the queue is down a
 * second, and the number a player watches goes up three levels in the same
 * twenty seconds. The frame does not pay for it: over a six-second profile
 * during convergence, `Engine/frame` was 16.67 ms mean and 23.3 p95 at four
 * against 16.71 and 19.3 at eight, with fourteen late frames against twelve.
 *
 * `cores - 2` is unchanged, so this only moves machines with eight logical
 * cores or more, and the two figures it is measured against are one machine's.
 * The case it is least sure of is SMT: `hardwareConcurrency` counts threads,
 * so sixteen threads on eight physical cores gets eight workers and the main
 * thread shares a core with one of them. `?workers=` is how to re-run the
 * table there rather than guess.
 */
export function poolSize(): number {
  const cores = navigator.hardwareConcurrency ?? 4
  // `typeof` rather than a bare read: the tests run in plain Node, which has a
  // `navigator` and no `location`, and `GameEngine` calls this in its own
  // constructor. That is the check that the engine stays runnable off a DOM.
  const search = typeof location === 'undefined' ? '' : location.search
  const asked = Number(new URLSearchParams(search).get(QUERY.workers))
  // Bounded, because it is a URL: an unbounded one spawns whatever it says.
  if (Number.isInteger(asked) && asked > 0) return Math.min(asked, 16)
  return Math.max(1, Math.min(8, cores - 2))
}
