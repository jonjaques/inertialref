# The weather: where the work stands

The working notes behind [the weather plan](../the-weather.md), and the guide
to picking it up. The plan says what the weather is for. This directory says
how far it has got, what each phase handed the next, and where the evidence
is.

**Phase 0, feasibility, has landed** in `the-weather`. Every cloud pass is
built in its final place behind `?clouds=1`, drawing a placeholder field. Its
four choices are made and recorded, the losing alternatives are deleted, and
the plan cites the records.

**Phase 1, the volume and its light, is being built in waves** on
`weather/phase-1`. Its cornerstones and their baseline are their own pull
request; wave 1 is the contracts and three tool packages, merged and open as
phase 1's draft. Phases 2 to 6 have not started.

Nothing draws on `main`. Without the flag the cloud chunk is never loaded, and
with it nothing draws until `engine.clouds.on` is set.

## The branch

The weather lands on one integration branch, **`the-weather`**, cut from `main`
at `fb5aa5f5`. Each phase is a pull request into it, the phases are merged
forward and never rebased, and `the-weather` merges to `main` when the weather
ships.

| Pull request | Branch                       | Holds                                                     | State                               |
| ------------ | ---------------------------- | --------------------------------------------------------- | ----------------------------------- |
| #206         | `weather/phase-0`            | Phase 0: the passes, the measurement, the four records    | Merged into `the-weather`           |
| #199–#204    | `weather/p0-1-…` to `p0-6-…` | The same work as six stacked pull requests against `main` | Superseded by #206; closed          |
| #207         | `weather/p1-cornerstones`    | Phase 1's cornerstones, the velocity row, the baseline    | Open                                |
| Draft        | `weather/phase-1`            | Phase 1 in waves; wave 1 is merged                        | Draft, on `weather/p1-cornerstones` |

Wave 1 is package C, the contracts, at `78f6b3ee`, and three packages built
beside it: I, the instruments; U, the capture's second pass; and J, the
panel's tools ([phase 1's design](phase1/design.md) §10.2). Wave 2 is the
rest of that section's second table. D, R1, T1, T2, H and L go first, since
wave 3 waits on them, and T3, T4, E, Q, W, R2 and Y follow as slots free.
Each builds from the contracts' tip and merges forward into
`weather/phase-1`.

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
| A reset frame, a cut of `horizon` | —                    | 20.30 ms | 22.14 ms |
| Declared memory                   | about 76 MB          | 91.62 MB | 85.01 MB |

At Retina the largest single cost is the second scene pass, 3.88 to 5.32 ms
on the steady rows. At 1080p it is 1.52 to 2.19, and the trace, at four light
taps, is the larger on `ground`, `horizon`, `decks` and both pairs, up to
4.75 ms. The first frames with the clouds on are a hitch: the largest of the
first five is 50.80 to 66.80 ms at 1080p and 75.00 to 92.50 at Retina, the
caches' first build, not shown to be a compile. Every figure is campaign 2's,
at `bbea04da`, but the reset frame, which is the retake's at `f9746fd3`:
campaign 2's `cut`, `scrub`, `fly` and `pair-neighbor` rows looked through the
lens the moon's rise left on the page (ADR-0063). Every figure is the M6 mini's; the plan's budget
basis is an M5, which is not measured.

## What phase 1 inherits

Phase 0 was built to find these. Each is recorded where it was measured, and
none is fixed.

**In the march and its light**

- **A step's light source is taken at the step's start,** which biases
  first-order light high by `2/(1+e^−τ) − 1` a step on a uniform slab at equal
  sun and view angles. That is 15% only near the eye, where a step holds τ at
  0.3; past the step's floor τ grows with distance, to +52% at 8 km and about
  +100% at the far comparison's 55 km handover, where the floor makes a step
  209 m and τ 7.3. Every radiance figure of phase 0 is against a march with
  that bias.
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

## The cornerstones

