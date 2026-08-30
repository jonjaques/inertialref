import { getLogger, getTimer, type TimingDetail } from '@inertialref/shared'
import {
  decode,
  decodeWorkerRequest,
  isWorkerCancel,
  isWorkerTiming,
  type JobId,
} from '@inertialref/protocol'
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
 *
 * The same interval also goes onto a timeline, on this thread. `durationMs`
 * already crosses the wire and the pool already records it as a rolling mean;
 * what a mean cannot say is *when*, and "when" is the whole question when a
 * frame drew coarse ground because a 37 ms heightfield had not landed yet.
 *
 * **Timed on this side and emitted on this side.** `console.timeStamp` takes
 * milliseconds against `performance.timeOrigin`, and a worker's origin differs
 * from the page's by however long it took to spawn — so an interval measured
 * here and emitted there lands in the wrong place on the trace. The pool emits
 * its own dispatch-to-answer figure and this emits the task's own time; DevTools
 * shows them on separate threads because they are on separate threads.
 */

const timer = getTimer('workers.host')

/* No `group`, for the reason `pool.ts` gives: the host names its own track and
 * the browser sink supplies the application's. */
const TASK_DETAIL: TimingDetail = Object.freeze({
  track: 'Tasks',
  color: 'primary-dark',
})

export interface ServeOptions {
  /** Injected so this stays free of any host clock API. */
  readonly now?: () => number
  /**
   * Told when the page changes how much it wants described.
   *
   * A callback rather than this module attaching a sink itself, because
   * *which* levels exist and what a sink does with one are the host's business
   * — `packages/*` may not name `console.timeStamp`. The loop owns the
   * subscription, so decoding the message stays in the one place that already
   * decodes every other message kind.
   */
  readonly onTimingLevel?: (level: string) => void
}

export function serveTasks(
  registry: TaskRegistry,
  port: HostPort,
  options: ServeOptions = {},
): () => void {
  const log = getLogger('workers.host')
  const now = options.now ?? (() => 0)
  const cancelled = new Set<JobId>()

  const unsubscribe = port.subscribe((message) => {
    if (isWorkerCancel(message)) {
      cancelled.add(message.job)
      return
    }
    if (isWorkerTiming(message)) {
      options.onTimingLevel?.(message.level)
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
      port.post({
        kind: 'failure',
        job: request.job,
        error: `Unknown task ${request.task}`,
      })
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
        const finished = now()
        /*
         * One entry per task, on this thread, named for the task and no more.
         *
         * A `full`-level drain on the main thread will not see this: a worker's
         * User Timing entries live on the worker's own performance timeline and
         * are invisible to the page's `getEntriesByType`. What does see them is
         * a DevTools recording, which is where the correlation this exists for
         * actually gets read.
         */
        if (timer.on)
          timer.measure(
            request.task,
            started,
            finished,
            regionDetail(request.payload),
          )
        port.post(
          {
            kind: 'success',
            job: request.job,
            payload: result,
            durationMs: finished - started,
          },
          transfer,
        )
      } catch (cause) {
        log.error('task failed', {
          task: request.task,
          job: request.job,
          cause: String(cause),
        })
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

/**
 * Which patch this job is for, as an entry detail — never as part of the name.
 *
 * The plan asked for the region folded into the *label*, and that is the one
 * thing it must not be. A label is the aggregation key for `ir.profile` and the
 * argument to `clearMeasures`, and a nine-level selection names thousands of
 * distinct regions: folding it in gives one bucket per patch, a retained-name
 * set that grows without bound, and a flame chart in which no two bars share a
 * name. `generateHeightfield` stays `generateHeightfield`, and the address
 * rides in the properties table where a table can hold it.
 *
 * What is lost is the address at `trace`, which has no properties channel. What
 * is not lost is the thing the split exists for: *when* the 37 ms happened, on
 * which thread, against the frame that was waiting — and that is correlation by
 * time, which is the whole reason for a shared axis.
 *
 * Structural rather than per-task, because a registry is open and this loop
 * knows no task's payload type. `region` is the one shape worth reading.
 */
function regionDetail(payload: unknown): TimingDetail {
  if (typeof payload !== 'object' || payload === null) return TASK_DETAIL
  const region = (payload as { region?: unknown }).region
  if (typeof region !== 'object' || region === null) return TASK_DETAIL
  const { face, level, i, j } = region as Record<string, unknown>
  if (typeof face !== 'number') return TASK_DETAIL
  return {
    ...TASK_DETAIL,
    properties: [
      ['region', `${face}/${String(level)}:${String(i)},${String(j)}`],
    ],
  }
}
