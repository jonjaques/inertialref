# The weather, phase 1 (the volume and its light): engineering design

**Draft 4.** The plan is `design/plans/the-weather.md`, and this design covers
its §10 row 1 as the road to the MVP re-slices it (§0).

**The rubric is `design/plans/weather/mvp.md`,** settled on 2026-11-10 by its
council of three. It is what the finished work is scored against, and where
this design and the rubric disagree, the rubric holds. This design cites it
by its own numbers: its sections as "rubric §n", its continuity checks C1 to
C11, its budget bars B1 to B15, and the rows 1 to 21 of its acceptance table.
§11.2 lists every place this design still departs from it, and what it asks
the rubric's council to amend.

**The tree.** Phase 0 is landed, measured and documented on `weather/phase-0`
(`51c96da4`): ADR-0063 to ADR-0066 under `docs/adr/`, and the evidence under
`design/plans/weather/phase0/measurements/`. "Landed" beside a figure here
means its second campaign, at `bbea04da`
(`landed-2026-11-10T09-05-32Z.md` there). Wave 0 of this phase, packages K and
V, is built and merged as `weather/p1-cornerstones`. Three is 0.185.1. A line
number cited here is the campaign commits' (`8a01d311`, `25df44ab`) unless its
section says the landed tree was read, and a package reads the line again at
its own base.

**This document stands alone.** It is committed as
`design/plans/weather/phase1/design.md`. The working files it was written
from are not in the tree: the orchestrator's ledger and rulings, the two
critiques of draft 1, and the rubric council's reviews. What a package needs
of them is restated here, in the record below, the critique log, §11.5 and
**What draft 3 and draft 4 changed** at the end.

I read the rubric, the plan, the as-built map, the neighbors map, the transport
research and the phase 0 package reports in full, phase 0's design by section,
and its landed campaign's tables. Every interface this design leans on was
re-read in the code or surveyed read-only for it; §11.4 lists which is which.
Nothing was built, run, tested or measured for this design: another agent
holds the machine. A figure this design wants and could not compute by hand is
marked **to measure**.

Draft 2 answered two adversarial reviews, of the physics and of the
engineering, and the orchestrator's rulings on draft 1. A "ruling n" cited
here is the nth of those seven, restated in §11.1. Each finding was checked
against the code, the plan or a computation; the **critique log** at the end
lists every finding, its verdict and what changed. Draft 3 resolved
the sections that waited on phase 0's choices. Draft 4 brings the design into
line with the settled rubric, the thin form's decision, phase 0's landed
figures and what its review left for this phase.

Borrowed facts keep the research file's tags: **R** read at its source, **S**
read in a snippet or an abstract, **M** recalled and not checked, **D** derived
by arithmetic shown where it is used, **E** an estimate of cost, and **W** a
source a critic fetched for its review, quoted there with its URL. No digit
tagged **M** is verified, and the package that uses one transcribes it from its
source first.

This document binds the packages of §10. An interface a package needs is in §4
or in the contracts package. If it is in neither, the package asks the
orchestrator and does not invent it.

---

## What phase 0 decided, and what each section assumes

Phase 0's two campaigns decided four choices and its ladders by the rules its
design fixed (§8.7 there). ADR-0063 and ADR-0064 record them, and the figures
are in `design/plans/weather/phase0/measurements/`.

| Choice              | Decided                                                                                                             | What settled it                                                                                                                                                                                                                                                                                               | Sections that assume it                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Placement           | **A, `passes`:** two scene passes over a layer split                                                                | B is cheaper on the GPU nowhere (Retina steady, split against passes: 6.79 / 6.88, 7.98 / 8.00 and 5.66 / 5.66 ms). **A stands as an exception:** by §8.7 as written the CPU clause fires at Retina `inside`, and ADR-0063 argues it with figures (§4.12, §7.4)                                               | §4.7, §4.9, §4.12, §10.4                  |
| Far field           | **The atlas**                                                                                                       | Its worst footprint error over the four handover cases at 400 m is 1.643 against the spheres' 2.087, and neither exception clause fires. The gap is one case, at 1,600 m the spheres lead in all four, and the landed 800 m was not scored: the choice is provisional until it is (§5.9)                      | §4.5, §5.8, §5.9, §10.4                   |
| Cache × sun's depth | **`(field, grid)`:** the march reads the field, and the sun's depth is the grid, whose bake sums through the volume | The volume fails `horizon` at both sizes (6.26% to 6.88% against 3%). Neither sun depth passes at two taps, and the grid is the more accurate (worst case 0.192 against 0.492)                                                                                                                                | §2.5, §4.3, §4.5, §4.7, §5.3, §5.5, §10.4 |
| Ladders             | `maxSteps` 192. `lightTaps` 4, not shown converged. `farFootprint` 800 m                                            | 192 against 256 steps is 0.02%. Two against four taps is 1.04% and four has no larger neighbor measured. 800 against 1,600 m is 0.01%, where 400 against 800 is 7.18% at Retina. Each ladder was taken with the cascades, two taps and 400 m: the landed set has no ladder of its own until window 1's (§7.3) | §4.6, §5.4, §5.8, §7.3                    |
| Thin form           | **Allowed from orbit only.** Phase 1 draws the identity everywhere, the second body included                        | The landed `error` batch: from orbit 0.1% at the 95th percentile and 0.4% to 1.8% at worst; `sunset` 27% to 32% and 100%; `fog` 4.2% to 4.9%; `horizon-2.4km` 3.2% to 3.7%                                                                                                                                    | §4.10, §7.2                               |

**Where phase 0 lands** (steady, in ms; the frame of a cut and of a scrub is
the clouds' Δ on that frame):

| Stance                  | 1080p Δ | Of it: trace | Over pass | Bakes | Retina Δ | 1080p: a cut's frame | A scrub's |
| ----------------------- | ------- | ------------ | --------- | ----- | -------- | -------------------- | --------- |
| `ground`, under cumulus | 7.12    | 3.72         | 1.70      | 1.62  | 8.91     | 23.50                | 16.27     |
| `horizon`               | 5.67    | 2.45         | 1.52      | 1.61  | 7.70     | 20.61                | 14.88     |
| `inside`                | 5.07    | 1.27         | 2.08      | 1.56  | 7.70     | 24.60                | 16.95     |
| `decks`                 | 7.55    | 2.90         | 2.19      | 2.25  | 9.79     | 19.04                | 15.31     |
| `orbit`                 | 3.03    | 0.09         | 1.84      | 0.84  | 5.54     | 3.00                 | 3.04      |
| `pair-moon`, two bodies | 9.38    | 4.75         | 1.96      | 2.36  | 10.21    | 35.27                | 29.43     |

- Memory is 91.62 MB at 1080p and 85.01 MB at Retina, 96.41 and 89.80 with a
  second clouded body.
- The first five frames with the clouds on hold one of 50.8 to 66.8 ms at
  1080p, against a steady 16.7.
- With four taps the trace is the largest cost at 1080p. The second scene
  pass is the largest at Retina, 3.88 to 5.32 ms.
- A pass's time is latency and not share (rubric §5), so these columns say
  where to look and no bar is formed from one.
- **The cut's and the scrub's columns are at an unknown field of view.** The
  landed campaign's `cut`, `scrub`, `fly` and `pair-neighbor` rows ran through
  the lens the `pair-moon` stance left behind: its rise framing fits the
  flight lens, and `ir.visit` sets none. The clouds-off base on `ground` reads
  5.87 ms steady and 6.92 to 7.29 in those rows. They are being retaken on
  phase 0's branch. The steady rows above were taken before `pair-moon` and
  stand, and the grid's share of a reset does not depend on the view. In
  phase 1 every stance sets its own lens (§7.2).

What the campaigns and phase 0's review found, and where each is answered:

| Finding                                                                                                                              | Answered in | Package |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------- |
| The second scene pass costs 1.5 to 2.2 ms at 1080p and 3.9 to 5.3 ms at Retina                                                       | §4.12       | Y       |
| The grid's rebuild is the reset frame: a cut's frame is 14.9 ms over the steady Δ on `horizon` and a scrub's 9.2                     | §4.7        | L       |
| The grid is rebuilt whole every frame the sun moves over 0.05°, so sustained warp is a permanent reset, and no warp row was recorded | §4.7, §7.2  | L, Q    |
| A profile's figures follow the presentation rate, and no campaign can hold 60 Hz on demand                                           | §7.5        | Q       |
| The landed defaults have no ladder; `LIGHT_TAP_COUNTS` and the `images` batch's stances are hard-coded                               | §7.3        | Q       |
| The three accuracy instruments assert only that their figures are finite                                                             | §6.3        | C       |
| The atlas is unscored at the landed 800 m                                                                                            | §5.9        | X       |
| A second clouded body always composites through the thin form, in a regime never measured                                            | §4.10       | N       |
| The placeholder's drift is derived from the observer, so moving the eye at a held time changes the density at a fixed point          | §5.3        | D, F, H |
| The sun gate that chose the grid is a figure about the inner 4 km, and at four taps the grid is within 3% in four cases of ten       | §5.5        | L, M1   |
| The first frames with the clouds on are a hitch, not shown to be a compile                                                           | §4.7        | L, N    |
| The boot's `warming the clouds` span came back empty in all six boots                                                                | §4.7        | N       |

Phase 0's council read the landed code as well, and §11.5 gives each of its
findings a package and a test. Two faults it found are fixed on phase 0's own
branch and are not designed around here: the cloud pass's handling of an
exception, and the runner's handling of a refused row.

The order of work (§10.3) starts from wave 0's merge.

---

## 0. The road to the MVP

The MVP is the plan's phases 0–3: Earth from low orbit with its shadow and its
light, and a generated wet world from orbit to the ground (rubric §1). Three
phases of work remain after phase 0. This section slices them, on two pages,
and gives phases 2 and 3 a page each.

### 0.1 Three slicings

|                                   | **P: the plan's order** (plan §10)                                                                                                            | **W: the working position**                                                                                                      | **A: the shadow, then Earth, then the light under a deck**                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Phase 1                           | References, density, march, phase tables, higher orders, irradiance table, history, composite, far field, reflection probe, WebGL's far march | P without the probe and without WebGL; the ISCCP-H ingest and its CPU statistics as a parallel package; the `velocity` fix first | As W                                                                                                                      |
| Phase 2                           | `cloudSunlight` in the ground, sea, sphere, hull and flare; the energy balance under a deck; both halves of the shadowed air                  | P's phase 2, plus the reflection probe and the sea's far reflection                                                              | `cloudSunlight` everywhere and the air's single-scattered half; Earth's climatology wired; the deck retired; E1–E3 judged |
| Phase 3                           | ISCCP-H, the overlap rule, the diurnal clock, orography; the deck retires                                                                     | Wiring, orography, the deck's retirement, plates                                                                                 | The energy balance, the air's Ψ half, the probe; G2 and G3 judged                                                         |
| A judged Earth-from-orbit picture | End of phase 3                                                                                                                                | End of phase 3 as stated; **end of phase 2 with the one addition §0.2 makes**                                                    | End of phase 2                                                                                                            |

### 0.2 The slicing this design takes: W, with Earth judged from phase 2

W holds up under test, and one addition gives it A's only advantage.

**(a) The ISCCP-H ingest starts in phase 1 with no drawn consumer. Adopted.**

- It is CPU work in `apps/ingest` and `packages/rendering`, and the GPU is the
  scarce resource on this machine: one job at a time, and a campaign needs the
  machine whole. A package that never takes the lock runs beside everything.
- It retires the two risks phase 3 would otherwise meet late: `h5wasm`, a new
  dependency (`rg -c h5wasm pnpm-lock.yaml` finds nothing), and a manifest whose
  license line must not claim CC0 (`design/plans/weather/isccp-h-research.md:222-240`).
- It has two consumers inside phase 1 that draw nothing. The genus
  calibration holds each genus to ISCCP's own per-type mean optical depth where
  the artifact carries one (§5.2), and the zonal law a generated world's
  climate uses is fitted to Earth's own zonal means (§5.3).
- It forces the climate's seam to be designed now. Earth's measured climate is
  a second implementation of the interface the generated world's analytic
  climate implements first (§4.2), so phase 3 is wiring by construction.
- **What phase 1 commits of it is small:** the zonal means and each type's
  mean depth, which are all its two readers need. The gridded climatology's
  form and home are phase 3's design, made with its reader (§4.1). The ingest
  still reads all 120 files in phase 1, so the reader, the fill and the
  manifest are proven now.
- Its cost is one more package in an already large phase. Nothing phase 1
  draws reads it, but one row of the rubric does: row 9 holds each genus's
  mean `τ` within 15% of ISCCP-H's for its type. So the small table is due
  before package G, and only the gridded climatology's own work may slip.

**(b) The reflection probe moves to phase 2. Adopted.**

- Its only consumer is the reflected term in `render/water.ts:552-560`, and the
  picture that judges it, G2, also needs the energy balance under a deck, which
  is phase 2's.
- Without it phase 1 edits no surface material. Rule 59's test for the phase is
  then one sentence: the ground, the sea and the sphere are not touched.
- The plan's reason for placing it in phase 1 was that it needs the composite
  chosen (phase 0 design §1.4). Phase 0 settles that either way.

**(c) The `velocity` fix lands on the weather stack, in phase 1's first wave.
Adopted, beside the cornerstones and not ahead of them.**

- The composite cannot ship under a temporal picture before FSR reads the
  masked `motion.rg` (phase 0 design §12.2 item 2). Nothing on `main` is
  scheduled to deliver that: no pull request is open for it.
- The stack merges forward and is never rebased, so a fix that lands on `main`
  first reaches the stack only by a back-merge. Landing it on the stack removes
  that wait. It is written as one self-contained series (five files and three
  lines of `cloudComposite.ts`), so the same commits cherry-pick onto a branch
  for `main` if Jon asks for that, and the later merge of `the-weather` meets
  identical changes. Nothing is opened against `main` unasked (ruling 7).
- Jon's instruction makes the cornerstones the first package. The two own
  disjoint files, run in the same wave, and are the phase's first pull request
  together (§10.5).

**The addition: the picture panel scores E1 and E2 in the forced arm at the
end of phase 2.** The rubric takes it as one recorded round that banks
nothing (§2 there), because the plate moves when the climate draws it; the
two confirming rounds are of the climate plates, at the verdict. A is the one
alternative that reaches a judged Earth-from-orbit picture a phase sooner, and
it pays three prices for it:

- it couples two unrelated risks in one phase, the rule-59 shadow across four
  materials and the climatology with the deck's retirement;
- it retires Earth's deck while the air's Ψ half is missing, so E2's "shadows
  they lay on the air" is judged with the shafts washed out (plan §6.3) and is
  judged again a phase later;
- it leaves Earth's ground under an overcast lit by a clear sky's skylight for
  a whole phase after the deck is gone.

E1 and E2 are regional pictures. They need the transport, the far field, the
shadow and the shadowed air, and they do not need the climatology: a
fair-weather field over a continent and layered tops along a limb are what a
held weather regime draws (§3.3). Every phase takes them with the volume forced
onto Earth already. So at the end of phase 2 the panel scores the forced arm of
E1 and E2 against their photographs and against the deck arm, once, for the
record. E3, the deck's retirement and every Earth picture's confirmation wait
for phase 3, and no frame on the default path loses Earth's clouds on the
way.

**The two rules hold.** Each phase lands green on its own (§0.4, §0.5 and §2
give each phase's gate). No frame takes Earth's clouds away before the volume
draws them with their shadow and light: until phase 3 Earth is outside the set
of bodies the volume serves by default (§4.8), and the forced arm is a capture
arm, never a default.

### 0.3 Departures from the plan, and the reason for each

| Plan                                                                                       | This road                                                                                                            | Reason                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §11 decision 3, and phase 1's "WebGL's far march alone"                                    | No WebGL path for the weather in any phase                                                                           | Jon: "we're ditching webgl altogether"                                                                                                                                                                                                                                                                               |
| Phase 1 holds the reflection probe                                                         | Phase 2                                                                                                              | §0.2 (b)                                                                                                                                                                                                                                                                                                             |
| Phase 3 holds the ISCCP-H ingest                                                           | The ingest and its CPU statistics are a phase 1 package; the wiring stays in phase 3                                 | §0.2 (a)                                                                                                                                                                                                                                                                                                             |
| The upscaler's fix lands on `main` (`the-upscaler.md:40-45`)                               | It lands on the stack, in phase 1's first wave                                                                       | §0.2 (c)                                                                                                                                                                                                                                                                                                             |
| Plates exist when a phase is done                                                          | The cornerstone presets, their capture path and the settle land before anything they judge                           | Jon: "fix this by adding a few test presets ahead of tine as cornerstones"                                                                                                                                                                                                                                           |
| "A generated world takes the volume before Earth does" reads as on by default from phase 1 | The served set and its plumbing land in phase 1; **the default turns on with phase 2's integration**                 | A cloud field with no shadow on the ground is the regression a guard verdict exists to block (rubric §3.8). Every wet generated world's committed plate would move in phase 1, be judged against its clear plate with clouds that cast nothing, and move again in phase 2. One move, with the shadow, is one verdict |
| Earth is not drawn by the volume before phase 3                                            | Every phase takes E1–E3 with the volume forced onto Earth, beside the deck, and records it                           | Jon: "defer earth is ok but keep testing progress, record it"                                                                                                                                                                                                                                                        |
| Neyret's three-phase advection carries the texture (plan §4.5)                             | In phases 1–3 each layer turns rigidly about the spin axis; bounded advection arrives with the wind field in phase 4 | The drift phase 0 draws starts over every hour and counts as a jump (`cloudFrame.ts:467-472`), which is a visible step once an hour on a default path. A rigid turn is exact on a sphere, continuous for ever and costs no fetch (§5.3)                                                                              |
| The primary bow is a phase 1 number (plan §10, rubric §6)                                  | The cloudbow is. Rain's table lands with rain in phase 4                                                             | The primary bow is a raindrop's, and rain is outside the MVP (rubric §8). §5.4 settles the generator now                                                                                                                                                                                                             |
| Octaves or a slab table, "a measured choice", with both built (plan §5.3)                  | The slab's source function is built. Octaves are fitted in Node and built on the GPU only if the fit passes          | Under the plan's own bound an octave series reaches about 0.12 of the incident flux where a deck returns 0.3 (§5.5), so its GPU path would be built to lose                                                                                                                                                          |
| Ice is Baum's table (plan §5.3)                                                            | The same, committed in reduced form with "no license stated" in its header                                           | The distribution states none; Jon has the data and said to commit it (ruling 5)                                                                                                                                                                                                                                      |
| One pull request a phase                                                                   | Two, stacked: the cornerstones and the `velocity` fix, then the rest as a draft from the contracts' merge            | CI runs on pull requests alone (§10.5)                                                                                                                                                                                                                                                                               |
| The slab reference is Prahl's `ad` (plan §10)                                              | An adding-doubling oracle in TypeScript, held to `ad`, to PythonicDISORT and to a seeded Monte Carlo                 | `ad` takes only `g`, solves only the azimuthal mean and reports the truncated problem (research §1.1, **R**)                                                                                                                                                                                                         |

### 0.4 Phase 2 on one page: the shadow and the light

**Contains.**

- `cloudSunlight(point)`, one function of a body-fixed point for the ground, the
  sea, the sphere, the hull's key light, the flare and the air's march. Near the
  eye it reads the sun's optical depth; past that cache it reads the far
  field's column statistics displaced along the sun by each layer's height.
  The deck's own sphere shadow (`render/planet.ts:452-464`) gives way to it for
  a served body. It has two forms, for the reason §5.1 gives: the irradiance
  on a surface, the ground's, the sea's, the sphere's, the hull's and the
  air's, takes the scaled transmittance `T′`; the sun's disk, which the flare
  draws, takes `T′^(1/(1 − f_δ))`.
- Both halves of the shadowed air: `marchAir` (`render/air.ts:343-367`) and
  `airMediumAt` (`:941-1006`) take the same two taps, held equal by the test at
  `cloudLight.gpu.test.ts:452`.
- The energy balance under a deck: the beam through the shadow, the clear
  sky's share from the sky table, the deck's diffuse transmission by
  delta-Eddington, and the ground's return `1/(1 − A·R_base)`. The two-stream
  form scales by `g²`, about 0.74, where the renderer's beam scales by `f_δ`,
  about 0.49, so the diffuse part is the two-stream total less the renderer's
  own beam, never less the two-stream's: summed the other way the ground
  loses 0.195 of the incident flux at `τ = 5` overhead (the physics critique's
  finding 28, **D** there). Its oracle is the Monte Carlo column, phase 1's
  slab generator with the air and a ground added.
- The air's two skylight defects closed (`design/plans/the-air.md:180-186`,
  `:301-306`) by reading the sky table per fragment.
- The reflection probe and the sea's far reflection.
- The default turns on for every body in the served set, **and the flag
  retires.** The system exists today only under `?clouds=1`: the chunk, the
  factory and the warm-up's registration hang on it (`App.tsx:116-123,
:280-281`; `apps/game/src/pages/paths.ts:353-360`). Retiring it puts the
  chunk on every WebGPU boot, adds the warm-up's span to the boot and the
  declared bytes to every session with a served body in it. Phase 1's `memory`
  batch records that span and those bytes (§7.2), so phase 2 starts from a
  figure. Every committed plate of a wet generated world is re-taken and takes
  its guard verdict.
- Instruments: the shadow-offset measure for E1 and the share of cloud pixels
  at display white (rubric §3.9, advisory), and the tests of the rubric's rows
  12 to 15. The panel's tools and its calibration round are phase 1's (§8.6),
  so phase 2's first judged round starts from a fixed bar.
- Pictures: G1, G2, G3 and G4 judged, two confirming rounds each; E1 and E2
  in the forced arm take one recorded round; the overlay guard and every
  moved guard take their verdicts (rubric §3.8). Closing the air's two
  skylight defects moves every scene with a sky on purpose, and each of those
  is a guard.

**Needs phase 1 to have left in place.**

| Phase 1 leaves                                                                                                  | Where                                                                                        | Phase 2 uses it for                                                     |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A sun optical depth readable at any eye-relative point inside the cache, not only inside the march              | `CloudSunDepthNodes.opticalDepth` (`render/cloudNodes.ts:110-113`), kept free of march state | The near half of `cloudSunlight`                                        |
| Far column statistics readable from a fragment stage: per layer a fraction, an in-cloud depth, a base and a top | §5.9                                                                                         | The far half of `cloudSunlight`, and the sea's far reflection           |
| The sky table with its hemisphere accessor                                                                      | §4.4, §5.6                                                                                   | The ground's and the sea's skylight; the clear sky's share under a deck |
| The slab oracle's fluxes and the Monte Carlo slab                                                               | §5.11                                                                                        | Delta-Eddington's error before the column adds air and ground           |
| The scaled medium, one extinction for every transmittance                                                       | §5.1                                                                                         | A ground shadow that agrees with the cloud the trace draws              |
| `cloudFront` read by what draws after the composite                                                             | §4.9                                                                                         | Nothing new: the hull and the flare join the same reader                |
| The cornerstones, the capture set, the step detector and the solar-time solver                                  | §3, §8                                                                                       | Every picture and cast it is judged on                                  |
| The served set as one predicate                                                                                 | §4.8                                                                                         | Turning the default on is one line and one set of plates                |
| A `'picture'` reset that restarts the history and rebuilds no cache                                             | §4.7                                                                                         | The reset frame's budget row                                            |

**Lands green when** the rubric's phase 2 rows hold: one cloud shadow at the
descent gate within 0.01 absolute between any two of the three materials (row
12), one air under a cloud's shadow within 1% (row 13), downward light under
a deck within 10% of the column (row 14), the skylight within 1% of the sky
table at eight points (row 15), G4's ring within 0.2° on the plate (row 8),
C10, and every plate `presets:compare --all` moves has its guard's verdict.

### 0.5 Phase 3 on one page: Earth

**Contains.**

- Earth's climate from ISCCP-H's gridded climatology, read by phase 1's
  ingest into an artifact whose form and home that phase's design decides
  (§4.1): nine types to three levels by the overlap rule (plan §4.2), the land and sea contrast in droplet number, and
  the diurnal clock. The clock needs Basic HGH, 2.88 GB a decade
  (`isccp-h-research.md:20-21`), where the monthly product averages it away; the
  phase's design decides between HGH and an analytic clock at the measured
  phases.
- Orography in the maps: elevation and its slope against the wind.
- The statistics, counted on the CPU by the rubric's own protocol (§6.3
  there; row 16): global, land and ocean cover and each 10° band against
  ISCCP-H's 2007–2016 means, over 480 instants of ten simulated years. Each
  type's optical-depth histogram is recorded with no bar.
- The deck retires for Earth: its `SolarClouds` record
  (`packages/universe/src/solar/bodies.ts:574`), its map source
  (`apps/ingest/src/textureSources.ts:139-147`) and the 0.4% floor on the lift
  (`render/bodyUniforms.ts:449-461`), which only Earth's 12 km deck ever
  reached. Venus keeps its deck and the deck's material. Earth joins the served
  set by losing its authored deck (§4.8), and the dossier reads `cloudsServed`
  where it reads `appearance.clouds` (`packages/devtools/src/dossier.ts:1203-1209`).
- Pictures: E1 to E3 taken under Earth's own climate with nothing forced,
  each cornerstone's place and instant re-solved once to where the climate
  holds the pictured weather; two confirming rounds each, E3 against EPIC,
  with its forced ranking against the deck. C5, G6's slow path from E1's
  stance on Earth, is read against its clouds-off control with no panel.
- The verdict commit's full set: every plate, cast, cost and test at one
  commit and one lever hash (rubric §9), then the council's verdict.

**Needs phase 1 to have left in place.**

| Phase 1 leaves                                                                  | Where          | Phase 3 uses it for                                       |
| ------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------- |
| The climate's interface, with a body's layers in its own uniforms               | §4.2           | Earth's measured climate is a second `BodyClimate`        |
| ISCCP-H's ingest, its manifest, its zonal table and its CPU statistics          | §10, package E | The climate's data and the statistics' reference          |
| Map channels a march reads for cover and for kind, and a place for column depth | §4.3           | The measured types' depth scales a level's extinction     |
| The genus calibration against ISCCP's classes                                   | §5.2           | Each type's histogram is the same test on measured cover  |
| E1–E3 as cornerstones with a forced arm and a recorded history of plates        | §3             | The deck arm is taken from the last tree that draws one   |
| The CPU field, a pure function of body, place and time                          | §4.2           | Cover counted over the sphere and over years, with no GPU |

**Lands green when** the rubric's Earth numbers hold, no preset draws a deck on
Earth, and `presets:ledger` shows Earth's plates and nothing else moved.

---

## 1. Phase 1 on one page

### 1.1 What phase 1 is

- Phase 1 turns phase 0's placeholder into a cloud: density from microphysics,
  light held to references, one field from the long lens at 400 km to the
  inside of a cumulus, on a generated wet world and, forced, on Earth.
- **Nothing a player sees by default changes.** The volume draws where a
  picture or a lever asks for it, behind `?clouds=1` as today
  (`apps/game/src/pages/paths.ts:353-360`). `presets:compare --all` reports 0
  moved. The default turns on with phase 2, which also retires the flag (§0.4).
- It lands the instruments the MVP is judged with before the work they judge:
  nine cornerstone presets and the overlay guard, the casts of the rubric's
  continuity checks with their controls, a capture set that shows each beside
  the last phase's plate with its provenance, a settle that waits on the
  clouds, a solver for the sun's place, a step detector whose findings are
  classified, the panel's tools with the calibration round that fixes the pass
  bar, and a 60 Hz presentation held on demand.
- **It is held to the rubric's phase 1 rows:** rows 1 to 11 and 17 to 21 of
  its acceptance table, C1 to C4, C6 to C9 and C11, and the budget's bars as
  far as phase 1's work moves them (§2.1, §2.6).
- It is two stacked pull requests. The cornerstones and the `velocity` fix are
  the first, small and early, with the baseline media. Everything else is the
  second, opened as a draft once the contracts merge so that every later push
  runs CI (§10.5).
- Its measured choices are made by rules fixed in §7.4 before any measurement:
  the higher orders' form, the phase's radius handling, the jitter, the
  handover's band, the history's clip, the over pass's form and the grid's
  caps. The losers are deleted before the second pull request lands, as phase
  0's are.
- It starts from phase 0's decided system: the march reads the field, the
  sun's depth is the grid, the far field is the atlas, and the composite
  draws in a second scene pass.

### 1.2 Decisions this design makes

1. **The medium is the delta-scaled one, and it is defined as a phase
   function.** A droplet's diffraction half is light that goes on, so every
   transmittance is formed from `σ′ = (1 − f_δ)·σ` with `f_δ = 1/Q_ext`, and
   the medium's phase is the Mie phase less its Fraunhofer part. First-order
   light keeps the unscaled source `σ·p` with the exact Mie phase. The slab
   oracle solves that same medium, so the higher orders' table is in the
   march's own coordinate, and it also solves the true one, which is what the
   march is judged against (§5.1, §5.11).
2. **A source narrower than the diffraction blur takes the unscaled
   transmittance.** The sun's disk, a star and the flare behind a cloud are
   dimmed by `T′^(1/(1 − f_δ))`; a surface, the air and a shadow by `T′`
   (§5.1).
3. **A step integrates a source that falls along it.** The march as built
   takes the sun at a step's start, which draws first order 15% to 86% high on
   a slab. Phase 1's step holds the source log-linear between its two ends
   (§5.4).
4. **The trace keeps its four outputs, and no limit is raised.** The phase is
   applied inside the kernel, so per-class light, the sky term and a later
   second beam are registers and fetches, not textures (§4.5).
5. **First-order light takes its phase per sample, from a prefetch.** The
   mean-radius shortcut is the other candidate, and the choice is measured
   (§5.4).
6. **Higher orders are the slab's own source function,** tabulated from the
   oracle by transport depth from each face, with a lobe about the sun for the
   low orders. Octaves are fitted in Node, as the plan asks, and are built on
   the GPU only if that fit passes; the arithmetic says it will not (§5.5).
7. **The sky enters split:** its mean never occluded, which passes the furnace
   exactly, and the difference of its two sides' irradiance weighted by the
   column on each side (§5.6).
8. **The weather is a body's own.** `bodyWeather(record)` derives a body's
   layers, climate and seed from its record, and each served body carries its
   layers in its own uniforms. A held regime replaces the climate where a
   picture or a test asks (§4.2).
9. **The maps bake what a march reads.** Two textures of four survive in the
   cube and the clipmap: cover and kind. That returns 15.8 MB (§4.3).
10. **A layer's texture turns rigidly about the spin axis.** Nothing restarts,
    so the hourly jump goes. Its shape changes slowly, and not at all on the
    equator, which is declared (§5.3).
11. **The handover has no discrete state.** A step is never shorter than an
    even share, in the logarithm of distance, of what is left to the handover;
    that distance is dithered across a band in footprint; and the fine and the
    far march count the columns they cross by one law, fitted to the field
    (§5.8, §5.9).
12. **A moving camera is rejected per pixel, never by regime.** The `'motion'`
    reset goes. The immediate regime is for a discontinuity (§5.10).
13. **A cut restarts the history and rebuilds no cache.** The `'key'` reset
    splits into `'picture'` and `'field'` (§4.7).
14. **Earth is outside the default served set until its deck retires**, by one
    predicate: wet, and no authored deck. A picture forces it, and the deck's
    sphere shadow yields with the deck (§4.8).
15. **The cornerstones are presets in their own list.** Picture format 3 adds
    an optional `weather`. `findPicture` resolves a cornerstone, and the
    planetarium's lists do not show one (§3).
16. **`ir.settled()` waits on the clouds,** and the clouds settle when the
    field is whole by the rubric's definition: the history's eight samples a
    pixel, 32 frames; the sun grid at full weight; and every block of the far
    atlas in view baked (§3.5).
17. **The references live in `apps/ingest` and commit tables.** The cumulus
    reference is a float64 path tracer in Node that checks a WebGPU one, both
    on a fixture built from the noise's CPU twin, which the tree already holds
    to the GPU's bytes (§5.11).
18. **The sun's disk is a convolution at upload, per sun.** The path tracer
    samples the disk with the unconvolved table; the march and the slab
    oracles use the convolved phase with a point sun. Never both (§5.4).
19. **Ice draws Baum's severely roughened aggregate,** reduced to the air's
    three bands and committed with its citation and a manifest line that says
    no license is stated (ruling 5). Rain's table lands with rain (§5.4).
20. **The contracts change a live system by three means:** a mechanical
    propagation the contracts package is given authority for, factories that
    keep construction in each module's own file, and bridges that draw phase
    0's picture until the named package removes them (§4.11).
21. **A second clouded body stays in the composite,** bakes an atlas of its
    own, and carries its own layers (§4.5).
22. **What draws after the composite reads the knots** through a handle the
    engine holds, and builds today's graph byte for byte without one (§4.9).
23. **The losers of this phase's choices are deleted before landing,** by
    phase 0's rule and for its reasons (phase 0 design §1.6).
24. **The sun grid is refreshed, never rebuilt in a frame.** A turning sun is
    no event, because the steady refresh already redraws every slice under it.
    A jump of the field, a new place and a wake from orbit rebuild the grid
    over a dozen frames under a cap, and until it is whole the layers' own
    statistics stand in, faded out by a weight that is continuous in the
    camera and in time (§4.7, §5.5).
25. **The volume is the grid's source and nothing else:** two levels, no
    bound, every slice under the budget. That returns 4.8 MB under B12's
    80 MB, and takes a third of the volume's slices out of every bake (§2.5).
26. **The composite draws in the sensor's chain when nothing draws over the
    clouds,** and the second scene pass runs only on a frame that has an
    overlay, storing its samples once. Placement C is reconsidered, as phase
    0's rule requires, and is not built (§4.12).
27. **The march is held to the oracle on its own scaled medium,** as the
    rubric splits it (rows 1 and 2). The scaled medium's distance from the
    true one is the oracle's own figure, declared at 3% (row 3), and the
    path-traced cumulus is what still judges the march against the true
    medium (row 6; §5.11, §7.4).
28. **The identity draws every cloud, the second body's included.** The thin
    form passes from orbit alone, where it is the same fragment with one term
    zeroed, so it buys no cost and would need a regime boundary on the way
    down. It stays a measurement control for row 20 (§4.10).
29. **A cache is refreshed at the pace its field moves,** not at a fixed
    count a frame: a texel is redrawn before its layer turns a tenth of it.
    From orbit that takes the bakes out of the steady frame (§4.7).
30. **A light tap reuses its step's `cover` and `kind`,** which do not vary
    over a tap's reach: 17 reads a step at four taps where the landed march
    makes 25 (§5.4).
31. **The panel's tools, the noise floor and the calibration round are phase
    1's,** before any plate of this phase's light exists (§8.6).
32. **The zoom cast stands where the handover's band is.** At G4's pose the
    farthest cloud in frame is 34 km off and the band starts at 172 km, so a
    zoom there crosses nothing. It is taken from 400 km at pitch −45°, and
    §11.2 asks the rubric's council to amend C1 (§8.2).
33. **The texture's motion is the body's, and a test holds it from two
    eyes.** Phase 0's drift is built on the observer's tangent basis, so the
    density at a fixed point changes as the eye moves at a held time (§5.3).

---

## 2. Scope

### 2.1 What lands, and when each is done

| #   | Item                              | What lands                                                                                                                                                                                                                                                                                  | Done when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Package             |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1   | **The cornerstones**              | Picture format 3; nine presets; the weather a picture holds applied by `takePicture` and released on leaving it; `ir.settled()` on the clouds; the capture set, its casts and its sheets; the solar solver                                                                                  | A headless test holds each cornerstone's sun to its constraint within 0.5° and G1's and G3's ground above the sea; every cornerstone round-trips `pictureLink`; one capture run takes the seven stills in both arms from two boots, and the two boots agree under the rig's noise floor; one still taken by a cut inside a boot agrees with its fresh boot; the six casts are taken with the clouds on and off; all recorded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | K                   |
| 2   | **The `velocity` fix**            | FSR reads `motion.rg`; the row goes                                                                                                                                                                                                                                                         | `sceneLayout.test.ts` holds a temporal layout with no `velocity` row; the overlay probe of `the-upscaler.md:47-54` reads −0.108 at the bare edge and under the overlay; both temporal presets re-measured at both ratios, recorded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | V                   |
| 3   | **The weather per body**          | `bodyWeather`, layers in each body's uniforms, the `weather` lever, the served set, the frame's derivation                                                                                                                                                                                  | Earth is not served by default and is when forced (Node); two bodies in one frame draw two layer sets (GPU)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | C, H, N             |
| 4   | **The slab references**           | Adding-doubling on the true medium and on the renderer's, with the single-scattering correction; a seeded backward Monte Carlo on the true medium; their generated tables, and the black-surface flux the calibration reads                                                                 | `R + T = 1` to 10⁻⁶ at albedo one; the HG cases at `g` 0.75 and 0.875 equal the committed `iadpython` fixture and van de Hulst's rows within 0.5%; the Mie case equals the PythonicDISORT fixture within 0.5%; 64 and 128 streams differ under 0.5% in the declared domain; every committed Monte Carlo row is within `3·SE + 0.5%` of adding-doubling; the largest relative difference in radiance between the oracle's two solutions over the rubric's domain is in the committed table, and `slabTables.test.ts` recomputes it and holds it to 3% (row 3, declared)                                                                                                                                                                                                                                                                                                                                                                              | R1                  |
| 5   | **The path-traced cumulus**       | A float64 tracer in Node; a WebGPU tracer in the GPU suite; the fixture and its probes                                                                                                                                                                                                      | The furnace holds with zero variance at one sample a pixel on both tiers; of the GPU tier's 288 probe pixels at most three are beyond three combined standard errors of the CPU tier's and none beyond five; the reference curves and the core's and base's medians are written; a Node test fails when the fixture no longer equals `cloudFieldAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | R2                  |
| 6   | **Density from microphysics**     | The genus table, the adiabatic profile, the radius by height, the climate, the CPU field                                                                                                                                                                                                    | Each genus's detected pixels fall in its ISCCP class by §5.2's shares, on 5 km pixels, radiatively averaged, with at least half its cloudy pixels detected, no share moving ten points at `μ₀` 0.4, and each genus's mean `τ` within 15% of ISCCP-H's for its type (row 9, declared); the fair-weather field's exponent is 2.19 ± 0.4 on a 60 km square at 100 m (row 10, advisory); the climate's zonal means match its law; the field at `t` and at `t + 1/60 s` differ by the turn alone to 3.2 × 10⁸ s (row 19); the density at one body point and instant is one value from two eyes (§5.3)                                                                                                                                                                                                                                                                                                                                                    | D, G                |
| 7   | **The field on the GPU**          | Two-texture maps, the per-body profile with its cumulative column, the media                                                                                                                                                                                                                | Each medium equals the CPU field at 1,000 sampled points within one 8-bit step of extinction; a far texel 1,800 km out bakes the climate's cover; the transmittance over one field at footprints of a quarter, a half and a whole cell, mixed by §5.9's law, is within 10% of the resolved field's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | F                   |
| 8   | **The light's tables**            | The phase atlas with its gain, the disk convolution and Baum's ice rows; the sky table; the blue-noise mask                                                                                                                                                                                 | The convolved phase keeps its integral to 10⁻⁴ and reduces to the table as the disk shrinks; the ice rows keep theirs and equal the source at its own angles; the sky table's mean and its two sides' irradiance difference equal a quadrature of the air's own march within 1%; the mask's spectrum test passes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | T1, T2, T3, T4      |
| 9   | **The march's light**             | The scaled medium, the step's source integral, the prefetched phase, taps spaced in optical depth, the higher orders, the split sky, the budget's floor                                                                                                                                     | A slab's radiance within 5% of the oracle's on the renderer's own scaled medium, at every grid and held-out point of the rubric's §6.1, and its reflected flux within 2%, with the shipped sun; the exact sun's run is recorded beside it (rows 1 and 2, declared); the furnace to 10⁻³ on a slab and a broken field (row 4); a uniform slab's transmittance within 10⁻⁴ of its closed form, and a layer's light within 1% of its 192-step value as `maxSteps` runs from 16 (row 5); the first red maximum within one atlas texel of the table's ring, the ring's peak over its trough within 10% of the scaled medium's reference, and the cloudbow's peak between 139.7° and 142.0° (row 8); the phase shortcut within 3% RMS and 0.1° of the per-sample phase (row 7, declared); the range readout within 25% of `3.912/σ′` in a uniform medium at each genus's `σ′` (row 21); the kernel's WGSL binds at most 16 sampled and 4 storage textures | M1, M2              |
| 10  | **The far march's light**         | Mixing by the field's own law, the sky term and the higher orders at the depth the view weighs, the cut and the code on the unscaled depth                                                                                                                                                  | The atlas's score at the landed 800 m is in the record before any of this is built on it; a uniform slab still equals the fine march to 10⁻³; over the real field, in each pitch bin, the footprint-averaged transmittance is within 10% of the fine march's and the radiance within 15% (row 11, declared), by `cloudFarCompare`, whose bounds a test now holds; a deck's higher orders from above are within 5% of the fine march's; the far furnace to 10⁻³ (row 4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | X                   |
| 11  | **The handover**                  | The dithered band                                                                                                                                                                                                                                                                           | `cloudHandover.gpu.test.ts` holds the two marches on the real field, across footprints from `farFootprint` to the band's far edge, by pitch bin, within row 11's 10% and 15%; the zoom cast and the slow descent each cross the band with no error step (C1, C2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | M1, X, N            |
| 12  | **The history**                   | Per-pixel motion, the clip's width, the jitter                                                                                                                                                                                                                                              | The regime stays `converging` through a boundary crossing at 250 m/s (GPU, through the real `cloudFrame`); in the pass at 2 m and in the fast descent the trail measure is under its floor between frames 3 and 32 after the stop, and against a settled still at a quarter, a half and three quarters of the motion (C8); after a cut no frame's RMSE against the settled plate rises and no cell overshoots (C9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | H                   |
| 13  | **World transparency**            | `cloudFront` in the ring, the plumes and the entry trace, through the engine's handle                                                                                                                                                                                                       | A ring behind a cloud is dimmed by the knots' transmittance, and one in front is not (GPU, on the real ring material); without a handle the three materials' WGSL is hash-equal to today's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | W                   |
| 14  | **The instruments**               | The step detector and its trail measure, the glory profiler, the range readout                                                                                                                                                                                                              | The detector flags a synthetic step and passes a synthetic drift (Node); in one run it flags the injected step, which the classification calls an error step, and flags nothing on G5's settled stills where the served opacity is steady; every flagged step of every cast is classified against settled samples and the eye's place at a cloud's boundary, with the frames and the reason in the record (rubric §4); the drawn field's displacement on the 100× cast is within 10% of the CPU turn's (C7)                                                                                                                                                                                                                                                                                                                                                                                                                                         | I                   |
| 15  | **ISCCP-H's ingest**              | The fetch, the manifest, the reader, the CPU statistics, and the small table phase 1 reads: zonal means and each type's mean depth                                                                                                                                                          | The 2007–2016 means are 64.75 ± 0.5% global, with ocean over land by 10 to 17 points (`isccp-h-research.md:408-423`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | E                   |
| 16  | **The runner**                    | Phase 1's batches, its two campaigns, the `noise` step and the casts' stage                                                                                                                                                                                                                 | `--dry-run` plans every batch; `measure.test.mjs` and `campaign.test.mjs` pin them; every row carries its presentation rate and the hash of the levers resolved at its size; a clouds-off row on `horizon` presents at 58 to 62 Hz on demand, three times running (§7.5); the whole frame's 95th percentile is a step of its own; the ladders take their values and stances from the levers' own lists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Q                   |
| 17  | **The choices, measured**         | The phase 1 campaign; the winners as defaults; the losers deleted                                                                                                                                                                                                                           | §7.4's rules applied to the campaign's tables, in the ADRs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | N                   |
| 18  | **The frame, measured**           | The rubric's budget rows that phase 1 can fill, E1's lens among them                                                                                                                                                                                                                        | B1 to B15 each have a row from the landed code at both sizes on the mini, with its rate and lever hash: the steady Δs, the whole frame's 95th percentile on every stance and cornerstone, the four reset sequences, the overlay, memory, the first five frames and the boot's `warming the clouds` span, with a figure in it. A bar this phase's work was to meet and did not is in the record with its figure (§2.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | N                   |
| 19  | **Earth's progress**              | E1–E3 in the forced arm beside the deck                                                                                                                                                                                                                                                     | The record's table carries a row for each, with the plates and what is missing (§3.7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | K, N                |
| 20  | **The sun's depth, refreshed**    | The grid's refresh with no rebuild in a frame; the volume as its source alone, two levels and no bound; the statistics that stand in, and the grid's weight                                                                                                                                 | A sun turning through 0.05° bakes no more slices than the frame before it; after a jump of the field no frame bakes more than the cap, and the grid's weight rises from zero over its ramp (Node, on the schedule; GPU, on a real frame); on `horizon` a cut, a scrub, a change of weather and a wake from orbit each cost no more than 4 ms over the steady Δ on the event's frame and 2 ms on any later one, and the field is whole within 48 frames (B7); a warp of 100× and of 1,000× has a steady row; a steady frame bakes what its field's motion asks and no more; the sun gate's RMS at both of phase 0's suns is no worse than the landed figure by more than 0.01, and is recorded at G3's sun; declared bytes equal the GPU's                                                                                                                                                                                                           | L                   |
| 21  | **The over pass's price**         | The composite as a term of the chain when nothing draws over the clouds; the second scene pass storing its samples once; the count of what is marked over the clouds                                                                                                                        | A frame with nothing over the clouds has no `scene over clouds` pass and equals the same frame through pass B within one half-float step; with an overlay in frame the pixels equal today's and the pass discards its multisampled color after resolving it; no pipeline on the first frame of either form; the steady Δ on `overlay` is at most 1.0 ms over `horizon`'s (B11, declared); §4.12's batch recorded at both sizes, with the placement's cell at one rate                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Y                   |
| 22  | **The panel's tools and its bar** | Under `scripts/panel/`: the packet builder with lettered arms and frozen crops, the shuffler, the three controls and their discard rules, the validator of `review.json`, the artifact vocabulary with regions, the ledger, kept packets; the noise floor by picture; the calibration round | A packet built twice from one seed is byte-equal, and no file in a seat's packet names an arm; the validator refuses a review outside the vocabulary; the ledger computes `B_form`, `B_light` and F from a fixture round by the rubric's rounding, and reads a pass, a void round and a block as §3.5 and §3.6 there say (Node); each baseline still's floor is taken from five pairs of boots with its RMSE at or under 0.005; the calibration round is run with three valid seats and its scores are in the record, before any plate of this phase's light                                                                                                                                                                                                                                                                                                                                                                                        | J, the orchestrator |
| 23  | **The capture's second pass**     | The casts the rubric's checks name and K's six do not hold, with their controls; settled stills at a path's own frames; the frames after a cut; the overlay guard; the record's provenance and roles                                                                                        | Every cast of C1 to C9 is taken with its clouds-off control; the zoom cast and the slow descent each hold frames on both sides of the band (Node, from the path and the lens); the overlay guard's ledger clause holds the station inside the frame; a capture record carries the commit, the stance, the fixtures' hash, the processing mode, the levers' hash at its size and its role, and a record missing one is refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | U                   |
| 24  | **The thin form's row**           | The identity for a second body; the `error` batch on six scenarios; the `composite` lever as a measurement control                                                                                                                                                                          | No regime of the shipped game draws through the thin form (row 20); the batch runs on the landed commit at both sizes with Enhanced off and on, the two `pair` stances among its scenarios                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | N, Q                |
| 25  | **Accuracy that can fail**        | The three instruments' landed figures as bounds                                                                                                                                                                                                                                             | `cloudFarCompare`, `cloudSunAccuracy` and `cloudCompositeError` each fail when a figure passes its landed value by more than a tenth, watched failing with a defect put back; the bounds only tighten from there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | C, then X, L and N  |

**"Fair weather, inside, over the deck and cumulus from orbit taken"** (plan
§10) is item 1's capture run repeated on the landed code. **"The descent
recording with no frame that steps"** is items 11, 14 and 23, read as the
rubric reads a cast: an error step fails, and a flagged step is classified
first. **"§9 met at both sizes"** is item 18 against the rubric's bars.

**Which of the rubric's rows phase 1 closes, and which it only moves.** The
tests of rows 1 to 11 and 17 to 21, and C1 to C4, C6 to C9 and C11, land in
this phase and are green or declared at its end. The pictures are judged
from phase 2 and the verdict is phase 3's, so B1 to B15 gate there: phase 1
records each and says where its work leaves it (§2.6). Rows 12 to 15, C10
and the panel's first judged round are phase 2's. Row 16, C5 and the climate
plates are phase 3's.

### 2.2 What Jon's instructions change

- **No WebGL path.** `sensor.ts:224-231` keeps the idle report for a WebGL
  session and nothing more is built. The plan's §11 decision 3 goes; so do
  "WebGL's far march alone" in §10's row 1, the WebGL clause of §5.4's last
  sentence ("the sphere's cloud material becomes the far march for a body the
  trace does not serve"), and §12's risk about the far march on WebGL. §9.2
  lists the plan's edits.
- **The cornerstones are the first package** (§3, package K), in a pull
  request of their own. It lands what a preset needs to hold weather, the
  settle, the capture path and the scripted casts, and it takes the baseline
  plates and casts on phase 0's landed light before any package changes it.
- **Earth stays out of the default served set until phase 3** (§4.8), and
  every phase takes E1–E3 forced, beside the deck, and records it (§3.7).
- **Every pull request carries comparison media** from one command (§3.6).
- **Baum's ice table is committed** in reduced form, with its citation and a
  manifest line that says no license is stated and quotes its README's date,
  25 July 2013 (ruling 5; §5.4).

### 2.3 What does not land

| Not in phase 1                                                                                                                                        | Why                                                                                                                                           | Where       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `cloudSunlight` in the ground, sea, sphere, hull and flare; the shadowed air; the energy balance; the probe                                           | Rule 59: all surfaces at once, or none                                                                                                        | Phase 2     |
| The volume on by default, and the flag's retirement                                                                                                   | §0.3                                                                                                                                          | Phase 2     |
| The panel's judged rounds                                                                                                                             | The first judged pictures are phase 2's. Phase 1 lands the panel's tools, the noise floor and the calibration round that fixes the bar (§8.6) | Phase 2     |
| ISCCP-H wired into Earth's climate; its gridded artifact; the overlap rule; the diurnal clock; orography; the land and sea contrast in droplet number | They need a land mask and a slope in the maps, and the artifact's form is phase 3's design                                                    | Phase 3     |
| Earth's deck retired                                                                                                                                  | The volume draws no shadow yet                                                                                                                | Phase 3     |
| Rain's phase rows, shafts, lightning, fog's physics and its calibration row, cyclones, bounded advection, the warp fade, the temperature profile      | Storms                                                                                                                                        | Phase 4     |
| A wind that varies over the body, in the texture or in reprojection; a texture whose shape evolves on the equator                                     | Both need bounded advection                                                                                                                   | Phase 4     |
| The moon's beam, cities, airglow                                                                                                                      | The night                                                                                                                                     | Phase 5     |
| The aureole's second-order correction                                                                                                                 | The scaled medium counts the diffraction half once as unscattered and once in first order inside the diffraction cone; §5.1 declares its size | Not planned |
| Any WebGL path                                                                                                                                        | §2.2                                                                                                                                          | Never       |

### 2.4 Constraints held throughout

- **No surface material is edited.** The ground's (`render/terrain.ts`), the
  sea's (`render/water.ts`), the sphere's (`createPlanetMaterial`,
  `render/planet.ts:275`) and the hull's (`render/shipMaterial.ts`) are
  read-only to every package. Three things come near them. A uniform's value:
  the deck's sphere shadow is set to 0 for a body whose deck yields (§4.8),
  which changes no graph. The ring's material, `createRingMaterial`, lives in
  `planet.ts:834`; it is world transparency, and package W edits that function
  alone (§4.9). And `createAirUniforms` (`render/air.ts:255`), which those
  three materials each call, gains a member no existing graph reads; the
  contracts package proves by hash that their WGSL does not move (§10.2).
- **No picture moves without the flag.** `presets:compare --all` reports 0
  moved and `presets:ledger` shows no diff on every package's base and tip.
- **Nothing canonical.** No hash, no save, no `GENERATION_VERSIONS` change, no
  field on `SurfaceParameters` or `SurfaceGrammar`, no write to
  `appearance.clouds`. A body's weather seed is
  `deriveSeed(surface.seed, 'weather')`, never a draw from its `rng`
  (`packages/universe/src/system.ts:1238-1248` says why). A test holds the
  state hash equal with the clouds on and off.
- **The weather is a function of `(body, place, renderTime)`.** Nothing is
  stepped or saved, and no generator or reference calls `Math.random()`: the
  Monte Carlo and the path tracers draw from `xoshiro128**`
  (`packages/procedural/src/rng.ts`) on a stream per path.
- **Float64 decides and float32 draws.** Every turn, drift and origin is
  reduced on the CPU (rule 58); every crossing comes from heights (rule 52).
- **One GPU job at a time** (rule 68), and compile-ahead through
  `render/warmup.ts` (rule 61). Reports never throw or write (rule 65).

### 2.5 The memory this phase declares

Changes against the as-built declaration, computed from dimensions:

| Resource                            | Change                                   | Bytes           |
| ----------------------------------- | ---------------------------------------- | --------------- |
| Weather cube, 1542 × 1028           | Four RGBA8 targets become two            | −12,681,408     |
| Clipmap, 256² × 6                   | Four RGBA8 targets become two            | −3,145,728      |
| Phase atlas                         | 1024 × 32 RGBA16F becomes 1024 × 64      | +262,144        |
| Sky table                           | 102 × 16 RGBA16F, one a body, two bodies | +26,112         |
| Slab source table                   | Up to 32 × 32 × 8 RGBA16F (§5.5)         | +65,536 at most |
| Blue-noise mask, if it wins         | 64 × 64 × 16 R8                          | +65,536         |
| Profile                             | 64 × 8 RGBA8 becomes 64 × 48             | +10,240         |
| **The maps and the light's tables** |                                          | **−15,397,568** |
| Volume, level 0                     | Goes: 256² × 34 RG8                      | −4,456,448      |
| Volume bound                        | Goes, with its kernel                    | −393,216        |
| **Net**                             |                                          | **−20,247,232** |

The grid reads its ray's whole from a second cell and stores nothing more
(§5.5).

**The total.** A megabyte is 10⁶ bytes, as the campaign prints it.

| Size, and bodies              | Phase 0 as landed | Phase 1, as designed | Phase 1 if the volume keeps level 0 and its bound |
| ----------------------------- | ----------------- | -------------------- | ------------------------------------------------- |
| 1920 × 1080, one served body  | 91.62 MB          | **71.37 MB**         | 76.22 MB                                          |
| 1440 × 900 at DPR 2, one body | 85.01 MB          | **64.76 MB**         | 69.61 MB                                          |
| 1920 × 1080, two clouded      | 96.41 MB          | **76.16 MB**         | 81.01 MB                                          |

- **B12 is 80 MB with one served body, declared.** Phase 1 holds it with
  8.6 MB in hand, and with 3.8 MB if the sun gate refuses the volume's cut.
  The mask and the largest slab table are counted; without the mask the
  total is 0.07 MB less. Phase 2's reflection probe is what the room is for.
- A second clouded body adds its own far atlas, 4,792,608 B (the as-built
  map). Its sky table is in the table above. The rubric records the pair's
  bytes with no bar.
- Of the landed 91.62 MB the sun's depth is 14.81: the volume 13,369,344 B,
  its bound 393,216 B and the grid 1,048,576 B (the as-built map; ADR-0064's
  byte table has each resource).

**Why the volume loses a level and its bound.** Under `(field, grid)` the
volume has one reader, the grid's bake, which sums through
`CloudVolume.medium` (`render/cloudSunGrid.ts`, `#bakeNode`). No march reads
it.

- **The bound is read by nothing.** It is the largest value in each brick, for
  a march that skips empty bricks. The grid's bake takes 32 fixed steps.
  Package L confirms it with `rg` at the landing commit before deleting it.
- **Level 0 is finer than the grid can hold.** The grid's cell is 400 m, two of
  level 1's texels (`cloudSunGrid.ts`, `CELL_METERS`), and a bake's step is
  the cell's sun path to the union's top over 32: 310 m or more through a
  10 km union (**D**). Level 0's 50 m texels are read once a cell and once a
  step, a point sample of detail the grid cannot store, where level 1 holds
  the field already averaged to 200 m.
- **Level 0's 34 slices are the ones baked at once after a jump,** outside the
  budget, so that a march never read the field for a frame
  (`render/cloudVolume.ts`, `#schedule`). That march is gone, and they are
  every volume slice a reset frame draws.
- **The sun gate judges the cut.** Phase 0's `sunAccuracy` instrument runs
  again at its two suns, 37.5° and 5°, at four taps. The cut stands if no
  scenario's RMS is worse than the landed figure by more than 0.01 (§7.4). If
  it fails, level 0 returns and the total is 76.22 MB, still inside B12.
- **What the instrument does not reach.** It scores samples within 4 km of an
  eye at 2 m, so the figure that chose the grid is about the inner 4 km, and
  level 0's window is 12.8 km. Package L widens the instrument to the grid's
  whole window, 25.6 km, before it reads the cut, and the landed code's score
  on the wider window is the "before" (§5.5).

### 2.6 The budget, bar by bar

The rubric's bars gate at the verdict, in phase 3. Most of their cost is
spent or saved in this phase, so each has a plan here, and window 3 records
where the phase leaves it (§7.2). A bar is at 1080p unless its row says
otherwise, and "nothing over" is a frame with nothing drawn over the clouds.

| Bar | It asks                                                                                                                | Landed                                       | What phase 1 does                                                                                                    | Package     |
| --- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------- |
| B1  | Steady Δ on `ground`, nothing over: ≤ 5.0 ms (provisional)                                                             | 7.12                                         | The plan by term, below                                                                                              | Y, M1, L, F |
| B2  | On `horizon`: ≤ 4.0 ms (provisional)                                                                                   | 5.67                                         | The same                                                                                                             | The same    |
| B3  | On `inside`: ≤ 4.0 ms (provisional)                                                                                    | 5.07                                         | The same                                                                                                             | The same    |
| B4  | From orbit at a 60° lens, on `orbit` and `earth-orbit`: ≤ 1.6 ms                                                       | 3.03, 3.00                                   | The second scene pass goes, 1.84 of it, and the bakes follow the field's motion, 0.84 of it                          | Y, F, X     |
| B5  | From orbit at E1's lens: recorded                                                                                      | None                                         | The `earth-orbit-long` stance                                                                                        | Q           |
| B6  | The whole frame's 95th percentile under 14.7 ms on every cornerstone and campaign stance, the overlay guard among them | Medians of 6.23 to 13.94                     | B1 to B4's savings. `pair-neighbor` is nearest the bar. The `frame` step reads the percentile, which no campaign has | Q, N        |
| B7  | A reset on `horizon`: the event's frame ≤ 4 ms over the steady Δ, later frames ≤ 2 ms, whole within 48 frames at 60 Hz | A cut's frame 14.9 over, a scrub's 9.2       | §4.7                                                                                                                 | L, X, F     |
| B8  | Retina: no cornerstone's 95th percentile over 33.3 ms                                                                  | Medians of 13.4 to 23.2                      | Recorded. It holds as landed                                                                                         | Q           |
| B9  | Retina against 60 Hz: a stance that holds it without the clouds and not with them is a miss. Declared, the owner's     | Every ground stance                          | Recorded by stance. Levers resolve by size (§4.6), so a cheaper Retina default is one table if the owner asks for it | C, Q        |
| B10 | Retina's steady Δ within 0.5 ms of 1080p's, nothing over. Declared                                                     | 1.8 to 2.6 over                              | `chain` removes the pass that scales with the target. The composite's fragment and the depth copy still do           | Y           |
| B11 | The steady Δ on `overlay` at most 1.0 ms over `horizon`'s. Declared                                                    | None                                         | `lean`: the break without it is 1.0 ms by itself                                                                     | Y           |
| B12 | Memory, one served body: ≤ 80 MB. Declared                                                                             | 91.62 MB                                     | 71.37 MB (§2.5)                                                                                                      | F, L        |
| B13 | The largest of the first five intervals within 16.7 ms of the steady median, at 60 Hz. Declared                        | 50.8 to 66.8 ms against 16.7, at 81 to 89 Hz | The first frame is a reset under §4.7's caps, and what is not a reset moves into the boot's warm-up                  | L, N        |
| B14 | Late frames: the clouds add at most 2 over 3 s, at 60 Hz. Declared                                                     | None at 60 Hz                                | Waits for the hold                                                                                                   | Q           |
| B15 | Pacing: each of B6's frames presents at 58 Hz or more over 3 s, at a held 60 Hz. Declared                              | None at 60 Hz                                | The hold itself (§7.5)                                                                                               | Q           |

**The plan for B1 to B4, by term.** In ms at 1080p. The landed figures are
pass times from the landed campaign's table. The plan's are estimates
(**E**), written so each package knows its share, and none is a bar: a bar is
the A/B Δ.

| Term                        | `ground`   | `horizon`  | `inside`   | `orbit`    | What moves it                                                                                                                                                                           |
| --------------------------- | ---------- | ---------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The composite               | 1.70 → 0.6 | 1.52 → 0.5 | 2.08 → 1.0 | 1.84 → 0.6 | `chain`: the break goes and the fragment stays. The empty split is 1.0 ms of the landed pass (campaign 1)                                                                               |
| The trace                   | 3.72 → 2.6 | 2.45 → 1.8 | 1.27 → 1.2 | 0.09 → 0.1 | The scaled medium doubles a step's length in cloud, and a tap reads three textures where it read five. Against that, the slab source and the grid's second read are a fetch each a step |
| The history, the depth copy | 0.38 → 0.4 | 0.40 → 0.4 | 0.40 → 0.4 | 0.38 → 0.4 | Nothing                                                                                                                                                                                 |
| The bakes                   | 1.62 → 0.4 | 1.61 → 0.4 | 1.56 → 0.4 | 0.84 → 0.1 | Each cache at its field's pace (§4.7), two map targets, the volume's two levels                                                                                                         |
| **Sum**                     | 7.42 → 4.0 | 5.98 → 3.1 | 5.31 → 3.0 | 3.15 → 1.2 |                                                                                                                                                                                         |
| **The bar**                 | 5.0        | 4.0        | 4.0        | 1.6        |                                                                                                                                                                                         |

- **The composite's own fragment has no figure.** The landed pass holds the
  break and the fragment together, and 0.5 to 1.0 ms is that pass less the
  empty split. The `over` batch's first row measures it.
- **The trace is the least sure.** Four things move it and none is measured.
  If it cannot come under its share at four taps, the levers are the taps'
  count, which the ladder may return to two once they are spaced in optical
  depth (§7.3), and their reach.
- **B10 is likely to be missed by a few tenths.** With the pass gone, Retina's
  Δ over 1080p's is the composite's fragment and the depth copy at 2.5 times
  the pixels, less a trace that is cheaper at Retina by 0.3 to 0.6 ms
  (landed). It is declared, and the record carries the figure.
- **A bar still missed at window 3** is in the record with the term that
  holds it. It stays the verdict's gate, and phase 2's design starts from the
  figure.

---

## 3. The cornerstones (packages K and U)

A cornerstone is a preset: an address, a stance, a lens, an instant and its
weather, so it is one command to take and the same picture every time. Package
K lands the nine the rubric requires, and what a preset needs to hold weather
at all.

**K is built** and merged as `weather/p1-cornerstones`, with ADR-0067. §3.1
to §3.7 are its specification, and where it landed otherwise the text says
"as built". The settled rubric asks more of the capture than K was given: the
casts of its continuity checks, settled stills along a path, the frames after
a cut, the overlay guard, a record with provenance and roles, and a noise
floor by picture. Those are package U's (§3.8), which owns K's capture files
from wave 2.

### 3.1 A picture holds its weather

`Picture` (`packages/devtools/src/pictures.ts:66-93`) carries pose, time, lens
and processing. The weather of a body is a function of its record, the place
and the instant, so a picture already holds the climate's weather by holding
its time. What it cannot hold today is the part that is not derivable: that the
volume draws at all while the default is off, and a regime standing in for the
climate.

```ts
/** What a picture adds to its instant: the clouds drawn at it. */
export interface PictureWeather {
  /**
   * The body's own climate, or one named regime held over the whole body:
   * the picture stands where the climate would have this weather.
   */
  readonly regime: 'climate' | ScenarioId
}

export interface Picture {
  // … as today …
  readonly weather?: PictureWeather
}
```

- **Format 3.** Versions 1 and 2 exist: 2 requires `processing`
  (`pictureFormat.ts:164-166`). Version 3 is version 2 with `weather` allowed.
  `decodePictures` accepts 1, 2 and 3 (`:150-158`). `encodePictures` writes 3
  when any picture carries `weather` and 2 otherwise (`:181-191`), so an export
  with no weather stays readable by a build that predates this.
- **`isPicture` validates `weather`** when present and refuses any key inside
  it but `regime`. It passes unknown top-level keys today (`:30-146`), which is
  how a `weather` field would otherwise ride through unchecked.
- **`presetUrl.ts` learns the field.** `flatten` throws `Unknown shot field`
  on any key `FIELD_TYPES` does not list (`presetUrl.ts:74, 84`), and every
  capture goes through `pictureLink` (`scripts/driveUrl.mjs:18, 32`). `FIELD_TYPES`
  gains `weather.regime`; a link carries `shot=3` when the picture has weather
  and `2` otherwise (`:10`, `:132`, `:170-171`).
- **`takePicture` applies it.** After `observatory.setTime`
  (`harness.ts:1247`) it calls a new render-host member,
  `setWeather(weather: PictureWeather | null, address: string)`, beside
  `setCameraProcessing` (`host.ts`; the port has one member a question). The
  engine's implementation is `apps/game/src/engine/pictureWeather.ts`, a small
  file of its own with a one-line delegate in `GameEngine.ts`, and it writes
  the levers:
  - with weather and `cloudsAvailable`: the levers it found, with `on` true,
    the regime as `scenario`, and `served` the picture's address when the body
    is outside the default served set (§4.8), null when it is inside it;
  - with no weather: the levers it found, with `on` false and `served` null,
    in phase 1. Phase 2 changes this one branch to the default set.
  - **It releases what it set.** It keeps the levers it found, and puts them
    back when the picture is left, on the observatory's `clear` or on the next
    picture, as a stance releases the switch it set (rule 7). A picture's
    forced `served` does not outlive the picture.
  - `takePicture`'s result gains `weather: 'drawn' | 'unavailable' | 'none'`.
    `'unavailable'` is a picture with weather on a page without the flag or
    without WebGPU, or one naming a regime the build does not know. The
    capture tool refuses it in the volume arm and wants it in the deck arm.
- **ADR-0033 is amended by ADR-0067,** which lands with this package (§9.1): a
  preset holds its weather. The decoder stays the one decoder for bundled and
  imported pictures (ADR-0033 `:44-45`, `:118-119`).

`regime` names a `ScenarioId` today, and until the contracts package lands a
picture asking for `'climate'` reports `'unavailable'`. That package widens the
lever to `'climate' | ScenarioId` and renames it `weather` (§4.6); K's mapping
in the engine is the one line that changes with it.

### 3.2 The cornerstones are their own list

`PresetsPage.tsx:94` lists every entry of `PICTURES`, "Export all" merges them
(`SavedPictures.tsx:76`), the tour offers them (`tour/brief.ts:307`), and
`presets:check` wants a 480 × 320 plate for each (`scripts/presets/check.mjs:61-92`).
Nine pictures of unfinished clouds do not belong in any of those.

- `packages/devtools/src/cornerstones.json` holds them in the same envelope,
  version 3, decoded by the same `decodePictures`. `pictures.ts` exports
  `CORNERSTONES` beside `PICTURES`.
- `findPicture` (`packages/devtools/src/pictures.ts:99`, which
  `presetUrl.ts:168` and the driver call) searches `PICTURES`, then
  `CORNERSTONES`. A test holds the two id sets disjoint. So `ir.preset(id)`,
  `?preset=` and `drive.mjs --preset` take a cornerstone, and no player-facing
  list shows one.
- `apps/headless/src/cornerstoneLedger.test.ts` snapshots each cornerstone's
  resolved pose, lens and light to `cornerstoneLedger.json`, as
  `pictureLedger.test.ts:152` does for `PICTURES`, and asserts §3.4's sun
  constraints and §3.3's ground. It is what holds a cornerstone's instant
  without a GPU. `pnpm cornerstones:ledger` updates it, as `presets:ledger`
  updates the pictures' (`package.json:54`).
- Every-picture loops over `PICTURES` are unchanged. Their cornerstone
  counterparts are three cases in one new test file: the link round-trip, the
  address resolving, and the lens inside `FOV_MIN..FOV_MAX`
  (`packages/rendering/src/lens.ts:304-305`).

### 3.3 The nine

Angles are degrees here and radians in the file, as `pictures.json` stores
them. A lens is the 24 mm gauge with the focal length that gives the stated
vertical field, `f = 12/tan(fov/2)` (**D**; it reproduces `blue-marble`'s
18.836 mm at 65° and `far-shore`'s 20.785 mm at 60°). Heights are over the
ground beneath (`packages/rendering/src/surfaceStance.ts:35-43`), clamped to
[2 m, 0.5 R] (`:125-137`). Every stance is a surface stance: 400 km is under
the orbit arm's 1.5 R floor (`observer.ts:129`), pitch stops at ±88°
(`surfaceStance.ts:61`), and `compose` refuses a station
(`observatory.ts:1288-1291`).

**The generated world is `g:milky-way/s:P222_3_2_k/b:3`,** P222_3_2_k IV,
under an F0V star of 6,375 K. It is the first body, by cell distance from
far-shore V's cell (`P222_1_0`; Manhattan distance, then the cell's dx, dy
and dz ascending, then the system's index, then the body's), that passes
every clause of this rule:

1. **Wet and plain:** `wetWorld`, an aerosol depth under τ 0.15, a ground
   between 250 and 310 K, a day between 10 and 60 hours, a radius over
   3,000 km, and a `shore` site.
2. **Its sky, as the camera draws it, is blue where the pictures look.** The
   air's radiance along the view ray, times the star's color
   (`starColor(T)`), times the camera's balance (`whiteBalance(5800)`), has
   B ≥ 1.2 R at every elevation from 5° to 29°, under a 60° sun 120° off in
   azimuth (G1) and a 35° sun 135° off (G2). Earth gives 1.31 to 2.47 there;
   1.2 is its weakest less 10% (**D**).
3. **G3 can be lit from below with margin:** the 4,000 m base's horizon dips
   at least 2.0°, half a degree past the −1.5° sun. That is a radius of
   6,570 km or less (**D**).
4. **Its sea stands within 250 m of the datum.** A regime's layers are over
   the datum (`CloudLayerSpec.base`) and a stance's height is over the ground
   beneath, and a photograph's cloud stands over its sea. A quarter of the
   lowest regime's kilometer keeps the two one height.
5. **Its shore faces open sea:** some bearing from S holds standing water at
   the sea's level at every sample from 0.1 to 30 km. The `shore` site is
   scored on the unclamped land nearest the sea's datum
   (`surveySites.ts`), and on a body with a drainage graph the sea stands
   only where it reaches (`groundElevation`), so the site can face a dry flat
   under the sea's level, a lagoon or an islet.
6. **A land stance exists** by the clauses below.

**Why the rule is not the zenith's.** The rule this replaces chose
`P222_1_0_7/b:2` for a blue-dominant noon zenith by
`zenithSkyRadiance`, 0.092 : 0.123 : 0.169 at a 60° sun. That radiance is per
unit of a white sun. The rule never applied the star's light, and
P222_1_0_7's star is 2,346 K: its key light is 1 : 0.34 : 0.05, and 1 : 0.36
: 0.06 at the camera's 5,800 K balance, which the renderer multiplies into
the sky, the sea, the ground and the clouds alike (`scene.ts`,
`bodyUniforms.ts`). The air itself is blue along every ray the pictures hold,
with B/R from 1.2 at the horizon to 2.4 at 29° up under G1's sun, and the
key light takes it to 0.07 to 0.13: every one of the baseline's ground
stills came out orange to brown. Under the luminance meter that light also
clips the foreground in red first, because a metered luminance is 0.46 of
the red channel. Seven in ten of the 614 systems in far-shore's 3 × 3 × 3
block of cells are M dwarfs, which is why a rule blind to the star landed on
one. The sea there also stands 1,313 m under the datum, which put the
overcast's base 1.6 km over the water, G4's eye 1.7 km over its deck and
G5's under its cumulus.

| Body                     | Star         | Key B/R at the balance | Pictured B/R, 5° to 29°, at 60° / 35° | Radius   | Sea vs datum | Open sea from S       | G3 margin | Verdict    |
| ------------------------ | ------------ | ---------------------- | ------------------------------------- | -------- | ------------ | --------------------- | --------- | ---------- |
| `P222_1_0_7/b:2`, cell 0 | 2,346 K      | 0.06                   | 0.08–0.13 / 0.07–0.14                 | 6,102 km | −1,313 m     | yes                   | 0.57°     | fails 2, 4 |
| `P220_1_0_c/b:4`, cell 1 | 5,525 K, G2V | 0.91                   | 1.40–2.25 / 1.32–2.31                 | 4,225 km | −558 m       | 4 of 8 on its best    | 0.99°     | fails 4, 5 |
| `P220_1_2_k/b:2`, cell 2 | 5,540 K, G4V | 0.92                   | 1.93–2.47 / 1.94–2.61                 | 7,061 km | −218 m       | yes                   | 0.43°     | fails 3    |
| `P222_3_2_k/b:3`, cell 2 | 6,375 K, F0V | 1.16                   | 1.63–2.78 / 1.51–2.81                 | 3,922 km | +192 m       | bearings 169° to 203° | 1.09°     | **passes** |

The figures are a CPU march of the shell's own `marchAir` along each ray,
which agrees with `zenithSkyRadiance` at the zenith to 0.3%. The other
bodies that pass clause 1 within two cells orbit M or late-K stars, whose
key light is under 0.7 at the balance and fails clause 2 outright.
`cornerstoneLedger.test.ts` holds the parts of clause 2 the library can say
without marching a ray (the key light at least 0.85 in B/R, and the zenith it
lights at least 1.5 under a 60° sun), and clauses 4 and 5.

- **P222_3_2_k IV:** radius 3,922 km, a day of 30.19 hours, ground 280 K,
  Earth's haze authoring (τ 0.12, an aerosol height of 1,482 m), the sea
  192 m over the datum. Under its star at the balance the key is
  1 : 1.00 : 1.16, and the sky in G1's frame at its own noon is B/R 1.40 at
  2° and 2.70 at 29°; the zenith under a 60° sun is 2.13 (**D**).
- **Its day is 30.19 hours,** so its sun moves 0.05° in 15 s, 0.8 times
  Earth's rate (**D**).
- **The campaign's stances stay on far-shore V** (§7.2), where every phase 0
  figure was taken: a cost depends on the geometry and the weather, not on
  the sky's color, and the rubric fixes a stance to the world its landed
  figure was taken on (§5 there). B6 reads the cornerstones' own frames on
  this world as well.

**Where the ground pictures stand.** `site: 'basin'` on a body with a sea is
the deepest seabed read at the sea's surface
(`packages/universe/src/surveySites.ts:334-345`), open water. So:

- **The shore stance, S,** is the world's `shore` site, 16.7810° S,
  37.3967° E, **facing 186°**: the middle of the widest run of bearings from
  S, 169° to 203°, that hold open sea at every sample to 30 km. The bearing
  the land falls lowest toward, 89°, crosses an islet 2 km out.
- **The land stance, L,** is 16.6514° S, 37.2465° E: the first point 5 to
  50 km from S, within 90° of the bearing away from the sea (269°) and nearest
  it, whose ground is dry and at least 20 m over the sea and stays dry and
  over the sea for 10 km along G1's heading. It is 13.25 km from S at bearing
  312°, 43° off, 20.6 m over the sea (212.7 m over the datum), with the
  nearest standing water 0.5 km off. G1's view crosses land to 10 km and
  reaches open sea at 20 km, a strip at its horizon.
- **G4's and G5's heights are the design's over the datum,** because their
  layers are: G4's eye 3,000 m over the stratocumulus's 1,300 m top is
  4,108 m over S, and G5's at the cumulus's middle, 1,700 m, is 1,487 m
  over L. `cornerstoneLedger.test.ts` holds both, holds G1's rise dry, and
  holds the ground under G1, G3 and G6's last frame above sea level.

| Id                          | Body, stance                                                                              | Lens            | Sun at the stance (§3.4) | Weather                                                | Kind  |
| --------------------------- | ----------------------------------------------------------------------------------------- | --------------- | ------------------------ | ------------------------------------------------------ | ----- |
| `weather-e1-cumulus-orbit`  | Earth; latitude −5, longitude −60, height 400,000, heading 0, pitch −87.995               | 120.2 mm, 11.4° | 50° and falling          | `fair-cumulus`                                         | Still |
| `weather-e2-limb-dusk`      | Earth; latitude 20, longitude −30, height 400,000, heading the sun's azimuth, pitch −19.8 | 120.2 mm, 11.4° | −21° and falling         | `cirrus-over-cumulus`                                  | Still |
| `weather-e3-whole-face`     | Earth; `compose` framing `blue-marble`, `fovDeg` 65, time 0 (`pictures.json:23-42`)       | —               | As held                  | `fair-cumulus`, then `climate` when package N lands it | Still |
| `weather-g1-fair`           | G world; L, height 40, heading the sun's azimuth + 120, pitch 4                           | 25.7 mm, 50°    | Local noon               | `fair-cumulus`                                         | Still |
| `weather-g2-overcast-shore` | G world; S, height 2, heading 186, pitch 5                                                | 25.7 mm, 50°    | 35° and rising           | `overcast`                                             | Still |
| `weather-g3-underlit-dusk`  | G world; L, height 2, heading the sun's azimuth, pitch 15                                 | 23.05 mm, 55°   | −1.5° and falling        | `dusk-altocumulus`                                     | Still |
| `weather-g4-over-deck`      | G world; S's place, height 4,108, heading the sun's azimuth + 180, pitch −35              | 17.14 mm, 70°   | 35° and falling          | `stratocumulus`                                        | Still |
| `weather-g5-inside`         | G world; L's place, height 1,487, heading 90, pitch 0                                     | 20.78 mm, 60°   | 45° and rising           | `fair-cumulus`                                         | Cast  |
| `weather-g6-descent`        | G world; L's place, height 400,000, heading 90, pitch −87.995                             | 20.78 mm, 60°   | 45° and rising           | `stratocumulus`                                        | Cast  |

**As built.** E1's and G6's pitch is −87.995°, because −88° is past the
stance's limit. The solved suns are E1 50° and falling, E2 −21° and falling;
on P222_3_2_k IV, G1's noon at 73.79° (at 16.7° S), G2 35° and rising at
azimuth 78.37°, 108° off its view, G3 −1.5° and falling with the base's
horizon dipping 2.59°, a margin of 1.09°, G4 35° and falling, G5 and G6 45°
and rising. On this world's 3,922 km radius G3's ray returns into its layer
about 206 km sunward where the text below says 334 km for Earth's (**D**).
E3 holds `fair-cumulus` until the climate lands: `cirrus-over-cumulus`'s
bands, 0.05 rad, stripe a whole face every 2.9° of latitude.

What each geometry is for, with what the gathered references say of it
(`design/plans/weather/references.md`; observations from photographs, not
rulings):

- **E1.** At 400 km an 11.4° field spans 79.8 km top to bottom (**D**:
  `2·400·tan 5.7°`), 88.7 m a CSS pixel at 900 lines, so a kilometer cell is 11
  CSS pixels and 22 device pixels at DPR 2. A trace texel spans 354 m there
  (**D**: four CSS pixels), under half of the 800 m handover footprint, so the
  fine march draws the frame. The grid idles at this height (§5.5). The regime's base is at 1,000 m (`weatherScenario.ts:104`),
  so a 50° sun puts a cloud's shadow 0.84 km from it (**D**: `1.0/tan 50°`),
  most of a 1.2 km cell's width beside it. The references' field matches about
  a 120 mm lens on the station's cameras, so the photographs are chosen near
  that focal length and the lens stands.
- **E2.** The limb lies 19.8° under the horizontal from 400 km (**D**:
  `acos(6371/6771)`), so pitch −19.8 centers it. Two things move from draft 1.
  - **The lens goes to the floor, 11.4°.** Real limb photographs at this sun
    are taken at 240 to 460 mm, a field of 6° to 3°, and the lens cannot follow
    them: under 11.4° the terrain's patch cap saturates
    (`packages/rendering/src/lens.ts:299-305`). At the floor a degree is 79 CSS
    pixels and the air's 100 km at 2,290 km, 2.5°, is 197 (**D**), half the
    references' scale at best. **The panel's brief carries the caveat:** E2 is
    judged on color and layering, not on the band's apparent size.
  - **The sun is 21° under the horizon beneath the eye,** 1.2° under the limb.
    The limb's own ground then sees it 1.2° under, and a top there is lit above
    1.4 km (**D**: `6371·(1/cos 1.2° − 1)`), so both of the regime's layers
    stand lit over dark ground. Shadows a cloud lays on the air show clearly
    only near the terminator, and this puts the terminator at the limb. They
    are drawn from phase 2, with the shadowed air.
  - **At the decided footprint E2 stands in the handover's band.** Its frame
    runs from 1,115 km at its lower edge to the limb at 2,290 km, and at
    800 m the band is 905 to 1,809 km at Retina (§5.8); at 400 m the frame is
    all far march. So E2 is also the still that judges the band from orbit. The grid idles at this height, and every cloud in it takes its
    sun's depth from the layers' statistics (§5.5).
- **G1** stands 40 m up, on land, with its pitch low. From 2 m on flat ground
  the shadows of clouds on the ground are barely visible in real photographs;
  a rise of tens of meters shows them crossing the ground to the horizon. The
  rubric's G1 is "from a rise 40 m up" for that reason. The
  shadows themselves are phase 2's; in phase 1 the picture shows bases and
  tops.
- **G3.** A mid-level layer is lit from below only while the sun is higher
  than the layer base's own horizon dips, `acos(R/(R + h))`: 2.03° for a
  4,000 m base on a world of Earth's radius and 2.59° on the cornerstones'
  world (**D**). At −2° an Earth-sized world leaves 0.03° of margin, and a
  small error in the sun or the base flips the picture between lit and dark.
  So the sun is 1.5° under, and the ledger test holds the base's dip at least
  0.5° past the sun's depression: 1.09° as built. Clause 3 of the world's
  rule keeps that margin.
  - **The layer has to end before its own light comes in.** A base's ray to a
    sun `e` under its horizon dips under the layer and comes back up into it
    where the local sun stands `e` over the horizon: 334 to 362 km sunward of
    a base at the stance, on a world of Earth's radius, for 28 km of path
    through a layer 800 m thick (**D**, §5.5). A regime held over the whole
    body puts cover 0.7 there, and no light reaches any base: the picture is
    a gray deck, and correctly so. Real underlit decks end sunward. The grid
    phase 0 chose follows that ray to the union's far side (§5.5), so the
    picture depends on what the weather holds there.
  - **So G3's weather is `dusk-altocumulus`:** the `altocumulus` layer with
    its cover falling to nothing where the local sun is over the horizon,
    full under −0.1° and clear over +0.1°. Every base in frame that the sun is
    under then has a clear re-entry. The deck's edge stands 167 km sunward,
    its base 0.6° over the horizon in frame with clear sky under it (**D**,
    Earth's radius), which is the photographs' clear slot.
  - The ledger test holds it: at G3's instant no cloud of the layer stands at
    the re-entry point of a base's ray, for the base over the stance and for
    bases sunward of it. As built the clause walks sunward under the whole
    deck, where this design asked for one point 150 km out. It also holds
    the edge low in the frame over a clear slot, by its elevation from the
    eye, between 0.5° and 3.5°: a distance cannot say that on every world,
    since the same edge 100 km out stands 1.2° up on a world of Earth's
    radius and 1.75° up on this one. On P222_3_2_k IV the deck is full to
    96 km sunward and clear from 110 km, its edge 1.6° to 1.2° up.
  - **As taken, the GPU draws no deck at G3's instant.** The cloud frame
    forms its body-fixed sun from the star's render position less the
    body's (`bodySun`, `render/cloudFrame.ts`), as the terrain and the water
    do on `main`. Render compression keeps only directions from the eye, and
    the star stands 28 radii from the body's center in render space at G3, so
    the sun seen from the center stands 2.04° higher than from the eye:
    +0.5° where the true sun is −1.5°. The terminator then clears the eye.
    The CPU twin, the ledger and this design take the true sun. The
    weather's README records it, with its measure. The scenario
    carries the edge as `terminator: { full: −0.1, clear: 0.1 }`, in degrees
    of the local sun's elevation (`weatherScenario.ts`).
- **G4.** The eye stands 3 km over the regime's 1,300 m top, looking at the
  antisolar point: pitch is the sun's elevation negated. At 70° a degree is
  12.9 CSS pixels, so a glory ring near 2.4° is 31 CSS pixels from the point,
  and the cloudbow near 40° stands inside the 48° half-width (**D**:
  `atan(1.6·tan 35°)`). **No shadow stands at the glory's center.** Every
  photographed glory surrounds its aircraft's shadow; this stance is the
  observatory's eye, with no hull at it, and no phase draws a hull's shadow on
  the volume. That is also what an aircraft sees from far above its deck: the
  plan puts the umbra's end about 107 hull lengths away (§8.1 there). The
  panel's brief says so, and the references are chosen among those with the
  smallest shadow.
- **G5** is short of references: no clearly licensed footage of flying into
  and out of a cumulus was found, and the candidates are stratus. Its judgment
  leans on the cast's continuity check and the range readout (§8.5) more than
  on photographs. The rubric passes G5 by C6, with the panel's scores
  advisory, and its photographs illustrate the stages.
- **G5 and G6** are start poses. §8.2 gives the paths.

Package K adds three scenarios the table needs to
`packages/rendering/src/weatherScenario.ts`, in the shape of its neighbors
(`:100-251`): `altocumulus`, one layer at 4,000–4,800 m, cover 0.7, 1,000 m
cells, with no deck under it to block a sun under the horizon;
`dusk-altocumulus`, the same layer with the sunward edge G3 needs; and
`stratocumulus`, one layer at 800–1,300 m, cover 0.9, 1,800 m cells, radius
10 µm. The edge is cover as a function of the local sun's elevation, which
the cover's bake already receives (`scenarioCoverageNode(direction, sun, …)`,
`render/cloudMaps.ts`). As built it is one optional field of the scenario's
record, `terminator`, read in that function and in its CPU twin. A regime's id is part of a committed format from here on: the ids are
stable, and a picture naming one the build does not know decodes and reports
`'unavailable'`.

Every cornerstone carries `processing`, the build's default sensor settings,
as `ir.capturePicture` records them (`harness.ts:1196-1215`). The capture
record names the mode: the rubric's rig is Enhanced, the mode the game ships
with, and a change of the shipped default re-takes every cornerstone under
both (§3.2 there).

### 3.4 The instant is solved, and a test holds it

There is no solver for local solar time. `sunDirection(world, system, frame,
time)` (`packages/devtools/src/maneuvers.ts:107-120`) gives the sun in a body's
fixed axes, and the harness's private `#sunElevation` (`harness.ts:624-630`)
turns that into an elevation at a place. A body's spin is uniform, `2πt/P`
about its pole with zero phase at J2000 (`packages/universe/src/frames.ts:295-304`).

`packages/devtools/src/solarTime.ts` (new, layer 6, because it takes a
`World`):

```ts
export interface SunAt {
  /** Degrees over the sphere's horizon at the place. */
  readonly elevation: number
  /** Degrees east of north. */
  readonly azimuth: number
}
export function sunAt(
  world: World,
  address: string,
  place: Geodetic,
  time: number,
): SunAt

export interface SunTarget {
  /** Degrees. `'noon'` is the day's highest sun. */
  readonly elevation: number | 'noon'
  readonly trend: 'rising' | 'falling'
  /** The first instant at or after this, seconds from J2000. */
  readonly after: number
}
/** Null where the sun never reaches the elevation in the next 400 solar days. */
export function solveSun(
  world: World,
  address: string,
  place: Geodetic,
  target: SunTarget,
): ({ time: number } & SunAt) | null
```

- The solver brackets by the solar day, `2π/(2π/P − n)` from
  `synodicDay` (`dossier.ts:1643`), samples 96 instants a day for the first
  sign change with the wanted trend, and bisects to 10⁻³ s. It evaluates the
  frame graph at each instant; that clears the graph's cache
  (`packages/spatial/src/frame.ts:192-195`), which costs time and nothing else,
  so it runs outside a frame.
- Its core takes the sun as a function of time, so a property test drives it
  with a synthetic sun on a uniformly turning body: for any place, tilt and
  target the sun reaches, the solved instant's elevation is the target within
  10⁻⁴°, its trend is the one asked for, and no earlier instant after `after`
  satisfies both.
- The harness gains `ir.sun(address, place, time?)` and `ir.solveSun(…)`, in
  degrees as `ir.visit` takes them.
- `after` is 0 for every cornerstone: Earth's, and the generated world's,
  which is a replacement.

The solved times are in `cornerstones.json`, written by package K.
`cornerstoneLedger.test.ts` holds
each to the table: elevation within 0.5° of its target, the trend, and for
`heading the sun's azimuth` a heading within 0.5° of the solved azimuth plus
its offset. A change to a body's frames that moves a cornerstone's sun fails
that test in Node.

### 3.5 Settling

`ir.settled()` (`harness.ts:717-750`) reads the galaxy's cache and the
terrain's patches and no history at all. It gains one field:

```ts
const clouds = this.#host.render.clouds()?.settle ?? null
// ok also requires: clouds === null || !clouds.pending
// returns { ok, galaxy, terrain, clouds }
```

- `settle` is null when the system is off or absent
  (`packages/devtools/src/clouds.ts:114-128`), so a page without the flag
  settles as today, and `harness.test.ts:271-319` gains `clouds: null` and one
  pending case.
- `CLOUD_SETTLE_FRAMES` goes from 16 to 32 (`clouds.ts:104`). The history's
  weight floors at 1/8 (`render/cloudHistory.ts:105-121`), so a pixel holds
  the mean of eight samples only after 32 frames; 16 is four. The phase 0
  runner already waits 32 before it reads radiance
  (`scripts/clouds/page.mjs`, `RADIANCE_CONVERGE`).
- `capture.mjs`'s `--settle 30000` polls `ir.settled()` until two reads agree
  (`scripts/driveSteps.mjs:86-97`), so it needs no change. The help text at
  `scripts/drive.mjs:199-201`, `docs/agents/driving.md` and the drive skill
  gain the clouds.
- A forced path never settles (`clouds.ts:111-112`). No cornerstone forces
  one.
- **Settled is the rubric's "whole"** (§3.2 and §5 there): the history's 32
  frames, the sun grid at full weight or idle, and every block of the far
  atlas in view baked since the field last changed. K's settle is the first
  of the three. Package L adds the grid's weight to the report's `settle`
  when it builds the weight, and package X the atlas's blocks in view, so a
  plate cannot be taken while the statistics still stand in for the grid
  where the grid will draw.
- **Weather asked for before the clouds arrive is drawn when they do** (as
  built): the cloud chunk loads lazily, and a picture taken first holds its
  weather until the system exists.
- **`'climate'` reports unavailable until package C widens the lever** (as
  built). No cornerstone but E3's last form and C4's cast names it.

### 3.6 The capture set, and the media a pull request carries

One command takes every cornerstone and builds what a pull request shows:

```sh
pnpm build && pnpm preview &          # 8787; the tool refuses if it does not answer
node scripts/weather/capture.mjs --phase 1 --url http://localhost:8787/ --gpu-wait 1800
#   --only e1,g6     a subset by id suffix
#   --twice          take each still from two boots and report the pair's difference
#   --cut e1         take one still a third way, by a cut inside a boot
#   --base <dir|record>   the last phase's plates, by path or by a record's URLs
```

- **The rig** is the rubric's (§3.2 there): one session of `scripts/drive.mjs`
  at `--width 1440 --height 900 --dpr 2`, `--query chrome=0 --query layers=0
--query output=standard`, sRGB, the production preview with `--no-serve`.
  The tool acquires the GPU lock once and hands its token to each child, as
  `scripts/presets/capture.mjs` does, and brings its rig down in a `finally`.
- **A still** is `--preset <id>`, then `--settle 30000 --wait 1000`, a `--js`
  that returns `{ mode, lens, time, light: ir.light(), settled: ir.settled(),
clouds: ir.clouds(), weather }`, and `--shot`. The tool refuses a take whose
  `settled.ok` is false or whose `weather` is not the arm's.
- **Arms.** Every cornerstone has a `volume` arm, taken with `--query
clouds=1`. E1–E3 also have a `deck` arm, taken without the flag: the picture's
  weather is then `'unavailable'` and Earth draws its deck. From phase 3 the
  deck arm is taken from the last tree that draws one, by `--base`.
- **A cast** is §8.2's path for G5 and G6 at both speeds, the two fly casts
  and the zoom, each with the clouds on and off. The page-side path functions
  are `scripts/weather/descent.mjs`, which is this package's, because a
  cornerstone that cannot be taken before the work it judges is not one.
  `startPath` refuses a picture with no surface stance: the surface verbs do
  nothing without one (`packages/devtools/src/surfaceArm.ts:775, :805, :833,
:842`), and a cast of a still page must not be read as a pass.
- **`--twice` is two boots.** Each still is taken, the page is closed, and it
  is taken again from a fresh boot. The pair's changed pixels, by
  `compare.mjs`'s measure (`scripts/presets/compare.mjs:267-277`), are the
  rubric's row 17: two boots at one instant draw one plate, within the noise
  floor. The floor itself is five pairs, which is package U's `--pairs`
  (§3.8).
- **A cast records the rate it was taken at.** As built `capture.mjs` reads
  the rate from the page's own frame log over the cast's first 30 frames and
  refuses a cast outside 58 to 62 Hz. The rubric refuses only once a 60 Hz
  presentation can be held on demand, and until then asks for the rate in the
  cast's record (§4 there). Package U makes the refusal the hold's: before the
  hold exists a cast outside the band is kept, marked with its rate, and
  counts for no check that §7.5 lists as moving with the rate.
- **`--cut` is the rubric's "a cut lands on the right sky".** In one boot the
  tool takes another preset, settles, cuts to the named cornerstone, settles
  and shoots, and reports that plate against the fresh boot's. §4.7 keeps
  every cache through a cut on purpose, and this is the check that the kept
  caches are the right ones.
- **Output** goes to the main checkout's `.data/weather/phase-1/`, found from
  the clone's common git directory as `scripts/gpuLock.mjs:90-95` finds the
  lock, so every worktree of every phase reads one path and a removed worktree
  takes no plate with it. It holds `<id>-<arm>.png`,
  `<id>-<speed>-<on|off>/cast.mp4` with its frames and log, and `record.json`:
  the commit, a clean status, the build's time, Chrome's version, the frozen
  references' hash (rubric §3.2), each take's returned state, and each plate's
  and cast's SHA-256.
- **Sheets.** `scripts/weather/sheet.mjs` composes, per cornerstone, one PNG:
  the last phase's plate, this phase's, and for E1–E3 the deck, labeled and at
  one scale. For a cast it lays the two phases' videos side by side. It writes
  `media.md`, a Markdown block with one row a cornerstone. It needs ffmpeg and
  ImageMagick, which the driver treats as optional
  (`scripts/drive.mjs:650-677`), and it refuses without them.
- **Publishing.** The orchestrator uploads the sheets, the plates and the
  casts with the `share-media` skill and pastes `media.md`, with its URLs,
  into the pull request's body and into the record. `--base` then takes the
  record's URLs where a path is gone. Jon's "attach comparison media to prs
  throughout" is the instruction this serves; nothing else is uploaded.
- **The baseline.** Package K's own capture is phase 0's arm: the landed
  defaults' light, with the placeholder density, stills and casts both. Every
  later sheet's left column starts there, G5's and G6's included. It is also
  the panel's low anchor (rubric §3.3). Its casts carry phase 0's
  observer-built drift (§5.3): the density at a fixed point changes as the
  eye moves at a held time, so a step the detector finds in a baseline cast
  may be the placeholder's, and the baseline's casts pass no check.

A pull request that moves no cornerstone says so and shows the measurement it
does have.

### 3.7 The record

`design/plans/weather/README.md` gains one table, a row a cornerstone and a
column a phase: the sheet's URL, the commit, the numbers of the rubric's §3.9
that exist yet, and the panel's scores where a panel has sat. Earth's rows say
what the forced arm lacks at that phase: in phase 1, no shadow on the ground
and a regime in place of the climatology. E3's row says when its weather
changes from a regime to the climate, because the sheet across that change
compares two weathers. The uploaded plates make the table the durable index.
Package K writes the table with the baseline's column; package N writes phase
1's. Only the verdict commit's full set gates; every earlier phase's plates
are the record (rubric §2). Jon is shown the sheet at the phase's end, before
any score, and is not a gate on it (rubric §9).

**The references are frozen before the baseline is taken** (rubric §3.1), by
the orchestrator (ruling 3): 40 photographs, four or five a picture, with
source, credit, license, hash, capture metadata, a caption and a one-line
"misleads" note, in `design/plans/weather/references.md`; the images stay in
`.data/weather/references/`. Jon is shown the set and is not a gate on it.
E2's captions take the preset's 11.4° lens and its sun 21° under the horizon
by a dated note there, before the first packet is built.

### 3.8 What the settled rubric adds to the capture (package U)

Package U owns `scripts/weather/capture.mjs`, `descent.mjs` and `sheet.mjs`
after K, with `cornerstones.json` and the ledger test.

**The record carries provenance and a role** (rubric §3.2, §9).

| Field             | What it is                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commit`, `clean` | As built                                                                                                                                                                                          |
| `stance`          | The preset's id and its resolved pose, lens and instant                                                                                                                                           |
| `fixtures`        | The hash of the frozen references and of `cornerstones.json`                                                                                                                                      |
| `processing`      | The mode the plate was taken under. The rig's is Enhanced, the mode the game ships with                                                                                                           |
| `levers`          | The hash of the cloud levers as resolved at the capture's size, from `ir.clouds()` (§4.6)                                                                                                         |
| `role`            | `candidate`, `deck`, `last-accepted`, `low-anchor`, `guard-pair`, `clouds-off`, `injected-defect`, `reference-run` or `settled-sample`, with the differences the comparison exists to make, named |
| `rate`            | For a cast, the presentation rate and whether the hold was on                                                                                                                                     |

- A record missing a field is refused by the tools that read it: the panel's
  packet builder, `castSteps` and the sheet.
- **A candidate is matched by commit and lever hash,** within a size. A
  comparator is matched by rig, stance, fixtures and processing mode, and its
  commit and levers are what the comparison is between.

**The noise floor is five pairs of boots a picture.** `--pairs 5` takes each
baseline still from ten boots, two at a time. A picture's floor is the
largest difference in any of its pairs, as a changed-pixel count by
`presets:compare`'s measure and as an RMSE, written to the record as
`floor.json`. An RMSE over 0.005 stops the run: the rig is repaired before
any review counts (rubric §3.2). It is taken once, on the baseline, before
any plate of this phase's light.

**The casts the rubric's checks name.** K's six are in §8.2. These are added
or changed:

| Check  | Cast                                                                                                                                                      | Why K's set does not hold it                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| C1, C2 | **The zoom, from 400 km.** G6's start with pitch −45°, 60° to 11.4° in 300 frames                                                                         | At G4's pose the band is never in frame (§8.2)                 |
| C4     | G6's slow path under the world's own climate, `regime: 'climate'`                                                                                         | The lever names no climate until package C                     |
| C6     | G5 over 1,600 frames, with 2 km of clear range ahead at its first frame and at its last (§8.5)                                                            | K's 600 frames are 1.5 km                                      |
| C7     | The clock: the camera held at E1's stance at 1×, 100× and 1,000×, and at G1's at 1×, 300 frames each, started so a reduction falls inside the cast (§5.3) | K's paths hold the instant                                     |
| C8     | Settled stills at a quarter, a half and three quarters of the pass at 2 m and of the fast descent                                                         | K's casts have no settled sample                               |
| C9     | The frames from a cut to its settle, 60 of them, and the same for a scrub                                                                                 | `--cut` keeps the settled plate alone                          |
| §4     | **The continuous entry:** G5's path as settled stills, one a path frame, 600                                                                              | The detector's second control                                  |
| §4     | **The injected step:** the slow descent at `handoverBand` 1 with `maxSteps` 24                                                                            | K's positive control is named in §8.1 and not in its cast list |
| §4     | Settled stills at any path's frames `a..b`, for classifying a flagged step                                                                                | —                                                              |

- K's orbit fly, E1's pose at 7.7 km/s through a 60° lens, moves the ground a
  quarter of a pixel a frame and cannot ghost (rubric §4). It leaves the
  checks. Its baseline stays in the record.
- **A settled still along a path** is the path driven to frame `k` by its own
  schedule with no screencast, held, settled and shot. It has the role
  `settled-sample`, and it is what a flagged step is classified against
  (§8.1).
- **The clock's path** needs a preset's held instant released at a rate.
  `heldTime.ts` holds it (§8.2); package U adds the harness's verb for
  running it at a warp from a start instant and reads back the instant each
  frame into the log. The start is solved from `weatherClock.ts`'s reduction
  so that a layer's turn or the noise's origin is reduced inside the cast.

**The overlay guard** (rubric §2, §3.8) is a tenth preset,
`weather-guard-station`, in the cornerstones' list.

- **It is E1's picture with the station in it.** The observatory holds the
  station as its subject (`packages/devtools/src/observatory.ts`, a station
  is a subject of kind `'station'`; ADR-0060), from 1 km above it, looking
  down, through E1's 11.4° lens, with `fair-cumulus` forced. The station
  orbits at E1's height, so the field under it is E1's, 400 km off.
- **Its place is the station's, so its instant is solved for the sun.** The
  solver takes a place that moves: the first instant after J2000 at which the
  sun at the station's sub-point is 50° up and falling.
- The ledger test holds the station's bounding sphere wholly inside the
  frame and between a twentieth and a third of its height.
- It has a deck arm, which is its first accepted plate, and a volume arm. It
  is taken at every phase, read by B6, and judged from phase 2.
- **Nothing in it is drawn over the clouds,** as far as this design read: the
  station is opaque and writes the depth the trace stops at, so it carries no
  over-clouds mark and the `chain` form serves it (§4.12). Package U confirms
  that by the timeline, which holds no `scene over clouds` on the frame. What
  it tests
  is the composite's upsample at a hull's silhouette, where one transmittance
  a pixel meets an edge the scene antialiased by the sample. A halo there is
  one pixel wide, the same in both forms, and the rubric's artifact class for
  it is Halo.
- If the observatory cannot hold that pose on a station, package U reports
  it before it builds anything else, and the guard is a hull's: the ship at
  400 km through the flight camera.

---

## 4. Module layout, interfaces and the frame schedule

### 4.1 Layering and files

The layering is phase 0's (its §2.1): arithmetic a shader is held to in
`packages/rendering`, GPU modules in `apps/game/src/render` under `three/webgpu`
and `three/tsl`, reports as plain data in `packages/devtools`, generators and
references in `apps/ingest`, runners under `scripts/`. Files stay flat under
the `weather*` and `cloud*` prefixes.

**New files.**

| Path                                                                                                                             | Purpose                                                                                                                                                                   | Owner        |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `packages/devtools/src/cornerstones.json`, `solarTime.ts`                                                                        | §3                                                                                                                                                                        | K            |
| `apps/game/src/engine/pictureWeather.ts`                                                                                         | A picture's weather as levers, and its release: the mapping kept out of `GameEngine.ts`, which is 82.8 against fta's 91                                                   | K            |
| `apps/headless/src/cornerstoneLedger.test.ts`, `cornerstoneLedger.json`                                                          | §3.2                                                                                                                                                                      | K            |
| `scripts/weather/capture.mjs`, `sheet.mjs`, `descent.mjs`, `capture.test.mjs`                                                    | §3.6, §8.2                                                                                                                                                                | K            |
| `apps/game/src/render/cloudContracts.test.ts`                                                                                    | Imports every stub module and asserts shapes only, so knip sees a reader; deleted by N                                                                                    | C            |
| `apps/ingest/src/weatherSources.ts`                                                                                              | The source records of the third-party data behind a committed weather table: Baum's set and ISCCP-H, each with its citation, URL, license statement and date              | C            |
| `packages/rendering/src/weatherGenus.ts`                                                                                         | The genus table, the profile with its water, the radius by height, the scaled extinction                                                                                  | C (types), D |
| `packages/rendering/src/weatherClimate.ts`                                                                                       | `BodyWeather`, `bodyWeather`, `regimeWeather`, the zonal law                                                                                                              | C (types), D |
| `packages/rendering/src/weatherField.ts`                                                                                         | The CPU field every medium is held to; `FieldClock`; column depths; the sight-line count                                                                                  | C (types), D |
| `packages/rendering/src/skyIrradiance.ts`                                                                                        | The sky table's bake                                                                                                                                                      | C (stub), T2 |
| `packages/rendering/src/slabReference.generated.ts`                                                                              | The true medium's radiance and reflected flux on §5.11's domain; the scaled medium's beside it; the black-surface flux `R(τ, μ₀)` at `μ₀` 0.7 and 0.4 over `τ` 0.1 to 100 | C (stub), R1 |
| `packages/rendering/src/slabSource.generated.ts`                                                                                 | The higher orders' source function                                                                                                                                        | C (stub), R1 |
| `packages/rendering/src/cloudOctaves.ts`                                                                                         | The fitted octave constants and their Node error, typed                                                                                                                   | C (stub), R1 |
| `packages/rendering/src/blueNoise.generated.ts`                                                                                  | The mask                                                                                                                                                                  | C (stub), T3 |
| `packages/rendering/src/iceAggregate.generated.ts`, `iceTable.ts`                                                                | Baum's severely roughened aggregate, reduced, and its decoder (§5.4)                                                                                                      | C (stub), T4 |
| `packages/rendering/src/cumulusFixture.ts`                                                                                       | The isolated cumulus's density grid, from the CPU field                                                                                                                   | C (stub), R2 |
| `packages/rendering/src/cumulusReference.generated.ts`                                                                           | The CPU tracer's probe pixels, the reference curves, and 1,000 of the fixture's voxels                                                                                    | C (stub), R2 |
| `packages/rendering/src/isccpZonal.ts`, `isccpZonal.generated.ts`                                                                | ISCCP-H's zonal means and each type's mean depth, and their reader                                                                                                        | C (stub), E  |
| `apps/ingest/src/transport/legendre.ts`, `moments.ts`, `addingDoubling.ts`, `monteCarloSlab.ts`, `slabTables.ts`, `octaveFit.ts` | The slab references and what is generated from them                                                                                                                       | R1           |
| `apps/ingest/src/transport/pathTrace.ts`, `cumulusTables.ts`                                                                     | The CPU tracer and its generator                                                                                                                                          | R2           |
| `apps/ingest/src/blueNoise.ts`                                                                                                   | The mask's generator                                                                                                                                                      | T3           |
| `apps/ingest/src/iceTable.ts`                                                                                                    | The ice rows' generator                                                                                                                                                   | T4           |
| `apps/ingest/src/isccp.ts`, `isccpSources.ts`                                                                                    | The fetch, the reader, the statistics                                                                                                                                     | E            |
| `apps/game/src/render/cloudSky.ts`                                                                                               | The sky table's node                                                                                                                                                      | C (stub), T2 |
| `apps/game/src/render/cloudSource.ts`                                                                                            | The slab source table's upload and node                                                                                                                                   | C (stub), M2 |
| `apps/game/src/render/cloudJitter.ts`                                                                                            | `traceJitter` and the mask's upload, moved out of `cloudNodes.ts`                                                                                                         | C (stub), T3 |
| `apps/game/src/render/cloudMix.ts`                                                                                               | A crossing's law in TSL (§5.9), read by both marches                                                                                                                      | C (stub), M1 |
| `apps/game/src/render/cloudPathTrace.ts`                                                                                         | The WebGPU tracer, imported by its test alone                                                                                                                             | R2           |
| `scripts/clouds/noise.mjs`                                                                                                       | The runner's `noise` step and its table (§7.1)                                                                                                                            | Q            |
| `apps/game/src/render/cloudFarFurnace.gpu.test.ts`                                                                               | The far march's furnace, apart from the fine march's                                                                                                                      | X            |
| `scripts/castSteps.mjs`, `scripts/weather/glory.mjs`                                                                             | §8                                                                                                                                                                        | I            |

**ISCCP-H's artifact in phase 1 is small on purpose.** Phase 1's two readers
need zonal means and nine numbers: the zonal law's fit reads the cover of
eighteen 10° bands, total and by level, for each of twelve months, and the
calibration reads each of nine types' mean cover and mean optical depth.
`isccpZonal.generated.ts` holds those, about 1,100 numbers and under 20 KB of
text. Package E's ingest reads all 120 monthly files to make them, so the
reader, the fill's handling and the manifest are proven now. The gridded
climatology, about 14 million values, is not committed in phase 1: whether it
is generated text or a binary under `data/` with a manifest, as the textures
are (`apps/ingest/src/main.ts:400-446`), is phase 3's design, made with its
reader.

**One more new file follows from phase 0's choices:**
`packages/rendering/src/cloudSunSchedule.ts`, the sun grid's schedule as
arithmetic: which slices a frame bakes, whether the source is trusted, and
the grid's weight, from the frame's events and the cap. It is in the
rendering package so that Node can hold it by a property (§6.2);
`render/cloudSunGrid.ts` calls it and keeps the GPU's side. The files phase
0's losers leave behind are §10.4's.

Tests are in §6. Existing files touched are in each package's ownership list
(§10.2). No two packages in flight at once own one file, with one exception
that is ordered: packages L and Y each edit a hunk of `cloudSystem.ts`.

### 4.2 The weather per body

Phase 0 draws one scenario for every body through one `CloudLayerUniforms`
(`render/cloudUniforms.ts:153`, written once a frame at `:520`), with the
pattern's uniforms in a `WeakMap` beside the bundle (`render/cloudMaps.ts:98-149`).
Phases 1–3 need a climate per body.

**On the CPU** (`packages/rendering`, no three):

```ts
/** A level's envelope over the datum, meters. Three levels: low, middle, high. */
export interface LevelSpec {
  readonly base: number
  readonly top: number
  /** The genus where the level is stratiform, and where it is cumuliform. */
  readonly stratiform: CloudGenus
  readonly cumuliform: CloudGenus
}

export interface ClimateSample {
  /** Each level's cloud fraction, 0..1. */
  readonly cover: readonly [number, number, number]
  /** Each level's cumuliform share, 0..1. */
  readonly convective: readonly [number, number, number]
  /** The middle level's ice share, and the deep-convection rate, 0..1. */
  readonly ice: number
  readonly deep: number
}

export interface BodyClimate {
  readonly kind: 'regime' | 'zonal' | 'measured'
  /**
   * At a body-fixed unit direction, under a body-fixed unit sun. The season
   * is the sub-solar latitude and the local solar time is the sun's longitude
   * there (plan §4.1); neither is a calendar's.
   */
  sample(direction: Vec3, sun: Vec3): ClimateSample
}

export interface BodyWeather {
  /** deriveSeed(surface.seed, 'weather'). */
  readonly seed: Seed
  readonly levels: readonly [LevelSpec, LevelSpec, LevelSpec]
  readonly climate: BodyClimate
  /** Each level's turn about the spin axis against the ground, rad/s (§5.3). */
  readonly turn: readonly [number, number, number]
  /** The texture's drift along the spin axis, m/s. */
  readonly drift: number
}

/** A body's own weather; null where `wetWorld` is false. Derived, stored nowhere (rule 17). */
export function bodyWeather(body: Body): BodyWeather | null
/** A named regime as a weather: the scenario's layers as levels, its pattern as the climate. */
export function regimeWeather(body: Body, regime: ScenarioId): BodyWeather
```

- A regime and a climate are one type, so every consumer has one path. A
  scenario's layers (`weatherScenario.ts:34-51`) become the three levels, its
  cumulus genera read as `convective: 1`, and its `uniform`, `bands` or `blobs`
  pattern (`:368`) is its `sample`. `MAX_CLOUD_LAYERS = 3` (`:79`) is the level
  count.
- `'measured'` is phase 3's implementation, over ISCCP-H's gridded
  climatology. It is named here so the seam is one interface with three kinds.
- `weatherField.ts` evaluates the whole recipe on the CPU, from a `BodyWeather`
  and a frame's reduced clock, `FieldClock` (§4.11):

```ts
export interface FieldSample {
  readonly fraction: number
  /** Scaled in-cloud extinction σ′, 1/m (§5.1). */
  readonly sigma: number
  /** Effective radius, µm. */
  readonly radius: number
  /** −1 outside every level. */
  readonly level: number
}
/** `position` is body-fixed meters from the center; `footprint` is the meters a sample stands for. */
export function cloudFieldAt(
  weather: BodyWeather,
  clock: FieldClock,
  sun: Vec3,
  position: Vec3,
  footprint: number,
): FieldSample
/** A level's unscaled vertical optical depth at 550 nm in a direction: what ISCCP retrieves. */
export function columnDepth(
  weather: BodyWeather,
  clock: FieldClock,
  sun: Vec3,
  direction: Vec3,
  level: number,
): number
```

It reads the noise through `weatherNoise.ts` (`baseNoise` `:292`,
`detailNoise` `:302`), which `cloudNoise.gpu.test.ts` holds to the GPU's bake
within half an 8-bit step at every texel, and it quantizes as the bake does.
That twin is why no reference needs a readback (§5.11).

**On the GPU.** `CloudBodyUniforms` (`cloudUniforms.ts:56`) gains its body's
layers and climate, and `CloudUniforms.layers` moves into it. §4.11 says how
that lands on a system whose every medium reads the old path. The members
below are new; `base`, `top` and `sigmaScale` stay as built
(`cloudUniforms.ts:91-103`), and `coverage` and `genus` give way to the
climate's uniforms:

```ts
export interface CloudLayerUniforms {
  // one a body; every member a vec3 over the three levels; base, top and sigmaScale as built
  readonly sigma: UniformNode<'vec3'> // each level's reference σ′, 1/m
  readonly gain: UniformNode<'vec3'> // 1/(1 − f_δ) at the level's reference radius
  readonly radius: UniformNode<'vec3'> // reference effective radius, µm
  readonly cell: UniformNode<'vec3'> // base-noise cell, meters
  readonly erosion: UniformNode<'vec3'>
  readonly profileRow: UniformNode<'vec3'> // the level's first row in the profile table
  readonly phaseRow: UniformNode<'vec3'> // the class's first row in the phase atlas
  readonly phaseRows: UniformNode<'vec3'> // and its row count
  readonly phaseRadius: UniformNode<'vec3'> // the class's first row's radius, for the row mapping
  /** The level's noise frame: its turn as a matrix, and the reduced origins (§5.3). */
  readonly turn: readonly [
    UniformNode<'mat3'>,
    UniformNode<'mat3'>,
    UniformNode<'mat3'>,
  ]
  readonly noiseOrigin: readonly [
    UniformNode<'vec3'>,
    UniformNode<'vec3'>,
    UniformNode<'vec3'>,
  ]
  readonly detailOrigin: readonly [
    UniformNode<'vec3'>,
    UniformNode<'vec3'>,
    UniformNode<'vec3'>,
  ]
}
export interface CloudClimateUniforms {
  // one a body
  readonly kind: UniformNode<'uint'> // 0 regime, 1 zonal, 2 measured
  readonly law: UniformNode<'mat4'> // the zonal law's sixteen coefficients (§5.3)
  /** The regime's pattern: what the WeakMap side bundle holds today. */
  readonly pattern: UniformNode<'vec4'> // kind, scale, cells, period halves
  readonly blobThreshold: UniformNode<'uvec3'>
  readonly cover: UniformNode<'vec3'>
  readonly convective: UniformNode<'vec3'>
}
```

`cloudUniforms.write(frame)` stays a mechanical copy (`:516`). `CloudBodyFrame`
(`render/cloudFrame.ts:81`) carries each body's `BodyWeather`-derived numbers,
so the served and the second body draw their own weather, and
`writeScenarioPattern` (`cloudMaps.ts:211`) goes. §4.11 gives those fields
their TypeScript and gives their derivation to package H.

### 4.3 The maps, the profile and the medium

**The maps carry what a march reads.** Of the cube's and the clipmap's four
RGBA8 targets, the fine march reads texture 0 and nothing reads 1–3
(`cloudClipmap.ts:105, :277-285` has no caller outside tests). Phase 1 bakes
two:

| Texture | R               | G                  | B                | A                 | Read by      |
| ------- | --------------- | ------------------ | ---------------- | ----------------- | ------------ |
| `cover` | cover, low      | cover, middle      | cover, high      | ice share, middle | Every medium |
| `kind`  | convective, low | convective, middle | convective, high | deep convection   | Every medium |

Column depth and rain return in phase 3 and 4 with their readers, as a third
target; wind and wetness in phase 4, as a fourth. The bake stays one MRT quad
(phase 0's premise spike holds for two targets as for four). `CloudClipmapNodes`
keeps `coverage` and gains `kind`; `column`, `columnMeters` and `level` go
(`cloudClipmap.ts:97-113`). The cube bake evaluates the body's climate through
`climateNode(direction, sun, body.climate)`, a TSL port of `BodyClimate.sample`
that replaces `scenarioCoverageNode` (`cloudMaps.ts:337`) and is held to the
CPU at every texel within one 8-bit step, as `cloudMaps.gpu.test.ts` holds the
scenario today.

**The profile is per body.** `cloudProfile.ts` holds 64 heights × 8 rows of
RGBA8, a row a genus (`:28-35`). It becomes 64 × 48: two bodies × three levels
× eight rows, and a level's eight rows run from its stratiform genus to its
cumuliform one, so one bilinear fetch at row `profileRow + 7·v` blends the
profile by the sample's convective share `v`:

| Channel | Holds                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------- |
| R       | The extinction's shape with height, `σ′(h)/σ′_ref` over 2, so a growing profile fits a byte (§5.2) |
| G       | Its mean over the level, `p̄`: the unresolved density                                               |
| B       | The share of the level's column above this height: `∫_h^top / ∫_base^top` of R                     |
| A       | The radius with height, `r_e(h)/r_ref` over 2                                                      |

**The medium** (`cloudNodes.ts:79-90`) becomes:

```ts
export interface CloudMedium {
  /** The cloudy share of the column the sample stands for; 1 when resolved. */
  readonly fraction: Node<'float'>
  /** Scaled in-cloud extinction σ′, 1/m. Every transmittance is formed from it. */
  readonly sigma: Node<'float'>
  /** −1 outside every level. */
  readonly layer: Node<'int'>
  /** As built. Read by nothing once a crossing mixes by §5.9's law; removed at integration. */
  readonly column: Node<'float'>
  /** Effective radius at the sample, µm. */
  readonly radius: Node<'float'>
  /** Scaled in-cloud optical depth of the level's column above the sample, and of the whole column. */
  readonly depth: Node<'vec2'>
}
```

- `radius` is the sample's own, from the profile's A, where it is the level's
  constant today (`cloudDensity.ts:127`).
- `depth` is `(B, 1)·σ′_ref·p̄·thickness`, two multiplies on the fetch the
  recipe already makes. It feeds the sky term (§5.6) and, past the sun's
  cache, the higher orders (§5.5).
- The first-order gain `1/(1 − f_δ)` rides in the phase atlas's fourth
  channel, at the sample's own radius (§4.4). The level's `gain` uniform is
  the far march's, which reads one radius a layer.
- The recipe (`cloudDensity.ts:194-241`) is otherwise as built: shaped by the
  base noise against cover, eroded by the detail, faded by footprint to a
  fraction and a mean extinction.
- **A step makes five reads where it made four:** `cover`, `kind`, base,
  detail, profile. The march reads the field, by phase 0's cache gate, and
  every light tap is a medium of its own, so a step at four taps is up to 25
  reads before its light (**D**: five for the step and five a tap). That is
  the cost `lightTaps` 4 carries under the field, and the `ladders` batch
  prices it (§7.3).
- **The volume holds what the grid's bake reads,** and no march reads it
  (§2.5). Its bake calls the injected `fieldMedium`, so the two-texture maps,
  the per-body profile and the turn (§5.3) reach it with no edit of its own.
  It stores what it stored, the root of the extinction and the fraction; the
  grid sums `σ′` (§4.11).
- The three media keep their one recipe (`:255-299`): `fieldMedium` from the
  clipmap, `synopticMedium` from the cube, and `analyticMedium` from
  `climateNode` for a second body, which has no cube.

### 4.4 The light's tables

| Table           | Form                                                                                                                                                                                                                                                                                                                                                    | Made                                                                                                                                                           | Read by                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Phase atlas** | 1024 × 64 RGBA16F, one texture. Rows 0–31 droplets, 2–32 µm, as generated. Rows 32–54 ice: Baum's severely roughened aggregate of solid columns at its 23 effective diameters, 10–120 µm in 5 µm steps (§5.4). Rows 55–63 reserved for rain and dust. RGB the phase per band, convolved with the served sun's disk; **A the row's gain, `1/(1 − f_δ)`** | `CloudPhase` (`render/cloudPhase.ts:42`) from `mieDroplets()`, the ice table and `convolveDisk` at upload, again when the served sun's angular radius moves 1% | The march's prefetch, the far march, the composite's second body |
| **Sky table**   | 102 × 16 RGBA16F a body: three 34-column blocks over the sun's cosine, 16 rows over height, a guard column each side of a block. Block 0 `ln L̄`; block 1 `Δ`, the upper side's irradiance less the lower's over `π·L̄`; block 2 `Δ_s`, the sunward side's less the far side's (§5.6)                                                                     | `bakeSkyMoments` in the atmosphere task (`render/atmosphereTask.ts:59-60`), uploaded beside the air's two tables (`render/atmosphereLuts.ts:105-106`)          | The march, the far march; phase 2's ground and sea               |
| **Slab source** | RGBA16F 3D, linear, `n × n × 8` with `n` the smallest of 16, 24 and 32 that holds §5.5's reconstruction: `(u(t_d), u(t_b), μ₀)` to `(J₀, J₁, J_f)`, `t` a transport depth from a face and `u` its logarithmic map                                                                                                                                       | Generated by R1, uploaded by `cloudSource.ts`                                                                                                                  | The march and the far march                                      |
| **Blue noise**  | 64 × 64 × 16 R8, read by `textureLoad`                                                                                                                                                                                                                                                                                                                  | Generated by T3, uploaded by `cloudJitter.ts`                                                                                                                  | The trace, if the mask wins                                      |

```ts
export interface CloudPhaseNodes {
  /**
   * First-order phase per band, sr⁻¹, in rgb, and the row's gain in a, at
   * cos θ = nu, for a level's class at an effective radius, µm.
   */
  phase(
    nu: Node<'float'>,
    layers: CloudLayerUniforms,
    level: number,
    radius: Node<'float'>,
  ): Node<'vec4'>
}
export interface CloudSkyNodes {
  /** The sky's mean radiance per band and its two irradiance differences, at a sample. */
  at(
    sample: CloudSample,
    body: CloudBodyUniforms,
  ): { mean: Node<'vec3'>; up: Node<'vec3'>; sunward: Node<'vec3'> }
}
export interface CloudSourceNodes {
  /** (J₀, J₁, J_f) per unit of the sun's irradiance, from a sample's transport depths to its two faces and the sun's cosine. */
  source(depth: Node<'vec2'>, sunMu: Node<'float'>): Node<'vec3'>
}
```

- `phase` clamps its row inside the class's rows, half a texel in, so a
  bilinear fetch never blends droplets with ice. Each class maps a radius to a
  row its own way, by a per-level uniform: droplets by the table's logarithm,
  `log2(r/r₀)·(rows − 1)/log2(r₁/r₀)` (`cloudPhase.ts:75-94`); ice linearly in
  effective diameter, `(2r − 10)/5`.
- **The gain rides in the atlas's fourth channel,** so first order takes
  `1/(1 − f_δ)` at the sample's own radius from the fetch it already makes.
  Through an adiabatic level the radius doubles and `1 − f_δ` moves 4%
  (**D**), which a level's constant would put into first order at one end.
  The far march, which reads one radius a layer, uses the level's.
- `packages/rendering/src/mieTable.ts` gains `diffractionShare(table,
radius)`, `1/Q_ext` between the rows of the `bulk` the decoder already holds
  (`bulk[row].extinction`, `:30-35`), and `convolveDisk(table, angularRadius):
Float32Array` (§5.4). The committed droplet table is not regenerated.
- The sky table is exposed on `AirUniforms` as `sky`, with a stand-in of its
  own (rule 57). `AirUniforms` is what `createAirUniforms` returns
  (`render/air.ts:255`), and it is built six times, three of them in the
  surface materials (`planet.ts:326`, `terrain.ts:377`, `water.ts:285`). TSL
  binds a texture only in a graph that reads it, so those materials' WGSL does
  not move; the contracts package's spike proves it by hash at all six sites
  (§10.2).
- The served body's air takes its tables at `render/cloudUniforms.ts:328` by
  three positional arguments. The contracts package makes that one object, the
  body's table set, so package T2 adds a table without editing that file.
- The sky table's ground is a constant, `SKY_GROUND_ALBEDO = 0.15`. The
  atmosphere task's request carries a haze, a ratio and heights
  (`atmosphereTask.ts:40-44`) and no albedo, and phase 2 replaces the constant
  when it couples the ground's light to the deck over it. The task's `version`
  (`:57`) is spent, which is a cache key and not a generation version.

### 4.5 The trace: bindings, outputs and kernels

**The outputs stay four, 72 B a texel** (`render/cloudTrace.ts:93-104, :142-143`).
The as-built map reads the storage ceiling as the end of per-class light. It
is not, because of where the phase is applied: `lightSoFar()` multiplies the
first-order accumulators by the phase inside the kernel
(`render/cloudMarch.ts:312-326`), and what is stored is `L_c`, already phased
(`cloudTrace.ts:222`). So each addition is a register and a fetch:

| Addition                                                   | What it costs in the kernel                                             | An output? |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | ---------- |
| Per-class first order (droplets, ice; rain and dust later) | A row range in one atlas; the prefetch of §5.4                          | No         |
| The sky term                                               | One fetch of the sky table a segment; one `vec3` register               | No         |
| Higher orders                                              | Arithmetic, or one 3D fetch a step; one `vec3` register                 | No         |
| The moon's beam (phase 5)                                  | Its own prefetch at its own angle, summed into `L_c`                    | No         |
| Lightning (phase 4)                                        | Lit in the composite from depths the trace already writes               | No         |
| A wind that varies by layer, in reprojection               | The history finds the layer from the reprojected point's height (§5.10) | No         |
| The served opacity and the range (§8.5)                    | Three slots of the step counters' buffer, under `stats`                 | No         |

**The three ways to add a fifth output, and why none is taken.**

- _Raise `requiredLimits`._ `createRenderer.ts` and `capability.ts:53` request
  a default device, and `gpuHarness.ts:341` does the same for the suite. Asking
  for `maxStorageTexturesPerShaderStage: 8` changes both, makes the suite
  depend on what CI's paravirtual adapter offers (**not read**), and turns a
  device that offers only the defaults into one with no clouds, with a second
  configuration to test and no WebGL to fall to. It buys nothing phase 1–3
  needs.
- _Restructure_ into two kernels. That doubles the dispatches and re-marches
  the ray.
- _Pack._ Taken, and it costs nothing here because nothing needs packing: the
  72 B hold what they hold.

`requiredLimits` returns as a question only if a later phase needs a quantity
kept apart through the history. The census below is what would show it.

**Sampled bindings.** The stage allows 16. Phase 0's census (13, and 15 with
the volume; `cloudTrace.gpu.test.ts:406-409`) counts `CLOUD_STAND_INS.field`,
which binds seven textures where the real `fieldMedium` reads four
(`cloudNodes.ts:463-482`). Nothing counts the real kernel. The contracts
package's first test does: it builds the system's own trace kernel and counts
`texture_` bindings in its WGSL. The count this design expects, for the field
with the grid:

| Binding                                                            | Count  |
| ------------------------------------------------------------------ | ------ |
| Clipmap `cover`, clipmap `kind`, base noise, detail noise, profile | 5      |
| The sun grid                                                       | 1      |
| The air's transmittance and Ψ                                      | 2      |
| Sky table, phase atlas, far atlas, depth copy                      | 4      |
| **Before this phase's choices**                                    | **12** |
| Slab source                                                        | +1     |
| Blue noise, if it wins                                             | +1     |
| **Worst case**                                                     | **14** |

- **14 at worst, two free.** The volume and its bound are not in the trace:
  the grid's bake reads the volume, in a fragment stage of its own.
- The grid's second read, for a ray's whole depth (§5.5), is of the texture
  already bound, and the statistics that stand in for the grid are arithmetic
  on the `cover` and `kind` texels a step already holds. Neither adds a
  binding.
- If the spike's census reads more than this table, the count found replaces
  it, and at 16 the sky table moves into the phase atlas as 16 more rows
  (both are RGBA16F and both are re-uploaded when the served body changes),
  which returns one binding.
- `cloudTrace.gpu.test.ts` asserts the real count at most 16 and the storage
  count 4, and fails the build of any package that adds a binding unseen.

**Kernels.** After phase 0's landing the trace is one kernel and the stats
clear (`cloudTrace.ts:154-155, :297-308`; phase 0 design §12.2 item 5). While
this phase's choices are measured it is three: the phase's radius handling
changes the registers, so `mean`, `bins` and `sample` are variants, and `bins`
is one kernel for every bin count (§4.6). The jitter is a branch on a uniform
inside each, with the mask bound, and so is the higher orders' form if octaves
are built, so each A/B differs by the branch taken. After the landing it is
one again.

**The composite's fragment** binds 10 with the real far field (phase 0 package
report, WP9). It gains the second body's sky table and the slab source: 12.

**The second body** keeps its far march in the composite's fragment
(`render/cloudComposite.ts:441-489`). The plan's other home for it, the sphere
material, existed for WebGL. Its bake reads `analyticMedium` over its own
`CloudBodyUniforms`, so it draws its own weather. Its bake is an atlas of its
own, `farSecond`, the same class as the served body's (§10.4), and it reads
no grid: its sun's depth is the statistics alone (§5.5). Its per-pixel cost
has no figure (phase 0 package report, WP7); the campaign's pair stances take
one (§7.2).

### 4.6 Levers

`CloudLevers` (`render/cloudLevers.ts:59-100`) after phase 0's landing, changed
by this phase. Each lever's uniform is declared by the contracts package in
`CloudTraceUniforms` (`render/cloudUniforms.ts:123-150`), because that file is
closed to later packages.

| Lever                                                                                                                                                        | Values                                                                                                                                                                            | Its uniform                                                         | Kind                                                | Fate                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| `scenario` → **`weather`**                                                                                                                                   | `'climate' \| ScenarioId`, default `'climate'`                                                                                                                                    | None: it chooses the body's weather on the CPU                      | What is drawn                                       | Stays                                                       |
| `phaseMode`                                                                                                                                                  | `'mean' \| 'bins' \| 'sample'`                                                                                                                                                    | None: a kernel variant                                              | Measured choice                                     | Deleted; `'sample'` stays in the test that holds the winner |
| `phaseBins`                                                                                                                                                  | 2, 3, 4                                                                                                                                                                           | `trace.phaseBins`, a `uint`                                         | Measured choice                                     | Deleted                                                     |
| `jitter`                                                                                                                                                     | `'ign' \| 'stbn'`                                                                                                                                                                 | `trace.jitter`, a `uint`                                            | Measured choice                                     | Deleted                                                     |
| `transport`                                                                                                                                                  | `'slab' \| 'octaves'`                                                                                                                                                             | `trace.transport`, a `uint`                                         | Exists only if the octave fit passes in Node (§7.4) | Deleted                                                     |
| `handoverBand`                                                                                                                                               | A ratio ≥ 1, default 2                                                                                                                                                            | `trace.handoverBand`                                                | Quality step                                        | Stays, at its measured value                                |
| `clip`                                                                                                                                                       | The history's clip width in σ, default 1.25                                                                                                                                       | `trace.clip`                                                        | Quality step                                        | Stays, at its measured value                                |
| `lightTaps`                                                                                                                                                  | 0, 2, 4, 6, 8, default 4, spaced in optical depth (§5.4)                                                                                                                          | As built                                                            | Quality step                                        | Stays                                                       |
| `maxSteps`, `farFootprint`, `traceScale`, `composite`, `force`, `warp`, `scrubSeconds`, `flySpeed`, `jitterFrame`, `served`, `second`, `deck`, `stats`, `on` | As built                                                                                                                                                                          | As built                                                            |                                                     | Stay                                                        |
| `over`                                                                                                                                                       | `'passes' \| 'lean' \| 'chain'`, default `'passes'`                                                                                                                               | None: it chooses the composite's form and pass B's store on the CPU | Measured choice (§4.12)                             | Deleted; the winner is the default                          |
| `sunSlices`, `sunRamp`, `farBlocks`                                                                                                                          | Slices a frame a rebuild may bake, 4, 8 or 16, default 8; frames the grid's weight takes to rise, 8, 16 or 32, default 16; atlas blocks a frame after an event, 1 or 2, default 1 | None: the caches' schedules; `trace.sunWeight` carries the weight   | Measured choice (§4.7)                              | Deleted; the values become constants                        |

The decided ladders are the defaults the landing sets: `maxSteps` 192,
`lightTaps` 4 and `farFootprint` 800 m. `lightTaps` admits 6 and 8 for the
ladder that is taken again (§7.3), and its list, `CLOUD_LIGHT_TAPS`, is
exported so the runner's ladder reads it and holds no copy.

**Levers resolve by size, and the resolved set has a hash.** The rubric binds
a candidate's evidence by a hash of the levers as resolved at the capture's
size (§9 there), and offers a cheaper lever at Retina as the answer to B9.

```ts
/** The levers a frame of this drawing-buffer size and pixel ratio draws with. */
export function resolveCloudLevers(
  levers: CloudLevers,
  size: { width: number; height: number; dpr: number },
): CloudLevers
/** Eight hex digits over the resolved levers' canonical JSON, keys sorted. */
export function cloudLeversHash(resolved: CloudLevers): string
```

- `resolveCloudLevers` is the identity in phase 1, apart from what the trace's
  extents already do by size (`render/cloudFrame.ts`, `extents`). It is the
  one place a size-specific default can be written, which is what B9's second
  answer needs.
- The hash leaves out the levers that only steer a measurement, `force`,
  `warp`, `scrubSeconds`, `flySpeed`, `jitterFrame` and `stats`, so a forced
  row and its steady row share one hash. The report says which were set.
- `ir.clouds()` carries `levers`, the hash (`packages/devtools/src/clouds.ts`).
  The capture's record and every campaign row read it there (§3.8, §7.2).
- The contracts package declares both and tests that two lever sets differ in
  hash exactly when a shipped lever differs.

**Which levers stay, and as what.** The rubric asks that each lever left at
the verdict be a quality step or a measurement control, named as such in its
ADR (§7 there). After this phase's landing: `weather`, `maxSteps`,
`lightTaps`, `farFootprint`, `traceScale`, `handoverBand` and `clip` are
quality steps; `composite`, `force`, `warp`, `scrubSeconds`, `flySpeed`,
`jitterFrame`, `served`, `second`, `deck`, `stats` and `on` are measurement
controls. `composite` keeps `'thin'` for row 20's batch alone (§4.10).

`bins` is one kernel for every `phaseBins`: it holds four phases a level and
fetches the first `phaseBins` of them, so the trace has three variants during
the measurement, not five. `isCloudLevers` (`:147-198`) and the reset keys
(§4.7) follow.

### 4.7 The frame schedule, and what a reset rebuilds

**The schedule is phase 0's** (`render/cloudSystem.ts:242-257`): the field's
bakes, the depth copy, the trace and the history, then the composite's draw.
Phase 1 adds no pass and no pass name: every new table is baked on the CPU or
generated offline. It removes two: `cloud volume bound` goes with the bound
(§2.5), and `scene over clouds` is absent on a frame with nothing drawn over
the clouds (§4.12). The frame node runs inside pass B, as the first thing its
opaque list draws (`render/cloudFrameNode.ts`, `render/cloudOverPass.ts`), and
on a frame without pass B it runs from the chain's composite term, before
that term reads the trace.

**On the CPU,** `beginFrame` (`cloudSystem.ts:339-372`) gains two jobs, both on
a frame that is already a reset:

- when the served body changes, its profile rows and its climate's uniforms
  are written, and its sky table's texture is bound;
- when the served sun's angular radius has moved 1% since the atlas was
  convolved, `CloudPhase` convolves and uploads again. The cost is about 2.7
  million kernel evaluations with the ice rows (**E**; §5.4) and is **to
  measure**; if it passes 2 ms it moves to the atmosphere task.

**A cut stops costing a cache rebuild.** `keyChanged`
(`render/cloudFrame.ts:556-569`) folds the picture's epoch, the history key,
the levers' key and both bodies' addresses into one `'key'` reset, and a
`'key'` reset rebuilds every eye-anchored level and the sun grid from no
previous frame (`:596-603, :643`). But the field is a function of body, place and time:
a cut that keeps all three leaves every cache correct. So the reason splits:

| Reason      | Fires on                                                                        | The history                      | The caches                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'picture'` | `pictureEpoch` or `historyKey` moved (`sensor.ts:540-551`)                      | Restarts; the frame is immediate | Kept. `levelFrames` (`packages/rendering/src/cloudFrames.ts:338`) still gets the previous frame, so a level rebuilds only if the cut moved its anchor |
| `'field'`   | The weather, the served or second address, `farFootprint` or `traceScale` moved | Restarts; immediate              | Rebuilt from no previous frame; the sun grid and its source under the cap, as below                                                                   |

`cloudResetKey` (`cloudLevers.ts:205-221`) becomes `cloudFieldKey`, without
the candidates the landing deleted. `CloudResetReason` (`cloudFrame.ts:121-122`)
is `'none' | 'first' | 'field' | 'picture' | 'jump' | 'resize' | 'cut' |
'force'`; `'motion'` goes (§5.10). The contracts package adds the two new
reasons beside the old ones, and package H makes the split and removes
`'key'` and `'motion'` (§4.11). The rubric's B7 reads a cut, a scrub, a
change of weather and a wake from orbit each as its own sequence, and a cut
is the cheap one.
`capture.mjs --cut` checks that the caches a cut keeps are the right ones
(§3.6).

**The grid's rebuild is the reset frame, and it is spread.** With the grid a
cut costs 19.69 ms and a scrub 14.54 ms at 1080p, against 7.83 and 9.86 with
the cascades: the frame's bakes are 13.79 and 8.64 ms where they were 1.71
and 3.90 (campaign 1, on `horizon`). The landed campaign reads 20.61 and
14.88 ms, through another stance's lens. The rubric's B7 allows the event's
frame 4 ms over the steady Δ. Four things make that frame, read in the code:

- **Every event rebuilds all 32 slices at once.** The first frame, a frame
  index that skipped, a jump, a new scenario, a new address, level 1's anchor
  moving, a wake from idle and a sun turned 0.05° each null every slice, and
  the cap, `SUN_DEPTH_FRAME_CAP`, is exactly 32 slices of 128² cells by 32
  steps, 16.8 M texel-steps (`render/cloudSunGrid.ts`, `render`, `#schedule`).
- **Its source is not there yet.** After a jump the volume bakes level 0's 34
  slices that frame, which spends its budget of eight, and levels 1 and 2
  follow at eight a frame from the next (`render/cloudVolume.ts`,
  `#schedule`). Where no level is trusted `CloudVolume.medium` answers from
  the field. So outside level 0's 12.8 km the grid's 16.8 M steps are the
  field's five reads, not the volume's one.
- **The sun's turn is an event on a clock.** At Earth's rotation the sun moves
  0.05° in 12 s (phase 0 design §3.12), so the grid is rebuilt whole every 12
  seconds of ordinary play. No `ir.gpu` row holds that frame: the runner's
  held loop freezes `renderTime` (phase 0 design §4.1), and the sun with it.
  A 3 s profile whose clock ran would meet it one time in four. On the
  cornerstones' world, with its 10 hour day, it is every 5 s.
- **The game's own warp is a jump every frame.** `jumped`
  (`render/cloudFrame.ts:420-448`) expects a frame's step of world time to be
  the wall's, and calls anything over `max(1 s, 4·delta)` a jump unless the
  `force: 'warp'` lever is set. The dock's ladder is 1, 5, 25, 100 and up
  (`hud/warp.ts:15`), and at 100× a 60 Hz frame is 1.67 s of world time. So
  from 100× every frame takes the reset path: the immediate regime, and every
  cache rebuilt. The lever measures a path the game does not take (phase 0's
  council).

The refresh that replaces it is package L's, with the frame's jump test
package H's:

| Event                                                                                     | Today                                  | Phase 1                                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The sun turns                                                                             | All 32 slices that frame, every 0.05°  | Not an event. The steady refresh bakes under the frame's sun, and its pace follows the sun's (below)                                                               |
| The clock runs at a warp, at any rate of the dock's ladder                                | A jump every frame from 100×           | Not an event. A frame's step of world time is compared with the clock's own rate, so only a step the rate does not explain is a jump                               |
| A cut that keeps the body, the place and the time (`'picture'`)                           | All 32, and the volume's 34 at once    | Nothing. The history restarts and the caches stand                                                                                                                 |
| The eye moves                                                                             | Six slices a frame at the new window   | As built                                                                                                                                                           |
| A jump of the field's time, a new weather or address (`'field'`), an anchor past a window | All 32, and the volume's 34 at once    | A rebuild under the cap: the volume's two levels at `sunSlices` a frame, then the grid's 32 at `sunSlices` a frame from the trusted volume, then the weight's ramp |
| A wake from idle, on the way down from orbit                                              | All 32 that frame, and the shadows pop | The same rebuild, started at the wake; the weight rises with the eye's descent                                                                                     |
| The first frame with the clouds on (`'first'`)                                            | Every cache at once: 51 to 67 ms       | The same rebuild. What is not a rebuild moves into the boot's warm-up (below)                                                                                      |

- **Why a turning sun needs no rebuild.** The grid's cells are level 1's,
  fixed to the body and anchored at the eye; the sun's direction is only the
  ray each cell's bake follows. Two slices baked under suns `Δ` apart
  disagree by a shadow displaced `chord·Δ`: 9 m for 10 km of chord at 0.05°
  (phase 0 design §3.12), against a 400 m cell. The cascades needed the event
  because their texels are in the sun's own frame. The steady refresh redraws
  all 32 slices in eight frames, in which Earth's sun turns 0.0006° (**D**:
  `360°/86,164 s × 8/60 s`).
- **A jump is a step the clock's rate does not explain.** Package H's
  `jumped` takes the clock's own rate from the frame's inputs
  (`scene/Sensor.tsx:201-203` hands it the world's step and the wall's), and
  a frame jumps when `|Δt_world − rate·Δt_wall|` passes
  `max(1 s, 4·rate·Δt_wall)`. A steady warp at any rate of the dock's ladder
  is then continuous, and a scrub is still a jump. The `force: 'warp'` lever
  drives the same path the game takes. The rigid turn (§5.3) is what makes
  that safe: at 1,000× a layer moves 133 m a frame at 8 m/s, which the
  history reprojects by the layer's own turn (§5.10).
- **Every cache is refreshed at the pace its field moves.** A cache's texel
  is redrawn before the fastest thing it holds moves a tenth of it:

| Cache                | Texel            | What moves in it                 | At 1×, whole within      | Landed: whole within                  |
| -------------------- | ---------------- | -------------------------------- | ------------------------ | ------------------------------------- |
| Cube, 6 faces        | 19.6 km on Earth | A layer's turn, 25 m/s at most   | 78 s                     | 6 frames                              |
| Clipmap, 6 levels    | By level         | The same                         | By level, from its texel | An eighth of a level a frame          |
| Far atlas, 45 blocks | 24 to 39 km      | The same                         | 96 to 156 s              | 45 frames, at 0.80 to 1.59 ms a block |
| Volume, two levels   | 200 m, 800 m     | The same                         | 0.8 s, 3.2 s             | 9 frames                              |
| Sun grid, 32 slices  | 400 m            | The turn, and the sun's own turn | 1.6 s, or 0.25° of sun   | 8 frames                              |

- The pace is `texel/(10·u)` for a layer speed `u`, and under a warp `u` is
  the warp's (**D** for each row at 25 m/s). The grid's second clock is the
  sun: its slices are never more than 0.25° of sun apart, 44 m of shadow in
  10 km of chord (**D**).
- **It takes the bakes out of the steady frame.** At 1× the volume and the
  grid together bake about one slice a frame where they bake twelve, and
  the cube and the atlas a face and a block every few seconds where they
  bake one of each every frame. From orbit, where the volume and the grid
  idle, the steady frame bakes almost nothing (§2.6). The frame that does
  bake an atlas block still pays its 0.8 to 1.6 ms, once in about 130
  frames.
- **Each cache's cap is its event rate,** which the landed code spends on
  every frame: the cube a face a frame, the atlas `farBlocks` a frame, the
  volume and the grid `sunSlices` each. Under a warp the pace rises toward
  the cap and stops there. At eight slices a frame the grid follows a sun
  to a warp of 900 at Earth's rotation (**D**: `0.25°·8/32` a frame against
  `0.0696°` at 1,000×), and past that it lags by four frames, which
  ADR-0073 declares. The plan accepts a cache that lags under warp (§12
  there); it does not accept one that rebuilds.
- The schedule is arithmetic, in `packages/rendering/src/cloudSunSchedule.ts`
  for the grid and its source and in the same shape for the cube, the
  clipmap and the atlas, each in its own package's file. Package L writes
  the function all four call.
- **The grid waits for its source.** A slice is baked only when both of the
  volume's levels are trusted, so no step of a rebuild takes the field's five
  reads. With two levels the source is 68 slices: nine frames at eight a
  frame. Then the grid is four frames. Then the weight ramps over `sunRamp`
  frames, 16 by default: 29 frames from the event to the grid at full weight,
  inside the 32 the history itself takes to settle (§3.5).
- **A cache is fresh only from a fresh source.** After a jump the landed
  clipmap and atlas rebuild from cube faces not yet rebaked and mark
  themselves fresh (phase 0's council), so a settle can pass on the old
  weather. Each cache records the generation of what it read: the clipmap and
  the atlas the cube face's, the grid the volume's. A cache whose source is
  older than the field is pending and is baked again when the source
  arrives. The cube bakes the faces in view first, and an atlas block waits
  for its face.
- **After an event the atlas bakes the blocks in view first,** `farBlocks` a
  frame, one by default. Half the body at most is in view, so 23 blocks and
  the three faces before them are whole within about 26 frames (**D**). If a
  block's 0.8 to 1.6 ms does not fit under B7's later frames beside the
  grid's slices, package X cuts the block from 192 texels to 128, a hundred
  blocks a cycle at under half the cost each, and §7.4's rule chooses.
- **Nothing is unshadowed meanwhile.** While the grid is not whole, the sun's
  depth past the taps is the layers' own statistics (§5.5), which is also what
  draws from orbit and past the grid's window. The grid replaces them through
  a weight, `trace.sunWeight`, that is zero until every slice holds this
  field and rises linearly over the ramp. As built, an unwhole grid reads as
  no cloud at all (`cloudSunGrid.ts`, `opticalDepth`'s `select`), so a spread
  rebuild without the stand-in would light every cloud past its taps for a
  quarter second and then shade it.
- **The wake is by height, not by a frame.** The grid idles while the eye is
  more than level 1's extent, 51.2 km, above the union's top
  (`cloudSunGrid.ts`, `render`). On the way down its bakes start there, and
  its weight is also multiplied by `saturate((51.2 km − (eye − top))/12.8 km)`:
  zero at the wake and one a quarter of the extent lower. That is a function
  of the camera, so a camera hovering at the wake does not flicker, and G6's
  descent crosses it as a fade (§5.8 gives the same reason for the handover).
- **A scrub that never ends never finishes a rebuild.** Under the runner's
  `force: 'scrub'` every frame is a jump, so every frame draws the stand-in
  and bakes `sunSlices` of the volume. That is the reset frame's own cost,
  which the row wants, and the frames after it are measured as a sequence
  (§7.2).

`sunSlices`, `sunRamp` and `farBlocks` are set by §7.4's rule from the reset
sequences.

**B7 is the rubric's, and this is how the design meets it.** A cut, a scrub,
a change of weather and a wake from orbit are each read as a sequence on GPU
timestamps, on `horizon` at 1080p:

| B7 asks                                                                                                                                      | What spends it                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The event's own frame, which traces every pixel once, is no more than 4 ms over the steady Δ                                                 | The immediate regime: four trace dispatches at a quarter of the steps each. On `horizon` the landed cut's trace is 6.00 ms against a steady 2.45, so the regime alone is 3.5 ms. The bakes that frame are a cube face and `sunSlices` of the volume, no more than a steady frame at its cap |
| No later frame is over the steady Δ by more than 2 ms                                                                                        | The caps: `sunSlices` of the volume or the grid, a cube face, `farBlocks` of the atlas                                                                                                                                                                                                      |
| The field is whole within 48 frames at 60 Hz: the grid at full weight, eight samples a pixel in the history, every atlas block in view baked | 29 frames for the grid at the defaults, 32 for the history, about 26 for the atlas                                                                                                                                                                                                          |

- **The event's frame has half a millisecond to spare,** and the trace's own
  cost decides it. The regime's premium is 1.45 times the steady trace
  (**D**: `6.00/2.45 − 1`), so at B2's bar, where the plan's trace is 1.8 ms,
  it is 2.6 ms (§2.6). If the trace does not come down, B7's first clause is
  the one that fails, and the lever is the immediate regime's share of the
  steps.
- **The caps and the ramp have to fit 48 frames together.** `sunSlices` 4
  with `sunRamp` 16 is 41 frames; 8 with 32 is 45; 4 with 32 is 57 and is not
  a choice. `sunRamp` is 8, 16 or 32.
- **The sequence is 60 frames,** 48 and a margin, read by the `sequence`
  step (§7.2). "Whole" is read from `ir.clouds()`: the grid's weight, the
  history's count and the atlas's pending blocks in view.
- **The landed figure B7 quotes is at an unknown field of view** (the record
  at the top). The bar's own derivation is from `horizon`'s steady row and
  stands.

**The first frames are a reset and a warm-up, and B13 wants both.** The
largest of the first five intervals with the clouds on is 50.8 to 66.8 ms at
1080p against a steady 16.7, and it is not shown to be a compile: the
pipelines are 10 and 8 on every boot, and a cut alone costs 19 to 25 ms of
GPU (landed).

- **The reset's share is this section's:** the first frame is `'first'`, and
  it rebuilds under the same caps as any change of field.
- **The rest is not a rebuild and moves into the boot.** What the first
  frames spend beyond a reset has not been decomposed. The candidates are the
  system's textures being allocated, the noise being baked and the tables
  being uploaded. Package N reads the first five frames by pass and by CPU
  span, and whatever of those it finds there moves into the boot's warm-up
  under the `warming the clouds` span, through `render/warmup.ts` (rule 61).
- **That span came back empty in all six landed boots.** Package N's first
  act is to find why: whether the registration emits it, and whether the
  runner reads it. A span that is not recorded cannot hold B13 or the plan's
  cold-compile row.
- B13 binds from the first campaign that can hold 60 Hz (§7.5). Until then
  the `memory` batch records the five intervals with their rate, and beside
  them each of those frames' GPU time by pass, which does not move with the
  rate and says what the first frames spend.

**Warm-up** (`cloudSystem.ts:394-410`) keeps its shape: one registration,
every kernel and material compiled against stand-ins, `cloudWarm.gpu.test.ts`
holding the first frame of every lever set to no new pipeline. The lever sets
it holds gain one with `served` set and one with `second`, which the landed
test never exercises (phase 0's council).

### 4.8 The served set, and Earth

```ts
/** Drawn by the volume unasked: wet, with no authored deck to lose. Derived (rule 17). */
export function cloudsServed(body: Body): boolean {
  return wetWorld(body) && body.appearance.clouds === null
}
```

- It lives beside `wetWorld` (`packages/rendering/src/weatherScenario.ts:452-459`),
  and `cloudFrame`'s `wet` predicate (`render/cloudFrame.ts:610-613`) calls it
  where it calls `wetWorld`. Earth is wet and has an authored deck
  (`packages/universe/src/solar/bodies.ts:574`), so it is outside the set; so
  is Venus, which `wetWorld` already excludes.
- `servedBody` (`cloudFrame.ts:255-276`) is unchanged: a forced address wins
  over the set, which is how a picture's weather or a measurement's lever puts
  Earth in. `secondBody` (`:278-296`) likewise.
- `deckYields` (`cloudLevers.ts:229-235`) is unchanged: the served body's deck
  hides while the clouds are on. **Its sphere shadow yields with it.** A hidden
  deck still darkens the sphere through `cloudShade`
  (`render/planet.ts:452-464`), so the volume arm of E1 would show the deck's
  map as shadows under the volume's clouds. `scene/Bodies.tsx:536` writes
  `cloudShadow` as 0 on the frames `:546-549` hides the deck. That is a
  uniform's value, and no graph moves.
- In phase 3 Earth's `clouds` record goes, and the predicate admits it with no
  change.
- A test builds both records from `@inertialref/universe`, as
  `weatherScenario.test.ts:165-222` does, and holds: far-shore V served,
  Earth not, Earth served when forced, and the deck's shadow 0 exactly when
  the deck is hidden.
- **As built,** `cloudsServed` is in `weatherScenario.ts` with its test
  (package K), and `cloudFrame` still calls `wetWorld`. Package C wires the
  frame to it.
- **C11 is this section's test** (`weatherScenario.test.ts`,
  `cloudFrame.test.ts`): on WebGPU, Earth's deck is hidden only on a frame
  where the volume serves Earth, and Earth joins the served set when its
  deck's record goes, which the test shows by building Earth's record without
  one. A frame of Earth with neither a deck nor the volume fails it. Its
  phase 3 half is the same test on the record as it then stands.

### 4.9 What draws after the composite reads the knots

`cloudFront(trace, uniforms, screen, distance)` (`render/cloudFront.ts:103-155`)
returns the transmittance and the light in front of a point, and only its
tests call it. Every overlay draws over the clouds unattenuated today. A ring
passing behind a limb's clouds, a plume inside a deck and an entry trace under
one are each a pasted layer.

**A knot is a level's crossing, not a column's.** As landed, the march closes
a segment at each clipmap texel of horizontal run and records a knot at each
close whose own transmittance is under 0.98, and the fourth knot absorbs the
rest (`render/cloudMarch.ts:357, :447-449`, `render/cloudKnots.ts`). On the
real field four knots are then the first four columns, about 250 m each.
Looking up 30° through a kilometer of cumulus under cirrus, knots 0 to 2 are
the first 750 m and the fourth runs from there through the cirrus, so an
object in the clear gap takes a depth-proportional share of the cirrus behind
it. A cloud thin in every column records nothing, and `cloudFront` answers
`T = 1` (phase 0's council). The landed tests see neither, because they are
on slabs, whose column has no end.

- §5.9's law removes the column's close, and the knot's trigger with it.
  **Package M1 records one knot a crossing of a level:** its entry is the
  crossing's first cloudy step and its exit the last, with the transmittance
  and the light so far at the exit. A crossing whose own transmittance is
  over 0.999 records none.
- Four knots hold three levels and one level crossed twice, which is a
  grazing ray's. Past four the fourth absorbs the rest, as now.
- Inside a knot `cloudFront` interpolates between entry and exit, as now.
  Between two knots it is flat, which is the clear gap between two layers.
- The layout does not change: four entries and exits, and four `(L, T)`
  (`cloudKnots.ts`).
- **The tests are on the real field** (`cloudFront.gpu.test.ts`, package M1).
  Under `cirrus-over-cumulus`, looking up 30°, a point in the gap reads the
  cumulus's transmittance within 2% of a march stopped there. A layer of `τ`
  0.1 in every column reads within 0.01 of the march's transmittance behind
  it, and not 1. `cloudFront` at the ray's end equals the trace's own
  `(T, L)` within 1%.

**Nothing hands a scene material the trace today.** The system is made inside
the sensor (`render/sensor.ts:224-227`) from a factory in a lazily loaded
chunk (`App.tsx:116-123`); it exposes its field and not its trace
(`render/cloudSystem.ts:74-102, :204`); the ring, the plumes and the entry
trace are built with no system in reach (`scene/Bodies.tsx:369`,
`scene/ThrusterFx.tsx:55`, `scene/EntryTrace.tsx:30`, and the ring again at
boot, `render/preload.ts:120`); and the sensor's chain is rebuilt on a picture
change, so a captured uniform bundle goes stale. So the contract is a handle
the engine holds:

```ts
/** What a material drawn after the composite needs, to read the clouds in front of it. */
export interface CloudFrontHandle {
  /** This frame's trace textures; null on a frame with no clouds. */
  textures(): CloudTraceTextures | null
  /** The screen's and the served body's numbers `cloudFront` reads, copied every frame. */
  readonly screen: CloudFrontUniforms
}
// GameEngine: readonly cloudFront: CloudFrontHandle | null   (null without the flag)
```

- The contracts package declares it, makes the engine's one handle when the
  cloud chunk loads, and has the system copy its screen uniforms into it each
  frame in `beginFrame` and point `textures()` at its trace. The handle
  outlives a rebuilt chain; the bundle inside it is the materials' own.
- **Each material takes the handle as an optional argument and builds today's
  graph, byte for byte, without one.** A page without the flag passes none, so
  its three materials are today's in pixels, in pipelines and in WGSL. Package
  W's done command holds that by hash. The scene components pass the handle
  only when `engine.cloudsAvailable`.

| Object                                                | Material                                               | What it takes                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| The ring                                              | `createRingMaterial`, `render/planet.ts:834`           | Alpha-blended: `color·T + light·alpha` under the light in front of it, which its blend must not darken (plan §5.6) |
| Plumes                                                | `render/plumes.ts`                                     | Additive: `color·T`                                                                                                |
| The entry trace                                       | `createEntryTraceMaterials`, `render/entryTrace.ts:31` | Additive: `color·T`                                                                                                |
| The flare, the warp, the orbit traces, the staged sky | —                                                      | Nothing: lens effects and instruments read no cloud (plan §5.6); the flare's dimming is phase 2's `cloudSunlight`  |

- Each reads three trace textures through the `TextureFollower`
  (`cloudFront.ts:50-76`), which swaps the bound texture at each draw.
  `rings.gpu.test.ts`, `plumes.gpu.test.ts` and `entryTrace.gpu.test.ts` gain
  the case with a handle.
- **The cost is three reads a fragment under the flag,** and the plumes
  overdraw. It has no figure. The `targets` batch records one stance with a
  ring in frame and one with a plume, if phase 0's stances have either;
  otherwise package W's report says the cost is unmeasured.
- **These objects are on the over-clouds layer and draw in pass B,** after
  the frame node has run the trace (`render/cloudOverPass.ts`,
  `render/cloudLayers.ts`), so the knots they read are this frame's. Their
  marks are the scene's own, `markOverClouds` in `scene/Bodies.tsx` (the
  rings), `ThrusterFx.tsx` and `EntryTrace.tsx`, and package W changes no
  order.
- **An object that reads the knots is one that draws over the clouds,** so a
  frame holding one always has pass B, and §4.12's chain form never has to
  serve it. `markOverClouds` is where package Y counts what is in view.
- `createRingMaterial` is the one function of `planet.ts` this phase edits.
  The sphere's material in the same file is not touched (§2.4).

### 4.10 The composite's form: the identity, everywhere

Phase 0's rule allows the thin form only in a regime where its error against
the identity is under 1% at the 95th percentile and under 5% at worst (phase 0
design §8.7), and the rubric makes that a gate on the verdict commit (row
20). The landed `error` batch decided it:

| Scenario        | Thin's error at the 95th percentile | At worst       | Allowed |
| --------------- | ----------------------------------- | -------------- | ------- |
| `orbit`         | 0.1%                                | 0.4% to 1.8%   | Yes     |
| `sunset`        | 27.4% to 31.6%                      | 100%           | No      |
| `fog`           | 4.2% to 4.9%                        | 10.0% to 15.4% | No      |
| `horizon-2.4km` | 3.2% to 3.7%                        | 17.8% to 20.5% | No      |

**The thin form is allowed from orbit and nowhere else, and phase 1 does not
use the allowance.** The identity draws every pixel of every clouded body.

- **It buys no cost.** The two forms are one fragment: the thin form is the
  identity with its blocked-air term selected to zero and its air taken to
  the cloud's mean depth where the identity takes it to the ray's end
  (`render/cloudComposite.ts`, the `thin` select). There is no cheaper
  shader to switch to.
- **It buys no picture.** Where it is allowed it is within 0.1% of the
  identity.
- **It would need a boundary on the way down.** A regime that draws thin from
  orbit and by the identity below hands over somewhere on G6's descent, and
  C1 allows no switch that can flip between two frames. A band that fades
  between two forms 3% apart is work that buys nothing.
- **The evidence for "from orbit" is one stance at one sun,** 4.4° up (phase
  0's council). Using the allowance would need more of it. Not using it needs
  none.

**The second body draws by the identity too.** As landed its far march is
composited through the thin form always, with no blocked air and its air
taken to the cloud's mean depth (`cloudComposite.ts`, the second body's
branch), in a geometry no `error` scenario holds: a distant disk seen
through the served body's near air. Row 20 lets a regime draw thin only
where its error passes on the verdict commit.

- Package N gives the second body's term the identity's form: the air to the
  ray's end, and the far march's blocked air. Whether `CloudFarResult`
  carries the blocked air to the composite's fragment is the package's first
  reading; where it does not, `FarMarch` returns it.
- **The `error` batch gains the two `pair` stances** (§7.2), thin against the
  identity for the second body's term, so the record holds what the landed
  form cost in error. It decides nothing: the identity draws either way.
- If the identity's second body costs more than the protocol's resolution on
  `pair-moon` and `pair-neighbor`, the figure is recorded against B6. It is
  not a reason to draw thin unmeasured.

**What stays of the thin form** is the `composite` lever's `'thin'` value, a
measurement control (§4.6). Row 20 is read from the `error` batch on the
verdict commit, at both sizes with Enhanced off and on, and it holds while no
regime of the shipped game draws through the thin form. If a later phase
wants the allowance, it brings the evidence and the band.

**One column of that batch is not evidence.** Its display-referred pair, two
screenshots, contradicts its own meter: `horizon-2.4km` at Retina has every
pixel over 3% where the meter puts 2.9% of texels over 5%, and from orbit
with Enhanced off the pair differs by 0.068 to 0.111 in display RMSE where
the residual says 0.1%. The pair is taken under a meter that settles between
the two shots. Package Q takes it at a held exposure or drops the column
(§7.2).

### 4.11 How the contracts land on a system that is already built

Phase 0's contracts were additions under stubs. Phase 1's replace members of a
system that is built, wired and tested, and their consumers are files the
contracts package does not own: thirteen reads of `uniforms.layers` in
`render/cloudDensity.ts:99-119, :200, :329` alone, eight literals of
`CloudMedium`, fifteen files naming the `scenario` lever, nine of them GPU
tests. Three means keep every wave's gate green.

**1. Authority for mechanical propagation.** The contracts package may edit
any cloud module and any cloud test to carry a contract change that is
mechanical: a rename, a moved path, a neutral member added to a literal, a
union widened. Each is its own commit naming the contract, as integration's
fixes are. Nothing in such a commit changes what is drawn.

**2. Construction behind factories.** `render/cloudField.ts` and
`cloudSystem.ts` are where every module is constructed, and they belong to
integration. The contracts package takes both for their construction sites,
and `cloudSystemRig.ts` with them, and moves each module's construction into a
factory in the module's own file: `createCloudPhase(deps)` in `cloudPhase.ts`,
and likewise the maps, the clipmap, the profile, the sun's depth and the far
field. A later package changes its module's constructor and never opens
`cloudField.ts`.

**3. Bridges, each with the package that removes it.** Where a change is not
mechanical, the new member lands beside the old one, drawing phase 0's
picture, and one named package completes it.

| Contract                                                 | The contracts package lands                                                                                                                                                         | Completed by                                      | Old member removed by                                                                                                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CloudUniforms.layers` (`cloudUniforms.ts:91-103, :153`) | Moved to `served.layers` and `second.layers`, every reader's path changed; no member removed; §4.2's new members added at neutral values; both bodies written from the one scenario | H writes each body's own; F reads the new members | F deletes `coverage` and `genus`. `base`, `top` and `sigmaScale` stay: `layerAt` reads the first two (`cloudDensity.ts:99-119`) and the volume's encoding the third (`cloudVolume.ts:383, :531`) |
| `CloudMedium.depth`                                      | Required, `vec2(0)` in each literal (`cloudDensity.ts:234-240, :372-378`, `cloudMarch.ts:198-205`, `cloudVolume.ts:417`, four tests)                                                | F                                                 | —                                                                                                                                                                                                |
| `CloudSun.depth`, `octave`                               | Added at `cloudSunlight.ts:89-98`: `vec2(0)`, and `octave` returning `cloud`                                                                                                        | M1                                                | —                                                                                                                                                                                                |
| `CloudPhaseNodes.phase`                                  | Beside `droplets(nu, radius)`, delegating to it with a gain of one                                                                                                                  | T1 implements it; M1 and X call it                | N deletes `droplets`                                                                                                                                                                             |
| The lever `scenario` → `weather`                         | Renamed in all fifteen files                                                                                                                                                        | —                                                 | —                                                                                                                                                                                                |
| `CloudResetReason`                                       | Gains `'field'` and `'picture'`; `'key'` and `'motion'` still fire                                                                                                                  | H makes the split and stops `'motion'`            | H, with the two readers `cloudSunCascades.ts:444` and `cloudHistory.gpu.test.ts:1138`                                                                                                            |
| `CloudFrame.scenario`                                    | Kept. `CloudBodyFrame` gains `weatherKey` and `levels`, filled by a stub from the scenario; every bake's restart reads `weatherKey`                                                 | H derives them from `bodyWeather`                 | N deletes `scenario`                                                                                                                                                                             |
| `writeScenarioPattern` (`cloudMaps.ts:211`)              | Its call moves from `cloudField.ts:136` into `CloudMaps.write(frame)`                                                                                                               | F                                                 | F, with the side bundle                                                                                                                                                                          |
| `trace.wind` (`cloudUniforms.ts:147, :497`)              | `trace.turn`, three rates, beside it                                                                                                                                                | H                                                 | H                                                                                                                                                                                                |
| `CloudTraceDeps` (`cloudTrace.ts:106-125`)               | Gains `sky`, `source` and `jitter`, wired in `cloudField.ts` to the stub modules                                                                                                    | T2, M2, T3                                        | —                                                                                                                                                                                                |
| The served air's tables (`cloudUniforms.ts:328`)         | One object in place of three positional arguments                                                                                                                                   | T2 adds its table                                 | —                                                                                                                                                                                                |
| `engine.cloudFront` (§4.9)                               | The handle, written each frame                                                                                                                                                      | W reads it                                        | —                                                                                                                                                                                                |

**The state between waves.** At every wave's merge the gate is green and so
are the package's own GPU tests and four more that stand for the system:
`cloudSystem`, `cloudWarm`, `cloudSensor` and `cloudSecondBody`. The bridges
are what make that possible, and the orchestrator runs those four after each
merge. The full GPU suite is required at integration.

**The frame's derivation is package H's.** `render/cloudFrame.ts` turns a
`BodyWeather` into the numbers the uniforms copy. Its shape:

```ts
/** What the field needs of time for one body: nothing unreduced. */
export interface FieldClock {
  /** Each level's turn about the spin axis, radians in [0, 2π), reduced in float64. */
  readonly turn: readonly [number, number, number]
  /** The drift along the axis, meters, unreduced: every consumer reduces it by its own period. */
  readonly drift: number
  /** Seconds from J2000, for a regime's pattern period alone. */
  readonly time: number
}
export function fieldClock(weather: BodyWeather, time: number): FieldClock

export interface CloudLevelFrame {
  /** Meters over the datum. */
  readonly base: number
  readonly top: number
  /** Reference σ′, 1/m; reference effective radius, µm, and the level's least and greatest. */
  readonly sigma: number
  readonly radius: number
  readonly radiusRange: readonly [number, number]
  /** 1/(1 − f_δ) and 1 − g′ at the reference radius. */
  readonly gain: number
  readonly transport: number
  readonly cell: number
  readonly erosion: number
  readonly profileRow: number
  readonly phaseRow: number
  readonly phaseRows: number
  /** R_y(−ω·t), row-major, and ω itself for the history. */
  readonly turn: readonly number[]
  readonly turnRate: number
  /** Reduced in float64, meters. */
  readonly noiseOrigin: Vec3
  readonly detailOrigin: Vec3
}
export interface CloudBodyFrame {
  // … as built (`cloudFrame.ts:81-118`) …
  /** The weather's identity: a regime's id, or 'climate'. A change is a `'field'` reset. */
  readonly weatherKey: string
  readonly levels: readonly [CloudLevelFrame, CloudLevelFrame, CloudLevelFrame]
  /** The climate's law or the regime's pattern, as §4.2's uniforms take them. */
  readonly climate: CloudClimateFrame
}
```

Package H builds against the contracts' stub of `bodyWeather`, which returns a
regime, and meets package D's real one at the wave's merge.

**The stand-ins' new parameters.** `slabMedium` and `CLOUD_STAND_INS`
(`render/cloudNodes.ts:309-347, :462-537`) are the contracts package's, and
packages M1, M2 and X test through them. They gain: a `radius` that may be a
function of altitude, for the mixed-radius cases; the slab's `depth`, which is
analytic; a `gain`; and an exact sun for a slab, `exactSlabSun(slab)`, beside
the shipped `cloudSunFn`, because the gates run with each (§7.4).

**Which numbers are in which depth.** The scaled medium changes every constant
that is compared with an optical depth or encodes one. The contracts package
records each in the constant's own comment:

| Constant                                                                     | Where                               | After phase 1                                                                                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `STEP_DEPTH = 0.3`, `EXIT_TRANSMITTANCE = 0.01`, `FRONT_TRANSMITTANCE = 0.5` | `cloudMarch.ts:113, :117, :124`     | Scaled: they describe what is drawn                                                                                                          |
| `KNOT_TRANSMITTANCE = 0.98`                                                  | `cloudKnots.ts:52`                  | Scaled                                                                                                                                       |
| `CLOUDY_TAU = 0.1`, under which the far bake calls a sub-column clear        | `cloudFarAtlas.ts:152, :402`        | **Unscaled.** At a scaled 0.1 the `cirrus-over-cumulus` cirrus, 0.12 unscaled, would leave the far field while the fine march still draws it |
| The far field's 8-bit code of `log₂(1 + τ)`                                  | `cloudFarAtlas.ts:158-173`          | **Unscaled** `τ` is encoded; the far march multiplies by the level's `1 − f_δ` after decoding. Its 2.5% steps then sit where they sat        |
| The sun grid, through the volume it sums                                     | `cloudSunGrid.ts`, `cloudVolume.ts` | Scaled: it sums `σ′`                                                                                                                         |
| The calibration, `columnDepth`, ISCCP's classes                              | §5.2                                | Unscaled                                                                                                                                     |

### 4.12 The over pass, and placement C

**What the campaign found.** Under placement A the composite and everything
drawn over the clouds are a second render of the scene into the scene's own
target, `scene over clouds` on the timeline (`render/cloudOverPass.ts`). At
Retina it is the largest cloud cost in the frame, and at 1080p the second,
behind the trace at four taps (landed, steady, ms; the empty split is campaign
1's, the only place B was measured):

| Stance                              | 1080p: the clouds' Δ | Of it, `scene over clouds` | Retina: Δ        | Of it, `scene over clouds` |
| ----------------------------------- | -------------------- | -------------------------- | ---------------- | -------------------------- |
| `horizon`                           | 5.67                 | 1.52                       | 7.70             | 3.88                       |
| `inside`                            | 5.07                 | 2.08                       | 7.70             | 5.05                       |
| `decks`                             | 7.55                 | 2.19                       | 9.79             | 5.32                       |
| `orbit`                             | 3.03                 | 1.84                       | 5.54             | 4.45                       |
| The empty split, B with nothing run | 1.04, 0.98, 1.02     | —                          | 2.45, 2.42, 2.49 | —                          |

- **From orbit the trace is 0.09 ms and the over pass 1.84.** B4 is 1.6 ms,
  and the pass alone spends it.
- **B10 fails on this pass and nothing else.** Retina's Δ is to be within
  0.5 ms of 1080p's and is 1.8 to 2.6 ms over. The over pass grows by 2.4 to
  3.0 ms between the sizes, and the trace falls (2.45 to 2.19 ms on
  `horizon`), because the ray budget is held.
- **The price is the target's bytes.** The empty split is the break with
  nothing drawn: 1.0 ms at 1080p and 2.45 at Retina, 2.4 times, on a target
  with 2.5 times the pixels.

**What the break moves.** At the default picture the scene's target is
multisampled four times (`render/picture.ts:36, :84`) and holds `output` and
`motion` in RGBA16F, `meterMask` in R8 and a float depth
(`render/sceneLayout.ts:93-105, :132-146`): 21 B a sample, 84 B a pixel. Three
stores every attachment at every pass's end, binds each multisampled color
with its resolve target, and loads every attachment when `autoClear` is off
(`WebGPUBackend.js:672-688, :870-878, :908-916`, three 0.185.1). So the break
between pass A and pass B adds, a frame (**D**):

| What the break adds                                      | Bytes a pixel | At 1920 × 1080 | At 1440 × 900, DPR 2 |
| -------------------------------------------------------- | ------------- | -------------- | -------------------- |
| Loaded at pass B's start: every sample, every attachment | 84            | 174 MB         | 435 MB               |
| Stored at pass B's end: the same                         | 84            | 174 MB         | 435 MB               |
| Resolved a second time: three colors                     | 17            | 35 MB          | 88 MB                |
| **Total**                                                | **185**       | **384 MB**     | **959 MB**           |

Under the temporal picture the target has no samples and gains `reactive`:
25 B a pixel, 50 B a break, 27% of this (**D**). No campaign row is at that
picture, and the batch below takes one.

**What has to survive the break.**

| What                                | Does pass B need it?                                                                                                                                                                                   | Does anything read it after pass B?                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `output`, four samples              | An overlay does: it blends over the scene by the sample. **The composite does not.** Its fragment runs once a pixel with one transmittance and one light, so `resolve(dst·T + L) = resolve(dst)·T + L` | Only resolved. The stored samples have no reader                                                                   |
| `motion`, `meterMask`, four samples | Only where an overlay's blend reads the destination (`over` and `max`, `sceneLayout.ts:93-100`)                                                                                                        | Only resolved                                                                                                      |
| Depth, four samples                 | Yes, read-only, to test the overlays against the scene                                                                                                                                                 | **Not read for this design:** whether the optics read it after pass B, and whether the entry trace's inks write it |
| Pass A's own resolve                | No. Nothing between the two passes reads a resolved color: the sea's copy is taken at the sea's own break, inside pass A (`render/seaReflection.ts:236-250`), and the trace reads depth                | —                                                                                                                  |

So on a frame with no overlay all 185 B are carried for no reader, and on a
frame with one, 84 of them are.

**What phase 1 builds: two forms, behind the `over` lever.** Package Y.

1. **`chain`: the composite is a term of the sensor's chain on a frame with
   nothing drawn over the clouds.** The frame then has one scene pass and no
   break.
   - **The count is the scene's own marks.** `markOverClouds`
     (`render/cloudLayers.ts`) registers what it marks. In `beginFrame` the
     system asks whether any registered object is visible, by its own flag and
     its ancestors'. The frustum is not tested, so an overlay behind the
     camera keeps pass B, which is the safe side.
   - **With none in view,** `scenePass.setLayers(null)`, `overPass.active` is
     false, and the chain's term draws `scene·T + L` over the resolved
     `output`, after the scene's term and before the upscaler, where
     `CloudOverPassNode` sits today.
   - **The two forms are one function,** `compositeOver` in
     `render/cloudComposite.ts`: in pass B the mesh's blend applies it, and in
     the chain a node does. A GPU test draws one frame through each and holds
     them within one half-float step. A blend cannot floor `scene − air`, so
     §5.1's split of a sky pixel is `dst·T_point + air·(T′ − T_point)` in pass
     B and the floored form in the chain, equal wherever a pixel holds at
     least its own air; the test's frame is such a frame.
   - **Both are compiled at boot.** `cloudWarm.gpu.test.ts` holds the first
     frame of each form, and the frame on which one gives way to the other,
     to no new pipeline.
   - **What flips is the frame's cost, not its picture.** When a plume lights
     or the flare enters the frame, pass B returns and the frame pays the
     break. The step detector reads the cast across such a frame (§8.1).
   - **What the composite writes beside `output` has to reach its readers.**
     Package Y's first reading is the composite's outputs to `motion`,
     `meterMask` and, under the temporal picture, `reactive`, and each
     reader's input (`render/sensor.ts`, `upscale.ts`, `defocus.ts`,
     `motion.ts`). Where a reader can take a node in place of the attachment,
     the chain form supplies it. Where it cannot, the chain form is not
     offered at that picture and pass B stays; the report says at which.
2. **`lean`: pass B stores its samples once.** Its color attachments take
   `storeOp: 'discard'` under their resolve targets, which resolves and then
   drops the samples, and its depth is read-only when nothing on the layer
   writes depth. The break then adds the load and the one resolve the frame
   needs, 101 B a pixel where it adds 185 (**D**), and no pixel moves.
   - **The reach into three is one call.** The descriptor is three's own,
     built in `beginRender` and handed to `beginRenderPass` in the same call
     (`WebGPUBackend.js:826-940`). The sea's split already holds that call on
     an encoder it has in hand, and the pass timeline names each pass from
     inside it (`render/seaReflection.ts:236-250`, `render/passTimeline.ts`).
     Pass B's encoder is made inside the same `beginRender`, so package Y's
     premise spike finds where the edit can stand: on the timeline's own hook
     if every frame has it, or on a hold of the device's `createCommandEncoder`
     for pass B's one render.
   - `cloudOverPass.gpu.test.ts` holds a frame equal with the edit on and off,
     and the timeline's names unchanged.
   - **If the spike cannot reach the descriptor without patching three,**
     `lean` is not built, and the report says what three would have to expose.

**What the composite's tests do not hold today, and package Y adds** (phase
0's council). Y builds a second form of the composite, so the first has to
be pinned before it:

| Unheld today                                                                                                                                          | The test Y adds, in `cloudComposite.gpu.test.ts` unless named                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Every case sets the render compression to 1, and from orbit it is not                                                                                 | One slab at orbit's compression draws the frame the uncompressed case draws, within a half-float step                             |
| Its only air has no in-scatter, and no always-on test calls `compositeAir`: the identity's `(1 − T_c)·L_a(0, t₁)` can be deleted and the suite passes | One slab in an in-scattering air, held within 1% of the joint march `cloudCompositeError` uses. Watched failing with the term out |
| No test draws the real composite with a marked overlay                                                                                                | `cloudOverPass.gpu.test.ts`: a marked mesh in front of a slab and one behind it, through the system's own composite               |
| No test compares a frame after the clouds are turned off with one that never had them                                                                 | `cloudSensor.gpu.test.ts`: on, then off, then a frame equal to the chain without clouds                                           |

**What phase 1 does not build.**

- **The overlays in a target of their own:** cleared, not loaded, testing
  against the scene's depth, merged in the chain after the composite. It
  removes the 84 B load as well. It needs a second pipeline for every overlay
  material, since the target's layout differs, and a merge for `motion` and
  `meterMask`. It goes to phase 2's design with the batch's figures, and only
  if the rule below says the pass is still dear.
- **Placement C, riding the sea's split.** Phase 0's rule sends it here: the
  empty split costs 10 to 25 times the 0.1 ms under which C could not pay
  (phase 0 design §4.2, §8.7). Reconsidered, it is still not built:
  - **It saves one break, and only where the full sea is in view.** Neither of
    the rubric's steady rows stands on such a frame: the ground row is dry,
    and the split belongs to a sea sheet under `sea: full` (the pipeline map
    §11.4), which a frame from 400 km does not hold. That last is the map's
    reading, not re-read here; the `over` batch's `orbit` row shows it by
    whether the timeline holds a resumed pass. C moves no budget row.
  - **`chain` saves the same break on the same frames,** and on every other
    frame with no overlay, with no encoder work.
  - **Its mechanism is B's,** the cloud passes encoded inside a held
    `beginRenderPass`, which the landing deletes with `cloudSplit.ts`. C would
    bring it back beside A: two placements in one frame loop, chosen by
    whether a sea sheet is in view, with the composite the first opaque of
    pass B on one side of a shoreline and a transparent in the sea's resumed
    pass on the other.
  - **It reads a depth from before the sea's own write**
    (`render/water.ts:337`; the pipeline map §11.4): right for a cloud over
    water, wrong for phase 4's fog on it.
  - ADR-0074 records the reconsideration with the batch's figures.

**The measurement** is the `over` batch of §7.2, and its rules are §7.4's.

**B11 is `lean`'s row.** The steady Δ on `overlay`, `horizon`'s pose with
the engine lit, is to be at most 1.0 ms over `horizon`'s. With `chain` on
`horizon`, that difference is the whole price of pass B: the break, the
second traversal and the plume's own fragments. The break alone is 1.0 ms
(the empty split), so `passes` as landed cannot hold the row and `lean` has
to. If `lean` cannot be built, or leaves the difference over 1.0 ms, B11 is a
declared miss with its figure in ADR-0074, and the overlays' own target goes
to phase 2's design.

**Placement A stands as an exception, and one cell can send it back.** By
phase 0's rule as written (§8.7 there), A loses if its `sensor` mean exceeds
B's by more than 0.3 ms on any of three stances at either size. At Retina
inside a cloud it does, in all three samples: 10.71, 13.63 and 11.57 ms
against 9.20, 10.12 and 6.93, which is 1.51, 3.51 and 4.64 ms over, at two
presentation rates. ADR-0063 keeps A as the exception the rule allows with
figures: the GPU cost is equal, the frames delivered are equal (132, 133, 132
against 130, 131, 130), A has no more late frames, the 1080p cells show no
difference, and B draws the opaque instruments under the clouds and reaches
under three's surface.

- **What the excess would be, if it is real,** is pass B's second
  `renderer.render`: a second traversal, cull and sort of the scene on the
  CPU. `chain` removes that render on a frame with no overlay, so from here
  the question is only about a frame that has one.
- **The `over` batch takes the cell at one rate:** the `sensor` span and the
  frames presented at Retina on `inside` and on `overlay`, nine samples a
  side at a held 60 Hz, for `passes`, `chain` and `lean` (§7.2).
- **What sends the placement back** is §7.4's rule: evidence that pass B
  costs a frame, where phase 0 had evidence only that it costs CPU time.
- **What going back costs.** B exists at `25df44ab`. With `chain` in place B
  would serve only a frame that has an overlay, in place of pass B: the split
  after the sea's sheet and its test restored, the scene's marks turned back
  into draw orders, the plumes and the entry trace given an order past the
  composite's, and `lean` dropped, since a split's first half must store what
  its second loads. That is one package of about 1,200 lines (**E**, from
  the split's landed size and the seven scene components), one window of
  about an hour and a half for the `over` batch and the placement's cells
  again, and ADR-0063 superseded. It also brings back what B was declined
  for: the entry trace's opaque inks under the clouds, and a swap of three's
  encoder.
- **A against B itself can be taken again only where both exist,** at
  `25df44ab`, from a worktree at that commit: about ten minutes at a held
  rate. The orchestrator has declined it for now, and the commit stays in
  the branch's history. Phase 1 rebuilds neither B nor C to measure them.

---

## 5. The physics, with its references

Symbols: `σ` a droplet population's extinction, 1/m, at `Q_ext` from Mie; `σ′`
the scaled extinction the renderer forms transmittances from; `τ`, `τ′` their
optical depths; `μ₀` the sun's cosine over the local horizontal; `ν` the cosine
between the sun and the view, fixed along a ray; `p` a phase function, sr⁻¹,
integrating to one; `g` its asymmetry.

### 5.1 The medium is the scaled one

A droplet far larger than the wavelength scatters half its light by
diffraction, into a cone a degree or two wide. That light goes on almost where
it was going. Counting it as extinction makes a thin cloud twice as opaque as
it looks, puts the sun's light out twice as fast as it dims inside a cloud,
and leaves the higher orders carrying a sharp angular structure no cheap term
can hold.

**The medium is defined as a phase function, and one definition serves the
renderer and its oracle.**

```
f_δ = 1/Q_ext                                  the diffraction's share of extinction
σ′  = (1 − f_δ)·σ                              what every transmittance is formed from
p′  = (p − f_δ·p_diff)/(1 − f_δ)               the medium's phase; albedo one
g′  = (g − f_δ)/(1 − f_δ)                      its asymmetry
```

- `f_δ = 1/Q_ext` because diffraction has an efficiency of one (**D**,
  Babinet). On the committed table `Q_ext` runs from 2.27 at 2 µm to 2.04 at
  32 µm (measured; phase 0 package report, WP2), so `f_δ` is 0.44 to 0.49 and
  `g′` runs 0.68 to 0.77 (**D**).
- `p_diff` is the Fraunhofer pattern of a disk, averaged over the row's size
  distribution. The generator computes it beside the Mie series
  (`apps/ingest/src/mie.ts`), clamps `p′` at zero where the subtraction dips
  under it, renormalizes, and reports the clamped share a row.
- **This is not the oracle's own truncation.** Delta-M removes the first
  truncated moment, which depends on the stream count: about 0.33 to 0.36 at
  10 µm and 64 streams, and about 0.17 at 128 (the physics critique's finding
  5, **D** there, from Korkin et al. 2012, **W**). Draft 1 called both "the
  scaled problem" and indexed the slab table by one depth while the oracle's
  field lived in another. Now the oracle is handed `p′` and `τ′` and solves
  the renderer's medium as a problem in its own right, with whatever numerical
  truncation it likes inside; and it is handed `p` and `τ` and solves the true
  one (§5.11).

**First-order light keeps the unscaled source and the exact phase:**
`σ·p(ν) = σ′·p(ν)/(1 − f_δ)`, attenuated by scaled depths both ways. Outside
the diffraction cone this is exactly the scaled medium's own first order,
since there `p = (1 − f_δ)·p′`. Inside the cone it adds the diffraction light
a second time. That is the single-scattering correction of Nakajima and Tanaka
(the form is confirmed at Korkin et al.'s equations 8 and 10, **W**): the exact
phase, the scaled depth, and `ω/(1 − fω)`. It keeps the glory, the bows and
the corona at the table's angles.

**Higher orders are the scaled medium's,** every order past the first of
`(p′, τ′)`, which is smooth because the diffraction peak is not in it (§5.5).

**One medium for every extended thing.** The trace, the knots, the far bake,
the sun's depth and, in phase 2, the shadow on the ground all read `σ′`. Under
a cloud 1.5 km up the diffraction light lands within 40 m of where the beam
would (**D**: 1.5 km at 1.5°), so a ground's shadow, the shadowed air and
terrain seen through cloud from orbit all take `σ′` correctly.

**A source narrower than the blur takes the unscaled transmittance.** The
sun's 0.53° disk, a star and the flare are narrower than one deflection and
far behind the cloud. Their true transmittance is `e^(−τ)`; `e^(−τ′)` is too
bright by `e^(f_δ·τ)`, 12 times at `τ = 5` and 134 at 10 (**D**), which would
draw a sharp sun through an overcast.

- A reader that dims such a source raises the cloud's transmittance to the
  gain: `T_point = T′^(1/(1 − f_δ))`.
- **In phase 1 that reader is the composite, on sky pixels.** A sky pixel's
  scene is the air along the ray plus whatever celestial source stands behind
  it. The composite already reproduces that air (`render/cloudCompositeAir.ts:222`),
  so it splits the pixel: the air takes `T′`, and what is left of the scene
  after the air, floored at zero, takes `T_point`. Where there is no cloud
  both are one and the frame is the scene bit for bit, as now. Package N adds
  it, with the test: a point source behind a slab reads back at
  `e^(−τ′/(1 − f_δ))`, and a sky with no source is unchanged.
- **In phase 2** `cloudSunlight` has two forms for the same reason (§0.4):
  irradiance on a surface takes `T′`, and the disk the flare draws takes
  `T_point`.

**Which constant is in which depth** is §4.11's last table: the far bake's
clear cut and its 8-bit code stay on the unscaled depth, and the genus table,
the calibration and ISCCP are unscaled throughout. ISCCP retrieves `τ` at
`Q_ext ≈ 2`, and `columnDepth` (§4.2) returns that.

**Declared.**

- **Inside the diffraction cone the diffraction half is counted twice,** as
  unscattered and in first order. The cone is `0.61·λ/r_e` wide: 0.6° at
  32 µm, 1.9° at 10 µm and 9.6° at the table's 2 µm row (**D**). In
  transmission the excess is `(f_δ/(1 − f_δ))·(τ′/μ₀)·e^(−τ′/μ₀)` of the
  incident flux, up to 35% of it at `τ′ = μ₀` (**D**). With the disk on
  `T_point` the aureole's excess over the true one falls to
  `f_δτ/(1 − e^(−f_δτ))`, 1.27 at `τ = 1` (**D**). The correction is the same
  paper's second step and is not built.
- **The glory's contrast is about twice the real one.** Scaled first order is
  `1/(1 − f_δ)` times the truly single light, and the added half has crossed
  a diffraction event on the way, a blur as wide as the ring itself (**D**).
  The oracle's correction shares the error; only the Monte Carlo on the true
  medium shows it, and package R1 records the ratio (§5.11).
- **Detail narrower than the blur stays crisp to twice its true range.**
  Contrast is carried at `e^(−σ′d)` for detail wider than the blur and at
  `e^(−σd)` for detail narrower (the physics critique, on WMO No. 8's
  collimated beam, **W**). The renderer cannot blur, and `σ′` is right for
  every shape in a frame: a hull, a wing, a gap, another cloud. A strut or a
  panel line is drawn to `3.912/σ′` where a real one is gone at half that.
- **Visibility inside a cloud is `3.912/σ′`** for those shapes: about 110 m at
  the plan's 68 km⁻¹ for continental cumulus and 145 m at the marine 52 the
  genus table uses on every body in phases 1 and 2 (**D**:
  `3.912/(0.52·0.052)`). §8.5 measures it, in a uniform medium, where the
  rubric's row 21 holds it.

### 5.2 Density is water

**The law.** `σ = 3·LWC/(2·ρ_w·r_e)` (plan §5.1). A cumuliform cloud's water
grows with height over its base, `LWC(z) = s·f_ad(z)·Γ_ad·z`, with
`f_ad = z₀/(z₀ + z)`, `z₀ = 500 m` and `Γ_ad = 2 g m⁻³ km⁻¹`. Its droplets
number `N`, so `r_e = (3·LWC/(4π·ρ_w·k·N))^⅓`, with `k` the distribution's
breadth, 0.80 for marine and 0.67 for polluted stratocumulus. The physics
critic read those constants at their sources (Wood et al. 2009 and Wood 2000,
**W**); the package transcribes them with the page. Then

```
σ(z) ∝ LWC(z)^⅔ · (k·N)^⅓        r_e(z) ∝ LWC(z)^⅓ · (k·N)^−⅓
```

A check of the law's size (**D**): at `z = 500 m`, `s = 1`, `N = 74 cm⁻³`,
`k = 0.80`, `LWC` is 0.5 g m⁻³, `r_e` is 12.6 µm and `σ` is 59.5 km⁻¹, beside
the plan's 52 for marine cumulus. So the formula is the measurement's order.

**The genus table** (`weatherGenus.ts`). A genus is a phase class, a growth
rule, an edge shape, a cell size, an erosion, its mean in-cloud extinction and
the range of thickness a layer of it may have:

| Genus             | Class    | Water with height             | Mean in-cloud `σ`, km⁻¹ (plan §5.1) | Thickness a regime may give it |
| ----------------- | -------- | ----------------------------- | ----------------------------------- | ------------------------------ |
| Stratus           | Droplets | Adiabatic, capped at its mean | 57 continental, 40 marine           | 200–700 m                      |
| Stratocumulus     | Droplets | Adiabatic                     | 35                                  | 200–500 m                      |
| Cumulus           | Droplets | Adiabatic                     | 68 continental, 52 marine           | 200–1,500 m                    |
| Altostratus (new) | Droplets | Flat                          | 20–40                               | 300–1,500 m                    |
| Altocumulus       | Droplets | Adiabatic                     | 20–40                               | 100–400 m                      |
| Cumulonimbus      | Droplets | Adiabatic                     | About 93                            | To the level's top             |
| Cirrus            | Ice      | Flat                          | 0.05–0.5                            | 0.5–2 km                       |
| Fog               | Droplets | Flat                          | 8.1                                 | To the ground                  |

- **The extinction is the genus's, and the thickness is what yields.** A
  genus's mean `σ` sets how a cloud looks from inside and how its edge lights,
  so it is held to the plan's measured figure. The sub-adiabatic share `s`
  follows from it, and what the calibration below is free to move is a
  regime's layer thickness, inside the genus's range, and its cover. Draft 1
  moved `s` instead, which meets ISCCP's cumulus class only at a mean `σ` near
  20 km⁻¹, under half the genus's own figure, with a visibility inside near
  400 m (the physics critique's finding 11, **D** there).
- The profile's shape is `edge(h)·w(h)^⅔`, `w` the water's growth normalized
  over the level and `edge` the rise and fall `genusProfile` draws today
  (`weatherScenario.ts:393-424`). The radius's shape is `w(h)^⅓`. Both go into
  the profile table (§4.3), so a base is thin and small-dropped and a top
  dense and large-dropped from one rule.
- `N` is the marine 74 cm⁻³ on every body in phases 1 and 2. The continental
  288 needs a land mask in the maps, which is phase 3's.

**Calibration to ISCCP's classes** (package G, a Node test, no GPU). ISCCP-H
retrieves on pixels about 5 km across and samples them at about 10 km; its
type boundaries are `τ` 3.55 and 22.63; and it detects cloud in radiance, at a
visible threshold of 0.03 to 0.06 by surface, with no optical-depth floor
stated (C-ATBD, **W**, by the physics critique).

1. For each genus, lay a fixed lattice of columns at 500 m over a 100 km
   square of a regime of that genus at its typical cover: 40,000 columns, 100
   to each of 400 pixels of 5 km. `columnDepth` gives each column's unscaled
   depth. The lattice and the count are fixed so that sampling does not make
   the distribution: at twenty columns a pixel the cover's own spread is 0.107
   at a cover of 0.35 (**D**).
2. A pixel's reflectance is the mean of `R(τ_column)` over its 100 columns,
   clear ones at zero, with `R` the black-surface flux at `μ₀ = 0.7` from
   `slabReference.generated.ts` (§5.11). A linear mean of `τ` is the error
   plan §3 forbids.
3. A pixel is **detected** when its reflectance is 0.03 or more. A detected
   pixel's `τ` is its reflectance inverted through the same `R`.
4. A row passes only if at least half the genus's cloudy pixels are detected.
   That keeps a row from passing on a share of nothing: phase 0's
   `cirrus-over-cumulus` cirrus has a column of 0.12
   (`weatherScenario.ts:178-187`), which no visible threshold sees.
5. Assert the shares of detected pixels:

| Genus, at cover                     | Its detected pixels                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cumulus, 0.35                       | ≥ 90% at or under 22.63, and ≥ 30% under 3.55: ISCCP's cumulus is the low thin class, and a growing cumulus passes through all three (plan §5.1) |
| Stratocumulus, 0.9                  | ≥ 60% in 3.55–22.63                                                                                                                              |
| Stratus, 1                          | ≥ 90% over 3.55 and ≥ 30% over 22.63                                                                                                             |
| Altocumulus, 0.7                    | ≥ 60% under 3.55                                                                                                                                 |
| Altostratus, 1                      | ≥ 60% in 3.55–22.63                                                                                                                              |
| Cirrus, 0.5                         | ≥ 80% under 3.55                                                                                                                                 |
| Cumulonimbus, pixels at cover ≥ 0.9 | ≥ 60% over 22.63                                                                                                                                 |

6. Repeat at `μ₀ = 0.4`: no share moves by more than ten points.
7. Where `isccpZonal.generated.ts` carries a type's mean `τ`, the genus's
   radiatively averaged mean is within ISCCP's ±15% of it. This assertion
   skips while package E is not merged.

- **What the calibration solves** is each regime's layer thickness and cover.
  `fair-cumulus` at 1,400 m thick has a cell's column near 50 at the genus's
  52 km⁻¹ and cannot put 30% of its pixels under 3.55; at about 400 m it can
  (**D**: `0.35·R(τ)` inverts under 3.55 for a column near 10). So the regime
  becomes cumulus humilis, which is what "fair weather" means, and the
  cornerstones that hold it are re-taken; the record says so.
- **When a genus's range cannot meet its row,** the package stops and reports
  the pair of numbers. It does not widen a share or leave the range.
- **Fog has no row.** Its extinction is the plan's constant, so a test of
  `3.912/σ` tests a constant, and what the frame shows is `3.912/σ′`. Fog's
  physics and its test are phase 4's.

**The cells' sizes.** Cumulus fields follow a power law in cell size, `n(D) ∝
D^−2.19` by a direct fit on the area-equivalent diameter; line fits of the
same data give 2.85, or 1.88 and 3.18 either side of a break near 0.6 km
(Mieslinger et al. 2019's table, **W**, by the physics critique). A Node test
labels the connected cloudy cells of a 60 km square of `fair-cumulus` at 100 m
and fits the exponent by maximum likelihood on `n(D)`, `D` from 200 m to 2 km.
The bound is 2.19 ± 0.4 and is **to measure**. A thresholded noise is a power
law in island size only as a fractal: by Korčák's law `n(D) ∝ D^−(3 − H)`, so
2.19 needs a Hurst exponent near 0.8 held over the fitted range (**D**, same
critique). If the fit is outside the bound, the base noise gains octaves down
to 150 m at a gain of 0.57, in the bake, at no cost a step.

### 5.3 The climate, and the texture's motion

**A generated world's levels** come from its air's scale height `H`
(`packages/physics/src/rigidBody.ts:74-81`): low 0.08–0.30 `H`, middle
0.40–0.70 `H`, high 0.95–1.30 `H`. For Earth's 8.5 km that is 0.7–2.6, 3.4–6.0
and 8.1–11.1 km (**D**). Low is stratocumulus to cumulus, middle altostratus
to altocumulus, high cirrus.

**The zonal law.** Cover is a function of latitude `φ` and the season the sun
draws, the sub-solar latitude `δ`:

```
cover_k(φ) = base_k + itcz_k·G(φ − φ_I, w) − dry_k·[G(φ − φ_H, w) + G(φ + φ_H, w)]
                    + storm_k·[G(φ − φ_S, w) + G(φ + φ_S, w)]
convective_k(φ) = saturate(κ_k·G(φ − φ_I, w))
```

- `G` is a Gaussian in latitude. Three levels of four amplitudes and four
  shared numbers (`φ_I`, `φ_H`, `φ_S`, `w`) are the sixteen coefficients of
  `CloudClimateUniforms.law`; `κ` is its `convective`.
- `φ_I` follows the sun, `φ_I = ι·δ`. `φ_H`, the Hadley cell's edge, is 30° at
  Earth's rotation and widens as a body turns slower (Kaspi and Showman 2015,
  plan §4.3); the exponent is transcribed from that paper by package D (**M**),
  and the edge is clamped to 12–80°. `φ_S = φ_H + 20°`.
- The amplitudes are fitted so Earth's record gives the plan's quoted zonal
  offsets: 0.10 under the mean at 20°N, 0.15 under at 20°S and 0.15–0.25 over
  at 60°S (plan §4.2). When package E's zonal table exists
  (`isccpZonal.generated.ts`, §4.1), they are refitted to ISCCP-H's own zonal
  means, and the fit's residual is recorded.
- The law is multiplied by a synoptic field, `1 + ½·(n − ½)`, `n` the base
  noise on a lattice 1,000 km across, turning with the low level. A lattice
  that coarse may read an absolute direction (rule 58 binds fine ones).
- No land, no sea and no hour of the day enter. Those are phase 3's.
- Earth, forced, draws this law at its own rotation until phase 3.

**The texture turns; it does not drift.** Phase 0's drift is one vector for
every layer, starts over every hour, and the hour is a jump
(`packages/rendering/src/weatherClock.ts:28`, `render/cloudFrame.ts:467-472`):
a history restart and a far-bake restart once an hour of simulated time. On a
default path that is a step in every hour's cast.

**And phase 0's drift is the observer's.** The wind is built in the eye's own
tangent basis, `horizonBasis(eye)`, and the accumulated drift is that wind
times up to 3,600 s (`render/cloudFrame.ts:352-357, :375`);
`render/cloudDensity.ts:139` subtracts it from every sample. So at a held
time, moving the eye turns the whole lattice: the density at a fixed body
point changes with where it is seen from, by about 0.9 m/s of false drift at
250 m/s on far-shore V, and sharply near a pole, where the tangent basis
turns fastest. The history's reprojection cannot follow a motion that is not
in time. The plan asks for a pure function of `(body, place, renderTime)`,
the rubric's row 17 gates it, and every cast that moves the camera at a held
instant would read the defect as the field's (phase 0's council, two seats).

- **Each level's noise frame turns rigidly about the spin axis** at its own
  rate, `ω_k`, against the ground: a zonal wind `u = ω_k·a·cos φ`. A rigid turn
  of a lattice has no shear, is exact on a sphere at every latitude, and is
  defined for all time.
- **And drifts along the axis** at `w = 0.25 m/s`, so the slice of noise a
  level cuts changes. **Only away from the equator.** A translation along the
  axis is vertical at a pole and horizontal at the equator: a 1,200 m cell's
  shape turns over in 80 minutes at a pole, in `80/|sin φ|` minutes at
  latitude `φ`, fifteen hours at E1's 5° south, and never on the equator,
  where the pattern slides toward one pole unchanged (the physics critique's
  finding 21, **D** there). No still and no cast of this phase shows it; under
  warp the tropics are a rigid texture. It is declared, and it ends with phase
  4's advection. A drift vector that turned to follow the eye's vertical would
  fix it and break the float64 reduction, since the accumulated offset would
  then move with the eye.
- The lookup, for a body-fixed point `p`:
  `p′ = R_y(−ω_k·t)·p + ŷ·w·t`. On the CPU, `ω_k·t` is reduced by a turn
  (`reduceTurns`, `weatherClock.ts:57`) and the origin by the noise's period,
  in float64. On the GPU the lattice coordinate is
  `(noiseOrigin_k + M_k·offset)/cell`, with `M_k` the turn as a float32 matrix
  and `offset` the sample less the eye. The origin is `M_k·eye + ŷ·w·t`,
  reduced by `reducePoint` in float64 (`weatherClock.ts:88`). Rule 58 holds:
  the eye's term is float64 and the offset is eye-relative. At a 2,000 km
  limb the float32 matrix is 0.12 m wrong, and millimeters near the eye, at
  any date (the physics critique, **D** there).
- `ω_k` is the scenarios' winds as turns: 8, 15 and 25 m/s at the equator over
  the body's radius for the climate, and a regime's `wind.east` for all three
  of its levels. Its `wind.north` is not drawn.
- `CLOUD_ADVECTION_PERIOD`, the hourly jump and `driftOffset`'s restart go.
  `periodIndex` stays for the regimes' blob redraw, which no cornerstone uses.
- **Nothing in the lookup is the observer's.** The turn is about the body's
  spin axis and the drift along it, both in body-fixed axes. The eye enters
  only as the origin the float32 offset is measured from, and
  `M_k·eye + M_k·offset` is `M_k·p` for any eye. `horizonBasis` leaves the
  field's derivation in `cloudFrame.ts` (package H); it stays where a stance
  needs an east and a north.
- **Three tests hold it from two eyes.** In Node, `weatherField.test.ts`
  (package D): for any body point, instant and pair of eyes, the level
  frames built for each eye map the point to one lattice coordinate modulo
  the noise's period, to float64 rounding (**property**). In Node,
  `cloudFrame.test.ts` (package H): the same on the frame's own `turn` and
  `noiseOrigin`, with one eye at a pole. On the GPU, `cloudDensity.gpu.test.ts`
  (package F): the extinction at one body point and instant, read through
  `fieldMedium` from an eye 10 km off and from one 2,000 km off, is equal
  within one 8-bit step. Each is watched failing with phase 0's
  `horizonBasis(eye)` put back.
- **The drift's sign has a test of its own.** The landed history's oracle is
  built from the same `served.wind` the frame hands the kernel, so negating
  the drift passes (phase 0's council). The history's test takes its
  expected displacement from the CPU field, `cloudFieldAt` at `t` and at
  `t + Δt` (package H), and C7's cast measures the drawn field's displacement
  against the CPU turn's, sign and all (§8.1).
- Neyret's bounded advection, a wind that varies over the body and a new seed
  each period are phase 4's, with the wind field they need.

**What the turn costs.**

- **In the march:** three matrices in the level's uniforms and one multiply a
  noise read.
- **In the sun's depth: nothing new.** The volume holds the field in
  body-fixed texels, so a turning texture ages them, and the grid sums through
  the volume. The steady refresh already outruns the turn. The volume bakes
  eight slices a frame (`cloudSystem.ts`, `VOLUME_SLICES`), all 68 of its two
  levels in nine frames, and the grid's 32 follow in eight. In those 17
  frames the fastest level turns 7 m at 25 m/s, under a fiftieth of the
  grid's 400 m cell (**D**: `25 m/s × 17/60 s`). No cadence is added, and the
  turn raises no jump.

### 5.4 First order: the step, the classes, the sun's disk and the radius

**A step integrates a source that falls along it.** The march as built takes
its sample half a meter inside a step's start
(`render/cloudMarch.ts:509-515`), takes the sun there (`:423`), and adds
`sun(start)·T_view(start)·(1 − e^(−Δτ))` (`:427-429`). That is exact for a
constant medium and a left-endpoint rule for the source, which falls along
the step as the sun's depth grows. On a uniform slab, reflected first order,
with `k = 1 + μ/μ₀` and the schedule's step of 0.3:

```
march / exact = k·(1 − e^(−Δ)) / (1 − e^(−kΔ))     1.149 at k = 2,  1.310 at k = 3,  1.863 at k = 6
```

(the physics critique's finding 1, **D** there and redone here). The jitter
does not remove it, no step count sees it, and a longer step makes it worse.

**And the landed step does get longer with distance.** The 0.3 holds until
the schedule's floor, `3 m + 0.00375·t`, passes `0.3/σ`: 1.5 km out for
`fair-cumulus` at 35 km⁻¹. At 8 km a step is 33 m, a depth of 1.16, and
first order is 52% high at `k = 2`. At the far comparison's 55 km handover a
step is 50 m or more, and it is 70% high or more (phase 0's council; **D**:
`2/(1 + e^(−Δ)) − 1`). So the bias is 15% only near the eye, and the far
comparison's own reference carries the most of it exactly where the two
marches are compared.

- **The step's source is log-linear between its two ends.** With `S₀` and `S₁`
  the source at a step's start and end and `κ = ln(S₀/S₁)/Δτ′`, the step adds
  `S₀·(1 − e^(−(1 + κ)·Δτ′))/(1 + κ)`, per band. That is exact for a source
  that falls exponentially, which a slab's does, at any step length.
- **It costs one register and no fetch.** A step's end is the next step's
  start, so a step is closed when the next sample is taken, with the source
  held from the one before. A segment's last step has no next sample; the sun
  is evaluated once more at the segment's close.
- Where either end's source is zero or the two differ by more than e⁸, the
  step falls back to the linear form,
  `S₀·(1 − e^(−Δ)) + (S₁ − S₀)·(1 − (1 + Δ)·e^(−Δ))/Δ`.
- "The source" is everything a step emits per unit of scaled depth: first
  order below, and the higher orders and the sky of §5.5 and §5.6, each of
  which falls with the same beam.
- **It is a defect of phase 0's march, fixed by package M1.** How it bears on
  phase 0's own figures is at the end of this section.
- **Its test is at the steps the march really takes** (`cloudTrace.gpu.test.ts`,
  package M1): a uniform slab's first-order radiance is within 1% of its
  closed form at step depths of 0.3, 1.16 and 2, where the landed step is
  15%, 52% and 76% high.
- **The far comparison is re-based once, when this lands.** Package C pins
  `cloudFarCompare`'s landed figures as bounds (§6.3), and those figures are
  against a reference that is up to 70% high. M1's change moves the reference
  for a stated reason, so the package that lands it re-takes the instrument
  and writes the old and the new figures into the record in one commit. After
  that the bounds only tighten.

**First order.** A step's source, per band:

```
S₁ = sun.air · T′_sun · gain(r) · p_k(ν, r)           seen through   T_air(eye → step) · T′_segment
```

with the gain and the phase from one fetch of the atlas (§4.4).

**The sun's depth near a lit face.** The light taps are at fixed distances in
meters, each counted whole or not by its midpoint
(`render/cloudSunlight.ts:36-47, :61-73`): at the default two, the first is
250 m wide. Within 125 m of a lit face the sun's depth is then wrong by up to
`σ′·125 m`, 4.4 in fair cumulus, and `e^(−τ)` averaged over where the face
falls is high by a factor of 9 (the physics critique's finding 8, **D**
there). That is where all of first order's light is.

- **The taps are spaced in optical depth,** from the sample's own `σ′`: the
  first tap's width is `0.5/σ′`, and each next one doubles, to the 1 km reach
  (`LIGHT_TAP_REACH`, `:48`). It costs no fetch. A tap still counts its medium
  whole, so the error at a face is bounded by the first tap's half depth,
  0.25.
- **`lightTaps` is 4, and phase 0 did not show that converged:** two taps
  against four differ by 1.04% on `horizon`, 1.14% at Retina, and four had no
  larger neighbor. The lever admits 6 and 8, and the ladder is taken again
  with them (§7.3). Spaced this way, four taps reach `7.5/σ′`, about 210 m in
  fair cumulus; six reach `31.5/σ′`, about 890 m; and eight are clipped by
  the 1 km reach (**D**, at the 35 km⁻¹ the line above implies). So 8 against
  6 tests the reach, and 6 against 4 the count.
- **A tap reuses its step's `cover` and `kind`.** Those two texels hold the
  climate's or the regime's cover and its convective share, which vary over
  the maps' texels, kilometers, and a tap's whole reach is a kilometer at
  most. So a tap reads the base noise, the detail and the profile at its own
  point and takes the cover and the kind its step fetched: three reads where
  the landed tap makes five, 17 a step at four taps where it makes 25
  (**D**). The sun gate judges it with the rest of the taps' changes.
- **Past the taps the sun's depth is the grid's,** read at the taps' end, or
  the statistics that stand in for it (§5.5). At four taps the landed grid is
  within the gate's 3% in four cases of ten. Its RMS is 0.097 on `two-decks`
  at 37.5° and 0.054 at 5°, 0.082 on `cirrus-over-cumulus` at 5°, 0.046 and
  0.032 on `fair-cumulus`, and 0.040 on the anvil at 5°; and its worst sample
  is 1.00, full scale, under two decks at a 5° sun, and 0.94 or more in five
  cases of ten (the landed `sunAccuracy` document; ADR-0064). Those are with
  the taps as built. Package M1 takes the gate again with these.
- The gates run with an exact sun and with this one (§7.4), so the sun
  path's own error has a number.

**The radius is the sample's.** A ray's `ν` is fixed, so a level's phase is a
function of radius alone along it. Three ways to take it are built for the
measurement:

| Candidate | What it does                                                                                                                                                      | Fetches                                    | Registers                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| `sample`  | `phase(ν, k, r)` at every step. The reference; never shipped                                                                                                      | One a step                                 | One `vec3`                               |
| `bins`    | On a level's first step, fetch the phase at `K` radii spaced evenly in `log r` over the level's range; at every step blend the two nearest by the sample's radius | `K` a level a ray enters                   | One `vec3`, and four held phases a level |
| `mean`    | The plan's shortcut: accumulate each level's light and its light-weighted radius, fetch once at the end and at each knot                                          | One a level at the end, one a level a knot | Two a level                              |

`bins` is a quadrature of `sample` over radius, so it converges on it as `K`
grows and draws a mix of radii as a broadened ring. `mean` draws one sharp
ring at the mean. §7.4 chooses. Under `bins` and `sample` the knots' light
(`cloudKnots.ts:83`) is the register itself; under `mean` a knot's record
fetches, as `lightSoFar` does today (`cloudMarch.ts:372-375`). `mean` needs
the source kept unphased until the end, so under it the step's log-linear
integral runs on the unphased light and the phase multiplies the sum.

**The classes.**

- **Droplets:** the committed table, 2–32 µm (`mieDroplets.generated.ts:25-31`).
- **Ice: Baum's severely roughened aggregate of solid columns** (Baum et al.
  2014, _JQSRT_ 146, 123–139; the citation's volume and pages are **M** and
  the package confirms them). Jon has the registered download and has said to
  commit the reduced table (ruling 5). The distribution's README, last updated
  25 July 2013, states no license and no terms of use; it gives 445
  wavelengths from 0.2 to 100 µm, 23 effective diameters from 10 to 120 µm in
  steps of 5, and `P11` at 498 scattering angles in the gzipped files (the
  rulings, from the README).
  - **The generator,** `apps/ingest/src/iceTable.ts` (package T4), reads the
    aggregate's `FullPhaseMatrix` and `NoPhaseMatrix` files from
    `.data/weather/baum/`, where the package extracts the archive into its own
    empty directory, outside any campaign. It reads them with `h5wasm`, which
    the contracts package adds to `apps/ingest` so that this package and the
    ISCCP ingest share one lockfile change.
  - **The reduction.** `P11` is averaged over the wavelengths inside each of
    the air's three bands, with the droplet table's own raised-cosine weights
    (`apps/ingest/src/mieTable.ts:134`); a band holding fewer than two
    wavelengths takes its two nearest, and the header says which. The 498
    angles are resampled onto the atlas's 1,024 (`tableAngle`, `:66`), in the
    logarithm of the phase. Each row and band is renormalized to one. Each
    row's bulk is its band-mean `Q_ext`, albedo and asymmetry, from the second
    file. Whether the 498 angles reach 0° and 180° is **to read** in the file;
    the generator refuses to extrapolate.
  - **What is committed** is `iceAggregate.generated.ts`: 23 rows × 1,024
    angles × 3 bands of half floats, 141,312 B, about 190 KB of text, and the
    bulk. Its header and the source's record in
    `apps/ingest/src/weatherSources.ts` carry the citation, the source's URL
    (`https://www.ssec.wisc.edu/ice_models/polarization.html`), the words "no
    license or terms of use are stated", and the README's date. The archive
    and its extraction are never committed.
  - **In the medium** ice is treated as droplets are: `f_δ = 1/Q_ext` from its
    own bulk, its gain in the atlas, and the disk's convolution over its rows
    as over the droplets'. The table holds its own diffraction peak, so the
    gain multiplies a phase that has one.
  - **Its tests** run without the archive: the reduction on a small synthetic
    file, and on the committed table each row's integral within 10⁻³, its
    asymmetry within 2% of its bulk's, and no local maximum near 22° or 46°,
    which is what roughening removes. A test that recomputes a row from the
    source skips where `.data/weather/baum/` is absent, so CI skips it.
  - The plan's cirrus has effective radii of 34–92 µm (§5.1 there), diameters
    of 68–184 µm, past the table's 120. A larger crystal reads the last row,
    declared.
- **Rain:** not built. Its generator is settled for phase 4: the existing
  series (`apps/ingest/src/mie.ts:45-188`) to a size parameter near 14,000
  (**D**: `2π·1000/0.44`), a Marshall–Palmer distribution cut at a 1 mm
  radius, where drops flatten and a sphere's bow is wrong (research §6.2,
  **R**), a row a rain rate, split by row across processes because rule 8
  keeps `worker_threads` out of ingest. Airy's peak near 138.9° (**R**) and
  the geometric 137.9° and 129.1° (**D**) are its checks, not its generator.
- **The bows phase 1 holds** are the droplets': the cloudbow at 139.7–142.0°
  for radii of 10 µm and over, and each row's red glory ring, both measured on
  the committed table (phase 0 package report, WP2).

**The sun's disk.** First-order light from a disk of angular radius `α` is the
phase averaged over the cap:

```
p̃(Θ) = (1/Ω_c) ∫ p(θ′) · 2·φ_max(Θ, θ′) · sin θ′ dθ′,   θ′ from max(0, Θ − α) to min(π, Θ + α)
φ_max = acos(clamp((cos α − cos θ′·cos Θ)/(sin θ′·sin Θ), −1, 1)),   Ω_c = 2π(1 − cos α)
```

(research §7, **D**). `convolveDisk(table, α)` evaluates it for every texel of
every row and band, by 16-point Gauss–Legendre after `θ′ = Θ + α·sin s`, on
the table's piecewise-linear phase. That is about 2.7 million kernel values
with the ice rows (**E**). The table resolves 0.042° a degree from either end
(phase 0 design §6.4), a sixth of the disk's radius from Earth, so the peak,
the corona and the glory are sampled; in the middle the disk is under a texel
and the convolution changes nothing.

- `α` is the served body's sun's: 0.265° from Earth, whatever a generated
  world's star subtends. The second body reads the served body's atlas,
  declared.
- **One sun model a reference.** The path tracer samples a point on the disk
  and evaluates the unconvolved table. The march, the adding-doubling oracle
  (`χ̃_l = χ_l·k_l`, the cap's Legendre coefficients, research §7) and the
  Monte Carlo slab use the convolved phase and a point sun. No reference does
  both.

**How the step's defect bears on phase 0's figures.**

- **Costs, memory, the cold compile and the thin form's residual** do not see
  it: none depends on how much light a step adds.
- **The ladders stand.** The bias is first order in the step's depth, which is
  0.3 at any `maxSteps`, so a ladder's two images carry it alike. So do the
  cache's two (the volume against the field), which run one march.
- **The sun's-depth instrument stands.** It compares transmittances to the
  sun, not light along the view.
- **The far field's radiance error is to be read as a ranking.**
  `cloudFarCompare` scores each far field against the fine march, and the fine
  march's first order is 15% high at `μ = μ₀` and more toward a low sun, while
  the far march's light is a closed form. Both candidates are scored against
  the same biased reference, and the errors that decide between them are 50%
  to 165% (`design/plans/weather/README.md:79-81`), so the choice stands. The
  absolute figures are not the far field's alone; package X's re-run of the
  instrument, after M1, gives those.
- Phase 0's placeholder light claimed nothing (its design §12.2 item 7), and
  no phase 0 ADR should quote a radiance as the cloud's.

### 5.5 Higher orders, and the sun's depth

Every order past the first is the scaled medium's (§5.1), added per step to
the same source the step integrates (§5.4). The furnace is §5.6's.

**S, the slab's own source function.** For a conservative slab of the medium
`(p′, τ′)` under a sun at `μ₀`, the oracle gives the radiance field at every
depth and in every direction. The source function of every order past the
first is projected on three terms:

```
S_h = sun.air · (J₀ + J₁·μ_v + J_f·Φ(ν))
μ_v = −(ray · up)                 the cosine, to the slab's normal, of light traveling to the eye
Φ(ν) = 4π·HG(ν; g′²) − 1          a lobe about the sun's own direction, with zero mean
```

- **`J₀` and `J₁` are the diffusion domain's exact form.** There the radiance
  is `I₀ + 3·I₁·μ` and the source is `I₀ + 3·g′·I₁·μ` (**D**), and in a
  conservative slab the flux `I₁` is constant with depth. The table carries
  the oracle's own values, which hold near the top as well.
- **`J_f` carries what two moments about the normal cannot.** The low orders
  keep the phase's lobe about the sun's direction: "even high orders (up to
  30 scattering events) show an anisotropic behavior" (Bouthors et al. 2008,
  research §3.2, **R**). At a rim 15° from the sun, with a scaled
  line-of-sight depth of 1.5 to 2, orders two and up are 35% to 45% of the
  radiance, and `J₀ + J₁·μ_v` alone draws the silver lining a quarter to a
  third low (the physics critique's finding 7, **D** there). `Φ` is the second
  order's shape, `p′` scattered twice. The three coefficients are fitted by
  least squares over every view direction, azimuth included, at each node.
  Package R1's report says whether `J_f` is needed: if the reconstruction
  below passes without it at every azimuth, the channel is dropped.
- **It is exact in a slab by construction,** up to the three terms and the
  table's own read: it is the oracle's solution of the renderer's medium less
  that medium's first order, in the march's own depth.
- **It carries what octaves cannot.** A column that is thin toward the sun has
  little `J`, so an edge's higher orders are dim while its first order is
  bright: the dark edge and the silver lining from one table. Deep in a thick
  column `J` is the diffusion's glow, and at its far side the diffuse
  transmission, so a base is gray and not black.
- **It is a slab's.** On a cumulus's flank the two depths below are a slab
  equivalent, an approximation the path-traced cumulus judges (§7.4).

**The table's axes** are the transport depths to the two faces, each on a
logarithmic map, and the sun's cosine:

```
t_d = (1 − g′)·τ′_d        t_b = (1 − g′)·(τ′* − τ′_d)        u(t) = ln(1 + t/0.02)/ln(1 + 16/0.02)
```

- **From each face, on a logarithm,** because the source near a face changes
  over a scaled depth of 0.2 to 1 and a deck is 25 deep: sixteen linear nodes
  of `τ_d/τ*` put a node every 1.7, and a linear read of a term `e^(−τ′/μ₀)`
  across that returns 0.716 where the integral is 0.5 (the physics critique's
  finding 7, **D** there).
- **By transport depth,** because one table then serves every radius row and
  ice: `g′` runs 0.68 to 0.77 across the droplets and is near 0.5 for ice
  (**D**), and the higher orders of a forward-peaked medium depend on depth
  through `(1 − g′)·τ′` to the accuracy the similarity relation has. The table
  is generated at 10 µm, and the gate runs at 6, 10 and 16 µm (§5.11), which
  measures what the relation costs.
- **`n` nodes a depth axis, 16, 24 or 32,** the smallest for which the
  reconstruction below holds.

**The reconstruction is the table's own test, in Node, before any GPU work.**
Package R1 integrates §5.4's first order and
`∫(J₀ + J₁·μ + J_f·Φ)·e^(−τ′/μ) dτ′/μ` through the committed table's own
trilinear read, at depths, thicknesses and suns between its nodes, and
compares the slab's leaving radiance with the oracle's at each azimuth of the
domain, never with an azimuthal mean. The figure goes in the table's header,
and `slabTables.test.ts` holds the committed table to it.

**Where a sample's two depths come from.** `τ′_d = μ₀·τ′_sun` and
`τ′* = μ₀·τ′_total`: the sample's scaled depth toward the sun through cloud,
and the whole of that ray's, each times the sun's cosine, which is exact in a
slab. `CloudSun` (`cloudNodes.ts:97-102`) gains them:

```ts
export interface CloudSun {
  readonly cloud: Node<'float'>
  readonly air: Node<'vec3'>
  /** Scaled optical depth through cloud toward the sun, and the whole of that ray's. */
  readonly depth: Node<'vec2'>
  /** The cloud's transmittance to the sun with its depth scaled by `a`. */
  octave(a: number): Node<'float'>
}
```

- **The grid holds the depth to the sun.** A cell holds the depth from its
  center to the union's top along the sun (`render/cloudSunGrid.ts`,
  `#bakeNode`, read by `opticalDepth`): 128 × 128 cells of 400 m on level 1's
  window, 51.2 km square about the eye, at 32 heights. That is not the ray's
  whole: the part behind the sample is never marched. **The whole is read
  from the cell where the sample's sun ray, continued away from the sun, meets
  the union's base,** one more fetch a step, of the texture already bound. At
  a 5° sun that cell is 23 km from a sample 2 km over the base (**D**:
  `2/tan 5°`), so toward the window's edge it is often outside, and there the
  statistics give the whole.
- **Where the grid does not reach, the layers' own statistics stand in.** That
  is three places: from orbit, where the grid idles; past its window, 25.6 km
  from the eye; and while a rebuild is under way (§4.7). As built each reads
  as no cloud past the taps (`opticalDepth`'s `select`), so a cumulus under
  cirrus 30 km off is lit as if the cirrus were not there, and the far march,
  which adds the layers above to its sun's depth, disagrees with the fine
  march across the band.

```
T′_sun  = T′_taps · (w·e^(−τ′_grid) + (1 − w)·T′_stat)
T′_stat = own_k · Π_{j on the sun's side of k} ((1 − c_j) + c_j·e^(−τ̄′_j/(μ₀·n_j)))^(n_j)
own_k   = (1 − c_k) + c_k·e^(−max(d_k/μ₀ − τ′_taps, 0))
τ′_d    = mix(d_k, μ₀·(τ′_taps + τ′_grid), w)
```

- `c_j` is level `j`'s cover at the sample's own column, from the `cover`
  texel the step already holds. `τ̄′_j` is the level's mean in-cloud depth, its
  stratiform and cumuliform values in the level's uniforms, blended by the
  `kind` texel. `n_j` is §5.9's exponent for the sun's run across the level.
  `d_k` is the sample's own column toward the sun, `depth` of §4.3. No fetch
  is added.
- **The statistics are sided by the sun.** Over the local horizon the sun's
  side is up: `d_k = depth.x`, and `j` runs over the levels above. Under it
  the light comes in from below: `d_k = depth.y − depth.x`, the column under
  the sample, and no level above shades. G3 is that case (§3.3).
- **It is §5.9's law, from `cloudMix.ts`,** and the far march's sun term calls
  the same function for the layers on the sun's side of its column, so past
  the grid the two marches agree on what shades a layer.
- **The layers are read at the sample's own column,** not displaced along the
  sun. At a low sun that is the wrong column. Phase 2's `cloudSunlight`
  displaces them (§0.4); phase 1 declares it in ADR-0073.
- **The weight is continuous in the camera and in time:**
  `w = trace.sunWeight · saturate((24 km − d)/3.2 km)`, `d` the larger of the
  sample's two horizontal offsets from the eye along the grid's axes. It is
  one to 20.8 km and zero from 24 km, inside every window the grid's snap can
  give. It is measured from the eye and not from the window's edge, because
  the window moves a cell at a time and a weight tied to it would step by an
  eighth at each snap. `trace.sunWeight` is §4.7's: the rebuild's ramp times
  the wake's height. From orbit it is zero, every cloud takes the statistics,
  and S draws no edge structure there; ADR-0068 says so.
- **A sun under the horizon: the bake sums to the ray's first exit.** As
  built a cell's ray runs to the far crossing of the union's top in 32 steps
  (`#bakeNode`: `shellCrossingFrom(…).far` over `SUN_GRID_STEPS`). At G3's
  sun, 1.5° under, a ray from the top of `altocumulus`, 4,800 m, leaves the
  layer downward after 34 km, passes 1.4 km under its base at 167 km and
  comes back up into it 300 to 334 km sunward; a ray from the base leaves at
  once and returns at 334 to 362 km (**D**, on a world of Earth's radius).
  That is 32 steps of about 11 km, of which three at most fall in the layer
  near the sample. So a ray that leaves the union through its base is summed
  to that exit, 32 steps over at most 34 km, and what it meets where it comes
  back up is one crossing by the law above, from one read of the field at the
  re-entry point, added to the cell's depth. A sun over the horizon bakes as
  built.
- **The sun gate has no figure at the cornerstones' low suns.** Phase 0
  measured at 37.5° and 5°. G3 stands at −1.5°, and E2's limb sees the sun
  1.2° under. Package L's instrument takes G3's sun on `altocumulus`, with
  the bake as built and as above, and the record carries both.
- **The gate's population is thin, and package L widens it before it reads
  anything** (`cloudSunAccuracy.gpu.test.ts`; phase 0's review and council):
  - **Places.** It takes the first maximum of cover on a Fibonacci sphere, so
    four of five scenarios stand at latitude 86° to 89°, one place each. The
    rigid turn makes a pole a special place, where a layer's texture stands
    still. Each scenario is scored at five places drawn by a seed between
    60° S and 60° N.
  - **Reach.** Its samples are within 4 km of an eye at 2 m, so the figure
    that chose the grid is about the inner 4 km of a 25.6 km window. They run
    to the window's edge and through the weight's ramp.
  - **The worst sample.** The document holds each case's worst error and the
    ADR's table did not; the only bound on it is `worst ≤ 1`, which cannot
    fail. The worst is reported and held (§6.3).
- **The window's edge is a seam as landed.** `select(inside, tau, 0)` ends
  the grid in a step about 25 km out, shadowed on one side and lit on the
  other (phase 0's council). The weight above replaces the step with a ramp
  from the eye, and its test is on a line across it: under one layer shading
  another, at samples 400 m apart from 18 km to 28 km out, the sun's
  transmittance is the weight's mix of the grid's value and the statistics'
  within 0.01, so no two neighbors differ by more than an eighth of what the
  two disagree by (`cloudSunDepth.gpu.test.ts`, package L).
- The light taps add their own depth to `τ′_sun` (`cloudSunlight.ts:74-88`).
- `μ₀` is floored at 0.05, the table's first row.

**O, octaves on the sun, is fitted in Node and built only if the fit passes.**
The plan asks for octaves "fitted to the slab reference" (§5.3 there;
Wrenninge, Kulla and Lundqvist 2013, **R**):

```
S_O = sun.air · Σ_{i=1}^{N−1} bⁱ · sun.octave(aⁱ) · p_HGD(ν; cⁱ)
sun.octave(a) = ((1 − c) + c·e^(−a·τ′_taps)) · e^(−a·τ′_beyond)
```

- `octaveFit.ts` fits `(a, b, c)` for `N` of 2, 3 and 4 to the oracle's
  higher-order radiance on the domain's grid, under `b ≤ a` (an octave never
  scatters more than it extinguishes; Frostbite's bound in Wrenninge's
  letters, research §4, **R**), and reports the error at the held-out points.
- **The arithmetic says it fails.** Under `b ≤ a` an octave's share of a thick
  slab's reflected radiance is at most `aⁱ·p_i·μ₀/(μ₀ + aⁱ·μ)` (**D**: the
  integral of `e^(−aⁱτ/μ₀)·e^(−τ/μ)` over depth). With `N ≤ 4` the sum is
  bounded near 0.12 of the incident flux where an albedo-one deck returns
  about 0.3 (the physics critique's finding 31, **D** there), so the slab gate
  at depths of 20 and over is out of reach.
- So octaves cost phase 1 one Node fit and a recorded figure. Their branch in
  the march, the `transport` lever and `sun.octave`'s body are built only if
  that fit is within 5% at every held-out point (§7.4). `CloudSun.octave`
  stays in the contract either way: phase 2's `cloudSunlight` has the same
  shape.

### 5.6 The sky's light on a cloud

The transport equation is linear in its boundary light. Split the sky a sample
sees into its mean over the sphere and the rest. At albedo one the mean
produces exactly `L̄` at every point of any medium, the furnace identity, so
only the rest needs transport (research §4.1, **D**).

**The table** holds, by height and the sun's cosine, per band:

| Block | Holds                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------- |
| 0     | `ln L̄`, the sky's mean radiance over the whole sphere                                             |
| 1     | `Δ = (E_up − E_down)/(π·L̄)`: the irradiance on a horizontal face from above, less that from below |
| 2     | `Δ_s`: the same difference across a vertical face turned to the sun's azimuth                     |

- **Irradiance, not mean radiance.** A diffusion boundary takes each side's
  irradiance. For a sky uniform above and dark below, `Δ = 2`, and a thick
  deck's top returns the sky's radiance exactly; weighting by the hemisphere's
  mean radiance, as draft 1 did, returns 0.875 of it (the physics critique's
  finding 15, **D** there and redone here).
- `bakeSkyMoments(recipe, transmittance, multiScatter)` integrates the air's
  own march over the 64 directions `bakeMultipleScattering` uses
  (`packages/rendering/src/atmosphere.ts:438, :900-905, :924-933`): single
  scattering through the transmittance table plus Ψ, and where a direction
  meets the ground, a Lambertian ground at `SKY_GROUND_ALBEDO` under the clear
  sky's own light. So the cloud and the air agree on the sky.
- `L̄` is stored as its logarithm for the reason Ψ is (`atmosphere.ts:907-922`):
  through twilight it falls tenfold in two degrees.
- It runs in the atmosphere task beside the two tables that exist. Its cost
  there is **to measure**, on the boot timeline's own span.

**The term.** Inside a column of scaled depth `τ*`, at depth `τ_d` under its
top, the diffusion solution for a conservative slab between two diffuse faces
weighs the two sides linearly in transport depth, and carries a flux through
the slab (**D**):

```
w_top = (t_b + q)/(t_d + t_b + 2q),   q = ⅔,   t = (1 − g′)·τ′ as in §5.5
J_sky = L̄ · max(0, 1 + Δ·(w_top − ½) + g′·(Δ·(ray·up) + Δ_s·(ray·ŝ_h))/(t_d + t_b + 4/3))
```

- **The first term** is the mean. **The second** leans it toward the side the
  sample is nearer. **The third** is the flux's view term, the same
  `3·g′·I₁·μ` as §5.5's: light crossing the cloud from the brighter side
  reaches an eye on the far side. Without it a thin cloud is lit alike from
  above and from below. With `ŝ_h` the sun's horizontal direction it also
  carries the bright side of a twilight sky, which G3 looks toward. The floor
  at zero is there because a two-term form of a forward lobe dips under it.
- **The depths are the sample's own column's.** `CloudMedium.depth` is the
  level's statistical column (§4.3), so a wisp inside a deep level would read
  the level's depth and never reach `w_top = ½`. The march scales both depths
  by the sample's density over the profile's mean at that height, clamped to
  one: an eroded wisp reads a thin column. It is a heuristic, declared, and
  the cumulus gate's base and core medians (§5.11) are what judge it.
- **Limits.** A wisp glows with the whole sphere's mean and takes the full
  view term. A thick deck's top returns the upper side's irradiance over π.
  Its base returns the lower side's, plus the share that diffuses through.
- **The furnace is exact.** With a uniform sky `Δ = Δ_s = 0`, so `J_sky = L̄`
  at any density, step count or depth estimate, and a ray returns
  `L̄·(1 − T′) + T′·L̄`.
- It replaces the placeholder `SKY_SHARE·Ψ` (`cloudMarch.ts:121, :431`), and
  it answers the research's question 5: the plan's "occluded by the column over
  the sample" (§5.3 there) applies to the difference, never to the mean.
- One table fetch a segment. The three vary over kilometers of height.

**Declared.** The table's ground is lit by a clear sky. Under a thick deck the
real ground is in shadow, so a base over it is lit from below as over sunlit
ground until phase 2 couples the two (`1/(1 − A·R_base)`, plan §6.2).

### 5.7 The dark edge

A declared term is allowed only if the winning transport, after its fit,
misses the path-traced cumulus's sunward-edge curve by more than §5.11's
tolerance. Under S it is expected to be unnecessary, because a thin column's
`J` is small already.

If it is needed, it is a factor on the sun's higher orders alone, never on
first order, which carries the glory, and never on the sky, which would break
the furnace:

```
m = 1 − e^(−κ·τ_b),   τ_b = μ₀·min(τ′_sun, τ′_total − τ′_sun)
```

- `τ_b` is the depth to the nearer boundary along the sun's ray, from
  `CloudSun.depth`. No tap is added.
- `κ` is fitted to the sunward-edge curve at the back geometry, then held at
  the other two, where the rim curve must stay inside its tolerance.
- **It is kept only if the winner with it passes gate 1 again,** and gate 2 in
  all six cases. The factor goes to zero in a thin cloud and is under one near
  both faces of a slab, so it moves the slab radiance the winner passed with,
  and under S it repeats a deficit the table already holds (the physics
  critique's finding 27).
- Photographs judge it second, through the panel.

### 5.8 Steps and the handover

**The schedule is phase 0's** (`cloudMarch.ts:108-139`): out of cloud from
50 m, growing 1% a step to 1 km; in cloud a scaled depth of 0.3 a step,
floored at 3 m plus 60 m per 16 km; an exit under 1% transmittance; every step
clipped to the next of six boundaries (`:151-182`). In the scaled medium a
depth of 0.3 is twice the length it was.

**A ray always reaches its handover, and keeps its fine steps near the eye.**
As built, a ray that spends its budget hands over where it ran out
(`cloudMarch.ts:574-580, :613-694`; phase 0 design §12.2 item 6), so the
switch's distance is each ray's own and moves with the jitter. Now a step is
never shorter than an even share, in the logarithm of distance, of what is
left to the handover:

```
Δ = max(schedule, t·((stop/t)^(1/(maxSteps − steps)) − 1)),   t floored at 50 m
```

- **Why the logarithm.** Draft 1's floor was the distance left over the steps
  left, which binds from the first step of any long ray: 286 m to 389 m a step
  for a ray inside a cumulus looking toward a horizon 55 to 75 km out, where
  the schedule gives 8.5 m, so the pixel was one sample at the eye (the
  physics critique's finding 2, **D** there). The geometric floor spreads the
  steps as the schedule's own growth does. At 192 steps to 75 km it is 3.9% of
  the distance a step: 4 m at 100 m and 39 m at a kilometer (**D**:
  `1500^(1/192) − 1`), under the schedule near the eye and over it only far
  away, where a trace texel is wide.
- With §5.4's integral a longer step conserves the light of a source that
  falls along it. What it loses is the medium's variation inside the step.
  Resolution falls smoothly where a budget is short; nothing switches.
- `exhausted` (`cloudMarch.ts:92-93`) becomes the count of rays whose floor
  passed the schedule: how often quality was traded, under `stats`.

**The handover is a dithered band in footprint.**

```
stop = clamp(farDistance · band^ξ, ray.start, ray.end)
```

- `farDistance = farFootprint/pixelAngle` as built (`cloudUniforms.ts:479-483`),
  `band` is the `handoverBand` lever, and `ξ` is the ray's third jitter value
  (§5.10). Across pixels and frames the two representations cross-fade over
  footprints from `farFootprint` to `band·farFootprint`, and the history
  integrates the dither. One march a ray, as now.
- The far bake still evaluates the medium at `farFootprint`
  (`cloudFarAtlas.ts:467`), the band's near edge.
- **By footprint, never altitude:** a zoom changes `pixelAngle` and a descent
  changes distance, and both move `stop` by the one rule.

**What the band cross-fades has to be one medium.** The fine medium fades its
own detail between footprints of a quarter cell and a whole one
(`cloudDensity.ts:222-226`): 300 m to 1,200 m for `fair-cumulus`. At the
decided footprint, 800 m, a band of 2 runs from 800 m to 1,600 m: its near
half lies on that fade's last part and its far half past it, where the fine
march reads a fraction and a mean alone. For `stratocumulus`'s 1,800 m cells
the fade is 450 m to 1,800 m and holds the whole band (**D**). So across the
band the fine march is partly or wholly a fraction and a mean, and it must
mix that fraction exactly as the far march does. §5.9's first change makes
that so: one law for a layer's crossing, in both marches.

**Why there is no hysteresis.** The art direction asks for it where a level of
detail is a state (`docs/design/art.md:371-373`): a patch that is fine or
coarse flips at a threshold, and a camera hovering there flickers. Here
nothing is a state. `stop` is a continuous function of the camera and the
lens, the fine medium's fade is continuous in footprint, and the clipmap
already reads two levels across its fade band. The physics critic looked for a
latch and found none. The rubric now reads "faded across a band, with no
switch that can flip between two frames" (§4 there), and that is what is
tested. If the cast across the band shows a step, the band's width is the
lever (§7.4), and a state would be the wrong fix.

**The ladders phase 0 set, and where they put the handover.** `maxSteps` is
192, `lightTaps` 4 and `farFootprint` 800 m, each on the placeholder's
unscaled medium. Phase 1 starts there and takes all three again (§7.3),
because the scaled medium halves the depth a step crosses, the floor changes
what `maxSteps` buys and the taps are spaced anew.

- **`pixelAngle` is a trace texel's** (`render/cloudFrame.ts:471`), so
  `farDistance` is `800 m` over the lens's vertical angle a trace line
  (**D**, at 270 trace lines for 1080p and 225 for 1440 × 900):

| Lens                     | 1080p: the band at 2 | Retina: the band at 2 | What stands in it                                                                                               |
| ------------------------ | -------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| 50°, on the ground       | 248 to 495 km        | 206 to 413 km         | Nothing of a layer under 3.3 km: its own horizon is nearer than 206 km                                          |
| 60°, from 400 km         | 206 to 413 km        | 172 to 344 km         | Nothing: `orbit` and `earth-orbit` look 40° and 35° down, and the nearest ground in frame is 427 km off (**D**) |
| 11.4°, E1, straight down | 1,086 to 2,171 km    | 905 to 1,809 km       | Nothing: the frame is 400 km off and all fine march, by 2.3 times where 400 m left 13%                          |
| 11.4°, E2, at the limb   | 1,086 to 2,171 km    | 905 to 1,809 km       | **The frame:** its lower edge is 1,115 km off and the limb 2,290 km (**D**). At 400 m it is all far             |

- **So on the ground the far march draws almost nothing at 800 m,** and the
  ladder's last step agrees: 800 m against 1,600 m is 0.01% on `horizon`,
  where 400 m against 800 m is 7.18% at Retina. Phase 0's far march passes
  1.35 to 1.5 times the reference's transmittance (0.306 against 0.207 over
  broken cumulus, 0.646 against 0.477 for cirrus over cumulus; `farCompare`),
  so the likelier reading is that the ladder
  converged by taking the far march out of the frame, not by the two marches
  agreeing. **Not verified:** the campaign did not record the share of rays
  handed over, and at 1080p the same ladder passes from 200 m (0.43%), which
  this reading does not explain. `ladders` records the share from here on
  (§7.3).
- **What follows.** The fine march now runs to a low layer's horizon, so the
  budget's floor carries more of the frame: at 192 steps to 248 km a step is
  4.5% of the distance, 45 m at a kilometer (**D**: `4,960^(1/192) − 1`), where
  75 km gave 3.9%. After §5.9 makes the two marches one medium, the footprint
  ladder is the one most likely to move back, and 400 m and 200 m stay on it.
- **The band is judged where it is in frame:** the zoom cast, the slow
  descent, E2, and the `handover` batch's two stances (§7.2). G1 to G4 do not
  show it.
- **The zoom cast cannot stand at G4's pose.** There the eye is 3 km over
  the deck's top looking 35° down, and at a 60° lens the farthest cloud in
  frame is 34 km off (**D**: `3/sin 5°`), where the band begins 172 km out
  and moves away as the lens lengthens. The zoom crosses nothing, at 800 m or
  at 400 m. It is taken from G6's start, 400 km up, at pitch −45°: at 60° the
  nearest ground in frame is 415 km off and the band ends at 344 km, so the
  frame is all far march; at 11.4° the frame runs from 529 km to 666 km and
  the band begins at 905 km, so it is all fine march (**D**, at Retina's 225
  trace lines on a radius of 6,102 km). The band sweeps the whole frame in
  between. The slow descent crosses it by distance: straight down from
  400 km, the nadir is far march above 344 km and fine march below 172 km.
  That is C1 and C2, one rule crossed by a lens and by a distance, and §11.2
  asks the rubric's council to name this pose where C1 names G4's.

### 5.9 The far march

The far march must be the fine march's own statistics, or the band shows it.
Six changes, the first in the one recipe, the last in the bake and the rest
in `FarMarch`
(`cloudFarAtlas.ts:602-770`), the atlas's march, which the served body and a
second body share.

**1. A layer's crossing has one exponent, and every step of either march
takes its share.** Plan §3: a ray is in the cloudy fraction or out of it for
one column's crossing, and between columns the overlap is random and the
transmittances multiply. A column is the field's decorrelation length.

- **As built, the two marches count columns differently.** The fine march
  closes a segment when its horizontal run passes `column`
  (`cloudMarch.ts:213-226, :465`), and `column` is the texel of the cover map
  the sample reads: the clipmap level's (`cloudDensity.ts:255-261`,
  `cloudClipmap.ts:110-111, :286`) or the cube's 19.6 km, a cell only where a
  level's texel happens to be one. The far march mixes once a step
  (`cloudFarAtlas.ts:705-712`), and a step is an atlas texel, 24 km on
  far-shore and 39 km on Earth (phase 0 design §8.6). A grazing ray crosses
  twenty to thirty cells in one; the rays of the partial campaign's fan cross
  1.5 to 5.
- **The law.** A ray's crossing of a level has a chord `s` and a horizontal
  run `ℓ`, both known from the shells' crossings before any step is taken.
  With `c` the level's sight length, the crossing's exponent is

```
n = √(1 + (ℓ/c)²)
```

and a step that covers `s_i` of the chord, with the cover and the in-cloud
depth it reads there, passes

```
n_i = n·s_i/s,   T_i = ((1 − cover_i) + cover_i·e^(−τ′_i/n_i))^(n_i)
```

- **It is split-invariant by construction.** Under one cover and one
  extinction, `τ′_i/n_i` is the same for every step, so the product over any
  cut of the chord is `((1 − cover) + cover·e^(−τ′/n))ⁿ` (**D**). A vertical
  crossing of a half-clear layer of depth 20 passes one half at any step
  count, which is the test phase 0's march holds with its segments
  (`cloudTrace.gpu.test.ts`; phase 0 package report, WP6). At a cover of one
  it is `e^(−τ′_i)` at any `n`, so a slab is unmoved.
- **It is the same expression in both marches,** so across the band they
  differ only in what resolution they read cover and depth at. In the fine
  march it replaces the open segment's registers and its close at `column`
  (`cloudMarch.ts:233-251, :362-387`); a knot is a level's crossing where it
  is a column's close today (§4.9). `CloudMedium.column` is
  read by nothing after package M1 and is removed at integration. The CPU
  reference, `packages/rendering/src/cloudOverlap.ts`, is rewritten to the law
  by the same package, with its five properties (phase 0 design §5.7) restated
  for it.
- **A step's light** is its opacity, `1 − T_i`, times §5.4's view-weighted
  mean of the source over one column's depth, `τ′_i/n_i`.
- **The form is the field's own.** `√(1 + (ℓ/c)²)` is the clear-line-of-sight
  literature's for ellipsoids, `P = (1 − N)^√(1 + β²tan²θ)` (Taylor and
  Ellingson 2006, **W**, by the physics critique), which blocks from the side
  before the run reaches a whole cell; draft 1's `max(ℓ/c, 1)` does not. `c`
  is not assumed to be the noise's cell: a Node test in package D counts clear
  lines of sight through `cloudFieldAt` by zenith angle for each cumuliform
  regime, fits `c`, and holds the form to the count within 10%. If the count
  supports another form, that form replaces this one in both marches.
- This goes past the physics critique's smallest change, which made `column`
  the smaller of the map's texel and the cell and bounded the difference by a
  test. That leaves a staircase in one march against a smooth form in the
  other, 19% apart in transmittance at a run of one cell and a cover of 0.35
  (**D**: `0.65` against `0.65^1.41`), inside the band.
- The partial campaign measured both far fields at twice the fine march's
  transmittance over broken cumulus, 0.376 against 0.192
  (`design/plans/weather/README.md:80-83`). In all three of its rows the far
  transmittance is the reference's raised to a power of 0.5 to 0.6, and 0.646
  for cirrus over cumulus is exactly one mix of a 0.35 layer (the physics
  critique's finding 13, **D** there). Mixing by cells fits those numbers. One
  mean over one fan cannot tell it from a constant bias, so
  `cloudFarCompare` reports its ratio by pitch bin, and item 10's done-when is
  a bound in each bin, on the transmittance and on the light.
- **In the atlas, `ℓ` is the horizontal run of the slab step,** a texel along
  the ray.

**2. It reads the sky and the higher orders at the depth the view weighs.** A
deck seen from above shows its source within about one scaled depth of its
top, not at its middle. In a conservative slab the diffuse intensity falls
linearly from the top, so a source read at the middle is 0.55 of the top's at
an unscaled depth of 50, and the sky's weight at the middle is one half
identically, so the difference never draws (the physics critique's finding 3,
**D** there). That is the defect phase 0 fixed once for first order
(`6b6332e0`, "the far march lit each column through half its own depth",
`design/plans/weather/README.md:122-123`).

- The far step already computes where its opacity's weight centers, for its
  depth moments: `exponentialMean(τ′_step)`, a share `m` of the step from its
  entry (`cloudFarAtlas.ts:721`). The depth under the top is then
  `τ′_d = τ′*·m` for a ray entering from above and `τ′*·(1 − m)` for one
  entering from below. The layers on the sun's side of the column shade it by
  §5.5's statistics, the one function in `cloudMix.ts` the fine march uses
  past the grid, where the far march adds their depths today.
- Each layer's step adds `(1 − T_step)` of §5.6's sky source and §5.5's
  higher-order source at that depth. One sky fetch and one source fetch a
  layer.

**3. It keeps its cut and its code on the unscaled depth** (§4.11): a
sub-column is clear under an unscaled 0.1, and the 8-bit code holds the
unscaled depth, scaled after decoding.

**4. It reads the atlas by class and the body's own layers:**
`phase(ν, layers, k, r_ref)`, once a layer as now (`:749-756`), with the
level's gain.

**5. Its done-when has a light.** The far light's partial figures are 35% low
over broken cumulus even after the transmittance is corrected (0.00198·1.30
against 0.00392; the physics critique's finding 13, **D** there). Changes 1
and 2 both move it. Item 10 holds, in each pitch bin, the transmittance within
10% and the radiance within 15% of the fine march's, which is the rubric's
row 11, and a deck's higher orders from above within 5%.

**6. A clear texel holds the depth a cloud there would have.** The atlas
keeps a fraction and the logarithm of an in-cloud depth, and a clear texel's
depth is zero. A bilinear read between a cloudy texel and a clear one then
filters the logarithm against that zero and returns `(1 + τ)^w − 1`: a depth
of 8 at half weight reads 2, and the pair's opacity 0.43 where it is 0.50
(`cloudFarAtlas.ts:430, :457, :965-967`; phase 0's council). It is one cause
of the light the far field lets through.

- A texel with no cloudy sub-column stores the level's own mean in-cloud
  depth at that place, the statistic §5.5 already carries, and its fraction
  stays zero. The filtered depth is then a blend of depths that mean
  something, and the fraction alone carries the cover.
- The channels and their code do not change. What a clear texel's second
  channel means does, so the atlas's header comment and its test say so.
- Its test (`cloudFar.gpu.test.ts`, package X): across the edge of a deck of
  depth 8 beside clear sky, the far march's footprint-averaged opacity at the
  boundary texel is within 2% of the fine march's.

**Before any of the six: the atlas is scored where it will be used.** The
far-field choice was made at 400 m. The landed footprint is 800 m, which no
committed document scores, and at 1,600 m the spheres led in all four cases
(ADR-0064). The instrument now takes 400, 800 and 1,600 m.

- **Package X's first act is that score** on the landed code, from window
  1's instrument run, written into the record as the "before". Nothing of
  the band is built on the atlas until it is there.
- **The instrument is made to measure what row 11 asks,** by package X:
  - its reference is the fine march the far one takes over from, at the
    shipped `maxSteps`, beside the 1,051-step march it uses today, so the
    comparison is of the two marches a pixel in the band can draw;
  - its errors are relative, by pitch bin and footprint from `farFootprint`
    to the band's far edge. Today each case is normalized by its own mean
    light, 8.4 × 10⁻⁵ for the anvil, so its "worst case" compares unlike
    units (phase 0's council);
  - it runs after M1's step integral, because until then its reference is
    15% to 70% high in first order (§5.4).
- **What the score can change.** If the atlas at 800 m is no better than at
  400 m after the six changes, the footprint ladder says so (§7.3), and the
  band's width is the lever (§7.4). The spheres are not rebuilt: both far
  fields passed the same excess light for the same reason, mixing once a
  texel, which change 1 removes from whichever representation draws.

**For phase 2,** the bake's statistics (a fraction, an in-cloud depth, a base
and a top a layer) stay readable from a fragment stage with the one binding
the composite's second body uses today.

### 5.10 The history: motion, the clip and the jitter

**Motion is rejected per pixel.** `cloudFrame` calls a frame `'motion'`, and so
immediate, when the camera turns 20° or the eye moves a tenth of its height
over the nearest of six boundaries (`cloudFrame.ts:217-220, :524-543`). At a
boundary that height is zero, so any speed trips it. A descent at 1.2% of its
height a frame is immediate for about ten frames each side of every boundary
it crosses (**D**), and each switch divides the step budget by four and swaps
a converged pixel for a single sample. That is a step in the cast the
descent's detector exists to find.

- The rule goes, with `MOTION_TURN`, `MOTION_SHARE` and the reason.
- What it guarded is already tested per pixel: parallax over 0.1 of the kept
  depth, a depth 20% off, a scene now in front (`cloudHistory.ts:391-408`). A
  near pixel is rejected and takes the bilinear current at the full step
  budget; a far pixel in the same frame keeps its history. Quality falls
  smoothly with speed, and nothing switches.
- A reprojection that leaves the previous frame, or passes behind its eye, is
  already refused (`cloudHistory.ts:391-395`), so a turn of any size needs no
  rule of its own.
- The immediate regime stays for a discontinuity: `'first'`, `'field'`,
  `'picture'`, `'jump'`, `'resize'`, `'cut'`, `'force'`. A steady warp is not
  one (§4.7).
- **The landed rule has no floor, which is the same defect seen from level
  flight.** Within ten frames' travel of any base or top, 42 m at 250 m/s,
  every frame is immediate, so an aircraft cruising at a cloud's base never
  accumulates a sample (`cloudFrame.ts:524-525`; phase 0's council). The
  history's test gains that case (`cloudHistory.gpu.test.ts`, package H):
  level flight 20 m under a base at 250 m/s for 120 frames stays
  `converging`, `resets` does not rise, and a pixel on the horizon reaches
  the history's eight samples.

**The wind in reprojection is the level's turn.** `trace.wind` is one vector
(`cloudUniforms.ts:147, :497`). The three rates land beside it as
`trace.turn` (§4.11), and the kernel moves the reprojected point by
`−ω_k·(ŷ × X)·Δt` (as built it subtracts `wind·Δt`, `cloudHistory.ts:363`),
with `k` the level its height falls in, found from the body's boundaries. The
trace writes nothing new.

**The clip's width is measured, on its bias.** At 5% noise a sample, the 1.25σ
clip holds a stationary pixel's mean 2.1% from its samples' mean, because a
bilinear value averages two or four samples and its σ understates one
sample's (phase 0 package report, WP8). `clip` takes 1.25, 1.5 and 2, and the
rule reads that bias, not a pixel's deviation, which is near 5% at any width
(§7.4).

**The jitter gives three numbers a ray:** the first step's share, the point
inside the history pixel, and the handover's `ξ`.

- **`ign`**, as built (`cloudNodes.ts:201-214`): interleaved gradient noise
  with an R1 step a frame, and a third value from a third transposed read. No
  binding.
- **`stbn`**, the candidate: a 64 × 64 × 16 scalar mask, blue in each slice and
  in each pixel's sequence (Wolfe et al. 2022, **R** by the plan's citation;
  the energy's kernel widths are transcribed by the package), read by
  `textureLoad` at `(x, y, (frame >> 2) mod 16)`, and at two fixed offsets for
  the second and third values. One binding.
  - **The slice is the pixel's own sample count.** A history pixel takes a
    fresh sample every fourth frame (`cloudHistory.ts:60, :97-103`), so
    indexed by the frame it would see every fourth slice, and the mask's
    property in time is over consecutive ones. Indexed by `frame >> 2`, its
    eight samples are eight consecutive slices.
  - **It wraps with no shift.** The mask is toroidal in time, and a sequence
    restarted or shifted every cycle "has an error spike" under an exponential
    average (Wolfe et al., arXiv 2112.09629, **W**, by the physics critique).
    Draft 1 shifted it every sixteen frames.
- The mask is generated here, by void-and-cluster on the 3D torus from a
  seeded `xoshiro128**`: 65,536 placements, minutes in Node (**E**). A
  published mask's terms were not read for this design, and a generated one
  needs none.

### 5.11 The references

All live in `apps/ingest/src/transport/` and are Node-only. What the app and
its tests read are generated tables in `packages/rendering`, each with a
header naming its generator, its inputs' hashes and its source, and nothing
that differs between two runs (§10.1, rule 7).

**The slab oracle solves two problems.**

|                  | The true medium                                                                                                  | The renderer's medium                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Phase, depth     | `p`, `τ`                                                                                                         | `p′`, `τ′` (§5.1)                                                                                                        |
| What it is for   | What the scaled medium is measured against (row 3), and what the cumulus's tracer and the Monte Carlo slab trace | What the march is judged against (rows 1 and 2), and what the higher orders' table is cut from, in the march's own depth |
| Its own numerics | Delta-M at `2N` streams and the single-scattering correction, on the Mie moments                                 | The same machinery on a phase with no diffraction peak, which it truncates little                                        |

- Legendre moments of each row and band come from the Mie coefficients
  themselves (`apps/ingest/src/mie.ts:141-188`), averaged over the size
  distribution the table uses (`apps/ingest/src/mieTable.ts:169`), times the
  cap's coefficients for the disk. The table's 0.28° texels at 90° are too
  coarse to integrate moments to `l ≈ 2x` (research §1.2). `p′`'s moments are
  `p`'s less the Fraunhofer pattern's, which are closed-form.
- Double-Gauss nodes, every azimuthal mode, a thin-layer start under the
  smallest cosine, doubling with the beam carried apart, the requested view
  and sun cosines as zero-weight nodes. The structure is research §1.2's
  (**M** for its sources; the package works from Hansen and Travis 1974 and de
  Haan et al. 1987, read). The oracle's first-order term is evaluated on the
  series, not on the half-float table the march reads.
- **It proves itself.** Flux conservation to 10⁻⁶ at albedo one. 64 and 128
  streams within 0.5% over the domain. Henyey–Greenstein at `g` 0.75 and
  0.875, where both the book and the tool can answer (Prahl's thesis verifies
  at 0, 0.5 and 0.875, and at 0.75 for the angular values, **W**, by the
  physics critique), against a committed `iadpython` run (MIT) and van de
  Hulst's rows, which the package transcribes with their page. The Mie case
  against one committed PythonicDISORT run (MIT): one band, three depths,
  three suns, twelve views, with the moments it was given, its version and its
  command. Both fixtures are generated once, in a virtual environment outside
  the tree (ruling 6), and each one's header names the tool, its version and
  the command.
- **The scaling's own bill is the rubric's row 3, and it is reported first.**
  Package R1 records the largest relative difference in radiance between the
  two problems over the domain, with the cone left out. The rubric declares
  it at 3%. The committed table holds both solutions, and
  `slabTables.test.ts` recomputes the figure and holds it. Over 3% it is a
  declared miss: the figure goes to the orchestrator the day it is known,
  with the points that carry it, because it stands only by the council's
  amendment (rubric §9). It does not stop package M2: the march's own bar
  is against the scaled problem.
- **Why the split is the right one.** Outside the diffraction cone the march
  and the scaled oracle solve one problem. First order's unscaled source with
  the whole Mie phase is `σ·p = σ′·p′ + σ·f_δ·p_diff` (**D**, from §5.1's
  definition of `p′`), and `p_diff` is the Fraunhofer pattern, which the
  domain leaves out with the forward cone. So what rows 1 and 2 hold is the
  march's transport: the step's integral, the three-term source and its
  table's read. What the medium itself costs is row 3's, and what a slab's
  source costs on a cloud that is not a slab is row 6's.

**The domain of "within 5%"** is the rubric's §6.1, which took it from here:

| Axis           | Values                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bands          | 680, 550, 440 nm                                                                                                                                       |
| Radius rows    | 6, 10 and 16 µm                                                                                                                                        |
| Unscaled `τ`   | 5, 10, 20, 50 on the grid; 7 and 30 held out                                                                                                           |
| Sun            | `μ₀` 1, 0.5, 0.2 (elevations 90°, 30°, 11.5°) on the grid; 0.7 and 0.35 held out                                                                       |
| View           | `μ` 0.2, 0.4, 0.6, 0.8, 1 at azimuths 0°, 45°, 90°, 135°, 180° from the sun                                                                            |
| Reflected      | Every direction but the two exclusions below                                                                                                           |
| Transmitted    | Every direction more than the larger of 6° and 1.5 diffraction cones from the sun: 6° at these three rows, whose cones are 3.2°, 1.9° and 1.2° (**D**) |
| Reflected flux | Within 2%, by eight Gauss points in `μ` and sixteen azimuths, 128 rays a case                                                                          |

- **The generator lists the scattering angle beside every point,** and leaves
  to the glory's test (§6.2) every point within 8° of the antisolar direction
  or between 136° and 146°. Draft 1 said no grid point sat on a ring; two sit
  on the glory's center (`μ = μ₀ = 1`, and `μ = μ₀ = 0.2` at 180°) and a row at
  `μ₀ = 1, μ = 0.8` is at 143.1°, a degree from the cloudbow (the physics
  critique's finding 6, **D** there).
- **Held-out points judge.** The table and the octave fit are made on the
  grid. Both are judged on the grid and at the eight held-out pairs, so a
  fit's figure is not its own residual.
- **The reflected flux is the only flux gated.** A march returns radiance, so
  the flux is formed by the stated quadrature. The transmitted flux is not
  gated: with first order's exact phase it holds the diffraction half twice by
  construction, 24% high at `τ = 5` under an overhead sun (the physics
  critique's finding 4, **D** there), which §5.1 declares. PythonicDISORT says
  the same of its own correction: it "is applied to the intensity but not to
  the flux" (**W**).
- **Under `τ = 5`** the rubric records and no row turns. Package R1 records
  the reconstruction's error at `τ` 0.5, 1 and 2, where cirrus, altocumulus
  and every cloud's edge live, and ADR-0068 carries the figures.

**The black-surface flux the calibration reads.** `slabReference.generated.ts`
also exports `R(τ, μ₀)` for the true medium over a black surface, at `μ₀` 0.7
and 0.4, on a logarithmic grid of `τ` from 0.1 to 100. Package G reads it
(§5.2), because a test in `packages/rendering` cannot import the oracle from
`apps/ingest` (`scripts/check-graph.mjs:68-72`), and phase 2's delta-Eddington
check reads the same table.

**The Monte Carlo slab** runs on the true medium. It is the oracle's
independent check, the only reference that sees the glory's true contrast, and
phase 2's column in embryo.

- **Backward, from each detector direction, with next-event estimation to the
  sun.** Three suns are three lobes, which one fixed mixture of the phase and
  a lobe toward each serves. Draft 1 traced forward and scored 25 detector
  directions at every collision, where a phase reaching 10⁴ sr⁻¹ leaves a
  variance near 10³ a collision and wants 10⁷ photons, not 10⁵ (the physics
  critique's finding 17, **D** there). Nothing is truncated.
- A stream a path, `Rng.fromSeed(deriveSeed(base, index))`
  (`packages/procedural/src/rng.ts`, `seed.ts`), and sixteen batches summed in
  order, so the result does not depend on how the run is split. **A row is
  refused when its batch means are not consistent with its standard error,**
  because a heavy-tailed score's sample error understates the truth until the
  rare events are drawn.
- **Every committed row is held to adding-doubling at `3·SE + 0.5%`,** the
  half percent being the oracle's own stream convergence. The comparison is in
  the table's header, at every depth and not at `τ = 5` alone. `τ` 5 runs in
  the gate if its first measured run is under five seconds. The slow suite
  regenerates one row of `τ` 20 and holds it to the same bound; package R1's
  done command records that row's runtime, and a row over 60 s leaves the slow
  suite, which is in CI's 20-minute job.
- It reports the glory ring's peak over its trough at 10 µm beside the
  oracle's, which is the size of §5.1's second declared item.

**The path-traced cumulus.**

- **The fixture** is a density grid built on the CPU from `cloudFieldAt`: one
  `fair-cumulus` cell, its neighbors masked off, 160 × 160 × 96 voxels of 20 m,
  and a congestus at 40 m. 2.5 million evaluations of the field, seconds to a
  minute (**E**). No readback is needed, because the noise's CPU twin is
  already held to the GPU's bake within half an 8-bit step
  (`cloudNoise.gpu.test.ts`; phase 0 package report, WP4).
- **A reference cannot go stale in silence.** The fixture is rebuilt from the
  field wherever it is used; it is not committed. The generated reference
  carries 1,000 of its voxels, drawn by a seed, and the genus table's hash,
  and a Node test fails when `cloudFieldAt` no longer returns those voxels.
  Package G moves the regimes' thickness in wave 3 (§5.2), so the reference is
  generated after G merges (§10.3), and any later change to the field fails
  that test before it misleads a gate.
- **It traces the true medium:** the unscaled `σ` and the whole Mie phase,
  peak included. The scaled medium is the march's approximation, and a
  reference that shared it would not test it.
- **The CPU tier,** float64: delta tracking against an 8³-brick maximum, ratio
  tracking to the sun, the phase sampled by inverse CDF from the unconvolved
  table at the voxel's radius, next-event estimation to a point on the disk
  with multiple importance sampling, a sky of the table's `L̄` and its two
  differences so the march and the tracer stand under one sky, and a
  Lambertian ground. A stream a sample, seeded by pixel and index.
- **It renders the curves' own pixels.** In each of the rim's and the
  sunward edge's masks, eight bins of line-of-sight depth with sixteen pixels
  each; and sixteen each in the core and the base: 288 pixels a case at 4,096
  samples, about 1.2 million paths and under 20 minutes of one core (**E**, at
  draft 1's rate; the physics critique's finding 14). One process a case, six
  cases, granted a CPU window by the orchestrator.
- **The GPU tier** is a compute kernel in the GPU suite, opt-in under
  `IR_CLOUD_MEASURE`, rendering 256² at 1,024 samples. It is held to the CPU
  tier's 288 pixels by a count: at most three beyond three combined standard
  errors and none beyond five. A bound on every pixel at three would fail one
  run in two by chance (**D**: `1 − 0.9973²⁸⁸`). It writes the images.
- **The furnace is each tier's unit test:** at albedo one under a uniform sky
  with no sun and a ground of albedo one, every path's throughput is one and
  every path ends on the sky, so a pixel equals the sky with zero variance at
  one sample (research §3.1, **D**).
- **Six cases:** sun–view angles of 15°, 90° and 165°, at both sizes.
- **The measure** (research §3.5). In a rim mask (sun behind the cloud, depth
  under 3, beside the silhouette) and a sunward-edge mask (sun behind the eye,
  depth under 5, on the lit side), the curve of radiance over the core's
  median against line-of-sight depth, which is exact from the fixture.
  - **The curve error** is the largest relative error of any bin, over the two
    masks. Gate 2 is that error within 20% in all six cases, the rubric's row
    6, or three standard errors of the reference's bin where that is larger.
  - **The silver lining is present** when the rim curve's peak is within 20%
    of the reference's in height and one bin in depth.
  - **The edge is present** when the sign of edge less core matches and its
    depth is within 30%. Where the reference's edge is within three standard
    errors of its core there is no sign to match, and the check is that the
    march's edge is within 10% of its core.
  - **And an absolute check,** because a curve divided by its core hides the
    core: the march's core and base medians are within 15% of the tracer's, or
    three standard errors if that is larger. A slab's source on a body that
    leaks light through its sides gets the core's level wrong first.
- **Tolerances** are those figures or three standard errors of the reference's
  own bin, whichever is larger.

**The march's furnace** is a GPU test with its conditions stated: a uniform
sky table, no sun, the air's extinction off, a background of `L̄`, a slab and a
broken field, for the fine march and the far one. It is an identity of the
weights' bookkeeping through steps, fractions and far steps, so it is held to
10⁻³, which is the rubric's row 4.

### 5.12 The research's open questions, settled

| #   | Question                                                     | Settled                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The domain of "within 5%"                                    | §5.11's table: three radius rows, held-out points, the scattering angle listed, the rings left to their own test, the reflected flux alone at 2%                                                                                                                                 |
| 2   | A readback of the baked noise, or a CPU twin                 | The twin, `weatherNoise.ts`, which a GPU test already holds to the bake                                                                                                                                                                                                          |
| 3   | Where each reference runs                                    | Adding-doubling's own tests in the gate; Monte Carlo at `τ` 5 in the gate if under five seconds measured, one row in the slow suite if under 60 s, the rest generated; the CPU tracer generated offline in a granted window; the GPU tracer an opt-in instrument in the campaign |
| 4   | Octave constants per band or shared; a slab table for a deck | Shared, fitted in Node, built on the GPU only if the fit passes. The table is S, and it draws every genus                                                                                                                                                                        |
| 5   | Does the sky's split replace occlusion by the column         | Yes. The table holds the mean and two irradiance differences; only the differences are weighted by the column                                                                                                                                                                    |
| 6   | Baum's terms                                                 | Jon has the data and has said to commit the reduced table with its citation and "no license stated" (ruling 5). Package T4                                                                                                                                                       |
| 7   | Rain's generator                                             | The Mie series, in phase 4                                                                                                                                                                                                                                                       |
| 8   | The sun's disk in the path tracer                            | It samples the disk with the unconvolved table. Everything else uses the convolved phase and a point sun                                                                                                                                                                         |
| 9   | The dark edge's inputs, and whether it is allowed            | The sun's two depths, no new tap; allowed only if the winning transport misses the edge curve, and kept only if it then passes both gates                                                                                                                                        |
| 10  | ISCCP's retrieval geometry                                   | `μ₀ = 0.7` over a black surface on 5 km pixels, detection at a reflectance of 0.03, with a second run at 0.4 that may move no share ten points                                                                                                                                   |
| 11  | §3.5's tolerances                                            | The proposals, or three standard errors of the reference's bin if larger, with an absolute check beside the curves                                                                                                                                                               |

---

## 6. Tests

Each test is listed with what it pins, its suite and its package. GPU files
run under `pnpm test:gpu` and the lock, drive their module with analytic media
through the stand-ins as phase 0's do, and read no LFS object. An opt-in file
is `describe.skipIf(!process.env.IR_CLOUD_MEASURE)` and writes
`.data/clouds/<name>.json`. Every regression test is watched failing with its
defect put back before it is kept (`.claude/rules/testing.md`).

### 6.1 Node, in the gate

| File                                                                                                                | Package | Pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/devtools/src/pictureFormat.test.ts` (existing)                                                            | K       | Version 3 takes `weather`; an unknown key inside it is refused; a regime the build does not know decodes; versions 1 and 2 decode as before; `encodePictures` writes 3 exactly when a picture has weather                                                                                                                                                                                                                                                                                                                |
| `apps/game/src/planetarium/presetUrl.test.ts` (existing)                                                            | K       | Every cornerstone round-trips `pictureLink`; `shot=3` exactly with weather; `PICTURES` and `CORNERSTONES` share no id                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/devtools/src/solarTime.test.ts`                                                                           | K       | **Property:** for any place, tilt, period and reachable target on a synthetic sun, the solved instant's elevation is the target within 10⁻⁴°, its trend the one asked, and no earlier instant after `after` satisfies both; an unreachable target is null                                                                                                                                                                                                                                                                |
| `apps/headless/src/cornerstoneLedger.test.ts`                                                                       | K       | Each cornerstone resolves; its sun is within 0.5° of §3.3's constraint with the right trend; its heading is the solved azimuth plus its offset; its lens is inside `FOV_MIN..FOV_MAX`; the ground under G1, G3 and G6's end is above the sea; G3's layer base dips at least 0.5° past its sun, and no cloud of the layer stands where a base's sun ray re-enters it (§3.3)                                                                                                                                               |
| `packages/devtools/src/harness.test.ts`, `clouds.test.ts` (existing); `apps/game/src/engine/pictureWeather.test.ts` | K       | `settled()` returns `clouds` and waits on it; a page without the system settles as before; the clouds settle at 32 frames; `takePicture` sets the weather after the time and reports `'unavailable'` without the system; leaving the picture restores the levers it found                                                                                                                                                                                                                                                |
| `scripts/weather/capture.test.mjs`                                                                                  | K       | The argv of each cornerstone, arm and cast; a take with `settled.ok` false or the wrong `weather` is refused; the output path is the common directory's from any worktree; the sheet's layout from a fixture of three plates                                                                                                                                                                                                                                                                                             |
| `apps/game/src/render/sceneLayout.test.ts` (existing)                                                               | V       | No layout has a `velocity` row; a temporal layout keeps `reactive`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/game/src/render/cloudContracts.test.ts`                                                                       | C       | Every stub module imports and has the shape §4 gives it. Shapes only: no value of a stub table is asserted                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/rendering/src/weatherGenus.test.ts`                                                                       | D       | §5.2's check of the law's size; the profile continuous and zero outside its level; the radius non-decreasing with height in an adiabatic genus; each genus's mean `σ` is the table's; `σ′ = (1 − 1/Q_ext)·σ`                                                                                                                                                                                                                                                                                                             |
| `packages/rendering/src/weatherClimate.test.ts`                                                                     | D       | `bodyWeather` null for a dry world; its seed is `deriveSeed(surface.seed, 'weather')` and no draw from `rng` (two bodies generated in either order give one weather: rule 4); `regimeWeather` reproduces `scenarioCoverage` for every scenario at 1,000 directions; the zonal law's Earth offsets; `sample` is a function of its arguments alone (**property**)                                                                                                                                                          |
| `packages/rendering/src/weatherField.test.ts`                                                                       | D       | `cloudFieldAt` equals the as-built recipe on every regime at `t = 0`; `columnDepth` equals a 512-step integral of the unscaled extinction; **ten years past the epoch a cloud drifts without a step** (**property**: at any `t` to 3.2 × 10⁸ s, the field at `t` and at `t + 1/60 s` differ by the turn's own displacement to float64 rounding, and no instant is a restart); **the sight count:** clear lines of sight through each cumuliform regime, by zenith angle, follow §5.9's form within 10% at the fitted `c` |
| `apps/headless/src/weatherCanon.test.ts`                                                                            | D       | `world.stateHash()` is equal with the weather evaluated between ticks and without; no weather module imports `simulation`                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/rendering/src/weatherCalibration.test.ts`                                                                 | G       | §5.2's shares for every genus on 5 km pixels at `μ₀` 0.7, with at least half the cloudy pixels detected, and none moving ten points at 0.4; each genus's thickness inside its range; the cells' exponent                                                                                                                                                                                                                                                                                                                 |
| `packages/rendering/src/weatherScenario.test.ts` (existing)                                                         | K, C    | The three new scenarios are valid, and `dusk-altocumulus` has no cover where the local sun is over +0.1°; `cloudsServed`: far-shore V yes, Earth no, Venus no                                                                                                                                                                                                                                                                                                                                                            |
| `packages/rendering/src/mieTable.test.ts` (existing)                                                                | T1      | `convolveDisk` keeps each row's integral to 10⁻⁴, is the identity as `α → 0`, leaves an isotropic phase isotropic exactly, and equals the Funk–Hecke form on a Henyey–Greenstein phase to 10⁻⁴; `diffractionShare` is `1/Q_ext` at each row; at a row's own radius the convolved glory ring is within one texel of `gloryRed`                                                                                                                                                                                            |
| `apps/ingest/src/iceTable.test.ts`, `packages/rendering/src/iceTable.test.ts`                                       | T4      | The reduction's band weights, resampling and normalization on a small synthetic file; on the committed table each row's integral within 10⁻³, its asymmetry within 2% of its bulk's, and no local maximum near 22° or 46°; the header carries the citation, "no license", and the README's date. The row recomputed from the source skips without `.data/weather/baum/`                                                                                                                                                  |
| `packages/rendering/src/skyIrradiance.test.ts`                                                                      | T2      | `L̄`, `Δ` and `Δ_s` each equal a 2,000-direction quadrature of the air's march within 1% at eight grid points; a sky uniform above and dark below gives `Δ = 2`; the logarithm round-trips                                                                                                                                                                                                                                                                                                                                |
| `apps/ingest/src/transport/addingDoubling.test.ts`, `moments.test.ts`, `legendre.test.ts`                           | R1      | `χ₀ = 1` and `χ₁` the table's `g` to 10⁻³; `p′`'s moments are `p`'s less the Fraunhofer pattern's and its clamped share is under 1%; conservation to 10⁻⁶; the Henyey–Greenstein slabs at 0.75 and 0.875 against the committed fixtures to 0.5%; 64 against 128 streams under 0.5% on the domain; the Mie case against the PythonicDISORT fixture to 0.5%                                                                                                                                                                |
| `apps/ingest/src/transport/monteCarloSlab.test.ts`                                                                  | R1      | `τ` 5: within `3·SE + 0.5%` of adding-doubling at twelve views; the result independent of the batch split; a row with inconsistent batch means is refused                                                                                                                                                                                                                                                                                                                                                                |
| `apps/ingest/src/transport/slabTables.test.ts`, `octaveFit.test.ts`                                                 | R1      | Three committed rows of each table recomputed to half-float rounding; the reconstruction through the committed table's own read, between its nodes and at every azimuth, is at most the figure its header records; the fit re-run reproduces the committed constants and their held-out error; `R(τ, 0.7)` is monotone and equals the oracle at five depths                                                                                                                                                              |
| `apps/ingest/src/transport/pathTrace.test.ts`; `packages/rendering/src/cumulusFixture.test.ts`                      | R2      | The furnace with zero variance at one sample; a homogeneous slab fixture within three standard errors of adding-doubling at one geometry; **the fixture's 1,000 recorded voxels equal `cloudFieldAt`, and the genus table's hash is the reference's**                                                                                                                                                                                                                                                                    |
| `apps/ingest/src/blueNoise.test.ts`                                                                                 | T3      | Each slice's energy under a quarter of Nyquist is under 10% of white noise's; each slice is a uniform histogram; consecutive slices at one pixel are spread (the paper's temporal property); the generator is deterministic from its seed                                                                                                                                                                                                                                                                                |
| `apps/ingest/src/isccp.test.ts`, `packages/rendering/src/isccpZonal.test.ts`                                        | E       | The reader's handling of the undeclared fill and the offset on a small committed fixture; the zonal table's means, §2.1 item 15                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/rendering/src/cloudOverlap.test.ts` (existing)                                                            | M1      | §5.9's law: split-invariant under one cover (**property**); one half for a half-clear layer of depth 20 at any cut; `e^(−τ′)` at a cover of one; `n = 1` for a vertical crossing                                                                                                                                                                                                                                                                                                                                         |
| `apps/game/src/render/cloudFrame.test.ts`, `cloudLevers.test.ts`, `cloudUniforms.test.ts` (existing)                | C, H    | Earth unserved by default and served when forced; a `'picture'` reset keeps every level whose anchor did not move; a `'field'` reset rebuilds all; no frame is `'motion'`; each body's levels are its own weather's; the turn's reductions exact to 3.2 × 10¹² s; the levers' guard and the field key                                                                                                                                                                                                                    |
| `scripts/castSteps.test.mjs`                                                                                        | I       | A synthetic drift gives no step; the same with one injected step gives that frame; a strobe is left to `frameDiff`; `--against` drops a step both series share; a synthetic smear after a stop is a trail and convergence noise is not                                                                                                                                                                                                                                                                                   |
| `scripts/clouds/measure.test.mjs`, `campaign.test.mjs` (existing)                                                   | Q       | The new batches' plans, the `noise` step, the casts' stage and the campaigns' stage lists                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 6.2 GPU, in `pnpm test:gpu`

| File                                                                                                                    | Package                    | Pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudPremises.gpu.test.ts` (existing)                                                                                  | C                          | §10.2's premises                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cloudTrace.gpu.test.ts` (existing)                                                                                     | C, then M1                 | **The census of the real kernel:** at most 16 sampled and exactly 4 storage textures in the system's own trace WGSL. A slab's `T′ = e^(−σ′L)` to 10⁻⁴; **a layer's transmittance unchanged, and its light within 1%, as `maxSteps` runs from 16 to 192**; **a slab's reflected first order within 1% of its closed form at `μ/μ₀` of 1, 2 and 5 and step depths of 0.3 to 1.6**, with the left-endpoint variant built in the test failing it; a ray inside a slab toward a horizon 75 km out takes its first step at the schedule's length, not the budget's; `stop` inside the band for every `ξ`; no ray stops short of `stop` |
| `cloudSunDepth.gpu.test.ts` (existing)                                                                                  | M1                         | `CloudSun.depth` on a slab: the depth to a sample and the ray's whole, each within 2% at samples deeper than one tap's width; with the taps spaced in depth, the transmittance within one scaled depth of a lit face within 15% of exact, where fixed taps are off by a factor                                                                                                                                                                                                                                                                                                                                                   |
| `cloudSlab.gpu.test.ts`                                                                                                 | M2                         | **The slab gate:** the march on an injected slab against the oracle's solution of the renderer's own scaled medium, over §5.11's domain and held-out points, radiance at 5% and reflected flux at 2%, at the three radius rows, with the shipped sun, which is the rubric's run, and with `exactSlabSun`, recorded beside it                                                                                                                                                                                                                                                                                                     |
| `cloudFurnace.gpu.test.ts`                                                                                              | M2                         | Under a uniform sky table, with no sun, the air's extinction off and a background of `L̄`, a slab and a broken field return `L̄` to 10⁻³                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cloudFarFurnace.gpu.test.ts`                                                                                           | X                          | The same through the far march                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cloudGlory.gpu.test.ts`                                                                                                | M2                         | A deck of one radius row seen from above at the antisolar point: the red ring within one atlas texel of the table's ring; the ring's peak over its trough within 10% of the scaled medium's reference; the cloudbow's peak inside 139.7–142.0°. Its opt-in half scores `mean` and `bins` against `sample` on §7.4's three cases                                                                                                                                                                                                                                                                                                  |
| `cloudLight.gpu.test.ts` (existing)                                                                                     | T1                         | The atlas's lookups equal the CPU's convolved table at 200 angles × 5 radii in both classes, the gain in the fourth channel; a fetch at the droplets' last row with the ice rows poisoned reads no poison                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `cloudSky.gpu.test.ts`                                                                                                  | T2                         | The node equals the table at 100 samples; the three blocks never blend                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cloudJitter.gpu.test.ts`                                                                                               | T3                         | The mask's reads are the generated bytes; a pixel's eight samples read eight consecutive slices; three values a ray are pairwise uncorrelated over a frame (correlation under 0.05)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `cloudMaps.gpu.test.ts`, `cloudClipmap.gpu.test.ts`, `cloudDensity.gpu.test.ts`, `cloudNoise.gpu.test.ts` (existing)    | F                          | Two MRT targets from one quad; the cube equals `BodyClimate.sample` at every texel within one 8-bit step, for a regime and for the zonal law; each medium equals `cloudFieldAt` at 1,000 points; the turn keeps a feature at its turned place over 10⁴ s; every loop read still names level 0; **the fine march's transmittance over one field at footprints of a quarter, a half and a whole cell is within 10% of the resolved field's**                                                                                                                                                                                       |
| `cloudFar.gpu.test.ts` (existing)                                                                                       | X                          | A uniform slab still equals the fine march to 10⁻³; **a half-clear layer crossed at a run of five sight lengths passes §5.9's law to 10⁻³, in one step and in five, and the variant mixing once a step, built in the test, fails it**; a deck's higher orders from above within 5% of the fine march's, with the variant reading the layer's middle failing it; a column of unscaled depth 0.12 stays in the bake                                                                                                                                                                                                                |
| `cloudHistory.gpu.test.ts` (existing)                                                                                   | H                          | Through the real `cloudFrame`, an eye crossing a boundary at 250 m/s stays `converging` and `resets` does not rise; an off-frame reprojection is rejected; a feature in the high level moves by its own turn                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cloudComposite.gpu.test.ts` (existing)                                                                                 | V, then N                  | The composite writes no `velocity`; a point source behind a slab reads back at `e^(−τ′/(1 − f_δ))`; a sky with no source behind it is unchanged, bit for bit where there is no cloud                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `rings.gpu.test.ts`, `plumes.gpu.test.ts`, `entryTrace.gpu.test.ts`, `cloudFront.gpu.test.ts` (existing)                | W                          | Behind a knot of transmittance 0.3 the object reads back at 0.3 of itself, and the ring under the knot's light; in front of it, unchanged; with no handle, the pixels, the pipeline count and the WGSL hash of today                                                                                                                                                                                                                                                                                                                                                                                                             |
| `upscale.gpu.test.ts` (existing)                                                                                        | V                          | The rebase check reads `motion.rg`; the overlay probe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cloudSecondBody.gpu.test.ts`, `cloudSystem.gpu.test.ts`, `cloudWarm.gpu.test.ts`, `cloudSensor.gpu.test.ts` (existing) | C at each contract, then N | Green at every wave's merge (§4.11). At integration: two bodies draw two layer sets; declared bytes equal the GPU's; no pipeline on the first frame of any lever set; without the flag the chain is a chain without clouds                                                                                                                                                                                                                                                                                                                                                                                                       |
| `materials.gpu.test.ts`, `atmosphereSky.gpu.test.ts`, `surfaceVisibility.gpu.test.ts` (existing)                        | C, T2                      | Unchanged, and the WGSL of all six sites that build `AirUniforms` hash-equal before and after the sky table joins it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cloudPathTrace.gpu.test.ts`                                                                                            | R2                         | Always: the GPU tracer's furnace. Opt-in: the six cases, held to the CPU tier's 288 pixels by §5.11's count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Added by the decisions,** for packages L and Y:

| File                                                                                          | Suite | Package    | Pins                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rendering/src/cloudSunSchedule.test.ts`                                             | Node  | L          | **Property:** over any sequence of frames, suns, anchors and jumps, no frame bakes more grid slices than the cap, a sun's turn alone bakes no more than the frame before it, no grid slice is baked while a level of its source is untrusted, and the weight is zero until every slice holds the current field and never moves more than `1/sunRamp` a frame; the wake's weight is a function of the eye's height alone         |
| `cloudSunDepth.gpu.test.ts`, `cloudVolume.gpu.test.ts` (existing)                             | GPU   | L, then M1 | The volume has two levels and no bound, and its declared bytes are the GPU's; a slab's grid holds its depth within 2% from a sun 5° up and from one 1.5° under, where the bake stops at the base; with the weight at zero a sample's sun is the statistics', and it equals the grid's on a uniform layer within 2%                                                                                                              |
| `cloudOverPass.gpu.test.ts`, `cloudComposite.gpu.test.ts`, `cloudWarm.gpu.test.ts` (existing) | GPU   | Y          | With nothing marked over the clouds the timeline holds no `scene over clouds` and the frame equals pass B's within one half-float step; with a marked object visible, pass B runs and the pixels are today's; under `lean` pass B's descriptor discards its multisampled color, its depth is read-only, and a frame is equal with it on and off; no pipeline on the first frame of either form or on the frame they change over |

**Added by the rubric and by phase 0's reviews.** Each row names what could
not fail before it. A test here is kept only after it is watched failing
with its defect put back, which the rubric asks of every instrument (§6
there).

| File                                                                                         | Suite | Package   | Pins                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | ----- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloudSlab.gpu.test.ts`                                                                      | GPU   | M2        | Rows 1 and 2: the march against the oracle on the scaled medium, 5% at every grid and held-out point and 2% in the reflected flux, with the shipped sun. The exact sun's run is written beside it                                                                                                                                                                              |
| `apps/ingest/src/transport/slabTables.test.ts`                                               | Node  | R1        | Row 3: the scaled medium against the true one, recomputed from the committed table, 3%                                                                                                                                                                                                                                                                                         |
| `cloudTrace.gpu.test.ts` (existing)                                                          | GPU   | M1        | Row 5: a uniform slab's transmittance within 10⁻⁴ of its closed form; a layer's light within 1% of its 192-step value from 16 steps up. And first order within 1% of its closed form at step depths of 0.3, 1.16 and 2 (§5.4)                                                                                                                                                  |
| `cloudGlory.gpu.test.ts`                                                                     | GPU   | M2        | Row 8: the first red maximum within one atlas texel of the table's ring; the ring's peak over its trough within 10% of the scaled medium's reference; the cloudbow's peak between 139.7° and 142.0°. Row 7 is its measured half                                                                                                                                                |
| `cloudRange.gpu.test.ts`                                                                     | GPU   | M1        | Row 21: in a uniform medium at each genus's `σ′`, with the eye inside, the range readout is within 25% of `3.912/σ′`                                                                                                                                                                                                                                                           |
| `cloudFront.gpu.test.ts` (existing)                                                          | GPU   | M1        | The knots on the real field: a point in the gap between two layers, a layer thin in every column, and the ray's end (§4.9)                                                                                                                                                                                                                                                     |
| `cloudHandover.gpu.test.ts`, `cloudFar.gpu.test.ts`                                          | GPU   | X         | Row 11: transmittance within 10% and radiance within 15% across the band, by pitch bin, and 10⁻³ on a slab. A deck's edge beside clear sky within 2% in opacity (§5.9). No atlas block reports fresh while it holds a field older than its face                                                                                                                                |
| `cloudClipmap.gpu.test.ts` (existing)                                                        | GPU   | F         | After a change of weather, with the cube baked a face a frame, no level reports fresh while it holds the old cover, and a texel read back after the settle holds the new                                                                                                                                                                                                       |
| `weatherField.test.ts`, `cloudFrame.test.ts`, `cloudDensity.gpu.test.ts`                     | Both  | D, H, F   | One body point, one instant, two eyes, one density (§5.3)                                                                                                                                                                                                                                                                                                                      |
| `cloudFrame.test.ts` (existing)                                                              | Node  | H         | At every rate of the dock's ladder a steady run of frames raises no jump and no reset; a step of three hours raises one (§4.7)                                                                                                                                                                                                                                                 |
| `cloudHistory.gpu.test.ts` (existing)                                                        | GPU   | H         | Level flight 20 m under a base at 250 m/s accumulates; a feature's expected displacement comes from the CPU field at two instants, so a negated turn fails (§5.3, §5.10)                                                                                                                                                                                                       |
| `cloudSunSchedule.test.ts`                                                                   | Node  | L         | Under a warp of 1,000× no frame bakes more than the cap, and no frame rebuilds the grid whole                                                                                                                                                                                                                                                                                  |
| `cloudSystem.gpu.test.ts` (existing)                                                         | GPU   | C, then N | **The declared bytes are held to what the device was asked for.** The test wraps the device's `createTexture` and `createBuffer` for the system's life and compares their sum with the declaration. Today it sums each resource's own list, so a texture left off a list is unseen, and the radiance meter's buffer, about 1.0 MB at 1080p, and the composite's are outside it |
| `cloudWarm.gpu.test.ts` (existing)                                                           | GPU   | C, then N | A lever set with `served` and one with `second` draw their first frame with no new pipeline                                                                                                                                                                                                                                                                                    |
| `cloudLevers.test.ts` (existing)                                                             | Node  | C         | Two lever sets differ in hash exactly when a shipped lever differs; `lightTaps` 6 and 8 are valid; the resolved set at each size is the set's own in phase 1                                                                                                                                                                                                                   |
| `weatherScenario.test.ts`, `cloudFrame.test.ts` (existing)                                   | Node  | C         | C11 (§4.8)                                                                                                                                                                                                                                                                                                                                                                     |
| `scripts/panel/*.test.mjs`                                                                   | Node  | J         | §8.6's list                                                                                                                                                                                                                                                                                                                                                                    |
| `scripts/weather/capture.test.mjs`, `apps/headless/src/cornerstoneLedger.test.ts` (existing) | Node  | U         | The zoom cast and the slow descent each hold frames on both sides of the band, from the path, the lens and the lever; the overlay guard's station is in frame; a record without its provenance or its role is refused; a cast before the hold is kept with its rate and after it is refused outside 58 to 62 Hz                                                                |
| `scripts/castSteps.test.mjs`, `scripts/weather/classify.test.mjs`, `drift.test.mjs`          | Node  | I         | A flagged step is an entry, an exit or an error by the rubric's three cases, on fixtures of each; an unresolved one cannot pass; a cast with a gap at a suspected step is sent back, never divided; a synthetic field shifted by a known vector is measured within 2%, with its sign                                                                                           |
| `scripts/clouds/measure.test.mjs`, `rules.test.mjs`, `campaign.test.mjs` (existing and new)  | Node  | Q         | A stance's row carries the stance's own lens after any other stance; every row carries its rate and its levers' hash; a run whose page's build id is not the tree's is refused; each rule of §7.4 and each bar is computed from the documents, with the allowance capped at 0.25 ms; a second stop waits for the first                                                         |

**What CI does not run.** CI's adapter skips the tests that read the pass
timeline (`.github/workflows/check.yml:146`), package Y's among them. That is
the adapter's, and phase 1 does not change it. The orchestrator runs the GPU
suite on the mini after each merge (§10.3), which is where those tests count.

### 6.3 GPU instruments, and the three that could not fail

`cloudFarCompare`, `cloudSunAccuracy` and `cloudCompositeError` are phase 0's
accuracy instruments. Each runs only under `IR_CLOUD_MEASURE`, and each
asserts that its figures are finite and under bounds no figure can reach:
10⁷, 10, and `worst ≤ 1` for a quantity bounded by one. So far-field and sun
accuracy can regress to any finite value with the suite green (phase 0's
review and council).

- **Phase 1's first test change pins them,** in package C. Each instrument's
  document from window 1's run on the landed code is committed beside the
  test, and the test fails when a figure passes its landed value by more
  than a tenth: every case's RMS, bias and worst for the sun's depth; every
  case's footprint transmittance and radiance at 400, 800 and 1,600 m for
  the far field; the identity's residual at the 95th percentile for the
  composite.
- **One case of each joins the always-on suite,** so a regression fails
  `pnpm test:gpu` and not only a campaign: `fair-cumulus` at a 37.5° sun for
  the sun's depth, broken cumulus at 800 m for the far field, and one slab
  for the composite. The full sets stay under the flag, and the campaigns'
  `instruments` stage reads them.
- **The bounds tighten and never loosen, with one stated exception.** Package
  L replaces the sun's with the widened population's (§5.5), package X the
  far field's with row 11's 10% and 15%, and the package that lands M1's
  step re-bases the far comparison once (§5.4). Each replacement is a commit
  that shows the old figure and the new.

| File                                         | Package | Scores                                                                                                                                                                                                    |
| -------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudCumulus.gpu.test.ts`                   | N       | The march on the fixture against the reference: the curve error and the core's and base's medians, six cases, with the exact sun and with the shipped one: gate 2 of §7.4                                 |
| `cloudHandover.gpu.test.ts`                  | X       | The fine and the far march over the band on the real field, by footprint and pitch bin, on every regime. Its bounds are row 11's and are in §6.2 from the start; under the flag it writes the whole table |
| `cloudSunAccuracy.gpu.test.ts` (existing)    | L       | The sun's depth against a 256-step march: five scenarios at five seeded places each, three suns, to the window's edge; RMS, bias and worst                                                                |
| `cloudCompositeError.gpu.test.ts` (existing) | N, Y    | The identity and the thin form against a joint march on analytic slabs                                                                                                                                    |
| `cloudFarCompare.gpu.test.ts` (existing)     | X       | The footprint-averaged transmittance and light again, by pitch bin                                                                                                                                        |

---

## 7. Measurement

### 7.1 The protocol is phase 0's

The machine, the build, the quiet check, the lock, the A/B in one boot and
the output are phase 0's (its §8.1, §8.3, §8.8, §8.9), as
`scripts/clouds/measure.mjs` and `scripts/clouds/campaign.mjs` run them:

- the Mac mini, Mac18,5, Apple M6, 32 GB; the production preview on 8787;
  1920 × 1080 at DPR 1 and 1440 × 900 at DPR 2;
- a row taken beside `vitest`, `tsc`, `tsgo`, `vite`, `astro`, `oxlint`,
  `knip`, `pnpm` or another rig is marked, re-run and counts for nothing
  (`measure.mjs:533-542`); a campaign runs with no package of any phase in
  flight;
- a campaign is detached, keeps a state file and continues where it stopped
  (`campaign.mjs:74-109, :141`).

A phase 1 campaign is new entries in two tables: a batch in `BATCHES`
(`scripts/clouds/measure.mjs`) with its step list, reader and table in
`page.mjs`, and a campaign in `CAMPAIGNS`, whose stage lists
`campaign.test.mjs` pins. Package Q writes them against the contracts' levers
and proves them with `--dry-run`, as phase 0's runner was written before the
system it drove (phase 0 package report, WP10). `measure.mjs` and `page.mjs`
score 78.3 and 77.3 against fta's 91 (same report), so each new step and its
table goes in a file of its own: `noise.mjs`, `sequence.mjs`, `frame.mjs` and
`rules.mjs`.

**What the rubric fixes of the protocol** (§5 there), and package Q builds
into the runner:

- **A steady Δ is the median of five A/B pairs.** The table prints that
  median beside the two sides' medians and says which is which. Today it
  prints a median of deltas beside two independent medians, which need not
  agree: 18.83 and 18.92 beside a Δ of −0.06 (phase 0's council).
- **The allowance is twice the pairs' spread, at least 0.05 ms and at most
  0.25 ms.** A row whose spread would allow more is taken again. It does not
  enlarge the bar.
- **A bar is an A/B Δ or a whole frame.** A pass's time is recorded beside a
  row and no bar is formed from one.
- **Every row carries** its presentation rate (§7.5), the hash of the levers
  resolved at its size (§4.6), and the lens it was taken through.
- **The runner computes each rule's outcome.** `scripts/clouds/rules.mjs`
  holds every rule of §7.4 and every bar of the rubric that a campaign can
  read, as a function of the batch documents, with its allowance. Phase 0's
  rules were each applied by hand (phase 0's council). A summary prints the
  outcome beside the figures it was computed from.
- **A run is tied to its build.** Every run, a campaign's or one started by
  hand, compares the page's `ir.build().id` with the tree's and refuses on a
  difference. Phase 0's placement repeats were started by hand and compared
  nothing.

### 7.2 Stances and batches

**A stance owns its lens.** The landed campaign's `cut`, `scrub`, `fly` and
`pair-neighbor` rows were taken through the lens `pair-moon` left behind,
because a rise framing fits the flight lens and `ir.visit` sets none, and the
runs of one size share a page. Their clouds-off base on `ground` moved from
5.87 ms to 6.92 to 7.29 ms. So every stance in the runner names a focal
length, the runner sets it on entering the stance and reads the lens back
into the row, and a row whose lens is not its stance's is refused
(`measure.test.mjs` holds it by taking a `rise` stance before another). Until
phase 0's retaken rows exist, its reset, fly and `pair-neighbor` figures are
at an unknown field of view, and nothing here leans on them.

The stances are phase 0's (`scripts/clouds/measure.mjs`, `STANCES`), on
far-shore V, with `weather` where they set `scenario`, and these more:

| Stance             | Pose                                                      | For                                                                                   |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `over-deck`        | G4's                                                      | The phase's radius, from above                                                        |
| `earth-orbit-long` | E1's, with its 11.4° lens                                 | B5, recorded                                                                          |
| `earth-limb`       | E2's, with its lens                                       | The handover's band in frame from orbit (§5.8)                                        |
| `descent-150`      | Far-shore V, 150 km up, pitch −40, the 60° lens           | The band in frame on the way down: the frame's center is 237 km off (**D**)           |
| `shore`            | G2's                                                      | A frame with the full sea in view, and so the sea's own split, for the `over` batch   |
| `overlay`          | `horizon`'s, with the engine lit                          | B11, the `over` batch and package W's cost                                            |
| The ten presets    | Each cornerstone and the overlay guard, by its own preset | B6 and B8, which read every cornerstone's whole frame, on the cornerstones' own world |

Every batch's base levers are the landing's defaults: the field, the grid,
the atlas and two passes, at `maxSteps` 192, `lightTaps` 4 and `farFootprint`
800 m. The candidates' names are gone from the runner (its `COMBOS`,
`decisions`, `sweep` and the `cache` group of `images` are deleted at phase
0's landing).

**Campaign `choices`** (phase 1's replaces phase 0's of that name):

| Batch         | Contents                                                                                                                                                                                                                                                                                                                                        | Run type                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `phase`       | `mean` and `bins` at 2, 3, 4 against each other: steady on `over-deck` and `inside`, both sizes, five pairs                                                                                                                                                                                                                                     | `ab`                                                                  |
| `jitter`      | `stbn` against `ign`: steady cost on `horizon`, `inside`; converged noise, the temporal RMS of 64 captures over cloud texels with the jitter moving; the error of the eighth frame after a reset against the 64-frame mean                                                                                                                      | `ab`, and the new `noise` step beside `radiance` (`page.mjs:240-321`) |
| `handover`    | `handoverBand` 1, 1.5, 2 against 3 on `earth-limb` and `descent-150`: the 64-frame mean with the jitter moving                                                                                                                                                                                                                                  | `noise`                                                               |
| `clip`        | `clip` 1.25, 1.5, 2 on `horizon`, `inside`: the bias, the mean of the history less the mean of its samples over 64 frames                                                                                                                                                                                                                       | `noise`                                                               |
| `transport`   | Only if the octave fit passed in Node: O against S, steady on `ground`, `inside`, `orbit`, both sizes, five pairs                                                                                                                                                                                                                               | `ab`                                                                  |
| `casts`       | The zoom from 400 km and the slow descent at each `handoverBand`; the pass at 2 m and the fast descent at each `clip`; each with its clouds-off control and the detector's two controls, read by `castSteps` and classified (§8.1)                                                                                                              | A command stage (`campaign.mjs`) over `capture.mjs`                   |
| `instruments` | `cloudCumulus`, `cloudGlory`, `cloudHandover`, `cloudFarCompare`, `cloudSunAccuracy`, `cloudCompositeError`, `cloudPathTrace` under `IR_CLOUD_MEASURE=1`                                                                                                                                                                                        | A command stage                                                       |
| `over`        | `chain` and `lean` each against `passes`: steady on `orbit`, `horizon`, `inside`, `shore` and `overlay`, both sizes, five pairs; one row of each at the temporal picture on `horizon`; and the placement's cell, the `sensor` span and the frames presented at Retina on `inside` and on `overlay`, nine samples a side at a held 60 Hz (§4.12) | `ab`, and the profile pair                                            |
| `reset`       | A cut, a scrub, a change of weather and a wake from orbit, each as the 60 frames from the event, on `horizon` at both sizes, at `sunSlices` 4, 8 and 16, `sunRamp` 16 and `farBlocks` 1 and 2: each frame's GPU time by pass, and the frame at which the field is whole                                                                         | The new `sequence` step                                               |
| `sun`         | `cloudSunAccuracy` on the two-level volume at phase 0's two suns and at G3's, four taps, on the widened population; the wake cast and a cut cast at each `sunRamp`, read by `castSteps`                                                                                                                                                         | A command stage                                                       |

The `handover` batch stands on `earth-limb` and `descent-150`, where the band
is in frame at 800 m; on `horizon` and `orbit` it is not (§5.8).

**Campaign `landed`**, on the commit that deletes this phase's losers. It is
the campaign that fills the rubric's rows for the phase:

| Batch     | Contents                                                                                                                                                                                                           | The rubric's rows it fills   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `ladders` | The three ladders at the landed configuration, each from its lever's own list of values, on `horizon`, `inside` and `earth-limb` (§7.3)                                                                            | —                            |
| `targets` | Steady, five pairs, both sizes: phase 0's nine stances, `decks` and both `pair` stances among them, and `earth-orbit-long`, `shore` and `overlay`. Fly on `ground` and `orbit`                                     | B1 to B5, B9, B10, B11       |
| `frame`   | The whole GPU frame over 180 frames, clouds off and on, its median and its 95th percentile, on every stance of `targets` and on the ten presets, both sizes                                                        | B6, B8, and B9's two sides   |
| `reset`   | The four sequences at the landed caps, on `horizon`, both sizes                                                                                                                                                    | B7                           |
| `warp`    | Steady Δ with the clock at 100× and at 1,000×, on `horizon` and `orbit`, 1080p, five pairs, through the game's own clock and not the lever alone                                                                   | Recorded: no warp row exists |
| `pace`    | With the presentation held at 60 Hz: the first five intervals of three cold boots, late frames over matched 3 s windows from `orbit` and `ground`, and the presented rate of each of `frame`'s rows over 3 s       | B13, B14, B15                |
| `memory`  | Cold boots, the declared bytes against the device's, one body and two, and the boot's `warming the clouds` span                                                                                                    | B12                          |
| `error`   | The thin form against the identity on phase 0's four scenarios and the two `pair` stances, both sizes, Enhanced off and on. The display-referred pair is taken at a held exposure or its column is dropped (§4.10) | Row 20                       |

- **`pace` waits for the hold.** If no campaign can hold 60 Hz when window 3
  opens, the batch records its three rows with their rates, and B13 to B15
  stay recorded only (§7.5).
- **`frame` is one loop a row,** `ir.passes` summed over each of 180 frames
  in a held pose. A held loop still steps the caches' refresh and the
  jitter, so the percentile sees the frame that bakes a block.
- **No row is from the M5 MacBook Air.** The rubric records one at the
  verdict, with no bar (§8 there). Every figure here is the M6 mini's, and
  the plan's own basis was an M5, unmeasured.

The capture set of §3.6 and §3.8, its casts among them, runs after `landed`
under the same lock. §10.3 gives each window's length. The runner prints the
real durations.

**The `velocity` fix is measured apart,** by ADR-0044's own protocol: both
temporal presets at both ratios, on package V's base and on its tip. It runs
in the window K's baseline is taken in.

### 7.3 The ladders are taken again

`maxSteps`, `lightTaps` and `farFootprint` start at phase 0's values: 192, 4
and 800 m. **Those values have no ladder at the configuration that landed.**
Each was read with the cascades, two taps and 400 m, and the landed set, the
grid at four taps and 800 m, was measured for cost, memory and composite
error with no images. Window 1 takes phase 0's ladders on the landed code,
which is the first ladder the landed set has; by its own rule `lightTaps` is
unset there, since four has no larger neighbor.

**The runner cannot take the ladders this design asks for until two lists
are opened.** `LIGHT_TAP_COUNTS` is `[0, 2, 4]` in `render/cloudLevers.ts`,
and the `images` batch's stances are `horizon` and `inside` in
`scripts/clouds/measure.mjs`, so six and eight taps and a stance that shows
the band cannot be laddered without editing both (phase 0's review and
council). Package C exports the lever's values as `CLOUD_LIGHT_TAPS`, with 6
and 8. Package Q reads each ladder's values from its lever's list and takes
the ladders' stances as a parameter.

Phase 1 changes what each lever buys: the scaled medium halves the depth a
step crosses, the budget's floor ends exhaustion, the taps are spaced in
optical depth, and the higher orders move light deeper into a cloud than the
taps reach. So the three are set again from `ladders`, by phase 0's rule, on
the landed code.

| Ladder         | Values                 | What phase 0 left open                                                                                                                                                                     |
| -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxSteps`     | 96, 128, 192, 256      | Nothing: 192 against 256 is 0.02%. The floor may let 128 pass, which was 1.60% from 192                                                                                                    |
| `lightTaps`    | 0, 2, 4, **6, 8**      | Four is not shown converged: two against four is 1.04% (1.14% at Retina), and four had no larger neighbor. Under the field each tap is five reads a step (§4.3), so it is also the dearest |
| `farFootprint` | 200, 400, 800, 1,600 m | Why 800: at Retina 400 against 800 is 7.18% and 800 against 1,600 is 0.01%, which reads as the far march leaving the frame (§5.8)                                                          |

- **Each ladder row records what the image cannot say:** the share of rays
  handed to the far march, the share whose floor passed the schedule
  (`exhausted`, §5.8), and the trace's own milliseconds from `ir.passes`. A
  ladder that converges because a term left the frame then says so.
- **`farFootprint` is read on a third stance, `earth-limb`,** where the band
  is in frame at every value, beside phase 0's `horizon` and `inside`. A
  value passes only if it passes on all three.
- **`lightTaps` 6 and 8 are new values of the lever** (§4.6). If four against
  six is still over 1%, six is the default, and the trace's cost at six is
  the record's.

### 7.4 Decision rules, fixed before measuring

A difference counts only over the protocol's resolution: twice the spread of
the pairs' deltas, and at least 0.05 ms (phase 0 design §8.7). An ADR may
argue an exception, with figures.

**The higher orders.**

| Step                             | Where                                         | Rule                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The forecast                     | Node, package R1                              | S's reconstruction through its own table's read, and O's fit, each at the grid and the held-out points. **The Node figure is a forecast, never the gate.** O's GPU path is built only if its fit is within 5% at every held-out point                                                                                                                         |
| Gate 1, the slab                 | `cloudSlab.gpu.test.ts`, with the shipped sun | The rubric's rows 1 and 2: every point of §5.11's domain and its held-out points within 5% of the oracle's solution of the renderer's own scaled medium, at the three radius rows, and the reflected flux within 2%. A candidate that passes in Node and fails here has met a defect of the march, which is packages M1's and M2's to fix; it is not a result |
| Gate 1 beside it, the exact sun  | The same test with `exactSlabSun`             | Recorded beside the first. Where the shipped sun fails and the exact one passes, the bill is the sun path's, and ADR-0068 carries both tables                                                                                                                                                                                                                 |
| The medium's own bill            | `slabTables.test.ts`                          | The rubric's row 3: the scaled medium within 3% of the true one over the domain. It is the oracle's figure and no candidate's, so it chooses nothing here                                                                                                                                                                                                     |
| Gate 2, the cumulus              | `cloudCumulus`, both suns                     | The rubric's row 6, against the tracer on the true medium: each bin within 20%, the rim's peak within 20% in height and one bin in depth, the edge's sign and its depth within 30%, the core's and the base's medians within 15%, each or three standard errors of the reference's bin where that is larger, in all six cases                                 |
| The winner                       |                                               | A candidate that passes gate 1 and gate 2 draws everything. If two do, the one with the smaller steady Δ on `ground` and `inside` at both sizes                                                                                                                                                                                                               |
| S passes gate 1 and fails gate 2 |                                               | The dark-edge term (§5.7) is tried. If S with it passes both gates, it stays. If not, S draws without it, and the ADR records the curve error and the medians; if O was built and its curve error is smaller, O draws the cumuliform share of a sample, blended by the convective share                                                                       |
| Nothing passes gate 1            |                                               | The smaller worst error draws. Rows 1 and 2 are then declared misses: the ADR records the shortfall by point, and it stands only if the rubric's council accepts it by name (rubric §9)                                                                                                                                                                       |
| A column under `τ = 5`           |                                               | The winner draws it. Its errors at `τ` 0.5, 1 and 2 are recorded and no rule turns on them                                                                                                                                                                                                                                                                    |

**The rest.**

| Choice                              | Rule                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The octave count,** if O is built | The smallest `N` whose worst gate-1 error is within one point of the next `N`'s; 4 if 3 is not within a point of it                                                                                                                                                                                                  |
| **The dark edge**                   | Built only on the row above. Kept only if the winner with it passes gate 1 again and gate 2 in all six cases                                                                                                                                                                                                         |
| **The phase's radius**              | The candidate with the fewest fetches a ray, among `mean` and `bins` at 2, 3 and 4, whose radiance within 8° of the antisolar point is within 3% RMS of `sample`'s on all three cases below and whose red ring is within 0.1° of `sample`'s. If none passes, `bins` at 4, with the shortfall recorded                |
| **Its three cases**                 | A stratocumulus deck with the adiabatic radius, 5 µm at its base to 12 µm at its top, from 3 km above; a 6 µm layer over a 14 µm deck, in two levels; a cumulus's flank, radius by height, seen across it                                                                                                            |
| **The jitter**                      | `stbn` replaces `ign` only if its converged noise is at least 20% lower on both stances at both sizes, its eighth-frame error is not higher, and its steady Δ is under 0.02 ms over the resolution. Otherwise `ign` stays                                                                                            |
| **The handover's band**             | The smallest of 1, 1.5, 2 and 3 whose zoom cast and slow descent show no error step (C1, C2; §8.1), and whose 64-frame mean is within `B` of band 3's over cloud texels, `B` the fine and far marches' footprint disagreement that `cloudHandover` measures. If none, 3, with the gap recorded against the far march |
| **The clip**                        | The smallest of 1.25, 1.5 and 2 whose bias is under 1% at the worst cloud texel and whose two casts of C8, the pass at 2 m and the fast descent, are under the trail floor after the stop and at the three quarter points (§8.1). If none does both, the widest that passes the trail floor, with its bias recorded  |
| **The ladders**                     | Phase 0's rule: the smallest value whose image is within 1% radiance RMS of the next larger one's in `horizon` and `inside`, the jitter held; `farFootprint` on `earth-limb` as well (§7.3)                                                                                                                          |
| **The thin form**                   | No regime draws through it (§4.10). Row 20 is read from the `error` batch on the landed commit                                                                                                                                                                                                                       |

**What the decisions added.**

| Choice                         | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The composite in the chain** | `chain` is the form on a frame with nothing over the clouds if its frame equals pass B's within one half-float step and its steady Δ is under `passes`'s by more than the resolution on `orbit` and `horizon` at both sizes. Offered only at the pictures whose readers it can serve (§4.12)                                                                                                                                                                                                                                                                                                                           |
| **Pass B's store**             | `lean` stays if a frame is equal with it on and off and its steady Δ on `overlay` is under `passes`'s by more than the resolution at Retina. If the spike cannot reach the descriptor without patching three, it is not built                                                                                                                                                                                                                                                                                                                                                                                          |
| **The over pass after both**   | B11: the steady Δ on `overlay` is at most 1.0 ms over `horizon`'s at 1080p. If it is not, B11 is a declared miss with its figure, and the overlays' own target and placement C go to phase 2's design with the batch's figures. Neither is built in phase 1                                                                                                                                                                                                                                                                                                                                                            |
| **The placement**              | **A goes back to the orchestrator if pass B costs a frame.** On `overlay` and `inside` at Retina, at a held 60 Hz, nine samples a side: `passes` or `lean` against `chain`'s frame of the same stance without the overlay. It goes back if the median of late frames over 3 s is higher by more than 2, or the frames presented are fewer by more than 2%. A `sensor` mean higher by any amount is recorded and sends nothing back: phase 0 already has that figure, and ADR-0063's exception is argued on it. If no campaign can hold 60 Hz, the cell is taken at the one rate the machine gives and is recorded only |
| **The forms' CPU cost**        | A form whose `sensor` mean at Retina on `inside` is under `passes`'s by more than 0.3 ms and by more than twice the spread of the nine paired differences is cheaper on the CPU. That breaks a tie in the rows above and decides nothing alone                                                                                                                                                                                                                                                                                                                                                                         |
| **The caps**                   | B7's own clauses. The largest `sunSlices` of 4, 8 and 16, with `farBlocks` 1 or 2, for which the event's frame is within 4 ms of the steady Δ and no later frame is over it by more than 1.5 ms, three quarters of B7's 2, in all four sequences on `horizon` at 1080p. If none, 4 and 1, and B7's figure is in the record                                                                                                                                                                                                                                                                                             |
| **The grid's ramp**            | The smallest `sunRamp` of 8, 16 and 32 that, with the caps chosen, leaves the field whole within 44 frames and whose wake cast and cut cast show no error step (§8.1). If none does both, the one that keeps 48 frames, and the step goes to its check: C3 for the wake, C9 for the cut                                                                                                                                                                                                                                                                                                                                |
| **The volume's cut**           | Two levels and no bound stay if no scenario's `T_cloud` RMS at four taps, at 37.5° or at 5°, on the widened population, is worse than the landed code's on the same population by more than 0.01. Otherwise level 0 returns, and the memory row is 76.22 MB                                                                                                                                                                                                                                                                                                                                                            |
| **The second body's form**     | The identity (§4.10). The `error` batch's two `pair` stances record the thin form's error there, and decide nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **A declared row that misses** | Rows 1 to 3, 6, 7, 9 and 11, and B10 to B13: the package that finds the miss reports the figure and the points that carry it to the orchestrator that day. The figure goes in the row's ADR and in the register (rubric §7), and it stands at the verdict only if all three seats accept it by name                                                                                                                                                                                                                                                                                                                    |
| **The bake under the horizon** | The first-exit bake stays if its RMS at G3's sun is under the as-built bake's. Otherwise the as-built bake draws, and the record says what G3's bases are lit by                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Why each rule reads as it does:

- **The band** compares means with the jitter moving. Held, the dither's
  pattern is frozen, and two bands then differ by the two marches'
  disagreement wherever their patterns differ, which no band can bring under
  1% (the physics critique's finding 16).
- **The clip** is judged on a bias. A converged pixel's own deviation is its
  sample's over `√15`, 1.3% at 5% a sample, so its worst over a frame is near
  5% at any width (**D**, same finding); the 2.1% phase 0 found was a bias
  (phase 0 package report, WP8).
- **The ring's tolerance** is 0.1° because the blend between radius rows 9%
  apart moves a 2.4° ring by that much; an atlas texel there is 0.04° to 0.06°
  (the physics critique's finding 26, **D** there).

### 7.5 The presentation rate, and a 60 Hz hold

**What phase 0 found.** Every profile of its first campaign ran at a 60 Hz
cap on the clouds-off side: 180 frames in 3 s. Two hand-started repeats ran
the same bases at about 120 Hz at 1080p and 64 to 78 Hz at Retina. The second
campaign presented at 95 to 120 Hz at 1080p and at 59 to 120 Hz at Retina,
and its cold boots at 81 to 89 and at 49 to 51 Hz; four of its scenarios have
rows more than 15% apart in rate and are named as two operating points
(ADR-0063; `landed-2026-11-10T09-05-32Z.md`). The `sensor` span's mean and the
late-frame count follow the rate: a clouds-off base is 6.8 to 7.1 ms at 60 Hz
and 3.05 ms at 120 Hz. `ir.gpu`'s Δ does not: 0.1 ms across both. **The cause
is not established.** The display was off throughout, and how Chrome was
started was ruled out.

**The hold is an instrument phase 1 owes** (rubric §5): a presentation held
at 60 Hz on demand. B13, B14 and B15 bind from the first campaign that has
it, the casts are refused outside 58 to 62 Hz from then, and the placement's
cell is read at it (§7.4). If it does not exist at the verdict, the three
bars are declared misses. Package Q builds it, and it starts with a study,
because nothing can be held until the cause is known.

- **The study,** half an hour of the machine before window 2: the page's own
  frame log on a clouds-off `horizon` at 1080p, 3 s at a time, with the
  display asleep and awake, at each refresh mode the display offers, with the
  window in front and occluded, and with the rig's `?presentation=occluded`
  on and off. It records the rate each gives and which of them the rate
  follows. The rig measures with the display dark and the page told it is
  occluded (`.claude/rules/browser.md`), so the likeliest finding is that
  nothing is pacing the page but the frame's own cost.
- **The hold, in the order it is tried.**
  1. **The display paces it.** The display awake in a 60 Hz mode and the
     page presenting to it, for the rows that need a rate and for no others.
     The steady A/B rows stay as they are: they do not move with the rate.
  2. **The page paces itself,** if the display cannot: under a `pace=60`
     query the frame loop draws on a 60 Hz grid from the host's clock and
     skips a callback that arrives early. It holds the rate of the frames
     drawn. It does not make the compositor present them, so B15's reading
     under it is the page's and the record says so.
- **Its acceptance** is one stage, run before any batch that needs it: three
  consecutive clouds-off rows on `horizon` at 1080p each present at 58 to
  62 Hz over 3 s, by the page's frame log. A campaign whose stage fails runs
  its rate-free batches and marks the others not taken.
- **What it costs the rig's rule.** A page the compositor presents is a page
  the rig's occlusion rule exists to avoid measuring through. So the held
  rows are a batch of their own, `pace`, and no steady Δ is taken in it.

**The rule.**

- **Every row records its rate:** the frames presented over the row's window
  over its seconds, the median interval between `requestAnimationFrame`
  timestamps, and how Chrome was started, by the campaign's detached driver
  or from a shell. The row's table prints the rate beside the figure.
- **A cell is one rate.** A cell's samples are pooled, and its two sides
  compared, only if every sample is within 2% of the cell's median rate. A
  sample outside is taken again; if it is outside again, the cell is reported
  as two cells and no rule reads it. A rule of §7.4 that reads a
  rate-dependent figure names the rate in its decision.
- **A campaign checks its own pacing first.** Before its first batch the
  runner takes one profiled row and records its rate, and before any batch
  that needs the hold it runs the hold's acceptance stage.
- **A cast's rate is part of its reading.** Its paths are scheduled by frame
  index (§8.2), so at another rate the same path runs in other seconds and
  the capture keeps another share of its steps. Until the hold exists a
  cast's record says the rate it was taken at. From then a cast is taken at
  58 to 62 Hz or refused (rubric §4; §3.6 says what package K built).
- **A captured-frame gap is not divided away.** Where the difference across
  a gap would be a step, the cast is taken again. So is a cast that captured
  under two thirds of its path's frames.

**Which figures move with the rate.**

| Figure                                                          | Moves?          | Why, and what holds it                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ir.gpu`'s Δ, `ir.passes`' passes, the `sequence` step's frames | No              | GPU time by timestamp query, in a held loop                                                                                                                                                                                                                                                                            |
| Declared bytes, image errors, the `noise` step, the instruments | No              | Held frames, taken by index                                                                                                                                                                                                                                                                                            |
| The `sensor` span's mean                                        | Yes             | 6.8 to 7.1 ms against 3.05 ms on one base                                                                                                                                                                                                                                                                              |
| Late frames                                                     | Yes             | A count against the interval. B14 is at a held 60 Hz, over matched 3 s windows                                                                                                                                                                                                                                         |
| The first-frame hitch, in `memory`                              | Yes             | It is read as an interval overrun. It is recorded with its rate, beside the pipelines compiled on that frame, which `cloudWarm` counts and which do not move                                                                                                                                                           |
| A cast's frames                                                 | Yes             | The screencast takes presented frames, and the path advances a step a frame                                                                                                                                                                                                                                            |
| The step detector (§8.1)                                        | Yes             | Its series is a first difference between captured frames, so a frame the capture skipped doubles one. Each captured frame is matched to the log's frame index. A gap is not divided away: where its difference would be a step, the cast is taken again, as is one that captured under two thirds of its path's frames |
| The trail measure (§8.1)                                        | Yes             | `k + 3` and `k + 32` are path frames, matched to captured frames by the log's timestamps. The history converges by frame, so in seconds a trail is half as long at 120 Hz                                                                                                                                              |
| The grid's rebuild, the weight's ramp, the clouds' settle       | Yes, in seconds | Each is counted in frames: 29 frames is 0.48 s at 60 Hz and 0.24 s at 120 Hz                                                                                                                                                                                                                                           |

---

## 8. The instruments the MVP owes

### 8.1 A step detector for a moving camera, and a measure of a trail

`analyzeFrames` (`scripts/frameDiff.mjs:116-186`) finds a frame that differs
from both neighbors while they match each other. A pop does not revert, so the
frame after it matches it and the skip test (`:135-140`) passes it over; a
moving camera raises the median and with it the floor (`:131`). It finds
strobes, by design.

`scripts/castSteps.mjs` (package I) reads a cast's frames and the page's log
(§8.2):

- **Per frame,** the mean luminance of the whole frame and of each cell of a
  4 × 3 grid, by `sharp`, which the rig already loads (`scripts/drive.mjs:621`).
  Beside them, the changed-pixel count of each pair from `changedPixels`
  (`frameDiff.mjs:57-74`), and the served opacity from the log.
- **A step at frame `i`:** the first difference of a series leaves its
  neighborhood, `|d_i − median(d)| > max(6·MAD(d), floor)` over the 16 frames
  around it, in the whole frame's luminance, in two adjacent cells', or in the
  opacity; or the pair's changed pixels pass four times their window's median
  without the strobe test claiming the frame. The floor is the larger of 0.4%
  of full scale and three times the noise of a held cast of the same scene,
  measured once.
- **Against a control.** `--against <cast>` takes the same path with the clouds
  off, and reports only the steps the control lacks within 3% of the path's
  progress. A terrain patch that pops is the terrain's, and is listed apart.
- **Each step** is reported with its frame, its height from the log, its cell
  and its size, and the tool writes the pair of frames either side.
- **A gap in the capture is not divided away.** Each captured frame is
  matched to the log's frame index by its timestamp. Where two captured
  frames are more than one index apart and their difference would be a step,
  the cast is taken again, and so is a cast that captured under two thirds
  of its path's frames (rubric §4). The cast's presentation rate is in its
  report (§7.5).

**A flagged step is a finding to classify, and it fails nothing on sight**
(rubric §4). `scripts/weather/classify.mjs` (package I) takes each one
through three questions, and writes the answers, both sets of frames and the
reason into the cast's record.

| Question                                                        | How it is answered                                                                                                                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Do settled samples at the same poses and times hold the change? | Package U's settled stills at the path frames either side of the step (§3.8), differenced as the cast's frames are                                                                                                              |
| If they do, is the eye at a cloud's boundary in those frames?   | The log's range readout crossing 2 km, or `cloudFieldAt` at the eye's body-fixed place and instant crossing from clear to cloud between the frames. The tool evaluates the CPU field in Node, from `packages/rendering`         |
| What is it, then?                                               | **A real entry or exit** only if the settled samples hold it and the eye is at a boundary. **An error step** if the settled samples lack it, or hold it with the eye at no boundary. **Unresolved** if a sample cannot be taken |

- An error step fails its check. An unresolved finding cannot pass.
- **Agreement with the settled samples does not prove a physical cause:** a
  switch that depends on pose sits in both. That is why the second question
  exists, and why a change the settled samples hold away from any boundary is
  an error.

**The detector counts only from a run that proves it,** by two controls taken
in that run (rubric §4):

- **It flags the injected step,** the slow descent at `handoverBand` 1 with
  `maxSteps` 24, and the classification calls it an error step.
- **It passes the continuous entry:** G5's path as 600 settled stills, one a
  path frame, on which it flags nothing where the served opacity is steady.
  Settled stills remove the motion's history and not every discontinuity, so
  a flag where the opacity itself steps is not the detector's failure.
- A run that misses either says its detector is blind, and no cast of that
  run counts.

**The field has to move, and by the right amount** (C7).
`scripts/weather/drift.mjs` (package I) measures the drawn field's
displacement between the first frame and the last of the 100× cast at E1's
stance, by the shift that best registers the two frames' luminance over the
cloud pixels, searched to ±64 pixels on frames reduced by two.

- The CPU turn's displacement is the level's `ω_k·a·cos φ·Δt` at the stance,
  through the lens and the height into pixels: 4 km over the cast, 45 of
  E1's pixels (the rubric's own derivation).
- C7 holds the two within 10%, in size and in direction. A frozen field
  measures zero and fails. So does a field that moves the wrong way.
- At 1,000× a frame moves the low level 1.5 pixels; that cast and the two at
  1× are read by the detector and by `frameDiff`'s strobe test alone.

**After a cut, the frames approach the settled plate** (C9). The reader takes
the 60 frames from a cut, or from a scrub, and the settled plate:

- no frame's RMSE against the settled plate rises after the event's frame by
  more than that picture's RMSE floor;
- in no cell of the 4 × 3 grid does a frame's mean luminance lie outside the
  span from the event's frame to the settled plate by more than the floor;
- and the settled plate differs from a fresh boot's at that instant by no
  more than the floor, which is `--cut`'s check as K built it.

**A trail is a number** (C8). A ghost that fades over five frames is neither
a step nor a burst. The paths that can ghost stop: the camera moves for two
thirds of the cast and holds for the rest, and the log marks the stop's
frame, `k`. They are the pass at 2 m under cumulus at 250 m/s and the fast
descent. A cast at 7.7 km/s from 400 km moves the ground a quarter of a pixel
a frame, cannot ghost, and is no check.

- **The trail measure** is the mean absolute difference between frame `k + 3`
  and frame `k + 32`, each first blurred by a box the size of a trace texel at
  the cast's scale. A ghost is a smear at the scale of a cloud; what the
  history is still doing at `k + 3`, turning one sample a pixel into eight, is
  noise at the scale of a pixel, and the blur removes it.
- **Its floor** is the larger of 0.5% of full scale and twice the same measure
  on a held cast of the stop's pose, taken once.
- **After the stop,** a cast passes when the measure between frames `k + 3`
  and `k + 32` is under the floor.
- **During the motion,** it passes when, at a quarter, a half and three
  quarters of the motion, the same measure between the cast's frame and a
  settled still of that pose is under the floor. A smear that keeps up with
  the camera shows there and not after the stop.

The thresholds are held by `castSteps.test.mjs` on synthetic series.

### 8.2 Scripted, held paths

A descent has to be the same frames every time, at a held instant, with no
cut. `ir.visit` cuts on every call (`packages/devtools/src/surfaceArm.ts:396`),
`ir.drop` is paced by the wall clock and cannot start under 0.5 R
(`surfaceArm.ts:505-507, :744-759`), and a cutscene script is a code change
that runs the clock (`packages/devtools/src/cutscene.ts:225-228`). But the
observatory's `setStanceHeight`, `moveTo`, `setHeading` and `setPitch`
(`packages/devtools/src/observatory.ts:1547-1569`) move the eye with no cut
(`surfaceArm.ts:771-866`), and a preset holds its time while they do
(`packages/devtools/src/heldTime.ts:65-86`).

`scripts/weather/descent.mjs` is package K's, with the capture that calls it
(§3.6). It exports page-side functions, stringified into `--js` as the
runner's are (`scripts/clouds/page.mjs:51`):

```
startPath({ kind: 'descent', rate, pitch: [from, to, between] })
startPath({ kind: 'fly', metersAFrame, heading, stopAt })
startPath({ kind: 'zoom', from, to, frames })
stopPath() → the log
```

- `startPath` begins a `requestAnimationFrame` loop and returns at once, so
  the next step, `--cast <n>`, records while it runs; steps are sequential
  (`scripts/driveSteps.mjs:169-173`). It refuses a page with no surface stance
  (§3.6).
- **The schedule is by frame index, never by time:** `h_k = max(h₀·(1 − rate)ᵏ,
2)` for a descent, a fixed arc a frame for a fly-through until `stopAt`, a
  fixed ratio of focal length a frame for a zoom.
- **The zoom's verb is unverified.** `engine.requestLens` exists
  (`GameEngine.ts:612-616`) and `engine` is on the page (`App.tsx:522-524`);
  whether a preset's flight lens yields to it a frame at a time is package K's
  first check. If it does not, K adds a harness verb, a one-line delegate.
- **The log** has one entry a frame: the index, `performance.timeOrigin +
performance.now()`, the height, and from `ir.clouds()` the regime, the reset
  count, the served opacity and the range (§8.5). A screencast frame carries a
  wall-clock timestamp (`scripts/cdp.mjs:152`), so each frame finds its entry.
- One invocation: `--preset weather-g6-descent --query clouds=1 … --settle
30000 --js startPath(…) --cast 1100 --js stopPath()`.

| Cast        | Path                                                                                  | Frames                            | For                                                          |
| ----------- | ------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| G6, slow    | 400 km to 2 m at 1.2% of height a frame; pitch from −88° to 5° between 20 km and 2 km | 1,010 (**D**: `ln(2·10⁵)/0.0121`) | Rubric §4: a descent through a deck with no frame that steps |
| G6, fast    | The same at 4% a frame                                                                | 300                               | The same, at reentry's pace                                  |
| G5          | 2.5 m a frame along the heading, 600 frames, 150 m/s at 60 Hz                         | 600                               | Range falls and returns, and no frame steps                  |
| Fly, ground | G1's pose at 2 m, 4.2 m a frame, 250 m/s, stopping at frame 200                       | 300                               | The trail measure                                            |
| Fly, orbit  | E1's pose with a 60° lens, 128 m a frame, 7.7 km/s, stopping at frame 200             | 300                               | The same                                                     |
| Zoom        | G4's pose, 60° to 11.4° in 300 frames                                                 | 300                               | The band crossed by a lens                                   |

Each is taken with the clouds on and off, and read by §8.1. `--cast` stops at
`max(10 s, n·200 ms)` (`cdp.mjs:173`), which 1,100 frames are far inside. A
cast that captured under two thirds of its path's frames is taken again.
**The baseline's six casts are package K's,** on phase 0's landed light, so
the phase's pull request has a "before" for each. As built, the pitch is
−87.995°.

**What the rubric's checks need of the casts, which is package U's** (§3.8):

| Check  | Casts                                                                                                                   | Change from K's six                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| C1, C2 | The zoom, and G6 slow                                                                                                   | **The zoom moves** to G6's start at pitch −45°. At G4's pose it crosses nothing (§5.8). K's zoom stays as a baseline |
| C3     | G6 slow and G6 fast                                                                                                     | None                                                                                                                 |
| C4     | G6 slow under the world's own climate                                                                                   | New, once package C widens the lever                                                                                 |
| C6     | G5, over 1,600 frames: started where the range ahead is over 2 km, through one cloud, ended where it is over 2 km again | **Longer.** K's 600 frames are 1.5 km, so a cloud entered in them is under 1.5 km ahead at the first frame (§8.5)    |
| C7     | The clock at E1's stance at 1×, 100× and 1,000×, and at G1's at 1×: 300 frames each, the camera held                    | New: a path kind that runs the clock                                                                                 |
| C8     | Fly, ground, and G6 fast, with settled stills at a quarter, a half and three quarters of each                           | The settled stills are new. Fly, orbit leaves the checks                                                             |
| C9     | The 60 frames from a cut and from a scrub, at E1                                                                        | New: `--cut` keeps the frames                                                                                        |
| §4     | The injected step: G6 slow at `handoverBand` 1 and `maxSteps` 24. The continuous entry: G5's path as 600 settled stills | New                                                                                                                  |

That is 11 casts with their clouds-off controls, 600 settled stills for the
continuous entry, six for C8, and as many again as the classification asks
for: about 13,500 frames and 700 stills a run (**E**). The continuous entry
is taken on K's own 600 frames of G5, which hold the entry.

### 8.3 The glory profiler

`scripts/weather/glory.mjs` reads G4's plate and its record. From the sun, the
lens and the pose it finds the antisolar point's pixel, takes the radial
profile of `R/(R + G + B)` in 0.1° bins to 10°, and reports the first red
maximum past the first interior minimum, the rule the Mie tests use (phase 0
package report, WP2), beside the table's ring for the deck top's radius. It
reports the ring's peak over its trough, which is the brightness the angle
alone does not pin, and the cloudbow's peak. On the plate the rubric holds
the ring within 0.2° of the table's, two of the profiler's bins (row 8), and
scores the bow when it is present. That half of row 8 gates from phase 2,
when G4 is judged; phase 1 records it.

### 8.4 Which phase builds each

| Instrument                                                                                                                              | Phase                 | Package                     |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------- |
| A picture that holds weather; the capture set, its casts and sheets; the scripted paths; `ir.settled()` on the clouds; the solar solver | 1                     | K                           |
| The step detector, the trail measure, the classification of a flagged step, the field's displacement, the frames after a cut            | 1                     | I                           |
| The glory profiler                                                                                                                      | 1                     | I                           |
| The range readout, and its fixture                                                                                                      | 1                     | M1                          |
| The cells' size distribution and the sight count, on the CPU field                                                                      | 1                     | G, D                        |
| The frozen reference manifest                                                                                                           | 1, before K's capture | The orchestrator (ruling 3) |
| The casts of C1 to C9 with their controls, settled stills along a path, the overlay guard, the record's provenance, the noise floor     | 1                     | U                           |
| The panel's packet builder, shuffler, controls, validator and ledger, under `scripts/panel/`                                            | 1                     | J                           |
| The real-time anchor stills, frozen; the calibration round                                                                              | 1                     | The orchestrator            |
| A 60 Hz presentation held on demand; the whole frame's 95th percentile; each rule's outcome computed                                    | 1                     | Q                           |
| The levers' hash at a size                                                                                                              | 1                     | C                           |
| E1's shadow offset against `h·tan z`; the share of cloud pixels at display white                                                        | 2                     | —                           |
| The ground's illuminance under a deck against the Monte Carlo column                                                                    | 2                     | —                           |
| Earth's cover by the rubric's §6.3                                                                                                      | 3                     | —                           |

### 8.5 The range inside a cloud, measured

The rubric's G5 asks that visibility fall and return, and nothing in draft 1
measured a visibility. The physics critic settled what sets it (§5.1): inside
a cumulus, shapes in the frame are lost at the scaled range, `3.912/σ′`, and
detail narrower than the diffraction blur at half that.

- **The readout is the rubric's:** the distance at which the optical depth
  accumulated along the center ray reaches `ln 50`, 3.912 (row 21). Under the
  `stats` lever the trace already counts its steps through a small buffer
  (`render/cloudTrace.ts:145-171, :240-248`). It gains three slots: the sum
  of `1 − T′` over its rays, which is the served opacity the casts' logs
  read, and for the center texel the distance at which its scaled depth
  passes 3.912, placed inside the step that crosses it by the step's own
  extinction. The report carries `opacity` and `range`, the range null where
  the center ray never reaches it.
- **Its number is held where it is true** (row 21, a gate):
  `cloudRange.gpu.test.ts` (package M1) puts the eye inside a uniform medium
  at each genus's `σ′` and holds the readout within 25% of `3.912/σ′`. A
  step crosses a scaled depth of 0.3, so the readout's own grain is 8%
  (**D**).
- **G5 is judged on entry, exit and continuity** (C6). An error step fails
  it. So does a range under 2 km before the cloud or after it, or one that
  never falls inside it. The least range over the cast is recorded and gates
  nothing: in a heterogeneous cloud it is not `3.912/σ′` of anything.
- **"Before" and "after" are the cast's first frame and its last.** The
  readout is along the center ray, and G5 flies along it, so the range ahead
  of a cloud is the distance to it: about 600 m from 500 m out, with nothing
  wrong. Package U lengthens G5's cast to 1,600 frames, 4 km at 2.5 m a
  frame, and the ledger test holds the path on the CPU field: the range along
  the heading is over 2 km at the first frame and at the last, and under
  500 m somewhere between. If the preset's heading gives no such path, U
  re-solves the heading once and says so. §11.2 asks the rubric's council
  for the wording.

### 8.6 The panel's tools, the noise floor and the calibration round

The rubric makes the panel's tools a package of phase 1 (§3.2 there),
because one calibration round fixes the pass bar before any candidate plate
exists (§3.5 there). Package J builds them under `scripts/panel/`, as Node
scripts with their tests in the gate. They draw nothing and take no lock.

| Tool           | What it does                                                                                                                                                                                                                                                                                                          | What its test holds                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packet.mjs`   | Builds one seat's packet for a round from capture records (§3.8). For each scene: the arms as lettered images, each the full plate at packet size and one native-pixel crop; the captioned references, less the one withheld from that seat; the frozen brief. Letters are shuffled by seat and by round, from a seed | A packet built twice from one seed is byte-equal. No file name, metadata or order in it names an arm. Two seats' letters differ |
| The arms       | The candidate, the last accepted candidate, up to one experiment, the three controls, and on E1 to E3 the deck, each by its record's role                                                                                                                                                                             | A record with the wrong role, rig, stance, fixtures or processing mode for its arm is refused                                   |
| The controls   | A duplicate pair, the low anchor (the baseline plate) and a photograph withheld from that seat's own set, each in a scene the seed chooses                                                                                                                                                                            | Each appears once a seat a round                                                                                                |
| `crops.json`   | Each still cornerstone's crop as a fraction of the frame, frozen with the preset, the same for every arm and for a photograph. E2 has a second, at the terminator, where its Shadow is scored                                                                                                                         | Every still cornerstone has a crop inside its frame                                                                             |
| `validate.mjs` | Checks a seat's `review.json`: an integer from 0 to 10 for each dimension the rubric gives that picture, for each arm; a strict ranking where one is asked; each artifact as one of the nine classes and a region, with whether it shows in the full plate; three observations about named images                     | A score out of range, a tie in a forced ranking, a class or a region outside the vocabulary, each refused                       |
| `ledger.mjs`   | Reads a round's reviews with its letter maps and writes the ledger's rows: who is valid, each picture's pass, block or void, each guard's verdict, the streaks                                                                                                                                                        | The rules below, each on a fixture round                                                                                        |
| `archive.mjs`  | Copies a round's packets, briefs and reviews into the main checkout's `.data/weather/panel/` and indexes them from the record                                                                                                                                                                                         | A round's ledger row is written only after its archive                                                                          |

**The rules the ledger computes are the rubric's, and its tests are their
fixtures** (§3.3, §3.5, §3.6 and §3.8 there):

- **A seat is discarded** when its duplicate pair differs by more than a
  point on any dimension, when it scores the low anchor 6 or more on Form, or
  when it scores the withheld photograph under 7 on Form or Light. A false
  observation discards it too, which the orchestrator finds and enters.
- **`B_form` and `B_light`** are each the mean of that dimension over every
  anchor still and valid seat of the calibration round, rounded to the
  nearest half point with a quarter rounding down, and held within 7 to 8.
  **F** is one under the lower B, rounded down, never under 6.
- **A still passes a round** with three valid seats when every seat scores it
  F or more on each of its dimensions, the means reach `B_form` and
  `B_light`, no artifact blocks it, every seat ranks it above the deck on E1
  and E2, and its rows of the acceptance table that name a plate hold. E3's
  Form bar and floor are one point under.
- **An artifact blocks** when two valid seats name one class in one region,
  both in the full plate, both score Artifacts 8 or under, and neither names
  the class on its photograph arm.
- **A pass is confirmed by a second round on an unchanged plate.** A round
  with a discarded or missing seat and nothing failing is void for the
  streak. A plate has moved when its changed pixels or its RMSE against its
  last accepted plate pass its picture's floor.
- **A moved guard** is a blind pair, blocked when two valid seats call the
  new plate worse on Integration or on Artifacts. The overlay guard also
  needs every valid seat at F or more on both.

**What is not package J's.** The seats are delegates the orchestrator
launches, one model from each of three providers at high effort, fresh each
round. The orchestrator checks each seat's observations against the pixels.
The brief is the rubric's §3.7, frozen by the orchestrator; J ships its
template and the packet's layout.

**The real-time anchor stills are gathered by a research delegate and frozen
by the orchestrator,** as the photographs were (ruling 3).

- They are stills of shipped real-time volumetric clouds from other engines.
  Each has its engine, its title, its source and a hash, and stays in
  `.data/weather/references/anchors/`. None is committed.
- The orchestrator assigns each to the one picture whose stance and genus it
  matches, and lists it in `references.md` by a dated note, before the round.
  A picture with no matched anchor says so in the record.
- **Few engines draw a cloud field from 400 km,** so E1 to E3 may have none.
  B is a mean over every anchor still, so it can rest on the ground
  pictures' anchors alone; the record says how many it rests on.

**The noise floor** is package U's `--pairs 5` on the baseline (§3.8), in a
window of its own (§10.3).

**The calibration round runs once, as soon as its five inputs exist, and
before window 3.**

| It needs                                           | From                                 |
| -------------------------------------------------- | ------------------------------------ |
| The tools                                          | Package J, merged                    |
| The photographs and the anchors, frozen            | The orchestrator                     |
| The baseline plate of each picture, the low anchor | Window 1, package K's capture        |
| The deck arm of E1 to E3                           | The same capture, taken with no flag |
| The noise floor by picture                         | Window 1b, package U's `--pairs`     |

- It needs no GPU: its seats read images. It runs beside wave 2 or wave 3.
- **No plate of this phase's light exists before it.** No package but the
  capture opens a browser (§10.1), and the first capture on phase 1's light
  is window 3's. The orchestrator does not take one sooner.
- It publishes its scores in the record and fixes `B_form`, `B_light` and F
  for good. Phase 2's first judged round starts from them.

---

## 9. Docs

### 9.1 The ADRs

Phase 0 takes 0063–0066. Re-list `docs/adr/` when writing: a sibling branch
can take a number first. Each title states the decision; where it waits on
this phase's measurement, both forms are given.

| ADR      | Lands in                               | Title (house voice)                                                                                                                                   | Records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0067** | The first pull request, with package K | _A preset holds its weather, and a cornerstone is a preset no list shows_                                                                             | Picture format 3 and why `weather` is the part of a picture that cannot be derived; the cornerstones' own list and what resolves one; a regime's id as part of a committed format, with an unknown one reported and never refused; the weather's release on leaving a picture; the solver for the sun's place; the settle on the clouds at 32 frames. It amends ADR-0033                                                                                                                                                                               |
| **0068** | The second                             | _A cloud's medium is its droplets less their diffraction, and its light is Mie once and_ [a slab's source function \| a fitted octave series] _after_ | The scaled medium as a phase function, the two problems the oracle solves and the scaling's own bill; what it declares, with their sizes; a point source's transmittance; the step's source integral and what phase 0's figures carried; first order, the classes, the disk's convolution, the taps and the radius handling that won; the higher orders by §7.4's gates, with both suns' tables and the cumulus curves; the sky's split and the furnace; whether a dark-edge term was needed; Baum's table, its citation and that no license is stated |
| **0069** | The second                             | _A genus is its water, and its columns fall in ISCCP's classes_                                                                                       | The law, the genus table with its extinctions held and its thickness solved; the radius with height; the calibration's shares at both geometries on 5 km pixels; the cells' exponent; what waits for a land mask                                                                                                                                                                                                                                                                                                                                       |
| **0070** | The second                             | _The weather is a body's own, and a layer turns with its world_                                                                                       | `BodyWeather` and the three kinds of climate; the zonal law and its fit; the rigid turn against the hourly jump, and where its shape does not evolve; the served set and why Earth is outside it; the two map textures                                                                                                                                                                                                                                                                                                                                 |
| **0071** | The second                             | _The far march is the fine march's statistics, and the two meet in a dithered band_                                                                   | The budget's geometric floor; the band and its measured width; why no state and so no hysteresis; one law for a crossing in both marches, with the sight count that fitted it and `cloudFarCompare`'s ratios by pitch before and after; the far march's depth for its sky and higher orders                                                                                                                                                                                                                                                            |
| **0072** | The second                             | _A moving camera is rejected by the pixel, and a cut rebuilds nothing_                                                                                | The reset reasons; the `'motion'` rule's removal and the casts that judged it; the trail's measure; the clip's width; the jitter that won, with its noise figures                                                                                                                                                                                                                                                                                                                                                                                      |

Two more follow from phase 0's decisions:

| ADR      | Lands in   | Title (house voice)                                                                                   | Records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ---------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0073** | The second | _A cache is refreshed at the pace its field moves, and none is rebuilt in a frame_                    | Why a turning sun and a running clock are no events, and what a jump is; each cache's pace and its cap, with B7's sequences before and after and the warp rows; a cache fresh only from a fresh source; the statistics that stand in from orbit, past the window and during a rebuild, at the sample's own column; the grid's weight and the wake by height; the bake under the horizon; the volume's two levels, the sun gate on its widened population, and the memory row; the lag under warp; the first frames |
| **0074** | The second | _The composite is the identity everywhere, and draws in the chain when nothing draws over the clouds_ | What the break between the two scene passes moves, by attachment and sample; the two forms and their equality; pass B's store and B11; the `over` batch's figures at both sizes and at the temporal picture; placement C reconsidered and why it is not built; the placement's cell at one rate, and what would send A back; why no regime draws through the thin form, the second body's identity, and row 20's batch                                                                                             |

The rubric's rows change what four of the others record: 0068 holds the
slab's rows against the scaled medium, row 3's figure, and the knots as a
level's crossing; 0071 holds the atlas's score at 800 m before and after,
the clear texel's depth and the pose the zoom cast stands at; 0072 holds the
jump test under a warp and the casts of C7 to C9; and package U amends
ADR-0067 with the capture's provenance and roles, the overlay guard and the
noise floor. Each ADR names every lever it leaves as a quality step or a
measurement control (rubric §7).

In the same change as each: a row in `docs/adr/README.md` and an entry at the
end of `scripts/docs/wings.mjs`'s "Decision Records" (rule 46;
`scripts/docs/routes.test.mjs:145-148` fails the gate otherwise). Package V
amends `docs/adr/0044-the-sensor-reconstructs-the-display.md:80` to "an RGBA8
reactive attachment", with its re-measured figures. If 0072 makes an invariant
("never switch the cloud's regime on motion"), its imperative goes in
`AGENTS.md`, `docs/agents/invariants.md` and `.claude/rules/rendering.md`
together.

### 9.2 The plan loses its decided sections (rule 47)

| Section of `design/plans/the-weather.md`                                                                                                                   | Change                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| §11, decision 3; §10 row 1's "and WebGL's far march alone"; §5.4's "the sphere's cloud material becomes the far march for a body the trace does not serve" | Struck. One sentence in §11 says the weather is WebGPU's alone                                                                                    |
| §2's table                                                                                                                                                 | Points at `design/plans/weather/mvp.md` for the pictures the MVP is judged on; the rest stay as later phases'                                     |
| §4.5                                                                                                                                                       | Becomes phase 4's: bounded advection and new weather each period. Its first sentence cites ADR-0070 for the rigid turn that draws until then      |
| §4.8's table                                                                                                                                               | The cube's and the clipmap's rows carry two textures and their bytes, citing ADR-0070                                                             |
| §5.1                                                                                                                                                       | Cites ADR-0069; the genus table stays as the calibration's target                                                                                 |
| §5.2 "Steps grow…", "A step's light is its integral", "Detail fades…" and the jitter clause                                                                | Cite ADR-0068, ADR-0071 and ADR-0072                                                                                                              |
| §5.3, to "The moon is a second beam"                                                                                                                       | Cites ADR-0068. Ice's sentence cites the table; rain's says phase 4                                                                               |
| §5.4's second and third paragraphs                                                                                                                         | Cite ADR-0071                                                                                                                                     |
| §5.5 "Two regimes" and "Convergence is part of settling"                                                                                                   | Cite ADR-0072 and ADR-0067                                                                                                                        |
| §10                                                                                                                                                        | Row 1 reads "Landed: ADR-0067–0074". Rows 2 and 3 are rewritten as §0.4 and §0.5: the probe in row 2, the gridded climatology's artifact in row 3 |
| §13                                                                                                                                                        | "Octave multiple scattering … A measured choice" and "Spatiotemporal blue noise … Adopted" take the verdicts the campaign gave                    |
| §9                                                                                                                                                         | The rows phase 1 measured carry the mini's figures                                                                                                |

`design/plans/the-upscaler.md:11-54` goes with package V.

### 9.3 `CONTEXT.md`

One entry before `## Known gaps`:
`## The clouds have their light, held to references, and nothing draws them unasked (DD Mon 2026)`.
It links the ADRs, gives the figures with their conditions, and says what was
tried and rejected. Each defect a phase 1 test caught goes under
`## Bugs the tests found`; the march's left-endpoint source is the first.

### 9.4 Docs that change with the code

| File                                                                                   | Change                                                                                                                                                                                                                                 | With                      |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `docs/guides/harness.md`                                                               | The cornerstones and `scripts/weather/capture.mjs`; `ir.sun`, `ir.solveSun`; `ir.settled()`'s `clouds`; the scripted casts; that taking a picture with no weather turns the clouds off on a flagged page, for a person driving by hand | K, the first pull request |
| `docs/agents/driving.md`, `.claude/skills/drive/SKILL.md`, `scripts/drive.mjs:199-201` | `--settle` waits on the clouds                                                                                                                                                                                                         | K                         |
| `docs/guides/harness.md`                                                               | `scripts/castSteps.mjs` and the trail; the `weather` lever and the levers that stay; `ir.clouds()`'s opacity and range; the generated tables' commands                                                                                 | The docs step, the second |
| `docs/concepts/rendering.md`                                                           | **Unchanged in phase 1.** A concept page says what the system does, and no body draws the volume unasked yet. Phase 2 writes the weather's section with the default                                                                    | —                         |
| `design/plans/weather/README.md`                                                       | Where the work stands; the record's table (§3.7); **the register** the rubric asks for (§7 there): each declared row, its figure or its absence, and its ADR; the panel's ledger and the calibration round's scores                    | K, then N                 |
| `design/plans/weather/mvp.md`, `references.md`                                         | The settled rubric and the frozen manifest, with the anchors' dated note                                                                                                                                                               | The orchestrator          |
| `docs/guides/harness.md`                                                               | The panel's tools; the classification of a flagged step; the 60 Hz hold and which rows need it; the runner's rule outcomes                                                                                                             | J, I, Q                   |
| `design/plans/weather/phase1/design.md`, `package-reports.md`                          | This document and its packages' reports                                                                                                                                                                                                | The orchestrator          |

---

## 10. Work packages

### 10.1 Rules for every package

1. **Base.** A package branches from the merge its wave names (§10.3), in a
   worktree, runs `pnpm install --frozen-lockfile --prefer-offline` first, and
   reads the `.claude/rules/*.md` extracts for its paths itself. Packages
   merge into their pull request's branch locally and open no pull request of
   their own (§10.5).
2. **Merge forward, never rebase.** No pushed weather branch is rebased and
   nothing is force-pushed; a fix to an earlier wave goes on its branch and
   merges forward. This overrides `.claude/rules/branching.md`'s rebase rule,
   which is written for branches bound for `main`. `/ship` is not used: it
   rebases onto `origin/main`.
3. **Own only the listed files.** No two packages in flight at once own one
   file. A file a package does not own is read-only to it. Two packages hold
   an authority beyond their lists: C for the mechanical propagation of a
   contract (§4.11), and N for integration failures.
4. **Build against the contracts; test with analytic media through the
   stand-ins.** A package's tests import what its base holds, never a
   sibling's work in flight.
5. **The machine is shared.** A gate budgets every core and does not know of
   the others (`scripts/check.mjs:356-362`); ten at once on twelve cores
   measure the machine, not the code (`:48-50`). So:
   - every package's brief sets `IR_CHECK_JOBS=4`;
   - at most five packages are in flight at once;
   - a generator or a reference that runs for more than a minute starts only
     when the orchestrator grants it a CPU window;
   - GPU tests run as `IR_GPU_WAIT=300 pnpm vitest run --config
apps/game/vitest.gpu.config.ts <names>`. Three hundred seconds is under a
     foreground call's ten-minute cap. A refusal means a rig or a campaign
     holds the lock while a package is in flight, which §10.3 forbids, so the
     package reports it and does not wait longer.
6. **No package opens a browser** except the capture, K's and then U's, and
   package Q's pacing study, each of which the orchestrator schedules in a
   window. So no plate of this phase's light exists before window 3 (§8.6).
7. **A generator** runs as `node apps/ingest/src/<file>.ts`, then
   `pnpm exec prettier -w` on what it wrote. **Its file's header carries
   nothing that differs between two runs:** the generator, its inputs'
   hashes and its source's citation, and not the machine, the Node version or
   the seconds it took. Those go in the package's report and the commit's
   body. The Mie generator writes them into its header
   (`apps/ingest/src/mieTable.ts:445`), so regenerating an identical table
   changes the file (phase 0's council); package T1 takes them out of it, and
   the ice, slab, cumulus and mask generators never put them in. One that
   runs for minutes is split by row over processes from the command line:
   rule 8 keeps `worker_threads` out of ingest.
8. **Commit each reversible step,** with an extended body. **Report:** the
   done command's output, the files changed, any contract missing, every
   figure as measured or not measured, and the fta score of any file within
   ten points of the cap.

### 10.2 The packages

Sizes are in §10.6. Every done command starts with `IR_CHECK_JOBS=4 pnpm check
--only gate`; what follows is what it adds.

**Wave 0, the first pull request. Built.** K and V are merged as
`weather/p1-cornerstones`. K is twelve commits and about 4,500 lines of its
own against this design's 2,100, which is phase 0's ratio again. Their lists
below are what they were given, and package U owns K's capture files from
wave 2.

**K: the cornerstones.** Opus 5.5.

- **Owns:** `packages/devtools/src/pictures.ts`, `pictureFormat.ts`,
  `cornerstones.json`, `solarTime.ts`, `harness.ts`, `host.ts`, `clouds.ts`,
  `index.ts` and their tests; `apps/game/src/planetarium/presetUrl.ts` and its
  test; `apps/game/src/engine/GameEngine.ts` and `pictureWeather.ts` with its
  test; `apps/game/src/scene/Bodies.tsx` (the deck's shadow);
  `packages/rendering/src/weatherScenario.ts` and its test (three scenarios
  and `cloudsServed`), with `scenarioCoverageNode` in `render/cloudMaps.ts`
  for the dusk edge's field (§3.3);
  `apps/headless/src/cornerstoneLedger.test.ts` and its snapshot;
  `scripts/weather/capture.mjs`, `sheet.mjs`, `descent.mjs`,
  `capture.test.mjs`; `scripts/drive.mjs` (help text);
  `scripts/driveUrl.test.mjs`; the root `package.json` (one script,
  `cornerstones:ledger`); ADR-0067 with its README row and `wings.mjs` entry;
  §9.4's first two rows; `design/plans/weather/README.md` (the record).
- **Keeps two files under the cap.** `harness.ts` scores 84.4 and
  `GameEngine.ts` 82.8 against 91 (phase 0 design §2.4). The solar verbs'
  bodies are in `solarTime.ts` and the weather's mapping and release in
  `pictureWeather.ts`, with one-line delegates in the two large files. K
  reports both scores.
- **Reads:** `scripts/presets/capture.mjs`, `scripts/gpuLock.mjs`,
  `render/cloudLevers.ts`.
- **Done:** `IR_GPU_WAIT=300 … cloudSensor cloudSystem`; `pnpm
presets:compare --all` at 0 moved and `pnpm presets:ledger` with no diff;
  then, in window 1, the capture with `--twice` and `--cut`, and the six
  casts with their controls.

**V: the `velocity` fix.** Opus 5.5.

- **Owns:** `render/sceneLayout.ts` and its test, `sensorMrt.ts`, `sensor.ts`
  (`:188`, `:239`), `upscale.ts`, `upscale.gpu.test.ts`, `cloudComposite.ts`
  (`:135-139`, `:500`, `:518-520`) and its GPU test;
  `docs/adr/0044-the-sensor-reconstructs-the-display.md`;
  `design/plans/the-upscaler.md`.
- **Done:** `… upscale cloudComposite sensor radianceReactivity
sensorMotion`, and §7.2's re-measurement in window 1.

K and V started from phase 0's landing commit, so the four files of theirs
the landing rewrote (`render/sensor.ts`, `render/cloudComposite.ts` and its
GPU test, `packages/devtools/src/clouds.ts`) were met as the landing left
them.

**Wave 1**

**C: the contracts.** Fable 5.2.

- **Owns:** `render/cloudLevers.ts`, `cloudNodes.ts`, `cloudUniforms.ts`,
  `cloudFrame.ts` (types, the reason union, the `cloudsServed` call) and their
  tests; `render/cloudField.ts` and `cloudSystem.ts` (construction sites and
  the front handle), `cloudSystemRig.ts`; `render/cloudContracts.test.ts`,
  `cloudPremises.gpu.test.ts`, `cloudTrace.gpu.test.ts` (the census);
  `packages/rendering/src/weatherGenus.ts`, `weatherClimate.ts`,
  `weatherField.ts` (types, with `regimeWeather` real and `bodyWeather`
  returning the `fair-cumulus` regime), `weatherScenario.ts`
  (`cloudsServed`), `mieTable.ts` (`diffractionShare`, and `convolveDisk`
  returning its input), `index.ts`; `render/air.ts` (the `sky` member and its
  stand-in); every stub §4.1 marks, a generated table's stub being a valid
  tiny table; `render/cloudMix.ts`, the crossing's law in TSL, as a stub that
  mixes as the march does today; `apps/ingest/src/weatherSources.ts`;
  `apps/ingest/package.json` and `pnpm-lock.yaml` (`h5wasm`);
  `engine/GameEngine.ts` (the `weather` lever, the handle's field).
- **Declares what the decisions added:** the `over`, `sunSlices` and
  `sunRamp` levers and `lightTaps`' two new values (§4.6); `trace.sunWeight`;
  `CloudSunDepthNodes` returning a sample's two depths and the grid's weight
  where it returns one depth (§5.5); `CloudBudget.sunSlices` in place of the
  whole-grid cap (`render/cloudSystem.ts`, `budgetOf`); each level's mean
  depths in `CloudLevelFrame`; the statistics' function in `cloudMix.ts`, as
  a stub that returns one, which is today's "no cloud past the taps"; and
  `packages/rendering/src/cloudSunSchedule.ts`, a stub that schedules as the
  grid does today.
- **Declares what the rubric and phase 0's reviews added:**
  `resolveCloudLevers` and `cloudLeversHash`, and the hash in `ir.clouds()`
  (`packages/devtools/src/clouds.ts`; §4.6); `CLOUD_LIGHT_TAPS`, exported;
  the `farBlocks` lever; the clock's own rate among the frame's inputs, with
  the one line of `scene/Sensor.tsx` that passes it (§4.7); `'climate'` as a
  value of the `weather` lever, which the landed page reports unavailable;
  and `cloudFrame`'s `wet` predicate calling `cloudsServed`, with C11's test
  (§4.8).
- **Makes phase 1's first test change:** the three accuracy instruments'
  landed figures as bounds, and one case of each in the always-on suite
  (§6.3). It needs window 1's instrument documents from the landed code.
- **Holds the declared bytes to the device:** `cloudSystem.gpu.test.ts`
  wraps `createTexture` and `createBuffer` (§6.2), and `cloudWarm.gpu.test.ts`
  gains the lever sets with `served` and `second`.
- **Holds §4.11's authority** over every cloud module and cloud test, for
  mechanical propagation alone.
- **The premise spike,** each with its fallback written into the contracts
  before wave 2:

| Premise                                                                                                                                                                                             | If it fails                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| The system's real trace kernel binds what §4.5 counts                                                                                                                                               | The count found replaces §4.5's table, and the sky table packs into the atlas at 16 |
| Three `mat3` uniforms in a compute kernel                                                                                                                                                           | Nine `vec3` rows                                                                    |
| A `Data3DTexture` of RGBA16F, linear, sampled at level 0 in a compute kernel                                                                                                                        | A 2D atlas of eight slices, blended by hand                                         |
| `textureLoad` of an R8 3D texture in a compute kernel                                                                                                                                               | A 256 × 256 2D atlas of sixteen tiles                                               |
| A table added to `AirUniforms` and read by no existing material leaves the WGSL of all six sites that build one hash-equal (`planet.ts:326`, `terrain.ts:377`, `water.ts:285` and the three others) | The sky table stays out of `AirUniforms`, in the cloud system's own bundle          |
| Re-uploading a 1024 × 64 RGBA16F `DataTexture` costs under 2 ms                                                                                                                                     | The convolution moves to the atmosphere task (§4.7)                                 |

- **Done:** `IR_GPU_WAIT=300 … cloudPremises cloudTrace cloudSystem cloudWarm
cloudSensor cloudSecondBody materials`, every hash equal, and a frame of
  the system pixel-equal to its base's (the bridges draw phase 0's picture).

**Wave 2**

| Package                          | Model     | Owns                                                                                                                                                                                                                                                                                                                                                                                           | Done adds                                                                                                                                                                                                                                                  | GPU                                                 |
| -------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **D: density and climate**       | Opus 5.5  | `weatherGenus.ts`, `weatherClimate.ts`, `weatherField.ts`, `weatherScenario.ts`, `weatherNoise.ts` and their tests; `apps/headless/src/weatherCanon.test.ts`                                                                                                                                                                                                                                   | —                                                                                                                                                                                                                                                          | No                                                  |
| **R1: the slab references**      | Fable 5.2 | `apps/ingest/src/transport/legendre.ts`, `moments.ts`, `addingDoubling.ts`, `monteCarloSlab.ts`, `slabTables.ts`, `octaveFit.ts` and tests; `slabReference.generated.ts`, `slabSource.generated.ts`, `cloudOctaves.ts`                                                                                                                                                                         | `pnpm test:slow slabTables monteCarloSlab`, with the slow row's runtime; the report carries the scaling's bill, the reconstruction's error with and without `J_f`, at the nodes and between them, at `τ` 0.5, 1 and 2, and the octave fit's held-out error | No; CPU windows for the Monte Carlo rows            |
| **T1: the phase atlas**          | Opus 5.5  | `packages/rendering/src/mieTable.ts` and its test; `render/cloudPhase.ts`; `cloudLight.gpu.test.ts`; `apps/ingest/src/mieTable.ts` (its header alone, §10.1)                                                                                                                                                                                                                                   | `… cloudLight`                                                                                                                                                                                                                                             | Suite                                               |
| **T2: the sky table**            | Opus 5.5  | `skyIrradiance.ts` and its test; `render/atmosphereTask.ts` and its test, `atmosphereLuts.ts`, `air.ts`, `cloudSky.ts`, `cloudSky.gpu.test.ts`                                                                                                                                                                                                                                                 | `… cloudSky materials atmosphereSky surfaceVisibility`                                                                                                                                                                                                     | Suite                                               |
| **H: the frame and the history** | Opus 5.5  | `render/cloudFrame.ts`, `cloudHistory.ts` and their tests; `packages/rendering/src/weatherClock.ts` and its test. With the reset's reasons: the jump test against the clock's rate (§4.7), the field's derivation with no `horizonBasis` (§5.3), the history's oracle from the CPU field and level flight at a base (§5.10)                                                                    | `… cloudHistory cloudSystem`                                                                                                                                                                                                                               | Suite                                               |
| **T3: the mask**                 | Opus 5.5  | `apps/ingest/src/blueNoise.ts` and its test; `blueNoise.generated.ts`; `render/cloudJitter.ts`, `cloudJitter.gpu.test.ts`                                                                                                                                                                                                                                                                      | `… cloudJitter`                                                                                                                                                                                                                                            | Suite; a CPU window                                 |
| **T4: the ice rows**             | Opus 5.5  | `apps/ingest/src/iceTable.ts` and its test; `iceAggregate.generated.ts`; `packages/rendering/src/iceTable.ts` (its decoder) and its test                                                                                                                                                                                                                                                       | The table generated from `.data/weather/baum/`; the source-row test run once locally                                                                                                                                                                       | No; a CPU window                                    |
| **E: ISCCP-H's ingest**          | Opus 5.5  | `apps/ingest/src/isccp.ts`, `isccpSources.ts`, `main.ts` and tests; the root `package.json` (one script); `isccpZonal.ts`, `isccpZonal.generated.ts` and its test                                                                                                                                                                                                                              | —                                                                                                                                                                                                                                                          | No; a fetch of 518 MB                               |
| **Q: the runner**                | Opus 5.5  | `scripts/clouds/measure.mjs`, `page.mjs`, `noise.mjs`, `sequence.mjs`, `frame.mjs`, `rules.mjs`, `campaign.mjs` and their tests: the batches of §7.2; a lens a stance; the rate, the lens and the levers' hash in every row; the build id compared; each rule's outcome computed; the pacing study and the 60 Hz hold (§7.5), with the frame loop's `pace` query if the display cannot hold it | `--dry-run` of every batch of both campaigns                                                                                                                                                                                                               | No                                                  |
| **W: world transparency**        | Opus 5.5  | `render/planet.ts` (`createRingMaterial` alone), `plumes.ts`, `entryTrace.ts`, `cloudFront.ts`, `preload.ts` (the ring's line); `rings`, `plumes`, `entryTrace`, `cloudFront` and `materials` GPU tests; `scene/Bodies.tsx` (the ring's handle), `ThrusterFx.tsx`, `EntryTrace.tsx`                                                                                                            | `… rings plumes entryTrace cloudFront materials`, and the three materials' WGSL hash-equal without a handle                                                                                                                                                | Suite                                               |
| **I: the instruments**           | Opus 5.5  | `scripts/castSteps.mjs`, `scripts/weather/glory.mjs`, `classify.mjs`, `drift.mjs` and their tests; `scripts/frameDiff.mjs` (an export)                                                                                                                                                                                                                                                         | The detector run on K's baseline casts; the classification on a fixture of each kind; the drift measure on a shifted field                                                                                                                                 | No                                                  |
| **R2: the path tracer**          | Fable 5.2 | `apps/ingest/src/transport/pathTrace.ts`, `cumulusTables.ts` and tests; `cumulusFixture.ts` and its test, `cumulusReference.generated.ts`; `render/cloudPathTrace.ts`, `cloudPathTrace.gpu.test.ts`                                                                                                                                                                                            | `… cloudPathTrace`. Built and tested on an analytic fixture; the reference is generated after G merges                                                                                                                                                     | Suite; a CPU window; the long run is the campaign's |
| **L: the sun's depth**           | Fable 5.2 | `render/cloudSunGrid.ts`, `cloudVolume.ts` and their GPU tests (`cloudSunDepth`, `cloudVolume`, `cloudSunAccuracy`); `packages/rendering/src/cloudSunSchedule.ts` and its test; `render/cloudMix.ts` (the statistics' function alone; the crossing's law in it is M1's); the budget's two lines in `cloudSystem.ts`                                                                            | `… cloudSunDepth cloudVolume cloudSystem`; `rg` showing no reader of the bound before it goes; the sun gate at both of phase 0's suns and at G3's, recorded                                                                                                | Suite                                               |
| **Y: the over pass**             | Fable 5.2 | `render/cloudOverPass.ts`, `cloudLayers.ts`, `cloudFrameNode.ts`, `cloudComposite.ts` (`compositeOver` and its two forms) and their GPU tests; the composite's term in `sensor.ts` and the frame's choice of form in `cloudSystem.ts`; `passTimeline.ts` only if the spike puts `lean`'s edit there                                                                                            | `… cloudOverPass cloudComposite cloudWarm cloudSensor`; the spike's finding on the descriptor; its reading of the composite's other attachments and their readers; the composite's four unheld cases (§4.12)                                               | Suite                                               |
| **J: the panel's tools**         | Opus 5.5  | `scripts/panel/packet.mjs`, `validate.mjs`, `ledger.mjs`, `archive.mjs`, `crops.json`, the brief's template, and their tests (§8.6)                                                                                                                                                                                                                                                            | The tests of §8.6 on fixture rounds; one packet built from the baseline's records, if window 1's exist                                                                                                                                                     | No                                                  |
| **U: the capture's second pass** | Opus 5.5  | `scripts/weather/capture.mjs`, `descent.mjs`, `sheet.mjs`, `capture.test.mjs`; `packages/devtools/src/cornerstones.json` (the overlay guard), `solarTime.ts` (a place that moves), `harness.ts` (the clock's verb, one delegate); `apps/headless/src/cornerstoneLedger.test.ts`; ADR-0067's amendment                                                                                          | `capture.test.mjs`, the ledger test; then, in window 1b, `--pairs 5` on the baseline                                                                                                                                                                       | No; window 1b                                       |

D, R1, T1, T2, H and L go first: wave 3 waits on them. J and U start with
them, because neither waits on the contracts for anything but the lever's
hash and the `'climate'` value, and the calibration round waits on both. The
other eight start as slots free. L and Y each edit `cloudSystem.ts` in hunks
of their own, `budgetOf` and `beginFrame`'s layers, and merge in that order.

**Wave 3**

| Package                             | Model     | Base              | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Done adds                                                                                                                                                      |
| ----------------------------------- | --------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F: the field on the GPU**         | Opus 5.5  | D, H, T2 merged   | `render/cloudProfile.ts`, `cloudMaps.ts`, `cloudClipmap.ts`, `cloudDensity.ts`, `cloudNoise.ts`, and their GPU tests. The volume's bake calls its injected field, so F edits no line of `cloudVolume.ts`. The cube's and the clipmap's pace and their freshness by generation (§4.7), and the two-eyes test on the GPU (§5.3)                                                                                                                                                      | `… cloudNoise cloudMaps cloudClipmap cloudDensity cloudSystem`                                                                                                 |
| **M1: the march**                   | Fable 5.2 | T1, H, L merged   | `render/cloudMarch.ts`, `cloudKnots.ts`, `cloudTrace.ts`, `cloudSunlight.ts`, `cloudMix.ts` (the crossing's law); `packages/rendering/src/cloudOverlap.ts` and its test; `cloudTrace.gpu.test.ts`, `cloudFront.gpu.test.ts`, `cloudRange.gpu.test.ts`. It reads the sun's two depths and the weight through L's `CloudSunDepthNodes`, and takes the sun gate again with its own taps. The knots as a level's crossing (§4.9), a tap's three reads (§5.4), the range readout (§8.5) | `… cloudTrace cloudSunDepth cloudSystem`. The scaled medium, the step's integral, the crossing's law, the prefetch, the taps, the floor, the band, the readout |
| **M2: the light after first order** | Fable 5.2 | M1, R1, T2 merged | `render/cloudMarch.ts`, `cloudSource.ts`; `cloudSlab.gpu.test.ts`, `cloudFurnace.gpu.test.ts`, `cloudGlory.gpu.test.ts`                                                                                                                                                                                                                                                                                                                                                            | `… cloudSlab cloudFurnace cloudGlory cloudTrace`. The higher orders, the sky, the gates                                                                        |
| **X: the far march's light**        | Fable 5.2 | M1, R1, T2 merged | `render/cloudFar.ts` and `cloudFarAtlas.ts`; `cloudFar.gpu.test.ts`, `cloudFarFurnace.gpu.test.ts`, `cloudFarCompare.gpu.test.ts`, `cloudHandover.gpu.test.ts`. First the atlas's score at 800 m on its base; then §5.9's six changes, the instrument's reference and its relative errors, the atlas's pace, its blocks in view first and its freshness by generation (§4.7)                                                                                                       | `… cloudFar cloudFarFurnace cloudSystem`                                                                                                                       |
| **G: the calibration**              | Opus 5.5  | D, R1, E merged   | `packages/rendering/src/weatherCalibration.test.ts`; `weatherGenus.ts` (the ranges), `weatherScenario.ts` (each regime's thickness and cover)                                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                              |

M2 and X read the higher orders' source through the contracts' stub of
`cloudSource.ts` until M2 fills it, so they run side by side.

**Wave 4**

**N: integration.** Opus 5.5.

- **Owns:** `render/cloudSystem.ts`, `cloudField.ts`, `cloudSystemRig.ts`,
  `cloudComposite.ts` (the second body's bindings and the point source's
  split, §5.1) and its GPU test, `sensor.ts`, `scene/Sensor.tsx`,
  `engine/GameEngine.ts`; `cloudSystem`, `cloudWarm`, `cloudSensor`,
  `cloudSecondBody`, `cloudCompositeError` and `cloudCumulus` GPU tests;
  `packages/devtools/src/clouds.ts` (the report's `opacity` and `range`, and
  the three parts of "whole"); `packages/devtools/src/cornerstones.json`
  (E3's weather to `climate`); `design/plans/weather/README.md` (phase 1's
  column, and the register).
- **Gives the second body the identity** (§4.10), with `cloudSecondBody`'s
  cases for it.
- **Takes the first frames apart** (§4.7): why the `warming the clouds` span
  is empty, what the first five frames spend, and what of it moves into the
  boot's warm-up.
- **Removes the bridges' old members** §4.11 gives it: `droplets`,
  `CloudFrame.scenario`, `CloudMedium.column`, `cloudContracts.test.ts`.
- **Authority over every cloud module for integration failures,** each fix its
  own commit naming the defect, with the module's own tests re-run, as phase
  0's integration had (its §11.2).
- **Done:** `pnpm check` (full) and `IR_GPU_WAIT=300 pnpm test:gpu` (full),
  with the suite's wall time recorded, which nothing has yet.

### 10.3 The order of work, and the machine's windows

1. **Done.** Phase 0 is landed, measured twice and documented. Wave 0, K and
   V, is built and merged as `weather/p1-cornerstones`.
2. **Window 1, under way:** K's baseline capture with `--twice` and `--cut`,
   V's 32 cells into ADR-0044, and phase 0's ladders and instruments on the
   landed code, which gives the landed set its first ladder and the atlas its
   score at 800 m. Then **the first pull request is opened** (§10.5).
3. **Phase 0's own fixes merge forward first.** Its council's record fixes,
   the cloud pass's exception guard, the runner's refused rows, a stance's
   lens and the rows retaken through it land on `weather/phase-0` and are
   merged into `weather/p1-cornerstones` before C's base is cut. C pins
   instrument figures and Q extends the runner, and neither should start from
   a tree those fixes are about to change.
4. **Wave 1: C,** on `weather/phase-1`, cut from that tip. **Beside it: J, U
   and I,** from the same tip. They touch no file C does, and the
   calibration round waits on J and U. When C merges, **the second pull
   request is opened as a draft,** and J, U and I merge into it as each is
   done.
5. **Window 1b,** once U is in: the noise floor, five pairs of boots on the
   baseline, and the pacing study (§7.5), which needs the landed runner and
   the display and no package.
6. **The anchors are frozen, and the calibration round runs.** It needs no
   window. It has to close before window 3 (§8.6).
7. **Wave 2,** from C, five in flight at most: D, R1, T1, T2, H and L first,
   as slots free; then E, which package G now waits on; then Y, Q, W, T3, T4
   and R2. Each merges when done; after each merge the orchestrator runs the
   gate and §4.11's four system tests on the mini, where the tests CI skips
   count.
8. **Wave 3:** F from the merge of D, H and T2; M1 from the merge of T1, H and
   L; then M2 and X when M1 is in; G when D, R1 and E are in. R2 generates
   its reference after G, in a CPU window.
9. **Wave 4: N.** Then the full check and suite, `presets:compare --all` at 0
   moved and `presets:ledger` with no diff.
10. **Window 2: campaign `choices`.**
11. **Decide and land.** §7.4's rules on the tables, each computed by the
    runner; one commit deletes the losers and sets the winners as defaults;
    the gate and the suite.
12. **Window 3: campaign `landed`,** then the capture set on the same commit:
    the ten plates, the casts with their controls, the settled stills, and
    each flagged step classified.
13. **Record.** `chore(clouds): phase 1's figures, measured on the Mac mini`,
    with the runner's tables, each rule's outcome, and the register's rows.
14. **Docs** (§9), then the review by layer and the council, once.
15. **The second pull request is marked ready,** with the sheets in its body.
    Phase 2 branches from its tip.

**The windows.** In each the machine is held whole, with no package of any
phase in flight. All are estimates, from phase 0's per-run arithmetic.

| Window | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Estimate                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1      | Under way: K's baseline, ten stills from two boots each, the cut take, twelve casts of about 6,700 frames; V's 32 cells; phase 0's ladders and instruments on the landed code                                                                                                                                                                                                                                                                                   | The wave-0 delegate's; about 2 hours                     |
| 1b     | The noise floor: ten boots of the ten stills. The pacing study                                                                                                                                                                                                                                                                                                                                                                                                  | About 1.5 hours                                          |
| 2      | `choices`: four batches, about 2.5 hours, and half an hour more if O was built; `over`, `reset` and `sun`, about 1.5 hours (**E**: 22 `ab` rows of five pairs, the placement's cell, 48 sequences, three instrument suns, six casts with their controls); the casts' stage with the rubric's set at each band and clip, about 30 casts and 600 settled stills, about an hour; the instruments, with the GPU path tracer up to 45 minutes (research §3.3, **E**) | About 6 hours                                            |
| 3      | `landed`, about 3.5 hours: its ladders with two more tap values and a third stance, `frame` on 22 stances and presets, the four reset sequences, the warp rows, `pace` under the hold, `memory` and `error` with the two `pair` stances. The capture set, its casts, the settled stills and the classification, about 1.5 hours                                                                                                                                 | About 5 hours                                            |
|        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **About 14.5 hours, in four windows,** before any resume |

Phase 0's campaign needed a detached driver with eight resumes a stage to
finish at all (`scripts/clouds/campaign.mjs:60-66`), so the total is a floor.
**Phase 2's wave 0 does not start before window 3 closes;** its design may.

**The CPU windows** are not the machine whole, but each runs for more than a
minute and is granted: R1's Monte Carlo rows; R2's six tracer processes, about
20 minutes of a core each; T3's mask; T4's reduction; E's read of 120 files.

### 10.4 The files phase 0's choices leave, and who owns each

The lists are fixed. A line number in any of these is read again at the
landing commit.

| Choice            | What stays                                                                                                                                                        | Owner in phase 1                                                                                                                                   | What is gone                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Placement A       | `render/cloudOverPass.ts`, `cloudLayers.ts`, `cloudFrameNode.ts`; the composite's one mesh in `cloudComposite.ts`; `markOverClouds` in seven scene components     | **Y.** W draws its three objects in pass B's list and edits no order. The scene's marks are not edited by any package                              | `cloudSplit.ts` and its test; the split's mesh; `splitOrders` in `CinematicStage.tsx` and `OrbitTraces.tsx` |
| Far field: atlas  | `render/cloudFarAtlas.ts`, holding `FarMarch`; `farSecond`, the second body's own atlas                                                                           | **X.** In §5.9 `ℓ` is a slab step's horizontal run                                                                                                 | `cloudFarSpheres.ts`                                                                                        |
| Cache: the field  | `cloudMaps.ts`, `cloudClipmap.ts`, `cloudDensity.ts`, `cloudProfile.ts`, `cloudNoise.ts`                                                                          | **F.** The turn is three matrices in the level's uniforms. **M1**'s kernel binds 12 to 14                                                          | The volume as a medium the march reads, its lever and its key in `packages/devtools/src/clouds.ts`          |
| Sun's depth: grid | `render/cloudSunGrid.ts`; `render/cloudVolume.ts` as its source, cut to two levels with no bound; `cloudSunDepth`, `cloudVolume` and `cloudSunAccuracy` GPU tests | **L**, both files. **M1** reads through `CloudSunDepthNodes` and edits neither. **F** edits neither: the volume's bake calls the field it is given | `cloudSunCascades.ts`, `sunCascades`, the `sunDepth` lever                                                  |

- **Two names move with the landing.** In its tree as this is written,
  `keepRenderer` stands in `render/cloudFrameNode.ts` and
  `SUN_DEPTH_FRAME_CAP` in `render/cloudSunGrid.ts`, where the campaign
  commit has them in `cloudSplit.ts` and `cloudSunCascades.ts`. Packages Y
  and L read both at the landing commit before they start.
- What each package's list gained or lost by these is in **After the
  decisions**, at the end.

### 10.5 The pull requests

CI runs on a pull request and on a push to `main`, and on nothing else
(`.github/workflows/check.yml:19-23`). A branch with no pull request gets no
CI, so one pull request at the phase's end would first meet CI's hosted
adapter, and its 20-minute jobs, on the finished branch. Phase 1 is two
stacked pull requests.

|        | The first                                                                                                                                                                                                                                                                                                                                  | The second                                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Branch | `weather/p1-cornerstones`                                                                                                                                                                                                                                                                                                                  | `weather/phase-1`                                                                                                                                                                                                                                                                                            |
| Base   | `weather/phase-0` at its landing commit; `the-weather` once phase 0's pull request merges                                                                                                                                                                                                                                                  | `weather/p1-cornerstones`; then whatever is lowest and unmerged under it                                                                                                                                                                                                                                     |
| Holds  | K and V                                                                                                                                                                                                                                                                                                                                    | Waves 1 to 4, the campaigns, the landing, the docs                                                                                                                                                                                                                                                           |
| Opened | After window 1, ready                                                                                                                                                                                                                                                                                                                      | As a draft when C merges; ready at step 15                                                                                                                                                                                                                                                                   |
| Gate   | Full `pnpm check`; full `pnpm test:gpu`; `presets:compare --all` at 0 moved and `presets:ledger` with no diff; the capture's two boots under the noise floor and its cut take equal to its fresh boot; the sheets and the six baseline casts in its body; V's re-measured figures in ADR-0044; ADR-0067 with its `wings.mjs` row; CI green | §10.3 steps 9 to 14; every rule of §7.4 applied and its loser deleted; each of the rubric's phase 1 rows green, or declared in the register with its figure; the calibration round's scores in the record; ADR-0068 to 0074; the capture's sheets, each cornerstone beside the baseline; CI green on the tip |
| Review | `/code-review`; no council                                                                                                                                                                                                                                                                                                                 | By layer, then the council, once                                                                                                                                                                                                                                                                             |
| Media  | The baseline: phase 0's landed light, stills and casts, and for E1–E3 the deck beside the forced volume                                                                                                                                                                                                                                    | Each cornerstone and cast beside the baseline's                                                                                                                                                                                                                                                              |

- Every push to the draft runs CI, and a superseded run is cancelled
  (`check.yml:29-31`), so the hosted adapter is met from wave 1 on.
- Nothing is rebased, `/ship` is not used, and each pull request enters
  `the-weather` by a merge commit, which is one more of Jon's merge cards than
  a single pull request would cost.
- The council sits once for the phase, on the second.

### 10.6 Sizes, and the critical path

Phase 0's packages landed at 1.9 times their estimates: 28,592 lines against
14,700, by `git diff --shortstat` over each package's commits (the engineering
critique's finding 11). "Estimate" below is this design's own count, tests
included; "expected" is that count at phase 0's ratio.

| Package | Estimate   | Draft 4 adds | Expected     | On the critical path                                       |
| ------- | ---------- | ------------ | ------------ | ---------------------------------------------------------- |
| K       | 2,100      | —            | Built: 4,500 | It was: the first pull request, and C's base               |
| V       | 300        | —            | Built        | —                                                          |
| C       | 2,700      | 300          | 5,100        | Yes. It waits on window 1's instrument documents           |
| D       | 1,650      | 50           | 3,150        | Yes: F, G                                                  |
| R1      | 2,300      | —            | 4,400        | Yes: M2's tables and gates                                 |
| T1      | 600        | —            | 1,100        | Yes: M1                                                    |
| T2      | 700        | —            | 1,300        | Yes: M2                                                    |
| H       | 1,350      | 150          | 2,550        | Yes: F, M1                                                 |
| L       | 800        | 200          | 1,500        | Yes: M1 reads the sun's depth through it                   |
| T3      | 500        | —            | 950          | No                                                         |
| T4      | 500        | —            | 950          | No                                                         |
| E       | 1,000      | —            | 1,900        | **Now on the second path:** G's row 9 reads its table      |
| Q       | 1,300      | 600          | 2,450        | No; due by window 2, and the hold by window 3              |
| W       | 900        | —            | 1,700        | No                                                         |
| I       | 1,200      | 500          | 2,300        | No; due by window 2                                        |
| R2      | 1,800      | —            | 3,400        | No; its reference is due by window 2, after G              |
| Y       | 850        | 150          | 1,600        | No; due before N, and by window 2                          |
| J       | 1,300      | 1,300        | 2,450        | **The third path:** the calibration round, before window 3 |
| U       | 1,200      | 1,200        | 2,300        | The third path, and every cast of window 2                 |
| F       | 1,600      | 200          | 3,050        | Yes                                                        |
| M1      | 1,600      | 300          | 3,050        | Yes                                                        |
| M2      | 1,000      | —            | 1,900        | Yes                                                        |
| X       | 1,200      | 300          | 2,300        | No; due before N                                           |
| G       | 500        | —            | 950          | No; R2's reference waits on it                             |
| N       | 1,550      | 250          | 2,950        | Yes                                                        |
| **Sum** | **30,500** | **5,500**    | **58,000**   |                                                            |

**What draft 4 costs.** Two packages, J and U, and 5,500 lines by this
design's count, about 10,500 at phase 0's ratio: 25 packages and 58,000 lines
expected, of which wave 0's 5,000 are built. The machine's windows go from
three and about 10 hours to four and about 14.5: the noise floor and the
pacing study are new, and windows 2 and 3 take the rubric's casts, the
settled stills, the whole-frame rows, the warp rows and the hold's.

**The critical path** is window 1, phase 0's fixes merged forward, C, then R1
beside the shorter D, T1, T2, H and L, then M1, M2, N, window 2, the landing
commit, window 3, the docs and the council. R1 and the two halves of the
march are the transport, and they are Fable's.

- **What moved on it:** C now waits on window 1's instrument documents, which
  it pins, and on phase 0's fixes. Nothing else of draft 4 is on the main
  path: its work is in packages that were already off it, or in J and U.
- **The second path** is D and E to G to R2's reference, and it has to close
  by window 2. E joined it: the rubric's row 9 holds each genus's mean depth
  to ISCCP-H's.
- **The third path is new:** J and U, window 1b, the anchors frozen, the
  calibration round. It has to close before window 3, and it is the one most
  likely to be forgotten, because no code waits on it.
- **The hold** has to exist by window 3's `pace` batch, or B13 to B15 stay
  recorded only for another phase.

---

## 11. Risks, what needs a decision, and what was not verified

### 11.1 What the rulings settled, and what is still asked

Draft 1 asked seven things. Each is ruled and folded in:

| #   | Ruled                                                                        | Where it is now                                            |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | The default turns on in phase 2                                              | §0.3, §0.4, with the flag's retirement                     |
| 2   | The world's rule stands, and the replacement is expected                     | §3.3; the campaign's stances stay on far-shore V (§7.2)    |
| 3   | The orchestrator freezes the references, and Jon is shown them               | §3.7                                                       |
| 4   | Rain's table waits for phase 4; the cloudbow is phase 1's number             | §5.4, §6.2                                                 |
| 5   | Baum's reduced table is committed, with its citation and "no license stated" | §4.4, §5.4, package T4                                     |
| 6   | `h5wasm` through pnpm; the two Python fixtures made once outside the tree    | Package C adds the dependency, so T4 and E share it; §5.11 |
| 7   | The `velocity` fix on the stack alone                                        | §0.2, package V                                            |

One of the rulings' premises does not hold: "wave 0 owns no file the landing
deletes or rewrites". It owns four, with placement A decided (§10.2), by the
engineering critic's evidence, which the code bears out. Wave 0 now starts
from the landing commit, so there is no merge to order (§10.3).

**Settled since draft 3,** and folded in: K's world and its land stance
(§3.3); G3's weather, which K built as `dusk-altocumulus`; the thin form
(§4.10); the rubric's budget rows, which took draft 3's proposals as B4, B7,
B10 and B11; and A against B at `25df44ab`, which the orchestrator declined
for now (§4.12).

**What each of the first packages needs from the orchestrator:**

| Package            | Starts from                                                    | Needs                                                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C**, wave 1      | `weather/p1-cornerstones`, with phase 0's fixes merged forward | Window 1's instrument documents from the landed code, the far comparison at 400, 800 and 1,600 m among them, which it pins. §4.11's authority. The rubric and this design committed in the tree it starts from  |
| **J**, beside C    | The same tip                                                   | `references.md` as frozen, with its captions and "misleads" notes, for the packet's layout. The brief's text, or leave to draft it from the rubric's §3.7. Window 1's capture records, to build one real packet |
| **U**, beside C    | The same tip                                                   | A ruling on the overlay guard's form if the observatory cannot hold the station's pose (§3.8). Window 1b once it merges                                                                                         |
| **I**, beside C    | The same tip                                                   | K's baseline casts, to run the detector on                                                                                                                                                                      |
| Wave 2's first six | C's merge                                                      | CPU windows for R1's rows; the 800 m score in the record before X is briefed                                                                                                                                    |

**Still asked of the orchestrator:**

1. **A research delegate for the real-time anchor stills,** and their freeze
   in `references.md`, before the calibration round (§8.6).
2. **The calibration round itself,** once J, U, window 1 and window 1b are
   in, and before window 3.
3. **Half an hour of the machine for the pacing study,** in window 1b (§7.5).
   The 60 Hz hold cannot be designed further until the cause is known.
4. **The rubric's council sees §11.2's amendments,** C1's pose first, before
   package U builds the zoom cast.
5. **A declared miss that may come early from package R1.** If the scaled
   medium is more than 3% from the true one in the rubric's domain, row 3 is
   missed, and the figure comes to the orchestrator the day it is known
   (§5.11). It does not stop M2.
6. **CPU windows** for R1's rows, R2's six processes, T3, T4 and E (§10.3).
7. **Phase 0's retaken rows.** Its `cut`, `scrub`, `fly` and `pair-neighbor`
   figures are at another stance's lens (§7.2). This design leans on none of
   them, and B7's landed column in the rubric quotes two.

**Asked of Jon:** nothing new. Package T4 reads
`~/Downloads/polarization_models.zip`, by ruling 5, and extracts it into
`.data/weather/baum/`. Three of the rubric's bars are his to confirm (§10
there): the ground's, a Retina miss, and the deck's deletion.

### 11.2 Where this design departs from the rubric, and what it asks amended

The rubric is settled, and the design follows it. Its rows, bars and checks
are cited by number through this document, and §2.1's done-whens are theirs.
These are the places the design still does something the rubric's words do
not say, and why.

| Rubric                                                                                                   | This design                                                                                                                                                     | Why                                                                                                                                                                                                   | Amendment asked |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| C1: "the zoom cast (G4's pose, 60° to 11.4° in 300 frames)" crosses the handover's band                  | The zoom is taken from G6's start, 400 km up, at pitch −45°. K's zoom at G4's pose stays in the record as a baseline and is read by no check                    | At G4's pose the farthest cloud in frame is 34 km off, and the band begins 172 km out at 60° and 905 km out at 11.4°. The cast crosses nothing, at the landed 800 m or at 400 m (§5.8)                | Yes, 1          |
| C6: fails on "a range under 2 km before the cloud or after it"                                           | Read at the cast's first frame and at its last. G5's path is lengthened so that both can hold, and the ledger test holds the path to it on the CPU field (§8.2) | The readout is along the center ray, and G5 flies along it. Approaching a cloud head-on, the range ahead is the distance to the cloud: about 600 m when the eye is 500 m out, with no defect anywhere | Yes, 2          |
| B7: whole when "every level of the far atlas in view is baked"                                           | Every block of the atlas in view                                                                                                                                | The atlas has faces, layers and blocks, and no levels (`cloudFarAtlas.ts`)                                                                                                                            | Yes, 3: wording |
| §2: the overlay guard is "E1's stance and weather with the station or a hull in frame"                   | E1's height, lens, pitch, sun and weather, at the station's own place and at the instant its sub-point has E1's sun (§3.8)                                      | The station is where its orbit puts it. It passes over E1's place at E1's sun only by chance                                                                                                          | Yes, 4: reading |
| §2: E1 and G6 at pitch −88°                                                                              | −87.995°, as built                                                                                                                                              | −88° is past the stance's limit                                                                                                                                                                       | No              |
| Row 20: a regime may draw through the thin form where its error passes                                   | No regime does. The identity draws everything, the second body included, and the `error` batch gains the two `pair` stances (§4.10)                             | The form buys neither cost nor picture where it passes, and would need a boundary on the descent. This is inside the row, and stricter                                                                | No              |
| §4: a cast is refused outside 58 to 62 Hz only once the hold exists; until then its record says its rate | K's capture refuses now. Package U makes the refusal the hold's                                                                                                 | K was built to draft 3. Until U merges, a baseline cast taken at another rate is refused where the rubric would keep it                                                                               | No              |
| Row 9: each genus's mean `τ` within 15% of ISCCP-H's for its type                                        | Held where package E's table carries the type. Package G waits on E                                                                                             | If E slips, that clause is a declared miss and not a silent skip                                                                                                                                      | No              |
| B13, B14, B15 bind from the first campaign that holds 60 Hz                                              | The hold is package Q's, after a study of why the rate moves (§7.5). Its second means, the page pacing itself, does not make the compositor present             | The cause of the rate's movement is not known, so the hold cannot be promised by a mechanism yet                                                                                                      | No              |
| Row 20's batch: "every regime of the `error` batch, Enhanced off and on"                                 | The batch's display-referred pair is taken at a held exposure or dropped                                                                                        | The pair contradicts the batch's own meter under a meter that settles between two shots (§4.10)                                                                                                       | No              |
| §3.2: the settle waits for "the shadow's slices and the cache levels in view"                            | In phase 1, the history, the grid's weight and the atlas's blocks in view (§3.5). The shadow's slices are phase 2's                                             | Nothing draws a shadow yet                                                                                                                                                                            | No              |

**What the design asks the rubric's council to amend.** Each goes by the
rubric's own §9. The first two matter: without them a check fails, or passes,
for a reason that is not the renderer's.

1. **C1, the zoom's pose.** "G4's pose" becomes "G6's start, 400 km up, at
   pitch −45°". The figure: at G4's pose the eye is 3 km over the deck's top
   looking 35° down, so at a 60° lens the farthest cloud in frame is 34 km
   off, where the band is 172 km to 344 km out at Retina and moves outward to
   905 km as the lens lengthens. From 400 km at −45° the frame is all far
   march at 60° and all fine march at 11.4°, and the band sweeps it between
   (§5.8). C2's "one by a lens and one by distance" then holds as written.
2. **C6, where the 2 km is read.** "A range under 2 km before the cloud or
   after it" becomes "at the cast's first frame or its last". The figure: the
   readout is the distance along the center ray at which the depth reaches
   `ln 50`, about 110 m into a cumulus, so 500 m short of a cloud it reads
   about 600 m. K's G5 path is 1.5 km long, so any cloud it enters is under
   1.5 km ahead at its first frame, and the clause as written fails every
   time.
3. **B7, "every level of the far atlas".** The atlas has no levels; "every
   block of the far atlas in view" is what can be read. And B7's landed
   column, 14.9 and 9.2 ms, is from rows taken through another stance's lens,
   which phase 0 is retaking: the bar's derivation does not use them and
   stands.
4. **The overlay guard's place.** "E1's stance and weather" read as E1's
   height, lens, pitch, sun and weather, at the station's own place.

**One bar is not asked about yet, and may be.** B10 holds Retina's steady Δ
within 0.5 ms of 1080p's with nothing over the clouds. With the second scene
pass gone, what still grows with the target is the composite's fragment and
the depth copy, and the trace falls by 0.02 ms from orbit and 0.3 to 0.6 ms
on the ground (landed). From orbit that leaves Retina about 0.9 to 1.7 ms
over (**E**: the depth copy's 0.2 ms and a fragment of 0.5 to 1.0 ms at
1080p, 2.5 times at Retina). The figure is an estimate, so nothing is asked
on it. If the `over` batch measures it so, B10 goes back to the council with
that figure and the two-clause form: the trace, the history and the bakes no
dearer at Retina, and the composite recorded apart.

**What the rubric took from this design's earlier drafts** is in its text
now: the reflected flux alone, 5 km pixels, the exponent's estimator, G1's
rise, G3's sun and its sunward edge, G4's missing shadow, `castSteps` in
place of `traceFrames`, the trail as a measure, two boots for a plate, the
budget's rows as B4, B7, B10 and B11, and the slab's domain as its §6.1.

### 11.3 Risks, and what checks each

1. **The scaled medium moves every phase 0 figure.** Costs fall and the
   ladders shift. `ladders`, `targets` and `error` are taken again on the
   landed code (§7.2), and §5.4 says how phase 0's own figures read.
2. **The scaled medium may be more than 3% from the true one.** That is the
   rubric's row 3, declared. It is the first number package R1 reports, and a
   miss goes to the orchestrator that day (§5.11). It does not spend the
   march's own gate.
3. **Three terms may not hold a slab at every azimuth.** The reconstruction
   says so in Node, with and without the lobe, before any GPU work, and §7.4
   has a shortfall clause.
4. **S on a cumulus is a slab equivalent.** Gate 2 judges it, with an absolute
   check on its core and base, and the dark-edge term is the fallback.
5. **The crossing's law replaces the march's segments,** which phase 0 tested.
   Its split-invariance is exact by algebra, its CPU reference is rewritten
   with it, and phase 0's own half-clear test carries over. The risk is in
   package M1's size, which is why M is two packages.
6. **The law's form is the literature's, not yet the field's.** The sight
   count in package D decides, and `cloudFarCompare` by pitch bin checks the
   result. If the ratio does not close, the band's width has to hide the gap,
   which the handover's rule then measures.
7. **Flight inside a cloud with every pixel rejected** draws the bilinear
   current each frame, with no accumulation. G5 and the ground fly cast judge
   it. If it flickers, the immediate regime returns for that case alone, on
   the share of pixels rejected, entered at 75% over four frames and left at
   50%, and ADR-0072 records it.
8. **The path tracer's variance.** Albedo one with a 10⁴ sr⁻¹ phase is spiky.
   Its pixels are the curves' own, the GPU tier is held to them by a count,
   and a tolerance is never tighter than three standard errors.
9. **Baum's file may not be what its README says.** Whether its 498 angles
   reach both ends, and how many wavelengths fall in a band, are read by
   package T4, which refuses to extrapolate and records what it used.
10. **The trace binds 14 of 16 at worst** under the field. The census reads
    the real kernel, and one fallback is named.
11. **Two CPU jobs join a frame:** the sky table in the atmosphere task and
    the disk's convolution at a body change. Both are measured by C's spike
    and the boot timeline, and both have a place to move to.
12. **A screencast drops frames.** The detector matches each captured frame
    to the path's index. A gap where a step would be sends the cast back, and
    so does a capture of under two thirds of the path (§8.1).
13. **The contracts change a live system.** §4.11's bridges and four system
    tests at every merge are the guard; C's done command holds a frame
    pixel-equal to its base's.
14. **The cornerstones' world has a 10 hour day.** Its sun moves 2.4 times
    as fast as Earth's, so whatever follows the sun is exercised harder there
    than on the campaign's stances (§3.3). The ledger test holds what the
    pictures need of the world: land under three of them, and G3's margin.
15. **Three r185 premises** are read, not run: `mat3` uniforms and the two 3D
    reads in a compute kernel. C's spike settles each with a fallback.
16. **Phase 1 is twenty-five packages and about 58,000 lines** at phase 0's
    ratio, with about 14.5 hours of the machine held whole. Five run at once.
    Nothing may slip a phase now: E's table is read by row 9.
17. **Earth's forced arm draws no shadow and a regime's weather** in phase 1.
    The record says so beside every plate.
18. **The grid's stand-in is a layer's statistics at the sample's own
    column.** From orbit and past 24 km it is the whole of the sun's depth
    past the taps, so E1 to E3 and every far cloud draw no cast structure
    between clouds. The far march already draws that way; the ramp and the
    wake are judged by casts (§7.4), and phase 2 displaces the columns.
19. **The grid has no figure at a sun under the horizon,** and G3 stands on
    one. Package L measures it, with the first-exit bake and without. G3's
    weather is changed so that the picture is possible at all (§3.3).
20. **The footprint ladder may have converged by removing the far march.**
    `ladders` now records the share of rays handed over and reads the
    footprint on a stance where the band is in frame (§7.3).
21. **`lean` reaches into three by a hold on one call,** as the sea's split
    does. Its spike comes first, and without it `chain` still removes the
    break on a frame with no overlay.
22. **`chain` may not serve every picture.** What the composite writes to
    `motion`, `meterMask` and `reactive` has readers this design did not
    read. Package Y reads them first, and pass B stays wherever the chain
    cannot supply one.
23. **A rule may read two pacing regimes as one.** §7.5 refuses to pool them,
    and a campaign checks its own pacing before its first batch.
24. **The 60 Hz hold may not be buildable from a page.** Its cause is not
    known. If the display cannot pace the page and the page's own pacing does
    not count, B13 to B15 are declared misses at the verdict by the rubric's
    own clause, and the placement's cell stays recorded only.
25. **The budget's plan rests on four estimates of the trace** (§2.6). The
    bars gate at the verdict and not here, and window 3 says where each
    stands; B7's first clause fails first if the trace does not come down.
26. **The calibration round can be starved of anchors.** Few engines draw a
    field from orbit. B is a mean over whatever anchors exist, and the record
    says how many.
27. **G5's path may not exist at its heading.** It needs 2 km of clear range
    before one cloud and after it, in a field at a cover of 0.35. The ledger
    test finds out on the CPU, and the heading is re-solved once if it must
    be.
28. **The knots change under world transparency.** Package W reads them and
    package M1 changes what a knot is, a wave later. W's tests are on slabs
    with one crossing, where both definitions agree; M1 re-runs them.
29. **A cache refreshed slowly can hide a stale texel for longer.** At a
    field's own pace a wrong atlas block stays 96 s where it stayed 45
    frames. Freshness by generation (§4.7) is what makes a slow refresh safe,
    and its tests are on the caches themselves.
30. **Phase 0's reset figures are at an unknown lens** until its retaken rows
    exist. Nothing here is derived from them.

### 11.4 Not verified for this design

- **Nothing was built, run, tested or measured.** Every figure tagged **D** is
  hand arithmetic from constants in the code or the plan; every **E** is an
  estimate; every **M** is to be transcribed; every **W** was fetched by a
  critic and is quoted from its critique, to be checked at the source before
  it is cited.
- **Read in the code for this design:** `render/cloudNodes.ts:40-224`,
  `cloudMarch.ts:60-459, :505-516, :574-582`, `cloudTrace.ts:28-312`,
  `cloudLevers.ts:55-250`, `cloudFrame.ts:217-300, :556-628`,
  `cloudFarAtlas.ts:150-160, :690-772`, `cloudHistory.ts:352-411`,
  `cloudSunlight.ts:34-76`, `cloudUniforms.ts:89-104`,
  `cloudDensity.ts:219-228, :255-262`, `bodyUniforms.ts:428-438`;
  `packages/rendering/src/weatherScenario.ts:20-252, :436-460`,
  `mieTable.ts:13-50`, `atmosphere.ts:900-935, :1030-1075`;
  `packages/devtools/src/clouds.ts:100-130`; `.github/workflows/check.yml:17-31`;
  `scripts/gpuLock.mjs:86-96`; and the grep that finds no `requiredLimits` in
  `createRenderer.ts`, `capability.ts` or `gpuHarness.ts`.
- **Read for draft 4:** the settled rubric whole, and the two sets of rulings
  that shaped it; the landed campaign's summary
  (`design/plans/weather/phase0/measurements/landed-2026-11-10T09-05-32Z.md`)
  and the far comparison's document for its fields; phase 0's council, three
  reviews; the orchestrator's ledger for K's report and the thin form's
  decision; `render/cloudKnots.ts:1-125`; `render/cloudComposite.ts:396-500`
  and its `thin` select; `render/cloudFarAtlas.ts:60-150` and its jump key;
  and, from `weather/p1-cornerstones` by `git show`, K's cast list
  (`scripts/weather/descent.mjs`), its capture's rate check and its
  scenarios.
- **Not read for draft 4, and each is named where it binds:** K's code beyond
  those three; `cloudFrame.ts:420-448` and `:352-375`, which are quoted from
  phase 0's council; `hud/warp.ts`; `scene/Sensor.tsx:201-203`; whether the
  observatory can hold a station from above through a 11.4° lens; whether
  `CloudFarResult` carries the blocked air; what the first five frames spend;
  why the presentation rate moves; whether the retaken rows change any
  landed figure quoted here; ADR-0063 to ADR-0066 as committed, beyond the
  figures the measurements hold.
- **Read for draft 3,** at `25df44ab` with the landing's edits in the tree:
  the orchestrator's ledger for the decisions and the pacing finding, and
  the campaign's decision table by row; `render/cloudSunGrid.ts` whole;
  `cloudVolume.ts`'s header, its `medium`'s choice of level and its
  `#schedule`; `cloudSystem.ts`'s `budgetOf` and `run`; `cloudOverPass.ts`
  whole; `sceneLayout.ts:40-146` and `picture.ts`'s sample count;
  `seaReflection.ts:168-262`; `cloudFrame.ts:125-130, :467-472`;
  `cloudUniforms.ts:475-483`; the stances of `scripts/clouds/measure.mjs`;
  three's `WebGPUBackend.js:660-712, :826-975` at 0.185.1; phase 0's design
  at its refresh table (§3.12) and its GPU timeline (§4.2); the pipeline map
  §11.4 and §11.5.
- **Not read for draft 3, and each is named where it binds:** how the marked
  scene components hide what they mark, the flare first; what the composite
  writes to `motion`, `meterMask` and `reactive`, and who reads those; whether
  the optics read the scene's depth after pass B, and whether the entry
  trace's inks write it; where the pass timeline's hook stands; the bound's
  readers, which the cache gate implies are none; `scenarioCoverageNode`'s
  patterns; the cascades' reach; and the landing commit, which did not exist.
- **Surveyed read-only for draft 1, by search agents, and not re-opened:**
  the picture format, `presetUrl.ts`, `takePicture`, `settled()`, the plates'
  scripts and the planetarium's lists; `frameDiff.mjs`, the cast, the surface
  arm's verbs and cuts, the held time, the frames and the sun's direction; the
  runner's batches and the campaign's stages.
- **Taken from the two critiques and not re-opened,** beyond the lines above:
  every `path:line` in §4.9's second paragraph, §4.11's first table and
  §10.2's note on the landing; the survey sites; `scripts/check.mjs`; the fta
  scores; phase 0's landed sizes.
- **Taken from the two maps and not re-opened:** the line numbers in
  `cloudClipmap.ts`, `cloudMaps.ts`, `cloudComposite.ts`, `cloudFront.ts`,
  `cloudSunCascades.ts`, `cloudSunGrid.ts`, `cloudPhase.ts`, `cloudSystem.ts`,
  `sensor.ts`, `planet.ts`, `water.ts`, `air.ts` and the upscaler's files.
- **Not read at all:**
  - Baum's archive, by instruction; what is said of it is the README's, as the
    rulings quote it;
  - the ring's, the plumes' and the entry trace's material bodies, only where
    they are;
  - whether a preset's flight lens yields to `engine.requestLens` a frame at a
    time, for the zoom cast;
  - what limits CI's adapter offers beyond the specification's defaults;
  - `design/plans/weather/references.md`, beyond the six observations its
    author passed on;
  - `the-upscaler.md`, ADR-0033, ADR-0037, ADR-0044 and ADR-0056 beyond what
    the maps and the surveys quote.
- **The cornerstones' numbers are design values.** Each pose and each sun is
  checked by the package with `ir.light()` and the ledger test, and changed
  only through the orchestrator.

### 11.5 What phase 0's reviews leave to phase 1

Phase 0's code review and its council's first round (three seats, 7 of 10
each) asked for record fixes before its merge and left these to phase 1. Each
has a package and a test, or a reason it is not this phase's. F is the Fable
seat's numbering, W the Wonder Full seat's, A the Astra seat's, R the code
review's.

| #         | Finding                                                                                                                                                                     | Package | What phase 1 does                                                                                                             | The test that can fail                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| F5, W8    | Under the game's own warp, from 100×, every frame is a jump and takes the reset path; under any warp a sun past 0.05° a frame rebuilds the grid whole                       | H, L, Q | A jump is a step the clock's rate does not explain; no cache rebuilds on a turning sun; warp rows are recorded (§4.7)         | `cloudFrame.test.ts`: no jump at any rate of the dock's ladder. `cloudSunSchedule.test.ts`: no whole rebuild at 1,000×. C7's casts. The `warp` batch |
| F6        | A knot is one of the first four 250 m columns, so `cloudFront` is wrong through layered cloud and answers `T = 1` for cloud thin in every column                            | M1      | A knot is a level's crossing (§4.9)                                                                                           | `cloudFront.gpu.test.ts` on the real field: the gap between two layers, a thin layer, the ray's end                                                  |
| F7        | The step-start bias is 15% only near the eye: 52% at 8 km and 70% or more at the handover, in the far comparison's own reference                                            | M1, X   | The step's source is log-linear (§5.4); the far comparison is re-based once when it lands                                     | `cloudTrace.gpu.test.ts`: first order within 1% at step depths of 0.3, 1.16 and 2                                                                    |
| F8        | No always-on test holds: a compression other than 1 in the composite; the air's in-scatter term; a marked overlay through the real composite; a frame after `on` goes false | Y       | Four cases, before the composite gains a second form (§4.12)                                                                  | `cloudComposite.gpu.test.ts`, `cloudOverPass.gpu.test.ts`, `cloudSensor.gpu.test.ts`, each watched failing                                           |
| F8        | No test reads the drift, so its sign can be negated                                                                                                                         | H, I    | The history's expected displacement comes from the CPU field; C7 measures the drawn field's                                   | `cloudHistory.gpu.test.ts`; `drift.test.mjs` and the 100× cast                                                                                       |
| F8        | The grid's only gate is a uniform slab; its accuracy on a real field is opt-in                                                                                              | C, L    | The instrument's landed figures are bounds, and one case runs always (§6.3)                                                   | `cloudSunAccuracy.gpu.test.ts`                                                                                                                       |
| F8, W11   | The declared bytes sum each resource's own list, so a texture left off is unseen; the radiance meter's buffer and the composite's are outside the count                     | C, N    | The test wraps the device's `createTexture` and `createBuffer` (§6.2)                                                         | `cloudSystem.gpu.test.ts`                                                                                                                            |
| F8        | CI's adapter skips the tests that read the pass order                                                                                                                       | —       | **Not phase 1's.** It is the hosted adapter's limit. The orchestrator runs the suite on the mini after each merge (§10.3)     | —                                                                                                                                                    |
| F9, A     | The field is a function of the eye: the drift is built in the observer's tangent basis                                                                                      | D, H, F | The turn is the body's (§5.3)                                                                                                 | `weatherField.test.ts`, `cloudFrame.test.ts`, `cloudDensity.gpu.test.ts`: one point, two eyes                                                        |
| F10       | The far atlas filters the logarithm of a depth against a clear texel's zero, and reads less opacity than is there                                                           | X       | A clear texel holds the level's own mean depth (§5.9)                                                                         | `cloudFar.gpu.test.ts`: a deck's edge within 2% in opacity                                                                                           |
| F11       | The motion reset has no floor: level flight at a cloud's base never accumulates                                                                                             | H       | The `'motion'` reset goes (§5.10)                                                                                             | `cloudHistory.gpu.test.ts`: 120 frames 20 m under a base                                                                                             |
| F12       | The runner computes no rule's outcome; a hand-started run compares no build id; its Δ sits beside two unrelated medians; a second stop orphans Chrome with the lock         | Q       | `rules.mjs`; the build id compared on every run; the table's columns named; a second stop waits (§7.1)                        | `rules.test.mjs`, `measure.test.mjs`, `campaign.test.mjs`                                                                                            |
| F12, A    | A row counts as quiet with a null capture or an unsettled scene; a refused row counts as done                                                                               | —       | **Not phase 1's:** it is being fixed on phase 0's branch. Package Q keeps its tests green when it extends the runner          | Phase 0's own                                                                                                                                        |
| F13       | The sun gate's places are at latitude 86° to 89°, one each; its worst sample is unbounded; its samples are within 4 km of the eye                                           | L       | Five seeded places a scenario within 60° of the equator, to the window's edge, the worst held (§5.5)                          | `cloudSunAccuracy.gpu.test.ts`                                                                                                                       |
| F14       | The thin form's "from orbit" is one stance at a 4.4° sun, and its display-referred pair is uncontrolled                                                                     | N, Q    | No regime draws thin, so the evidence is not leaned on; the pair is held or dropped (§4.10)                                   | `measure.test.mjs`: the `error` rows say how the pair was exposed                                                                                    |
| F, note   | The grid's window ends in a hard select, a lighting seam about 25 km out                                                                                                    | L       | The weight's ramp from the eye (§5.5)                                                                                         | `cloudSunDepth.gpu.test.ts`: a line across the edge                                                                                                  |
| F, note   | After a jump the clipmap and the atlas rebuild from cube faces not yet rebaked and call themselves fresh                                                                    | F, X    | A cache is fresh only from a fresh source (§4.7)                                                                              | `cloudClipmap.gpu.test.ts`, `cloudFar.gpu.test.ts`                                                                                                   |
| W5, R1    | The landed defaults have no ladder; `LIGHT_TAP_COUNTS` and the `images` batch's stances are hard-coded                                                                      | C, Q    | The lever exports its values; the ladders read them and take their stances as a parameter (§7.3)                              | `cloudLevers.test.ts`; `measure.test.mjs`: a row for every value and for `earth-limb`                                                                |
| W7        | The three accuracy instruments assert only finiteness                                                                                                                       | C       | Phase 1's first test change (§6.3)                                                                                            | The three instruments                                                                                                                                |
| W7        | The warm-up test never draws a lever set with `served` or `second`                                                                                                          | C, N    | Two lever sets more                                                                                                           | `cloudWarm.gpu.test.ts`                                                                                                                              |
| W3        | The atlas is unscored at 800 m; its errors are normalized by each case's own mean light; its reference takes 1,051 steps where the shipped march takes 192                  | X       | The score first; relative errors by bin; the shipped march beside the long one (§5.9)                                         | `cloudFarCompare.gpu.test.ts`, `cloudHandover.gpu.test.ts`                                                                                           |
| W9        | A second clouded body always draws through the thin form, in a regime never measured                                                                                        | N, Q    | The identity; the `pair` stances in the `error` batch (§4.10)                                                                 | `cloudSecondBody.gpu.test.ts`; row 20's batch                                                                                                        |
| W10       | The trace binds 12 of 16 sampled and all 4 storage textures; the atlas bakes a block a frame whatever the budget, at 0.80 to 1.59 ms                                        | C, X    | 14 at worst and no fifth output (§4.5); the atlas at its field's pace, and `farBlocks` after an event (§4.7)                  | `cloudTrace.gpu.test.ts`'s census; the `reset` sequences                                                                                             |
| W11       | A generator's header carries its runtime and machine, so regenerating an identical table changes the file                                                                   | T1      | Headers carry nothing that differs between runs (§10.1)                                                                       | `mieTable.test.ts`: the committed header holds no runtime, machine or version                                                                        |
| W11       | `summarize` parses a batch document unguarded; a resume resets every stage's attempts                                                                                       | Q       | The guard `progress` already has; attempts kept across a resume                                                               | `campaign.test.mjs`                                                                                                                                  |
| W6        | Every figure is the M6 mini's, and the plan's basis was an M5                                                                                                               | —       | **Not phase 1's.** The rubric puts hardware below the mini outside the claim and records one M5 row at the verdict (§8 there) | —                                                                                                                                                    |
| F2        | The landed `cut`, `scrub`, `fly` and `pair-neighbor` rows ran through another stance's lens                                                                                 | Q       | A stance owns its lens (§7.2). The retake is phase 0's                                                                        | `measure.test.mjs`: a `rise` stance, then another                                                                                                    |
| F1, W1, A | Placement A stands by an exception, and one cell fires the rule as written                                                                                                  | Y, Q    | The cell at one rate, and the rule that sends A back (§7.4)                                                                   | The `over` batch                                                                                                                                     |
| F15, W2   | Cold compile was never measured: the `warming the clouds` span is empty in all six boots                                                                                    | N       | Why it is empty, first; then what the first frames spend (§4.7)                                                               | The `memory` batch reads a span that is there                                                                                                        |

---

## Critique log

Two adversarial reviews of draft 1: **P**, the physics, the references, the
tests and the decision rules (4 blockers, 16 majors, 11 minors); **E**, the
interfaces, the packages, the schedule and the delivery (2 blockers, 17
majors, 13 minors). Each finding was checked against the code, the plan or a
computation. Of 63, 60 are accepted and 3 in part (P12, E13, E21); none is
declined. **R** is the six observations of the delegate that gathered the
reference photographs.

The log is draft 2's, and its section numbers are of that draft. Where a row
cites §11.2, that section then held proposals to the rubric, which the
settled rubric took; §11.2 now lists where the design departs from it. Where
a row's change has since moved, **What draft 3 and draft 4 changed** says
how: the slab's gate (P-rows on the scaling) is against the scaled medium
now, and the thin form and the placement are decided.

### The physics

| #   | Severity      | Finding                                                                                    | Verdict          | Reason, and what changed                                                                                                                                                                                                                                                                                             |
| --- | ------------- | ------------------------------------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Blocker       | The march takes its source at a step's start: first order 15% to 86% high on a slab        | Accepted         | `cloudMarch.ts:423-429, :509-515` and the ratio redone. A step's source is log-linear between its ends (§5.4), by package M1; a test holds 1% at `μ/μ₀` to 5. It is phase 0's defect; §5.4 says how its figures read: costs, ladders and the sun's instrument stand, and the far field's radiance error is a ranking |
| P2  | Blocker       | The budget's floor makes uniform steps from the eye                                        | Accepted         | The floor is geometric, an even share in the logarithm of distance (§5.8), the critic's first form                                                                                                                                                                                                                   |
| P3  | Blocker       | The far march reads its higher orders and sky at the layer's middle                        | Accepted         | Both are read at the depth the step's opacity centers on, by the side the ray enters (§5.9 change 2)                                                                                                                                                                                                                 |
| P4  | Blocker       | "Fluxes within 2%" is undefined for a march, and the transmitted one fails by construction | Accepted         | The reflected flux alone is gated, by a stated quadrature; the double count's size is declared (§5.1, §5.11); the rubric's line is proposed (§11.2)                                                                                                                                                                  |
| P5  | Major         | "The scaled problem" is three truncations, and the table is indexed by the wrong one       | Accepted         | The medium is a phase function, `p′`, and the oracle solves it and the true one as two problems (§5.1, §5.11)                                                                                                                                                                                                        |
| P6  | Major         | Gate 1's grid sits on the rings, names no radius, and judges a fit in sample               | Accepted         | The scattering angle is listed and the rings left to their test; three radius rows; eight held-out pairs; figures recorded under `τ = 5` (§5.11, §7.4)                                                                                                                                                               |
| P7  | Major         | The slab table: linear depth, two moments, no azimuth, no phase axis                       | Accepted         | Transport depth from each face on a logarithm; a third term, a lobe about the sun; the reconstruction through the table's own read at every azimuth (§5.5). The lobe goes past the critic's change, because two moments about the normal cannot hold a rim                                                           |
| P8  | Major         | The gates run on a sun's depth the product does not have                                   | Accepted         | Each gate runs with an exact sun and with the shipped one, both recorded; the taps are spaced in optical depth (§5.4, §7.4)                                                                                                                                                                                          |
| P9  | Major         | A source narrower than the blur takes the scaled transmittance                             | Accepted         | `T′^(1/(1 − f_δ))` for the disk, a star and the flare; in phase 1 the composite splits sky pixels (§5.1), by package N; phase 2's `cloudSunlight` has two forms (§0.4)                                                                                                                                               |
| P10 | Major         | The ice stand-in is not self-consistent                                                    | Accepted         | Moot by ruling 5: Baum's table, which holds its own diffraction peak, replaces the stand-in (§5.4)                                                                                                                                                                                                                   |
| P11 | Major         | The calibration can pass on a field that looks wrong                                       | Accepted         | 5 km pixels on a fixed lattice; detection in reflectance; a minimum detected share; the genus's extinction held and the regime's thickness solved; fog's row dropped (§5.2)                                                                                                                                          |
| P12 | Major         | The fine march does not mix once a cell                                                    | Accepted in part | The finding stands (`cloudMarch.ts:465`, `cloudDensity.ts:255-261`). The fix is not `column` as the smaller of texel and cell, which leaves a staircase against a smooth form, 19% apart at one cell's run: both marches take one law for a crossing (§5.9 change 1). The critic's test at three footprints is kept  |
| P13 | Major         | Mixing by cells: the form is not the field's, and the done-when has no radiance            | Accepted         | `√(1 + (ℓ/c)²)`, with `c` fitted by a sight count on the CPU field; `cloudFarCompare` by pitch bin, on transmittance and light (§5.9, item 10)                                                                                                                                                                       |
| P14 | Major         | Gate 2: no source for its curves, no absolute check, an undefined sign and error           | Accepted         | The CPU tier renders the curves' own 288 pixels; an absolute check on core and base; the curve error defined; a rule where there is no sign; the missing clause; the probe test as a count (§5.11, §7.4)                                                                                                             |
| P15 | Major         | The sky's dipole is weighted by the wrong moment                                           | Accepted         | The table stores the two sides' irradiance difference; the term gains the flux's view term and the sunward one, and reads the sample's own column (§5.6)                                                                                                                                                             |
| P16 | Major         | The band's and the clip's rules cannot be decided as written                               | Accepted         | The band on 64-frame means with a fallback; the clip on a bias; the three cases named; the octave count's edge (§7.4)                                                                                                                                                                                                |
| P17 | Major         | The Monte Carlo's long rows check themselves                                               | Accepted         | Backward with next-event estimation; every row held to adding-doubling at `3·SE + 0.5%`; batch means; a time bound (§5.11)                                                                                                                                                                                           |
| P18 | Major         | Thresholds in optical depth do not survive the scaling                                     | Accepted         | §4.11's last table; the far bake's cut and code stay unscaled                                                                                                                                                                                                                                                        |
| P19 | Major         | Under the grid, "the ray's whole" is not what the bake sums                                | Accepted         | Read from a second cell, one fetch a step; no format change (§5.5, §2.5)                                                                                                                                                                                                                                             |
| P20 | Major         | The mask is read in a way that discards its time axis                                      | Accepted         | The slice is the pixel's own sample count, with no shift (§5.10)                                                                                                                                                                                                                                                     |
| P21 | Minor         | The axial drift changes a shape only away from the equator                                 | Accepted         | Declared, with the arithmetic corrected (§5.3); a turning drift vector is not exact under the float64 reduction, so it is not taken                                                                                                                                                                                  |
| P22 | Minor         | A refresh at one texel of travel is a one-texel jump                                       | Accepted         | A tenth of a texel (§5.3)                                                                                                                                                                                                                                                                                            |
| P23 | Minor         | van de Hulst's tables are not at 0.85                                                      | Accepted         | 0.75 and 0.875 (§5.11)                                                                                                                                                                                                                                                                                               |
| P24 | Minor         | The power law's estimator and fallback                                                     | Accepted         | Maximum likelihood on `n(D)`; the fallback as octaves at a gain of 0.57 (§5.2)                                                                                                                                                                                                                                       |
| P25 | Minor         | The furnace is an identity held at 2%                                                      | Accepted         | Its three conditions stated; 10⁻³ (§5.11)                                                                                                                                                                                                                                                                            |
| P26 | Minor         | The glory's test pins where, not how bright                                                | Accepted         | Tested at a row's own radius; the ring's peak over its trough; the contrast declared (§5.1, §6.2, §8.3)                                                                                                                                                                                                              |
| P27 | Minor         | The dark edge is judged on gate 2 alone                                                    | Accepted         | Kept only if gate 1 passes again (§5.7, §7.4)                                                                                                                                                                                                                                                                        |
| P28 | Minor         | Phase 2's balance names two scalings                                                       | Accepted         | The diffuse part is the two-stream total less the renderer's own beam (§0.4)                                                                                                                                                                                                                                         |
| P29 | Minor         | The higher orders' inputs change at the cache's edge                                       | Accepted         | Blended over the last two texels; declared from orbit (§5.5)                                                                                                                                                                                                                                                         |
| P30 | Minor         | Small terms that spend the 5%                                                              | Accepted         | The gain rides in the atlas at the sample's radius; the cone by row; the oracle's first order on the series (§4.4, §5.11)                                                                                                                                                                                            |
| P31 | Minor         | Seven figures tagged D that do not hold                                                    | Accepted         | Each corrected where it stood: E1's shadow, the drift, the cone, the cells a far step holds, the grid, the octaves' ceiling                                                                                                                                                                                          |
| —   | Open question | What sets how far a pilot sees inside a cumulus                                            | Answered         | §5.1 declares it, §8.5 measures it, §11.2 gives the rubric's sentence                                                                                                                                                                                                                                                |

### The engineering

| #   | Severity | Finding                                                                                       | Verdict          | Reason, and what changed                                                                                                                                                                                                 |
| --- | -------- | --------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1  | Blocker  | The contracts change live interfaces whose consumers they do not own                          | Accepted         | §4.11: an authority for mechanical propagation, factories, and bridges with the package that removes each                                                                                                                |
| E2  | Blocker  | G5 and G6 cannot be taken before the work they judge; two rules need casts after the decision | Accepted         | The path scripts and the cast arm are K's; a casts' stage in `choices`; a trail is a number (§3.6, §7.2, §8.1). The trail measure blurs before it differences, or it would read the history's own convergence as a trail |
| E3  | Major    | Wave 0 against phase 0's campaigns and landing                                                | Accepted         | The critic's evidence holds and the ruling's premise does not. §10.3 orders it; wave 1's base is the landing, K and V                                                                                                    |
| E4  | Major    | W cannot be built inside its ownership                                                        | Accepted         | The engine's handle, landed by C; materials byte for byte without one (§4.9)                                                                                                                                             |
| E5  | Major    | G1, G3 and G5 stand on the open sea                                                           | Accepted         | A land stance by rule, held by the ledger test (§3.3)                                                                                                                                                                    |
| E6  | Major    | The pull requests                                                                             | Accepted         | Two, stacked; the second a draft from C's merge; ADR-0067 and its docs in the first (§10.5, §9)                                                                                                                          |
| E7  | Major    | The baseline lives in one worktree's `.data/`                                                 | Accepted         | The clone's common directory; hashes; plates uploaded (§3.6)                                                                                                                                                             |
| E8  | Major    | Ten gates at once on twelve cores                                                             | Accepted         | `IR_CHECK_JOBS=4`, five in flight, granted CPU windows, a 300 s wait (§10.1)                                                                                                                                             |
| E9  | Major    | N carries the integration and the runner                                                      | Accepted         | Package Q (§10.2)                                                                                                                                                                                                        |
| E10 | Major    | The step from a `BodyWeather` to a frame is nobody's; six shapes are missing                  | Accepted         | `FieldClock`, `CloudLevelFrame` and the derivation's owner (§4.11); each lever's uniform (§4.6); the stand-ins' parameters                                                                                               |
| E11 | Major    | Sizes are half of what phase 0 measured; M is the critical path                               | Accepted         | §10.6, at 1.9 times; M is M1 and M2                                                                                                                                                                                      |
| E12 | Major    | The slab reference lacks what the calibration reads                                           | Accepted         | The black-surface flux at 0.7 and 0.4 (§5.11)                                                                                                                                                                            |
| E13 | Major    | A generated reference can go stale in silence                                                 | Accepted in part | The reference carries 1,000 of the fixture's voxels and the genus table's hash, and a test compares them. The fixture is not committed: 2.5 million voxels are megabytes of text for what the field regenerates (§5.11)  |
| E14 | Major    | The ISCCP artifact has no form, size or home                                                  | Accepted         | Phase 1 commits the small zonal table its two readers need; the gridded artifact is phase 3's design (§4.1)                                                                                                              |
| E15 | Major    | Ownership gaps, and one file owned twice                                                      | Accepted         | `cloudFarFurnace` for X; `cloudVolume.ts` is F's; T2's reach through one table-set object and a constant albedo; E3's weather and the record are N's; the ledger's script is K's (§10.2)                                 |
| E16 | Major    | Two of K's files are near the fta cap                                                         | Accepted         | `solarTime.ts` and `pictureWeather.ts` hold the bodies (§10.2)                                                                                                                                                           |
| E17 | Major    | Three rubric rows have no check, one no stance                                                | Accepted         | `--twice` is two boots; `--cut`; `earth-orbit-long`; the opacity in the log (§3.6, §7.2, §8.5)                                                                                                                           |
| E18 | Major    | "On by default" is a flag in the code                                                         | Accepted         | The flag's retirement and its cost are phase 2's (§0.4); phase 1 records the boot's span (§7.2)                                                                                                                          |
| E19 | Major    | The schedule holds the machine about eight hours                                              | Accepted         | §10.3's table; phase 2's wave 0 waits                                                                                                                                                                                    |
| E20 | Minor    | The stubs need an importer                                                                    | Accepted         | `cloudContracts.test.ts`, shapes only                                                                                                                                                                                    |
| E21 | Minor    | Five trace variants, not three                                                                | Accepted in part | Three: `bins` holds four phases a level and fetches by a uniform, so one kernel serves every count (§4.6)                                                                                                                |
| E22 | Minor    | Two sections assume an outcome untagged                                                       | Accepted         | §4.3 and §4.5 tagged, and the index                                                                                                                                                                                      |
| E23 | Minor    | `findPicture` is in `pictures.ts:99`                                                          | Accepted         | §3.2                                                                                                                                                                                                                     |
| E24 | Minor    | A picture's weather is never released                                                         | Accepted         | Released on leaving the picture (§3.1)                                                                                                                                                                                   |
| E25 | Minor    | A regime's id is in a committed format                                                        | Accepted         | Stable, and an unknown one is reported (§3.3, ADR-0067)                                                                                                                                                                  |
| E26 | Minor    | The record lacks the references' hash                                                         | Accepted         | §3.6                                                                                                                                                                                                                     |
| E27 | Minor    | The zoom's verb is unverified                                                                 | Accepted         | K's first check, with a fallback (§8.2)                                                                                                                                                                                  |
| E28 | Minor    | The surface verbs do nothing without a stance                                                 | Accepted         | `startPath` refuses (§3.6)                                                                                                                                                                                               |
| E29 | Minor    | R1's slow rows have no time bound                                                             | Accepted         | 60 s, recorded (§5.11)                                                                                                                                                                                                   |
| E30 | Minor    | What is green between wave 2 and N                                                            | Accepted         | The gate and four system tests at every merge (§4.11)                                                                                                                                                                    |
| E31 | Minor    | The sheets need ffmpeg and ImageMagick                                                        | Accepted         | `sheet.mjs` refuses without them (§3.6)                                                                                                                                                                                  |
| E32 | Minor    | A picture with no weather turns the clouds off                                                | Accepted         | The harness guide says so (§9.4)                                                                                                                                                                                         |

### The references

| #   | Observation                                                                              | What changed                                                                                        |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| R1  | E1's field matches about 120 mm on the station's cameras                                 | The lens stands; said in §3.3                                                                       |
| R2  | Real limb photographs are at 240–460 mm, and shadows on the air show near the terminator | E2's lens goes to the 11.4° floor, its sun to −21°, and the panel's brief carries the caveat (§3.3) |
| R3  | From 2 m on flat ground, cloud shadows barely show                                       | G1 stands 40 m up, on land (§3.3, §11.2)                                                            |
| R4  | At −2° a layer at 4 km is close to losing direct light                                   | G3's sun is −1.5°, with a margin the ledger test holds (§3.3)                                       |
| R5  | Every real glory surrounds its aircraft's shadow                                         | None is drawn; the brief says so (§3.3)                                                             |
| R6  | G5 is short of references                                                                | Its judgment leans on the cast and the range (§3.3, §11.2)                                          |

---

## What draft 3 and draft 4 changed

The critique log above is draft 2's. This is the record of the two rounds
since, so a reader of the tree's copy can tell what moved and why.

### Draft 3: phase 0's choices

Draft 3 resolved every section that waited on placement, the far field, the
cache with the sun's depth, and the ladders, and added two packages, L and Y.

| Section | Kept                                                                                       | Deleted                                                                     |
| ------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| §2.5    | The field with the grid, with the volume cut to what the grid reads                        | "−15.4 MB under any outcome"                                                |
| §4.3    | Five reads a step; the volume as the grid's source through its injected field              | The volume as the march's medium                                            |
| §4.5    | 12 bindings before this phase's choices and 14 at worst; the second body's own atlas       | The volume's column, 14 to 16; the spheres for a second body                |
| §4.7    | The frame node in pass B, or from the chain's term; the grid's refresh                     | The split's branch; a `'field'` reset that rebuilds everything in its frame |
| §4.9    | The three objects on the over-clouds layer, in pass B's list                               | The orders package W would have set under B                                 |
| §4.12   | New: the over pass, the two forms, C reconsidered                                          | —                                                                           |
| §5.3    | The turn as three matrices; no new cadence in the sun's depth                              | The volume's refresh by a tenth of a texel                                  |
| §5.5    | The grid's two reads, the statistics that stand in, the weight, the bake under the horizon | The cascades' four loads; a blend over "the cache's last two texels"        |
| §5.8    | 192 steps, four taps, 800 m, and where 800 m puts the band                                 | "Whatever the ladders give"                                                 |
| §5.9    | `ℓ` as a slab step's run; the sun's side by one function                                   | The spheres' slant run                                                      |
| §7.3    | The three ladders with their values, two more taps and a third stance                      | The clause for ladders that name no value                                   |
| §10.4   | Fixed lists                                                                                | The table by outcome                                                        |

What the decisions exposed that neither critic of draft 1 had seen: the grid
rebuilt whole on every 0.05° of sun; G3 as a gray deck under a layer held over
the whole body; no sun's depth past the taps from orbit or past the grid's
window; an unwhole grid reading as no cloud; the handover's band out of most
frames at 800 m; and casts, the detector and the trail measure counted in
frames.

### Draft 4: the settled rubric, the thin form, phase 0 as landed and reviewed

| What came in                                                                           | What changed                                                                                                                                                                                                   | Where                         |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| The rubric's rows 1 to 3                                                               | The march is held to the oracle on its own scaled medium. The scaled medium against the true one is the oracle's figure, declared at 3%, and does not stop M2                                                  | §2.1, §5.11, §7.4             |
| The rubric's rows 4 to 11, 17 to 21                                                    | Each done-when takes the row's tolerance. The handover's bound is fixed at 10% and 15%. The range is held in a uniform medium                                                                                  | §2.1, §6.2, §8.5              |
| The panel's tools as a phase 1 package, and the calibration round                      | Package J; the noise floor; who freezes the anchors; when the round runs                                                                                                                                       | §8.6, §10                     |
| The continuity checks, C1 to C11                                                       | Package U: the casts K's six do not hold, settled stills, the frames after a cut. The classification of a flagged step, the two controls, the field's displacement                                             | §3.8, §8.1, §8.2              |
| The budget's bars, B1 to B15                                                           | A plan by bar and by term; the reset as B7's sequence over 60 frames; a cache refreshed at its field's pace; the first frames; the whole frame's percentile; the 60 Hz hold                                    | §2.6, §4.7, §7.2, §7.5        |
| Provenance, and comparators with roles                                                 | The levers resolve by size and hash; the capture's record carries the hash and a role                                                                                                                          | §3.8, §4.6                    |
| The overlay guard                                                                      | A tenth preset, the station under E1's lens                                                                                                                                                                    | §3.8                          |
| The thin form: from orbit only                                                         | The identity draws everything, the second body included. `[depends: thin]` is resolved                                                                                                                         | §4.10, §7.2                   |
| Phase 0 as landed: 7.12, 5.67, 5.07 and 3.03 ms; 91.62 MB; first frames of 51 to 67 ms | The record at the top; the memory totals, 71.37 MB against B12's 80                                                                                                                                            | The record, §2.5, §2.6        |
| Placement A as an exception                                                            | What sends it back, and what going back costs                                                                                                                                                                  | §4.12, §7.4                   |
| Phase 0's review and council                                                           | The warp as no jump; knots as a level's crossing; the step's bias by distance; the field from two eyes; the atlas's clear texels; freshness by generation; the instruments pinned; the runner's rules computed | §11.5, and each section named |
| Wave 0 as built                                                                        | The world, its stances, the pitch, K's casts and its rate check                                                                                                                                                | §3                            |
| The lens the landed campaign's forced rows were taken through                          | A stance owns its lens; the landed reset figures are leaned on nowhere                                                                                                                                         | §7.2                          |

**Which packages changed in draft 4.**

| Package | Change                                                                                                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K, V    | Built. K's capture files pass to U                                                                                                                                                     |
| C       | The levers' resolution and hash, `CLOUD_LIGHT_TAPS`, `farBlocks`, the clock's rate in the frame's inputs, `'climate'`, C11; the three instruments pinned; the bytes held to the device |
| D       | The two-eyes property                                                                                                                                                                  |
| H       | The jump test against the clock's rate; the field's derivation with no observer's basis; the history's oracle from the CPU field; level flight at a base                               |
| L       | The pace every cache is refreshed at; the instrument's population and reach; the window's seam; the first frame as a reset                                                             |
| Y       | The composite's four unheld cases; B11                                                                                                                                                 |
| Q       | A lens a stance; the rate, the lens and the hash in every row; `frame`, `warp`, `pace`; each rule's outcome; the build id; the pacing study and the hold                               |
| I       | The classification, the field's displacement, the frames after a cut; a gap is never divided away                                                                                      |
| T1      | The Mie generator's header                                                                                                                                                             |
| E       | On the second path now: package G waits on its table                                                                                                                                   |
| F       | The cube's and the clipmap's pace and freshness; two eyes on the GPU                                                                                                                   |
| M1      | The knots as a level's crossing; a tap's three reads; the range readout and its fixture; the step's test at three depths                                                               |
| X       | The atlas's score at 800 m first; the clear texel's depth; the instrument's reference and relative errors; `cloudHandover` with row 11's bounds; the atlas's pace and freshness        |
| G       | Its base gains E                                                                                                                                                                       |
| N       | The second body's identity; the first frames and the empty span; the three parts of "whole" in the report; the register                                                                |
| **J**   | New, beside C, Opus 5.5: the panel's tools                                                                                                                                             |
| **U**   | New, beside C, Opus 5.5: the capture's second pass                                                                                                                                     |

Twenty-five packages. 30,500 lines by this design's count and 58,000 at phase
0's ratio, of which wave 0's are built. About 14.5 hours of the machine held
whole, in four windows.

**What draft 4 found that no review had.**

1. **The zoom cast crosses nothing at G4's pose.** The farthest cloud in
   frame is 34 km off and the band begins 172 km out. C1 and C2 need another
   pose (§5.8, §11.2).
2. **C6's 2 km fails by geometry.** The range ahead of a cloud is the
   distance to it, and K's G5 path is 1.5 km long (§8.5, §11.2).
3. **The landed caches refresh far faster than their fields move:** the cube
   every six frames where its texel takes 13 minutes to cross, the atlas every
   45 frames at 0.8 to 1.6 ms a block. Most of the steady frame's bakes are
   that (§4.7).
4. **B7's event frame is spent by the immediate regime alone,** 3.5 of its
   4 ms on `horizon` as landed, so the trace's cost decides it (§4.7).
5. **A tap is a whole medium,** five reads, and two of them cannot change
   over a tap's reach (§5.4).
6. **The thin form is the identity's own fragment with one term zeroed,** so
   the allowance from orbit buys no cost (§4.10).
7. **The cornerstones' world has a 10 hour day,** so the landed grid's whole
   rebuild comes every 5 s there (§3.3).
8. **K's capture refuses a cast the rubric would keep,** until the hold
   exists (§3.6).
