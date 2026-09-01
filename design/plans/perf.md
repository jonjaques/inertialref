# Performance: what is left

What the timeline instrument ([ADR-0022](../../docs/adr/0022-the-timeline.md))
still has open — `ir.profile`, `--trace` into `pnpm timing`, the worker tracks,
and raw-trace attribution of whatever the spans do not cover. Every entry is a
measured finding or a named suspicion with the measurement that raised it.
Operating points are named on every figure, because a figure measured at one is
a figure about that point.

**Where the numbers come from.** Two rigs. Stationary operating points — the
flight start in Earth orbit at 27.6 km/s, the planetarium looking at Earth from
14,400 km, arrival at Earth's summit site, and the converged summit stance —
profiled on the dev build and, where the entry says so, re-measured on the
shipped build served by `wrangler dev` on 8787. And the game as it is played:
mode switches, planet-to-planet retargets, a camera orbit, a scrub descent from
380 km to two meters, flight teleports, time warp, landings, jumps to two
generated systems and back, the title cutscene, and the documentation. The
machine is an Apple M5 (4P+6E, `hardwareConcurrency` 10), the window the
driver's 1600×900 at DPR 1, occluded.

Read every figure against the caveats before quoting it. Spans are
trustworthy; frame _periods_ from this rig are not.

---

## The frame

### Garbage collection eats 3–5% of the main thread at idle

Shipped build, planetarium orbit, 4 s: **131 ms of GC**, scavenges every
~200 ms; dev build 309 ms with incremental major-GC marking rescheduled 2,100
times.

The same question arrives from the other side during convergence. In the
Proxima descent window, several spans run an order over their means in the same
stretch — `terrain.build` max 16.1 ms against a 0.25 ms × 8 budget,
`terrain.select` max 16.5, `snapshot` max 8.6, `starfield` max 7.0,
`terrainPatches` max 9.8 — which is the shape of a collector pause landing
inside whichever span happens to be open.

The named producers behind that allocation rate are cut, and **none of it has
been re-measured _as GC_**. That is the open half: the rate is down by
construction and nobody has recorded the collector's share since. One trace with
attribution before believing any individual span's max. If scavenges still land
inside frames, the next candidates are the selection's per-walk node objects and
`pyramid`'s per-level string maps, both inside the re-walk path that a stance
does not pay.

### The balance pass has one idea worth taking and one that is not

`balance` in `packages/rendering/src/terrainSelect.ts` is 56% of a selection
walk. Two further ideas are measured rather than argued:

- **Skip the ring probe for nodes within one level of the deepest.** Exact, and
  worth 8%: a summit selection is flat across levels (5:8 6:60 7:75 8:75 9:75
  10:80 11:60 12:64 13:55 14:32 15:16), so only 48 of 600 nodes qualify.
- **Drive each pass from a recheck set built out of the previous pass's split
  nodes' ancestors.** Declined. At the pass sizes a summit selection actually
  has — 29, 12, 10, 5 and 2 splits after the first — the key arithmetic costs
  more than the eight probes per node it saves.

A stance pays neither; a descent pays two walks a frame. The no-crack property
is load-bearing and any change re-runs the crack tests.

### Mode switches drop two to six frames each, worst ~137 ms

Every SPA switch shows late frames with nothing inside the spans — React
mount/unmount commits. Entering the **planetarium is the worst: 135.9 / 137.4
ms** on its mount frame, twice, reproducibly. Entering flight: six frames over
25 ms, max 75. Docs, home and settings: 28–45 ms. A retarget profile shows the
same population, 30–45 ms frames with no span inside them.

Clicking `/docs/concepts/coordinates` from the docs index is the same class:
**26 of 125 frames over 25 ms**, max 53, engine at 0.7 ms — all page render.
The scene keeps drawing under the docs, and a whole shiki-highlit page mounts in
one commit.

**Every figure here is dev-build React, which runs about five times the shipped
cost, and nobody has measured the shipped one.** That measurement comes before
any work: the planetarium's mount is dock, catalog, rail and panels in a single
commit, and if it survives the shipped build the candidates are chunked page
mounts and pausing the scene behind the reader.

## Streaming

