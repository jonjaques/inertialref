# Performance: what the timeline found

The first deep pass over the instrument ADR-0022 built — `ir.profile`,
`--trace` into `pnpm timing`, the worker tracks, and raw-trace attribution of
whatever the spans do not cover. Everything below is a measured finding or a
named suspicion with the measurement that raised it; nothing here is fixed
yet unless the entry says so. Operating points are named on every figure,
because a figure measured at one is a figure about that point.

**Where the numbers come from.** Four operating points, each profiled on the
dev build and the two that matter re-measured on the shipped build served by
`wrangler dev` on 8787: the flight start (Earth orbit, 27.6 km/s), the
planetarium looking at Earth from 14,400 km, arrival at Earth's summit site,
and the converged summit stance. The machine is an Apple M5 (4P+6E), the
window the driver's 1600×900 at DPR 1, occluded. Commands to reproduce are at
the bottom.

---

## Landed on this branch

Recorded so the next reader does not re-find them; the commit bodies carry
the full numbers.

- **The whole interface re-rendered eight times a second.** `App` selected
  `snapshot.status` — a fresh object graph per sample — so every 8 Hz tick
  re-rendered the entire tree, and the travel survey handed the catalog a
  fresh rows array at 2 Hz besides. Shipped build, planetarium at Earth:
  4–5 ms of react-dom per tick, ~120 ms of a 4 s window; dev build: 627 ms
  of the same window with 33 main-thread tasks over 12 ms, every one a
  dropped frame. The live panels subscribe to the store themselves now, and
  the survey bails out when the sky has not changed.
- **The summit hover re-selected ground that could not have changed.**
  `terrain.select` was 2.07 ms a frame at a stance (shipped build) plus
  0.68 ms of `terrain.request` string keys, recomputing a selection whose
  every input was still. The streamer holds its selection against the eye
  (±5 mm; the pose round-trip jitters 0.15 mm), the optics, the floor and a
  cache epoch. Measured after: the engine step falls 3.20 → 0.67 ms at the
  stance, the terrain phase 2.87 → 0.18 ms, and `ir.terrain().selections`
  stands still while frames pass.
- **The starfield rewrote twenty thousand stars every rebase.** The gate was
  `origin.generation`, which ticks every 4,096 m — every ninth frame in Earth
  orbit — for a buffer of _directions_, which translation does not change. It
  is the parallax now: the survey's identity, the origin's orientation and
  anchor exactly, and its position within 1e-5 of the nearest star's distance.
  That star is the system's own sun at ~1 AU, so the budget in orbit is
  ~1,500 km rather than 4 km. `Render/starfield` in the planetarium at Earth:
  **0.48 ms mean / 1.7 ms max → 0.00 / 0.10**, dev build.
- **Orbit traces allocated several thousand objects a frame.** `placePathInto`
  is `placeAt`'s arithmetic without the `RenderPlacement`, the `UV.translate`
  per point (three `carry` records and a result), the conjugate rebuilt per
  point, or the `Math.asin` and LOD tier a line has no use for. The property
  test pins it to the reference within one float32 step _or_ one double step at
  sector scale — the second because a universe offset runs to 2^40 m, where a
  double resolves 0.24 mm, so folding a fine shift in universe coordinates
  rounds it away and adding it after the difference does not. `Render/orbitTraces`:
  **0.57 ms shipped / 2.5 ms max dev → 0.13-0.37 mean, 0.5-0.8 max dev**.
- **`snapshot()` formatted every body's address four times a frame** — once for
  the field, once through `bodyFrameId`, twice inside a ternary that spelled
  `bf:${formatAddress(…)}` on both arms. Sol is 129 bodies: over 30,000 formats
  and 23,000 template strings a second on the one path every operating point
  pays. `formatAddress`, `bodyFrameId` and `bodyFixedFrameId` are memoized on
  the address object — a `WeakMap`, because a region address is built fresh per
  call. `Engine/snapshot` 0.26-0.39 → **0.18-0.27 ms** dev; in Node, with the
  pose cache actually missing, 0.098 ms at one system and 0.147 at three.
- **The balance pass rebuilt its depth map in every one of seven passes.** A
  summit selection settles in seven and the first is the only large one — the
  passes split 72, 29, 12, 10, 5, 2 and 0 nodes, so six of them walked nine
  hundred ancestor chains to find at most twenty-nine splits. Depth is
  monotone, so the map is carried. **0.777 → 0.612 ms a walk** with the
  selection byte-identical (866 visited, 51 culled, 600 patches).
- **`surfaceDetailFloor` was paid inside the frame a body arrives.**
  `universe.surfaceDetailFloor` is a pool task; the streamer holds the ground
  back for the frames it takes rather than selecting against a ceiling it does
  not know. Node, first `update` on a cold body: Earth **39.8 → 5.7 ms**, Mars
  40.3 → 6.2, Luna 48.6 → 6.5 — the floor was 33-43 ms of each.
