# Performance: what is left

What the timeline instrument ([ADR-0022](../../docs/adr/0022-the-timeline.md))
still has open — `ir.profile`, `--trace` into `pnpm timing`, the worker tracks,
and raw-trace attribution of whatever the spans do not cover. Every entry is a
measured finding or a named suspicion with the measurement that raised it.
Operating points are named on every figure, because a figure measured at one is
a figure about that point.

[ADR-0037](../../docs/adr/0037-the-enhanced-camera.md) makes Enhanced's visible
sky an ordinary gameplay requirement and owns the camera's acceptance contract.
Natural measurements below retain their named response; they do not establish
the cost of that default. The completed cache, GPU star projection and bounded
population are measured under [the galaxy](#the-galaxy); the complete-frame
operating points, the two journeys and the return's 52.8 fps recording are
under [the camera](#the-camera).
Keep the upscaler and optional optical effects separate.

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

One producer is measured and gone: a ship integrated in the Sun's frame made
5.5 KB of garbage a tick — poses and quaternions for twenty children's sphere
tests — and the collector was 14% of that headless profile; on rails the tick
allocates a state and nothing else, and the tests are skipped by a bound.

**Re-measured as GC at the converged Earth summit stance**, dev build, a 5 s
trace read for the main thread's top-level collector tasks (a `MajorGC` entry
nests a `V8.GC_MARK_COMPACTOR`, a `MinorGC` a scavenger; count each once):
**87 ms in 5,015 ms — 1.7% of wall, 6.8% of the thread's 1,268 ms of task
time** — of which 51 ms is incremental marking, 19 ms major pauses and 17 ms
scavenges. The thread is 25% busy at that stance. Marking dominating means a
major cycle is always in progress, which is the allocation rate keeping the
old generation moving rather than any one pause; the producers named in the
memory section above are where the rate comes from. That is the open half: the rate is down by
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

### The stack's gates allocate a context per sample, unmeasured

`evaluate` builds a `StageContext` — `{surface, sketch, sea, seabed}` — on every
call and asks `stageOn` four times, for `ice`, `drainage`, `craters` and
`coast`; each is a `Map` lookup in `stageOf` and a call through the stage's own
closure. `groundCoverAt` pays a second literal and a third `terrainSketch`
lookup for the clamp. That is the per-vertex path: thousands of samples a patch,
~1,000 patches to the deepened floor, and `elevationAt` runs the same function
per contact test per tick.

**Nothing here is measured, and it may well be noise.** A literal that does not
escape is scalar-replaced, and this one escapes only into `stageOn` and the
stage's own predicate — both small enough to inline, after which it does not
escape at all; the `Map` is eleven entries. It is written down because the shape
is new: the composition is what makes the CPU stack and the kernel one
description of `BAND_STACK` (`packages/universe/src/bandStack.ts`), which is the
thing that stopped them drifting, so the cost of keeping it is worth knowing
rather than assuming.

**If it is real, hoisting is available and cheap.** The context is constant over
a patch and the four gate answers are constant over a body, so they lift out of
the sample loop into the job. That changes the sample signature, not the table —
the one description survives it, which is the property that matters.

**Where it would show.** Item 4 of the order below — one worker's first patch
against its tenth on the same body — already walks this path with allocation
attribution on. The answer comes out of that trace rather than a new one.

### The star survey's priority lane is unbuilt, and unneeded

One reading of `Workers/queue universe.surveyRegion` on a return to Sol is
**4.0–8.0 s** — the two survey jobs behind a hundred queued heightfields, the
sky repopulating seconds after the jump completes. It does not reproduce.
`STARFIELD_HYSTERESIS` is 8 light years and no system in `ir.targets()`' sweep
is more than 6.5 away, so provoking it takes a multi-hop tour — and every hop
retargets the observatory, which retires the terrain backlog first. A priority
lane in the pool buys nothing until something else fires a survey behind a full
window.

### The atmosphere bake is on the pool, and the boot prebake is not

The arrival bake is closed by [ADR-0028](../../docs/adr/0028-client-tasks.md):
`render.bakeAtmosphere` runs on the pool, a shell whose tables are in flight
draws a vacuum for those frames, and a jump's hazes reach the main thread as
uploads only — measured on the rig as three `bake atmosphere` entries on the
page thread after a look into HIP 71683 before, and none after. What is still
synchronous is the boot prebake, nine bakes at 20–39 ms each behind the
overlay and counted by the census: 200–350 ms of a 4.3 s cold boot, which
could go through the same task with the census counting arrivals rather than
bakes. Worth doing only if the boot line below is ever worked, because it is a
tenth of it.

The prefetch's two branches do not pace alike, and only one of them was
reasoned about. `prefetchScattering` in
[`preload.ts`](../../apps/game/src/render/preload.ts) drains its no-pool queue
one bake per macrotask, deliberately; the pool branch submits every haze of
every newly-loaded system in one `for` loop into the same FIFO the terrain
streamer feeds. A jump into a many-body system therefore puts N × 20–39 ms of
bakes ahead of the heightfields the arrival frames are waiting on — the haze
is cosmetic for those frames and the terrain is not, which is the ordering
[ADR-0028](../../docs/adr/0028-client-tasks.md) argues for and this loop
inverts. Unmeasured: the reading that would settle it is `pool.stats()`
throughput and `ir.terrain().level` across a jump into a system with more than
a handful of atmospheres, against the same jump with the loop paced. The fix
is a queue on this branch too, or the priority lane the survey section above
finds no other use for.

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

### The default sky has a progressive cache; final boot timing is open

The original PR #65 quarter-resolution target and two warm-up units are
superseded. Production now refines 32² → 128² → 512² physical cubes in bounded
tiles and can restore a completed WebGPU cube from a separate two-entry disk
cache. Cache misses do not require a synchronous full 512² bake before any sky
can appear. The archive does not write the save database.

The measured corrected 512² drained bake is 3.829 s, with 36 MiB of resident
cube targets. **A drained full-bake time is not a boot time**, which is why that
figure cannot be quoted as one: the tiers are 6, 96 and 1,536 tiles of 32×32
pixels, two tiles a submitted frame, so a boot capture that completes all 1,638
of them and writes one archive spreads the final tier over about 12.8 s at
60 fps while earlier complete tiers stay on screen. Storage, readback and driver
differences move cold and reload latency independently of the bake. First
visible sky, progressive convergence, archive-hit reload and peak whole-app
memory still need their own boot record. The old 120 ms full-bake estimate is
not a performance claim.

## The galaxy

Unless dated separately, figures here are from the 5 September 2026 run, on an Apple M5, through
two rigs: a headless one that draws the production volume node on the real
GPU across a drained queue (`.scratch/galaxy-perf/`, a scratch vitest config
over `openGpu`), and the driver at 960×540, DPR 1, occluded, so a draw is a
240×135 target. Per-sample cost is flat across target sizes, so the headless
rig answers kernel questions at any size the machine can spare.

### Completion record, 7 September 2026

This record supersedes the open galaxy optimization list from 5 September.
The completion branch stays on the user-selected
[PR #72](https://github.com/jonjaques/inertialref/pull/72) base. Active versions
are `galaxy@5`, `galaxy-field@5` and `galaxy-tsl@8`. The implementation and
acceptance status are in
[ADR-0038](../../docs/adr/0038-the-stars-and-the-diffuse-sky.md).

The shared 2048² arm table replaces repeated analytic arm evaluation in both
sky and live volume. Observer motion projects stable stars on the GPU. Physical
cubes and temporal history own their validity; a separate disk cache keeps at
most two completed cubes. The actual resolved threshold and admitted level mask
partition the calibrated first luminosity moment. Conservation is exact for the
ensemble, with an explicit finite-realization residual.

The original **2 ms live volume at 1080p** target is deliberately revised.
The measured uncapped half-resolution, stride-8 inside view costs **6.366 ms**
at 1920×1080 and **12.693 ms** at 2880×1800. Production caps the target's long
edge at 960 while preserving half-resolution detail below that cap. This bounds
Retina target/history growth; it does not make all live views fit 2 ms.

| Physical volume, half resolution / stride 8 / cap 960 |  Face-on |  Edge-on |   Inside | Owned target/history bytes |
| ----------------------------------------------------- | -------: | -------: | -------: | -------------------------: |
| 1920×1080 drawing buffer                              | 2.225 ms | 4.501 ms | 6.296 ms |                 29,284,096 |
| 2880×1800 drawing buffer                              | 2.460 ms | 5.525 ms | 7.399 ms |                 30,673,216 |

Apple M5, WebGPU, 40 moving draws per view with 0.2 pc translation each,
V8/mask-511 envelope, GPU timestamp instrumentation. The physical targets are
960×540 and 960×600; the scene and star buffers are unchanged. These are
isolated volume costs, not complete frame periods. Verified cap commit:
`434009f`, `.scratch/galaxy-finish/capped-galaxy-summary.json`; uncapped
comparison: `final-quality-bench.log` in the same directory.

Cached sampling is **0.030–0.047 ms** at the measured 960×540 and 1440×900
sampling targets. The corrected 512² cube has maximum RGB error **0.629%**
across 72 arbitrary directions, with 0.086% at 12 texel centers. Its measured
3.829 s full bake and 36 MiB residency support the 512² tier; the 1024²
experiment costs 18.256 s and 144 MiB. Field@5 retains the 0.15 pc reuse radius
within the unchanged 1% radiance budget over 21 tested origins. Source records:
`cube-quality.log`, `cube-footprint-summary.json` and
`cache-radius-field5-summary.json`.

At **100,000 stars**, the measured median added GPU draw cost is **0.687 ms**
(20k: 0.343 ms; 200k: 1.254 ms). This is Apple M5, 1920×1080, 4× MSAA through
the sensor MRT, with downstream optics bypassed and retained transparent
extinction. It excludes active dust integration. `starShell-gpu-benchmark.jsonl`
and `star-benchmark-notes.md` record three paired empty/populated batches of 80
submissions, including first-batch outliers and concurrent CPU-test caveats.

Replacing 10% of a fixed 28,942-source fixture lowers CPU preparation median
**9.802 → 3.000 ms**, p95 **11.747 → 4.419 ms**. Broad reordering after the
change is 4.877 ms median and 8.261 ms p95. These are paired earlier-population
comparisons at capacity 100,000, excluding GPU execution and driver submission;
they do not promise every new selection fits five milliseconds. Source records:
`star-replacement-pair.json` and `star-replacement-pair-reordered.json`.

Field@5's production V8 request is bounded by **100,000 sprites, 1,000,000
candidates and 2,000 cells**. The actual default-seed operating points are:

| Observer                | Total stars | Candidates / cells | Level mask | Worker median | Host apply median | Observed peak heap |
| ----------------------- | ----------: | -----------------: | ---------: | ------------: | ----------------: | -----------------: |
| Sol                     |      29,257 |      213,380 / 544 |        511 |    119.722 ms |         10.443 ms |         139.69 MiB |
| 1 kpc toward the center |      37,423 |      322,669 / 512 |        511 |    172.355 ms |         17.415 ms |         180.87 MiB |
| Galactic center         |      16,004 |      287,681 / 576 |          3 |    132.045 ms |          7.892 ms |         158.60 MiB |

The totals split procedural against catalog as 19,243 + 10,014 at Sol,
36,634 + 789 a kiloparsec toward the center, and 16,001 + 3 at the center:
the catalog runs out long before the procedural population does, which is what
the level mask is bounding. All retain V8 without duplicate identities or budget
violations. The central
query admits levels 0–1 and leaves omitted levels fully diffuse. Node 26.5 runs
the production worker and host selection inline for three clean timing repeats;
a separate memory pass samples their combined heap. These are observed peaks,
not exact V8 maxima or isolated browser-worker memory. Worker payloads serialize
to 5.05–11.64 MiB. Generation runs off the main thread in production; it is
**not a sub-5 ms CPU query**. Host application is per survey, not per frame.
`field5-operating-summary.json` records counts, thresholds, masks and methods.

Resolved dust updates at most 1,024 sources per GPU cycle. The **WebGL fallback
updates one CPU source column per submission** and converges progressively;
the earlier Solar smoke capture still had 18,806 pending columns. That shader
and backend check does not establish equal convergence time to WebGPU. See
`webgl-smoke-summary.json`.

### The assembled journey, and where the return spends its frames

Two 2,400-frame compositor casts over the same 36-second presentation journey,
production build, Apple M5, Chrome 152, WebGPU, sRGB SDR, MSAA 4, native
1920×1080 at DPR 1. Both preserve canonical hash `98b5b2be`, camera mode and
lens.

| Cast    | Rate                  | rAF interval p95 / p99 / maximum |
| ------- | --------------------- | -------------------------------- |
| Outward | 59.7 fps over 40.21 s | 18.0 / 18.7 / 50.9 ms            |
| Return  | 52.8 fps over 45.49 s | 32.5 / 50.2 / 150 ms             |

**The return is the measurement that matters, and it does not hold 60 fps.**
113 of its 2,209 sampled intervals are over 25 ms and 26 are over 50 ms, and
most of the slow ones land while the observer comes back in from outside the
disk — the leg where a live volume, a fresh survey and an incomplete cube
arrive together. A held frame does not cancel that: the same returned orbit,
drained, is 2.765 ms.

| Held complete-sensor cost, 60 queued frames | Result   |
| ------------------------------------------- | -------- |
| Enhanced Earth-band                         | 4.257 ms |
| Automatic Earth                             | 4.562 ms |
| Manual Earth-band, 2,400 s                  | 5.043 ms |
| Journey exterior                            | 2.868 ms |
| Returned orbit                              | 2.765 ms |
| Edge-on instrument                          | 2.513 ms |

Compositor rates, paced frame intervals and drained GPU submissions measure
three different things; only the first is about a player. At a 1440×900 CSS
viewport at DPR 2 the native scene is 2880×1800, the physical history holds its
960×600 cap, and 60 held complete-sensor frames average 6.410 ms. Extended
display-P3 and the resize both restore one finished archive, with no write and
no failure.

**A larger cube would not recover the missing dust structure, and that is
measured rather than assumed.** At the reviewed Earth-band pose, removing cube
filtering changes physical RGB by at most 0.38% across two 81-ray patches, and
broad RMS contrast stays about 13.1% at 512 faces, at 1024, and unfiltered.
Enhanced compresses that to about 10.0%. The smooth disks and Gaussian local
clouds dominate the broad brown lobes, so the structure a reference photograph
has is absent from the source rather than from the sampling. The night
Automatic plate is the same shape of finding at the other end: its meter
settles inside the comfort bounds at EV 8.388 and amplifies the hemisphere,
because the colorized Black Marble map emits its blue land/ocean background
together with the city lights. Forcing more gain amplifies the source error.

The assembled gate at that source passes 2,010 regular tests in 153 files and
eight slow tests; the physical GPU suite passes 107 tests in 36 files.

### Historical Natural Earth-orbit measurement

These are Natural baseline measurements. Its omission predicate is superseded
as default-camera direction by ADR-0037. Retain the physical-GPU comparison as
evidence for the tested response, not as permission to omit Enhanced's sky.

6 September 2026, production build, Apple M5, occluded 1920×1080 at DPR 1:
Earth-orbit rotation averages 62.47 ms per frame, free look 55.69 ms, and a
stationary view 16.67 ms. The simulation averages 0.29 ms during the orbit
rotation and terrain visits zero nodes. The galaxy draws on all 35 moving
frames in the 2.2-second window. Repeating the movement with the volume
disabled restores 16.67 ms per frame. At 960×540 the same rotation averages
18.37 ms, so the smaller rig hides most of the defect.

Natural's default daylight calibration does not display the diffuse sky.
`GameEngine.galaxyPose` omits that work when the current lens and range resolve
to daylight or darker. It preserves brighter Natural settings, metered
responses, Direct and staged galaxy instruments. The eligibility test reads
the current settings rather than the previous frame's exposure, so a setting
change reveals the volume immediately. Physical-GPU comparisons retain a lit
foreground, fixed noise and the sensor PSF; the tested daylight differences
remain below one display code with and without dust, while the long-exposure
control differs visibly. This does not reduce the cost of a visible integral.

The rebuilt production view averages 16.67 ms during both orbit and free-look
movement at 1920×1080, with no volume submissions. At a 1440×900 CSS viewport,
DPR 2, the confirmed 2880×1800 buffer also holds 16.67 ms for both movements.
Orbit's simulation-to-wall-time ratio is 0.9955 and free look's is 1.0016 over
the 2.2-second windows, within one 64 Hz tick of real time. No movement frame
exceeds 17.8 ms in those Retina windows.

The reproducible profiles are in `.scratch/orbit-perf/`.

### A draw was the whole integral, every frame, and at rest it was the saturation

Before the hold, at a 480×270 target: 113 ms a draw face-on, 246 edge-on,
165 and 237 at two interior points — 5 ns a sample over 21 to 47 million
samples a frame, redrawn on every scene submission whether or not the view
had moved. A stationary edge-on view was a GPU at four frames a second on a
picture that was not changing, which is the OS stall the M5 handoff records.

Closed. The node draws when the view, field or size changes and once more to
settle, then holds the target (`galaxyVolume.ts`). In the browser the held
backdrop adds 0.17 ms to a 4.7 ms frame; the last third of the journey, where
the observer crosses 0.01 pc a frame, is one draw a frame with the period at
vsync (mean 16.7 ms, 2 of 120 frames over 25 ms, at 240×135).

### The dust noise was 87% of a draw, and a texel from outside resolves none of it

Attribution on the real GPU at 240×135 edge-on, parts of the integrand
switched off: 58.5 ms whole, 7.4 ms without the four dust-noise bands, 33.8 ms
without the arms, 2.4 ms with neither. The transport loop itself is 4%. From
40 kpc a texel spans 140 pc, so the 64, 16, 4 and 1 pc bands are all
sub-texel there; inside the disk the 1 pc band is sub-texel past 90 pc and the
64 pc one past 5.5 kpc.

Closed. The ray carries the pixel's angle and each band is weighted by what
the footprint resolves, the rest replaced by its lattice mean
([ADR-0032](../../docs/adr/0032-the-stellar-field.md#dust-transport-m5)).
Through the production kernel at 240×135: edge-on 53 → 10.8 ms moving and
64 → 9.6 ms settled; interior toward the center 51 → 15.9 and 80 → 17.2.

### An eighth-size travel target is not a lever, and it was measured before it was built

At 120×68 the filtered edge-on moving draw is 16.4 ms against 10.8 ms at
240×135, four times the rays. A small draw is bound by the latency of its
longest rays — the in-plane edge-on ones run to 1,500 intervals at the
crossing law's 40 pc — not by throughput, so shrinking the target during
travel buys nothing at the view where travel is expensive. Declined.

### Status of the earlier optimization list

The arm table, bounded progressive sky work and temporal reuse are implemented;
the completion record above replaces their former unbuilt status and old
43–63 ms projected live cost. The original universal 2 ms target is revised
explicitly there. Early transmittance termination and a separate 3D slab are
not needed to explain the measured implementation.

The meter's treatment of orbit traces remains a separate sensor question.
Traces present at one brightness at every exposure, but a histogram that samples
scene pixels can still include them. No galaxy plate has established a need for
a meter mask.

## The camera

Enhanced draws the sky in ordinary gameplay, so a camera figure is a whole-frame
figure and not an isolated pass. The batch below is the production build on an
Apple M5, Chrome 152, WebGPU, Standard sRGB and Enhanced. Orbit, free look and
ground are six-second rAF probes without screencasting; descent records twelve
seconds around an eight-second flight. Each probe holds its canonical hash, mode
and lens, and cold orbit starts with an empty regenerable archive after first
light, so it excludes browser launch and shader boot. A held cost is 60 complete
sensor frames across a drained queue, submission included; free look restores
its aim first, and the ground row owns descent's held cost.

| Drawing buffer | Point      | rAF mean / p95 / maximum | Above 25 ms / intervals | Held complete-sensor cost |
| -------------- | ---------- | ------------------------ | ----------------------- | ------------------------- |
| 1920×1080      | Cold orbit | 16.67 / 17.60 / 17.70 ms | 0 / 360                 | —                         |
| 1920×1080      | Warm orbit | 16.67 / 17.60 / 17.70 ms | 0 / 360                 | 4.28 ms                   |
| 1920×1080      | Free look  | 16.67 / 17.60 / 17.80 ms | 0 / 360                 | 4.20 ms                   |
| 1920×1080      | Descent    | 16.67 / 17.30 / 17.70 ms | 0 / 720                 | —                         |
| 1920×1080      | Ground     | 16.67 / 17.40 / 17.60 ms | 0 / 360                 | 12.39 ms                  |
| 2880×1800      | Cold orbit | 16.71 / 17.50 / 33.30 ms | 1 / 359                 | —                         |
| 2880×1800      | Warm orbit | 16.67 / 17.40 / 17.70 ms | 0 / 360                 | 7.66 ms                   |
| 2880×1800      | Free look  | 16.67 / 17.30 / 17.70 ms | 0 / 360                 | 7.09 ms                   |
| 2880×1800      | Descent    | 23.90 / 34.40 / 50.70 ms | 192 / 502               | —                         |
| 2880×1800      | Ground     | 29.26 / 33.90 / 34.40 ms | 155 / 205               | 26.20 ms                  |

The Retina viewport is 1440×900 CSS at DPR 2. **Dense ground at that native
point runs around 30–34 fps, and the Retina descent misses vsync on 192 of its
502 intervals** — the two rows where the scene is terrain rather than sky, at
four times the pixels. Nothing in this table claims sustained 60 fps; it accepts
the bounded visible-sky and twelve-tap optical policy and names where that lands.
The 37.13 ms Retina ground batch, the 21.52 ms aperture probe and this 26.20 ms
one have different scene and session details, so their differences do not
isolate the 1.338 ms optical saving.

The two journeys travel for 36 seconds and then hold the endpoint. The 1080p
batch includes the 2,400-frame compositor recordings, with independent rAF
samples covering the first 40 seconds; the Retina batch records the same path
without screencasting. Later cloud, touchdown-heading and small-defocus
corrections do not change the orbital infinity-focus route.

| Drawing buffer | Journey | rAF p95 / maximum | Above 25 ms / intervals | Held complete-sensor cost |
| -------------- | ------- | ----------------- | ----------------------- | ------------------------- |
| 1920×1080      | Outward | 18.70 / 52.00 ms  | 12 / 2,382              | 1.60 ms                   |
| 1920×1080      | Return  | 18.50 / 66.70 ms  | 12 / 2,375              | 2.54 ms                   |
| 2880×1800      | Outward | 17.70 / 66.80 ms  | 20 / 2,372              | 4.51 ms                   |
| 2880×1800      | Return  | 17.60 / 50.10 ms  | 30 / 2,365              | 5.33 ms                   |

### What a ground frame is made of, and what the queue actually sees

The final ground records select 7,184,384 / 7,733,248 terrain triangles in
877 / 944 patches at 1080p / Retina, with 380 / 388 scene calls before the
sensor passes. Declared galaxy targets occupy 42,702,592 / 44,091,712 bytes;
star projection and extinction declare 9,600,004 and 13,204,096 bytes at both
points. Sampled V8 heap maxima are 612.32 / 592.65 MiB. Those are the named
allocations and sampled heaps, not total GPU residency — the 512² cubes and the
960-pixel physical history cap are both in force with Enhanced's sky visible.

A held ground frame issues **eighteen renderer calls at either size**: one scene
render, four defocus draws, twelve PSF draws and the final output, with both
gathers reporting twelve samples. The intercepted WebGPU queue sees 22
submissions and command buffers at 1080p and 18 at Retina, and the extra buffers
have no attributed producer. Timing probes exclude that instrumentation, so it
is a structural audit and not a cost.

### Small defocus pays for four pixels of blur, not forty-eight

Circles up to four pixels in the drawing buffer take twelve samples of the
flight iris per near/far layer; larger circles retain 48, and the half-pixel
bypass still submits no defocus work at all. Both variants warm against the same
four textures, so the choice adds no pipeline. Six alternating batches of 60
drained, isolated defocus frames measure median costs of **0.931 → 0.376 ms at
1920×1080 and 2.259 → 0.921 ms at 2880×1800**. At the four-pixel boundary a
striped near/far fixture differs from the 48-sample kernel by at most 0.01172 in
a linear channel, mean absolute difference 0.00514, relative energy change
0.00893%. This is the optical pass alone; it is not the complete scene and it is
not a presented frame rate.

### The matched return, and what a lower CPU span does not buy

The 36-second return plus held tail runs Enhanced at 18.836226925409882 mm,
f/2.8, 1/60 s and ISO 100. Both runs preserve their canonical hash, mode and
lens, but their initial canonical hashes differ, so the comparison matches lens
and route rather than an identical world state.

| Measurement                                  | PR #73 baseline           | Camera `bface6f`         |
| -------------------------------------------- | ------------------------- | ------------------------ |
| Survey preparation, mean / p95 / maximum     | 0.532 / 2.799 / 7.900 ms  | 0.022 / 0.101 / 0.600 ms |
| Starfield callback, mean / p95 / maximum     | 0.285 / 1.100 / 12.201 ms | 0.197 / 0.399 / 9.799 ms |
| Host reply application, mean / p95 / maximum | 1.381 / 6.200 / 9.000 ms  | 1.512 / 6.301 / 9.201 ms |
| Engine frame intervals above 25 ms           | 12 of 2,400               | 7 of 2,399               |
| Engine frame interval p95 / maximum          | 18.399 / 42.701 ms        | 18.600 / 62.101 ms       |
| Independent rAF interval p95 / maximum       | 18.2 / 34.7 ms            | 18.6 / 51.8 ms           |
| Independent rAF intervals above 25 ms        | 1 of 2,398                | 1 of 2,397               |

**Cheaper synchronous work is not a better worst frame, and this pair is the
proof.** Survey preparation falls by an order and the count of late engine
intervals falls with it, while the maximum grows from 42.7 to 62.1 ms. The two
columns of intervals also have different boundaries — the engine callback's and
an independent rAF's — and neither is a compositor recording or a drained GPU
cost. Sampled extinction source writes fall from 162,122 to 63,046 as completed
envelopes reach their consumers, while mapping writes and temporal resets rise,
so less preparation does not mean every cache does less work. The sky worker's
unchanged source values occupy about 38% fewer serialized bytes by omitting
system properties the renderer never reads.

## Memory and the resident world

### The tour ends at 906 MB of JS heap, and the steady state does not leak

`performance.memory` after the full tour — three systems, two landings, a stance
on a generated world: **628 MB** at the Proxima summit, **906 MB** at the end.
Two narrower readings: **488 MB** at a converged Earth summit with one system
loaded, **770 MB** after a Mars landing plus a jump, with two.

**Measured as live objects, it is flat.** Three operating points watched over
CDP for two to four minutes with `HeapProfiler.collectGarbage` forced before
every reading:

| Operating point                                               | Live heap                  | Window |
| ------------------------------------------------------------- | -------------------------- | ------ |
| Flight start                                                  | 129.5 MB, flat within ±0.5 | 150 s  |
| Earth summit stance, converged (1,134 fields, 403 geometries) | 524 MB, flat within ±2     | 240 s  |
| Planetarium at Earth, 100,000×                                | 552–556 MB                 | 32 s¹  |

¹ cut short by a source edit reloading the page; re-run before quoting.

The sampling profile of what is _retained_ across each window totals under 6
MB and names the travel survey's rows (`travelTargets`, 1.3 MB, replaced every
second), the catalog rows, and the cutscene overlay's animation-frame closure.
Nothing grows. **The unforced reading does not ramp either**: `usedJSHeapSize`
read every two seconds at the same stance with no collection forced sits
between **534 and 582 MB for 200 s**, a scavenge-sized sawtooth around the live
set and no trend. So the tour's 906 MB is not steady-state growth — it is what
the _transitions_ leave behind, three systems and three surveys and two
landings' worth, and whether that is garbage a major collection has not yet
taken or state something still holds is the measurement that has not been
made: a heap snapshot on either side of one jump, diffed by constructor.

The producers of that garbage at a stance, from the retained sites: the 8 Hz
status sample — `inspectWorld` mapped every entity through `inspectEntity`,
and `inspectEntity` built a whole world snapshot, 129 bodies with their poses,
to read one entity, twice a sample — the 1 Hz travel survey, and the frame's
own snapshot. The first is the cheap one to cut.

Prime suspects for the _working set_ are unchanged: the geometry cache (450 MB
at its documented full ceiling) plus the field cache (138 MB full), retained
across operating-point changes on the same body by design, plus each resident
world. `#evict` trims only above caps and `clear()` only fires on a body
change, so a session that ends its last landing holds that landing's full
working set indefinitely — which is a policy, not a leak. **A heap breakdown
of the 524 MB stance comes before anyone tunes a cap**, and it gates the entry
below. The budgets table in
[`docs/design/technical.md`](../../docs/design/technical.md) still records
**66–74 MB**, measured before streamed terrain existed. That row is stale
either way.

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

### Warp is delivered to 10⁷×, and the frame at warp is the snapshot and the starfield

Closed by [ADR-0025](../../docs/adr/0025-the-rails.md): a coasting ship is
propagated from an epoch and a frame jumps the ticks nothing integrates, so
the 1,920× ceiling is now the ceiling on _integration_ only. Measured after,
occluded rig, 1600×900:

| Operating point                     | Requested | Achieved | Ticks / frame | Engine mean / p95 | Period |
| ----------------------------------- | --------- | -------- | ------------- | ----------------- | ------ |
| Flight start, one system            | 100,000×  | 100,000× | 106,240       | 0.50 / 0.60 ms    | 16.67  |
| Planetarium at Earth from 14,400 km | 100,000×  | 100,000× | 79,998        | 0.37 / 0.50 ms    | 16.67  |
| the same                            | 10⁶×      | 10⁶×     | 826,693       | 0.36 / 0.50 ms    | 16.67  |
| the same                            | 10⁷×      | 10⁷×     | 8,264,027     | 0.37 / 0.50 ms    | 16.66  |

`Engine/advance` is 0.03–0.05 ms at every one of them: a 100,000× frame over a
ship in low Earth orbit is one jump, because the sphere-of-influence bound
binds on Luna at about ten hours of simulated time. Headlessly a coasting tick
is 0.01–0.03 µs at every operating point, against 0.4–12.5 µs integrated.

**Per tick, integrated, before** — the figures that made the case, 20,000
ticks a point on a quiet M5: 0.40 µs at the spawn point, 1.06 µs at 36,000 km
over Earth, **12.5 µs at 400 km** (two terrain samples a tick, gated at a
quarter of the body's radius), 13.3 µs at 100 km over Luna, **12.5 µs at 1 AU
in the Sun's frame** (twenty of the sixty-six children pass the band prune
and each is a Kepler solve), 0.30 µs landed. The terrain gate is now the
ground band and the post-step sample is reused; the children's tests are
skipped by a triangle-inequality bound on both the coasting and the thrusting
path.

**Per tick, thrusting** — the figure the game pays at 1×, main drive lit,
60,000 ticks, `origin/main` in a worktree against the branch, the two
**interleaved** so any load lands on both:

| Operating point, drive lit | `origin/main` | with the change |
| -------------------------- | ------------- | --------------- |
| 400 km over Earth          | 12.3–12.6 µs  | 0.43–0.51 µs    |
| 1 AU in the Sun's frame    | 11.8–13.3 µs  | 0.56–0.60 µs    |

The first is the crater ladder — `levelContribution` alone is 24% of a profile
of it, sampled twice a tick for a ship 400 to 2,900 km up — and the second is
the children's Kepler solves. On the branch `considerFrameChange` is 5% of the
star-frame profile and the collector 4%.

**Interleaved, and that is not fastidiousness.** The first attempt ran
`origin/main` twice and then the branch twice, immediately after installing
into a fresh worktree, and read 39–49 µs against 1.5–2.6 µs — both sides
inflated three-fold by a cold module cache, in a ratio that happened to look
plausible. Alternating the two costs nothing and is the only form of this
measurement worth quoting.

**What the engine's 0.4 ms contained in this run.** `Engine/snapshot` costs
0.28–0.39 ms for 129 bodies' orbit and spin poses, with no other engine span over
0.05 ms. The loaded-system scaling entry above concerns that work. At the time,
`Render/starfield` costs 0.62–0.79 ms under warp because the Sun binds the shell
parallax budget and twenty thousand sprite positions are rewritten per frame.

That starfield finding is closed by M8's GPU projection. Observer translation
updates uniforms instead of projecting the source array on the CPU. The current
selection/replacement costs and GPU scaling appear in the galaxy completion
record above; the old span is a comparison baseline, not unfinished work.

**The rig's late frames are not the engine's.** 3 of 240 frames over 25 ms in
the 10⁷× profile, the largest span inside them the starfield at 0.9 ms. Same
caveat as below.

---

## The Mars landing and the surface structures

Measured 11 September 2026 on `codex/roci-lands-on-mars` rebased onto
`main`, dev React, the driver's Chrome, a quiet machine. Two operating points
for the scene: the entry at 8 s (ground telephoto, sky dome only) and the
hover at 35 s (terrain at level 16, the pad, the dust, the dome). The orbit
figure is the Rocinante at 400 km over Mars in the flight arm.

| Operating point            | 1600×900 at DPR 1 | 3200×1800 at DPR 2 |
| -------------------------- | ----------------- | ------------------ |
| Mars orbit, flight         | 4.0 ms GPU        | not measured       |
| Landing at 8 s, entry      | not measured      | 12.6 ms GPU        |
| Landing at 35 s, the hover | 7.95 ms GPU       | 21.9 ms GPU        |

`ir.gpu(120)` for the GPU column. The frame at 35 s is vsync at DPR 1 (mean
16.6 ms, none over 25) and 27 ms mean, 40 ms p95 at DPR 2 — the scene misses
60 Hz on a retina window during the ground phase, and the 2.8× between the
two columns for 4× the pixels says it is fill. The CPU side is 3.3 ms of
engine a frame, 1.9 of it `terrain.select`, which walks every frame because
the scripted camera never converges. No strobe: a 240-frame cast at 60.3 fps
over the approach reported no isolated frames.

At DPR 2 the hover's selection is over the patch cap — 1,583 wanted against
1,280 — and the cap is met by loosening the cell tolerance to 1.5×
(`terrainSelect.ts` § `COARSEN_STEP`), which draws 1,011 patches with level
16 underfoot rather than the cut tree's 1,184 at level 13. In Node the walk
is 1.51 ms warm at that eye and 1.98 ms on the frame that climbs a step; the
streamer hands the settled multiple back, so the step is paid once per
crossing rather than per frame. The fill figure above is unchanged by it.

### What a placement costs the tick and the frame

The integrator's contact test is gated on the datum: above the ground band
and the body's tallest deck a tick touches neither the spin pose, the terrain
nor the body's placements, and inside the band one direction and one terrain
sample serve the ground and the deck alike. `contactHeight` is a number
cached on the world per body, and the placements are indexed per body; both
are rebuilt when a placement changes, never at the call. A ray that misses a
deck is rejected on the body's radius before the terrain under the pad is
sampled, so a ship hovering over Mars pays one noise call a tick for the
ground and none for a pad it is not above. The regression in
`structureContact.test.ts` counts the asks: an orbiter at 400 km with the
drive lit makes none over 640 ticks, a probe 60 m over the pad makes one a
tick.

The snapshot resolves each body's rotating pose once, for the placements it
carries and for its own visible orientation, and formats its address once.
`Engine/snapshot` is 0.24–0.32 ms a frame with Sol loaded; the pose it
resolves once is a Kepler solve up the chain per body, unmeasured on its own.

A glTF that fails to load stays failed until the page reloads, in the loader
and in the structure pass, because the pass asks for every instance it lacks
on every frame. The pass allocates nothing per frame: one reused set of
active ids, and the Cinema stage goes through the same placement path as a
world structure rather than being spread into a fresh list. Boot warms the
assets of the structures placed in loaded systems, so the cover's cost grows
with what is built near the player and not with the catalog; a structure
elsewhere compiles on first sight.

Still open, and unmeasured: `buildScene` samples the drawn terrain radius
under every visible structure every frame, and `cinematicStage.ts` allocates
through `Vec` and `Q` for the Sun direction each frame, cinema only. The
`pnpm sim` tick benchmark at 400 km with zero, one and twenty placements is
the experiment that would put a figure on the gate; it has not been run.

## The order it is worth taking

1. **Shipped-build mode switches and docs pages.** Every figure is dev React at
   about five times the real cost. Measure before acting.
2. **The return leg, and the Retina ground and descent rows.** They are the
   three operating points that miss vsync, and they are the ones a player is
   moving through. The journey's 2,400-frame casts already localize the return's
   spikes to the crossing back in from outside the disk; what is missing is the
   attribution inside those frames.
3. **Per-job heightfield time**, which is what fallback convergence is made of.
   One worker's first patch against its tenth on the same body separates the
   cold per-body caches from the grammar and the scheduler.
4. **A heap breakdown of the 524 MB stance**, which gates both the cap tuning
   and system eviction. The steady state is flat; what is left is what the
   working set is made of.
5. **The transitions' retention.** One jump, one heap snapshot either side,
   diffed by constructor: that is where the tour's 906 MB lives, and neither
   the stance nor the collector explains it.

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
- **`engine.gl` existing is not the frame being ready.** The warm-up cover can
  still read "198/199" on a page whose renderer the driver already accepts, and
  the driver waits only a bounded time for that cover to clear — so a completed
  invocation is not evidence that the intended frame was drawn. Inspect the
  image, `ready`, the versions and the buffer sizes inside the same attached
  run before quoting anything from it.
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

Two more throwaways, recorded because their mechanics cost a round trip each.
A **tick benchmark** opens a session through `openSession` with the headless
catalog and an inline pool, puts the ship at an operating point with the
harness's own verbs — `orbit(address, km)`, `land`, `goToSystem` — and times
`harness.step(20_000)`; run it under `--cpu-prof` and bucket the profile's
samples by `callFrame` for self time. Its figures are about the tick only on a
quiet machine: the integrated tick read 1.5–2.0 µs beside a `pnpm test` run and
0.55 quiet. A **heap watch** attaches to the driver's Chrome on port 9333
through `/json/list`, enables `HeapProfiler`, calls `collectGarbage` before
every `performance.memory` read so the trend is live objects, and brackets the
window with `startSampling`/`stopSampling` — the profile's `selfSize` per node
is what is _retained_ at the end, aggregated by `callFrame`. Editing a served
source file mid-watch reloads the page and ends the measurement; the dev
server's HMR is the reason the planetarium's warp reading above is 32 s long.
