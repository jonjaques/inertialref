import { getLogger } from '@inertialref/shared'
import { isWorkerCancel, isWorkerRequest, type JobId } from '@inertialref/protocol'
import type { HostPort } from './transport.ts'
import type { TaskRegistry } from './task.ts'

/*
 * The worker-side loop.
 *
 * Lives here rather than in the app's worker entry so that the entry file is
 * three lines and contains nothing worth testing. Timing is measured on this
 * side of the boundary — the pool separately measures queue latency — because
 * the difference between "the task is slow" and "the queue is backed up" is the
 * first question anyone asks when frames start dropping.
 */

export interface ServeOptions {
  /** Injected so this stays free of any host clock API. */
  readonly now?: () => number
}

export function serveTasks(registry: TaskRegistry, port: HostPort, options: ServeOptions = {}): () => void {
  const log = getLogger('workers.host')
  const now = options.now ?? (() => 0)
  const cancelled = new Set<JobId>()

  const unsubscribe = port.subscribe((message) => {
    if (isWorkerCancel(message)) {
      cancelled.add(message.job)
      return
    }
    if (!isWorkerRequest(message)) return

    const task = registry.get(message.task)
    if (task === undefined) {
      port.post({ kind: 'failure', job: message.job, error: `Unknown task ${message.task}` })
      return
    }
    if (task.version !== message.taskVersion) {
      // The page has been open across a deploy. Failing loudly beats generating
      // half a planet with one algorithm version and half with another.
      port.post({
        kind: 'failure',
        job: message.job,
        error: `Task ${message.task} version mismatch: worker has v${task.version}, request wants v${message.taskVersion}`,
      })
      return
    }

    const started = now()
    void (async () => {
      try {
        const result = await task.run(message.payload as never, {
          cancelled: () => cancelled.has(message.job),
        })
        if (cancelled.has(message.job)) {
          cancelled.delete(message.job)
          port.post({ kind: 'failure', job: message.job, error: 'cancelled' })
          return
        }
        const transfer = task.transfers?.(result) ?? []
        port.post({ kind: 'success', job: message.job, payload: result, durationMs: now() - started }, transfer)
      } catch (cause) {
        log.error('task failed', { task: message.task, job: message.job, cause: String(cause) })
        port.post({
          kind: 'failure',
          job: message.job,
          error: cause instanceof Error ? cause.message : String(cause),
        })
      } finally {
        cancelled.delete(message.job)
      }
    })()
  })

  port.post({ kind: 'ready', tasks: registry.names() })
  return unsubscribe
}
