# The weather: where the work stands

The working notes behind [the weather plan](../the-weather.md), and the guide
to picking it up. The plan says what the weather is for. This directory says
how far it has got, what each phase handed the next, and where the evidence
is.

**Phase 0, feasibility, has landed.** Every cloud pass is built in its final
place behind `?clouds=1`, drawing a placeholder field. Its four choices are
made and recorded, the losing alternatives are deleted, and the plan cites the
records. Phases 1 to 6 have not started.

Nothing draws on `main`. Without the flag the cloud chunk is never loaded, and
with it nothing draws until `engine.clouds.on` is set.

## The branch

The weather lands on one integration branch, **`the-weather`**, cut from `main`
at `fb5aa5f5`. Each phase is a pull request into it, the phases are merged
forward and never rebased, and `the-weather` merges to `main` when the weather
ships.

| Pull request | Branch                       | Holds                                                     | State                                     |
| ------------ | ---------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| #206         | `weather/phase-0`            | Phase 0: the passes, the measurement, the four records    | Open                                      |
| #199–#204    | `weather/p0-1-…` to `p0-6-…` | The same work as six stacked pull requests against `main` | Superseded by #206; closed once it merges |

## What phase 0 decided

Each choice was built in every candidate, measured on the Mac mini (Mac18,5,
Apple M6, 32 GB) at 1920×1080 and 2880×1800, and read against a rule fixed in
[the design](phase0/design.md) §8.7 before any figure existed. Not every
choice follows its rule as written, and the ADRs say where:

- **The placement is an argued exception.** Its CPU clause, as fixed, fires
  at Retina inside a cloud in all three samples and on `horizon` at 1080p in
  campaign 1's, and A stands on the figures ADR-0063 gives, provisional on
  the CPU evidence.
- **The sun's depth fell to the rule's fallback,** which keeps "the more
  accurate" without naming the aggregate. By the worst case's RMS at two taps
  it is the grid; case by case the cascades are ahead in five cells.
- **The far field is decided at 400 m and provisional at the default.** No
  comparison of the two candidates exists at 800 m.
- **`lightTaps` is unset by its rule,** and 4 ships.

| Choice                       | Decided                                                                                               | Against                                                                                      | Record                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Where the composite stands   | Two scene passes, one under the clouds and one over them; an exception to the CPU clause, provisional | A hand-rolled split of the scene pass, no cheaper in any cell                                | [ADR-0063](../../../docs/adr/0063-the-weather-draws-between-a-scene-pass-under-the-clouds-and-one-over-them.md)           |
| What the march reads         | The field itself                                                                                      | A baked local volume, 6.3–6.9% from the field's picture on a broken-cloud horizon against 3% | [ADR-0064](../../../docs/adr/0064-the-clouds-march-the-field-and-the-suns-depth-is-a-grid-summed-through-the-volume.md)   |
| The sun's optical depth      | A grid round the eye, summed through the volume                                                       | Sun-space cascades, 0.49 RMS under cirrus over cumulus at a 5° sun                           | ADR-0064                                                                                                                  |
| The far field                | A three-layer cube-sphere atlas                                                                       | Spheres at the layers' heights; the volume's coarse levels, excluded by their memory         | ADR-0064                                                                                                                  |
| The quality ladders          | `maxSteps` 192 and `farFootprint` 800 m by the rule; `lightTaps` 4 ships, unset by it                 | —                                                                                            | ADR-0064                                                                                                                  |
| Where the thin form may draw | From orbit, and nowhere else                                                                          | The identity, which stays the default everywhere, orbit included                             | ADR-0063                                                                                                                  |
| The scene unit               | `SCENE_UNIT_LUMINANCE`, the sun above the air; the sensor's white is half a stop under it             | Moving the white, which moves every plate                                                    | [ADR-0065](../../../docs/adr/0065-a-scene-unit-is-the-sun-above-the-air-and-the-sensors-white-is-half-a-stop-under-it.md) |
| The droplets' phase function | Lorenz–Mie at one narrow width, generated offline                                                     | A fitted phase function, which draws no glory                                                | [ADR-0066](../../../docs/adr/0066-the-droplets-phase-is-lorenz-mie-at-one-narrow-width-generated-offline.md)              |

An object drawn over the clouds has to be marked for the second pass. That is
rule 69 in [`AGENTS.md`](../../../AGENTS.md).

## What it cost

The clouds are over the plan's budget at both sizes, and the ADRs have every
row with its conditions. In short, against clouds off:

