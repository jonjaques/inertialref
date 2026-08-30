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

- **Read the two passes before optimizing anything, and measure on a quiet
  machine.** [perf](../../docs/plans/perf.md) and
  [perf-2](../../docs/plans/perf-2.md) carry every figure, what was declined and
  why, and which numbers are stale — including the ones the rig was lying about.
  The commonest shape is a rebuild key mixing two invalidation sources, so the
  cheap half pays the expensive half's cadence. A build running beside a
  measurement takes worker runs from 45 ms to 285.