Nine presets the weather is judged on and a tenth that guards it, committed
before the work that judges them ([ADR-0067](../../../docs/adr/0067-a-preset-holds-its-weather-and-a-cornerstone-is-a-preset-no-list-shows.md),
[phase 1's design](phase1/design.md) §3). Each is one command to take and
the same picture every time; the rubric ([`mvp.md`](mvp.md) §2) says what
each has to show, and [`references.md`](references.md) holds the
photographs it is judged against.

The generated world is P222_3_2_k IV (`g:milky-way/s:P222_3_2_k/b:3`), under
an F0V star of 6,375 K, by the rule [phase 1's design](phase1/design.md)
§3.3 states: the sky in the pictures' frames, times the star's color at the
camera's 5,800 K balance, has B ≥ 1.2 R from 5° to 29° up under both ground
suns; G3's base clears its −1.5° sun by half a degree; the sea stands within
250 m of the datum the regimes' heights are over; and the shore faces open
sea. It is the first body by cell distance from far-shore V that passes. The
rule before it read the air's zenith alone, per unit of a white sun, and
chose P222_1_0_7 III under a 2,346 K star, whose light drew that blue zenith
orange in every baseline still. Its shore site is S, facing 186° across sea
open to 30 km; its land stance L is 13.25 km from S at a bearing of 312°,
20.6 m over the sea. The campaign's stances stay on far-shore V.

| Picture                     | Body, stance, lens                           | Sun                     | Weather               |
| --------------------------- | -------------------------------------------- | ----------------------- | --------------------- |
| `weather-e1-cumulus-orbit`  | Earth, 5°S 60°W, 400 km, nadir; 11.4°        | 50.0° and falling       | `fair-cumulus`        |
| `weather-e2-limb-dusk`      | Earth, 20°N 30°W, 400 km, at the limb; 11.4° | −21.0° and falling      | `cirrus-over-cumulus` |
| `weather-e3-whole-face`     | Earth, `blue-marble`; 65°                    | `blue-marble`'s instant | `fair-cumulus`        |
| `weather-g1-fair`           | L, 40 m; 50°                                 | Noon, 73.8°             | `fair-cumulus`        |
| `weather-g2-overcast-shore` | 16.527°S 38.019°E, 2 m, facing 9°; 50°       | 35.0° and rising        | `overcast`            |
| `weather-g3-underlit-dusk`  | L, 2 m, facing the sun; 55°                  | −1.5° and falling       | `dusk-altocumulus`    |
| `weather-g4-over-deck`      | S, 4,108 m, at the antisolar point; 70°      | 35.0° and falling       | `stratocumulus`       |
| `weather-g5-inside`         | L, 1,487 m, east; 60°. A cast's start        | 45.0° and rising        | `fair-cumulus`        |
| `weather-g6-descent`        | L, 400 km, nadir; 60°. A cast's start        | 45.0° and rising        | `stratocumulus`       |
| `weather-guard-station`     | Earth, 2.5 km off the ISS, at −88°; 11.4°    | 50.0° and falling       | `fair-cumulus`        |

G4's and G5's heights are over their ground and stand at the design's
heights over the datum: G4 3,000 m over the deck's 1,300 m top, G5 at the
cumulus's middle, 1,700 m. E3 holds `fair-cumulus` until the climate lands,
because `cirrus-over-cumulus`'s bands stripe a whole face every 2.9° of
latitude.

G2 stands 45 km from S, on dry ground 0.6 m over the sea, because the world
rule holds a depth clause: across the frame's horizontal field, ±36.7° for a
50° lens on the 1440 × 900 rig, the drawn seabed lies under the sea by the
drawn ground's tail plus 1 m, from 250 m out to 30 km. At S the sea is 0.70 m
deep 250 m out, against 2.13 m. At G2's place every heading from −20° to 38°
passes, and at its 9° the shallowest sample in the frame is 10 m deep. G4
keeps S.

The overlay guard, `weather-guard-station`, is the tenth cornerstone: E1's
picture with the ISS in it, from 2.5 km off the station and 2° off its
vertical, through E1's lens, at the third crossing of E1's sun over the
station's sub-point (11,392.7 s), the first whose ground behind the station
holds cloud (cover 1.0; the first two read 0.07 and 0.24). At the design's
1 km the station's 65.3 m sphere fills 0.65 of the frame against the rule's
third; at 2.5 km it fills 0.26. Its weather is served on Earth, the body the
station goes round. It is taken in a deck arm, its first accepted plate, and
a volume arm, a guard pair.

The suns are solved, not written, and `cornerstoneLedger.test.ts` holds each
within half a degree in Node.

### The record

A row a cornerstone and a column a phase: the sheet, the commit, the rubric's
§3.6 numbers that exist yet, and the panel's scores where a panel has sat.
Phase 0's column is the baseline, phase 0's landed light on the placeholder
density, taken by `scripts/weather/capture.mjs` before any phase 1 package
changes it; every later sheet's left column starts there.

The baseline is three runs of the capture script on one rig: Chrome
157.0.8103.40 on the Mac mini (M6), 1440 × 900 at DPR 2, the display asleep.
E1 and E2 are the first run's, at `ab301957` from a production build of
`23f173bc`; the world's move changes nothing on Earth, and a cut into E1 on
the later build differs from that run's fresh boot at 2,087 px, under E1's own
floor. E3, G1 to G4 and the cut are the second run's, at `408d6c9b` from its
own build; the casts are the third's, at `4a8244e0` from the same bundle. The
noise floor is the pixels over the presets' 3% level between two fresh boots
of the same still, of 5,184,000. The cloud share is the share of the trace's
81,000 texels whose history holds cloud (`ir.cloudRadiance()`), with the mean
luminance on and off them in scene units.

| Picture | Phase 0, the baseline                                                                                                                                                                                                                                                                                                                                                                                                                                            | Phase 1 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| E1      | [Sheet](https://agentic-media-dumpster.jonjaques.com/2026/11/fzrhjxb9ji/weather-e1-cumulus-orbit.png). Volume: a dim blue-gray sea under scattered flat blotches of the placeholder's coverage, thinning to clear toward the frame's left; no cloud reads as cumulus. Deck: an unbroken white of the textured deck. Floor 6,236 px volume, 0 deck. A cut from G1 holds cloud at 0.85 of its texels                                                               | —       |
| E2      | [Sheet](https://agentic-media-dumpster.jonjaques.com/2026/11/5r2dsf2tdz/weather-e2-limb-dusk.png). The night limb under an orange and violet band of air; the volume's horizon is a fine broken edge where the deck's is smooth. Both arms draw the sun's flare through the dark disk below the limb (a defect on `main`, below). Floor 14,667 px volume, 0 deck                                                                                                 | —       |
| E3      | [Sheet](https://agentic-media-dumpster.jonjaques.com/2026/11/yzcnrywv3q/weather-e3-whole-face.png). Volume, `fair-cumulus`: Earth whole under a regular lattice of square dark blobs, the cube face's 64-cell grid read from a whole face, Africa through it; **it reads as a grid, not weather.** Deck: the photographed clouds. Cloud share 0.23. Floor 50,151 px volume, 0 deck                                                                               | —       |
| G1      | [Sheet](https://agentic-media-dumpster.jonjaques.com/2026/11/5a7vwfqbhe/weather-g1-fair.png). A dark sheet over the whole sky with a line of cumulus on the horizon, over a pale plain with lakes and the sea on the right, under a blue-white sky where it shows. **Not fair weather:** L stands under a core of `fair-cumulus`'s blob pattern, cover 1.0 to 10 km along the view. Cloud share 0.58. Floor 6,952 px                                             | —       |
| G2      | [Sheet](https://agentic-media-dumpster.jonjaques.com/2026/11/2bmtvxw9rz/weather-g2-overcast-shore.png). A near-black overcast over the whole sky over a pale foreground with blue water at the left. **The sea draws as flats:** it is 0.1 to 0.9 m deep for its first 2 km along 186°, under the drawn ground's tail, which on this body reaches 1.13 m (`drawnDivergence`; 1.25 m is the ceiling on any body). Cloud share 0.60, the whole sky. Floor 1,388 px | —       |
| G3      | [Sheet](https://agentic-media-dumpster.jonjaques.com/2026/11/upw8i8f3ib/weather-g3-underlit-dusk.png). The deck overhead, dark gray, broken by clear sky; toward the sun its far part is lit orange from below, over a glowing clear slot at the sunset. The orange band is speckled at the trace's texel. The ground is pale blue and brighter than the sky behind the deck. Cloud share 0.65. Floor 96,167 px                                                  | —       |
| G4      | [Sheet](https://agentic-media-dumpster.jonjaques.com/2026/11/d8ck54bnkh/weather-g4-over-deck.png). The deck from above, its tops dark gray under a 35° sun, darker than the white ground and blue sea in its gaps; the glory's rings at the antisolar point. Cloud share 0.83. Floor 13,630 px                                                                                                                                                                   | —       |
| G5      | [Sheet](https://agentic-media-dumpster.jonjaques.com/2026/11/rdbedpk54u/weather-g5-inside-fly.png); [the clouds-off cast](https://agentic-media-dumpster.jonjaques.com/2026/11/emjvg9evgj/cast.mp4), 690 frames at 62.9 Hz, 100% of the path, clip at 62.44 fps: level over pale land and a bay under a blue sky. With the clouds on, refused at three boots: 2, 1 and 2 dropped frames at 42.4 to 42.6 Hz                                                       | —       |
| G6      | Refused at three boots in every arm, by dropped frames. Slow: 12, 11, 14 drops on at 45.5 to 45.9 Hz; 9, 15, 6 off at 60.6 to 67.1 Hz. Fast: 5, 9, 5 on at 46.3 to 46.5 Hz; 8, 6, 10 off at 67.6 to 69.4 Hz                                                                                                                                                                                                                                                      | —       |

- **The baseline stills in this record are a first look.** They are the
  capture's first pass; each is retaken on its second, the tool on this
  branch, before any plate is judged against it.
- **The baseline's casts were refused for any dropped frame.** Every G6 arm
  drops frames in the same two places in every boot, with the clouds on and
  off: a band from about 50 to 20 km up, and one frame near the ground (355 m
  on the slow path, 291 m on the fast). The drops are the descent's, not the
  clouds'. G5 with the clouds on drops one or two frames at a time, among
  them its first frames, where B13 already puts the clouds' cost.
- **The capture keeps a cast with its drops listed,** each by path frame,
  height and distance, at the rate it presents at until a 60 Hz hold exists,
  and refuses it past 3% of its frames or three missed in a row
  ([ADR-0067](../../../docs/adr/0067-a-preset-holds-its-weather-and-a-cornerstone-is-a-preset-no-list-shows.md);
  provisional, from this baseline). A clouds-on drop where its control
  dropped nothing within ten path frames is marked `cloudsOnly`, a finding of
  its own kind.
- **A take is refused when its page's build is not the record's commit:** the
  build id must contain the commit's first eight characters and not end
  `-dirty`. The baseline's E1 and E2, recorded at `ab301957` from a build of
  `23f173bc`, are such a pair.
- **C6's clause waits for the fine field's CPU twin.** The ledger records
  G5's 1,600-frame path against C6 and does not assert it: the CPU holds only
  the coverage, whose blob cells are 96 km here, and L stands in a core at
  cover 1.0 for all 4 km, so no path from there runs clear, through a cloud
  and clear again. Package D's CPU field is what can place one.
- **C4's cast is G6's slow descent under the world's own climate,** the
  `weather` lever at `'climate'`. Until package D lands the climate,
  `bodyWeather` answers `CLIMATE_REGIME`, `fair-cumulus`, on every wet body,
  so the cast draws that regime, not G6's `stratocumulus`.
- **G3's deck draws on this world and did not on the last.** The cloud frame
  takes the sun from the body's center in render space, 2.04° high there and
  0.26° here (below, under the defects on `main`).
- **G1 and G2 show the regime and the ground, not the picture the rubric
  names,** for reasons in the cornerstones themselves, each in its row. They
  are taken as they stand, not tuned.
- **The undersides are dark everywhere,** and G4's tops are darker than the
  ground: phase 0's placeholder light, first order with a placeholder sky term.
  Phase 1's light is what changes them.

Earth's rows are the forced arm beside the deck. At this phase the forced
arm lacks three things the deck's picture has: it draws no shadow on the
ground (phase 2), a held regime stands in for the climatology (phase 3), and
its light is phase 0's placeholder, first order with a placeholder sky term.
So E1 to E3 say where the volume stands, not how Earth's clouds look. E3's weather changes from `fair-cumulus` to the climate
when phase 1's integration lands it, so the sheet across that change compares
two weathers.

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

Phase 0's, on the Mac mini, at `8cfd71a0`, whose code is phase 0's landed tip:

- `pnpm check`, full, on a budget of 4 cores: 20 stages passed in 88.2 s of
  wall time. Its `test` stage is 362 files and 4,141 tests, and `test:slow`
  5 files and 9 tests.
- `pnpm test:gpu`, full: 73 files and 444 tests passed; 3 files and 3 tests
  skipped, as many as the opt-in instruments, which skip without
  `IR_CLOUD_MEASURE`.
- `pnpm presets:compare --all`: against `main` (`fb5aa5f5`) all 13 presets
  move 0 px. Against the committed plates `centauri-daybreak` moves 231 px,
  which is `main`'s own distance from that plate; the other 12 are within
  124 px.
- `pnpm presets:ledger` leaves no diff, and `pnpm sim --self-test` passes 12
  of 12.
- The `stances` batch at `d03b8420`: thirteen stances, each quiet, with a
  still of each, and twelve settled. `earth-orbit` at 1080p reached the 30 s
  settle with its deposits still building, a row the runner rejects from
  `f9746fd3`; Earth's still above is that row's. The steady frame's passes
  are the nineteen ADR-0063 lists. The landing step's report records one observation from the
  stills, that the landed `orbit` draws almost none of the cloud texture
  campaign 1's showed (ADR-0064 has the pair); no record says each still was
  looked at.
- Campaign 1 at `8a01d311`: 78 A/B rows, 8 sweep runs, 18 image comparisons
  and three instruments, every counted row quiet. Campaign 2 at `bbea04da`:
  `targets` 58 of 58 runs quiet, `memory` 12 of 12, `error` 16 of 16, no
  failures, each batch on its first attempt, then the three instruments on
  the landed code. The landed set's ladder at `51c96da4`: 12 of 12 runs
  quiet, then the three instruments. The retake of campaign 2's forced and
  `pair-neighbor` rows at `f9746fd3`: 40 of 40 runs quiet, no failures, one
  run taken a third time after two attempts beside another job.

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

## The docs routing

The weather's exports push a review build's `_redirects` past Cloudflare's
2,000 static rules. The owner was asked and answered: "cut docs prerender to
just the top level pages, it takes way to long as is". That redesign lands on
`main` through its own pull request and is not started. Until it merges and
is merged back into this stack, this branch keeps its interim fix,
`db65372f`: past the cap the largest package's API routes collapse into one
splat, so an unknown address under that package reaches the shell's
not-found state with a 200 where an exact table answered 404.

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

Three more on `main` and one here, found by the cornerstones, are left as
they are for the light and the flare's own work to take up:

- **The sun's flare draws through the planet.** `sunVisibility`
  (`apps/game/src/render/flareMath.ts`) fades the flare over the sight line's
  closest approach from 0.985 to 1.03 of the drawn radius, so its fade starts
  95.5 km inside Earth's sunk sphere. E2's sun, 1.2° under the limb from
  400 km, passes 6,327.9 km from the center against a drawn 6,368.2 km, a
  ratio of 0.9937, and draws 9.7% of the flare through the dark disk, in
  both arms. It is `main`'s: the branch changes nothing in `flareMath.ts`.
- **The terrain and the water take the sun from the body's center in render
  space** (`TerrainPatches.tsx`, `WaterPatches.tsx`). Render compression
  keeps only directions from the eye, and the key star stands at a finite
  render distance, so the sun seen from the center carries a parallax: 2.04°
  at P222_1_0_7 III's G3, where the star stands 28 radii from the body's
  center in render space, 0.51° at E2 and 0.26° at P222_3_2_k IV's G3 (217
  radii). A dusk sun 1.5° under the horizon lights the ground as one 0.5°
  over it on the first: the baseline's G3 ground was brighter than its sky.
- **The cloud frame forms its sun the same way** (`bodySun`,
  `apps/game/src/render/cloudFrame.ts`, phase 0's), so the maps' terminator
  and the trace's light read that same parallax. At P222_1_0_7 III's G3 it
  cleared `dusk-altocumulus` from the whole frame: `ir.cloudRadiance()` held
  cloud at 0 of 81,000 texels, where the CPU twin puts cover 0.7 over the
  eye, and the GPU's edge crossed overhead only once the eye's sun stood
  2° to 2.5° under the horizon. With the same layer and no terminator it
  drew. At P222_3_2_k IV's 0.26° the deck draws. The fix is the direction
  from the eye, which compression preserves; phase 1's light is where it
  lands.

## What is in this directory

| File                                                                                       | What it is                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`mvp.md`](mvp.md)                                                                         | The rubric the MVP is judged against: the nine pictures, the budget, the numbers. A draft no council has settled                                                                                                             |
| [`references.md`](references.md)                                                           | The reference photographs gathered for each picture, with source, credit and license                                                                                                                                         |
| [`phase1/design.md`](phase1/design.md)                                                     | Phase 1's engineering design, draft 3: the cornerstones, the volume's light, the packages and their order                                                                                                                    |
| [`phase1/measurements/velocity-2026-11-10.md`](phase1/measurements/velocity-2026-11-10.md) | ADR-0044's held presets on the layout without the velocity row and on the one with it: 32 cells, the protocol and the rows                                                                                                   |
| [`phase0/design.md`](phase0/design.md)                                                     | Phase 0's engineering design: interfaces, frame schedule, physics, measurement protocol, decision rules, packages, and its critique log. The code has moved past it where a loser was deleted; the ADRs describe what stands |
| [`phase0/package-reports.md`](phase0/package-reports.md)                                   | What each of the ten work packages committed, where it departed from the design, and what it tried and dropped                                                                                                               |
| [`phase0/measurement-draft.md`](phase0/measurement-draft.md)                               | Notes on the jitter lever from the first, stopped measurement                                                                                                                                                                |
| [`phase0/measurements/`](phase0/measurements/README.md)                                    | Both campaigns' summaries and instrument documents, every pass's share, and the placement's repeats. The raw row documents stay on the Mac mini                                                                              |
| [`maps/`](maps/)                                                                           | A read-only survey of the eight subsystems the weather touches, taken on `c2a50f1` before any of this was written                                                                                                            |
| [`isccp-h-research.md`](isccp-h-research.md)                                               | Phase 3's data: ISCCP-H HGM is netCDF-4 read with `h5wasm`, and its own cover (64.8% global, 68.4% ocean) is not MODIS's                                                                                                     |

The maps, the design and the reports cite line numbers on the trees they were
written against; read the code before trusting one.