The GPU tile producer ([ADR-0023](../../docs/adr/0023-the-gpu-producer.md)) is
what a WebGPU page runs: sixteen tiles a dispatch in **10.0 ms** against 805.6
ms for the same sixteen on the CPU, and a two-meter stance on Luna converging in
**4.4 s** against 25.5–32.7 s from the worker pool. Everything below is the
fallback's, which is what a page without WebGPU gets and what `?producer=cpu`
re-runs.

### A worker's runs are 5–10× the Node baseline, and nobody knows why

`generateHeightfield` in the browser pool: Earth 45–76 ms; Mars **129 ms mean
at four workers, 187 at eight** (max 419); Proxima Centauri b **304–410 ms
mean**, max 648. The same grammars quiet in Node are 22–50 ms.

Part of the gap is dilation the pool-size table in
`apps/game/src/engine/browserWorker.ts` measures directly — 45% from four
workers to eight, the extra threads landing on E-cores. Part is not: Earth on
the same rig stays under 80 ms, so the per-body spread is real. Suspicions, in
order: per-worker per-body cold caches (sketch, crater ladders, plate partitions
rebuilt in each of eight workers), heavier crater and band grammars on those
worlds, and E-core scheduling. **The check that separates the first from the
rest is one worker's first patch against its tenth on the same body, and it has
not been run.**

This is what fallback convergence is made of. To the deepened floor is ~1,000
patches; at 41.6 jobs/s that is ~24 s of ground sharpening after an arrival,
which is the number a player watches. A Mars landing reaches drawn level 13 in
twenty seconds against level 10 at four workers, with the queue at 2.9 s rather
than 4.0.

**A smaller in-flight cap is not the lever.** `IN_FLIGHT_CAP` 128 over
`poolSize()` workers times the run time _is_ the queue, by construction, but
cutting it stalls the strictly serial refinement ladder below one rung
(~90 patches).

### The star survey's priority lane is unbuilt, and unneeded

One reading of `Workers/queue universe.surveyRegion` on a return to Sol is
**4.0–8.0 s** — the two survey jobs behind a hundred queued heightfields, the
sky repopulating seconds after the jump completes. It does not reproduce.
`STARFIELD_HYSTERESIS` is 8 light years and no system in `ir.targets()`' sweep
is more than 6.5 away, so provoking it takes a multi-hop tour — and every hop
retargets the observatory, which retires the terrain backlog first. A priority
lane in the pool buys nothing until something else fires a survey behind a full
window.

### An atmosphere bakes on the main thread the first time one is seen

`scatteringFor` is a synchronous ~40 ms bake. `watchSystemAtmospheres` polls the
loaded-system set once a second and drains new hazes one table per macrotask,
and the boot prebake covers the atmospheres of the systems loaded at boot —
neither is fast enough for the frame a jump arrives on. A jump to a generated
system lands a `Boot/bake atmosphere` entry mid-session: **39.7 ms inside a
43.3 ms frame**, which is the largest single thing left in an arrival.

**Deferring it is safe.** `createAtmosphereMaterial` binds 1×1 stand-ins so a
shell whose tables have not arrived runs the identical graph — full
transmittance, no multiple scattering, scattering coefficients at zero, a vacuum
that draws nothing — so a body that arrives before its tables draws without haze
rather than wrongly. `Bodies` calls `air.setScattering(…)` every frame the shell
is drawn, so it picks them up on whichever frame they land.

**What blocks it is the layer graph, not the risk.** The task shape is the one
`universe.surfaceDetailFloor` takes — two `Float32Array`s back, `toTexture`'s
half-float conversion staying on the main thread — but the bake lives in
`packages/rendering` and so does `packages/workers`, both layer 5, and
`pnpm graph` allows dependencies on strictly lower layers only. Moving the
scattering model down is an architectural question rather than a plumbing one: a
scattering LUT is arguably optics rather than rendering, and
`packages/universe` already owns the `HazeAuthoring` it is derived from. That
answer wants an ADR, not an import. Until then this is one dropped frame per
distinct atmosphere per session, on an arrival that has other work in it anyway.

## Boot

### Boot is the texture warm, and that is the only line worth working

