# ADR-0022: A frame emits to a timeline it cannot read

Status: accepted · 30 Aug 2026

## Context

This project measures itself carefully and can only show the answers as scalars.
Six instruments do it, on six axes, and none of them shares one:
`FrameMetrics × Series` over 240 samples, `PoolStats` over the last 64 jobs, a
one-shot GPU measure over 40 submitted frames, boot's `ms` log fields, the
offline `terrainBaseline`, and `TerrainStreamer.summary()`'s instantaneous
counts. Two consequences fall straight out of that.

**The axes do not line up, so correlation is not expressible.** A worker job's
9–37 ms lives in a mean over the last 64 jobs; the frame it starved lives in a
p95 over the last 240 frames. Depending on the queue those two windows cover
wildly different spans of wall clock, so "the frame at _t_ was slow" and "a
heightfield landed at _t_" cannot be put beside each other, because there is no
_t_.

**Composition is not expressible either.** `engineMs` is one number covering
ticks, snapshot, cutscene and observatory sampling, scene build, terrain
reconciliation, the star survey and the orbit traces. The frame budget in
[technical](../design/technical.md) has seven lines under it and the panel has
one plot for them. Nothing in a `Series` can say _which_ contributor moved.

Both are visible in Chrome's Performance panel the moment something writes them
there — and nearly all of it is already measured. Seven sites hold both ends of
an interval and throw one away.

The embarrassing part of the context is the rule this appears to argue with.
[`AGENTS.md`](../../AGENTS.md) rule 2 forbids `performance.now()` in canonical
code, and [`packages.md`](../../.claude/rules/packages.md) forbids a host API
below `apps/` at all. An instrumentation phase that ignored either would be a
determinism hole dressed as a debugging aid.

## Decision

**Canonical code may emit to a timeline and may not read one, and the check is a
type.**

```ts
interface Span {
  end(): void // never `: number`
}
```

A span hands nothing back. There is no expression a caller can write that
observes how long anything took, so no canonical value can be a function of wall
time. The invariant survives by construction rather than by discipline, and
`getLogger` is the precedent: logging from canonical code is accepted because a
log record is write-only. Timing is the same shape with a stricter signature.

**The host capability is a port.** `packages/shared/src/timing.ts` declares
`Timer`, `TimingDetail`, `TimingSink` and a module-global hub whose default does
nothing, exactly as `log.ts` does — importing a package never causes output.
`apps/game/src/engine/browserTiming.ts` is the only file in the application that
names `console.timeStamp`, `performance.mark` or `performance.measure`. A grep
test in `apps/headless` holds the half `pnpm graph` cannot see, because
`performance` is a global rather than an import and is therefore not an edge in
the dependency graph at all.

**Two platform APIs sit behind one three-valued level, because they cost
differently.** `console.timeStamp` reaches an active DevTools trace and nowhere
else, cannot be read back, and carries label, track, group and color and no
more. `performance.mark`/`measure` reach the page's own retained timeline, carry
a properties table, and can be read back by `getEntriesByType`, a
`PerformanceObserver` or `ir.timing.drain()`. Measured here, in Chrome, against
a 7.0 ns empty loop over 200,000 iterations: **46.5 ns** and **988.5 ns** an
entry. A 25:1 ratio is worth being able to choose between, and a boolean cannot
select the half that retains.

**The level is the gate, because feature detection cannot be a `typeof`.**
`console.timeStamp` is ancient and present in every browser and in Node; the
four track arguments are a recent Chromium extension with no capability query.
So `typeof console.timeStamp === 'function'` is true on Safari, Firefox and
Node — a sink that attached on it would make them pay the hot path for entries
that land nowhere, which is cost with no output. `off` is the default
everywhere and the only way to pay is to ask.

**It is wired in `main.tsx` at module scope**, beside the log sink, from
`?timing=` then the stored preference. Boot is the most interesting thing on
this timeline and boot happens before React mounts, so a level read in an effect
misses the atmosphere bake, every texture upload, the pipeline warm and the gap
between navigation and first light.

