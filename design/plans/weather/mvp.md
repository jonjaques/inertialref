# The weather: the MVP, and how it is judged

**Settled on 2026-11-10** by a council of three (Claude Fable 5.2, GPT-6
Astra, Muse Wonder Full 1.0) in its fourth round, each seat answering yes to
the page as it stands. Every verdict is scored against it, and a bar moves
only by §9's amendment. Three bars are provisional until the owner confirms
them (§10).

**Amended once, on 2026-11-10,** all three seats accepting each by name: C1's
zoom cast is taken from G6's start and counts only where it crosses the band
at the verdict's levers; C6 reads its 2 km at the cast's first and last
frames on a path the ledger holds clear there; B7 counts the far atlas in
blocks; the overlay guard stands at the station's own place with cloud behind
it. None moves a bar.

[The weather plan](../the-weather.md) runs to seven phases. The
MVP is the first four: the volume, its shadow and its light, on Earth from
orbit and on a generated wet world from orbit to the ground. This page says
which pictures that has to produce, how each is judged, which checks hold the
field continuous, what the frame may cost, which numbers hold it honest, and
what is left out on purpose.

Four marks recur:

- **Gate** or **declared.** Every requirement is one or the other. A missed
  gate is a no. A missed declared row stands only by §9's amendment. A row
  marked recorded or advisory is not a requirement, and a missing one blocks
  nothing.
- **Provisional.** A bar that is the owner's to confirm (§10). It is in force
  until he answers.
- **Proposed.** A tolerance the design leaves to a measurement and this page
  fixes instead. §10 gives each one's derivation.
- _Landed._ Where phase 0 stands, measured on the Mac mini (Mac18,5, Apple M6,
  32 GB) at `bbea04da`
  (`.data/clouds/campaign/landed-2026-11-10T09-05-32Z.md`).

---

## 1. What the MVP is

`the-weather` holds a solid MVP when all of this is true at one commit, the
verdict commit, at the levers the game ships with:

- Earth seen from low orbit and from `blue-marble` wears a volumetric cloud
  field with its shadow and its light, drawn from Earth's own climate with
  nothing forced, and the textured deck, its map and its 0.4% lift are gone.
  The ISS orbits at 400 km, which is where the deck's 19.6 km texels and its
  missing height show worst, so that altitude is where the pictures are taken.
- A generated wet world has weather at every height. It carries the
  ground-level pictures, because Earth's own terrain questions are open
  ([terrain](../terrain.md)).
- One field draws at every distance. A descent from orbit to the ground
  through a deck has no discontinuity (§4), on a generated world and on Earth.
- The clouds are on by default on WebGPU. No WebGL path is built for the
  weather: the project is leaving WebGL, so the plan's far-march-alone
  fallback (its §11, decision 3) does not exist, and once the deck retires a
  WebGL session draws Earth without clouds.
- Every figure below is measured on the mini and recorded in an ADR.

Earth at ground level is not judged against photographs. Its descent is
checked (§4, C5), and its surfaces wear one cloud shadow (§6, row 12).

---

## 2. The pictures

Each picture is a cornerstone: a preset that holds its address, stance, lens,
instant and weather, so it is one command to take and the same picture every
time (ADR-0033). Heights are over the ground beneath. A lens is its vertical
field.

| #   | Picture                  | Body and stance                                                           | Lens                    | Sun at the stance                                                   | Weather                                                                             | It has to show                                                                                                                                          |
| --- | ------------------------ | ------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | **Cumulus from orbit**   | Earth, 400 km, pitch −88°, over a continent                               | 11.4°, a 120 mm lens    | 50° up and falling                                                  | Earth's climate at the verdict; `fair-cumulus` held before phase 3                  | Cells about a kilometer across, each beside its own shadow on the ground                                                                                |
| E2  | **The limb at dusk**     | Earth, 400 km, pitch −19.8°, facing the sunset limb                       | 11.4°, the lens's floor | 21° under the horizon beneath the eye, 1.2° under the limb, falling | Earth's climate at the verdict; `cirrus-over-cumulus` held before phase 3           | Cloud tops standing into the orange band, the band's layers of color, a terminator that darkens. The shadows the tops lay on the air, in one named crop |
| E3  | **The whole face**       | Earth, `blue-marble`'s framing                                            | 65°                     | As the preset holds it                                              | Earth's climate                                                                     | The ITCZ, the clear subtropical belts, a stratocumulus deck off a west coast, the storm tracks' overcast                                                |
| G1  | **Fair weather**         | A generated wet world, on land, from a rise 40 m up, pitch 4°             | 50°                     | Local noon                                                          | `fair-cumulus`                                                                      | Flat bases at one height, bright tops, shadows crossing the ground                                                                                      |
| G2  | **Overcast over water**  | The same world, standing on a shore at 2 m, facing the sea                | 50°                     | 35° up and rising, hidden by the deck                               | `overcast`                                                                          | Gray light with no sun, and the deck in the sea where a blue sky stood                                                                                  |
| G3  | **Underlit at dusk**     | The same world, standing on land at 2 m, facing the sun, pitch 15°        | 55°                     | 1.5° under the horizon and falling                                  | `dusk-altocumulus`: a mid-level layer that ends sunward, with a clear slot under it | The layer lit orange from below. Crepuscular rays are scored when present                                                                               |
| G4  | **Over the deck**        | The same world, 3 km over a stratocumulus top, facing the antisolar point | 70°                     | 35° up and falling                                                  | `stratocumulus`                                                                     | The deck's cells, and the glory at the antisolar point with no shadow at its center. The cloudbow is scored when present                                |
| G5  | **Inside** (a cast)      | The same world, flying level through a cumulus at 150 m/s                 | 60°                     | 45° up and rising                                                   | `fair-cumulus`                                                                      | The range falls inside the cloud and returns to kilometers on leaving, and no frame steps                                                               |
| G6  | **The descent** (a cast) | The same world, 400 km to standing, through a deck                        | 60°                     | 45° up and rising                                                   | `stratocumulus`                                                                     | One field the whole way down                                                                                                                            |

Two stances carry a constraint the table cannot:

- **E2's lens stops at 11.4°,** because under it the terrain's patch cap
  saturates. Most ISS limb photographs are taken at 240 mm or longer, so the
  band is half the references' size at best.
- **G3's layer ends sunward,** because a layer held over the whole body stands
  in its own grazing light about 334 km toward the sun and draws as a gray
  deck. `cornerstoneLedger.test.ts` holds the base lit by at least 0.5°.

### Which weather is judged

- **At the verdict E1 to E3 are taken under Earth's own climate, with nothing
  forced.** A cornerstone's place and instant may be re-solved once, before its
  first climate plate, to where the climate holds the pictured weather. Its
  height, lens, pitch and sun stay. The regime plates of earlier phases stay
  in the record.
- **G1 to G6 hold the regime the table names.** A generated world's own
  climate is judged by C4's cast (§4).

### How each picture passes

