# The galaxy and the sensor: Earth to the whole Milky Way

Build a continuous journey from Earth orbit to 30 kpc above the galactic plane,
using one versioned model for the sky, resolved stars and the view of the whole
disk. This is the single implementation plan for the galaxy and the sensor work
it needs. Each milestone is one session's target: **Milestone → Implement →
Verify → PR**. The outside view arrives early, before local-sky caching and
population refinement.

The working base includes the sensor response and the terrain/optics lifetime
branch, assuming its review completes and it merges to `main`. The
implementation record is [ADR-0031](../../docs/adr/0031-the-sensor-response.md).
This plan does not claim that branch has merged or that any milestone below is
implemented.

## What already works

| Area              | Implemented baseline                                                                                                                                                                  | Remaining work for this plan                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Coordinates       | Galactocentric coordinates, the Sun's measured position, catalog astrometry and stable addresses.                                                                                     | Use the same frame throughout the volume, star field and camera journey.                             |
| Local stars       | 7,123 catalog systems within 150 ly; deterministic stars in 20 ly cells; a 100 ly survey cube; up to 20,000 sprites.                                                                  | Distant bright stars, magnitude completeness, larger-scale population selection and dust extinction. |
| Galaxy            | A simple double-exponential stellar density.                                                                                                                                          | Arms, bar, halo, dust, diffuse emission and a visible disk.                                          |
| Sensor            | Lens exposure, pre-exposure, histogram metering and clamps, glare halo, defocus, motion, noise, vignetting, lateral color, SDR dither, white balance, response presets and P3 output. | Measure the faint galaxy through those responses and the complete frame cost.                        |
| Resource lifetime | The reviewed branch gives heightfields fallback ownership, orbital bakes body-identity validity, live canvas-gamut negotiation and optical-pass warm/disposal ownership.              | Apply those contracts to volume targets, cached skies and their retirement.                          |

Natural retains the production ACES fit, integrated star visibility, and
analytic Sun glow and streak. Direct uses the lens exposure; the other Composite
presets use physical stellar flux and a hue-preserving response. A calibrated
diffuse galaxy must pass through the actual chain. Do not assume Natural's star
treatment already makes the band visible, or rebuild the implemented sensor
phases.

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
5. Keep the integration PR's checklist current as milestones land. M11 is the
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

All rows start **planned**. Fill the evidence columns as work completes.

| Milestone | Session result                                                     | Depends on        | PR / verified commit / evidence |
| --------- | ------------------------------------------------------------------ | ----------------- | ------------------------------- |
| M1        | The distant bright sky is cataloged and drawn.                     | Reviewed baseline | Planned                         |
| M2        | The stellar field has a measurable shape from outside.             | M1                | Planned                         |
| M3        | The planetarium renders the whole stellar disk.                    | M2                | Planned                         |
| M4        | The camera travels from Earth to the disk through the sensor.      | M3                | Planned                         |
| M5        | Shared dust transport dims and reddens the volume.                 | M4                | Planned                         |
| M6        | Local clouds and photometric checks constrain the sky.             | M5                | Planned                         |
| M7        | A progressive cached sky replaces the local live march.            | M6                | Planned                         |
| M8        | Observer motion projects the star shell on the GPU.                | M7                | Planned                         |
| M9        | Magnitude levels extend the population within a bounded draw.      | M8                | Planned                         |
| M10       | Resolved stars receive the same dust extinction.                   | M9                | Planned                         |
| M11       | Temporal rendering and the full journey pass the integration gate. | M10               | Planned                         |

### M1. The distant bright sky

**Milestone.** Orion's brightest stars appear at their catalog directions from
Earth. This is the first session and the first implementation PR.

**Implement.** Extend `apps/ingest` with `stars-sky.irsc`, starting with HYG
sources of apparent V ≤ 6.5 beyond 150 ly. Load and resolve those identities
alongside the local catalog. Add a sky selection path that reaches them without
expanding the travel survey. Deduplicate the two selections by identity and
measure the magnitude distribution for the later completeness rule. Keep the
current sprite ceiling; use a stable brightness selection if the union exceeds
it. Rebuild assets through the ingest, with the existing attribution contract.

**Verify.** Assert Orion's seven brightest catalog directions and capture them
from Earth orbit. Check duplicate IDs, catalog resolution, and unchanged survey
counts inside 150 ly. Measure the actual asset bytes and cold-load impact
against the 4 s download budget; the reference's 60 KB estimate is not a result.