**The phases tile the engine step from one clock read per boundary.** Measured here,
`performance.now()` steps in exactly **100 µs** — `crossOriginIsolated` is
false, nothing sets COOP/COEP, and 200,000 consecutive reads produced two
distinct deltas, both 100.00 µs. Reading once per boundary rather than twice per
span makes the quantization error redistribute between neighbors instead of
accumulating, so the phases sum to what they decompose: measured at 99.7% of
the `engine` entry, and to a microsecond on the Terrain track inside it.

**`engine` and `frame` are two entries against two budgets, and conflating them
hid a whole class of defect.** `engine` is this loop's own work, judged against
`ENGINE_BUDGET_MS`; `frame` is the wall-clock interval between animation frames,
judged against `DROPPED_FRAME_MS`. They were one entry covering the engine step
and colored against 25 ms — which `perfBudgets.ts` defines for the period, and
whose own comment warns that judging on the wrong one "gets this wrong in the
most misleading direction". It did: a session whose engine ran at 2 ms while the
renderer took 28 reported no late frames at all, because the only thing compared
to 25 was the half that was fine. The period covers the frame that just _ended_,
so every span from it — the engine phases, and the ten `useFrame` consumers that
run after `frame` returns — falls inside a bar rather than beside one.

**Each side of the worker boundary emits only its own numbers**, because
`console.timeStamp`'s arguments are milliseconds against `performance.timeOrigin`
and a worker's origin is not the page's. The level crosses as a protocol
message rather than as a query on the worker's URL.

## Alternatives considered

**Call `performance.mark` directly from the engine and accept the exception.**
The brief allowed it — the platform is "technically not a dependency" — and it
is genuinely an exception to the _dependency_ rule. It is not an exception to
the _portability_ one: `packages/*` has to run in a browser, a worker and Node,
and Node's `console.timeStamp` is not Chrome's. The port costs one interface and
buys a Node collector, an inline-worker test that can observe both sides of the
boundary, and a grep that can be enforced.

**One API instead of two.** `console.timeStamp` alone cannot be read back, so
`ir.profile()`, `ir.timing.drain()` and a bug report attachment are all
impossible. User Timing alone costs 21× more per entry and retains — at the
measured ~2,800 entries a second, a session left running is a leak. Each is the
wrong single choice for the other's job.

**A boolean flag.** It cannot select `full`, which is the level that retains and
therefore the only one anything can read back. Three named values in the URL
also make `?timing=full` a link somebody can send.

**The level on the worker's URL**, appended in `createBrowserWorkerPort`. Four
independent failures, kept in `WorkerTiming`'s doc comment because the idea
comes back: Vite's static `new Worker(new URL(…, import.meta.url))` analysis
breaks on an interpolated value and stops emitting the chunk at all;
`public/sw.js` matches `/assets/` with a bare `caches.match` and no
`ignoreSearch`, so a query-suffixed worker misses the cache on an offline
launch; inside a module worker the query is on `self.location.search` rather
than `import.meta.url`; and the premise is false anyway, because `ir.timing()`
and the panel change the level mid-session while a URL is read once at spawn.

**The flag in the engine's constructor, or in a React effect.** Both miss boot,
which is what this most wants to measure and the one window no existing
instrument can look at. `main.tsx` is also where the log sink is attached, for
the reason written there: attaching to a module-global hub is a process-wide
side effect and belongs to the process's entry point.

**A thirteenth capability check.** The inertness claim does need a live check —
breaking it costs frame time silently. But `README.md` carries a `12/12` badge
over the first milestone's closed historical set, and growing that number by
arithmetic rather than by milestone makes the claim mean something else. It runs
beside them, as `apps/game/src/engine/timingInert.test.ts`.

**A RUM beacon.** `analytics.ts` is the gate for anything third-party and it is
off unless this is a production build on the canonical host with no Global
Privacy Control. Sending timing anywhere is a separate decision with a separate
consent story. This ships `drain()`, which returns entries a developer can paste
into an issue.

## Consequences

**The instrument found three things on its first runs, and all three were
invisible to every existing one.**

`terrainStreamer.ts` documents selection at 40–90 µs for a whole disk. Standing
on Earth's summit site, with a nine-level selection visiting 446 nodes,
`terrain.select` is **2.733 ms of a 4.461 ms engine step** — 61% of everything the
engine does. Both figures are real and the comment now says which is which. A
figure measured at one operating point is a figure about that point.