| Frame                             | Plan's target, 1080p | 1080p    | Retina   |
| --------------------------------- | -------------------- | -------- | -------- |
| On the ground, under cumulus      | ≤ 2.9 ms             | 7.12 ms  | 8.91 ms  |
| From orbit                        | ≤ 1.6 ms             | 3.03 ms  | 5.54 ms  |
| A reset frame, a cut of `horizon` | —                    | 20.61 ms | 21.78 ms |
| Declared memory                   | about 76 MB          | 91.62 MB | 85.01 MB |

At Retina the largest single cost is the second scene pass, 3.88 to 5.32 ms
on the steady rows. At 1080p it is 1.52 to 2.19, and the trace, at four light
taps, is the larger on `ground`, `horizon`, `decks` and both pairs, up to
4.75 ms. The first frames with the clouds on are a hitch: the largest of the
first five is 50.80 to 66.80 ms at 1080p and 75.00 to 92.50 at Retina, the
caches' first build, not shown to be a compile. Every figure is campaign 2's,
at `bbea04da`.

## What phase 1 inherits

Phase 0 was built to find these. Each is recorded where it was measured, and
none is fixed.

**In the march and its light**

- **A step's light source is taken at the step's start,** which biases
  first-order light high by `2/(1+e^−τ) − 1` a step on a uniform slab at equal
  sun and view angles. That is 15% only near the eye, where a step holds τ at
  0.3; past the step's floor τ grows with distance, to +52% at 8 km and +70%
  or more at the far comparison's 55 km handover. Every radiance figure of
  phase 0 is against a march with that bias.
- **The sun's depth misses its 3% in most cases,** two decks under a high sun
  by 0.097 at four taps, and single samples reach a full-scale error of 1.00
  there. The gate scored one place a scenario, four of five at latitude 86 to
  89°, within 4 km of the eye. Outside the grid's 25.6 km window, which from orbit
  is everywhere, a sample is lit as though nothing stood past its first
  kilometer.
- **The ladders are not closed.** The landed set's own ladder, at
  `51c96da4`, holds `maxSteps` 192 and `farFootprint` 800 (set by Retina), and
  leaves `lightTaps` unset: two against four is 1.03% and 1.13% on `horizon`,
  and `cloudLevers.ts` has no rung above four. No ladder has an orbit stance,
  and the landed orbit still shows almost none of the cloud texture the
  campaign's showed.
- **The light is first order through the droplets' table and a placeholder
  sky term, on an uncalibrated density.** No image from phase 0 says how a
  cloud looks. The table is unconvolved, and ice and rain read the droplets'.

**In the frame**

- **The second scene pass** costs 1.52 to 2.19 ms at 1080p and 3.88 to 5.32
  at Retina, and a break with nothing drawn in it 1.0 and 2.4. Riding the sea's
  own split is reconsidered in phase 1 by the rule that priced it.
- **The placement is provisional on its CPU evidence.** At Retina inside a
  cloud A's `sensor` span is 1.51 to 4.64 ms over B's in all three samples,
  taken at two presentation rates, and the rule as fixed fires there. Phase 1
  takes that cell again at one rate; both placements exist at commit
  `25df44ab`.
- **A reset frame rebuilds the sun's grid whole,** 9.1 to 16.8 ms of a cut
  for the grid alone, and so does a sun that turns 0.05°. The first frames
  with the clouds on pay a whole build too, and the reset plan has to cover
  them.
- **The far atlas bakes a block every frame at 0.80 to 1.59 ms,** against 0.1.

**In the far field**

- **It lets through more light than the fine march:** half again over broken
  cumulus and nearly ten times on a grazing ray at sunset. It is not shown
  better than the spheres at 800 m: the atlas alone is scored there, and the
  spheres led at 1,600 m in all four cases. Its radiance errors are each
  relative to their own case's light, and its reference marches up to 1,051
  steps where production takes 192.
- **The handover is a switch.** The cross-fade by footprint, with hysteresis,
  is not built.

**Limits of the landed code, declared and not fixed here**

- **Under the game's own time warp every frame is a reset.** A frame whose
  world step exceeds its own by over a second is a jump, so at 60 Hz every
  frame from 100× up (from 1,000× at 120 Hz) takes the immediate regime and a
  whole grid rebuild, 9.1 to 16.8 ms of grid alone; and a sun that turns
  more than 0.05° a frame rebuilds the grid whole every frame, which on
  Earth's day is from about 720×. The `warp` lever measures another path, and
  no warp row was recorded.