**PR.** `codex/galaxy-the-bright-sky` → `codex/galaxy`. Include the catalog
report, sky capture and download measurement. No dust or new population levels.

### M2. The stellar field and CPU reference

**Milestone.** CPU plates show the bar, arms, disk and halo from outside.

**Implement.** Introduce the pure, seeded, versioned field in
`packages/universe/src/galaxy/`: stellar populations, arm geometry, bar/bulge,
thick disk, halo and warp. Add a CPU emission integrator and headless face-on,
edge-on and observer-centered plates through `openSession`/`pnpm sim`. Expose
sample values and the field version for inspection. Keep the existing active
population generator until calibration is complete and M9 activates the field.

**Verify.** Hold the Sun's density to `LOCAL_DENSITY`, arm tangencies within 3°,
finite nonnegative samples, order independence and total stellar count in the
reference range. Compare plates at fixed seeds and expose the integral and
normalization numbers. The observer-centered plate is emission-only at this
milestone, so it cannot pass a dust-calibrated sky test yet.

**PR.** `codex/galaxy-the-stellar-field` → `codex/galaxy`. Include plates and
field checks. Record the field version separately from the active generation
version so the preview cannot silently regenerate existing systems.

### M3. The first live whole-disk view

**Milestone.** The planetarium can display the galaxy face-on and edge-on.

**Implement.** Port M2's field and ray integral to one TSL kernel. Draw a
bounded live volume at quarter resolution from fixed galactic viewpoints, using
the existing scene and sensor chain. Add depth composition, warm-up
registration, resize and disposal ownership, and diagnostics. Start with
deterministic full updates of the low-resolution target; temporal history
belongs to M11. Use an explicit instrument exposure for these initial views.

**Verify.** Compare CPU and GPU field samples and complete rays within 1% using
nonzero cases plus absolute tolerances near zero. Capture face-on and edge-on
views, a foreground body's occlusion, and resize/remount behavior. Measure GPU
cost and memory on the stated rig. The 2 ms target is still open, and dust is
visibly absent.

**PR.** `codex/galaxy-the-visible-disk` → `codex/galaxy`. This is the first
whole-galaxy result. Include the two views and a measured cost, with the omitted
dust and temporal work stated explicitly.

### M4. Earth to the galaxy through the sensor

**Milestone.** One camera travels from Earth orbit to 30 kpc above the plane.

**Implement.** Raise the planetarium ceiling from 100 ly toward 100 kly, through
its existing camera and lens producers. Extend the live integrator to interior
observers with distance-appropriate sampling. Route diffuse emission through
pre-exposure and the implemented response modes. Give the galaxy instrument a
stated exposure; measure Direct, Neutral and Natural separately. Expose the
observer frame, exposure and field version in diagnostics. Keep the local survey
bounded as the camera moves; the disk never requests every cell it sees.

**Verify.** Record the complete outward and return journey as a `--cast`. Check
orientation, finite camera/lens values, foreground occlusion and absence of
black frames or camera jumps. Confirm a frozen camera cannot write canonical
world state. Capture identical views through the three responses, including a
bright body beside the faint field. Record exposure limitations here; final
photometric acceptance waits for M6.

**PR.** `codex/galaxy-earth-to-the-disk` → `codex/galaxy`. Include the cast and
response comparison. The game now demonstrates its largest scale before sky
caching, population expansion or temporal optimization.

### M5. Dust transport

**Milestone.** The same dust field shapes the view from inside and outside.

**Implement.** Add the smooth dust disk, seeded small-scale structure, arm-lane
offsets and wavelength-dependent extinction to the CPU field and TSL kernel.
Integrate emission and transmittance front to back. Keep the field and CPU/GPU
versions explicit. Named local clouds belong to M6.

**Verify.** Properties cover zero-dust identity, bounded transmittance,
increasing attenuation with column depth, and seed/order independence. Hold GPU
rays to the CPU and test numerical convergence with increased sample counts.
Capture a dusty edge-on disk and an interior band at the same field version.
Measure the extra frame cost.

**PR.** `codex/galaxy-light-through-dust` → `codex/galaxy`. Include matched
inside/outside plates, transport checks and cost. Resolved-star extinction
remains M10; note that temporary mismatch in the integration checklist.