| #   | Form           | Light    | Shadow       | Integration | Artifacts | Also                                                                    |
| --- | -------------- | -------- | ------------ | ----------- | --------- | ----------------------------------------------------------------------- |
| E1  | yes            | yes      | yes          | yes         | yes       | Every seat ranks it above the deck on Form, Light and Shadow            |
| E2  | yes            | yes      | crop         | yes         | yes       | Every seat ranks it above the deck on Form, Light and the crop's Shadow |
| E3  | yes, one under | yes      | no           | yes         | yes       | Every seat ranks it against the deck on Form. Reported (§9)             |
| G1  | yes            | yes      | yes          | yes         | yes       |                                                                         |
| G2  | yes            | yes      | no           | yes         | yes       |                                                                         |
| G3  | yes            | yes      | when present | yes         | yes       |                                                                         |
| G4  | yes            | yes      | no           | yes         | yes       | The ring's angle on the plate (§6, row 8)                               |
| G5  | advisory       | advisory | advisory     | advisory    | advisory  | Passes by §4's C6                                                       |
| G6  | advisory       | advisory | advisory     | advisory    | advisory  | Passes by §4's C3                                                       |

- **yes:** scored by the panel and held to §3.5's bar. E3's Form bar and floor
  are one point under the others'.
- **no:** the picture cannot show it. G2 has no sun, G4's shadows are under
  the deck, and E3's are smaller than a pixel.
- **crop:** scored only in E2's terminator crop. Away from the terminator the
  shadows on the air barely show at this sun.
- **when present:** scored if a seat finds it, and its absence costs nothing.
- **advisory:** the panel sees the cast's frames, and its scores gate nothing.

Every picture is a gate. The panel judges G1 to G4 from phase 2 and E3 in
phase 3. **E1 and E2 in their held regime take one recorded round at the end
of phase 2,** which banks nothing, because the plate moves when the climate
draws it. Their two-round confirmation is of the climate plates, at the
verdict. The casts are read from phase 1.

### The cornerstones exist before the work they judge

Each cornerstone is committed in phase 1's first package, with what it needs
to be taken at all: a preset that can hold weather, `ir.settled()` waiting on
the clouds, and the scripted paths of the casts. Earth keeps its deck by
default until phase 3, so until then E1 to E3 are taken with the volume forced
onto Earth.

Every phase re-takes every cornerstone on one rig in one session. Its pull
request shows each beside the last phase's plate, with the deck beside the
volume for Earth and the casts for G5 and G6, and
`design/plans/weather/README.md` keeps the table by phase and cornerstone.
That is the record. Only the verdict commit's full set gates (§9).

### The overlay guard, and anvils

One more plate is required, as a guard (§3.8): **E1's height, lens, pitch,
sun and weather, with the station or a hull in frame over the cloud field.**
The station is where its orbit puts it, so the plate is taken at the
station's own place, at an instant when its sub-point has E1's sun and cloud
stands behind the station in frame; the ledger test holds both on the CPU
field, and §2's one re-solve applies to it as to a cornerstone. A hull, if the
guard falls back to one, stands at E1's own place and instant. No cornerstone
has an object in front of the volume, and that frame is the composite's
hardest case.

Anvils at sunset are scored when a plate has them and block nothing. A tower
needs the tropopause the plan gives it in phase 4.

---

## 3. How a picture is judged

A cloud field can pass every number in §6 and still read as cauliflower. So
the still pictures are judged by eye, blind, against photographs, by the
protocol [the look council](../look-council.md) arrived at.

### 3.1 The references are frozen first

The set is 40 photographs, four or five a picture, chosen before the first
plate of any picture is taken. `references.md`, committed beside this page,
lists each with its source, credit, license, hash and capture metadata. The
images stay in `.data/`. A photograph leaves or joins the set only by a dated
note there, and never after a plate of its picture has been compared with it.

- **Each reference is shown with its caption:** its lens or field scale, and
  its one-line "misleads" note. A 400 mm frame of E1 shows cells three times
  the size the preset's field gives.
- **The packet carries E2's corrected captions.** A dated note in
  `references.md` sets them to the preset's 11.4° lens and its sun 21° under
  the horizon.
- **E3 is compared with the EPIC frames whose centroid is nearest the preset's
  sub-observer point,** because the ITCZ follows the sun.
- **G5's and G6's photographs illustrate the stages.** Neither cast is judged
  against one.

### 3.2 The rig and the packet

- **The rig is one rig.** Every plate in a round comes from one session of
  `scripts/drive.mjs` at 1440 × 900, DPR 2, sRGB forced, SDR.
- **The camera is Enhanced,** the processing mode the game ships with. From
  400 km it holds a fixed 30,000 cd/m² calibration and does not meter. If the
  shipped default changes, every cornerstone is re-taken under both modes in
  that phase.
- **The capture record carries** the commit, the stance, the fixtures' hash,
  the processing mode, and a hash of the cloud levers as resolved at the
  capture's size. §9 says which of them a comparison needs equal.
- **The settle is `ir.settled()`,** which waits for the clouds' history (32
  frames, eight samples a pixel), the shadow's slices and the cache levels in
  view.
- **The noise floor is the rig against itself, by picture.** Before any
  candidate plate exists, each baseline still is taken from five pairs of
  boots. A picture's floor is the largest difference in any of its pairs, as a
  changed-pixel count by `presets:compare`'s measure and as an RMSE. The RMSE
  is capped at 0.005 (**proposed**): a rig noisier than the cap is repaired
  before any review counts.
- **A plate moves** when either its changed-pixel count or its RMSE against
  its last accepted plate passes that picture's floor.
- **Arms.** A scene goes to the panel as lettered images: the candidate, the
  last accepted candidate, up to one experiment, and the controls of §3.3. On
  E1, E2 and E3 the textured deck is an arm, taken on the same rig from the
  last tree that draws one. Letters are shuffled per seat and per round.
- **Each arm is the full plate at packet size and one native-pixel crop,** at
  a rectangle frozen with the preset as a fraction of the frame, the same for
  every arm and for a photograph. A second crop is added only where it answers
  a named question. E2's terminator crop does: its Shadow is scored there.
- **What a seat sees.** Its packet: the images, the captioned references and
  the frozen brief. It never sees the round, the diff, another seat's words,
  or which arm is which. The only files it may open outside the packet are its
  own harness's skill files, which the brief names. A seat that opens any
  other is discarded for the round.
- **What a seat writes.** `review.json` in its packet, validated by tool: an
  integer score from 0 to 10 for each applicable dimension of each arm, a
  strict ranking where §3.5 asks for one, its named artifacts (§3.6), and
  three checkable observations about named images. The orchestrator checks the
  observations against the pixels, and a false one discards the seat for the
  round.
- **The panel's tools are a package of phase 1,** under `scripts/panel/`: the
  packet builder, the shuffler, the controls, the validator and the ledger.
  The calibration round needs them before any candidate plate exists.

### 3.3 The seats, and when one is valid

One model from each of three providers, each at high effort, a fresh delegate
every round: Claude Fable 5.2, GPT-6 Astra, Muse Wonder Full 1.0. A seat's
model changes only by the look council's rule: the new model rescores one
archived round beside the old one first.

Every round carries three controls in every seat's packet, each in a scene
chosen by the packet builder's seed:

| Control        | What it is                                                                                     | The seat is discarded for the round when                         |
| -------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Duplicate pair | One plate under two letters                                                                    | Its two scores differ by more than a point on any dimension      |
| Low anchor     | Phase 0's baseline plate of that picture                                                       | It scores the plate 6 or more on Form                            |
| Photograph     | One of that picture's first two ranked references, withheld from that seat's own reference set | It scores the photograph under 7 on Form or Light (**proposed**) |

