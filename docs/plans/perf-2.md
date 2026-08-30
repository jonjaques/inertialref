# Performance, second pass: the game as it is played

The first pass ([perf](perf.md)) profiled four stationary operating points.
This one drives the game the way a player moves through it — mode switches,
planet-to-planet retargets, a camera orbit, a controlled scrub descent from
380 km to two meters, flight teleports, time warp, landings, jumps to two
generated systems and back, the title cutscene, and the documentation.

Each entry carries the measurement that raised it and, where a verifying pass
has been through, the measurement that closed it. **Read every "was" figure
against the caveats, not just against the "is" one**: the rig itself was
rebuilding the renderer on every boot, which doubled the drawing buffer, and
terrain selection is measured in display pixels — so some of these first
numbers are retina numbers wearing a default-window label. [perf](perf.md) §
Caveats has it.

**The build and the rig.** Dev build on the Vite server, driver's occluded
1600×900 Chrome, Apple M5. React costs below are dev-build costs (~5×
shipped); worker runs carry whatever else the machine was doing; frame
_periods_ from this rig overstate drops. Spans are trustworthy; the flags lean
on spans.

---

## Arrivals and transitions

### Arriving in a new system: 220 ms → 43 ms, and what is left is one bake

`ir.goTo('HIP70890')` (Proxima, generated) cost one frame of **220.5 ms with
`Render/bodies` at 192.8 ms**, then three more at 54-76 ms, with a
**`Boot/bake atmosphere` entry of 116.9 ms** landing mid-session on the main
thread. Re-measured on the same jump from a clean boot: the worst frame is
**43.3 ms**, `Render/bodies` max 7.8 ms — and 39.7 ms of that worst frame is
still one atmosphere bake.

Two things moved and only one of them is a fix. `Engine/orbits` no longer
re-solves on the retarget (below), and the rig no longer runs at a doubled
drawing buffer, which is most of what `Render/bodies` was paying for in
pipeline compilation and texture upload. **The bake is untouched** and is now
the largest single thing in an arrival; [perf](perf.md) § "An atmosphere bakes
on the main thread" carries the shape of the fix and the one open question.

### First contact with a new body's ground: fixed

`terrain.select` spiked to **113.8 ms once** on Proxima Centauri b and 36.1 ms
on Mars, in the frame the player arrives. Isolated in Node: the first `update`
on a cold body is 39.8 ms on Earth against 0.5 ms warm, and
`surfaceDetailFloor` is 33.4 ms of it — 85%, and the same ratio on Mars
(40.3/34.0) and Luna (48.6/42.8). It is a pool task now. The streamer selects
nothing at all until the answer lands, which is the same shape as waiting for
the heightfields.

### A retarget rebuilds every orbit trace: fixed

Every focus change re-solved `orbitPaths` for every body in every loaded
system — ~97 Kepler steps each, `Engine/orbits` max 18.4 ms in the Sol tour,
22.2 ms in the Proxima one, 12.3 ms on every planetarium mount. The rebuild
key mixed two things invalidated by different inputs: the sampling, which
depends only on the loaded systems, and the scope filter, which is what a
retarget changes. Split, with the anchor making it legal. Four retargets in
one profile window: **`Engine/orbits` max 0.20 ms**. A new system loading
still samples, and still costs 21.3 ms once.

### Mode switches drop two to six frames each, worst ~137 ms

Every SPA switch shows late frames with nothing inside our spans — React
mount/unmount commits. Entering the **planetarium is the worst: 135.9 / 137.4
ms** on its mount frame, twice, reproducibly. Entering flight: six frames over
25 ms (max 75). Docs, home, settings: 28-45 ms.

Still open and still unmeasured on the shipped build, which is the thing to do
before acting: these are dev-build React numbers and the ratio is about five.
The planetarium's mount (dock + catalog + rail + panels in one commit) is the
one worth the look. The retarget profile above still shows 30-45 ms frames
with no span inside them, which is the same population.

### A documentation page click janks for half a second

Clicking `/docs/concepts/coordinates` from the docs index: **26 of 125
frames over 25 ms** (max 53), engine at 0.7 ms — all page render (dev
build). The scene keeps drawing under the docs, and a whole shiki-highlit
page mounts in one commit. Worth one shipped-build measurement; if it holds
there, the candidates are chunked page mounts or pausing the scene behind
the reader.

## Streaming and the worker pool

### Stale heightfield jobs are cancelled now, not merely dropped

The streamer's `#epoch` discards _answers_ that outlive their view; the jobs
behind them ran to completion. After leaving a landing view with the in-flight
window full, `generateHeightfield` runs kept arriving through the _cutscene_
(42 runs at 292 ms mean inside its window) and the docs visit — up to
128 × ~400 ms of worker time burned on ground nobody will see, ahead of
everything the new view wants.

`#inFlight` holds the `JobHandle` and `clear()` cancels it. Measured in the
browser, landed on Mars and then looking away: **queued 124 → 0 within 60 ms**,
`cancelled` 124, at a 264 ms mean run — about **33 seconds** of worker time
not spent. At the cap all but `poolSize()` of the window are still in the
pool's queue, where cancelling is a splice and the work never happens; the few
running finish, because `generateHeightfield` polls nothing and cannot be
interrupted mid-field, and their answers are discarded by the epoch.

