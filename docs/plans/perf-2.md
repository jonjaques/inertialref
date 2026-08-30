# Performance, second pass: the game as it is played

The first pass ([perf](perf.md)) profiled four stationary operating points.
This one drives the game the way a player moves through it — mode switches,
planet-to-planet retargets, a camera orbit, a controlled scrub descent from
380 km to two meters, flight teleports, time warp, landings, jumps to two
generated systems and back, the title cutscene, and the documentation — and
flags what the instrument showed. Nothing here is verified to root cause or
fixed; every entry is a suspicion with the measurement that raised it, for a
later pass to confirm or dismiss.

**The build and the rig.** Dev build on the Vite server, driver's occluded
1600×900 Chrome, Apple M5, on the branch that already carries the first
pass's two fixes — so the HUD's 8 Hz re-render and the stance re-selection
are absent from these numbers by construction. React costs below are
dev-build costs (~5× shipped); worker runs carry whatever else the machine
was doing; frame _periods_ from this rig overstate drops (see perf.md's
caveats). Spans are trustworthy; the flags lean on spans.

---

## Arrivals and transitions

### Arriving in a new system stalls the frame up to 220 ms

`ir.goTo('HIP70890')` (Proxima, generated): one frame of **220.5 ms with
`Render/bodies` at 192.8 ms** inside it, then three more at 54–76 ms with
`bodies` 24–40 ms — and a **`Boot/bake atmosphere` entry of 116.9 ms**
landing mid-session, on the main thread. Vega (catalog, 27 ly): four frames
with `bodies` 26–50 ms. The suspicion: the boot preload bakes atmosphere
LUTs and builds per-instance materials only for the systems loaded _at
boot_, so a first look at a new system pays `createPlanetMaterial`,
pipeline builds and the LUT bake inside `Bodies`' frame callback. Check:
`preload.ts`'s census against `scatteringFor`'s cache key, and whether
`Bodies`' one-per-frame build-ahead covers a system that arrives
mid-session. An off-thread or amortized arrival warm (the boot recipe, run
on system load) is the shape of the fix.

### First contact with a new body's ground costs one ~114 ms frame

Landing on Proxima Centauri b: **`terrain.select` 113.8 ms once** (engine
119.7 that frame), against its ordinary 3–9 ms there. On Mars the same
first-selection spike is 36.1 ms. The walk itself cannot cost that; the
suspicion is what the first `update` on a new body computes inside the
frame — `surfaceDetailFloor` (which refines trial fields to find where the
grammar goes quiet) and the terrain sketch, both per-surface memos that are
cold exactly once, in the frame the player arrives. Check where
`surfaceDetailFloor`'s first call lands; precomputing it when the body is
resolved (or in a worker beside the heightfields) would move it out of the
frame.

### A retarget rebuilds every orbit trace in one frame: 12–22 ms

Every focus change in the planetarium (`Engine/orbits` max 18.4 ms in the
Sol tour, 22.2 ms in the Proxima tour, 12.3 ms on every planetarium
_mount_) rebuilds the whole visible trace set synchronously —
`orbitPaths`' Kepler sampling, ~97 points per body over every sibling and
moon in scope. It is invisible in the mean (0.13) and a guaranteed late
frame on the exact interaction the mode is for. Check `#maybeTraceOrbits`:
the rebuild key changes per focus, and nothing amortizes the rebuild across
frames or reuses the paths whose scope did not change.

### Mode switches drop two to six frames each, worst ~137 ms

Every SPA switch shows late frames with nothing inside our spans — React
mount/unmount commits (dev build). Entering the **planetarium is the worst:
135.9 / 137.4 ms** on its mount frame, twice, reproducibly, followed by the
12.3 ms orbit rebuild. Entering flight: six frames over 25 ms (max 75).
Docs, home, settings: 28–45 ms. Dev-build numbers; the shipped mounts need
measuring before anyone acts. The planetarium's mount (dock + catalog +
rail + panels in one commit) is the one worth a shipped-build look.

### A documentation page click janks for half a second

Clicking `/docs/concepts/coordinates` from the docs index: **26 of 125
frames over 25 ms** (max 53), engine at 0.7 ms — all page render (dev
build). The scene keeps drawing under the docs, and a whole shiki-highlit
page mounts in one commit. Worth one shipped-build measurement; if it holds
there, the candidates are chunked page mounts or pausing the scene behind
the reader.

---

## Streaming and the worker pool

### Stale heightfield jobs are dropped but never cancelled

The streamer's `#epoch` discards _answers_ that outlive their view, but the
jobs themselves run to completion: after leaving a landing view with the
in-flight window full, `generateHeightfield` runs kept arriving through the
_cutscene_ (42 runs at 292 ms mean inside its window) and the docs visit —
up to 128 × ~400 ms ≈ **50 s of worker time burned on ground nobody will
see**, ahead of everything the new view wants. `WorkerPool` has `cancel()`;
nothing calls it on `clear()` or on the epoch bump. Check the handle
plumbing in `#request` — the fix shape is holding the `JobHandle`s beside
`#inFlight` and cancelling on clear/evict.

