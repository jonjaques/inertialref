# ADR-0067: A preset holds its weather, and a cornerstone is a preset no list shows

Status: accepted · 10 Nov 2026 · amended 10 Nov 2026: the capture's record
carries each take's provenance and role, a cast is kept with its dropped
frames listed and refused only past a share or a run of them, every cast
starts from a settled first frame, G2 faces a sea deeper than the drawn
ground's tail, and the sun is solved over a place that moves. Amends
[ADR-0033](0033-presets-hold-a-photographic-instant.md): version 3 of the
presets format, and a second bundled list. The volume the weather draws is
[ADR-0063](0063-the-weather-draws-between-a-scene-pass-under-the-clouds-and-one-over-them.md)'s
and [ADR-0064](0064-the-clouds-march-the-field-and-the-suns-depth-is-a-grid-summed-through-the-volume.md)'s.

## Context

The weather is judged on nine pictures: Earth from the station's height at
noon, at dusk on the limb and whole; a generated wet world from a rise at
noon, on a shore under a deck, under a deck lit from below at dusk, over a
deck, inside a cumulus and on the way down from orbit. Each is judged against
photographs, phase after phase, so each has to be the same picture every time
it is taken, and it has to exist before the work it judges. A plate of
phase 1's clouds means something only beside the same picture taken on phase
0's light.

A preset is ADR-0033's fixture for "the same picture every time": an address,
a framing, a lens and an instant, decoded by one decoder whether it is
bundled or imported. Four things kept a preset from being a picture of
weather.

- **It could not say the clouds draw.** The volume draws only under
  `?clouds=1` and only when a script sets `engine.clouds` with `on: true`. A
  preset restored the camera and left the levers wherever they were, so a
  plate of a cloud depended on what the page had been told before it.
- **It could not name a weather.** A body's weather is a function of its
  record, the place and the instant, so the climate's weather needs nothing
  stored. But until each body has a climate, and in every test that wants
  one regime held over the whole body, the regime is a choice the instant
  does not carry.
- **It could not hold Earth.** Earth keeps its textured deck until the volume
  draws Earth with its shadow and its light. Outside the volume's default set
  of bodies, a picture of Earth's weather has to put Earth in by address, and
  nothing put it back.
- **Its instant could not be written down.** "The sun 50° up and falling over
  the Amazon" is an instant of a body whose spin is uniform from J2000 against
  an orbit; there is no local solar time to read it off.

And nine pictures of clouds the volume does not yet draw well do not belong
in the planetarium's list, its "Export all", the tour's offers or the plate
gate, all of which read the bundled list.

## Decision

**A picture holds its weather in an optional field, version 3 of the format,
and the pictures the weather is judged on are presets in a second bundled list
that `findPicture` searches and no player-facing list reads.**

### The format

- `weather: { regime }`, where `regime` is `'climate'` or a scenario's id
  (`weatherScenario.ts`). The part of a picture that cannot be derived is
  that the volume draws at all, and the regime standing in for the climate;
  nothing else of the weather is stored.
- Version 3 is version 2 with `weather` allowed. `decodePictures` reads 1, 2
  and 3, and refuses weather in a 1 or a 2. `encodePictures` writes 3 only
  when a picture carries weather, so an export with none stays readable by a
  build that knows only 2. A link does the same with `shot=3` and `shot=2`,
  and `weather.regime` is a dotted field like the rest.
- `isPicture` holds `weather` to its one key. It passes unknown top-level
  keys, so a field inside `weather` would otherwise ride through unread.
- **A regime's id is part of a committed format.** Ids are never renamed. A
  picture naming a regime the build does not know decodes, and reports its
  weather unavailable; it is never refused, because the file that carries it
  may hold a hundred other shots.

### Taking a picture

- `takePicture` hands the weather, or none, to the render host's
  `setWeather` after the instant is set, and its result says what became of
  it: `drawn`, `unavailable` (no `?clouds=1`, a WebGL renderer, or an unknown
  regime) or `none`. Headlessly every weather is unavailable.
