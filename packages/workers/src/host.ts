import { getLogger } from '@inertialref/shared'
import { decode, decodeWorkerRequest, isWorkerCancel, type JobId } from '@inertialref/protocol'
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
    // Validate, don't assert. This used to be a discriminant check, so `job`,
    // `task` and `taskVersion` were read off an unvalidated object and the
    // payload reached `task.run` as `never`. This is the boundary the protocol
    // package exists for; decoding here is the whole point of it.
    const decoded = decode(decodeWorkerRequest, message)
    if (!decoded.ok) {
      log.warn('rejected a malformed request', { error: decoded.error })
      return
    }
    const request = decoded.value

    const task = registry.get(request.task)
    if (task === undefined) {
      port.post({ kind: 'failure', job: request.job, error: `Unknown task ${request.task}` })
      return
    }
    if (task.version !== request.taskVersion) {
      // The page has been open across a deploy. Failing loudly beats generating
      // half a planet with one algorithm version and half with another.
      port.post({
        kind: 'failure',
        job: request.job,
        error: `Task ${request.task} version mismatch: worker has v${task.version}, request wants v${request.taskVersion}`,
      })
      return
    }

    const started = now()
    void (async () => {
      try {
        const result = await task.run(request.payload as never, {
          cancelled: () => cancelled.has(request.job),
        })
        if (cancelled.has(request.job)) {
          cancelled.delete(request.job)
          port.post({ kind: 'failure', job: request.job, error: 'cancelled' })
          return
        }
        const transfer = task.transfers?.(result) ?? []
        port.post({ kind: 'success', job: request.job, payload: result, durationMs: now() - started }, transfer)
      } catch (cause) {
        log.error('task failed', { task: request.task, job: request.job, cause: String(cause) })
        port.post({
          kind: 'failure',
          job: request.job,
          error: cause instanceof Error ? cause.message : String(cause),
        })
      } finally {
        cancelled.delete(request.job)
      }
    })()
  })

  port.post({ kind: 'ready', tasks: registry.names() })
  return unsubscribe
}
