/*
 * `scheduler.yield()` for the browsers that have none.
 *
 * three's `compileAsync` builds what it queued and yields after every 8 ms of
 * it through its `CompileScheduler`. On a visible page that waits for the
 * next frame, with a 100 ms timeout behind it; on a hidden one it is
 * `yieldToMain()` — `self.scheduler.yield()` where it exists and a
 * `requestAnimationFrame` otherwise. Safari 26 has WebGPU and no `scheduler`
 * at all; Chrome has had `scheduler.postTask` since 94 and `yield` only since
 * 129. On the fallback a hidden tab pays forever, because the browser
 * suspends animation frames for a hidden page and boot is designed to finish
 * in one (`warmup.ts` § `framesPossible`) — the cover never lifts.
 *
 * A `MessageChannel` round trip is the yield. One macrotask, like the native
 * one; not clamped to a millisecond the way a nested `setTimeout` is, and not
 * throttled to a second in a background tab the way timers are. It goes onto
 * the `scheduler` that exists — never over a native `yield`, and never as a
 * whole object where `postTask` is already there — so a browser that has the
 * real thing keeps it, and a `typeof` check in a library sees the same shape
 * either way.
 */

interface Scheduler {
  yield?: () => Promise<void>
}

/** One turn of the event loop, on a channel nothing throttles. */
export const yieldToMain = (): Promise<void> =>
  new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      port2.close()
      resolve()
    }
    port2.postMessage(null)
  })

/**
 * Give `target` a `scheduler.yield` if it lacks one. `globalThis` in the app;
 * a parameter so a test can hand over a bare object.
 */
export function installSchedulerYield(target: object = globalThis): void {
  const host = target as { scheduler?: Scheduler }
  const scheduler = (host.scheduler ??= {})
  scheduler.yield ??= yieldToMain
}
