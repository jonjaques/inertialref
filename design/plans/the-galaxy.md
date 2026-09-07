# The galaxy: Earth to the whole Milky Way

Build a continuous journey from Earth orbit to 30 kpc above the galactic plane,
using one versioned model for the sky, resolved stars and the whole disk.
This plan owns physical light, dust, populations, cached-sky rendering and
travel. [The camera plan](the-camera.md) owns the image through which the player
sees that journey, following
[ADR-0037](../../docs/adr/0037-the-enhanced-camera.md).

The M1–M6 planning baseline is [PR #70](https://github.com/jonjaques/inertialref/pull/70),
`9911dd5`. The current completion branch is
`codex/galaxy-the-sky-keeps-its-detail`, explicitly stacked on
[PR #72](https://github.com/jonjaques/inertialref/pull/72),
`codex/the-camera-reveals-the-sky` at `2847688`. The user's selected base
supersedes the older session-branch sketch below for this PR. Physical
calibration remains independent of Enhanced image treatment.

M7–M10 and M11's renderer are implemented. The final assembled image,
transition and performance record follows below once the release checks finish.
[ADR-0038](../../docs/adr/0038-the-stars-and-the-diffuse-sky.md) records active
`galaxy@5`, physical `galaxy-field@5`, the resolved/diffuse partition, dust,
cache and history contracts. Historical milestone rows retain their original
verification and do not assert that an earlier PR has merged.

## What already works

| Area                    | Implemented baseline                                                                                   | Remaining work                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Coordinates and catalog | Galactocentric coordinates, measured Sun position, stable addresses and the M1 distant bright catalog. | Preserve the frame through every representation.                                         |
| Field and transport     | Versioned field, M4 travel, shared/local dust and M6 V-band photometry, recorded in ADR-0032.          | M7 caching; camera C2 and C5 presentation acceptance.                                    |
| Star population         | Bounded local selection with catalog and procedural sprites.                                           | M8 GPU projection, M9 magnitude completeness and resolved/diffuse split, M10 extinction. |
| Sensor                  | Lens exposure, metering, optical passes and output negotiation in ADR-0031.                            | Camera C1–C5 replace the coupled Natural/Composite/Direct policy.                        |
| Resource lifetime       | Owned volume and optical targets, settled-view reuse and renderer retirement.                          | Progressive cache and temporal history validity.                                         |

Natural's integrated sprite ramp does not establish the default sky's finished
appearance. Enhanced must show bright worlds and faint galactic structure
together. Keep physical calibration and composite appearance as separate gates;
neither changes source light to satisfy the other.

## The galaxy integration PR

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
| M11       | Temporal rendering and the full journey pass the integration gate. | M10 + C5                       | Renderer implemented: interleaved physical history, cut/disocclusion/resize/version retirement, stationary detail retention and WebGL shader regression. Final journey and C5 verification in progress.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

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
calibration residuals and verification. The physical preview is
`galaxy-field@4`, with port `galaxy-tsl@5`; active generation is unchanged.

The V-band checks use linear radiance, and fixed-exposure Direct plates verify
renderer integration. Neither Natural visibility nor Enhanced appearance is a
calibration input. Source corrections in the reference below replace
unsupported targets without widening the 0.3 mag tolerance. Camera C2 owns
visibility processing and C5 owns the final default image; those are the
remaining presentation requirements, rather than unfinished physical M6 work.

### M7. A cached sky with an owned lifetime

**Milestone.** Ordinary Enhanced flight samples a visible cached sky at a
bounded cost, including sunlit Earth orbit and free look. This is required
before camera C4 changes the production default. Cache implementation uses
M6's versioned field; acceptance also needs camera C2's radiance-domain contract.

**Implement.** Bake the same kernel progressively into a cubemap, beginning at
128² and measuring 512²/1024² tiers. Tile dispatches, register boot progress,
and cache by field version and observer location. A written record owns the
observer/parallax validity budget and resources. Moving beyond that budget uses
the live volume until a valid bake is ready; cancellation, version changes,
resize and renderer retirement cannot publish stale results. Store physical
radiance independently of camera mode and display gamut, with precision and
exposure domains agreed with camera C2. A response change must not require
recomputing the physical field. Display history may need invalidation even
when a radiance cache stays valid.

**Verify.** Compare baked and live rays at several directions and observer
positions within 1%. Prove stale/canceled bakes cannot publish. Measure cold
bake, warm cache, peak memory and steady sampling cost against the reference
budgets. Record outward and return crossings of the 0.15 pc proposed boundary as
a cast, including a jump or remount during a bake. Measure moving and settled
Earth-orbit views with the sky visible at 1080p and the recorded Retina
operating point. A Natural daylight-skip result cannot close this gate.

**PR.** `codex/galaxy-the-cached-sky` → `codex/galaxy`. Include lifecycle
regressions, the crossing cast and measured budgets. A blend cannot conceal a
CPU/GPU or bake/live disagreement.

### M8. The star shell follows the observer on the GPU

**Milestone.** Translation stops rewriting every star position on the CPU.

**Implement.** Upload cell-relative star positions and cell offsets when the
selection changes. Project onto the shell in the vertex stage from an observer
uniform. Preserve star identity, existing visibility and correct velocity data.
Retain the current population and sprite ceiling for a comparable measurement.

**Verify.** Compare CPU reference and GPU projected directions across observer
translations and anchor changes. Check rebasing, paused motion and real star
velocity. Measure upload counts and `Render/starfield` during the same warp
scenario as the perf reference, whose 0.62–0.79 ms is the comparison baseline.

**PR.** `codex/galaxy-the-gpu-star-shell` → `codex/galaxy`. Include projection
checks, a sky capture and before/after measurements at equal star counts.

### M9. Magnitude levels and the population version

**Milestone.** The sky reaches beyond local cells without unbounded generation.

**Implement.** Activate the calibrated density field for the population, with an
explicit generation-version change. Introduce disjoint luminosity bands on cells
seeded by `(level, cell)` and the catalog-derived magnitude completeness rule.
Select by observable brightness with a measured ceiling up to 200,000 sprites.
Remove those resolved sources from diffuse emission so their light is counted
once. Keep travel queries independent of sky selection.

**Verify.** Sample ten thousand cells for completeness violations, duplicates,
order independence and stable identities. Verify band ownership, bounded work at
local/regional/galactic scales and conservation across the resolved/diffuse
split. Compare expected counts around Sol with the agreed local tolerance.
Measure memory and frame cost at the proposed ceiling; lower it explicitly if it
fails. Record manifest and save-compatibility consequences.

**PR.** `codex/galaxy-the-magnitude-population` → `codex/galaxy`. Include
properties, version changes and performance evidence. This is the one activation
step for the calibrated population, not an unrecorded density replacement.

### M10. Extinction on resolved stars

**Milestone.** Stars behind a dark lane dim and redden with the surrounding sky.

**Implement.** Integrate the shared dust between the observer and each resolved
star, bounded by the star's actual distance. Apply per-channel extinction to its
flux. Start with the proposed sixteen samples and measure error against the CPU
reference before choosing a final sampling or caching strategy.

**Verify.** Stars in front of a cloud remain unaffected by dust behind them;
background stars follow the expected attenuation. Test transparent rays and
strong columns on CPU and GPU, and inspect the Aquila Rift with the expanded
population. Recheck the resolved/diffuse split and measure the added cost at the
selected sprite ceiling.

**PR.** `codex/galaxy-the-obscured-stars` → `codex/galaxy`. Include foreground
and background cases, sky plates and the measured extinction budget.

### M11. Temporal volume and integration acceptance

**Milestone.** The assembled Earth-to-galaxy journey is ready for the Galaxy PR.

**Implement.** Add quarter-resolution temporal reprojection to the measured live
volume. Own history validity across camera cuts, disocclusion, field versions,
exposure changes, resolution changes and renderer retirement. Tune sample
spacing and cache transitions from measurements. Add the small-angular-size
fallback only if the measured operating points need it.

**Verify.** Run the full repository gate at the rebased integration tip and
repeat CPU/GPU agreement and calibration. Pass camera C5 with Enhanced,
Automatic and Manual at the same operating points. Record outward and return travel
through local, regional and galactic scales with no visible representation
switch, ghost trails or blank frames. Capture face-on, edge-on and Earth-orbit
views with Enhanced’s diffuse sky visible. Measure live volume against **2 ms at 1080p**, cached sampling against
**0.05 ms**, memory, cold boot and the complete sensor/atmosphere/galaxy frame.
State GPU, backend, dimensions and DPR for every result. Document a deliberate
budget revision or a tested quality fallback if a target cannot be met; an
unmeasured target remains open.

**PR.** `codex/galaxy-the-continuous-journey` → `codex/galaxy`, followed by the
final update to **Galaxy** → `main`. The integration description carries the
cast, plates, calibration results, performance table, shipped quality levels and
remaining follow-ups. Verify the cumulative tip after the last child merge.

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

A **published** figure carries its source. A **measurement** is from
`design/plans/perf.md`'s rig, an Apple M5 at 1600×900 DPR 1. A **budget** is a
claim a milestone measures. The following reference retains the proposed model,
literature attributions and budgets. Source verification and calibration are
implementation gates in M2 and M6; these values are not new measurements. The
milestone sequence above governs which parts enter the integration PR. H II
regions, clusters and neighboring galaxies remain follow-ups.

The frame is already right, which is the fact this plan stands on. The universe
origin is the galactic center; `heliocentricToUniverse` puts the Sun at (−8,178
pc, +20.8 pc, 0) in simulation axes; galactic longitude zero is +X from the Sun
and the north galactic pole is +Y; rotation is clockwise seen from that pole.
Nothing here needs a new frame. Every catalog star is already in this one, which
is what lets the band and Sirius agree by construction rather than by alignment.

---

### Shared model and generation

**One field, every consumer.** `packages/universe/src/galaxy/` holds a pure,
seeded, versioned field over galactocentric parsecs; number density per stellar
population, dust density, H II emission; and three consumers read it: the sky
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
clusters use a catalog in a follow-up session. The Local Bubble also requires a
published geometry.

**Brightness is integration.** The field emits in physical units, calibrated
against the integrated starlight the sky actually has, so the band's visibility
depends on the sensor response and exposure. A shutter value alone cannot
establish photographic visibility without aperture and ISO. M6 verifies raw
radiance and fixed photographic exposure; camera C5 compares Enhanced,
Automatic and Manual without feeding their appearance back into calibration.

**Continuity is a cache, not a cross-fade.** The sky from inside is the same
march as the view from outside, cached at the observer's position while the
observer is within a parallax budget and evaluated live otherwise; the pattern
`Starfield.tsx` already uses for its shell. There is no second representation to
fade to. One field at two costs.

---

### Stellar populations, dust and calibration

The field lives in `packages/universe/src/galaxy/`. The existing
`stellarDensity` delegates to the calibrated field when M9 activates it for
population generation. Coordinates are galactocentric parsecs in simulation
axes; `R` is the in-plane radius, `z` the height, `β` the azimuth from the Sun's
direction, increasing with rotation.

**Stars, by population.** Each population carries a density, a mean luminosity
and a color temperature, so emission per unit volume is a product and the
population mix is what colors the picture.

| Population | Density and published parameters                                                                                                               | Color target     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Thin disk  | Double exponential; radial scale 2.6 ± 0.5 kpc, height 300 ± 50 pc; arm modulation. Bland-Hawthorn & Gerhard 2016.                             | 5,000 K          |
| Thick disk | Radial scale 2.0 kpc, height 900 pc; 4% of local thin-disk density and 12% of its column.                                                      | 4,600 K          |
| Young arms | Gaussian arm ridges, height 19 pc; width `336 + 36 (R/kpc − 8.15)` pc; contrast about 3 in young stars and 0.2 in old stars. Reid et al. 2019. | 12,000 K plus Hα |
| Bar/bulge  | Boxy triaxial profile, angle 27° ± 2°, half-length 5.0 kpc, axis ratios 0.5 and 0.26, height 180 pc, mass 1.84 × 10¹⁰ solar masses.            | 4,300 K          |
| Halo       | Spheroidal profile proportional to `(1 + r/r_h)^−3.5`, flattening 0.6; Harris globular distribution.                                           | 4,800 K          |

Normalized so that `stellarDensity(SUN_POSITION)` is exactly `LOCAL_DENSITY`,
0.1 star/pc³, which keeps `generateCell`'s expected counts around Sol where they
are at the baseline; the Local arm's width is 310 pc, so its modulation across
the 100 ly survey cube is under 0.1%. Total integrated count lands between 10¹¹
and 4 × 10¹¹, the published range, and a test says so.

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

**H II regions.** Along the young-arm ridges only, within 40 pc of the plane,
Poisson-disc clumps seeded from the arm coordinate, each a small Gaussian
emitter at Hα's 656 nm and a shell of OB light. They are the pink knots along
the arms in every photograph of a spiral, they are the primary arm tracer in the
literature (Anderson et al. 2014, over 8,000 of them), and they are the first
thing in the game that emits a narrowband line; which is what the sensor's
filter seam is waiting for.

**Globular clusters.** Not modeled: **cataloged**. Harris 2010 lists 157 with
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

**Versioning.** The field is a generation algorithm and changes to it are
versioned through `algorithm()` and `manifest()` like every other one
([ADR-0005](../../docs/adr/0005-procedural-seeds.md)). One consequence is worth
stating plainly: `proceduralCount` reads `stellarDensity`, so any change to the
field moves which procedural systems exist beyond the survey cube and what their
ids are. M9 checks save and address references before activating that change.
[ADR-0032](../../docs/adr/0032-the-stellar-field.md) records M2's CPU reference, its calibrated tangencies, and the explicit preview assumptions. Each field revision carries an algorithm version. M2 through M6 build and calibrate the field without changing
the active population generator. M9 activates the calibrated field for
population generation and records that version change. Later recalibration is
another versioned change.

---

### Cached sky

The observer is inside the disk, 20.8 pc off a plane whose dust is 81 pc thick,
and a low-latitude ray runs 25 kpc while everything that matters to its picture
happens in the first few hundred parsecs. So the integrator is not a uniform
march.

**The march.** The initial proposal uses 256 log-spaced samples per texel
direction from **10 pc to 30 kpc**. Skip the near interval only where the
observer's local field supports it. Concentrate samples near clouds and widen
them where only the smooth disk remains. Accumulate emission front to back with
extinction `T ← T·exp(−κ dt)`; the smooth exponential terms integrated
analytically per ray where the noise is off, which is most of the way out. The
stars the sprite layer resolves are masked out of the emission; the haze is the
light of stars fainter than the resolved limit, which is how GAMBONS builds its
integrated starlight map; so a star is never drawn twice.

**Where it goes.** A cubemap, six faces of **1024² RGBA half-float, 50 MB**, on
a fine-pointer machine; 512² and 12.6 MB on a coarse one; the same query
`output.ts` already asks to pick a DPR ceiling. At 1024 a texel is 0.088°, a
pixel at the flight lens over 1080 lines is 0.06°, and the dust is diffuse at
that scale; the 2048² alternative is 200 MB and SpaceEngine ships it as an
option for exactly this reason. Drawn as the background; before the star shell,
no depth write, the same custom blend as the star field so alpha never reaches
the canvas; through the sensor's exposure like everything else.

**When.** Six faces at 1024² and 256 samples is 1.6 × 10⁹ field evaluations
(initial budgets: **120 ms** on the M5 and **500 ms** on the target laptop). M7
measures the tile count and dispatch duration together; neither follows from the
evaluation count alone. Register the bake with `render/warmup.ts` so the
progress total includes it. A progressive 128² pass targets a **2 ms** first
sky, with refinement over the following second. The bake goes in the IndexedDB
cache keyed on the field's version, quality and observer region, with the actual
baked origin recorded and checked against the parallax budget on every reuse,
because it is regenerable content and
[ADR-0007](../../docs/adr/0007-persistence.md) says that is what a cache is for.

**How long it is valid.** The nearest dust is about 100 pc away, so moving one
parsec swings it 0.6°, and a texel is 0.088°: the proposed budget is **0.15
pc**, thirty thousand astronomical units. M7 validates that budget against the
observer and actual nearest structure; a jump rebakes at arrival, behind the
tunnel; a planetarium fly-to that leaves the budget uses the live march until a
valid bake is ready. This is the `WrittenShell` pattern; a record of what was
baked and the budget it holds under; and `Starfield.tsx` shows the shape.

**Precision.** The kernel takes the observer in galactocentric parsecs as
float32. At 8 kpc that resolves 5 × 10⁻⁴ pc, a hundred astronomical units, and
the finest feature in the field is the 1 pc noise octave; two thousand times
larger. The terrain kernel's split-frame rule
([ADR-0023](../../docs/adr/0023-the-gpu-producer.md)) exists because a crater is
3 × 10⁻⁷ rad against a float32 direction's 6 × 10⁻⁸; nothing here is within
three orders of that ratio, and importing the machinery would be a comment
nobody could justify. The number is written here so the next reader can check it
rather than reach for it.

**The GPU kernel** `render/galaxyKernel.ts` is a TSL port of the field, and
`galaxyKernel.gpu.test.ts` holds it to the CPU at a few hundred sample points
and holds one full ray's integral to the CPU march within 1%. The calibration
tests run on both.

---

### Resolved population

The survey draws every star in a 100 ly cube. The sky needs more than that in
two ways: the bright far stars that make constellations, and the faint haze that
is not stars at all. The haze is described in the cached-sky reference. This
section is the middle.

**The naked-eye sky is a catalog, not a model.** Betelgeuse is 550 ly out, Rigel
860, Deneb 2,600: many recognizable constellation stars are beyond the 150 ly
bundle; each distant source is absent from the current local survey. The ingest
has a second asset, `stars-sky.irsc`: every HYG row with V ≤ 6.5 beyond 150 ly;
measured at 7,515 systems and **188 KB brotli** — the shipped record carries the
id, the name and the spectral string at 25.6 B per system, not the 16-byte
record the 60 KB estimate assumed. They are catalog stars in every sense,
resolvable by id and by name, at their published positions; what distinguishes
them is that they are indexed for identity and search and not by cell, so the
travel survey and the procedural fill are unchanged by them (`StarCatalog.sky`
has the reasoning). The draw joins them to the survey in
`apps/game/src/engine/starSelection.ts`. The extension to V ≤ 8 is 37,271 HYG
rows, which at the measured record is about 930 KB brotli; whether the cold
download's 4 s budget affords that is a measurement not yet taken.

**The completeness rule, as a magnitude.** The initial proposal estimates V 7.5
inside 150 ly and V 6.5 beyond it. M1 measures the catalog distribution and M9
establishes a defensible coverage rule; the histogram peak alone is insufficient
evidence of completeness. A procedural star exists only if its apparent
magnitude is fainter than that limit at its distance, and the limit rides on
`CellContext` as `completeRadius` does; two numbers, pure in the catalog
version. `population.test.ts` draws ten thousand cells and asserts no procedural
star violates it. M9 replaces the sphere, and it is what makes the horizon of
knowledge the irregular, class-dependent surface
[galaxy](../../docs/design/galaxy.md#completeness-is-the-real-constraint) says
it has to be.

**Levels.** Gaia Sky's magnitude-space octree is the construction: each level
holds a disjoint band of absolute magnitude, brighter bands at coarser cells.
Level 0 uses the existing 20 ly cells; level `k` uses cells of `20 · 2^k` ly.
Each luminosity interval belongs to exactly one level, including level 0.
Increasing brightness thresholds alone are insufficient because overlapping
bands draw duplicate populations. Seed by `(level, cell)` so independent
selections are order-free; a level is swept to the radius at which its band
drops below the resolved limit. The count is bounded by the sky: to apparent V 8
there are about 40,000 stars in the whole sky, to V 10 about 350,000. The
proposed sprite ceiling is **200,000**, compared with the current 20,000. M8 and
M9 measure whether that ceiling is affordable.

**The shell moves to the GPU.** `Render/starfield` is the perf plan's largest
span, 0.62–0.79 ms under warp, because the sprite positions are rewritten on the
CPU whenever the origin leaves a parallax budget that binds on the system's own
sun. With positions uploaded once per survey as cell-relative float32 plus a
per-cell offset, the vertex stage projects each star onto the shell from an
origin uniform, and a translation rewrites nothing; only a re-survey or a change
of anchor frame uploads. That closes the perf plan's item 3 as a side effect of
needing ten times the stars, and it is measured the same way.

**Extinction on the resolved stars.** A star behind the Aquila Rift is reddened
and dimmed by the dust in front of it; the sprite's color and flux carry
`exp(−τ)` per channel, integrated along the line from the observer through the
same dust field, sixteen samples in the vertex stage. Without it the band's dark
lanes would have bright stars sitting in front of them, which is the giveaway in
every additive star field ever drawn.

---

### Live volume

The planetarium's ceiling is 100 ly, an absolute cap so that "zoom out until the
neighboring stars appear" works at a moon as well as at a star. It rises to 100
kly through the three tiers [galaxy](../../docs/design/galaxy.md#scale-tiers)
names. These are initial regimes near Sol, with `d` measured from the Sun. Cache
validity elsewhere is relative to the actual baked observer, and volume sampling
depends on the observer's position within the disk, not just `d`:

| Regime   | `d`             | The sky                                      | The stars                                                                               |
| -------- | --------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Local    | under 0.15 pc   | the bake                                     | catalog and population sprites                                                          |
| Regional | 0.15 pc – 1 kpc | the live march, camera-centered, quarter res | the same sprites, the near field masked from the march                                  |
| Galactic | over 1 kpc      | the live march over the disk's bounding slab | unresolved stellar emission with bounded resolved stars; optional tracers in follow-ups |

**The live march** is the same kernel as the bake with different sampling: a
ray–slab intersection with the disk's bounding box, 96 uniform steps between the
two hits with a blue-noise start offset, at **quarter resolution with temporal
reprojection**; one of four pixels per 2×2 block per frame, the _Horizon Zero
Dawn_ cloud construction, which is about 2 ms there for a far more expensive
integrand (budget: **2 ms** at 1080p). The observer and the ray are in
galactocentric parsecs; the result composites through the depth buffer so a body
in front of the galaxy occludes it. Regime boundaries are not switches: the
march's sample density and resolution scale with `d`, and the bake and live
march integrate the same rays at the same observer position.
`galaxyKernel.gpu.test.ts` asserts that identity at three directions rather than
trusting the argument.

**What the picture is.** Face-on, the bar at 27° with the arms wrapping off its
ends, the young-arm ridges blue with pink H II knots, the dust lanes inside the
ridges, the bulge warm, the halo's globulars scattered to 40 kpc; edge-on, a
thin bright plane with the dust lane cutting it, the boxy bulge, the warp
lifting the rim past 20 kpc. Every one of those features is a published number
in the stellar-population reference, and the outside view is the check on all of
them at once; the reason to build it is that a galaxy that looks wrong from
outside is a field that is wrong from inside.

**Brightness from outside.** Equivalent unobscured views have distance-invariant
surface brightness, but the internal sky and face-on disk integrate different
columns. Their calibration checks are separate. The sensor exposes the actual
view, while the galaxy instrument may state a fixed exposure and bound its
sprite count. Those are declared instrument settings.

**Culling** is trivial and named so it is not forgotten: below about 50 px of
subtended size the march is replaced by a sprite of its own last frame, which is
also how the two Clouds and M31 draw at any distance.

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

- All unmeasured times, memory sizes, sprite limits and download estimates in
  the reference are budgets. M1, M3, M7 through M11 replace them with results.
- The bulge brightness attributed to Leinert et al. 1998 needs a readable source.
  M6 uses supported sky measurements and records the missing evidence.
- Hou & Han's arm fits use their own azimuth origin. Verify the source convention
  before transcribing coefficients; tangency tests do not establish that
  convention on their own.
- The completeness limit must come from the ingest's measured coverage, with
  its assumptions recorded. A histogram peak alone does not prove completeness.
- Local density and sky luminosity constrain the population mix together. A
  mismatch is a model finding and must not disappear into a relaxed tolerance.
- The proposed local sampling and outside uniform-step march must converge to
  the same integral. Validate step spacing and cloudy rays before accepting the
  quoted sample counts. The proposed bake tile durations and total time must
  agree in the measured schedule.
- Named local clouds can make the nearest dust distance differ from the nominal
  100 pc used for the 0.15 pc cache budget. Derive validity from the actual field
  and screen-space error, then test observer positions beyond Sol.
- A central surface brightness is not the same observable as an arbitrary
  sightline from inside the disk. Distance-invariance alone cannot equate them.
  M6 keeps the viewing geometry, bandpass and calibration source explicit.
- The 100 kly camera ceiling covers the target journey, but neighboring galaxies
  require a separate coordinate-range check. M31 is outside the current
  coordinate system's roughly 249,000 ly span.

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
M3 adds the galaxy GPU suite; M7 adds bake/live identity tests. Those suites
remain planned. Use the existing headless session constructor and browser
driver instead of a second runner.

Put scratch plates, traces and recordings in `.scratch/`, publish review media
through the existing media workflow when opening its PR, and link the durable
results in the ledger. A source change records measurements and decisions in
`CONTEXT.md` through `context-log`; accepted architecture belongs in an ADR.
Plans remain here in `design/plans/` and are not published implementation docs.