**A camera that stays is not a ship that leaves.** `ir.goTo` alone does not
clear the streamer: the observatory still holds the old body, so the window
keeps running for a surface the ship is no longer near. That is the camera
being right rather than the streamer being wrong, but it is worth knowing when
a jump does not produce the cancellations you expected.

### The star survey queues behind bulk terrain

Returning to Sol, `Workers/queue universe.surveyRegion` read **4.0–8.0 s** —
the two survey jobs sat behind a hundred queued heightfields, so the sky
repopulated seconds after a jump completed.

Expected closed by the cancellation above and **not reproduced**, which is not
the same thing. A survey only fires after the player moves eight light years,
and no single system in `ir.targets()`' sweep is more than 6.5 away — so it
takes a multi-hop tour to provoke, and every hop of one retargets the
observatory and therefore retires the backlog first. The priority lane the
original entry offered as the alternative is unbuilt and, on this reading,
unneeded.

### Worker runs on generated and mapped-red bodies are 5–10× the baseline

`generateHeightfield` runs, browser pool: Earth 45–76 ms; Mars **241 ms mean**
(max 419); Proxima Centauri b **304–410 ms mean** (max 648). The Node baseline
for the same grammars is 22–50 ms quiet.

Re-measured at the new pool size, Mars reads 129 ms mean at four workers and
187 at eight — so part of the gap is the dilation the pool-size table measures
directly and part is not. Earth on the same rig stays under 80, so the
per-body spread is real. Suspicions unchanged, in order: per-worker per-body
cold caches (sketch, crater ladders, plate partitions, now rebuilt in each of
eight workers), heavier crater and band grammars on those worlds, E-core
scheduling. The check that separates the first from the rest is one worker's
first patch against its tenth on the same body, and it has not been run.

### A landing view converges in minutes off Earth

Mars, landed, quiet view: queue **12.4 s deep**, `pending` pinned at the 128
in-flight cap, drawn level still 6 after fifteen seconds; Proxima b still
`pending 128, level 8` after 25 s with selections climbing.

Better and not solved. At eight workers the same Mars landing reaches level 13
in twenty seconds against level 10 at four, and the queue is 2.9 s rather than
4.0. Convergence to the deepened floor is ~1,000 patches; at 41.6 jobs/s that
is ~24 s of ground sharpening after every arrival. The remaining lever is the
per-job time above.

### Occasional 9–16 ms spikes inside terrain phases during convergence

During the Proxima descent-convergence window: `terrain.build` max 16.1 ms
(budgeted 0.25 ms × 4), `terrain.select` max 16.5, `snapshot` max 8.6,
`starfield` max 7.0, `terrainPatches` max 9.8 — several spans an order over
their means in the same stretch, which smells like GC pauses landing inside
whichever span is open (dev build, allocation-heavy window). Three of those
producers have since been cut and none of it has been re-measured _as GC_;
[perf](perf.md) § "Garbage collection" is the same open question from the
other side. Worth one trace with attribution before believing any individual
span's max.

## Simulation

### Maximum warp spends 2.5-4 ms a frame in `advance`

At 100,000× with three systems loaded: `Engine/advance` **3.95 ms mean, 10.4
max**; the engine step 4.5 mean / 6.5 p95 against its 2.0 ms budget line. At
1,000×: 1.7 mean.

Re-measured with one system loaded, looking at Mars: advance 0.03 ms at 1×,
**1.43 at 1,000×, 2.52 mean and 5.0 max at 100,000×**, with the engine step
2.80 / 5.3 and `Engine/frame` still 16.67 ms — no dropped frames at max warp.
The gap between the two readings is the loaded-system count, which is the
untested half of the original suspicion and the entry below. Nothing has
measured it at five to ten loaded systems.

### `snapshot()` cost scales with loaded systems, and nothing unloads one

Snapshot per frame: 0.23 ms with one system loaded, **0.77–1.01 ms with
three** — and `loadedSystems` only grows (`systems 3` for the rest of the
session). Twenty systems visited is a snapshot alone near the whole engine
budget, every frame, forever.

The allocation half is cut: `formatAddress`, `bodyFrameId` and
`bodyFixedFrameId` are memoized on the address object, and the body-fixed
frame is resolved once per body rather than three times. In Node with the pose
cache missing every frame the remaining scaling is 0.098 ms at one system and
0.147 at three (129 bodies against 161); in the browser `Engine/snapshot`
reads 0.18-0.27 ms at one system where it read 0.23.

**The eviction policy is still absent and is the real entry.** Whether
anything may unload a system the player has left is a design question, not a
tuning one: saves pin references, the catalog regenerates deterministically,
so a cache-not-save unload should be legal by ADR/AGENTS rules. It wants the
heap breakdown below first.

### Something in the first tour paused the clock: found

The clock was found **paused at tick 5782 (~90 s of sim)** mid-session, and
every flight and warp measurement after it silently described a frozen world.
Bisecting the timeline never reproduced it because the gesture was not in the
timeline: it was `ir.play` itself.

