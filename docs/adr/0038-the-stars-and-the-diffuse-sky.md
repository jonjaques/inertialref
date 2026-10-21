# ADR-0038: Resolved stars and diffuse sky share one population and dust field

Status: accepted · 7 Sep 2026

Supersedes the population-preview restriction and initial cache configuration
in [ADR-0032](0032-the-stellar-field.md). Its source conventions, linear
photometry and historical M1–M6 measurements remain recorded there.
[ADR-0037](0037-the-enhanced-camera.md) continues to own camera processing.

## Context

A fixed local survey does not cover the stars visible from a distant observer.
Increasing its radius generates too many faint systems, and increasing its
sprite ceiling makes every camera translation rewrite more positions. Drawing
those sources over the integrated stellar field also counts their light twice.

Dust must end at each star. A background sky column would obscure foreground
stars, while applying an observer-to-star column directly to a catalog's
observed magnitude would count the Solar observer's extinction a second time.
Sixteen integration samples miss thin and nearby clouds. Starting a new cache
cycle on every observer movement prevents any distant column from completing.

The physical sky needs more than a settled-image hold. Free look can reuse an
angular field, translation can invalidate it, and long rays still cost several
milliseconds. A finished cube is expensive enough to keep across a reload, but
it is regenerable data and does not belong in a save. Fine temporal detail must
survive after the eye stops; clamping a stationary history to a coarse current
ray erases the detail that preceding phases already measured.

## Decision

**Generate resolved sources from disjoint luminosity bands of the calibrated
field, subtract their expected emission from the diffuse field, and transport
both through the same dust.**

Nine logarithmic Johnson V luminosity bands own independent `(level, cell)`
seeds. Their number weights reproduce each population's calibrated mean V
luminosity. Cell widths double from 20 light-years; luminosity bounds grow by
four, so a magnitude query can bound the cells relevant to each level. Travel
queries remain independent of the sky draw. New `Q` system addresses identify
these levels; old `P` addresses retain their legacy generation path.

The shipped sky query requests unextinguished V ≤ 8, at most 100,000 sprites,
one million candidates and 2,000 cells. Budget pressure lowers the requested
magnitude or omits whole levels; it cannot pretend an unfinished level is
complete. The returned selection origin, actual magnitude threshold and level
mask define the diffuse subtraction. Luminosity moments remove the expected
emission of exactly those bands. Omitted levels remain diffuse. This conserves
ensemble light; individual stochastic realizations retain finite sampling
noise and do not guarantee identical radiance in every pixel.

Catalog completeness is a magnitude-and-distance envelope, independent of
search UI. Known faint neighbors remain protected inside 25 light-years;
Hipparcos supplies a conservative V 7.3 envelope inside 150 light-years and the
shipped distant sky supplies V 6.5 beyond it. Sparse catalog counts outside
the complete envelope reduce the corresponding procedural cell and band.
Catalog records retain their measured identities and flux convention.

A pending survey retains the completed source field and its exact diffuse
selection envelope, including a completed empty exterior field. The next reply
replaces both atomically. Only a new world publishes the initial catalog
fallback. Catalog candidates and completeness coverage are derived once per
world. The version 2 sky-task response carries only source identity, name,
position, color and the two luminosities the renderer consumes. Other system
queries retain their full records.

A source upload carries integer sectors, integer 1,024 m subcells and bounded
float remainders. Observer uniforms produce directions in the vertex stage;
ordinary translation uploads no source positions. Stable IDs preserve previous
coordinates through reorder and rebasing. Per-source motion flags distinguish
a moving source from a new source. Retained names and appearance update only
where the selection changes. Enhanced's visibility response uses transported
absolute V, so a different brightest star cannot brighten every other sprite.

The resolved-star dust cache integrates only to the source. It uses 32 samples
through 64 pc, 64 through 512 pc and 512 for longer paths, concentrating work
around the shared warped dust plane. A catalog source uses
`T(observer, source) / T(Sol, source)`; a procedural source uses the full current
transmission. At Sol the catalog correction is exactly unity. Optical-depth
storage preserves strongly obscured channels, with an explicit finite gain
ceiling for catalog corrections.