- The engine writes three levers and no others: `on`, the regime as the
  scenario, and `served`, the picture's body by address when the body is
  outside the default set (`cloudsServed`: wet, and no authored deck). A
  station's picture names the body the station goes round, since the clouds
  are served on a body and a station's address names none. No
  weather, or weather the page cannot draw, turns the volume off: a picture
  never draws a weather other than the one it names. On a page with the flag
  that means an ordinary preset turns the clouds off.
- **It releases what it set,** as a presentation stance releases the switch
  it pushed. The three levers found before the first picture go back when
  the observatory lets go of its target, and every later picture starts from
  them. A picture that forced Earth does not leave Earth forced.
- A deck the volume hides no longer darkens the sphere through its map: its
  shadow yields with it.

### The cornerstones

- `packages/devtools/src/cornerstones.json` holds the nine pictures and the
  overlay guard, E1's picture with the station in it, in the same
  envelope, decoded by the same decoder, as `CORNERSTONES`. `findPicture`
  searches `PICTURES`, then `CORNERSTONES`; the id sets are disjoint. So
  `ir.preset(id)`, `?preset=` and `drive.mjs --preset` take a cornerstone.
- The generated world is chosen by a rule, the first body by cell distance
  from far-shore V that passes it: wet and plain (haze under τ 0.15, ground
  250–310 K, a day of 10–60 hours, over 3,000 km, a shore); a sky that is
  blue as the camera draws it, the air's radiance times the star's color at
  the camera's balance, from 5° to 29° up under both ground suns; a radius
  that lets G3's deck be lit from below by half a degree; a sea within 250 m
  of the datum the regimes' heights are over; and open sea from the shore,
  deep enough to draw as sea: across the frame's horizontal field, from
  250 m out to 30 km, the drawn seabed lies under the sea by the drawn
  ground's tail (`drawnDivergence`, 1.13 m on this world) and a meter more.
  Water shallower than the tail draws as sand flats, which is what G2's
  first shore drew.
  The air's zenith alone is not the sky a picture shows: it is per unit of a
  white sun, and the M dwarf an earlier rule chose drew a blue zenith orange.
  P222_3_2_k IV, under an F0V star two cells from far-shore, is the first
  that passes.
- **The instants are solved, not written.** `solarTime.ts` finds the first
  instant at or after a time the sun stands at an elevation over a place,
  rising or falling, or at the day's noon, and `ir.sun` and `ir.solveSun`
  are its verbs. The place may move: a station's sub-point is sampled at
  each instant beside the sun, and the search steps through the station's
  orbit, since the sun over the sub-point goes round once an orbit
  (`solveStationSun`). The overlay guard is solved that way, E1's picture
  from 2.5 km off the ISS at the first crossing of E1's sun with cloud
  behind the station's silhouette, and the ledger holds the committed
  picture equal to the one it solves. `cornerstoneLedger.test.ts` holds each
  cornerstone's sun to its target within half a degree, in Node, against the
  real catalog: a change to a body's frames that moves a cornerstone's sun
  fails there, before a plate is taken.
- **Each picture's weather is held on the CPU field** (`weatherField.ts`)
  under its regime, by a clause stated once in
  `apps/headless/src/cornerstoneSolve.ts` and asserted by the ledger: fair
  weather few to scattered and overcast seven oktas or more, in the frame's
  columns at an unscaled depth of 0.3; a deck broken or more; G3's deck
  ending sunward over a clear slot; E1's cells leaving two columns in five
  clear for their shadows; E2's limb at a band's crest in the frame's
  center; G5's flight clear 2 km and a margin ahead at its first and last
  frames with a cloud entered between (C6), with the field held and turned
  by the cast's seconds; and cloud on the ring the guard's silhouette stands
  over. Where a cloud stands moves as the field's packages land, so a
  stance that depends on one is the answer of a search, not a number to
  keep: `node apps/headless/src/cornerstoneSolve.ts g5 e2 guard --write`
  places each where its clause holds, and `pnpm cornerstones:ledger`
  records it.
- `ir.settled()` waits on the clouds: the system's own settle, every cache's
  owed work done and 32 frames since the history last reset, which is when
  the history's 1/8 floor has every pixel holding eight samples.

### The capture

`scripts/weather/capture.mjs` takes the cornerstones in their arms, the casts
the rubric's checks name, and settled stills along their paths, on the
rubric's one rig, into one record.