### M6. The local sky and calibration

**Milestone.** Earth sees a sky whose orientation, dust landmarks and brightness
can be checked.

**Implement.** Add the Local Bubble and the named local clouds from the
reference, with source records for their positions, extents and columns. Fit
emission and population constants against the supported photometric checks.
Verify source conventions before transcribing arm fits or adopting a numerical
target. Record how Natural displays the calibrated diffuse sky; any declared
processing follows ADR-0031 and gets an explicit decision if its behavior
changes.

**Verify.** Check the galactic center and pole, the Aquila Rift's direction, CPU
and GPU sky brightness within 0.3 mag of supported targets, total luminosity,
and local population normalization together. Freeman's central brightness is a
model comparison until its applicability is established; an unread source is an
open gate, not permission to tune toward it. Repeat M4's exposure plates with
dust. Update constants and their version together.

**PR.** `codex/galaxy-the-calibrated-sky` → `codex/galaxy`. Include source
provenance, calibration residuals and a reference comparison. If evidence
requires revising a target, document the reason rather than widening tolerance.

### M7. A cached sky with an owned lifetime

**Milestone.** Flight inside a system samples a cached version of the live sky.

**Implement.** Bake the same kernel progressively into a cubemap, beginning at
128² and measuring 512²/1024² tiers. Tile dispatches, register boot progress,
and cache by field version and observer location. A written record owns the
observer/parallax validity budget and resources. Moving beyond that budget uses
the live volume until a valid bake is ready; cancellation, version changes,
resize and renderer retirement cannot publish stale results.

**Verify.** Compare baked and live rays at several directions and observer
positions within 1%. Prove stale/canceled bakes cannot publish. Measure cold
bake, warm cache, peak memory and steady sampling cost against the reference
budgets. Record outward and return crossings of the 0.15 pc proposed boundary as
a cast, including a jump or remount during a bake.

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
repeat CPU/GPU agreement and calibration. Record outward and return travel
through local, regional and galactic scales with no visible representation
switch, ghost trails or blank frames. Capture face-on, edge-on and Earth-orbit
views. Measure live volume against **2 ms at 1080p**, cached sampling against
**0.05 ms**, memory, cold boot and the complete sensor/atmosphere/galaxy frame.
State GPU, backend, dimensions and DPR for every result. Document a deliberate
budget revision or a tested quality fallback if a target cannot be met; an
unmeasured target remains open.

**PR.** `codex/galaxy-the-continuous-journey` → `codex/galaxy`, followed by the
final update to **Galaxy** → `main`. The integration description carries the
cast, plates, calibration results, performance table, shipped quality levels and
remaining follow-ups. Verify the cumulative tip after the last child merge.

## Follow-up sessions after the integration

These retain the open galaxy and sensor work without making the first complete
journey depend on it. Each row is a separate Milestone → Implement → Verify → PR
cycle; split a row further if its measured work exceeds one session.