The Boot track on a cold dev boot, measured clean — one census, no watchdog
remount: `navigation to first light` **4,302 ms**, `catalog.fetch` 6 ms,
`catalog.decode` 33 ms, nine atmosphere bakes at 20–39 ms each, and `preload`
1,843 ms of which **`warming surface maps` is 1,569 ms** — 85% of the budget,
and decode-and-upload rather than fetch.

The ≤4 s cold-load budget in
[`docs/design/technical.md`](../../docs/design/technical.md) is still unmeasured
on a 20 Mbit connection. If it needs shortening, this is the only line worth an
hour: upload the loaded system's maps first and let the rest trail the reveal,
or move the set to a GPU-compressed container so the decode disappears.

## Memory and the resident world

### The tour ends at 906 MB of JS heap, against a ≤900 MB budget

`performance.memory` after the full tour — three systems, two landings, a stance
on a generated world: **628 MB** at the Proxima summit, **906 MB** at the end.
Two narrower readings: **488 MB** at a converged Earth summit with one system
loaded, **770 MB** after a Mars landing plus a jump, with two.

The budgets table in
[`docs/design/technical.md`](../../docs/design/technical.md) still records
**66–74 MB**, measured before streamed terrain existed. That row is stale
either way.

Prime suspects: the geometry cache (450 MB at its documented full ceiling) plus
the field cache (138 MB full), retained across operating-point changes on the
same body by design, plus each resident world. The question is whether anything
ever _shrinks_ when the player leaves a body's surface for good — `#evict` trims
only above caps and `clear()` only fires on a body change, so a session that
ends its last landing holds that landing's full working set indefinitely.
**A heap breakdown comes before anyone tunes a cap**, and it gates the entry
below.

### Nothing unloads a system, and `snapshot()` scales with what is loaded

`Engine/snapshot` reads 0.18–0.27 ms in the browser at one system loaded. In
Node with the pose cache missing every frame the scaling is 0.098 ms at one
system and 0.147 at three — 129 bodies against 161. Addresses are memoized, so
what is left is one fresh object per body per frame plus the frame-chain walk.

`loadedSystems` only grows. Twenty systems visited is a snapshot alone near the
whole engine budget, every frame, for the rest of the session.

**The mechanism exists and has no caller.** `World.updateInterest` loads systems
within a radius and unloads the ones beyond 1.25× it, never unloading one that
contains an entity. Wiring it into the frame loop changes what unloads
mid-flight, which is a gameplay decision. The rest of the legality is
settled — saves pin references and the catalog regenerates deterministically, so
a cache-not-save unload is allowed by the ADRs — but it wants the heap
breakdown first.

### Warp at 100,000× is untested past three loaded systems

Three systems loaded: `Engine/advance` **3.95 ms mean, 10.4 max**, engine step
4.5 mean / 6.5 p95 against its 2.0 ms budget line. One system, looking at Mars:
advance 0.03 ms at 1×, 1.43 at 1,000×, **2.52 mean and 5.0 max at 100,000×**,
engine step 2.80 / 5.3, `Engine/frame` still 16.67 — no dropped frames.

The gap between those two readings is the loaded-system count, which is the
entry above. Nothing has measured five to ten.

---

## The order it is worth taking

1. **One atmosphere bake, 39.7 ms, on the arrival frame** — the largest single
   thing left in a transition, and the fix shape is already written down.
2. **Shipped-build mode switches and docs pages.** Every figure is dev React at
   about five times the real cost. Measure before acting.
3. **Per-job heightfield time**, which is what fallback convergence is made of.
   One worker's first patch against its tenth on the same body separates the
   cold per-body caches from the grammar and the scheduler.
4. **A heap breakdown**, which gates both the cap tuning and system eviction.
5. **Garbage collection**, re-measured as GC now that its named producers are
   gone.

## Caveats that shape these numbers

- **The occluded rig's frame periods are not the app's.** Shipped build in
  orbit: 18 of 240 periods over 25 ms while the main thread's longest task was
  3.8 ms — the occluded compositor skips vsyncs the page never sees. Attribute
  late frames from the rig only to spans _inside_ them.
