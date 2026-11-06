# The look council: a blind hill-climb for a rendered look

A plan for the second version of the experiment that took Earth from orbit
back toward production on #179: one orchestrator changes the renderer and
takes the plates, three reviewers from three providers score them blind, and
the climb runs until they agree. This records what the first run taught and
how the next one is built. The figures are from the run's ledger
(`.data/look-council/ledger/history.csv`); the proposals are a first draft.

## What the first run was

- 24 scenes as picture fixtures: 8 Earth-from-orbit scenes scored against a
  reference (Part A), 16 more as blind top/bottom pairs with one control
  (Part B).
- One reviewer from each of three providers, a fresh delegate every round, a
  frozen brief, a randomly named packet of images and nothing else.
- Up to three changes a round, a revert rule on a 0.5 drop, a stop at eight
  rounds.
- Result: the council's mean overall went from 3.0 in round one to 7.0 in
  round seven, the best of eight; the Part A mean from 3.5 to 7.9. Mean RMSE
  to the reference over the eight Earth scenes fell from 0.042 to 0.020 on the
  frame and from 0.071 to 0.030 on the limb crops. The pass bar (every seat
  at 9) was not reached: one seat said `ship` in rounds seven and eight, two
  never did, and every seat preferred the reference on two of Mars's views.

## What worked

- **Blindness held.** No reviewer ever saw another's words, the round, the
  diff or a hint. The control pair scored a gap of zero in all 24 reviews, so
  no seat was inventing differences.
- **Proof of looking.** Three random observations per review, checked against
  the images, caught nothing false in eight rounds; the requirement alone
  seems to keep reviews honest.
- **Pixel distance beside opinion.** RMSE against the reference over full
  frames and limb crops was the orchestrator's fast loop: each experiment a
  tier-A capture of about ninety seconds, judged by number and
  by eye before anything reached the council.
- **One provider per seat.** The seats disagreed for real reasons — one read
  Part B ground scenes as decisive, one weighted the limb, one the face —
  and consensus across them was a strong signal.

## What went wrong, and the fix for each

### The reference was not the rig's

The baselines were taken on a display that was gone by the time the climb
ran, and the fixtures were rewritten three minutes after them. Every local
plate sat 0.015–0.026 RMSE off its baseline with a cool cast, the same for
both builds. The climb re-shot production on the day's rig and used that.

- Capture the reference **with the candidate, on the same rig, in the same
  session**, every round, or at the start and the end. A reference is a
  plate taken under the conditions the candidate is taken under, not a file.
- Pin the color pipeline: record the display, its profile and Chrome's
  `--force-color-profile` in `capture.json`, and refuse to compare two
  captures whose records differ.
- Hash the fixtures into every capture record, and refuse a comparison
  across hashes.
- Calibrate with **rig against itself** (the noise floor, here 0.0001–0.0005
  on static scenes, 0.002–0.005 on streamed terrain) and **build against
  build on an untouched scene** (here 0.0003) before the first review.

### Part B measured the reference's defects as much as the candidate's

Production draws a starry, unlit afternoon and a sun through the ground. Two
seats inferred, blind, that the broken half might be the candidate and held
`ship` and `overall` down for it; one seat's overall swung 6 → 4 → 6 on
ground scenes that had not changed by more than noise since round two. That
swing triggered the revert rule in round six (mean overall 6.83 → 6.17) while
the Part A mean did not move (7.79 → 7.79). The candidate won more Part B
pairs than it lost in 21 of 24 reviews, and Earth's ground scenes, won by
2–6 points every round, never lifted `overall` past what the orbit allowed.

- Split `overall` into **`overall_orbit`** (the goal) and a separate
  **regression verdict** per Part B scene. Score the climb on the goal; gate
  it on regressions.
- Show Part B only for scenes whose candidate plate moved beyond the noise
  floor since the last review, and carry the previous verdict forward for the
  rest. Telling reviewers which groups were touched would do the same with
  less tooling, but it is a hint, and blindness is worth more than the
  tooling.
- Ask the regression question **against the last accepted candidate**, not
  against production. Production is worse than the candidate on purpose in
  the keep list's scenes, so a pair against it measures the keep list again
  every round; a pair against the last accepted plate measures only this
  round's change.
- Run the revert rule on Part A and on the regression verdicts, not on
  `overall`.

