# The weather: the MVP, and how it is judged

**Draft 2, not yet settled.** This page becomes `design/plans/weather/mvp.md`
once a branch can carry it. A council of three settles it once, before phase 1
builds. After that every verdict is scored against it, and a seat that wants a
bar moved argues the change against this page, in writing.

[The weather plan](../the-weather.md) runs to seven phases. The
MVP is the first four: the volume, its shadow and its light, on Earth from
orbit and on a generated wet world from orbit to the ground. This page says
which pictures that has to produce, what each is judged against, what the frame
may cost, which numbers hold it honest, and what is left out on purpose.

Figures marked _target_ are the plan's, borrowed from other hardware. Phase 0's
ADRs replace them with the Mac mini's own (Mac18,5, Apple M6, 32 GB), and the
council settles this page with those in place. Section 10 lists what is still
open in this draft.

---

## 1. What the MVP is

`the-weather` holds a solid MVP when all of this is true on its tip:

- Earth seen from low orbit and from `blue-marble` wears a volumetric cloud
  field with its shadow and its light, and the textured deck, its map and its
  0.4% lift are gone. The ISS orbits at 400 km, which is where the deck's
  19.6 km texels and its missing height show worst, so that altitude is where
  the pictures are taken.
- A generated wet world has weather at every height. It carries the
  ground-level pictures, because Earth's own terrain questions are open
  ([terrain](../terrain.md)).
- One field draws at every distance. A descent from orbit to the ground
  through a deck has no frame that steps.
- The clouds are on by default. The weather is WebGPU's alone: the project is
  leaving WebGL, so the plan's far-march-alone fallback (its §11, decision 3)
  is not built.
- Every figure below is measured on the mini and recorded in an ADR.

Earth at ground level is not judged against photographs. It still has to draw
without a defect a viewer would see: no band at the descent gate, no clear sky
snapping in overhead, one cloud shadow on the ground and the sphere.

---

## 2. The pictures

Each picture is a preset: an address, a framing, a lens and a held instant, so
the weather in it is the same every time it is taken (ADR-0033).

| #   | Picture                 | Where                                                                                             | It has to show                                                                                                                                                | Judged against                    |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| E1  | **Cumulus from orbit**  | Earth, 400 km, looking down, early afternoon over a continent, a long lens (the floor is 11.4°)   | Cells about a kilometer across, each beside its own shadow on the ground                                                                                      | ISS Earth-observation photographs |
| E2  | **The limb at dusk**    | Earth, 400 km, toward the sunset limb                                                             | Cloud tops standing into the orange band, the shadows they lay on the air, a terminator that darkens                                                          | ISS limb photographs              |
| E3  | **The whole face**      | Earth, `blue-marble`                                                                              | The circulation: the ITCZ, the clear subtropical belts, a stratocumulus deck off a west coast, the storm tracks' overcast                                     | DSCOVR EPIC frames                |
| G1  | **Fair weather**        | A generated wet world, from a rise at noon                                                        | Flat bases at one height, bright tops, shadows crossing the ground                                                                                            | Ground photographs                |
| G2  | **Overcast over water** | A generated wet world, standing on a shore under a deck                                           | Gray light with no sun, and the deck in the sea where a blue sky stood                                                                                        | Ground photographs                |
| G3  | **Underlit at dusk**    | A generated wet world, standing, the sun about 1.5° under the horizon, the layer's base still lit | A mid-level layer lit orange from below, crepuscular rays                                                                                                     | Ground photographs                |
| G4  | **Over the deck**       | A generated wet world, 3 km over stratocumulus, the sun behind the eye                            | The glory at the antisolar point with no shadow at its center, the cloudbow, the deck's cells                                                                 | Aircraft photographs              |
| G5  | **Inside**              | A generated wet world, flying through a cumulus (a cast, not a still)                             | The range falls to `3.912/σ′`, about 110 m in continental cumulus, and returns to kilometers on leaving, and no frame steps. The cast's log carries the range | Cockpit video                     |
| G6  | **The descent**         | A generated wet world, orbit to standing, through a deck (a cast)                                 | One field the whole way down: no pop, no band at the handover, no flash at the gate                                                                           | The continuity specification (§4) |

