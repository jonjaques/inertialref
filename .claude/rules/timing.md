---
paths:
  - 'apps/game/src/engine/browserTiming.ts'
  - 'apps/game/src/engine/frameTiming.ts'
  - 'apps/game/src/engine/perfBudgets.ts'
  - 'packages/shared/src/timing.ts'
  - 'packages/devtools/src/profile.ts'
  - 'scripts/timing.mjs'
---

# The performance timeline

Reasoning: [ADR-0022](../../docs/adr/0022-the-timeline.md).

- **Emit through a `Timer`; never name a platform timing API outside
  `engine/browserTiming.ts`.** `console.timeStamp`, `performance.mark` and
  `performance.measure` live there and nowhere else, and `packages/*` may not write
  `performance.` at all — `apps/headless/src/coreHostApis.test.ts` greps for it, because
  a global is not an import and `pnpm graph` cannot see one. The level, the drain and the
  clear each need the set of emitters known in one place.

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