| Milestone            | Implement                                                                                       | Verify                                                                                                   | PR and dependency                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| H II knots           | Seed arm-bound emission clumps and OB light from the shared field; carry line emission as data. | Determinism, arm/height placement, CPU/GPU emission agreement, luminosity budget and outside-view plate. | Galaxy follow-up after M11; enables spectral filters.                 |
| Globular clusters    | Ingest a cited cluster catalog and render measured positions, magnitudes and half-light radii.  | Catalog round trip, identity, Omega Centauri and 47 Tucanae positions, halo plate and draw budget.       | Independent galaxy follow-up after M11.                               |
| Iris sampling        | Use each glass record's blades and rotation in the existing defocus pass.                       | Blur shape for each glass and the half-pixel circle-of-confusion gate.                                   | Sensor follow-up; no galaxy dependency.                               |
| FFT kernel           | Bake a diffraction kernel from the iris and expose its energy and orientation diagnostics.      | Energy conservation, spike symmetry, aperture scaling and kernel rebuild cost.                           | Sensor follow-up after iris sampling.                                 |
| FFT convolution      | Convolve the bright-source image at the selected quality tier and own its warm/disposal paths.  | Whole-chain energy, captures, bypass behavior and the proposed 1.5 ms budget at 1080p.                   | Dependent PR on the FFT kernel.                                       |
| Spectral attachment  | Carry Hα/OIII/SII through a spectral emission attachment with explicit units.                   | CPU/GPU line values and broadband output equivalence with the attachment disabled.                       | Dependent on H II emission.                                           |
| Narrowband response  | Map the line channels through a declared filter and instrument readout.                         | Filter channels, exposure, P3/sRGB output and a nebular-knot comparison.                                 | Dependent on the spectral attachment.                                 |
| Photo export         | Export a held frame with the selected output encoding and recorded camera settings.             | Dimensions, color declaration, paused-frame repeatability and chrome-free output.                        | Sensor follow-up; uses the implemented camera controls.               |
| Tether controls      | Define and implement the photo control workflow through existing lens and camera producers.     | Control/readout agreement and a complete held-shot interaction.                                          | Separate photo PR; settle its UI scope before implementation.         |
| Display headroom     | Recheck the browser capability and implement discovery only if a measured signal exists.        | Explicit peak cap, unsupported-browser behavior and real canvas/encoder agreement.                       | Optional sensor follow-up; the authored cap remains supported.        |
| Neighboring galaxies | Add one parameter record at a time for the LMC, SMC and M31, including representation limits.   | Direction, angular size, brightness, coordinate range and culling.                                       | One PR per neighbor; M31 needs a far-field addressing decision first. |
| Horizon of knowledge | Derive the galaxy map's coverage surface from the catalog completeness record.                  | Per-class coverage and observed/projected labeling.                                                      | Separate map interaction plan and PR.                                 |
| Zodiacal light       | Specify the solar-system dust field and integrate it at AU scale.                               | A separate calibration and sampling plan.                                                                | Separate emitter plan; reuses the sensor contract.                    |

## Sensor contract and remaining specifications

The implemented chain and its deliberate departures from the proposal live in
[ADR-0029](../../docs/adr/0029-the-sensor-spine.md) and
[ADR-0031](../../docs/adr/0031-the-sensor-response.md). Those records govern
exposure, pre-exposure, the CPU reduction after asynchronous histogram readback,
packed velocity/reciprocal depth, Natural's production response, and owned
optical resources. The phase lists from the sensor proposal are not outstanding
implementation work.

For the galaxy, diffuse radiance stays in stated physical units until the sensor
response. The bake may store nW m⁻² sr⁻¹ to preserve half-float precision, but
the scene conversion must state its spectral assumptions before producing cd/m².
A global exposure has to preserve the faint sky when it is the subject and avoid
claiming it remains physically visible beside a sunlit hull. Natural's declared
integration and the map's stated fixed gain are distinct contracts. M4 and M6
measure both rather than inferring behavior from a formula.

The full performance matrix remains open. Record the scene/resolve/output,
histogram/readback, glare, defocus, motion, detector/output, atmosphere, star
field, live volume and cached-sky costs at the same operating points. The sensor
proposal assigns 0.15 ms to spine/resolve/blit, 0.05 ms to metering, 0.40 ms to
the halo, 0.80 ms to active defocus, 0.60 ms to active motion and 0.20 ms to
detector/output at 1080p on the target laptop. These are budgets, not measured
headroom for adding a 2 ms galaxy pass. Measure overlapping GPU work through the
actual chain instead of adding incompatible span timings.

The FFT follow-ups retain the proposed 512² quarter-resolution kernel, rebuilt
on aperture or focal-length changes, with a **1 ms rebuild budget** and **1.5 ms
per-frame convolution budget**. Its source is the iris polygon and its energy
comes from the image. Natural's analytic solar glow and streak remain until a
measured replacement preserves their intended response. Internal reflection
ghosts and occluder-anchored corona are separate effects.

Spectral filters require actual line emission before a channel mapping exists.
Hα, OIII and SII map to declared channels and the readout states the processing.
No authored mood LUT, extra effect-strength slider, or second producer of the
lens enters the chain. Noise and exposure adaptation follow simulation time;
paused pinned frames remain repeatable.

Temporal reprojection in M11 belongs to the diffuse volume. It does not turn on
whole-scene temporal anti-aliasing or place the star shell in that history. The
star-shell changes, subpixel sources and discontinuous selections require
separate evidence before a whole-scene history can be justified.

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
establish visibility without aperture and ISO. M4 and M6 verify Direct at stated
lens settings and each Composite response separately.

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
`arms.test.ts` asserts each within 3°. Beyond 20 kpc the disk warps: `z = a (R −
R_w)^b sin(φ − φ_w)`, line of nodes 17.5° from the Sun–center line (Chen et al.
2019), which is what makes the outside view's rim lift the way the real one
does.