- **A pass needs three valid seats.** A round with a discarded or missing seat
  can fail a picture and cannot pass one.
- **A seat that does not answer is missing.** It is never replaced by another
  model.

### 3.4 What is scored

Each arm is scored on the dimensions §2 gives its picture, against the
references.

| Dimension       | The question                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| **Form**        | Do the clouds have the shapes, sizes and arrangement of the genus in the references, or do they read as noise? |
| **Light**       | Tops against bases, the lit side against the shaded one, the silver lining, the color at a low sun             |
| **Shadow**      | Each cloud beside a shadow of the right length and direction, on the ground, the sea and the air               |
| **Integration** | The clouds stand in this air, on this limb, over this sea: no seam, no second model, no pasted layer           |
| **Artifacts**   | The classes of §3.6. Ten is none found                                                                         |

The scale is anchored so that three seats mean the same thing by a number:

- 10: at packet size, this dimension could be the photograph.
- 8: a convincing real-time cloud at normal viewing size, with minor
  simplifications.
- 6: plainly the phenomenon, and plainly synthetic.
- 4: reads as a graphics effect.

`Overall` is asked for and is advisory.

### 3.5 The bar, and how it is fixed

**One calibration round fixes the bar, before any candidate plate exists.**
Each still picture's scene carries a withheld photograph, the deck for E1 to
E3, phase 0's baseline plate as the low anchor, and the real-time anchor
stills assigned to that picture. The round carries §3.3's controls, needs
three valid seats, and publishes its scores in the record.

- **The real-time anchor is frozen before the round.** It is stills of shipped
  real-time volumetric clouds from other engines. Each is listed in
  `references.md` with its engine, source and hash, by the rule that freezes
  the photographs, and the images stay in `.data/`. Each still is assigned to
  the one picture whose stance and genus it matches and is shown only in that
  scene. A picture with no matched anchor says so in the record.
- **B is per dimension.** `B_form` is the mean of the Form scores over every
  anchor still and valid seat, rounded to the nearest half point, a quarter rounding down, and held
  within 7 to 8. `B_light` is the same on Light. At 8.5 three integer seats
  need two 9s, twice.
- **The floor, F, is one under the lower B, rounded down, and never under 6:**
  7 when the lower B is 8, and 6 when it is 7 or 7.5.

That round fixes `B_form`, `B_light` and F for good.

**After void calibration rounds, the owner may set the bar.** A calibration
round with fewer than three valid seats fixes nothing. Once one or more such
rounds are in the ledger, the owner may set `B_form` and `B_light` at a half
point within 7 to 8, the range a round could reach, and F follows by the rule
above. The ledger records that the owner set the bars, the source of the
decision, and the void rounds it follows. Those rounds stay in the ledger with
the scores they published. Bars set by the owner hold for good, as a round's
do, and no calibration round runs after them
(`node scripts/panel/ledger.mjs --owner-bars`).

**A still picture passes a round** when the round has three valid seats and:

1. every seat scores the candidate F or more on each applicable dimension,
   and F − 1 or more on E3's Form;
2. the mean across seats is at least `B_form` on Form and at least `B_light`
   on Light, and for E3 at least `B_form − 1` on Form;
3. no artifact blocks it (§3.6);
4. on E1 and E2, every seat ranks the candidate above the deck arm on Form, on
   Light and on Shadow, which for E2 is the crop's. The ranking is forced, so
   an integer tie cannot decide it;
5. the picture's rows of §6 that name a plate hold.

**On E3 every seat also gives a forced ranking of the candidate against the
deck on Form,** in both confirming rounds. It is reported and gates nothing:
the owner has answered §9's question in advance.

**A pass is confirmed, then banked.** A picture passes when two consecutive
rounds pass it on an unchanged plate, the second with fresh delegates and
reshuffled letters. A round in which a seat is discarded and nothing fails is
void for that picture's streak: neither a pass nor a break, whatever another picture does in the same round. A missing seat is read the same way. The pass holds until the
plate moves. Every round that is run is in the ledger, and its packets are
kept (§9), so no round is run again unseen.

### 3.6 Artifacts

A seat names an artifact as one class from this list and one region. Anything
else is described in words, recorded, and counts toward nothing.

| Class       | What the seat sees                                                           |
| ----------- | ---------------------------------------------------------------------------- |
| Banding     | Steps in a gradient that should be smooth                                    |
| Grain       | Noise or a dither pattern at the scale of a pixel                            |
| Ghosting    | A trail, or an edge drawn twice                                              |
| Seam        | A line where two resolutions, two layers or two maps meet                    |
| Stair-steps | Blocks along a cloud's edge                                                  |
| Slicing     | Parallel sheets or shells through a cloud's body                             |
| Tiling      | One pattern repeated across the field                                        |
| Halo        | A bright or dark outline where cloud meets the ground, the limb or an object |
| Cutoff      | A cloud ended by a straight line or a plane that is not its base             |

A region is one cell of the frame's 3 × 3 grid, two adjacent cells, or a crop.
With each artifact the seat says whether it shows in the full plate at packet
size or only in a crop.

**An artifact blocks a picture** when two valid seats name one class in one
region of the candidate, both see it in the full plate at packet size, both
score the candidate's Artifacts 8 or under (**proposed**), and neither names
that class on the photograph arm of its own packet. Grain that two seats
mention on a plate they score 9 does not block it.

### 3.7 What the brief tells a seat not to score

- **Surface detail.** On E1, E2 and G1 to G3 a seat scores the cloud field,
  its light and what it does to the scene: the shadow, the gray light, the
  reflection. The terrain, its cover and the sea's own texture are not the
  weather's.
- **E2:** the band's apparent size, and the absence of anvils. E2 is judged on
  color and layering.
- **E3:** cyclones and comma clouds, which are phase 4's, and the placement of
  one day's clouds. A seat judges the circulation §2 lists.
- **G3:** the absence of rays.
- **G4:** the missing aircraft shadow, the absence of a cloudbow, and the
  saturation of the one cloudbow reference.
- **A night side.** Clouds past the terminator are black (§8).

### 3.8 Guards

A guard is any preset whose plate moves and is not a cornerstone under
judgment. Every plate of a wet generated world is one from the phase that
turns the default on. Guards are gates.

- **A moved guard goes to the panel** as a blind pair against its last accepted
  plate, and each seat says which plate is worse on Integration and which on
  Artifacts. Two valid seats calling the new plate worse on either blocks the
  change. A guard that does not move carries its verdict forward.
- **"0 moved" binds a phase that does not touch shared light.** In phase 1
  `pnpm presets:compare --all` reports 0 moved. Phase 2 closes the air's two
  skylight defects, which moves every scene with a sky on purpose, and each of
  those takes its verdict.
- **The overlay guard** (§2) also needs every valid seat at F or more on
  Integration and on Artifacts (**proposed**). Its first accepted plate is the
  deck's from the same stance.

### 3.9 Numbers beside the opinions

Each sits beside the scores in the ledger, so a disagreement between a number
and a seat is visible. Each is advisory unless §6 gives it a pass value, and a
missing advisory number blocks nothing.

- **E1:** the offset from a cell's centroid to its shadow's centroid against
  `h · tan(z)`, for the sun's zenith angle `z` and `h` the layer's mid-height,
  its base plus half its thickness, from the CPU field.