On arrival at that summit a `generateHeightfield` waits **2.94 s** in the queue
and then runs for **83 ms**. The pool's own header names that distinction —
"slow tasks want optimization, a deep queue wants more workers or fewer
requests" — and until now both numbers existed with nowhere to see that one of
them was three seconds.

The whole preload and warm-up census runs **twice** on a cold boot, 4.5 s apart.
The log says why (`canvas never presented despite nudges; rebuilding the
renderer`), and rebuilding the renderer re-runs the warm-up. Nothing could show
that as a shape before: the panel does not exist yet at boot, and the log is two
identical sentences four seconds apart with nothing relating them.

**All three have since been acted on, and the first and third are superseded as
figures rather than as findings.** `terrain.select` is a held answer at a
converged stance and the walks no longer run every frame; the doubled census was
the driver's own window — focus emulation reports `visible` for a Chrome that
never composites, so the presentation watchdog rebuilt a healthy renderer, which
`?presentation=occluded` now stands down from. No player ever paid the second
census. What the numbers above are kept for is the shape of the argument: each
was a claim no existing instrument could have made, and the first is still the
worked example of a figure measured at one operating point being a figure about
that point. [`design/plans/perf.md`](../../design/plans/perf.md) carries the current ones.

**Over-budget now has one definition and three consumers.** `FRAME_BUDGET_MS`,
`DROPPED_FRAME_MS`, `ENGINE_BUDGET_MS` and `DRAW_CALL_BUDGET` move from
`hud/PerfPanel.tsx` to `engine/perfBudgets.ts`, because `hud/` sits above
`engine/` and the sink must not import a panel. The same number colors the
plot, colors the trace entry and bounds `ir.profile`'s verdict.

**The panel keeps its job and the split is worth stating.** The panel answers
_"is it fast right now"_ while you fly; the timeline answers _"why was that
frame slow"_ afterwards. The panel is better at p95 against a drawn budget and
at honest absences; a timeline reproduces both badly.

**A share of frame time is undefined for concurrent spans**, and this cost a
wrong number before it was noticed. Worker queue waits overlap each other and
the frames they cross, so their total over the frame total came out at 58,767%.
`summarizeProfile` detects the overlap empirically, per span, and prints an em
dash — empirically rather than by a list of track names, so a track added later
classifies itself.

**Clearing is by name, marks and measures separately, and never bare.**
`performance.clearMarks()` does not remove a measure, so a drain calling one of
them leaves half of what it emitted. And the bare forms clear entries another
tool put there: three seconds at `full` retained 8,394 of ours beside **338,065
of React DevTools'** in the same timeline.

**A short phase is honest in the mean and not in the instant.** At the 100 µs
step, a 40 µs selection and a 90 µs one read identically. Over a 240-frame
window the rounding is unbiased and the mean is good to well under a
microsecond; one bar is not a reading. That is a permanent property of this
context, not a defect to fix, and every span written here inherits it.

**The `void` return buys nothing in this diff, and that is the honest claim.**
Every span added lives in `apps/game` or in `packages/workers`, and none in
`packages/simulation`. `advance` is timed in `GameEngine.#step`, on the outside
of `world.advance`, where the wall clock is already legal and already read. The
type keeps the door shut for the next change — the one that wants to time a tick
from inside — which is a smaller claim than "this makes it safe to instrument
the simulation", and the one that can be supported.

**`pnpm sim --profile` has less to say than the plan hoped**, for that same
reason. With no span inside `packages/simulation`, a bare tick loop has nothing
to decompose and the report says so rather than printing an empty table. What it
does show is the worker pool, on any run that dispatches jobs.

## Related

- [Observability](../concepts/observability.md) — the four consumers this adds a fifth to
- [Determinism](../concepts/determinism.md) — the rule the `void` return preserves
- [ADR-0006](0006-simulation-clock.md) — the one call wall clock enters at
- [Workers](../concepts/workers.md) — the pool this instruments on both sides
- [The Timeline](../../design/plans/the-timeline.md) — the two things the
  instrument still cannot see