### The star survey queues behind bulk terrain

Returning to Sol, `Workers/queue universe.surveyRegion` read **4.0–8.0 s**
— the two survey jobs sat behind a hundred queued heightfields, so the sky
repopulates seconds after a jump completes. One queue, no priority, and the
cheapest, most player-visible task class loses. Check: a priority lane (or
a reserved worker) for small tasks, or simply cancelling the stale terrain
backlog (above), which caused the depth.

### Worker runs on generated and mapped-red bodies are 5–10× the baseline

`generateHeightfield` runs, browser pool, this tour: Earth 45–76 ms; Mars
**241 ms mean** (max 419); Proxima Centauri b **304–410 ms mean** (max
648). The Node baseline for the same grammars is 22–50 ms quiet. Some of
the gap is the loaded rig, but Earth measured on the same rig stays under
80 — the per-body spread is real. Suspicions, in order: per-worker
per-body cold caches (sketch, crater ladders, plate partitions rebuilt in
each of four workers), heavier crater/band grammars on those worlds, and
E-core scheduling. Check by timing one worker's first patch against its
tenth on the same body.

### A landing view converges in minutes off Earth

Mars, landed, quiet view: queue **12.4 s deep**, `pending` pinned at the
128 in-flight cap, drawn level still 6 after fifteen seconds; Proxima b
still `pending 128, level 8` after 25 s with selections climbing. The
first pass's queue-versus-run arithmetic plus the run dilation above
compounds into ground that sharpens for minutes. The pool-size experiment
(perf.md) and the two entries above all bear on this one number, which is
the one a player actually watches.

### Occasional 9–16 ms spikes inside terrain phases during convergence

During the Proxima descent-convergence window: `terrain.build` max 16.1 ms
(budgeted 0.25 ms × 4), `terrain.select` max 16.5, `snapshot` max 8.6,
`starfield` max 7.0, `terrainPatches` max 9.8 — several spans an order
over their means in the same stretch, which smells like GC pauses landing
inside whichever span is open (dev build, allocation-heavy window). Worth
one trace with attribution before believing any individual span's max.

---

## Simulation

### Maximum warp spends 4–6.5 ms a frame in `advance`

At 100,000× in Mars orbit with three systems loaded: `Engine/advance`
**3.95 ms mean, 10.4 max**; the engine step 4.5 mean / 6.5 p95 against its
2.0 ms budget line. At 1,000×: 1.7 mean. The step cap bounds it, but the
cost per tick presumably scales with loaded systems (below), and nothing
measured it at 5–10 loaded systems. Check `achievedTimeScale` under load
and where the per-tick time goes at max warp.

### `snapshot()` cost scales with loaded systems, and nothing unloads one

Snapshot per frame: 0.23 ms with one system loaded, **0.77–1.01 ms with
three** — and `loadedSystems` only grows (`systems 3` for the rest of the
session). Twenty systems visited is a snapshot alone near the whole engine
budget, every frame, forever. The first pass flagged the allocation; this
pass adds the scaling and the absent eviction policy. Check whether
anything may unload a system the player has left (saves pin references;
the catalog regenerates deterministically, so a cache-not-save unload
should be legal by ADR/AGENTS rules).

### Something in the first tour paused the clock, and nothing resumed it

Mid-session the clock was found **paused at tick 5782 (~90 s of sim)** —
every flight and warp measurement after it silently described a frozen
world until an explicit `resume()`. Bisected without reproducing: `look`,
`visit`, `setStanceScrub`, `setHeading`, and switches to `/docs`, `/`,
`/settings` all leave it running. The untested combination in the original
timeline is _leaving the planetarium for flight while a 2 m surface stance
is held_ (the heading sweep ended there, and sim-time arithmetic puts the
pause at roughly that wall moment). Not a perf item — a correctness one —
but it invalidates measurements wholesale, so it is filed here for the
verifying agent to bisect first.

---

## Memory

### The tour ends at 906 MB of JS heap, against a ≤900 MB budget

`performance.memory` after the full tour (three systems, two landings, a
stance on a generated world): **628 MB** at the Proxima summit, **906 MB**
at the end. The budgets table still records 66–74 MB, measured before
streamed terrain existed — that row is stale either way. Prime suspects:
the geometry cache (450 MB at its documented full ceiling) plus the field
cache (138 MB full), retained across operating-point changes on the same
body by design; plus three resident worlds. Unknown: whether anything ever
_shrinks_ when the player leaves a body's surface for good — `#evict`
trims only above caps and `clear()` only fires on a body change, so a
session that ends its last landing holds that landing's full working set
indefinitely. Needs a heap breakdown before anyone tunes a cap.

---

## Not measured here, deliberately

Shipped-build mode switches and docs pages (dev React inflates both); the
author's dock panels held open; multiplayer; WebGL fallback; any window
size other than the rig's default — the first pass's retina-window warning
applies to every terrain number above.

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
`clock.paused` is false, which this pass learned the hard way.