A frozen observer starts each finite update cycle. Its queue completes before
another cycle starts, including during continuous travel. Unchanged sources
retain their last physical column until its replacement arrives; new sources
begin hidden. Six submissions interpolate old and new optical depths. WebGPU
updates at most 1,024 sources per submission; the WebGL CPU fallback updates
one. The latter converges slowly during large moves and reports that lag.
Source IDs, field versions and queue epochs prevent stale work from attaching
to a reused buffer slot. One renderer shares one 2,048² RG16F arm table between
resolved transport and diffuse light; reference-counted leases own its lifetime.

### The optically young population

The active revisions are `galaxy@5` and `galaxy-field@5`. The GPU port is
`galaxy-tsl@9`. The signed bar coordinates use multiplication for fourth
powers, because native shader `pow` has no defined result for a negative base.
The kernel revision invalidates physical cubes computed under that undefined
operation. This field corrects the earlier use of a 19 pc height for all
young stellar light. [Reid et al. 2019](https://arxiv.org/abs/1910.03357)
measures that height for very young high-mass maser tracers within 7 kpc.
[Natale et al. 2022](https://doi.org/10.1093/mnras/stab2771) models geometric
young stellar components with a broader, flaring sech² distribution.

The shared height is `H(R) = 50 + 17 (R / 4500)^p` pc, where
`p = log(40/17) / log(8178/4500)`. It reaches 50 pc at the center, 67 pc at
4.5 kpc and 90 pc at the Sun. The vertical factor is
`(50 / H) sech²((y − warp) / H)`, preserving the column as height changes.
Applying that geometric profile to our arm ridges, and continuing its flare
beyond the Sun, are declared model assumptions. The radial exponential, arm
positions, dust, old populations and seeded texture remain unchanged.

The effective mean solar V luminosities are 0.204 for the thin disk, 0.35 for
the thick disk, 100 for young arms, 0.7725 for the bar/bulge and 0.1 for the
halo. Thin and bulge means are fitted against the same three Solar sky regions
and external V luminosity; these are population-model means, not measured
individual-star luminosity functions. The default-seed V residuals are
+0.0765, +0.1785, −0.2800 and +0.0325 mag respectively, within the original
0.3 mag limits. Local number density remains 0.1 star/pc³ and the reference
cylinder contains 116.064 billion stars. Catalog-plus-procedural counts in
10, 25 and 50 pc balls around Sol are 389, 6,788 and 53,532, against field
integrals of 418.924, 6,549.357 and 52,109.668 — −7.14%, +3.64% and +2.73%.
Those are counts of one finite realization against the smooth integral it is
drawn from, not a second calibration target. The finer quadrature retains its
original convergence test.

The young cohort contributes 15.31% of emergent ridge V at solar radius,
compared with 0.66% in the tracer-height model. This is a modest improvement
to the external arms. The model's large central V luminosity fraction remains
an approximation; a published stellar-mass bulge fraction is not a V-light
constraint. RGB temperatures are illustrative and do not establish a Johnson
B−V calibration. No display response enters the physical fit.

The saved manifest identifies generation drift. `Q` addresses encode a
level/cell/ordinal, so they can change under a different recorded generation
version; an ordinal that no longer exists fails explicitly. The unpublished
`galaxy@4` level population receives that existing drift policy. Old `P`
destinations continue to use their exact legacy generator.

### Physical cubes and temporal history

Ordinary nearby views refine complete 32², 128² and 512² cubemaps. The three
tiers hold 6, 96 and 1,536 tiles of 32×32 pixels; two are submitted per frame,
so a complete refinement submits 1,638 of them. The boot census ends after the
128² tier, while the 512² tier continues in the background. Each cube uses a conservative `2/N`
radian angular texel footprint; the projection reaches that width at face
centers. The archive fingerprint includes this filtering revision. Three
target slots retain two completed
locations and one replacement. Only six complete faces publish. Canceled work,
changed fields or source partitions, renderer retirement and late storage
reads cannot publish into a different generation.

Cube reuse is limited to 0.15 pc, measured against local cloud gradients. A
disk-restored source envelope can have a slightly different origin, so envelope
displacement and eye displacement spend one combined allowance. The restored
entry retains the remaining eye allowance for all later reuse. Magnitude or
level-mask changes reject the entry. A mode, lens, exposure or display-gamut
change does not change physical sky light.

The regenerable IndexedDB store retains at most two finished cubes in a
separate database. Records contain a versioned field fingerprint, kernel and
backend, quality, observer and source envelope, and all six physical RGBA16F
faces. Reads validate metadata, finite nonnegative radiance and complete faces.
Pixel validation yields every 16,384 texels; restoration checks its request
identity again after validation. Database version 2 separates small LRU metadata
from pixel payloads: eviction enumerates keys, and a hit touches metadata without
rewriting its cube. Upgrading retires the regenerable version 1 cache once.
Writes wait for transaction completion. Unsupported, blocked or failed storage
is a cache miss. GPU readback and upload preserve native cube-face orientation
and padded row strides; temporary transfer textures are disposed.

Outside the nearby disk, or beyond a valid cube, live rays fill half-resolution
physical history using an eight-by-eight interleaved pattern. At 1920×1080
this traces 120×68 primary rays per submission and retains 960×540 history.
Production caps the history's longest edge at 960 pixels, preserving aspect
ratio and at least the half-resolution divisor on smaller displays. A
2880×1800 drawing buffer therefore retains 960×600 and traces 120×75 rays.
Reference instruments can leave this cap unset. Warmup and resize use the
same sizing calculation.
RGB remains V-anchored nW m⁻² sr⁻¹ divided by 1,000; alpha carries
emission-weighted distance for reprojection. Foreground occlusion remains in
the full-resolution scene.

History rejects camera cuts, large parallax, disocclusion, changed fields or
source partitions, resize and renderer retirement. Moving history is bounded
by current neighboring radiance; stationary history retains already measured
fine samples. Exposure does not invalidate physical history. After the eye
settles and every phase completes, the target is held until something changes.

## Alternatives considered

**Generate a larger uniform local survey.** Faint stars dominate its work and
memory before its visible reach approaches the galaxy. The sky and travel
catalog answer different queries.

**Subtract the whole population inside a distance sphere.** Bright distant
sources and faint nearby sources cross that sphere differently. Luminosity
bands permit the same selection rule in source generation and diffuse transport.

**Normalize sprite appearance to the currently brightest source.** A replacement
selection changes the rest of the sky's brightness. Absolute transported V
provides a stable response and removes GPU maximum reductions.

**Use sixteen dust samples or restart them on movement.** The first misses
physical columns; the second starves a moving observer's queue. Distance-aware
quadrature and finite cycles bound the work without discarding foreground dust.

**Persist generated stars or put cubes in saves.** Both can be regenerated.
A small independent cache improves reload cost without changing canonical
state or making save compatibility depend on a GPU texture.

**Clamp every history sample.** The coarse current grid has not measured the
fine stationary feature it is clamping. Restricting that clamp to motion keeps
its ghost-rejection purpose without erasing converged angular detail.

## Consequences

The active population spends a generation version. Legacy procedural addresses
remain resolvable, while new selection and portable-picture manifests identify
the active algorithm. The source model and camera response remain independently
inspectable and tested.

The 100,000-source capacity reserves about 21.2 MB of GPU source, appearance and
dust data, in addition to the shared 16 MiB arm table. The dust cache allocates
10,004,096 bytes on WebGPU or 3,200,000 attribute bytes on the CPU fallback,
never both sets. These figures exclude the CPU slot lookup and scheduling maps. A 512² physical cube is
12 MiB. Half-resolution temporal resources add 9.33 MB over the measured
quarter-resolution alternative at 1080p. These are declared allocations,
excluding driver overhead and temporary JavaScript generation memory.

The live 2 ms target is not a universal bound.
[Measured operating points](#measured-operating-points) names the operating
points and the chosen quality budget. Typical retained source replacement fits
5 ms of main-thread preparation; cold entirely new populations and garbage
collection can exceed it. GPU source updates and diffuse cache refinement are
bounded separately from worker generation.

The field still uses illustrative RGB stellar colors and absorption-only dust.
Scattering, H II line emission, globular clusters and neighboring galaxies are
separate physical additions. Finite source realizations, angular interpolation,
and delayed moving-star dust refresh are observable approximation limits.

### Measured operating points

Measured 5–7 September 2026 on an Apple M5 through two rigs: a headless one
that draws the production volume node on the real GPU across a drained queue,
and the driver at 960×540, DPR 1, occluded. Active versions are `galaxy@5`,
`galaxy-field@5` and `galaxy-tsl@8`.

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