- **E1 to E3:** the share of cloud pixels at display white, beside the
  references' own share.
- **G4:** the ring's peak over its trough. The ring's angle has a pass value
  (§6, row 8).

---

## 4. Continuity

The [art direction's specification](../../../docs/design/art.md#continuity--the-no-pop-in-specification)
is held as it applies to a cloud field. The requirement is **no discontinuity
attributable to reconstruction, the handover or a cache refresh.** Every row
below is a gate.

### The instruments, and when a reading counts

- **`scripts/castSteps.mjs` reads a cast against its control,** the same path
  with the clouds off, and reports only what the control lacks. It reads the
  whole frame's luminance, each cell of a 4 × 3 grid, each pair's changed
  pixels and the served opacity, and a step in any one of them is a step. A
  whole-frame mean alone misses a seam that crosses one cell.
- **A step** is a first difference that leaves its neighborhood:
  `|d − median| > max(6 · MAD, floor)` over the 16 frames around it, the floor
  the larger of 0.4% of full scale and three times the noise of a held cast of
  the same scene.
- **A flagged step is a finding to classify, and it fails nothing on sight.**
  The cast's frames around it are compared with settled samples at the same
  poses and times, and the localized frames and the field are inspected, to
  tell a real entry into cloud or an exit from a handover, reconstruction or
  cache error. Agreement with the settled samples does not establish a
  physical cause: a switch that depends on pose sits in both. A change the
  settled samples also hold is a real entry or exit only where the cast's log
  puts the eye at a cloud's boundary in those frames, by the range readout or
  `cloudFieldAt` at the eye. Any other change they hold is an error step, and
  so is a change they lack. An error step fails its check. A finding that
  cannot be resolved cannot pass. The classification is in the cast's record
  with both sets of frames and the reason.
- **The trail measure** is the mean absolute difference between two frames at
  one pose, each blurred by a box the size of a trace texel. Its floor is the
  larger of 0.5% of full scale and twice the same measure on a held cast.
- **The detector counts only from a run that proves it,** by two controls
  taken in the same run. It flags the injected step, the slow descent at
  `handoverBand` 1 with a short `maxSteps`, and the classification calls it an
  error step. It passes the continuous entry:
  G5's path taken as settled stills, one a path frame (**proposed**). Settled
  stills remove the motion's history, not every possible discontinuity, so the
  detector passes when it flags nothing where the served opacity is steady. A
  run that misses either control says its detector is blind, and no cast of it
  counts.
- **A cast's rate is part of its reading,** because its path advances a step a
  frame. Until the 60 Hz hold exists (§5) each cast's record says the rate it
  was taken at. From then a cast is taken at 58 to 62 Hz or refused.
- **A captured-frame gap is not divided away.** Where the gap's difference
  would be a step, the cast is taken again. So is a cast that captured under
  two thirds of its path's frames.

### The checks

| #   | Requirement                                                                                                  | Check, and what fails it                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Phase |
| --- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| C1  | One field at every distance. Resolution fades across a band, with no switch that can flip between two frames | The zoom cast (G6's start, 400 km up, at pitch −45°, 60° to 11.4° in 300 frames) and the slow descent cross the handover's band. A cast counts only where the ledger test holds frames of it on both sides of the band at the verdict commit's levers. An error step fails it. The band's numeric bound is §6's row 11                                                                                                                                                            | 1     |
| C2  | The handover follows pixel footprint, never altitude                                                         | C1's two casts cross the band one by a lens and one by distance, under one rule. An error step in either fails it                                                                                                                                                                                                                                                                                                                                                                 | 1     |
| C3  | A descent through a deck has no discontinuity (G6)                                                           | G6's path at 1.2% of height a frame and at 4% a frame, reentry's pace. An error step fails it                                                                                                                                                                                                                                                                                                                                                                                     | 1     |
| C4  | The default weather descends as cleanly                                                                      | G6's slow path under the generated world's own climate, with no regime override. The same reading                                                                                                                                                                                                                                                                                                                                                                                 | 1     |
| C5  | Earth's descent draws without a defect                                                                       | G6's slow path from E1's stance on Earth, under Earth's climate at the verdict. The same reading. No panel                                                                                                                                                                                                                                                                                                                                                                        | 3     |
| C6  | Inside a cloud the range falls and returns (G5)                                                              | G5's cast, judged on entry, exit and continuity. An error step fails it. So does a range under 2 km at the cast's first frame or at its last, or one that never falls inside it. The ledger test holds G5's path to this on the CPU field: 2 km or more clear along the heading at the first frame and at the last, and a cloud between. The least range is recorded. Its number is held where it is true, in a uniform medium (§6, row 21)                                       | 1     |
| C7  | The clock runs, and the field moves with it                                                                  | The camera held at E1's stance with the clock at 1×, 100× and 1,000× (**proposed**), and at G1's stance at 1×, each cast placed across an instant at which a layer's turn or the noise's origin is reduced by its period. An error step, or a strobe by `frameDiff`'s test, fails it. So does a frozen field: on the 100× cast the drawn field's displacement from first frame to last agrees with the CPU turn's, within 10% (**proposed**)                                      | 1     |
| C8  | No ghosting when the camera outruns the history                                                              | Two casts at stances that can ghost: a pass at 2 m under cumulus at 250 m/s that stops, and C3's fast descent. It fails when the trail measure between the frames 3 and 32 after the stop is over its floor. It fails when, at a quarter, a half or three quarters of the motion, the same measure against a settled still of that pose is over that floor (**proposed**)                                                                                                         | 1     |
| C9  | A cut or a scrub lands on the right sky                                                                      | `capture.mjs --cut`. It fails when the settled plate differs from a fresh boot's plate at that instant by more than the noise floor. It fails when a frame's RMSE against the settled plate rises after the event's frame by more than that picture's RMSE floor (§3.2). It fails on overshoot: in any cell of the 4 × 3 grid, a frame between the cut and the settle whose mean luminance lies outside the span from the cut's frame to the settled plate by more than the floor | 1     |
| C10 | The ground, the sea and the sphere wear one cloud shadow (rule 59)                                           | §6's row 12                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 2     |
| C11 | Nothing takes Earth's clouds away on WebGPU                                                                  | The served-set test (`weatherScenario.test.ts`, `cloudFrame.test.ts`) holds that Earth's deck is hidden only on a frame where the volume serves Earth, and that Earth joins the served set when its deck's record goes. A WebGPU frame of Earth with neither fails it                                                                                                                                                                                                             | 1, 3  |

A cast at 7.7 km/s from 400 km at a 60° lens moves the ground a quarter of a
pixel a frame. It cannot ghost, and it is not a check.

---

## 5. The budget

Costs are `ir.gpu()` taken A/B in one boot, clouds on against clouds off, on a
quiet mini, by phase 0's protocol, with the presentation rate and the levers'
hash in every row. Earth's figures are against a frame with the deck hidden.
Two sizes: 1920 × 1080 at DPR 1 (1080p), and 1440 × 900 at DPR 2 (Retina).

- **A steady Δ is the median of five A/B pairs.** A Δ over its bar by less than
  the protocol's resolution, twice the pairs' spread and at least 0.05 ms, is
  not a miss.
- **That allowance is at most 0.25 ms,** twice the largest steady spread the
  landed campaign has at 1080p, 0.12 ms. A row whose spread would allow more
  is taken again. It does not enlarge the bar.
- **A bar is an A/B delta or a whole frame.** A pass's time from `ir.passes()`
  is latency, not share, so it is recorded beside a row and no bar is formed
  from one.
- **A stance is the campaign's,** on the world its landed figure was taken on.

### Where phase 0 lands

Steady, in ms: the frame with the clouds off, with them on, and the Δ. The
campaign presents at 95 to 120 Hz at 1080p and at 59 to 120 Hz at Retina, so
no row of it is a 60 Hz row.

| Stance                          | 1080p: off, on, Δ | Retina: off, on, Δ |
| ------------------------------- | ----------------- | ------------------ |
| `ground`, under cumulus         | 5.87, 12.99, 7.12 | 13.21, 22.15, 8.91 |
| `horizon`                       | 6.26, 11.92, 5.67 | 14.03, 21.72, 7.70 |
| `inside`                        | 7.47, 12.54, 5.07 | 15.50, 23.20, 7.70 |
| `decks`                         | 2.98, 10.53, 7.55 | 6.97, 16.76, 9.79  |
| `orbit`                         | 5.19, 8.22, 3.03  | 12.82, 18.36, 5.54 |
| `earth-orbit`, deck hidden      | 3.22, 6.23, 3.00  | 7.81, 13.38, 5.57  |
| `earth-ground`, deck hidden     | 3.55, 9.74, 6.19  | 7.65, 15.50, 7.83  |
| `pair-moon`, two clouded bodies | 1.37, 10.74, 9.38 | 3.16, 13.36, 10.21 |
| `pair-neighbor`                 | 6.97, 13.94, 6.96 | 13.62, 21.92, 8.30 |

### The bars

At 1080p unless a row says otherwise.

| #   | What                                                            | Bar                                                                                                                                                                                                                                                                      | Class    | Landed                                                                 |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------- |
| B1  | Steady Δ on `ground`, nothing drawn over the clouds             | ≤ 5.0 ms (**provisional**)                                                                                                                                                                                                                                               | Gate     | 7.12                                                                   |
| B2  | Steady Δ on `horizon`, the same                                 | ≤ 4.0 ms (**provisional**)                                                                                                                                                                                                                                               | Gate     | 5.67                                                                   |
| B3  | Steady Δ on `inside`, the same                                  | ≤ 4.0 ms (**provisional**)                                                                                                                                                                                                                                               | Gate     | 5.07                                                                   |
| B4  | Steady Δ from orbit at a 60° lens, on `orbit` and `earth-orbit` | ≤ 1.6 ms                                                                                                                                                                                                                                                                 | Gate     | 3.03, 3.00                                                             |
| B5  | Steady Δ from orbit at E1's 11.4° lens                          | No bar. B6 gates E1's whole frame                                                                                                                                                                                                                                        | Recorded | None                                                                   |
| B6  | The whole frame, clouds on                                      | The 95th percentile of the GPU frame is under 14.7 ms, on every cornerstone, every campaign stance, `decks` and both `pair` stances among them, and the overlay guard                                                                                                    | Gate     | Medians of 6.23 to 13.94                                               |
| B7  | A reset: a cut, a scrub, a change of weather, a wake from orbit | Each is read as a sequence on GPU timestamps, on `horizon`. The event's own frame, which traces every pixel once, is no more than 4 ms over the steady Δ (**proposed**); no later frame is over the steady Δ plus 2 ms; and the field is whole within 48 frames at 60 Hz | Gate     | On `horizon` a cut's frame is 14.9 over the steady Δ and a scrub's 9.2 |
| B8  | Retina, the whole frame, clouds on                              | No cornerstone under 30 frames a second: the 95th percentile of the GPU frame is under 33.3 ms                                                                                                                                                                           | Gate     | Medians of 13.4 to 23.2                                                |
| B9  | Retina against 60 Hz                                            | Where the clouds-off frame holds 60 Hz and the clouds-on frame does not, the stance is a miss. It is the owner's (§10)                                                                                                                                                   | Declared | Off holds on every ground stance; on does not                          |
| B10 | Retina, steady Δ, nothing drawn over the clouds                 | Within 0.5 ms of the same stance's Δ at 1080p                                                                                                                                                                                                                            | Declared | 1.8 to 2.6 over, on B1 to B4's stances                                 |
| B11 | Something drawn over the clouds                                 | The steady Δ on `overlay`, `horizon`'s pose with the engine lit, is at most 1.0 ms over `horizon`'s                                                                                                                                                                      | Declared | None                                                                   |
| B12 | Memory, one served body                                         | ≤ 80 MB declared. That the declared bytes equal the GPU's is a test, and so a gate (§7)                                                                                                                                                                                  | Declared | 91.62 MB                                                               |
| B13 | The first frames with the clouds on                             | The largest of the first five intervals is within 16.7 ms of the steady median, at a 60 Hz presentation                                                                                                                                                                  | Declared | 50.8 to 66.8 against 16.7, at 81 to 89 Hz                              |
| B14 | Late frames                                                     | Over matched 3 s windows at a 60 Hz presentation, from orbit and on the ground, the clouds add at most 2                                                                                                                                                                 | Declared | None at 60 Hz                                                          |
| B15 | Pacing                                                          | With the presentation held at 60 Hz, each of B6's frames presents at 58 Hz or more over a 3 s window (**proposed**)                                                                                                                                                      | Declared | None at 60 Hz                                                          |

- **The field is whole** when the sun grid is at full weight, the history
  holds eight samples a pixel, and every block of the far atlas in view is
  baked since the field last changed.
- **B6's 14.7 ms is a 60 Hz frame less 2 ms.**
- **B7's 4 ms is derived from the frame.** On `horizon` at B2's bar the steady
  frame is 10.3 ms, the landed 6.26 ms with the clouds off plus 4.0. Four more
  is 14.3 ms, so the event's frame stays inside one 60 Hz frame.
- **B9 is expected to fire.** With B1 to B3 and B10 met, the ground's stances
  at Retina are 18.5 to 20.0 ms against a 16.7 ms frame.
- **B13 to B15 wait for their instrument.** Each needs a presentation held at
  60 Hz on demand, which no campaign can yet do. That hold is an instrument
  phase 1 owes. The three rows are recorded only until it exists, and they
  bind from the first campaign that has it. If it does not exist at the
  verdict, the three are declared misses, not rows that never bound.

### Recorded, with no bar

- The steady Δ on `decks`, `earth-ground`, `pair-moon` and `pair-neighbor`,
  and the declared memory with two clouded bodies (landed: 96.41 MB).
- The whole frame at Retina, clouds off and on, for every stance, with its
  rate.
- Each row's pass times from `ir.passes()`, and the boot's
  `warming the clouds` span.
- One row from the M5 MacBook Air (§8).

After this page is settled the numbers stand.

---

## 6. The numbers that hold it honest

One table. A row's instrument is what can fail it, and an instrument counts
only when its own committed test fails a known-bad input: each is watched
failing with its defect put back before it is kept.

| #   | Row                                                        | Domain                                                                                                                                                    | Metric                                                                                                               | Tolerance                                                                                                                                                                                                                                                                                                                                 | Reference                                                             | Instrument                                                       | Phase | Class                                                                                         |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| 1   | A slab's radiance                                          | §6.1, with the shipped sun. The run with the exact sun is recorded beside it                                                                              | Relative error at every grid point and held-out point                                                                | 5%                                                                                                                                                                                                                                                                                                                                        | Adding-doubling on the renderer's own scaled medium                   | `cloudSlab.gpu.test.ts`                                          | 1     | Declared                                                                                      |
| 2   | A slab's reflected flux                                    | §6.1's depths, suns and radius rows                                                                                                                       | Relative error in the flux, by eight Gauss points in `μ` and sixteen azimuths                                        | 2%                                                                                                                                                                                                                                                                                                                                        | The same                                                              | The same                                                         | 1     | Declared                                                                                      |
| 3   | The scaled medium against the true one                     | §6.1                                                                                                                                                      | The largest relative difference in radiance between the oracle's two solutions                                       | 3%                                                                                                                                                                                                                                                                                                                                        | Adding-doubling on the true medium: the whole Mie phase, unscaled `τ` | The oracle's committed table, recomputed by `slabTables.test.ts` | 1     | Declared                                                                                      |
| 4   | The furnace                                                | A uniform sky, albedo one, no sun, the air's extinction off; a slab and a broken field; the fine march and the far march                                  | Relative error against the sky's radiance                                                                            | 10⁻³                                                                                                                                                                                                                                                                                                                                      | The identity: the radiance is the sky's at any density                | `cloudFurnace.gpu.test.ts`, `cloudFarFurnace.gpu.test.ts`        | 1     | Gate                                                                                          |
| 5   | A slab's transmittance, and a layer as its steps are split | A uniform slab; a layer with `maxSteps` from 16 to 192                                                                                                    | The slab's transmittance; the layer's light between step counts                                                      | 10⁻⁴ absolute; 1%                                                                                                                                                                                                                                                                                                                         | The slab's closed form; the 192-step value                            | `cloudTrace.gpu.test.ts`                                         | 1     | Gate                                                                                          |
| 6   | The isolated cumulus                                       | Six cases: sun–view angles of 15°, 90° and 165°, a cumulus and a congestus. A rim mask and a sunward-edge mask, eight depth bins each; the core; the base | Each bin's radiance over the core's median; the rim's peak; the edge's sign and depth; the core's and base's medians | Bins 20% (**proposed**). Peak 20% in height and one bin in depth. Edge: the sign, and depth 30%; where the reference's edge is within three standard errors of its core there is no sign to match, and the march's edge is within 10% of its core. Medians 15%. Each is three standard errors of the reference's bin where that is larger | A float64 path tracer on the true medium                              | `cloudCumulus.gpu.test.ts`                                       | 1     | Declared                                                                                      |
| 7   | The phase shortcut's glory                                 | Mixed radii: a deck 5 µm at its base to 12 µm at its top, from 3 km above; a 6 µm layer over a 14 µm deck; a cumulus's flank seen across                  | Radiance within 8° of the antisolar point; the red ring's angle                                                      | 3% RMS; 0.1°                                                                                                                                                                                                                                                                                                                              | The phase taken per sample                                            | `cloudGlory.gpu.test.ts`, its measured half                      | 1     | Declared                                                                                      |
| 8   | The glory's ring and the cloudbow                          | A deck of one radius row from above (the test); G4's plate (the profiler)                                                                                 | The first red maximum's angle; the ring's peak over its trough; the cloudbow's peak                                  | In the test: one atlas texel; 10% of the scaled medium's reference; 139.7° to 142.0°. On the plate: the ring within 0.2° (**proposed**), the bow when present                                                                                                                                                                             | The Mie table's ring for the deck top's radius                        | `cloudGlory.gpu.test.ts`; `scripts/weather/glory.mjs`            | 1, 2  | Gate                                                                                          |
| 9   | Each genus in ISCCP's optical-depth classes                | §6.2                                                                                                                                                      | The shares of detected pixels by class                                                                               | §6.2's shares; at `μ₀` 0.4 no share moves ten points; the genus's mean `τ` within 15% of ISCCP-H's for its type                                                                                                                                                                                                                           | ISCCP-H's class boundaries, `τ` 3.55 and 22.63                        | `weatherCalibration.test.ts`                                     | 1     | Declared                                                                                      |
| 10  | A fair-weather field's cell sizes                          | A 60 km square of `fair-cumulus` at 100 m, on the CPU field; diameters from 200 m to 2 km                                                                 | The exponent of `n(D)`, by maximum likelihood on area-equivalent diameter                                            | 2.19 ± 0.4                                                                                                                                                                                                                                                                                                                                | Mieslinger et al. 2019                                                | `weatherCalibration.test.ts`                                     | 1     | Advisory                                                                                      |
| 11  | The handover's two marches                                 | The fine march and the far march on the real field, across footprints from `farFootprint` to the band's far edge, by pitch bin; and on a uniform slab     | Footprint-averaged transmittance; radiance                                                                           | 10%; 15% (**proposed**). On the slab, 10⁻³                                                                                                                                                                                                                                                                                                | The fine march                                                        | `cloudHandover.gpu.test.ts`, `cloudFar.gpu.test.ts`              | 1     | Declared                                                                                      |
| 12  | One cloud shadow                                           | The descent gate. Body-fixed points across a shadow's edge: lit, in the edge and shadowed                                                                 | The sun's transmittance as the ground's, the sea's and the sphere's materials each read it                           | 0.01 absolute between any two (**proposed**)                                                                                                                                                                                                                                                                                              | Each other                                                            | A `pnpm test:gpu` file on the three real materials               | 2     | Gate                                                                                          |
| 13  | One air under a cloud's shadow                             | Row 12's points                                                                                                                                           | In-scattered radiance from the composite's air and from the surfaces' air                                            | 1% (**proposed**)                                                                                                                                                                                                                                                                                                                         | Each other                                                            | `cloudLight.gpu.test.ts`                                         | 2     | Gate                                                                                          |
| 14  | Light under a deck                                         | Sun elevations of 90°, 30° and 11.5°; ground albedos of 0.06 and 0.30; a deck of `τ` 10 and of 30 (**proposed**)                                          | Downward irradiance on the ground                                                                                    | 10%                                                                                                                                                                                                                                                                                                                                       | The Monte Carlo column: the slab generator with the air and a ground  | A `pnpm test:gpu` file against the generated column              | 2     | Gate                                                                                          |
| 15  | The air's skylight                                         | Eight points on the ground and the sea, two of them past the terminator from the camera                                                                   | The skylight a fragment takes against the sky table's hemisphere at its own place and sun                            | 1% (**proposed**)                                                                                                                                                                                                                                                                                                                         | The sky table                                                         | A `pnpm test:gpu` file on the real materials                     | 2     | Declared                                                                                      |
| 16  | Earth's cover                                              | §6.3                                                                                                                                                      | Cover: global, land, ocean, and each 10° band                                                                        | 0.03 global; 0.05 land; 0.05 ocean; 0.05 in each band                                                                                                                                                                                                                                                                                     | ISCCP-H's own 2007–2016 means (§6.3). MODIS is reported beside it     | A Node test on the CPU field                                     | 3     | Gate: the three means and the twelve bands from 60° S to 60° N. Declared: the six polar bands |
| 17  | The weather is a function of `(body, place, renderTime)`   | Every still cornerstone from two boots; the climate's `sample` for any arguments                                                                          | The two plates' difference; the sample's dependence on anything but its arguments                                    | The noise floor; none                                                                                                                                                                                                                                                                                                                     | The other boot                                                        | `capture.mjs --twice`; `weatherClimate.test.ts`, a property      | 1     | Gate                                                                                          |
| 18  | The weather is not canonical                               | A world ticked with the weather evaluated between ticks and without                                                                                       | `world.stateHash()`                                                                                                  | Equal                                                                                                                                                                                                                                                                                                                                     | The hash with the clouds off                                          | `weatherCanon.test.ts`                                           | 1     | Gate                                                                                          |
| 19  | Float64 decides and float32 draws                          | Any instant to 3.2 × 10⁸ s, ten years past the epoch                                                                                                      | The field at `t` against the field at `t + 1/60 s`                                                                   | The turn's own displacement to float64 rounding, and no instant is a restart                                                                                                                                                                                                                                                              | The turn                                                              | `weatherField.test.ts`, a property                               | 1     | Gate                                                                                          |
| 20  | The thin form draws only where it is right                 | Every regime of the `error` batch, at both sizes, Enhanced off and on, on the verdict commit                                                              | The thin form's error against the identity                                                                           | A regime draws through the thin form only where the error is under 1% at the 95th percentile and under 5% at worst. Everywhere else the identity draws                                                                                                                                                                                    | The identity                                                          | The campaign's `error` batch                                     | 1     | Gate                                                                                          |
| 21  | The range inside a uniform cloud                           | A uniform medium at a genus's `σ′`, with the eye inside it                                                                                                | The range readout: the distance at which the optical depth accumulated along the ray reaches `ln 50`                 | Within 25% of `3.912/σ′`                                                                                                                                                                                                                                                                                                                  | The closed form                                                       | A `pnpm test:gpu` file on a uniform-medium fixture               | 1     | Gate                                                                                          |

Two things about the scaled medium are stated, not bounded. The glory's
contrast is the scaled medium's, about twice the true one, and a march's
transmitted flux holds the diffraction half twice, 24% high at `τ` 5 under an
overhead sun, so only the reflected flux is held. The transport's ADR declares
both.

Earth's optical-depth histogram by ISCCP type is recorded with no bar. Row 9
holds the same quantity by genus.

### 6.1 The slab's domain

| Axis         | Values                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| Bands        | 680, 550 and 440 nm                                                                                        |
| Radius rows  | 6, 10 and 16 µm                                                                                            |
| Unscaled `τ` | 5, 10, 20 and 50 on the grid; 7 and 30 held out                                                            |
| Sun          | `μ₀` 1, 0.5 and 0.2 (elevations 90°, 30° and 11.5°) on the grid; 0.7 and 0.35 held out                     |
| View         | `μ` 0.2, 0.4, 0.6, 0.8 and 1, at azimuths 0°, 45°, 90°, 135° and 180° from the sun                         |
| Reflected    | Every direction but those within 8° of the antisolar direction or between 136° and 146°, which are row 8's |
| Transmitted  | Every direction more than 6° from the sun. The forward cone is left out                                    |

The table and any fit are made on the grid and judged on the grid and at the
eight held-out pairs, so a fit's figure is not its own residual. Under `τ` 5
the errors at 0.5, 1 and 2 are recorded and no row turns on them.

### 6.2 The genus shares

Each genus is laid at its cover over a 100 km square: 40,000 columns at 500 m,
100 to each of 400 pixels of 5 km. A pixel's reflectance is the mean of its
columns' black-surface reflectance at `μ₀` 0.7. A pixel is detected at a
reflectance of 0.03 or more, and its `τ` is its reflectance inverted. A row
passes only if at least half the genus's cloudy pixels are detected, so no row
passes on a share of nothing.

| Genus, at cover                     | Of its detected pixels                    |
| ----------------------------------- | ----------------------------------------- |
| Cumulus, 0.35                       | ≥ 90% at or under 22.63, ≥ 30% under 3.55 |
| Stratocumulus, 0.9                  | ≥ 60% in 3.55–22.63                       |
| Stratus, 1                          | ≥ 90% over 3.55, ≥ 30% over 22.63         |
| Altocumulus, 0.7                    | ≥ 60% under 3.55                          |
| Altostratus, 1                      | ≥ 60% in 3.55–22.63                       |
| Cirrus, 0.5                         | ≥ 80% under 3.55                          |
| Cumulonimbus, pixels at cover ≥ 0.9 | ≥ 60% over 22.63                          |

### 6.3 How Earth's cover is counted

The count is of the CPU field under Earth's climate, with no GPU.

| Part             | Fixed as                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Years            | Ten simulated years from the epoch, the length of ISCCP-H's 2007–2016 subset                                             |
| Instants         | The 15th of each month at 00, 06, 12 and 18 UTC: 480 (**proposed**)                                                      |
| Day and night    | Both, by one rule. ISCCP-H's cloud amount is of the whole day                                                            |
| Where            | One 5 km pixel of 100 columns at the center of each cell of a 2° grid, weighted by the cosine of latitude (**proposed**) |
| Detection        | Row 9's: a pixel's radiatively averaged reflectance at `μ₀` 0.7 is 0.03 or more                                          |
| Minimum detected | At least half of all cloudy pixels are detected, or the row fails                                                        |
| Land and ocean   | By the land mask the climate itself reads                                                                                |

ISCCP-H's means, as fractions: 0.648 global, 0.555 over land, 0.684 over
ocean. By 10° band from 90° S to 90° N: 0.441, 0.562, 0.801, 0.871, 0.833,
0.708, 0.575, 0.567, 0.583, 0.657, 0.537, 0.505, 0.625, 0.719, 0.739, 0.676,
0.668, 0.629
([research](isccp-h-research.md), §6.1). The first
three and the last three are the polar bands. A field built from ISCCP-H is
not held to MODIS, which reads 0.72 over ocean.

---

## 7. Engineering and the docs

**Gates.**

- `pnpm check` and `pnpm test:gpu` are green on the verdict commit, and CI is
  green on every phase's pull request. Every test §4 and §6 name is in one of
  them, or is an instrument whose record the verdict cites.
- `presets:compare --all` moves only the plates this work means to move, and
  each moved plate has its guard's verdict (§3.8).
- The verdict's evidence is taken at the shipped defaults (§9), so nothing the
  MVP needs sits behind a diagnostic flag.

**Declared.** A missing item is a declared miss (§9), listed in the register:
a table in `design/plans/weather/README.md` with the item, its figure or its
absence, and its ADR.

- Every architectural decision has an ADR, with its `wings.mjs` row.
- The plan has lost each section an ADR now owns.
- `CONTEXT.md` carries what was measured and what must not come back.
- `docs/concepts/rendering.md` has the weather's section, the harness guide
  names the passes and the levers, and `design/plans/weather/README.md` says
  where the work stands.
- Each phase's code has had a review by layer and a council round, and each
  finding is fixed or in the register.
- Each lever that stays is a quality step or a measurement control, and its
  ADR says which.

---

## 8. Out, on purpose

None of these counts against the verdict:

- Rain, shafts, wet ground, lightning, fog, cyclones and comma clouds, the
  warp fade, the primary bow, and the temperature profile they wait on
  (phase 4).
- The moon, cities under cloud, airglow, and any night picture (phase 5). A
  night side with black clouds is expected, and the ADR that lands the light
  declares it.
- Mars (phase 6). Venus, Titan and the giants keep what they draw.
- Snow, hail, ice halos, aurora, noctilucent clouds (plan §14).
- Earth judged from the ground against photographs.
- Any WebGL path for the weather.
- Merging `the-weather` into `main`.
- **Hardware below the mini.** Every bar is the Mac mini's, and frame rate on
  a slower machine is outside the claim. One row from the M5 MacBook Air is
  recorded at the verdict with no bar if that machine can be reached. If it
  cannot, the verdict says the row was not taken.

---

## 9. The verdict

Two bodies do two jobs, and they are kept apart.

- **The picture panel** is §3: blind, fresh delegates each round, scoring
  images against photographs. It answers whether the pictures pass.
- **The council** reads this page and the evidence. It is the three models
  §3.3 names, at high effort, read-only, and its delegates are different
  instances from the panel's. Each seat scores the MVP out of ten and answers
  one question: is this a solid MVP by this page?

**One commit and one lever hash bind the candidate's acceptance evidence.**
Every plate, cast, cost and test run the verdict cites for the candidate is
from the verdict commit at the shipped defaults. The hash is of the levers
resolved at the capture's size, and evidence is matched within a size. The
council refuses candidate evidence whose commit or hash differs.

**Everything the candidate is compared with is a comparator.** The deck arm,
the photographs, the anchors, the last accepted candidate, guard pairs,
clouds-off controls, injected-defect runs and reference runs each have a named
role and a record of their own, and what has to match depends on the role.

- **A capture of this renderer** (the deck arm, the last accepted candidate, a
  guard pair, a clouds-off control, an injected-defect run, a reference run)
  is compared when the rig, the stance, the fixtures' hash and the processing
  mode agree, apart from the differences that comparison exists to make, which
  its record names. The commit and the levers are what such a comparison is
  between.
- **A photograph or another engine's still** follows §3.1's and §3.5's rules:
  its source, hash, caption and the scene it is matched to. It needs no rig,
  fixtures' hash or processing mode of this renderer's.

**The work is done when all three seats answer yes in one round.**

- **A yes cites its evidence.** Section by section of this page, the seat names
  the file, the test or the record it opened. A test is cited by its name and
  its result, a cost by its campaign file, a picture by its ledger rows.
- **A missed gate is a no.** The seat names the row and the evidence that would
  change its answer.
- **A declared miss stands only by amendment.** It has an ADR with the measured
  figure, the verdict lists every one, and all three seats accept each by name,
  in writing. That acceptance is the amendment of this page. An ADR alone
  waives nothing.
- **A round with a missing seat has no verdict.** It is recorded and run again.
  A gate or a declared row with no record is not met.
- **Packets are kept.** The panel's packets, briefs and reviews, the
  calibration round's, and the council's verdict packet are archived in the
  main checkout's `.data/` and indexed from the record, so a later argument
  about a bar can be checked against what the seats saw.
- **Findings outside this page are recorded as later work** and do not hold
  the verdict.

**Three calls are the owner's** (§10). He is also shown the experiment sheet at
each phase boundary, before the scores, and is not a gate on it.

**The whole face against the deck.** E3 passes on §3.5's bar against EPIC.
The owner chose "Retire it regardless" in a dialog on 2026-11-10: the deck
goes once the volume passes E3's bar against the satellite photographs, even
if two panel seats rank the deck above it on Form in either confirming round
(§3.5). The forced ranking is still taken and reported. Keeping the deck at
distance is a second model and is not offered. The answer is recorded in the
[handoff's record](README.md#the-record).

---

## 10. Open after this draft

### The owner's to decide

| Item                                                                                                     | In force until he answers                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The ground's bars, B1 to B3                                                                              | 5.0 ms on `ground`, 4.0 on `horizon`, 4.0 on `inside`. The plan's 2.9 is the reported target                                                                                                                              |
| A Retina miss, B9                                                                                        | The verdict lists each stance that holds 60 Hz without the clouds and not with them. He accepts each by name, or the Retina default takes a cheaper lever and the Retina plates and costs are taken again at that default |
| The deck's deletion, if two seats rank the deck above the volume on E3's Form in either confirming round | **Answered:** "Retire it regardless" (2026-11-10). The deck goes once the volume passes E3's bar; the forced ranking is still reported ([record](README.md#the-record))                                                   |

### Proposed here

The design leaves each of these to a measurement or names no figure. The
council settles them with the page.

| Where      | Proposed                                                                       | Derived from                                                                                    |
| ---------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| §3.2       | The noise floor from five pairs of boots, its RMSE capped at 0.005             | The top of the look council's range for a rig against itself on streamed terrain                |
| §3.3       | A photograph under 7 on Form or Light discards the seat                        | A photograph is the scale's 10, and the control draws from a picture's two best                 |
| §3.6       | An artifact counts only from a seat that scores Artifacts 8 or under           | The anchor for 8: what does not show at viewing size is not a defect                            |
| §3.8       | The overlay guard's floor of F, and its first accepted plate                   | The floor of §3.5; the deck is that frame's only plate before the volume draws it               |
| §4         | The detector's continuous entry is G5's path as settled stills                 | They hold the real change of entering a cloud without the motion's history                      |
| §4, C7     | The clock at 100× and 1,000×, at E1's stance                                   | Both are under the clock's 1,920× cap. At 1,000× a frame moves the low level 1.5 of E1's pixels |
| §4, C7     | The field's displacement within 10% of the CPU turn's, on the 100× cast        | Over the cast the low level moves 4 km, 45 of E1's pixels: enough to measure and to register    |
| §4, C8     | Smear during motion is the trail measure against a settled still, at its floor | The design's own measure and floor, on a second pair of frames                                  |
| §5, B7     | The event's frame within 4 ms of the steady Δ                                  | One 60 Hz frame: 10.3 ms steady on `horizon` at B2's bar, 14.3 with it                          |
| §5, B15    | Pacing, 58 Hz over 3 s                                                         | The band the design refuses a cast outside, 58 to 62 Hz                                         |
| §6, row 6  | A bin within 20%                                                               | The silver lining's own bound, read from the same curve                                         |
| §6, row 8  | The ring within 0.2° on the plate                                              | Two of the profiler's 0.1° bins: the radius blend's shift, and the bin                          |
| §6, row 11 | Transmittance 10% and radiance 15% across the band                             | The design's bounds for the far march against the fine one, which the band blends               |
| §6, row 12 | 0.01 absolute                                                                  | The plan's 1%. A relative bound has no meaning in full shadow                                   |
| §6, row 13 | 1%                                                                             | Both airs take the same two taps. The bound is the sky table's own                              |
| §6, row 14 | The suns, the albedos and the depths                                           | The slab grid's suns; open water and bright land; a thin and a thick overcast                   |
| §6, row 15 | 1% at eight points                                                             | The bound the sky table is held to against the air's own march                                  |
| §6.3       | 480 instants, one pixel a 2° cell                                              | Four hours a day in every month of ten years; about 430,000 samples a band                      |
