---
paths:
  - 'packages/devtools/src/dossier.ts'
  - 'apps/game/src/planetarium/**'
---

# The record a body has

Reasoning: [ADR-0014](../../docs/adr/0014-the-record-with-holes-in-it.md),
`docs/design/planetarium.md` § "The record that is not filled in yet".

- **A field nothing has measured is a row, not an omission.** `Fact.value` is
  `string | null`; a null requires `pending`. An absent row cannot tell "this body has
  no atmosphere" from "nobody has measured it".

- **Write the reason in the universe's voice, never the engine's.** "No magnetometer
  has been flown through it", not "the generator does not produce one".
  `dossier.test.ts` greps for the vocabulary that breaks this — it cannot check that a
  reason is _true_, and one that was false about the star shipped past it once.

- **"None" is an answer and is not `no data`.** An airless body's `Envelope: None` is
  a measurement.

- **Derive; do not add a field for what the panel can compute.** Density, gravity,
  escape velocity, the synodic day, the parallax, the habitable zone.

- **Nothing about the camera belongs here.** Range, fill, the orbit angles and the
  frame id live in the author's Camera instrument.

- **Divide by the radius the body actually has.** `body.radius` is `a`. For the
  ninety-two bodies in Sol that are not spheroids it overstates the volume by up to
  two thirds — Phobos read 1.08 g/cm³ against a published 1.88, one row under its own
  mean radius. Use the volumetric mean.

- **Print the figure an almanac prints.** The sign of `rotationPeriod` carries the
  direction, so a retrograde body's obliquity is `180° − axialTilt`: Venus is 177.36°.

- **Sort for display by orbit, never by the address** (ADR-0009). A body promoted
  because the filter removed its parent sorts by the _parent's_ axis.

- **A measurement is formatted here, never by `Intl`** — `toLocaleString` takes the
  decimal separator from the reader's locale. **An instant is the opposite case**, and
  `simulationTime.ts` is right to use `Intl.DateTimeFormat`: a time zone is a property
  of whoever is looking.