- **A figure taken before `?presentation=occluded` is suspect in both
  directions.** Focus emulation reports `visibilityState: 'visible'` for a
  window that is still occluded, so the presentation watchdog's readback comes
  back transparent black for a healthy renderer, climbs its whole ladder and
  remounts the canvas. That doubles the preload census and leaves a **3200×1800
  drawing buffer for a rig asking for 1600×900 at DPR 1**, because
  `useDevicePixelRatio`'s media query does not re-fire under emulation. Terrain
  selection is measured in display pixels, so those are retina figures wearing a
  default-window label. The driver puts the flag on every URL it navigates to.
- **A measurement taken beside a test run is a measurement of the test run.**
  Not noise — a substitution. Finish the suite, let the machine settle, then
  measure, and take the browser down afterward so the suite gets the same
  courtesy.
- **A loaded machine poisons worker figures silently.** The same summit arrival
  reads 45 ms runs quiet and 285 ms with a build running beside it, the queue
  7.8 s rather than 1.1, and convergence over a minute. `CONTEXT.md` records the
  trap for patch generation; it applies to every pool figure here.
- **Dev-build React numbers are ~5× the shipped ones.** Both are real; only one
  is about a player. The dev figure is still the one an author feels all day.
- **The driver re-navigates when a URL half-matches.** One "production" trace
  was actually the dev page — the stacks inside it said `localhost:5173` while
  the command said 8787. Verify `location.origin` inside any run whose numbers
  will be quoted.
- **Confirm `clock.paused` is false before quoting any figure that depends on
  the world advancing.** A paused clock describes a frozen world in perfect
  detail, and every flight and warp reading taken through one is silently about
  nothing.
- **A camera that stays is not a ship that leaves.** `ir.goTo` alone does not
  clear the streamer: the observatory still holds the old body, so the in-flight
  window keeps running for a surface the ship is no longer near. That is the
  camera being right rather than the streamer being wrong, and it is why a jump
  does not produce the cancellations one expects.

## Not measured here, deliberately

The author's dock panels held open; multiplayer; WebGL fallback; any window size
other than the rig's default — the retina-window caveat applies to every terrain
number above.

## Reproducing

```bash
# a profile at an operating point (the level arms and restores itself)
node scripts/drive.mjs --url "http://localhost:5173/planetarium?timing=full" \
  --js "ir.visit('g:milky-way/s:SOL/b:2',{site:'summit',height:2})" \
  --wait 15000 --js "(await ir.profile(3000)).text"

# a trace, read back as a table; --threads separates the worker tracks
node scripts/drive.mjs --url "http://localhost:5173/planetarium?timing=trace" \
  --js "ir.look('g:milky-way/s:SOL/b:2')" --wait 4000 --trace 4000
pnpm timing --group all

# the boot track, drained after a cold load
node scripts/drive.mjs --fresh --url "http://localhost:5173/?timing=full" \
  --wait 4000 --js "ir.timing.drain().filter(e => e.track === 'Boot')"

# the pool-size table: land, converge, read throughput and drawn level together
node scripts/drive.mjs --url "http://localhost:5173/planetarium?producer=cpu&workers=8" \
  --file .scratch/poolsize.mjs

# the selection microbenchmark and its CPU profile. `ready: () => true` stands
# in for a converged cache — a starved tree stops at level 0 and measures
# nothing, which is what a streamer with no pool gives you.
node --cpu-prof --cpu-prof-dir=.scratch/prof .scratch/selectBench.ts
```

What the spans do not cover — GC, React commits, compositor stalls — comes from
the raw trace: filter the main thread's `ph: 'X'` events and bucket by name and
by `FunctionCall` source, which is how every "outside anything instrumented"
line above is attributed.

A scenario is a page-side script handed to the driver with `--file`; `.scratch/`
is where such throwaways live, and because they are not tracked, the mechanics
that make them work are recorded here. A transition is measured by scheduling
the gesture _inside_ a profile window — `ir.profile` arms and restores the
timing level itself, so no `?timing=` is needed except to capture boot.

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

Retarget tours schedule `ir.look` calls the same way; the camera orbit is
`observatory.setAngles((azimuth += 0.02), 0.25, false)` on a 16 ms interval;
warp is `engine.world.clock.setTimeScale(n)`.
