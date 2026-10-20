import { Worker } from 'node:worker_threads'
import type {
  JobId,
  WorkerInbound,
  WorkerOutbound,
} from '@inertialref/protocol'
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
  return threadWorkerPort(
    new URL('../workers/universe.thread.ts', import.meta.url),
  )
}

/**
 * The port over any thread entry. `createThreadWorkerPort` is the game's; a
 * test hands this one a thread that dies, which the game's never does on cue.
 */
export function threadWorkerPort(entry: URL): WorkerPort {
  const worker = new Worker(entry, { name: 'inertialref-universe' })
  const handlers = new Set<(message: WorkerOutbound) => void>()
  const emit = (message: WorkerOutbound): void => {
    for (const handler of handlers) handler(message)
  }

  /*
   * A thread that dies answers nothing, and the pool has no other signal.
   *
   * An uncaught throw in the thread, or a module that fails to load under type
   * stripping, ends it with an `error` event; a `postMessage` to it afterwards
   * is dropped without a word. Left at that, the job it held stays active in
   * the pool forever — the slow descent's drain waits on it until its
   * ten-minute timeout — and Node rethrows the unlistened `error` on the main
   * thread. So the port remembers the requests it carries and fails them with
   * the thread's own error, and fails every later one the same way.
   */
  const inFlight = new Set<JobId>()
  let dead: string | null = null
  const fail = (job: JobId): void => {
    inFlight.delete(job)
    emit({ kind: 'failure', job, error: dead ?? 'worker thread exited' })
  }
  const die = (reason: string): void => {
    dead ??= reason
    for (const job of [...inFlight]) fail(job)
  }
  // A worker's uncaught throw arrives as whatever it threw, not always an Error.
  worker.on('error', (cause) =>
    die(
      `worker thread failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    ),
  )
  worker.on('exit', (code) => die(`worker thread exited with code ${code}`))
  worker.on('message', (message: WorkerOutbound) => {
    if (message.kind !== 'ready') inFlight.delete(message.job)
    emit(message)
  })

  return {
    post(message: WorkerInbound, transfer: readonly ArrayBufferLike[] = []) {
      if (message.kind !== 'request') {
        if (dead === null)
          worker.postMessage(message, transfer as ArrayBuffer[])
        return
      }
      if (dead !== null) {
        // Asynchronously, as a live thread would answer: the pool marks the
        // job active only after `post` returns.
        const { job } = message
        inFlight.add(job)
        queueMicrotask(() => fail(job))
        return
      }
      // Before the post, so a clone that throws leaves nothing recorded.
      worker.postMessage(message, transfer as ArrayBuffer[])
      inFlight.add(message.job)
    },
    subscribe(handler: (message: WorkerOutbound) => void) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    terminate() {
      // A deliberate end is not a death: no failure for the pool to read.
      dead ??= 'worker thread terminated'
      inFlight.clear()
      void worker.terminate()
    },
  }
}