`CutsceneSession.sample()` runs on the engine store's sampler, which is
session-wide and does not stop when the cinema does — so an ending is visible
to it however the scene was started. It reacts by reopening the scene two
frames short and pausing the world clock to hold the last picture, which is
right for a reader holding an end card and wrong for a driver's
`ir.play('tngIntro')`: the director restores the clock when the scene ends,
and the session paused it again. A session now reopens only a scene it opened
itself, and `CinemaPlayer` unmounts through the session rather than past it,
which also closes the one-sample window where an ending arrives in the same
beat as the leave. Both cases are pinned in `cinema/session.test.ts`.

**The habit it earns**: confirm `clock.paused` is false before quoting any
figure that depends on the world advancing.

---

## Memory

### The tour ends at 906 MB of JS heap, against a ≤900 MB budget

`performance.memory` after the full tour (three systems, two landings, a
stance on a generated world): **628 MB** at the Proxima summit, **906 MB**
at the end. The budgets table still records 66–74 MB, measured before
streamed terrain existed — that row is stale either way.

Two fresh readings, both this pass: **488 MB** at a converged Earth summit
with one system loaded, and **770 MB** after a Mars landing plus a jump, with
two. The shape holds and nothing here has moved it. Prime suspects unchanged:
the geometry cache (450 MB at its documented full ceiling) plus the field
cache (138 MB full), retained across operating-point changes on the same body
by design, plus each resident world. Unknown, and it is the question: whether
anything ever _shrinks_ when the player leaves a body's surface for good —
`#evict` trims only above caps and `clear()` only fires on a body change, so a
session that ends its last landing holds that landing's full working set
indefinitely. **Needs a heap breakdown before anyone tunes a cap**, and it
gates the system-eviction entry above.

---

## What is still open, in the order it is worth taking

1. **One atmosphere bake, 39.7 ms, on the arrival frame** — the largest single
   thing left in a transition, and the fix shape is already written down.
2. **Shipped-build mode switches and docs pages.** Every figure for those here
   is dev React at about five times the real cost, and nobody has looked at the
   real one. Measure before acting.
3. **Per-job heightfield time**, which is what convergence is now made of. One
   worker's first patch against its tenth on the same body separates the cold
   per-body caches from the grammar and the scheduler.
4. **A heap breakdown**, which gates both the cap tuning and the
   system-eviction question.
5. **Garbage collection**, re-measured as GC now that three of its named
   producers are gone.

## Not measured here, deliberately

The author's dock panels held open; multiplayer; WebGL fallback; any window
size other than the rig's default — the retina-window warning applies to every
terrain number above, and the rig supplied a retina window of its own for a
while without saying so ([perf](perf.md) § Caveats).

## Reproducing

Every scenario is a page-side script handed to the driver with `--file`
(`.scratch/` is where such throwaways live; they are not tracked, so the
two mechanics that make them work are recorded here). A transition is
measured by scheduling the gesture _inside_ a profile window — `ir.profile`
arms and restores the timing level itself, so no `?timing=` is needed
except to capture boot:

```js
// one mode switch, profiled — react-router accepts a synthetic popstate
setTimeout(() => {
  history.pushState({}, '', '/planetarium')
  dispatchEvent(new PopStateEvent('popstate'))
}, 400)
return (await ir.profile(2600)).text
```

```js
// a controlled descent: the surface arm's own scrub, stepped like a drag
const obs = engine.harness.observatory
obs.setStanceScrub(1)
let step = 0
const id = setInterval(() => {
  obs.setStanceScrub(Math.max(0, 1 - ++step / 58))
  if (step >= 58) clearInterval(id)
}, 250)
return (await ir.profile(15500)).text
```

Retarget tours schedule `ir.look` calls the same way; the camera orbit is
`observatory.setAngles(azimuth += 0.02, 0.25, false)` on a 16 ms interval;
warp is `engine.world.clock.setTimeScale(n)` — after confirming
`clock.paused` is false, which this pass learned the hard way and the entry
above explains.

Two more that earned their place since:

```js
// the pool-size table: throughput, dilation and drawn level together, because
// jobs per second alone hides both of the other two
const pool = engine.pool()
ir.visit('g:milky-way/s:SOL/b:3', { site: 'summit', height: 2 })
await new Promise((r) => setTimeout(r, 4000))
const [t0, c0] = [performance.now(), pool.stats().completed]
await new Promise((r) => setTimeout(r, 20000))
const s = pool.stats()
return {
  jobsPerSecond: (s.completed - c0) / ((performance.now() - t0) / 1000),
  averageRunMs: s.averageRunMs,
  drawnLevel: ir.terrain().level,
}
```

```js
// cancellation, from the outside: fill the window, then look away
ir.visit('g:milky-way/s:SOL/b:3', { site: 'summit', height: 2 })
await new Promise((r) => setTimeout(r, 6000))
const before = engine.pool().queued
ir.look('g:milky-way/s:SOL')
await new Promise((r) => setTimeout(r, 60))
return {
  before,
  after: engine.pool().queued,
  cancelled: engine.pool().stats().cancelled,
}
```