### The cornerstones exist before the work they judge

Each required picture is a preset committed in phase 1's first package, before
the volume can draw it well. A cornerstone holds its address, its stance, its
lens, its instant and its weather, so it is one command to take and the same
picture every time. That package also carries what a cornerstone needs to be
taken at all: a preset that can hold weather, and `ir.settled()` waiting on
the clouds.

- **Every phase re-takes every cornerstone,** on one rig in one session, and
  its pull request shows each beside the last phase's plate.
- **Earth is tested from the start, and its progress is recorded.** Earth
  keeps its deck by default until phase 3, so until then E1 to E3 are taken
  with the volume forced onto Earth and shown beside the deck from the same
  stance. `design/plans/weather/README.md` keeps the record: a table by phase
  and cornerstone with the plate, the numbers of §3.6, and the panel's scores
  where a panel has sat.
- **Every pull request carries its comparison media:** the cornerstones it
  moves, before and after, the deck beside the volume for Earth, and the casts
  for G5 and G6. A phase with nothing a viewer could judge says so and shows
  what it has; phase 0's are the measurement's own image pairs.

E1 to E3 and G1 to G6 are required. Two more are scored when they exist and
block nothing:

- **Anvils at sunset.** The plan lists it under phase 3 and gives the anvil its
  tropopause in phase 4. A squall line under the eye is storm work.
- **A generated wet world from orbit.** Every existing plate of a wet generated
  world moves when it gains weather. Each is re-taken, and each needs a
  regression verdict (§3.5) that the clouded plate is not worse than the clear
  one.

---

## 3. How a picture is judged

A cloud field can pass every number in §6 and still read as cauliflower. So
the pictures are judged by eye, blind, against photographs, by the protocol
[the look council](../look-council.md) arrived at. Where this
page and that one differ, it is because the reference here is a photograph and
not a second render.

### 3.1 The references are frozen first

For each picture, three to five photographs of the real phenomenon are chosen
before the first plate of it is taken, so nobody picks the photograph the
render happens to resemble. The set is frozen: 40 photographs, four or five a
picture, listed with source, credit, license, hash and capture metadata in
`.scratch/weather/references.md`, which is committed beside this page as
`references.md`. The images stay in `.data/`. Sources: NASA's
Gateway to Astronaut Photography for E1 and E2, the DSCOVR EPIC archive for E3,
and public-domain or CC-licensed ground and aircraft photographs for the rest.
E3's references are EPIC frames at the same sub-solar latitude as the preset's
held instant, because the ITCZ follows the sun.

### 3.2 The packet

- **The rig is one rig.** Every plate in a round comes from one session of
  `scripts/drive.mjs` at 1440 × 900, DPR 2, sRGB forced, SDR, with the commit
  and the fixtures' hash in the capture record. The settle is `ir.settled()`,
  which waits for the clouds' history, the shadow's slices and the cache levels
  in view. Two boots of one tree must agree to the noise floor before any
  review counts.
- **Arms.** A scene goes to the council as lettered images: the candidate, the
  last accepted candidate, and up to one experiment. The letters are shuffled
  per seat.
- **Three controls.** One scene carries the same plate twice, and a seat that
  finds a difference of more than a point there is discarded for the round.
  One scene carries a real photograph as an arm, and a seat that scores a
  photograph under 8 on form or light has its scale checked before its scores
  are used. On E1, E2 and E3 the textured deck, taken on the same rig from
  `main`, is an arm.
- **What a seat sees.** The packet's images, the references, and a frozen
  brief. It never sees the round, the diff, another seat's words, or which arm
  is which.
- **Proof of looking.** Each review states three checkable observations about
  named images, and the orchestrator checks them against the pixels.

### 3.3 The seats

One model from each of three providers, each provider's strongest at high
effort, a fresh delegate every round: Claude Fable 5.2, GPT-6 Astra, Muse
Wonder Full 1.0. A seat that fails to answer is reported as missing, never
replaced.

### 3.4 What is scored

Each arm is scored out of ten on five dimensions, against the references.