- **The knots mean the first four clipmap columns on the real field.** A
  segment closes at every 250 m texel of horizontal run, and the fourth knot
  takes the rest, so through layered cloud `cloudFront` puts an object in a
  clear gap behind a depth-proportional share of the cloud past it, and for
  cloud thin in each column it records no knot and answers T = 1. The
  done-when for the transparent object is held on analytic slabs alone.
- **The field depends on the eye.** The wind is built in the observer's
  tangent basis (`cloudFrame.ts`) and the drift from it, up to 3,600 s of it,
  so moving the eye turns the whole lattice, and the history's
  `wind × frameSeconds` does not follow that.
- **The far atlas filters log τ against clear texels' zero.** A bilinear read
  beside a clear texel gives `(1+τ)^w − 1`: τ 8 at half weight reads 2, an
  opacity of 0.43 against 0.50. It is one cause of the far field's excess
  light, and fixing it changes the atlas's format.
- **The motion reset has no floor near a layer's boundary.** The reset
  compares the eye's travel with its clearance to the nearest shell, so
  within ten frames' travel of a base or a top, 42 m at 250 m/s and 60 Hz, every frame
  is immediate and the history never accumulates.
- **The grid's window ends in a hard edge about 25 km out.** Outside its
  trusted rectangle `opticalDepth` answers zero, a lighting seam where the
  grid gives way to the taps alone.
- **After a jump the clipmap and the atlas rebuild from cube faces not yet
  rebaked,** and mark themselves fresh, inside the runner's settle window.
- **What no always-on test gates:** compression other than 1 in the
  composite (`cloudComposite.gpu.test.ts` sets 1 in every case), the air's
  in-scatter term in the composite, the drift's sign (the history's oracle is
  built from the wind), the grid on a real field (its gate is a uniform
  slab), and a texture left off a resource's declared-bytes list (the census
  sums each resource's own list). The three accuracy instruments,
  `cloudFarCompare`, `cloudSunAccuracy` and `cloudCompositeError`, run only
  under `IR_CLOUD_MEASURE` and assert only that their figures are finite.
- **The thin form's regime is one stance.** "From orbit" is `orbit` at a 4.4°
  sun, and a second clouded body always composites through the thin form,
  from the ground too, in a geometry the `error` batch never measured.

**Not built, and owed before a cloud ships**

- **Velocity under temporal FSR.** The composite cannot blend into a row that
  has no blend. The upscaler's decided fix, reading the masked `motion`, lands
  before clouds draw under a temporal picture.
- **The clouds are not in `ir.settled()`,** so no plate can hold one.
- **Nothing in the scene calls `cloudFront`.** Rings, plumes and traces draw
  over the clouds undimmed.