- **Every take carries its provenance and a role:** the commit and a clean
  tree, the stance as the page resolved it, the fixtures' hashes (the frozen
  references and `cornerstones.json`), the processing mode, the hash of the
  cloud levers as resolved at the capture's size, and a role (`candidate`,
  `deck`, `last-accepted`, `low-anchor`, `guard-pair`, `clouds-off`,
  `injected-defect`, `reference-run`, `settled-sample`) with the differences
  its comparison exists to make. A cast adds its presented rate and whether
  the 60 Hz hold was on. `sheet.mjs` holds the list and refuses a record a
  take of which lacks any of it; the panel's packet builder and the step
  detector read the same record.
- **A cast is kept at the rate it presents at** until a 60 Hz hold exists,
  and refused for its rate only while the hold is on.
- **A cast is kept with its dropped frames listed,** each by path frame,
  frames missed, height and path distance, and refused when it misses more
  than 3% of its path's frames or three in a row. A clouds-on drop with no
  drop in its clouds-off control within ten path frames is marked
  `cloudsOnly`, a finding of its own the classifier reports and no
  continuity check fails on. The record says how many boots the cast took.
  The 3%, the three and the ten are provisional, from the baseline at
  `4a8244e0` on the M6, where G6's worst arm missed 15 frames of 1,012.
- **A cast starts from a settled picture at its own first frame:** the path
  is put at frame 0, settled and held quiet for a second, and only then
  started.
- **The noise floor is the rig against itself:** `--pairs n` takes each still
  from 2n boots, two at a time, and writes each picture's largest changed-pixel
  count and RMSE to `floor.json`; an RMSE over 0.005 stops the run.
- A cast's frames keep their screencast instants (`timestamps.json`), so a
  gap in the stream is visible and each frame finds the path step it showed.

## Alternatives considered

**Set the levers in the capture script.** A preset's URL would then not be
the picture: a person opening the link would see another sky, and the
plate would depend on a script nobody reads beside the preset.

**Store the weather itself — cover, layers, extinctions — in the picture.**
That stores what the record derives (rule 17), and freezes a cloud field the
next phase is meant to change. The regime's name is what a phase leaves
fixed while its drawing improves.

**Refuse a picture whose regime the build does not know.** A library holding
one such shot could not be imported at all, and a build a phase older could
not open a newer phase's links.

**Add the cornerstones to `pictures.json`.** Every list a player sees would
offer nine pictures of unfinished clouds, and `presets:check` would demand a
committed plate for each before the volume could draw one.

**Write the instants by hand.** A time is a claim about a sun nobody can
check by reading it, and it goes stale silently when a body's frames change.

**Refuse a cast for any dropped frame.** No descent is then ever kept:
every G6 arm of the baseline dropped 5 to 15 frames, three boots each, at
the same heights, about 50 to 20 km up, with the clouds off. The descent
drops them, not the clouds, so the cast is refused for the path's cost and
C3, C4, C8 and the injected step can never be read. Listing the drops and
marking the clouds' own keeps what a drop says about the clouds without
discarding the cast that shows it.

**Set the instant each frame for the clock's casts.** That is a scrub a
frame, which resets the history the cast exists to watch. The clock runs
through the observatory's own clock, as a player's warp does, and the log
records the instant each frame presented.

## Consequences

A cornerstone is one command to take, and the same picture every time on one
tree. The capture set (`scripts/weather/capture.mjs`) takes each in its arms,
with Earth beside its deck, and a pull request carries the sheets.

Taking any picture on a flagged page sets the clouds' levers, which a script
driving by hand has to know: a preset with no weather turns the volume off
until the observatory lets go.

The format grew a field that encodes a choice about the renderer, not about
the camera. It is the one such field, and it says what to draw, not how.

Each regime's id is now a promise: renaming one breaks every picture that
names it, silently degraded to unavailable rather than refused.

A record without provenance, the baseline's included, is refused by the
sheet and the panel's tools as a take to compare; its plates are still read
by path as a sheet's base. A cast whose drops the clouds alone
caused is kept and reported, so a hitch at an event is visible as a finding
rather than hidden as a retake.