### One number cannot separate "different" from "better"

RMSE rewarded the veiled disk over the clear one in round two, because the
veil happened to add the brightness the clear disk lacked. Reviewers asked
for things RMSE punished (a warm crescent, a terminator haze).

- Keep RMSE, and add measures per question: mean color in a few named
  regions (near-limb ocean, a desert, the terminator band), the rim's width
  and peak color from a radial profile, the band's layer heights on the
  sunset limb. These are cheap with ImageMagick and map one-to-one to the
  brief's dimensions.
- Show the reviewer's dimension scores and the matching measure side by side
  in the ledger, so a disagreement between them is visible.

### Rounds were slow and serial

A round was capture (~6 min), packets, three reviews (~10–20 min each, in
parallel), validation, scoring, and then experiments. Eight rounds took most
of a night.

- Let reviewers score **two or three candidates per round** as additional
  blind arms (A/B/C against the reference), with the arms shuffled per seat.
  The orchestrator then keeps the winning arm instead of guessing which of
  its experiments the council would prefer.
- Pre-render the packets for every experiment while the reviews of the last
  round run; the GPU is idle then, and the rule against two GPU jobs is not
  broken by a queue.
- Cut Part A crops to what is judged: the full frame at review size and one
  native crop is enough; four images per scene doubled the reading time.

### The brief and the packets cost the orchestrator its context

Every delegate's task was the frozen brief plus a 60-line listing, pasted by
hand, three times a round. Recording each review verbatim meant reading the
child's last message out of T3's state store.

- A `packet.py --emit-task <seat>` that writes the full task text to a file,
  and a delegate call that takes a file, or a short task that says "open the
  file `brief.md` in your packet" with the brief inside the packet (and the
  brief amended to allow it).
- Reviewers write their JSON to `review.json` in their own packet directory
  instead of the chat reply; the orchestrator validates the file. The packet
  then holds everything the round needs and the ledger copies it.
- A `council.py round N` that chains capture, sheets, packets, emit-task and,
  after the reviews, validate and score, so a round is two commands.

### The rig had flakes nobody owned

The HUD toolbar appeared in subset captures despite `chrome=0`; a compare
left its Chrome up and the next capture timed out on it.

- `capture.py` checks the bottom-center crop for the HUD and retakes the
  scene once, then fails loudly.
- Every tool that launches a rig brings it down in a `finally`, and the next
  tool's refusal names the leftover rig and offers the exact `--down`.

## Changes to the protocol

- **Scope the changes per round by evidence, not by count.** Three changes a
  round was right as a ceiling; what helped more was one experiment per
  defect with its measure, and only measured winners committed.
- **A change carried by a reverted round may come back** once a different
  change has been tried, if the council names its defect again — make that
  explicit rather than a judgment call.
- **Confirmation round** stays, but on the same arms with reshuffled packets,
  and only when the pass bar is met.
- **The pass bar** at 9 from every seat was out of reach for a look that has
  to keep a different physics underneath. Express it per dimension instead:
  limb thickness and edge ≥ 8.5, color ≥ 8, no new artifacts, no regression
  verdicts. `overall` becomes advisory.
- **Stall rule** on Part A, not on `overall`.

## Changes to the instruments

- A **radial limb profiler**: given the disk's center and radius in the
  fixture, sample the rim along 36 spokes and report width at half maximum,
  peak color and standoff from the disk. That turns "halo 4–7% of the radius
  off the disk" from a reviewer's estimate into a number.
- A **band profiler** for the sunset limb: the heights of the orange, white
  and blue layers along the vertical through the sun.
- A **terminator profiler**: luminance and hue along the line from the
  subsolar point across the terminator.
- An **experiment sheet** per round: the reference, the last accepted
  candidate and every experiment in one image per scene, which is what the
  orchestrator actually looked at to choose.

## Stronger models

The next run should seat each provider's strongest model of the day, at its
highest reasoning effort, and keep one provider per seat. The first run's
seats read the plates well enough to agree on direction and disagree on
weight; what they could not do reliably was estimate a rim's width as a
fraction of the radius or tell a small color shift from noise, which is where
the instruments above take over. A stronger seat is measured, not assumed:
rescore one archived round (its packets are kept) with the new seat beside
the old, and check both against the profilers before trusting the swap. The
orchestrator gains as much as the seats: most of a round's judgment was
choosing which experiment to put in front of the council.