- **The galaxy, the stars and the sun's disk take the sensor's white for the
  scene unit.** [The air's plan](../the-air.md) has the entry; phase 5 fixes
  it.

**Decided for the phases to come** (9 and 10 Nov 2026)

- **The weather has no WebGL path.** The plan's "WebGL draws the far march
  alone" goes when phase 1's changes land.
- **Phase 1 commits its cornerstone presets first,** before the work they
  judge.
- **Earth keeps its deck until phase 3,** and every phase records Earth with
  the volume forced onto it, here and in its pull request.
- **Every pull request carries comparison media.**

## Earth, phase by phase

Earth is not in the default served set until phase 3. Each phase takes it
with the volume forced, beside the deck it will replace.

| Phase | What Earth looks like from 400 km with the volume forced                                                                                                                                                 | The clouds against the deck hidden, 1080p / Retina | The deck alone, 1080p / Retina |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------ |
| 0     | A gray-blue veil in broad bands of the placeholder's coverage, with no cloud texture and the coast faint under it; the glory's rings stand at the antisolar point. A placeholder, not a picture of Earth | 3.00 / 5.57 ms                                     | 0.13 / 0.30 ms                 |

The still is `stances_verify_earth-orbit_1080p-still.jpg`, taken at `d03b8420`
and kept on the Mac mini under `.data/clouds/shots/stances-2026-11-10T08-45-21Z/`.
Stills are not committed.

## What was verified

On the Mac mini, at the tip the pull request carries:

- `pnpm check`, full: 20 stages passed in 97.3 s of wall time.
- `pnpm test:gpu`, full: 73 files and 443 tests passed; 3 files and 3 tests
  skipped, as many as the opt-in instruments, which skip without
  `IR_CLOUD_MEASURE`. 456 s.
- `pnpm presets:compare --all`: against `main` (`fb5aa5f5`) all 13 presets
  move 0 px. Against the committed plates `centauri-daybreak` moves 231 px,
  which is `main`'s own distance from that plate; the other 12 are within
  124 px.
- `pnpm presets:ledger` leaves no diff, and `pnpm sim --self-test` passes 12
  of 12.
- The `stances` batch at `d03b8420`: thirteen stances, each settled and
  quiet, with a still of each. The steady frame's passes are the nineteen
  ADR-0063 lists. The landing step's report records one observation from the
  stills, that the landed `orbit` draws almost none of the cloud texture
  campaign 1's showed (ADR-0064 has the pair); no record says each still was
  looked at.
- Campaign 1 at `8a01d311`: 78 A/B rows, 8 sweep runs, 18 image comparisons
  and three instruments, every counted row quiet. Campaign 2 at `bbea04da`:
  `targets` 58 of 58 runs quiet, `memory` 12 of 12, `error` 16 of 16, no
  failures, each batch on its first attempt, then the three instruments on
  the landed code.

## Defaults taken without asking

Each can still be overridden:

- The far field's third alternative, the volume's coarse levels carried to the
  planet, is decided on paper: reaching the limb takes a sixth level, and its
  far levels alone are 2.8 times the atlas's memory.
- Losing alternatives are deleted rather than kept behind levers. Campaign 1
  measured them at `8a01d311`, and `25df44ab` is the last commit that holds
  them all.
- Cold-compile figures use a fresh Chrome profile and do not clear the macOS
  Metal shader cache, which lives in the user's own cache directory.
- `?clouds=1` works in production builds, as `producer=cpu` does.
- A second clouded body draws its far march in the composite, not in the
  sphere material. Phase 1 decides whether it moves.
- The docs routing fix changes ADR-0039's behavior past Cloudflare's
  2,000-rule cap: an unknown API address under the collapsed package reaches
  the shell's not-found state with a 200 rather than a 404. The alternative,
  prerendering every API page on review builds, costs each build about 54 s.

## Defects found and fixed on the way

Each has a regression test watched failing with the defect restored. The
build log has the causes (`CONTEXT.md`, 10 Nov 2026, and "Bugs the tests
found").

- A cell with no coverage held cloud at a half-resolved footprint, and Earth
  was overcast from orbit (`d338623a`).
- The trace classed its texels in the reciprocal of the composite's units, so
  every texel read as sky (`9f332134`).
- The air behind an opaque cloud showed through, past the handover and after
  an early exit (`e2f7fbc7`, `216692f5`).
- The history's clip let a thin texel's light grow up to 79 times beside an
  opaque cell: black specks under the identity, white under the thin form
  (`20696e12`).
- The far march lit each column through half its own depth, so a cumulus cell
  seen from orbit drew no light (`f1177e1a`).
- The field moved against the wind the history followed (`eda24bc1`).
- A scrub redrew one far block and one cube face forever (`6ba3820d`,
  `ce6c78a4`).
- The depth copy, the volume and the sun grid each built a second pipeline on
  their first frame, because a narrow target warmed the wrong program
  (`cf16b1af`).

Two defects on `main`, found by reading and not observed in a frame, are
recorded in [`maps/deck.md`](maps/deck.md): the deck's drift is uploaded
unreduced (2.4 km float32 steps in 2026), and the sphere's cloud shadow
ignores that drift and may have its east–west sign reversed.

## What is in this directory

| File                                                         | What it is                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`phase0/design.md`](phase0/design.md)                       | Phase 0's engineering design: interfaces, frame schedule, physics, measurement protocol, decision rules, packages, and its critique log. The code has moved past it where a loser was deleted; the ADRs describe what stands |
| [`phase0/package-reports.md`](phase0/package-reports.md)     | What each of the ten work packages committed, where it departed from the design, and what it tried and dropped                                                                                                               |
| [`phase0/measurement-draft.md`](phase0/measurement-draft.md) | Notes on the jitter lever from the first, stopped measurement                                                                                                                                                                |
| [`phase0/measurements/`](phase0/measurements/README.md)      | Both campaigns' summaries and instrument documents, every pass's share, and the placement's repeats. The raw row documents stay on the Mac mini                                                                              |
| [`maps/`](maps/)                                             | A read-only survey of the eight subsystems the weather touches, taken on `c2a50f1` before any of this was written                                                                                                            |
| [`isccp-h-research.md`](isccp-h-research.md)                 | Phase 3's data: ISCCP-H HGM is netCDF-4 read with `h5wasm`, and its own cover (64.8% global, 68.4% ocean) is not MODIS's                                                                                                     |

The maps, the design and the reports cite line numbers on the trees they were
written against; read the code before trusting one.
