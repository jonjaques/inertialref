# The galaxy: Earth to the whole Milky Way

Build a continuous journey from Earth orbit to 30 kpc above the galactic plane,
using one versioned model for the sky, resolved stars and the whole disk.
This plan owns physical light, dust, populations, cached-sky rendering and
travel. [The camera plan](the-camera.md) owns the image through which the player
sees that journey, following
[ADR-0037](../../docs/adr/0037-the-enhanced-camera.md).

The M1–M6 planning baseline is [PR #70](https://github.com/jonjaques/inertialref/pull/70),
`9911dd5`. The galaxy completion branch is
`codex/galaxy-the-sky-keeps-its-detail`, open as
[PR #73](https://github.com/jonjaques/inertialref/pull/73), explicitly stacked on
[PR #72](https://github.com/jonjaques/inertialref/pull/72),
`codex/the-camera-reveals-the-sky` at `2847688`. The user's selected base
supersedes the older session-branch sketch below for this PR. Physical
calibration remains independent of Enhanced image treatment.

M7–M11 are implemented and the assembled verification record follows below.
PR #73 records verified implementation `ee0e9e1` and evidence commit `78e00dc`.
The [camera completion record](the-camera.md#camera-completion-record) follows
PR #73 at `9e26512` and records the current night emission, camera continuity
and return-frame evidence. Its
[complete-frame operating points](the-camera.md#complete-frame-operating-points)
record the bounded optical choice and native Retina ground limit. The
camera's C1–C5 sequence is complete at `db34e2a`, including matched stills,
final descent review and measured full-frame costs. The
historical record below retains its original
source, images and measured limits. Source morphology remains approximate,
and lower survey CPU cost does not establish sustained 60 fps.
[ADR-0038](../../docs/adr/0038-the-stars-and-the-diffuse-sky.md) records active
`galaxy@5`, physical `galaxy-field@5`, the resolved/diffuse partition, dust,
cache and history contracts. Historical milestone rows retain their original
verification and do not assert that an earlier PR has merged.

## Implemented and measured

| Area                    | Current implementation                                                                                             | Open acceptance or limit                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Coordinates and catalog | Shared galactocentric coordinates, measured Sun position, stable catalog addresses and distant bright stars.       | Q addresses require the recorded generation manifest.                                                 |
| Field and transport     | `galaxy-field@5` / `galaxy-tsl@8`, shared dust, flared young population and calibrated V light.                    | Central morphology remains an approximation; photometry alone does not establish exterior appearance. |
| Star population         | `galaxy@5`, magnitude levels, GPU shell projection, bounded selection, ensemble light partition and resolved dust. | Dense regions may omit whole levels; WebGL completes one source extinction column per submission.     |
| Sensor                  | Enhanced, Automatic and Manual responses, with physical caches independent of presentation.                        | Sixteen matched C5 plates verified; appearance limits are recorded below.                             |
| Resource lifetime       | Progressive cubes, a separate two-entry disk cache, temporal history and stale-work retirement.                    | Outward/return recordings and assembled gate pass; return hitches remain measurable.                  |

Physical calibration and the displayed image have separate acceptance checks.
Enhanced must show bright worlds and faint galactic structure together; its
appearance is not an input to the field calibration.

## The galaxy integration PR

The following is the original milestone workflow. The current completion PR
uses the explicit PR #72 base recorded above; it does not rebase to `main` or
create the historical integration branch as part of this completion.

Use `codex/galaxy` as the cumulative integration branch and open its **Galaxy**
PR against `main` once it contains the first verified milestone. Each session
branches from the current integration tip and opens a focused PR back into
`codex/galaxy`. The integration PR collects the journey and its evidence.

```text
main
└── codex/galaxy                     Galaxy integration PR → main
    └── codex/galaxy-<milestone>     Session PR → codex/galaxy
```

1. Start `codex/galaxy` from `origin/main` after the reviewed lifetime branch
   merges. If implementation starts sooner, use that branch's explicitly pinned
   tip and mark it as a dependency in the integration PR. After its squash merge,
   transplant only the galaxy commits onto the new `origin/main` with
   `rebase --onto`; do not replay the reviewed branch's commits.
2. Merge each reviewed session PR into the integration branch before cutting
   the next session branch. If a dependent PR must start while review is open,
   base it on its predecessor and target that predecessor's branch. After the
   predecessor is squash-merged, transplant only the dependent commits onto
   `codex/galaxy`, retarget the PR, and rerun the affected checks.
3. Keep history linear. Rebase the integration branch onto `origin/main` before
   the final gate. A child PR's verification does not replace verification of
   the assembled integration tip.
4. Every PR names its milestone, exact base, observable result, commands and
   measurements, known limitations, and the next milestone. Record its URL and
   verified commit in the ledger below. Passing tests do not mark a PR merged.
5. Keep the integration PR's checklist current as milestones land. M11, including camera C5, is the
   release gate for merging it to `main`. Additional sensor effects and nearby
   galaxies are follow-up PRs and do not hold this integration open.

This document establishes the branch and PR workflow. It does not create a
remote branch or open a PR by itself. Use `ship` when executing each PR step,
with the integration branch explicitly selected as the session PR's base.

## How one session finishes

Choose the first incomplete milestone whose dependencies are merged. Read its
referenced rules and ADRs, establish the baseline with `pnpm check` before code
changes, and start with the focused behavior check. For a defect, prove the
regression fails with the defect present; use properties for the field math.

Commit each coherent step before lengthy verification. Run the milestone's
focused checks, the required repository gate, and a browser capture only where
presentation is the evidence. Browser work uses the `drive` skill and `node
scripts/drive.mjs`; a continuous transition needs `--cast`, not a still. Update
the implementation docs and version records when their claims change. End with
the session PR and an updated ledger.

A milestone is a session-sized target, not a promise about elapsed time. If a
measurement reveals more work, split at a tested module boundary into a named
sub-milestone and a dependent PR. Keep the parent milestone open. Do not widen a
tolerance or silently carry unfinished acceptance work into the next session. An
early rendering milestone may expose an explicitly incomplete model on the
integration branch; M11 decides whether the assembled picture is ready for main.

## Milestones

M1–M6 retain their recorded physical implementation evidence. The completion
record below covers the assembled M7–M11 implementation on the PR #72 base;
its final images repeat camera C5 with the active population.

| Milestone | Session result                                                     | Depends on                     | PR / verified commit / evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1        | The distant bright sky is cataloged and drawn.                     | Reviewed baseline              | [PR #62](https://github.com/jonjaques/inertialref/pull/62) → `codex/galaxy`, from `codex/galaxy-the-bright-sky`; verified commit `1da7335` (gate green locally, 110 files, 1,671 tests). 7,515 systems at V ≤ 6.5 beyond 150 ly, 188 KB brotli; Orion's seven held to published directions within 0.02° and [drawn from 64,000 km above Earth](https://agentic-media-dumpster.jonjaques.com/2026/09/3u9ffd27xa/orion-3-marked.jpg); every cell inside 150 ly unchanged. Measurements in `CONTEXT.md`, 5 Sep 2026.                                                                                                                                                                                                                                                                                                                             |
| M2        | The stellar field has a measurable shape from outside.             | M1                             | Open in [PR #63](https://github.com/jonjaques/inertialref/pull/63) on `codex/galaxy-the-stellar-field`, based on PR #62 at `76cef98`. `galaxy-field@2`; 0.1 star/pc³ at the Sun; 116.185 billion stars in the reference cylinder; six tangencies within 3°. CPU plates and report through `pnpm sim --galaxy-plates .scratch/galaxy-m2/plates-v2 --galaxy-width 384`. Initial v1 gate at `3936e35` passed; PR review adds runtime input guards, width-derived plate heights, and continuous width projection at arm kinks. The full count runs in the slow suite. `VITEST_MAX_WORKERS=2 pnpm check` passes at `33f50fb`: 1,717 regular tests, five slow tests, docs and production builds. Headless self-test passes 12/12. Targets PR #62’s branch.                                                                                          |
| M3        | The planetarium renders the whole stellar disk.                    | M2                             | Open [PR #65](https://github.com/jonjaques/inertialref/pull/65) on `codex/galaxy-the-disk-is-visible`, targeting PR #63’s branch at `bdbfd93`; verified implementation `dfe75a2`. Fixed face-on/edge-on instruments, `galaxy-tsl@1`, full scene-depth composition and an owned rgba16f quarter-size target. CPU/GPU fields and 33 rays stay within 1%; all 69 GPU tests pass. At 1920×1080 on Apple M5: 0.989 MiB target, 10.58–10.61 ms added face-on and 23.14–23.31 ms edge-on. The 2 ms target, dust, continuous travel and temporal reuse remain open. Full gate: 1,723 regular tests and five slow tests; headless self-test 12/12. Captures are attached to PR #65; measurements and lifecycle evidence are in `CONTEXT.md`.                                                                                                           |
| M4        | The camera travels from Earth to the disk through the sensor.      | M3                             | Open in [PR #66](https://github.com/jonjaques/inertialref/pull/66), `codex/galaxy-earth-to-the-disk` → PR #65’s branch at `d980228`; verified implementation `7b612a1`, complete evidence ledger `8235d85`. [Execution plan](galaxy-m4-earth-to-the-disk.md); full outward/return capture and matched response plates in `.scratch/galaxy-m4/`. `pnpm check`: 1,742 regular tests, five slow tests, docs and build; physical GPU: 71 tests; headless: 12/12. Exposure clipping and 11–38 ms added volume cost remain explicit limits. [Journey recording](https://agentic-media-dumpster.jonjaques.com/2026/09/qxvm25qiw7/journey.mp4) and response plates are attached to PR #66.                                                                                                                                                            |
| M5        | Shared dust transport dims and reddens the volume.                 | M4                             | Feature implementation verified locally at `1d12369` on `codex/galaxy-light-through-dust`, from PR #66 at `837be56`. `galaxy-field@3`, `galaxy-tsl@3`; 1,784 regular tests, five slow tests, 74 GPU tests, headless 12/12. Inside/outside captures in `.scratch/galaxy-m5/`. **Performance run the same day:** the volume holds its target between changes of view (0.17 ms a frame at rest in the browser, against 113–357 ms a draw before), the dust texture is filtered to what a texel resolves (edge-on 53 → 10.8 ms a moving draw at 240×135), `galaxy-tsl@4`, orbit traces present at one brightness at every exposure. [Handoff and record](galaxy-performance-handoff.md). Open [PR #67](https://github.com/jonjaques/inertialref/pull/67), targeting M4; the daylight orbit follow-up and current verification are recorded there. |
| M6        | Local clouds and photometric checks constrain the sky.             | M5                             | [PR #70](https://github.com/jonjaques/inertialref/pull/70), `9911dd5`: physical model and linear photometry implemented, `galaxy-field@4` / `galaxy-tsl@5`. Source conventions and verification are recorded in ADR-0032. Enhanced treatment and final appearance acceptance belong to camera C2/C5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| M7        | A progressive cached sky serves ordinary Enhanced views.           | M6 baseline; C2 for acceptance | Implemented: shared arm table, progressive physical cubes, measured 0.15 pc reuse, independent disk archive and lifecycle regressions. Final quality measurements below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| M8        | Observer motion projects the star shell on the GPU.                | M7                             | Implemented: integer sector/subcell GPU projection, stable motion IDs, partial source uploads and absolute-V visibility. Equal-load CPU preparation and 20k/100k/200k GPU measurements below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M9        | Magnitude levels extend the population within a bounded draw.      | M8                             | Implemented: galaxy@5 magnitude levels, V8/100k/1m/2000 budgets, catalogue completeness, ensemble light partition and legacy P/Q manifest tests. Ten-thousand-cell slow property passes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| M10       | Resolved stars receive the same dust extinction.                   | M9                             | Implemented: shared observer-to-source dust, catalogue Solar correction, 1024-source GPU cycles and bounded WebGL fallback. Physical CPU/GPU columns and continuous-travel queue tests pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| M11       | Temporal rendering and the full journey pass the integration gate. | M10 + C5                       | Renderer implemented: interleaved physical history, cut/disocclusion/resize/version retirement, stationary detail retention and WebGL shader regression. Sixteen C5 plates and two 2,400-frame journeys recorded; exact state/lens/mode invariants pass. The completion record retains image and return-frame limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### M1–M5. Implemented foundation

[ADR-0032](../../docs/adr/0032-the-stellar-field.md) records the distant bright
catalog, versioned field, live volume, travel and dust transport. The ledger
above carries the verification references. Those implementation recipes are
complete and are not a second backlog.

[M4's execution record](galaxy-m4-earth-to-the-disk.md) retains the exposure
comparison: 2,400 s clips Earth while 1/40,000 s loses the galaxy, 26.5165 stops
apart at the same aperture and ISO. This remains photographic evidence.
Enhanced has a different acceptance requirement under camera C2 and C5.
[The M5 performance record](galaxy-performance-handoff.md) and
[performance findings](perf.md#the-galaxy) retain measured costs and sampling
constraints. Natural daylight omission is baseline evidence only.

### M6. The local sky and calibration

The physical model and linear photometry are implemented in
[PR #70](https://github.com/jonjaques/inertialref/pull/70), based on PR #69.
[ADR-0032](../../docs/adr/0032-the-stellar-field.md#the-local-sky-and-linear-calibration-m6)
records the nine local cloud approximations, Local Bubble, source conventions,
calibration residuals and verification. That milestone used
`galaxy-field@4` with port `galaxy-tsl@5` and left active generation unchanged.
The completion record below supersedes those versions.

The V-band checks use linear radiance, and fixed-exposure Direct plates verify
renderer integration. Neither Natural visibility nor Enhanced appearance is a
calibration input. Source corrections in the reference below replace
unsupported targets without widening the 0.3 mag tolerance. Camera C2 owns
visibility processing and C5 owns the final default image; those are the
remaining presentation requirements, rather than unfinished physical M6 work.

### M7. A cached sky with an owned lifetime

Implemented. A shared 2048² arm table serves both cube and live kernels. The
physical sky refines through 32², 128² and 512² faces in bounded tile batches.
A written observer and field/selection fingerprint governs reuse; response and
display-gamut changes reuse the physical cache. Canceled work, jumps, renderer
retirement and stale asynchronous loads cannot publish into a newer selection.

Completed WebGPU cubes can survive reload in a separate, regenerable IndexedDB
cache. Its two entries contain physical half-float faces, exact observer,
field/kernel/quality versions and the resolved envelope. Reads validate content
and the actual 0.15 pc displacement; failed storage is a cache miss. The save
database carries no sky pixels. Measured quality and costs follow below; final
crossing and reload behavior in the assembled journey remain part of M11.

### M8. The star shell follows the observer on the GPU

Implemented. Integer sectors, cell-relative source positions and observer
uniforms replace per-frame CPU shell projection. Stable IDs carry motion across
source replacement; partial uploads update changed sources. Absolute V
luminosity drives physical flux and the authored visibility response.

Projection, rebasing, stable identity and motion regressions pass. The equal-load
preparation comparison and 20k/100k/200k draw measurements are recorded below.
New-selection and broad-reorder work still have measurable CPU tails.

### M9. Magnitude levels and the population version

Implemented in `galaxy@5`. Nine disjoint luminosity bands have level-owned cells
and seeded bounded selection. The production request is V8 with ceilings of
100,000 sprites, 1,000,000 candidates and 2,000 cells. Recorded catalog coverage
replaces the old spherical completeness assumption. Travel queries resolve and
find coarse-level identities independently of the sky selection.

The resolved envelope carries its actual origin, retained magnitude threshold
and level mask. A source ceiling tightens the threshold; omitted bands remain
diffuse. Integrating the resolved and diffuse luminosity moments reconstructs
the calibrated total exactly in the ensemble. A finite catalog and procedural
realization has a sampling residual; it is not an atom-by-atom subtraction from
the smooth field.

The ten-thousand-cell slow property covers completeness, duplicates and order
independence. Manifest regressions preserve legacy P generation and report Q
version drift. Q addresses depend on the recorded generation manifest; an old
high index can fail explicit resolution after a population change rather than
silently naming a different index. Final field@5 operating points follow below.

### M10. Extinction on resolved stars

Implemented. The same dust field integrates only to the source distance, with
32/64/512 samples selected by distance and spacing concentrated near the disk
crossing. Catalog stars receive a Solar-reference correction so already
observed photometry is not attenuated twice.

Retained GPU columns update in cycles of at most 1,024 sources. Travel does not
restart every pending cycle. CPU/GPU column, foreground/background and queue
regressions pass. WebGL uses one CPU source column per submission; unresolved
columns converge progressively, so its first complete star field is slower.

### M11. Temporal volume and integration acceptance

The renderer is implemented. Physical temporal history retains fine stationary
detail and retires on cuts, disocclusion, resize, version changes and renderer
retirement. Production uses a half-resolution target with stride 8 and a
960-pixel maximum long edge. The scene and resolved stars retain their own
resolution. The measured live-volume budget revision follows below.

The production build at `ee0e9e1` passes the assembled repository gate and
sixteen exact public-picture checks. Outward and return recordings cover the
full route with unchanged canonical hash, camera mode and lens. This is author
verification for a ready PR; it is not a claim of the user's artistic approval.
The return's frame-time spikes and the model's smooth morphology remain visible
in the attached evidence.

### Completion measurements, 7 September 2026

The source record is `.scratch/galaxy-finish/` on the completion branch. GPU
figures use the Apple M5 and WebGPU; they measure isolated work through the
repository GPU timestamp helper, not the complete presented frame. Node 26.5
population figures run the production worker task and host selection inline,
with the default session seed and shipped catalog. They exclude IPC and dust.

| Physical sky measurement                 | Result and scope                                                                                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 512² cube, corrected `cube@2` footprint  | 3.829 s drained cold bake; isolated three-target allocation 36 MiB; maximum relative RGB error 0.629% across 72 arbitrary directions and 0.086% at 12 texel centers.                                        |
| Cube sampling                            | 0.030–0.047 ms across the measured 960×540 and 1440×900 sampling targets.                                                                                                                                   |
| 0.15 pc reuse at field@5                 | 3,120 translated rays from 21 origins; worst coarse error 0.710%, with 0.25 pc-step rechecks below 0.661%. The 1% budget is unchanged.                                                                      |
| 100k star draw                           | 0.687 ms median added GPU time at 1920×1080, 4× MSAA, sensor MRT, downstream optics bypassed and retained transparent extinction. The 20k and 200k controls add 0.343 and 1.254 ms.                         |
| Replacing 10% of a 28,942-source fixture | CPU preparation median 9.802 → 3.000 ms; p95 11.747 → 4.419 ms. Broad reordering is 4.877 ms median, 8.261 ms p95 after the change. These are earlier fixed-population comparisons, not new field@5 counts. |

The original live-volume **2 ms at 1080p** budget is deliberately revised.
The uncapped half-resolution/stride-8 inside view measures **6.366 ms** at
1920×1080, and 12.693 ms at 2880×1800. The chosen spatial detail costs more
than that original target; cached ordinary views stay near 0.03–0.05 ms. The
production 960-pixel cap bounds target/history growth while retaining that
sampling detail. It does not establish a universal 2 ms live path.

| Moving live volume, production half resolution / stride 8 / cap 960 |  Face-on |  Edge-on |   Inside | Volume + shared-table bytes |
| ------------------------------------------------------------------- | -------: | -------: | -------: | --------------------------: |
| 1920×1080 drawing buffer                                            | 2.225 ms | 4.501 ms | 6.296 ms |                  29,284,096 |
| 2880×1800 drawing buffer                                            | 2.460 ms | 5.525 ms | 7.399 ms |                  30,673,216 |

Each result measures 40 moving draws with 0.2 pc translation per draw and a
V8/mask-511 envelope. The 1080p target is 960×540; the larger buffer uses
960×600. These are physical volume costs, excluding the native scene, stars and
sensor. `capped-galaxy-summary.json` records the verified cap at `434009f`.

| Field@5 V8 observer     | Procedural + catalog | Candidates / cells | Retained levels | Worker median | Host apply median | Observed peak heap |
| ----------------------- | -------------------: | -----------------: | --------------- | ------------: | ----------------: | -----------------: |
| Sol                     |      19,243 + 10,014 |      213,380 / 544 | 0–8             |    119.722 ms |         10.443 ms |         139.69 MiB |
| 1 kpc toward the center |         36,634 + 789 |      322,669 / 512 | 0–8             |    172.355 ms |         17.415 ms |         180.87 MiB |
| Galactic center         |           16,001 + 3 |      287,681 / 576 | 0–1             |    132.045 ms |          7.892 ms |         158.60 MiB |

All retain V8, stay inside the three ceilings and repeat without duplicate IDs.
At the center, the remaining levels cannot fit the candidate budget and stay
fully diffuse. Generation runs off the main thread in production; **it does not
meet a five-millisecond CPU-query target**. Host application occurs per survey,
not per frame. Heap figures are sampled combined inline worker/host peaks from
a separate pass, not exact V8 maxima or isolated browser-worker memory. The
serialized worker payloads are 5.05–11.64 MiB.

Solar 10/25/50 pc balls contain 389/6,788/53,532 catalog-plus-procedural stars,
against field integrals of 418.924/6,549.357/52,109.668: −7.14%, +3.64%, +2.73%.
The local density remains 0.1 star/pc³ and the integrated reference count is
116.064 billion. The four V calibration residuals are +0.077, +0.178, −0.280
and +0.033 mag, inside the unchanged 0.3 mag tolerance. The young-height
correction shares one density profile with diffuse and resolved light; it does
not independently validate the approximate central morphology.

Source files: `cube-footprint-summary.json`, `cube-quality.log`,
`cache-radius-field5-summary.json`, `starShell-gpu-benchmark.jsonl`,
`star-replacement-pair*.json`, `final-quality-bench.log`,
`capped-galaxy-summary.json`, `field5-operating-summary.json` and
`population-height-plate.json` in that scratch directory.

### Assembled image and motion record

This is the PR #73 record at `ee0e9e1`. The
[camera completion record](the-camera.md#camera-completion-record) supersedes
its night-emission and camera-continuity findings and adds matched return
traces. The physical morphology and whole-frame caveats below remain applicable.

All images use the production source at `ee0e9e1`, Apple M5, Chrome 152,
WebGPU, sRGB SDR and MSAA 4. The sixteen camera fixtures use native
1920×1080 / DPR 1, with identical pose, time and lens in each Enhanced /
Automatic / Manual triplet. Public URL restoration preserves every encoded
field. This repeats the cold-restore regression that previously replaced
1/3200 s with 1/60 s. The parent preference binding now runs before the route
restores its photograph.

[Earth and band](https://agentic-media-dumpster.jonjaques.com/2026/09/h7ufhup55u/triplet-earth-band.jpg),
[Luna](https://agentic-media-dumpster.jonjaques.com/2026/09/r4rakwrbnu/triplet-luna.jpg),
[night side](https://agentic-media-dumpster.jonjaques.com/2026/09/fqbc4tqrdx/triplet-night.jpg)
and [Bennu](https://agentic-media-dumpster.jonjaques.com/2026/09/x3az4a68s7/triplet-bennu.jpg)
show the matched modes. Enhanced retains foreground relief and the sky;
Automatic and short Manual suppress faint sky beside a lit subject. The
[2,400 s Manual exposure](https://agentic-media-dumpster.jonjaques.com/2026/09/749er9thf4/camera-review-earth-band-manual-long.png)
reveals the band and clips Earth. Bodies occlude the band and stars, with no
observed sky-through-disk or reversed dust lane.

The [outward cast](https://agentic-media-dumpster.jonjaques.com/2026/09/f654hxpc66/cast.mp4)
and [return cast](https://agentic-media-dumpster.jonjaques.com/2026/09/yrbzpaa8yy/cast.mp4)
each contain 2,400 compositor frames. Both finish the 36-second presentation
journey, preserve canonical hash `98b5b2be` and retain the same Enhanced mode
and lens. Sampling includes a short held tail. Neither cast reports isolated
frames; because the camera moves, that detector alone does not prove an absence
of every artifact. Reviewed scale samples retain the sky and show no blank
representation switch. [Earth orbit](https://agentic-media-dumpster.jonjaques.com/2026/09/nxjjmbizyx/orbit.png),
[exterior](https://agentic-media-dumpster.jonjaques.com/2026/09/9xd33s2t35/exterior.png)
and [edge-on instrument](https://agentic-media-dumpster.jonjaques.com/2026/09/9tfs94rja4/edge-on.png)
are full-size plates from that run.

| Complete app / sensor operating point, 1920×1080 DPR 1   | Measured result                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Outward compositor cast                                  | 59.7 fps over 40.21 s; rAF interval p95 18.0 ms, p99 18.7 ms, maximum 50.9 ms |
| Return compositor cast                                   | 52.8 fps over 45.49 s; rAF interval p95 32.5 ms, p99 50.2 ms, maximum 150 ms  |
| Held Enhanced Earth-band                                 | 4.257 ms / 60 queued complete sensor frames                                   |
| Held Automatic Earth                                     | 4.562 ms / 60 queued complete sensor frames                                   |
| Held Manual Earth-band, 2400 s                           | 5.043 ms / 60 queued complete sensor frames                                   |
| Held journey exterior / returned orbit / edge instrument | 2.868 / 2.765 / 2.513 ms / 60 queued complete sensor frames each              |

Compositor rates, paced frame intervals and drained GPU submissions measure
different things. The return has 113 intervals above 25 ms and 26 above 50 ms
among 2,209 sampled intervals; it does **not** establish sustained 60 fps.
Most sampled slow frames occur while returning from outside the disk. The
held GPU result is not a substitute for this moving-app limit.

The visual limits are also measurable. At the Earth-band pose, removing cube
filtering changes physical RGB by at most 0.38% across two 81-ray patches;
broad RMS contrast remains about 13.1% at 512, 1024 or unfiltered resolution.
Enhanced compresses that to about 10.0%. The smooth disks and Gaussian local
clouds dominate the broad brown lobes; a larger cube would not create the
missing projected structure. The exterior's central light fraction remains
an approximate population model. Reference-matched dust morphology is further
physical-model work, not a hidden quality setting.

The night Automatic plate exposes an existing Earth source issue: the colorized
Black Marble map contains blue land/ocean background, and the body shader emits
that background together with city lights. The meter settles inside its comfort
bounds at EV 8.388 and amplifies the hemisphere while stars remain below
visibility. This fixture does not meet the proposed star-dominated night image;
forcing more gain would amplify the source error. The galaxy PR does not alter
Earth's night-emission material.

The full `pnpm check` passes 2,010 regular tests in 153 files and eight slow
tests, plus graph, presets, formatting, lint, all typechecks, documentation and
production builds. `pnpm sim --self-test` passes 12/12. The final physical GPU suite passes 107 tests in 36 files on byte-identical
`ee0e9e1` source. An initial run returned zero light in two dust tests; the
cause remains unproven. Six focused reruns, 72 distinct freshly compiled
shaders covering 864 rays, and two complete suite reruns pass without any
production, test or tolerance change. The record retains that initial failure
instead of claiming a diagnosed fix. The additional lifecycle
run uses public mode changes and photographic pause/resume, then negotiates
Extended display-P3 at 2× headroom through the real settings UI and returns to
Standard sRGB with verified renderer replacement. At 1440×900 CSS / DPR 2,
the native scene is 2880×1800, the physical history is 960×600, and 60 queued
complete sensor frames average 6.410 ms. Extended and resized views restore
one finished archive, with zero writes or failures.

The [mode-switch recording](https://agentic-media-dumpster.jonjaques.com/2026/09/h8uwsrmxbk/cast.mp4)
contains 360 compositor frames; the
[pause/resume recording](https://agentic-media-dumpster.jonjaques.com/2026/09/kibamqkipn/cast.mp4)
contains 240. Both have no isolated-frame flags or browser errors. Real WebGL
orbit and external-instrument captures also render without errors; Automatic
remains explicitly unsupported on that backend. Every owned Chrome rig and
preview server is closed. No tolerances
were relaxed to obtain these results. The detailed local records are
`camera-acceptance/final-fixed/`, `journey-final/` and
`earth-band-contrast-summary.json` under `.scratch/galaxy-finish/`.

## Follow-up sessions after the integration

These retain galaxy follow-ups without making the first complete journey
depend on them. Deferred optics, spectral response and photo workflow live in
[the camera plan](the-camera.md#scope-that-waits). Each row is a separate Milestone → Implement → Verify → PR
cycle; split a row further if its measured work exceeds one session.

| Milestone            | Implement                                                                                       | Verify                                                                                                   | PR and dependency                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| H II knots           | Seed arm-bound emission clumps and OB light from the shared field; carry line emission as data. | Determinism, arm/height placement, CPU/GPU emission agreement, luminosity budget and outside-view plate. | Galaxy follow-up after M11; enables spectral filters.                 |
| Globular clusters    | Ingest a cited cluster catalog and render measured positions, magnitudes and half-light radii.  | Catalog round trip, identity, Omega Centauri and 47 Tucanae positions, halo plate and draw budget.       | Independent galaxy follow-up after M11.                               |
| Neighboring galaxies | Add one parameter record at a time for the LMC, SMC and M31, including representation limits.   | Direction, angular size, brightness, coordinate range and culling.                                       | One PR per neighbor; M31 needs a far-field addressing decision first. |
| Horizon of knowledge | Derive the galaxy map's coverage surface from the catalog completeness record.                  | Per-class coverage and observed/projected labeling.                                                      | Separate map interaction plan and PR.                                 |
| Zodiacal light       | Specify the solar-system dust field and integrate it at AU scale.                               | A separate calibration and sampling plan.                                                                | Separate emitter plan; reuses the sensor contract.                    |

## Sensor contract and remaining specifications

[ADR-0029](../../docs/adr/0029-the-sensor-spine.md) owns the chain, and
[ADR-0037](../../docs/adr/0037-the-enhanced-camera.md) owns camera direction.
The implementation sequence and deferred sensor work live in
[the camera plan](the-camera.md). Exposure, pre-exposure, optical resource
ownership and output negotiation in ADR-0031 remain the implemented baseline.

Diffuse radiance stays in stated physical units until presentation. A bake can
store nW m⁻² sr⁻¹ to preserve half-float precision, but its conversion to cd/m²
must state its spectral assumptions. The response consumes calibrated input;
it cannot alter field constants to make the image work. Enhanced's declared
compression, Automatic's meter and Manual's lens exposure have separate image
checks. Fixed galaxy instruments remain useful for photometry without forcing
ordinary travel into a long exposure.

The complete sensor/atmosphere/galaxy performance matrix remains open. The
sensor budgets at 1080p are 0.15 ms for spine/resolve/blit, 0.05 ms for metering,
0.40 ms for the halo, 0.80 ms for active defocus, 0.60 ms for active motion and
0.20 ms for detector/output. These are targets, not measured room for a 2 ms
volume. Camera C5 measures the real chain with the default sky visible.

M11's temporal history belongs to the diffuse volume. Whole-scene temporal
anti-aliasing and the star shell are outside that history. Cache identity and
physical-light tests remain independent of presentation response; exposure or
mode changes invalidate or rescale display history according to its stored
units. [The upscaler](the-upscaler.md) does not gate the galaxy integration.

## Technical reference

Published figures carry sources; measured figures name their rig and operating
point. The completion record above supersedes the original unmeasured timing,
quality and sprite budgets. The reference below describes the implemented field
and marks deferred features. [ADR-0038](../../docs/adr/0038-the-stars-and-the-diffuse-sky.md)
records active generation, calibration assumptions and renderer contracts.

The frame is already right, which is the fact this plan stands on. The universe
origin is the galactic center; `heliocentricToUniverse` puts the Sun at (−8,178
pc, +20.8 pc, 0) in simulation axes; galactic longitude zero is +X from the Sun
and the north galactic pole is +Y; rotation is clockwise seen from that pole.
Nothing here needs a new frame. Every catalog star is already in this one, which
is what lets the band and Sirius agree by construction rather than by alignment.

---

### Shared model and generation

**One field, every consumer.** `packages/universe/src/galaxy/` holds a pure,
seeded, versioned field over galactocentric parsecs; number density and emission
per stellar population, plus dust density; and three consumers read it: the sky
bake from inside, the volume from outside, and the population sampler. The CPU
is the reference; the GPU kernel is a port held to a measured bound, the way
[ADR-0023](../../docs/adr/0023-the-gpu-producer.md) holds the terrain producer.
Separate inside and outside models would allow their structures and brightness
to disagree at the transition.

**Never generate a star the catalog would have seen.**
`CellContext.completeRadius` is this rule for a sphere; the horizon of knowledge
is not a sphere. It is a magnitude: a procedural star may exist only where its
apparent magnitude is fainter than the catalog's limit at that distance, and the
limit is a property of the catalog version, carried as an input the way
`completeRadius` is. A property test states it and a Poisson draw cannot break
it.

**Measured where measured, generated where not.** The disk, bar, arms and warp
use published parameters. Named clouds include the Aquila and Cygnus rifts,
Ophiuchus, Taurus, Perseus, Orion and the Coalsack. Their ellipsoids come from
3D dust maps; below that resolution the dust uses seeded noise. Globular
clusters use a catalog in a follow-up session. The Local Bubble uses a declared
solar-centered approximation informed by its published radius.

**Brightness is integration.** The field emits in physical units, calibrated
against the integrated starlight the sky actually has, so the band's visibility
depends on the sensor response and exposure. A shutter value alone cannot
establish photographic visibility without aperture and ISO. M6 verifies raw
radiance and fixed photographic exposure; camera C5 compares Enhanced,
Automatic and Manual without feeding their appearance back into calibration.

**One integral through travel.** Inside and outside views use the same field
and transport. A cube caches that integral at the observer while its written
parallax and selection envelope remain valid. Live rendering takes over outside
that budget, and a new valid cube can replace the work without changing models.

---

### Stellar populations, dust and calibration

The field lives in `packages/universe/src/galaxy/`. The active
`stellarDensity` and magnitude-level population use the calibrated field at
`galaxy@5` / `galaxy-field@5`. Coordinates are galactocentric parsecs in simulation
axes; `R` is the in-plane radius, `z` the height, `β` the azimuth from the Sun's
direction, increasing with rotation.

**Stars, by population.** Each population carries a density, a mean luminosity
and a color temperature, so emission per unit volume is a product and the
population mix is what colors the picture.

| Population | Density and published parameters                                                                                                                                                                                                                         | Color target |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Thin disk  | Double exponential; radial scale 2.6 ± 0.5 kpc, height 300 ± 50 pc; arm modulation. Bland-Hawthorn & Gerhard 2016.                                                                                                                                       | 5,000 K      |
| Thick disk | Radial scale 2.0 kpc, height 900 pc; 4% of local thin-disk density and 12% of its column.                                                                                                                                                                | 4,600 K      |
| Young arms | Gaussian ridges with the shared flared `sech²` profile: heights 50/67/90 pc at the center/4.5 kpc/Sun, preserving the vertical column. Natale et al. geometry is an explicit arm-population assumption; Reid's 19 pc describes very young maser tracers. | 12,000 K     |
| Bar/bulge  | Boxy profile at 27°; 1.5/0.75 kpc in-plane scales, 390 pc exponential height and a 5 kpc radial taper. These are the calibrated approximation, not a measured V-light decomposition.                                                                     | 4,300 K      |
| Halo       | Spheroidal profile proportional to `(1 + r/r_h)^−3.5`, flattening 0.6; Harris globular distribution.                                                                                                                                                     | 4,800 K      |

The field is normalized to 0.1 star/pc³ at the Sun. Its reference cylinder
contains 116.064 billion stars, inside the published 10¹¹–4 × 10¹¹ range.
Catalog-plus-procedural counts are compared with actual field integrals in the
completion record, rather than assumed constant throughout the old survey cube.
Mean solar V luminosities per star are 0.204/0.35/100/0.7725/0.1 for the five
rows above. The young-height law is shared by number density and emission;
`H(0) / H(R)` preserves its column as the profile flares.

**Arms.** Reid et al. 2019, Table 2: log-periodic with one kink, `ln(R/R_kink) =
−(β − β_kink) tan ψ`, with a pitch angle on each side of the kink and a Gaussian
half-width. Norma, Scutum–Centaurus, Sagittarius–Carina, the Local arm, Perseus
and the Outer arm, with the 3 kpc arm inside; Norma–Outer and
Scutum–Centaurus–OSC are single wrapped arms. The test that this is right is not
a picture: from the Sun, the arm tangencies fall at the longitudes Hou & Han
2014 measure from 815 H II regions; **Scutum 30.5°, Sagittarius 49.3°, Carina
282°, Centaurus 310°, Norma 328°**, the near 3 kpc arm at 24°. and
`arms.test.ts` asserts each within 3°. The Chen et al. power-law fit begins at 7.72 kpc and the disk warps: `z = a (R −
R_w)^b sin(φ − φ_w)`, line of nodes 17.5° from the Sun–center line (Chen et al.
2019), which is what makes the outside view's rim lift the way the real one
does.

**Dust.** An exponential disk with two vertical components; scale heights **81
and 152 pc**, scale length 2.26 kpc. The heights are Guo et al. 2025's means over 6–12 kpc;
the radial length is Drimmel & Spergel 2001's. Their combination is an explicit
preview assumption, recorded in [ADR-0032](../../docs/adr/0032-the-stellar-field.md#dust-transport-m5); normalized to about 1 V
magnitude of extinction per kiloparsec in the plane, with the arm lanes offset
inward of the stellar ridges, and a log-normal multiplicative noise term of four
bands down to about 1 pc (following the noise approach in GAMER, Groeneboom & Dahle 2014).
Reddening is `τ ∝ λ⁻¹`, three coefficients, so the band goes brown behind the
rift and the bulge reads warm through its foreground. On top of the field, a
table of **local clouds** approximates nine complexes in the Lallement 2022
map: Aquila, Cygnus, Ophiuchus, Taurus, Perseus, Orion, Chamaeleon, Lupus and the
Coalsack. M6 records the selection windows and fits Gaussian moments and excess
columns from the actual 25 pc resolution cube; the compact ellipsoids are model
approximations. Zucker et al. 2022 gives the **Local Bubble's radius** as
165 ± 6 pc, not its diameter. M6 uses a declared solar-centered approximation
with residual dust. It does not skip nearby emission or assume an empty first
ten parsecs.

**H II regions, follow-up only.** Proposed along the young-arm ridges only, within 40 pc of the plane,
Poisson-disc clumps seeded from the arm coordinate, each a small Gaussian
emitter at Hα's 656 nm and a shell of OB light. They are the pink knots along
the arms in every photograph of a spiral, they are the primary arm tracer in the
literature (Anderson et al. 2014, over 8,000 of them), and they are the first
thing in the game that emits a narrowband line; which is what the sensor's
filter seam is waiting for.

**Globular clusters, follow-up only.** The proposed source is a catalog. Harris 2010 lists 157 with
positions, distances, half-light radii and magnitudes, and Vasiliev & Baumgardt
2021 give 162 accurate distances from Gaia; the ingest packs them like the star
catalog does, and each draws as a sprite whose halo scales with its half-light
radius. Omega Centauri and 47 Tucanae are the two a player will know.

**Two Clouds and Andromeda**, later. The LMC at (280.46°, −32.89°) and 50 kpc,
the SMC at (302.79°, −44.30°) and 62 kpc, M31 at (121.17°, −21.57°) and 770 kpc:
each is the same field with its own parameter record, drawn from outside at its
real direction and size. The follow-up ledger preserves these targets; the field
parameter record allows separate objects without scheduling them in the
integration PR.

**Calibration.** M6 verifies the source, bandpass and viewing geometry before
accepting the target. The following replaces the draft transcriptions:

| Check                                               | Source target                                      | Tolerance                  |
| --------------------------------------------------- | -------------------------------------------------- | -------------------------- |
| Solar sky, all longitudes, 30–60° absolute latitude | 53.559 V nW m⁻² sr⁻¹, GAMBONS supplemental map     | 0.3 mag                    |
| Solar sky, all longitudes, 60–90° absolute latitude | 41.862 V nW m⁻² sr⁻¹, same map                     | 0.3 mag                    |
| Aquila region, l = 40–50°, absolute b = 0–5°        | 176.410 V nW m⁻² sr⁻¹, same map                    | 0.3 mag                    |
| Emergent face-on isotropic-equivalent luminosity    | M_V = −21.515, Licquia et al. Table 3 with h = 0.7 | 0.3 mag                    |
| Central disk B brightness / integrated B−V          | Freeman comparison / Licquia B−V = 0.744           | No V-band acceptance claim |

The GAMBONS reference includes integrated starlight, diffuse Galactic light and
extragalactic background. The model supplies the stellar component only; this
is a broad sky constraint with a declared component mismatch. The original
75 nW target is a ground-level annual zenith average at geographic 40° N and
includes atmospheric contributions. Table 3 does not give the proposed generic
22.3–23.4 mag range. The external magnitude needs the paper's `5 log h`
correction; the earlier −21.37 transcription is not its V-band target.

Green in the raw RGB field is Johnson V radiance; red and blue retain
illustrative color and extinction. A fixed photopic/V ratio of 1.25 converts
V radiance to luminance at 683 lm/W. A target texel stores those V-anchored
channels divided by 1,000 nW m⁻² sr⁻¹. Neither exposure nor a display response
enters the photometric acceptance calculation. The Natural-specific work is
held separately from these physical units and constants.

**Versioning.** Field and population changes use `algorithm()` and `manifest()`
([ADR-0005](../../docs/adr/0005-procedural-seeds.md)). M2–M6 kept the preview
separate from active generation. M9 activates magnitude levels; the coherent
young-height correction advances both active algorithms to version 5. Legacy P
addresses retain their original generator. Q addresses depend on their recorded
generation manifest; loading older generation reports drift and an unavailable
old index fails resolution explicitly. Recalibration remains a versioned change.

---

### Cached sky

The cube and live volume integrate the same bounded, adaptive physical kernel.
Sampling begins at the observer and concentrates around nearby clouds and disk
crossings. Dust is integrated front to back; unresolved luminosity is the
complement of the actual resolved envelope. There is no assumed empty first
10 pc and no arbitrary spherical subtraction around the camera.

Production refines 32² → 128² → 512² in 32² tiles, two per submission. A 512²
RGBA-half cube contains 12 MiB; three resident cache slots total 36 MiB. The
1024² experiment needs 144 MiB for those slots and an 18.256 s drained bake,
so it is not the shipped tier. The earlier 120 ms full-bake and 2 ms first-sky
estimates are superseded by measured progressive scheduling and a separate
completed-cube archive. Warm reuse does not block boot on a new full bake.

The archive keeps two completed WebGPU entries independently of save state.
Its fingerprint includes field/seed, kernel, cube sampling version, quality,
exact observer and resolved envelope. A valid read within 0.15 pc can restore
physical pixels asynchronously. Storage errors and stale replies become misses.
The unchanged 1% translation budget is checked at Sol, regional positions,
bulge and local-cloud fronts, not inferred only from a nominal dust distance.

CPU/GPU field, ray, cube interpolation and lifecycle tests guard agreement.
`cube@2` uses the conservative cube-face texel angle `2 / faceSize`; the
physical kernel remains `galaxy-tsl@8`. Physical radiance survives response and
gamut changes; display history has its own validity. Fine split coordinates are
needed for nearby resolved-star projection, while the diffuse field's parsec
scale remains representable in float32.

---

### Resolved population

The explicit catalog contains nearby stars and the 7,515-system distant V≤6.5
asset (188 KB brotli). The draw joins catalog and procedural selection by stable
identity. Catalog coverage is V7.3 inside 150 ly, V6.5 beyond it and a 25 ly
volume-complete neighborhood, with the assumptions and source provenance in
[ADR-0038](../../docs/adr/0038-the-stars-and-the-diffuse-sky.md). Sparse fainter
catalog stars also remove their expected procedural contribution. The proposed
V8 distant catalog extension remains a separate ingest/download decision.

Nine disjoint log-uniform V-luminosity bands use cells of `20 · 2^level` ly and
seeds derived from level and cell. The population weights reproduce each
calibrated mean luminosity. Complete level envelopes are admitted only within
the candidate and cell ceilings; the source ceiling can lower the actual
magnitude threshold. The shared resolved-envelope record controls the diffuse
first-moment complement on CPU and GPU. This conserves ensemble luminosity;
individual finite realizations retain a sampling residual.

The shipped V8 request uses 100,000 sprites, 1,000,000 candidates and 2,000
cells, selected from measured 20k/100k/200k GPU costs and bounded CPU work. The
field@5 operating-point table records the actual counts, masks and costs. It
does not claim every magnitude level is drawable in the densest region.

GPU projection reads stable source positions from integer sectors and relative
offsets. Observer motion updates uniforms; survey changes upload source data,
with retained identities and partial updates. The historical 0.62–0.79 ms CPU
rewrite under warp is no longer the active projection path.

Resolved dust uses retained physical columns with 32/64/512 distance-tier
samples, ending at each star. A catalog Solar-reference correction preserves
observed photometry. GPU cycles handle 1,024 sources; the WebGL fallback handles
one source per submission and converges progressively. A sixteen-sample
per-vertex integral was a proposal, not the shipped implementation.

---

### Live volume

The camera's 100 kly ceiling covers the Earth-to-disk journey. Local cache
validity is measured from the actual baked observer; it is independent of the
observer's distance from Sol. Outside the 0.15 pc cache radius, the same physical
integral renders live until a valid bake is ready. Resolved stars keep their
bounded selection and the diffuse field keeps its matching complement.

Production uses a half-resolution target, capped at a 960-pixel long edge,
with stride-8 interleaved temporal history. Adaptive ray spacing resolves the
dust columns; the original uniform 96-step proposal is not the implementation.
History preserves fine detail at rest and resets for discontinuities. Scene
depth composition lets nearby bodies occlude the galaxy. The completed
measurements above replace the original universal 2 ms at 1080p target.

Face-on and edge-on views expose the arm ridges, warm central population, dust
lanes and warp. H II knots and catalog globular clusters are follow-ups. The
central morphology remains approximate: passing broad integrated V constraints
does not establish a measured bulge/disk decomposition or final visual quality.
C5 and the complete journey remain the image acceptance gates.

Equivalent unobscured views have distance-invariant surface brightness, but an
internal sky and face-on disk integrate different columns. Their calibration
checks remain separate. Sensor exposure and declared galaxy-instrument settings
do not change the physical field. A small-angular-size sprite fallback remains
an optional measured follow-up; it is not needed to claim a second field model.

---

### Alternatives and their costs

- **A panorama.** ESO's and Gaia's all-sky images are what every planetarium
  uses, Stellarium included; Gaia's is CC BY-NC besides. An image is a fixed
  exposure of one viewpoint with the star halos baked in, and it is the thing
  this page exists to not do.
- **A point cloud only.** The Celestia example samples sprites from a template. It aliases, it has no dust, it saturates toward the center under
  additive blending (Gaia Sky's Figure 17 is the failure), and from inside it
  is a cloud of billboards Gaia Sky had to dither-discard for occlusion until
  it added a volume anyway.
- **A 3D texture of the field for the outside view.** 256³ RGBA half-float is
  134 MB and OpenSpace's 1024×1024×128 is the same idea larger. The analytic
  field is cheap enough to evaluate per sample, and a texture would be a
  second copy of the model to keep in step. If the march measures over budget
  the fallback is a 256×256×64 slab at 17 MB, and it is the same kernel
  sampling a texture instead of a function.
- **A density-wave particle galaxy.** A two-dimensional tilted-ellipse model
  has no interior dust transport or agreement with the catalog frame.
- **Shrinking the sky bake to save memory** by baking only the smooth part at
  low resolution. Emission behind dust and in front of it do not separate, so
  the product is what has to be stored at the dust's resolution.

---

## Evidence still to resolve

- The completion record separates passing author checks from the remaining
  image limits and return-frame spikes. A universal 60 fps journey is not proven.
- A drained full-bake time is not a boot time. The current boot capture completes
  all 1,638 progressive tiles and writes one archive; storage, readback and driver
  differences still affect cold/reload latency.
- Central morphology, H II line emission and clusters remain approximate or
  deferred. Integrated V calibration does not measure their spatial light mix.
- The catalog's coverage assumptions are explicit; deeper observed completeness
  requires an ingest and source review, not inference from a histogram peak.
- Neighboring galaxies require a separate coordinate-range check. M31 lies
  outside the current coordinate system's roughly 249,000 ly span.

## Commands and evidence locations

Existing commands for implementation sessions:

```bash
pnpm check
pnpm test:gpu -- sensor psf tonemap
node scripts/drive.mjs --url 'http://localhost:5173/?timing=full' \
  --js "await ir.gpu(60)" --down
```

M2 provides `pnpm sim --galaxy-plates <directory> --galaxy-width 384` for
composite and isolated-population plates, raw radiance, and the reference report.
The galaxy GPU suite includes field/ray, baked/live, temporal and lifecycle
checks. Rerun the relevant suites at the final assembled tip. Use the existing headless session constructor and browser
driver instead of a second runner.

Put scratch plates, traces and recordings in `.scratch/`, publish review media
through the existing media workflow when opening its PR, and link the durable
results in the ledger. A source change records measurements and decisions in
`CONTEXT.md` through `context-log`; accepted architecture belongs in an ADR.
Plans remain here in `design/plans/` and are not published implementation docs.