- **Stale heightfield jobs ran to completion after their view was gone.**
  `clear()` cancels the in-flight window. Measured in the browser, landed on
  Mars and then looking away: queued 124 → **0 within 60 ms**, `cancelled` 124,
  at a 264 ms mean run — **33 seconds of worker time** not spent on ground
  nobody will see.
- **The worker pool left six cores idle.** The ceiling was 4 and nothing had
  measured it; it is 8. See the table in `engine/browserWorker.ts`: on an M5,
  landing on Mars and converging twenty seconds, 4 → 8 workers is 30.4 → 41.6
  jobs/s, 4,037 → 2,876 ms of queue, and drawn level **10 → 13**, with
  `Engine/frame` unchanged (16.67 mean / 23.3 p95 against 16.71 / 19.3).
- **The rig measured itself.** `?presentation=occluded` — see the caveat below,
  which is now a fixed one.

---

## Open: the frame

### Garbage collection eats 3-5% of the main thread at idle

Shipped build, planetarium orbit, 4 s: **131 ms of GC**, scavenges every
~200 ms; dev build 309 ms with incremental major-GC marking rescheduled
2,100 times. The three named producers — the starfield rewrite, the orbit
traces, `snapshot()`'s address strings — have all landed above, and none of
them has been re-measured _as GC_. That is the open half: the allocation rate
is down by construction and nobody has recorded the collector's share since.
Re-measure before spending anything else here; if scavenges still land inside
frames, the next candidates are the selection's per-walk node objects and
`pyramid`'s per-level string maps, both inside the re-walk path that stances
no longer pay.

### The balance pass has two more ideas, both measured and both declined

`balance` is still 56% of a selection walk after the carried depth map, and
two further ideas were measured rather than argued:

- **Skip the ring probe for nodes within one level of the deepest.** Exact,
  and worth 8%: a summit selection is flat across levels (5:8 6:60 7:75 8:75
  9:75 10:80 11:60 12:64 13:55 14:32 15:16), so only 48 of 600 qualify.
- **Drive each pass from a recheck set built out of the previous pass's split
  nodes' ancestors.** At these pass sizes — 29, 12, 10, 5, 2 splits — the key
  arithmetic costs more than the 8 probes per node it saves.

A stance pays none of this; a descent pays two walks a frame. The no-crack
property is load-bearing and any change re-runs the crack tests.

### `snapshot()` still scales with what is loaded, and nothing unloads

0.098 ms at one system and 0.147 at three, in Node with the pose cache
missing every frame — 129 bodies against 161. The addresses are memoized, so
what is left is one fresh object per body per frame plus the frame-chain
walk, and `loadedSystems` only ever grows. Twenty systems visited is a
snapshot alone near the whole engine budget, forever. The open question is
not the allocation shape, it is whether anything may **unload** a system the
player has left: saves pin references, the catalog regenerates
deterministically, so a cache-not-save unload should be legal by ADR/AGENTS
rules. It wants a heap breakdown first — see the memory entry in
[perf-2](perf-2.md).

## Open: streaming and boot

### The heightfield queue is 25–90× the run

The pool's own header names the distinction: slow tasks want optimization, a
deep queue wants more workers or fewer requests. Measured queues for
`universe.generateHeightfield` on arrival at the summit: **1,138 ms mean
(dev, n=354)**, **2,015 ms (shipped, n=8)**, against runs of 45–83 ms — and
on a loaded machine (the preview server building beside the game) runs
dilate to 285 ms and the queue to **7.8 s**, with convergence taking over a
minute. The arithmetic is closed: `IN_FLIGHT_CAP` 128 over
`poolSize() = min(4, cores − 2)` workers × run time _is_ the queue, by
construction.

**The experiment is run and the ceiling is eight.** On an M5 (4P+6E,
`hardwareConcurrency` 10), landed on Mars and converging for twenty seconds:

| workers | jobs/s | mean run | mean queue | drawn level |
| ------: | -----: | -------: | ---------: | ----------: |
|       4 |   30.4 |   129 ms |   4,037 ms |          10 |
|       6 |   34.2 |   175 ms |   3,730 ms |          11 |
|       8 |   41.6 |   187 ms |   2,876 ms |          13 |

Runs do dilate — 45% from four to eight, the extra threads landing on E-cores
— and it is not close: throughput up 37%, a second off the queue, and three
more levels of ground in the same twenty seconds. The frame does not pay for
it (16.67 ms mean / 23.3 p95 at four, 16.71 / 19.3 at eight; fourteen late
frames against twelve). `?workers=N` re-runs the table anywhere.

**The other end is spent too, and better.** Cancellation on `clear()` retires
the whole stale window rather than letting a camera turn's abandoned requests
run — 124 jobs in 60 ms, ~33 s of worker time — which is the lever this entry
declined as "complexity the pool was deliberately built without" and which
turned out to be one method on a handle it already had. A smaller in-flight
cap still stalls the strictly serial refinement ladder below one rung
(~90 patches) and is still not worth pulling.