**Dust.** An exponential disk with two vertical components; scale heights **81
and 152 pc**, scale length 2.26 kpc (the 2025 two-component fit; Drimmel &
Spergel's single 134 pc disk is the alternative); normalized to about 1 V
magnitude of extinction per kiloparsec in the plane, with the arm lanes offset
inward of the stellar ridges, and a log-normal multiplicative noise term of four
octaves down to about 1 pc (the GAMER recipe, Groeneboom & Dahle 2014).
Reddening is `τ ∝ λ⁻¹`, three coefficients, so the band goes brown behind the
rift and the bulge reads warm through its foreground. On top of the field, a
table of **local clouds** as ellipsoids with published centers, extents and
column densities, from the Lallement 2022 and Edenhofer 2023 maps: the Aquila
Rift at 225–500 pc, the Cygnus Rift, Ophiuchus at 130, Taurus at 140, Perseus,
Orion, Chamaeleon, Lupus, the Coalsack at 180. And the **Local Bubble**: the Sun
sits inside a cavity about 165 pc across with almost no dust (Zucker et al.
2022), which is why the first ten parsecs of every ray can be skipped and why
the nearest dust anything sees is a hundred parsecs off.

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

**Calibration.** Fit the field against the following proposed checks. M6
verifies each source, bandpass and viewing geometry before accepting its target:

| Check                                                   | Published                                                           | Tolerance |
| ------------------------------------------------------- | ------------------------------------------------------------------- | --------- |
| Integrated starlight from the Sun, mid-latitude average | 75 nW m⁻² sr⁻¹ ≈ **23.2 mag/arcsec²** (Masana et al. 2021, GAMBONS) | 0.3 mag   |
| On the plane at l = 45°, a rift sightline               | 22.3–23.4 mag/arcsec² (Masana, Table 3)                             | in range  |
| The galaxy's total absolute magnitude                   | **M_V = −21.37**, B−V 0.73 (Licquia & Newman 2015)                  | 0.3 mag   |
| Face-on central surface brightness from outside         | 21.65 B mag/arcsec² (Freeman's law)                                 | 0.3 mag   |

The unit is the sensor's: luminance in cd/m², and 22 mag/arcsec² is 2 × 10⁻⁴
cd/m², thirteen orders below the Sun's disk. The sensor's pre-exposure carries
the portion of that range visible in the current frame. The bake stores nW m⁻² sr⁻¹, values from 10 to
10⁴, because the same numbers in W m⁻² sr⁻¹ sit at 10⁻⁸ and below half-float's
normal range.

**Versioning.** The field is a generation algorithm and changes to it are
versioned through `algorithm()` and `manifest()` like every other one
([ADR-0005](../../docs/adr/0005-procedural-seeds.md)). One consequence is worth
stating plainly: `proceduralCount` reads `stellarDensity`, so any change to the
field moves which procedural systems exist beyond the survey cube and what their
ids are. M9 checks save and address references before activating that change.
Each field revision carries an algorithm version. M2 through M6 build and calibrate the field without changing
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
gains a second asset, `stars-sky.irsc`: every HYG row with V ≤ 6.5 beyond 150
ly; about 9,000 stars, **60 KB brotli** at the 16-byte record; at their
published positions, loaded and indexed by cell like the rest. They are catalog
stars in every sense, resolvable by id, and the only thing that distinguishes
them is that the travel survey never reaches them. M1 also adds a distant-sky
selection path to the draw. Loading the asset alone cannot make Orion visible
because the travel survey never reaches those cells. The extension to V ≤ 8,
about 40,000 stars and 250 KB, is a measurement of the cold download against its
4 s budget, not a decision made here.

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

M2 adds `pnpm sim --sky --out sky.png` and explicit external-view options. M3
adds the galaxy GPU suite; M7 adds bake/live identity tests. These are milestone
deliverables, not commands available at the planning baseline. Use the existing
headless session constructor and browser driver instead of a second runner.

Put scratch plates, traces and recordings in `.scratch/`, publish review media
through the existing media workflow when opening its PR, and link the durable
results in the ledger. A source change records measurements and decisions in
`CONTEXT.md` through `context-log`; accepted architecture belongs in an ADR.
Plans remain here in `design/plans/` and are not published implementation docs.