| Dimension       | The question                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| **Form**        | Do the clouds have the shapes, sizes and arrangement of the genus in the references, or do they read as noise? |
| **Light**       | Tops against bases, the lit side against the shaded one, the silver lining, the color at a low sun             |
| **Shadow**      | Each cloud beside a shadow of the right length and direction, on the ground, the sea and the air               |
| **Integration** | The clouds stand in this air, on this limb, over this sea: no seam, no second model, no pasted layer           |
| **Artifacts**   | Banding, grain, ghosting, a handover line, stair-steps. Ten is none found                                      |

The scale is anchored so that three seats mean the same thing by a number:

- 10: at packet size, this dimension could be the photograph.
- 8: reads as the real thing at first glance, and the differences take
  inspection to find.
- 6: plainly the phenomenon, and plainly synthetic.
- 4: reads as a graphics effect.

**A required picture passes** when every seat scores it at 7 or more on every
dimension, the mean across seats is 8 or more on form and on light, and no two
seats name the same artifact. `Overall` is asked for and is advisory.

**On E1 and E2 the volume also beats the deck:** every seat ranks the
candidate above the deck arm on form, light and shadow. On E3 the deck is a
composite of real imagery and the comparison is reported, with the bar in §10.

### 3.5 Guards

Scenes outside the cloud pictures are guards. A guard whose plate moves past
the rig's noise floor goes to the council as a pair against its last accepted
plate, and two seats calling it worse blocks the change. A guard that does not
move carries its verdict forward. `pnpm presets:compare --all` reports 0 moved
for every preset with no clouded body in frame.

### 3.6 Numbers beside the opinions

Each is cheap, and each answers one dimension. They pick the experiments
between council rounds and sit beside the scores in the ledger, so a
disagreement between a number and a seat is visible.

- **E1:** the offset between a cell and its shadow against `height · tan(z)`
  for the sun's zenith angle `z`.
- **E2:** the band's layer heights along the vertical through the sun, and the
  height the cloud tops reach on the limb.
- **E3:** the disk's cloud fraction against the climatology's for that month,
  by 10° band; the disk's mean reflectance against EPIC's for the same phase.
- **G1 to G4:** the ground's illuminance under the deck against the
  Monte Carlo column; the glory's first ring at its angle for the table's
  radius.

---

## 4. Continuity