## The second run

The second run took the protocol above into `.data/look-council-2` and ran
it over three phases — Mars, Titan, the exoplanets — against production
captured on the same rig, with #179's Earth from orbit and #172's ground
views as guards. What it kept from the list above, and what it found.

### What the protocol did

- **The reference was the rig's.** Production, every candidate and every
  guard were captured on one rig in one session at 1440×900, DPR 2, sRGB
  forced, SDR, with the display, the commit and a hash of the fixtures in
  every `capture.json`; the tools refuse to put two captures side by side
  whose rig records disagree. The settle is the sensor's, nine time
  constants after the scene stands still, so two captures of one tree agree
  to 0.0001 RMSE where run one's Mars dusk sat 0.015 from itself.
- **Arms, not rounds.** Each round put the incumbent and two arms in front of
  the council as blind letters per scene, with every guard that moved past
  the noise floor as a regression pair and one control pair. An arm won by
  paired gain over the incumbent beyond `max(0.25, z·SE)` with alpha split
  across the arms, every seat in favor, and no regression pair flagged by
  two seats. Round 1's winner gained +0.78 against a bound of 0.64; rounds
  2 to 6 gained −0.29, +0.08, +0.19, +0.22 and +0.19 and lost, the last
  three with every seat in favor.
- **The measures chose the arms.** Rim width and color, standoff, the
  sunset band's layers, the ground's zenith and horizon, and whole-frame
  RMSE against the noise floor, from a fast capture of the scenes an
  experiment should move. Three iterations on the dust-is-the-sky arm ran
  on measures alone before the council saw one.
- **Seats were calibrated before they were trusted.** Each provider's
  strongest model at its highest effort rescored run one's round seven
  beside the old seats and the profilers; Muse Wonder Full 1.0 replaced
  Wonder 1.0 on that evidence (rank correlation with the old seats 0.93
  against 0.48). Every review was checked: every image opened, no file
  outside the packet, the control pair within a point, three observations
  per seat verified against the images.

### What it found

- **The council agrees on direction and the measures cannot read it.** All
  three seats asked, round after round, for the same three things on Mars:
  a thin attached butterscotch rim with a pale hairline over it, no glare
  through the ground that hides the sun, and a dusk that darkens. Two of
  the three are the camera's — the meter opens for a dark sky and the
  summit's aureole blows — and one is the flare's analytic occluder.
- **A fine line reads as an outline at the packet's scale.** The ice layer
  over Mars's rim is a two-pixel paling in the crops and a "uniform white
  outline" to every seat on the plates, and the tan line it caps ranked
  higher every time. A rim's structure needs the crop beside the plate and
  a question about the crop.
- **A single-scene fix cannot win a twelve-scene round.** The floor of 0.25
  on the paired gain is a quarter of a point over the mean; a glare fixed on
  one scene is +0.11, however every seat asks for it. The next run should
  carry a defect lane beside the hill-climb: a change that removes a named
  defect on the scenes it names, moves nothing else past the noise floor,
  and is called better by every seat on those scenes, lands.
- **One harness loads its own skill and the rule discards the seat.** The
  Codex seat opened `~/.agents/skills/unslop/SKILL.md`, listed it honestly
  under `opened`, and the strict packet rule threw the review out, twice in
  one round. The rule should name the harness's own files as allowed.
- **The defects that did not land are logged.**
  [`look-council-defects.md`](look-council-defects.md) carries every one a
  seat reported, with its status and the patch that fixes it where one
  exists, so the next run starts from the list and not from the reviews.

## Open questions

- Should the owner be a seat? One human pass per round on the experiment
  sheet would anchor the council to the person whose taste it serves.
- Is a reference the right target at all when the owner wants "much closer
  to production" but keeps parts of the branch? A target built from per-scene
  choices (production's orbit, the branch's ground) might be clearer than
  one reference with a keep list beside it.
- How many seats? Three disagreed usefully; a fourth provider would show
  whether a seat's swings are the seat or the scenes.
- What do Mars's limbs need? In the best round every seat preferred the
  reference on the sunset limb and on the raking view. They need their own
  target in the next run, not a side effect of Earth's.
