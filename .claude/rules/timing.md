---
paths:
  - 'apps/game/src/engine/browserTiming.ts'
  - 'apps/game/src/engine/frameTiming.ts'
  - 'apps/game/src/engine/perfBudgets.ts'
  - 'apps/game/src/engine/GameEngine.ts'
  - 'apps/game/src/engine/terrainStreamer.ts'
  - 'apps/game/src/scene/useTimedFrame.ts'
  - 'apps/game/src/render/*.ts'
  - 'packages/shared/src/timing.ts'
  - 'packages/devtools/src/profile.ts'
  - 'packages/workers/src/pool.ts'
  - 'packages/workers/src/host.ts'
  - 'scripts/timing.mjs'
---

# The performance timeline

Reasoning: [ADR-0022](../../docs/adr/0022-the-timeline.md).

- **Emit through a `Timer`; `console.timeStamp`, `performance.mark` and
  `performance.measure` live in `engine/browserTiming.ts` and nowhere else.** The level,
  the drain and the clear each need the set of emitters known in one place.
  **`performance.now()` is not one of those three** — it is the host's clock, it is legal
  anywhere under `apps/`, and `GameEngine.frame`, `PhaseClock` and `useTimedFrame` all
  read it. Under `packages/` nothing may name `performance.` at all;
  `apps/headless/src/coreHostApis.test.ts` greps for that, because a global is not an
  import and `pnpm graph` cannot see one.

- **`Span.end()` returns `void`, and that is the invariant.** Canonical code may write to
  the wall clock and may not read one. No expression a caller can write observes a
  duration, so no canonical value can be a function of wall time. `end(): number` looks
  helpful and is the whole defect.

- **`timer.on` is a getter over the live hub — never cache it.** The entry point attaches
  the sink after every static import has evaluated, so a boolean captured at module scope
  is `false` for the life of the process and records nothing, failing at nothing.

- **Take both ends from numbers the caller already has.** `measure(name, start, end)`
  over `span()` wherever the interval is already computed. Where it is not, use a
  `PhaseClock`: **one clock read per boundary, not a pair per span**, so the phases tile
  and the quantization redistributes instead of accumulating.

- **`performance.now()` here steps in 100 µs** — nothing sets COOP/COEP, so
  `crossOriginIsolated` is false. A span under ~300 µs is honest in the mean over a
  window and meaningless as one bar. Do not read a single short entry, and do not write a
  span whose whole point is a figure below the step.

- **Nothing that allocates goes outside its `if (timer.on)` guard**, and properties go
  behind `timingDetailed()` as well — they exist only at `full`, so formatting numbers
  into strings per frame fills a table `trace` discards.
  `apps/game/src/engine/timingInert.test.ts` counts `performance.now` calls and expects
  exactly two a frame when nothing is listening.

- **A label is an aggregation key and a `clearMeasures` argument, so keep the set
  bounded.** A region address in a label is one bucket per patch and a retained-name set
  that grows without end; it belongs in `properties`. Clear by name, marks and measures
  separately — never the bare form, which takes another tool's entries with it.

- **Each side of a worker boundary emits only its own numbers.** `timeOrigin` differs per
  scope, so an interval measured on one thread and emitted on another lands wrong. The
  level crosses as a protocol message, never as a query on the worker's URL.

## The shapes the two performance passes kept finding

Reasoning and every figure: [perf](../../docs/plans/perf.md),
[perf-2](../../docs/plans/perf-2.md).

- **A rebuild key that mixes two invalidation sources makes the cheap half pay the
  expensive half's cadence.** Four of the fixes are one shape. The starfield rewrote
  twenty thousand stars whenever `origin.generation` moved — every 4,096 m of travel —
  for a buffer of _directions_, which translation does not change. `#maybeTraceOrbits`
  re-solved ninety-seven Kepler steps per body whenever the _focus_ changed, because the
  sampling and the scope filter shared one key. `balance` rebuilt a depth map over nine
  hundred ancestor chains in each of seven passes to find twenty-nine splits. Before
  optimizing the work, ask what its answer is actually a function of, and key it on
  that.

- **Forgetting an answer is not retiring the work.** `TerrainStreamer.#epoch` discarded
  heightfields that outlived their view while the jobs behind them ran to completion —
  a departure left up to 128 of them queued ahead of everything the next view wanted,
  measured at 33 seconds of worker time. A cache that can be cleared and a queue that
  can be cancelled are two different verbs and `clear()` owes both.

- **A gate keyed on a proxy holds only while nothing fakes the proxy.**
  `document.visibilityState` stands in for "the compositor is presenting this window";
  CDP focus emulation reports `visible` for a window that never composites, so the
  presentation watchdog rebuilt a healthy renderer on every automated boot. When a
  signal is a proxy, say so where it is read, and give the environment that breaks it a
  way to say so — `?presentation=occluded`.

- **Move the cold memo off the frame that pays for it, not out of the code.**
  `surfaceDetailFloor` is 33-43 ms exactly once per body, in the frame the streamer
  first has that body underfoot. It is a pool task now and the streamer holds the ground
  back for the frames it takes, which is the same shape as waiting for the heightfields
  themselves. The check that found it: time the first `update` on a cold body against
  the second, in Node, before reaching for a browser.

- **Measure on a quiet machine, one thing at a time.** The same summit arrival reads
  45 ms worker runs quiet and 285 ms with a build running beside it. A test suite in
  another shell does not make a worker figure noisy; it makes it a figure about the test
  suite.

- **A constant nobody has measured is a guess with a comment.** The pool ceiling was
  four on a ten-core machine because `min(4, cores - 2)` looked prudent. Eight is 37%
  more throughput, a second off the queue and three more levels of ground in the same
  twenty seconds, for no frame cost. `engine/browserWorker.ts` carries the table;
  `?workers=N` re-runs it.