The [art direction's specification](../../../docs/design/art.md#continuity--the-no-pop-in-specification)
is held as it applies to a cloud field, and each item has a check.

| Requirement                                                                                                                              | Check                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One field at every distance. What changes with range is resolution, faded across a band, with no switch that can flip between two frames | A GPU test holds the fine march and the far march to one radiance and one transmittance across the handover band, within the bound phase 1 measures                                                     |
| The handover follows pixel footprint, never altitude                                                                                     | One cast of a zoom and one of a descent cross the band, and the same test covers both                                                                                                                   |
| A descent through a deck has no frame that steps (G6)                                                                                    | `--cast` over the descent on a generated wet world, read by `scripts/castSteps.mjs`: no frame-to-frame jump in mean luminance or cloud opacity outside the cast's own noise, at 1× and at reentry speed |
| No ghosting when the camera outruns the history                                                                                          | Casts at 250 m/s on the ground and 7.7 km/s in orbit. The trail measure is under its floor three frames after the camera stops                                                                          |
| A cut or a scrub lands on the right sky                                                                                                  | After `pictureEpoch` moves, `ir.settled()` resolves, and the settled plate equals a fresh boot's plate at that instant to the noise floor                                                               |
| The ground, the sea and the sphere wear one cloud shadow (rule 59)                                                                       | A GPU test holds the three to within 1% at the descent gate                                                                                                                                             |
| Nothing takes Earth's clouds away                                                                                                        | No commit on `the-weather` draws Earth without clouds: the deck stays until the volume draws Earth with its shadow and its light                                                                        |

---

## 5. The budget

Costs are `ir.gpu()` taken A/B in one boot, clouds on against clouds off, on a
quiet mini, by the protocol phase 0's design fixes (§8.3 there), with the
presentation rate recorded in every row. Earth's figure is against a frame
with the deck hidden. Two sizes: 1920 × 1080 at DPR 1, and 1440 × 900 at DPR 2.

**Where phase 0 lands,** measured on the mini at `bbea04da`
([the campaign's tables](phase0/measurements/)): the placeholder's clouds cost
5.1–7.6 ms on the ground and 3.0 ms from orbit at 1080p, against the plan's
2.9 and 1.6. The clouds-off frame on the ground is 5.9–7.5 ms at 1080p and
13.2–15.5 ms at Retina, so with clouds the frame is 12–13 ms at 1080p, under
a 60 Hz frame, and 22–23 ms at Retina, over it.

| Stance                                    | 1080p steady, ms | Of it: second scene pass / trace / bakes | Retina steady, ms |
| ----------------------------------------- | ---------------- | ---------------------------------------- | ----------------- |
| `ground`, under cumulus                   | 7.12             | 1.70 / 3.72 / 1.62                       | 8.91              |
| `horizon`                                 | 5.67             | 1.52 / 2.45 / 1.61                       | 7.70              |
| `inside`                                  | 5.07             | 2.08 / 1.27 / 1.56                       | 7.70              |
| `orbit`                                   | 3.03             | 1.84 / 0.09 / 0.84                       | 5.54              |
| Earth from orbit, against the deck hidden | 3.00             | 1.80 / 0.09 / 0.78                       | 5.57              |

Three things in those rows are phase 0's own and are the first to go: the
second scene pass, which costs 1.5–2.2 ms at 1080p and 3.9–5.3 ms at Retina
whether or not anything is drawn over the clouds; bakes that redraw every
frame while nothing changes; and a trace at 192 steps and four light taps of
five reads each.

**The bars.** Each is a steady Δ on the mini with nothing drawn over the
clouds, unless it says otherwise.

| What                                                             | Bar                                                                                                                   | Where the number comes from                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| From orbit over Earth, 1080p, a 60° lens                         | ≤ 1.6 ms                                                                                                              | The plan's target. Phase 0 lands at 3.00, of which 1.80 is the second pass                      |
| From orbit over Earth, 1080p, E1's 11.4° lens                    | Recorded, and no more than the ground's bar                                                                           | The long lens puts the whole frame in the fine march. No figure exists until phase 1's campaign |
| On a generated world's ground, dry, 1080p                        | **Open (§10 item 9):** the plan's 2.9 ms, or a re-based bar                                                           | Phase 0 lands at 5.1–7.6                                                                        |
| Retina, every stance                                             | The trace, the history and the bakes cost no more than at 1080p; the whole within 0.5 ms of the 1080p figure          | The plan's rule, split so the second pass is seen apart. Phase 0 lands 2.5–2.8 ms over          |
| A frame with something drawn over the clouds                     | Recorded beside each bar                                                                                              | The second pass's price, measured by phase 1's `over` batch                                     |
| A reset (a cut, a scrub, a change of weather, a wake from orbit) | No frame of the sequence adds more than the steady figure plus 2 ms at 1080p, and the field is whole within 48 frames | Proposed. Phase 0 lands a cut at 19–25 ms and a scrub at 15–17 ms on the ground                 |
| The first frames with the clouds on                              | The largest of the first five is within one 60 Hz frame of the steady median, recorded with its presentation rate     | Phase 0 lands 51–67 ms against 16.7 at 1080p                                                    |
| Memory, 1080p                                                    | ≤ 76 MB declared, and the declared bytes equal the GPU's                                                              | The plan's target. Phase 0 lands at 91.62 MB                                                    |
| Late frames at 1080p                                             | Over a 3 s window from orbit and on the ground the clouds add at most 2, at a 60 Hz presentation, the rate recorded   | Proposed                                                                                        |
| The whole frame at 1080p                                         | Every cornerstone holds 60 Hz on the mini: the GPU frame with clouds is under 14.7 ms                                 | Proposed, so the clouds' bar cannot be met by a frame that misses                               |

After this page is settled the numbers stand.

---

## 6. The numbers that hold it honest

The plan's done-when rows for phases 1 to 3, gathered. Each is a test in the
tree or a recorded measurement, and the verdict cites where.

**The transport (phase 1)**

- A slab against the adding-doubling reference for τ 5 to 50 at three sun
  elevations: its reflected flux within 2%, and its radiance within 5% over the
  angular domain the phase's design declares, which leaves out the forward
  cone in transmission.
- The furnace within 2%: under a uniform sky, at albedo one, with no sun, the
  radiance is the sky's at any density.
- A layer's transmittance unchanged as its steps are split.
- The isolated cumulus beside its path-traced reference, with the silver lining
  and the edge both present.
- The phase shortcut's glory beside the per-sample reference on mixed radii.
  The glory's first ring and the cloudbow at the table's angles. The primary
  bow is a raindrop's and arrives with rain.
- Each genus's cloudy pixels fall in ISCCP's optical-depth classes in the
  shares its type records, counted on radiatively averaged 5 km pixels, of
  those a satellite would detect. A
  growing cumulus crosses all three classes, so the test is a share and not a
  membership.
- A fair-weather field's cell sizes follow the measured power law, counted on
  the CPU field: a slope of 2.19 ± 0.4 by maximum likelihood on
  area-equivalent diameter, from 200 m to 2 km.
- The glory's contrast is the scaled medium's, about twice the true one. The
  transport's ADR declares it.

**The shadow and the light (phase 2)**

- One cloud shadow on the ground, the sea and the sphere at the descent gate,
  within 1%.
- The composite's air and the surfaces' air at one value under a cloud's
  shadow.
- Downward light under a deck within 10% of the Monte Carlo column at three sun
  elevations and two albedos.
- The air's two skylight defects closed: the noon ramp and the single zenith.

**Earth (phase 3)**

- Global cover and every 10° zonal band within the bounds §10 settles, counted
  on the CPU over the sphere and over simulated years.
- Each ISCCP type's optical-depth histogram.

**What the weather is**

- A function of `(body, place, renderTime)`. Two boots at one instant draw one
  plate. Nothing is stepped and nothing is saved.
- Not canonical. It enters no hash and spends no version, and a test holds the
  state hash equal with the clouds on and off.
- Float64 decides and float32 draws. Ten years past the epoch a cloud drifts
  without a visible step.

---

## 7. Engineering and the docs

- `pnpm check` and `pnpm test:gpu` are green on the tip, and CI is green on
  every phase's pull request.
- `presets:compare --all` moves only the plates this work means to move. Each
  is re-taken, and `presets:ledger` shows them and nothing else.
- Every decision has an ADR, with its `wings.mjs` row. The plan has lost each
  section an ADR now owns. `CONTEXT.md` carries what was measured and what must
  not come back. `docs/concepts/rendering.md` has the weather's section, the
  harness guide names the passes and the levers, and
  `design/plans/weather/README.md` says where the work stands.
- Each phase's code has had a review by layer and a council round, and its
  findings are fixed or declared.
- Nothing ships behind a diagnostic flag that the MVP needs. A lever that stays
  is a quality step or a measurement control, and its ADR says which.

---

## 8. Out, on purpose

None of these counts against the verdict:

- Rain, shafts, wet ground, lightning, fog, cyclones, the warp fade, and the
  temperature profile they wait on (phase 4).
- The moon, cities under cloud, airglow, and any night picture (phase 5).
- Mars (phase 6). Venus, Titan and the giants keep what they draw.
- Snow, hail, ice halos, aurora, noctilucent clouds (plan §14).
- Earth judged from the ground.
- Any WebGL path for the weather. Once the deck retires, a WebGL session draws
  Earth without clouds.
- Merging `the-weather` into `main`.

A night side with black clouds is therefore expected, and is declared in the
ADR that lands the light.

---

## 9. The verdict

Two bodies do two jobs, and they are kept apart.

- **The picture panel** is §3: blind, fresh delegates each round, scoring
  images against photographs. It answers whether the pictures pass.
- **The council** reads this page and the evidence: the panel's ledger, the
  measured tables, the tests each number in §6 names, the casts, the ADRs and
  the diff. It is the three models §3.3 names, at high effort, read-only. Each
  seat scores the MVP out of ten and answers one question: is this a solid
  MVP by this page?

The work is done when all three seats answer yes in the same round. A seat
that answers no names the section of this page that fails and the evidence
that would change its answer. Findings outside this page are recorded as
later work and do not hold the verdict.

---

## 10. Open in this draft

The council that settles the page decides these. Each has a proposed answer.

1. **Which climatology the cover is held to.** The plan quotes MODIS (global
   0.67 to 0.68, ocean 0.72, land 0.55) and builds from ISCCP-H, whose own
   2007 to 2016 mean is 64.8% global, 68.4% over ocean and 55.5% over land
   ([research](isccp-h-research.md)). A field built
   from one cannot be held to the other. _Proposed:_ the field is held to
   ISCCP-H's own figures, 0.03 globally and 0.05 in each 10° band, and the
   MODIS comparison is reported beside it.
2. **The whole face against the deck.** The Blue Marble deck is real imagery,
   and at `blue-marble`'s distance its texels are not the problem. A procedural
   climatology can pass against EPIC and still lose to it. _Proposed:_ E3
   passes on §3.4's bars against EPIC, the deck comparison is reported, and if
   two seats rank the deck above the volume on form the question goes to Jon
   before the deck's map is deleted.
3. **The pass bar.** Seven on every dimension and a mean of eight on form and
   light is a guess at what "solid" means for a real-time cloud beside a
   photograph. The look council's first bar, nine from every seat, was out of
   reach. _Proposed:_ score the photograph arm and the deck arm first, and move
   the bar only if a photograph itself does not clear it.
4. **Anvils.** Required, or scored when present. _Proposed:_ scored when
   present.
5. **The budget's proposed rows** (the reset sequence, the first frames, late
   frames, the whole frame at 60 Hz) are proposals with phase 0's landed
   figures beside them, and no measurement yet says phase 1 can meet them.
6. **Whether Jon is a seat.** One human pass over the experiment sheet per
   round anchors the panel to the person whose taste it serves. _Proposed:_
   Jon is shown the sheet at each phase boundary and is not a gate.
7. **Which camera the orbit plates are taken under.** From 400 km Enhanced
   holds its fixed 30,000 cd/m² calibration and does not meter
   (`packages/rendering/src/exposure.ts`), so a bright cloud field cannot move
   the exposure, and `clearedFromOrbit` is 1 there, which is the regime where
   the composite's identity is approximate. _Proposed:_ E1 to E3 are taken
   under the default the game ships with, the capture record names the mode,
   and the cloud tops' exposure under Enhanced is a calibration the phase's ADR
   states against the scene unit.
8. **The instruments the MVP owes before a picture can be judged.** None of
   these exists on the tree, and each is work the phases schedule: a picture
   that can hold a cloud (a preset has no weather field, and
   `scripts/presets/capture.mjs` passes no setup); `ir.settled()` waiting on
   the clouds; a step detector for a moving camera (`--cast`'s detector ignores
   one by design) and a scripted, held descent for G6; the 400 km stance as a
   surface address at −88° with a solver for the local solar time (true nadir
   is clamped, and `compose` refuses a station); and the picture panel's own
   tools, which are not committed anywhere. _Proposed:_ each is a named package
   in the phase that first needs it, and the panel's tools are committed under
   `scripts/`.
9. **The ground's bar.** The plan's 2.9 ms was borrowed from other engines on
   other hardware, for a frame it had not measured. Phase 0's placeholder
   lands at 5.1–7.6 ms, and phases 1 and 2 add the higher orders, the shadowed
   air and the sea's reflection. _Proposed:_ the bar is **4.0 ms** on
   `ground`, `horizon` and `inside` at 1080p with nothing drawn over the
   clouds, which is phase 0's landed `horizon` less its second pass (5.67 −
   1.52), and the plan's 2.9 stays as the target the ADRs report against. A
   seat that wants 2.9 held, or a looser bar, says what it would cut or what
   it would let slip. This one is also Jon's to decide.