**What is left is the per-job time itself**, which is the next entry.
Convergence to the deepened floor (level 15-19 since the drawn tail landed)
is ~1,000 patches; at 41.6 jobs/s that is ~24 s of ground sharpening after an
arrival, which is the number a player actually sees.

### A worker's runs are 5-10× the Node baseline, and nobody knows why

`generateHeightfield` on Mars in the browser pool: **129 ms mean at four
workers, 187 at eight**, against 22-50 ms for the same grammars quiet in Node.
Part of that is the dilation the table above measures directly, and part is
not: Earth on the same rig stays under 80 ms, so the per-body spread is real.
Suspicions, in order: per-worker per-body cold caches (sketch, crater ladders,
plate partitions rebuilt in each of eight workers now rather than four),
heavier crater and band grammars on those worlds, and E-core scheduling. The
check that separates the first from the rest is one worker's first patch
against its tenth on the same body, and it has not been run.

### Boot is the texture warm, and that is the only line worth working

The Boot track on a cold dev boot, measured clean (one census, no watchdog
remount): `navigation to first light` **4,302 ms**, `catalog.fetch` 6 ms,
`catalog.decode` 33 ms, nine atmosphere bakes at 20-39 ms each, and
`preload` 1,843 ms of which **`warming surface maps` is 1,569 ms** — 85% of
the budget, and decode-and-upload rather than fetch. If cold load needs
shortening toward the ≤4 s budget line (still unmeasured on a 20 Mbit
connection), this is the only line worth an hour: upload the loaded system's
maps first and let the rest trail the reveal, or move the set to a
GPU-compressed container so decode disappears.

The previous figure for the same boot was 10.2 s, of which ~6.5 s was the rig
recovering from a watchdog it should never have woken. See the caveats below.

### An atmosphere bakes on the main thread the first time one is seen

`scatteringFor` is a synchronous ~40 ms bake and the boot prebake only covers
the atmospheres of the systems loaded _at boot_. A jump to a generated system
therefore lands a `Boot/bake atmosphere` entry mid-session: **39.7 ms inside a
43.3 ms frame**, which is the largest single thing left in an arrival.

It is pure arithmetic on an `AtmosphereRecipe` and `packages/rendering` owns
it, so the task shape is the same one `universe.surfaceDetailFloor` took —
two `Float32Array`s back, `toTexture`'s half-float conversion staying on the
main thread. The open question is not where to run it but what the shell draws
while it waits: `Bodies` calls `air.setScattering(...)` every frame the shell
is drawn and simply skips it when there is no haze, so the deferred state is
reachable, and nobody has looked at what it looks like.

## Caveats that shaped these numbers, kept so they keep shaping them

- **The occluded rig's frame periods are not the app's.** Shipped build in
  orbit: 18 of 240 periods over 25 ms while the main thread's longest task
  was 3.8 ms — the occluded compositor skips vsyncs the page never sees.
  Attribute late frames from the rig only to spans _inside_ them.
- **The rig used to rebuild the renderer on every boot, and that changed two
  things at once.** Focus emulation reports `visibilityState: 'visible'` for a
  window that is still occluded, so the presentation watchdog's readback came
  back transparent black for a healthy renderer, climbed its whole ladder and
  remounted the canvas. Every boot figure carried a doubled preload census —
  and every terrain figure taken _after_ a rebuild carried a **3200×1800
  drawing buffer for a rig asking for 1600×900 at DPR 1**, because
  `useDevicePixelRatio`'s media query does not re-fire under emulation. Terrain
  selection is measured in display pixels, so those were retina figures wearing
  a default-window label. `?presentation=occluded` is on every URL the driver
  navigates to now; a figure from before it is suspect in both directions.
- **A measurement taken beside a test run is a measurement of the test run.**
  Not noise — a substitution. Finish the suite, let the machine settle, then
  measure, and take the browser down afterwards so the suite gets the same
  courtesy.
- **A loaded machine poisons worker figures silently.** The same summit
  arrival reads 45 ms runs quiet and 285 ms with a build running beside it.
  CONTEXT.md already records this trap for patch generation; it applies to
  every pool figure here.
- **Dev-build React numbers are ~5× the shipped ones.** Both are real; only
  one is about a player. The dev figure is still the one an author feels all
  day.
- **The driver re-navigates when a URL half-matches.** One "production"
  trace in this pass was actually the dev page — the stacks inside it said
  `localhost:5173` while the command said 8787. Verify `location.origin`
  inside any run whose numbers will be quoted.

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
node scripts/drive.mjs --url "http://localhost:5173/planetarium?workers=8" \
  --file .scratch/poolsize.mjs

# the selection microbenchmark and its CPU profile. `ready: () => true` stands
# in for a converged cache — a starved tree stops at level 0 and measures
# nothing, which is what a streamer with no pool gives you.
node --cpu-prof --cpu-prof-dir=.scratch/prof .scratch/selectBench.ts
```

What the spans do not cover — GC, React commits, compositor stalls — comes
from the raw trace: filter the main thread's `ph: 'X'` events and bucket by
name and by `FunctionCall` source, which is how every "outside anything
instrumented" line above was attributed.
