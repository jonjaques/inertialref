---
paths:
  - 'packages/devtools/src/dossier.ts'
  - 'apps/game/src/planetarium/**'
---

# The record a body has

Reasoning: [ADR-0014](../../docs/adr/0014-the-record-with-holes-in-it.md),
`docs/design/planetarium.md` § "The record that is not filled in yet".

- **A field nothing has measured is a row, not an omission.** `Fact.value` is
  `string | null`; a null requires `pending` and draws as _no data_. An absent row
  cannot distinguish "this body has no atmosphere" from "nobody has measured this
  body's atmosphere", and those are opposite claims about the same world.

- **Write the reason in the universe's voice, never the engine's.** "No magnetometer
  has been flown through it" and "the generator does not produce one" are the same
  fact and only the first may ship. The galaxy is _there_ — `projected` means the
  ship's computer worked a world out from its star's parameters, not that the world
  is fake — and the planetarium is the one screen whose whole subject is that the sky
  is not a program. `dossier.test.ts` greps every reason for `generator`,
  `procedural`, `not modeled`, `this build`, `engine` and `TODO`.

- **"None" is an answer and is not `no data`.** An airless body's `Envelope: None` is
  a measurement. Collapsing it into the same grey as an unmeasured field throws away
  the distinction the nullable value exists for.

- **Derive; do not add a field to `Body` for something the panel can compute.** Density,
  surface gravity, escape velocity, the synodic day, the parallax and the habitable
  zone are all arithmetic over what is already stored — the catalog's own "never store
  what the catalog can derive", one layer up.

- **Nothing about the camera belongs here.** Range, frame fill, the orbit angles and
  the frame id are facts about where you are standing. They live in the author's
  Camera instrument; on a page about Mars they read as a debugger.

- **The reading is formatted here, never by `Intl`.** `toLocaleString` picks the
  decimal separator from the browser's locale, so the same planet renders "6.371,0 km"
  on one machine and "6,371.0 km" on another — and a test asserting either passes
  exactly where it was written. Instruments do not translate.

- **Sort a system for display by orbit, and never by the address.** `b:2` is the third
  body _issued_ (ADR-0009); the two agree in Sol by accident. A body promoted to the
  top level because the filter removed its parent sorts by the _parent's_ axis, or
  nine moons of asteroids appear above Mercury.
