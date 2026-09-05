/*
 * `scheduler.yield()` for the browsers that have none.
 *
 * three's `compileAsync` builds what it queued one object at a time and yields
 * between them through `yieldToMain()` — `self.scheduler.yield()` where it
 * exists and a `requestAnimationFrame` otherwise — and `NodeBuilder.buildAsync`
 * yields the same way after every shader stage, nine times per fresh
 * material. Safari 26 has WebGPU and no `scheduler` at all; Chrome has had
 * `scheduler.postTask` since 94 and `yield` only since 129. On the fallback
 * every yield is a frame: a visible boot pays ten frames per material it
 * warms, and a hidden tab pays forever, because Chrome suspends animation
 * frames for an occluded window and boot is designed to finish in one
 * (`warmup.ts` § `framesPossible`) — the cover never lifts.
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
const yieldToMain = (): Promise<void> =>
  new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
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
