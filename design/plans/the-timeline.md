# The Timeline: what is left

Every phase of a frame, a boot and a worker job on the browser's own performance
timeline — through one port, off by default, and with no wall-clock read
reaching canonical code.

**[ADR-0022](../../docs/adr/0022-the-timeline.md) owns the decision**: the
`Span.end(): void` type that keeps canonical code write-only, the port in
[`packages/shared/src/timing.ts`](../../packages/shared/src/timing.ts), the one
sink in
[`apps/game/src/engine/browserTiming.ts`](../../apps/game/src/engine/browserTiming.ts)
that names a platform API, the three-valued level, and the measured cost of an
entry — 46.5 ns at `trace` against 988.5 ns at `full`, in Chrome, over a 7.0 ns
empty loop. The instrument is read from a terminal through `ir.profile(ms)`,
`ir.timing.drain()` and `pnpm timing` over a `--trace` recording. What it says
about this build is [Performance: what is left](perf.md).

Two things it cannot see yet.

---

## The rAF loops outside R3F's are dark

`useTimedFrame` gives one `Render` entry per `useFrame` consumer, and
`FrameMetrics` measures the same loop. Eight other `requestAnimationFrame`
callers run main-thread work outside it — `pages/HomePage.tsx`,
`planetarium/SkyLabels.tsx`, `hud/TrackOverlay.tsx`, `hud/CutsceneOverlay.tsx`,
`docs/useDocsFraming.ts`, `render/firstLight.ts`, `render/createRenderer.ts` and
`render/warmup.ts` — and no instrument sees any of them.

The last three are boot-time, which is the argument for taking them first: boot
is the one window the performance panel structurally cannot look at, the `Boot`
track already exists, and the front door's own orbit at 1.8°/s is the largest
field of motion in the product with nothing measuring it.

## `drain()` is the page's thread only

A `performance.mark` or `measure` lands in the timeline of the scope that wrote
it. So the `Tasks` track — one entry per task, emitted by
[`packages/workers/src/host.ts`](../../packages/workers/src/host.ts) on the
worker's own thread — never reaches `ir.timing.drain()`, and therefore never
reaches `ir.profile`. A profile taken from the page carries the pool's `queue`
and `run`, which the pool times on the main thread, and nothing the worker
itself said about the job.

A Chrome trace carries every thread, so `--trace` read back through
`pnpm timing --threads` is the reading that includes the worker side. Closing
the gap for `drain` instead means collecting each worker's entries over
`postMessage` — a second protocol message on top of the level broadcast, paid on
every drain — and that is worth doing only if a `full`-level report is wanted
somewhere a trace cannot be recorded.

---

## Related

- [ADR-0022](../../docs/adr/0022-the-timeline.md) — the decision and its
  consequences
- [Observability](../../docs/concepts/observability.md) — the timeline as the
  fifth consumer of one structure
- [Performance: what is left](perf.md) — the current figures
