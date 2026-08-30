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

---

## Open: the frame

### The starfield rewrites twenty thousand stars every rebase

`Starfield` rewrites its whole instance buffer — `placeOnStarShell`, a
distance, a flux and three attribute writes per star, plus a fresh `flux`
array — whenever `origin.generation` moves. The origin rebases every 4,096 m
of travel, which in the flight start's orbit is every ~9 frames, so the
component that "does nothing unless the survey changes" is the largest Render
span on the home page: **0.48 ms mean, 1.7 ms max** (dev build, 182 frames).

The suspicion: the rewrite condition is far too wide. The buffer holds
directions times the shell radius, and a direction is invariant under
translation until the origin moves a meaningful fraction of the _nearest
star's_ distance — light-years for the field, 1 AU for the system's own sun,
which the survey includes. Orientation is the input that genuinely
invalidates (a reanchor), and the survey generation already has its own
check. A tolerance near 1e-5 of the nearest distance keeps the error under a
quarter pixel at the zoom slider's extreme — the bound is the sun's shell
sprite peeking out from behind the sun's own drawn disk — and turns the
rewrite cadence from every ninth frame into roughly once a minute in orbit.
Warp across a system still rewrites per frame, which is what it costs today.

### Orbit traces re-place every vertex of every trace, allocating

`OrbitTraces` maps each path point through `placeAt` every frame — correctly,
since compression is radial about the eye and the eye moves — but `placeAt`
allocates several vectors per call, and eight visible traces of 97 points is
~800 calls and a few thousand allocations a frame: **0.57 ms mean on the
shipped build** in the planetarium, 2.5 ms max in dev, and a steady feed to
the scavenger. The arithmetic must not change (ADR-0003; the small moons
vibrated the last time compression was measured from the wrong point); the
allocation can — a placement loop that writes into the Float32Array directly,
or an `placeAt` variant that fills a caller's out-parameter, is the same
mathematics without the garbage. Suspected win: most of the span and a slice
of GC. Unmeasured until tried.

### `snapshot()` rebuilds the world's description every frame

0.26–0.39 ms at every operating point, ~2% of the budget: `formatAddress`
builds a string per body per frame (Sol is 129), `frameChain` an array per
entity, and every entity and body snapshot is a fresh object. The address of
an immutable body never changes, so the string is cacheable at generation or
through a `WeakMap`; the rest is allocation shape. Small, but it is the one
cost paid everywhere, and it feeds the same GC the traces do.

### Garbage collection eats 3–5% of the main thread at idle

Shipped build, planetarium orbit, 4 s: **131 ms of GC**, scavenges every
~200 ms; dev build 309 ms with incremental major-GC marking rescheduled
2,100 times. The three producers above plus the (now fixed) React churn are
the named sources. Nothing here suggests a leak — heap stabilizes — it is
allocation rate. Re-measure after the traces and snapshot entries land; if
scavenges still land inside frames, the next candidates are the selection's
per-walk node objects and `pyramid`'s per-level string maps, both inside the
re-walk path that stances no longer pay.

### The balance pass is nearly half of a selection walk

Node CPU profile of `.scratch/selectBench.ts` (Earth summit, converged
cache, 1,062 visited nodes): `balance` carries ~500 ms of 1,149 ms of self
time — the drawn and wanted walks are ~0.8–0.96 ms each and the balance pass
is close to half of each. It builds a depth map over every node's ancestor
chain and probes eight neighbors per node per pass, keyed by packed doubles
above Smi range. A stance no longer pays it; a descent pays it twice a
frame. Ideas worth measuring: per-level maps with Smi-range keys, or an
early-out for selections whose level span rules out a 2:1 violation. The
no-crack property is load-bearing — any change re-runs the crack tests.

---

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

The experiment nobody has run: this machine has ten cores and the cap leaves
four of the six spare ones idle. Raise the ceiling (6, then 8) and measure
jobs per second _and_ per-job dilation — the extra workers land on E-cores,
and if each job slows toward what the queue saves, the ceiling is right where
it is. The alternative levers pull the other end: a smaller in-flight cap
shortens the stale queue a camera turn abandons but stalls the strictly
serial refinement ladder below one rung (~90 patches); request aging or
cancellation spends complexity the pool was deliberately built without.
Convergence to the deepened floor (level 15–19 since the drawn tail landed)
is ~1,000 patches — at the quiet-machine 88 jobs/s that is ~12 s of ground
sharpening after every arrival, which is the number a player actually sees.

### Boot is the texture warm, and the rig measures its own recovery

The Boot track on a cold dev boot: catalog fetch 7.9 ms, decode 39.1 ms,
atmosphere bakes ~20–34 ms each — and **`warming surface maps` 1,702 ms of
the 1,969 ms preload**, the entire budget. The second pass (below) re-runs
it at 1,044 ms warm, so decode-and-upload, not fetch, is the cost. If cold
load needs shortening toward the ≤4 s budget line (still unmeasured on a
20 Mbit connection), this is the only line worth working: upload the loaded
system's maps first and let the rest trail the reveal, or move the set to a
GPU-compressed container so decode disappears. Nothing else on the track is
worth an hour.

**The rig artifact:** in the driver's occluded Chrome the presentation
watchdog cannot see a lit pixel — focus emulation makes `visibilityState`
report `visible`, so the occlusion deferral never engages, the ladder
exhausts, and the renderer is rebuilt while healthy. The whole preload and
warm-up census runs **twice**, 4.5 s apart (1,969 ms then 1,241 ms), and
`navigation to first light` reads 10.2 s of which roughly 6.5 s is the
watchdog waiting and re-warming. Every automated boot measurement pays it,
and no player does (a visible window presents on the first sample). The fix
has to be chosen carefully: the ladder exists because real boots really do
wedge black, and a guard that also trusts `document.hasFocus()` or an
occlusion signal must not reintroduce the failure the watchdog was built
for. Until then, boot figures from the rig are figures about the rig.

### Disposing a body's materials during the watchdog's rebuild throws

Every renderer rebuild logs
`TypeError: Cannot read properties of undefined (reading 'usedTimes')` from
Three's `Nodes.delete`, reached from `material.dispose()` in `Bodies.tsx`'s
unmount cleanup — dev and shipped builds both. The suspicion: the old
renderer is disposed before React unmounts the scene, so the material's
render objects point into a nodes cache that no longer holds them, and
Three's dispose listener dereferences the missing entry. The throw aborts
the cleanup loop, so the remaining visuals' materials are never disposed at
all on exactly the path that is about to rebuild them. Needs a minimal
repro against Three (likely an upstream dispose-after-dispose bug) or a
deliberate app-side guard with the reason written down; today it is an
uncaught exception in a recovery path, which is worse than either.

---

## Caveats that shaped these numbers, kept so they keep shaping them

- **The occluded rig's frame periods are not the app's.** Shipped build in
  orbit: 18 of 240 periods over 25 ms while the main thread's longest task
  was 3.8 ms — the occluded compositor skips vsyncs the page never sees.
  Attribute late frames from the rig only to spans _inside_ them.
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

# the selection microbenchmark and its CPU profile
node --cpu-prof --cpu-prof-dir=.scratch/prof .scratch/selectBench.ts
```

What the spans do not cover — GC, React commits, compositor stalls — comes
from the raw trace: filter the main thread's `ph: 'X'` events and bucket by
name and by `FunctionCall` source, which is how every "outside anything
instrumented" line above was attributed.
