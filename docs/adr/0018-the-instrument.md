# ADR-0018: The instrument the lens is operated from

Status: accepted · 2026-08-28

## Context

[ADR-0017](0017-the-lens.md) gave the camera a lens and the terrain a predicate
that reads it. What it did not give anybody was a hand on either. The
planetarium is the mode whose entire subject is _looking_, and its controls for
looking were spread across three surfaces, two of them behind a disclosure meant
for the author.

| Surface                 | Held                                                                                 | Reached by                     |
| ----------------------- | ------------------------------------------------------------------------------------ | ------------------------------ |
| **View** panel          | Layers — names, traces, the ship — and a Lens section beside them                    | the planetarium menu           |
| **Shots** panel         | Nine drawn compositions relative to the subject                                      | the planetarium menu           |
| **Camera** instrument   | All four lens channels, the Optics readouts, the observatory's pose                  | the `` ` `` disclosure         |
| **Navigate** instrument | Go to, a destination list, seven ship bookmarks, cutscenes, scenarios, the self test | the `` ` `` disclosure, or `G` |
| **Ship bookmarks**      | Seven more compositions, placed by teleporting the ship                              | `ir.shot`                      |

Seven facts followed from that table, and each is about the build rather than
about taste.

**The camera had no panel in the mode that is about looking.** The aperture, the
focus and the exposure were reached by pressing the console key. The View panel,
whose title is a claim about what is drawn _over_ the sky, carried two of the
four lens channels beside the layers, and the author's Camera instrument pointed
the reader at "navigate → shots", a section that composes the ship.

**Two lists of compositions shared a vocabulary and not a mechanism.** `gibbous`
in the panel and `gibbous` in `shots.ts` came out of one solver and meant one
picture, but one moved a camera and the other teleported a hull. Three existed
only for the hull — `glint`, `sunset`, `oblique` — because they aim somewhere
other than the body's center, and `observerPose` is `lookAlong(−offset, up)`,
always.

**Earthrise was a crescent.** The shot was `{phase: 132, tilt: 8, fill: 0.32}`:
the subject, small and low. The photograph the name belongs to is taken from
110 km over Luna with Earth a few degrees above the limb — a picture of two
bodies, in which the subject is the one being stood on.

**The observatory looked at one point**, so there was no way to look at a limb,
at a moon beside a disk, or at the sky; and on the ground, where heading and
pitch exist, no gesture drove them — the orbit writers refuse while standing and
nothing else listened, so a drag on Miranda's summit did nothing at all.

**Navigate was the product's navigation, filed under the author's
instruments.** In the planetarium its Go to, Orbit and Land teleported a ship
nobody could see, so the panel appeared to do nothing; in flight, where
`FlightMode` contributed no panels, it was the only way to go anywhere.

**Six window-level `keydown` listeners, two key models, and labels that
hard-coded the keys.** Two read `event.key` and four read `event.code`, which is
why `+` carried a comment about `Shift`. Six key names were string literals
across five files, and two hand-maintained help tables described them —
while [ux § controls](../design/ux.md#controls) said everything is rebindable
and `/settings/controls` printed a list and said rebinding was not built.

**The preferences had guards and no census.** Every key was validated on the way
in and nothing could list them, so nothing could export them, and a second
machine started from the defaults.

The forcing function is the next phase. Phase 2 of [the terrain
plan](../../design/plans/terrain.md) is the geology, and its acceptance criterion is a
plate review — "reads as a Moon, not as noise". Plates are composed through
these controls. A geology reviewed by dragging a camera that can only look at a
body's center, with the aperture behind the console key, is judged through the
wrong instrument. That is the argument ADR-0017 made about the predicate, one
step further out.

## Decision

### The aim is an offset on the pose, and it persists until the pose is replaced

`observerPose` takes a `LookOffset` — two angles composed after the centre-aim
orientation, yaw first so a look that is up and to the left does not arrive
rolled. On the ground the offset _is_ the heading and the pitch, which the
stance already holds.

**A zero offset returns the base orientation itself**, not its product with the
identity. The product is exact for every field, but the compositions are fitted
against that pose and stating the claim as a branch is what makes it hold under
a later change to `multiply`.

**The offset is cleared by whatever replaces the pose and by nothing else** — a
focus, a frame, a stand, a composed set of angles. Not a drag, not a dolly, not
leaving and re-entering the mode, so a viewer who turned to look at Io beside
Jupiter is still looking at Io after the wheel.

Two ways in, because there are two kinds of hand. The secondary button drags the
look and suppresses the context menu on its own surface only — a sky has no
menu, and taking the menu off the document would be the interface reaching
outside itself. `L` and a switch make the primary drag and the arrow keys look
instead, which is the only way in on a phone and with a keyboard alone.

**A drag moves the picture by the pixels dragged, at any lens.**
`DRAG_RADIANS_PER_PIXEL` is a constant, so at 8× zoom a 100 px drag swung the frame through three of its own
field-widths. The sensitivity is `pixelAngle(lens,
viewport)`, so the ground under the pointer follows the pointer. The lens exists,
and this is one of the things it is for.

### Compositions are one list with two placers

`aim: centre | limb | specular` is a solve for a look offset — where the point
falls on the sphere, and the two angles that put it in the middle of the frame.
With the solve in `packages/rendering`, the ship bookmarks and the drawn shots
are one list, with two placers: the ship's, which teleports, and the
observatory's, which moves a camera.

**A composition below the orbit floor lands on the surface arm.** The two arms
meet exactly at `MIN_DISTANCE_RADII`, and `sunset` at 1.04 radii _is_ a stance
four hundredths of a radius up. Saying so is what makes it a planetarium picture
rather than something only a hull can take — and the horizon levels for free
down there, where `placeShot` has to ask for it through an `upHint`.

A composition names its standoff as a `fill` or in `radii`, never both. A fill
is a fraction of the frame height, so it moves with the lens, which is what a
drawn framing is for; radii are lens-independent, which is what a bookmark
composed against a photograph is for.

### A rise is a two-body composition, and it says which two

`riseStance(radius, toParent, height, clearance, fov)` puts the eye on the great
circle from the sub-parent point, at the angular distance where the parent sits
`clearance` above the horizon, heading on its bearing, pitch at the horizon's dip
plus a sixth of the field so the horizon lands on the lower-third line.

**`toParent` is a displacement, not a direction**, and that is the whole of the
arithmetic. Read as a direction the answer is wrong by `asin((R + h)/d)` — 0.28°
for Earth from Luna, against a clearance being solved for of 3°, so 9% of the
answer. The quadratic in `cos θ` closes; both roots satisfy the squared equation
and only the one whose `d·cos θ − r` agrees in sign with `sin α` satisfies the
original. The other stands the eye on the far side of the body with the parent
under its feet.

**The lens is solved with it.** Earth is 1.90° across from Luna and Mars is
42.39° from Phobos — twenty-two to one — and one focal length is not the picture
for both. `riseFov` clamps to the slider's range, which is doing real work at the
long end: Earthrise wants 11.4° and stops at 20°, where the terrain predicate
saturates. That is a stated limit, and the lens below 20° is its own phase.

### Presets are two tiers, and the top one is a picture that already exists

A **picture** is a composition plus the two things a composition leaves out: an
address and a lens. It produces the same frame every time it is pressed, which
is what makes it a fixture — and a fixture is what a before/after plate is.

**Their thumbnails are plates**: captured through `scripts/drive.mjs` and
vendored, because a drawn diagram of a picture that exists is a worse thumbnail
than the picture. `pnpm presets:plates` regenerates them and `presets:check` is
in `pnpm check`, the way `brand:check` proves the mark. Vendored rather than
generated at build time for the reason `og-plate.png` is: a build that needed a
GPU would not run in CI, on a fork, or on a machine with no display.

A plate is taken with the chrome cleared **and the layers off**, and those are
different claims. Chrome is the interface; names and traces are content, which
is why `Shift+H` clears the first and leaves the second. But a thumbnail of a
picture is a thumbnail of what the _camera_ does, and a trace slashing across a
plate promises a layer the press does not set. So `labels` joins `showOrbits` as
a presentation stance and `ir.layers` is the verb.

A preset sets the camera and nothing about the layers. Names and traces are the
viewer's, and a button that turned them off would be the interface reasserting
itself.

### One key dispatcher, actions by id, chords by `code`

`apps/game/src/input/keymap.ts` holds `ACTIONS` — id, label, group, context,
default chord, whether Shift is a magnitude, and whether a focused control may
decline it. `KeymapStore` is the single window listener. A mode registers a
handler for an id and never sees a key; the editor moves a chord and never sees
a handler; a label prints the live chord for an id and never contains a key name.

**A chord is a physical key.** `+` _is_ `Shift+Equal` on every layout this ships
to, so a handler reading `event.key` sees a modifier that carries no information.
A binding tied to the physical key is the only kind that survives a keyboard
change. The _label_ goes the other way: `navigator.keyboard.getLayoutMap()` where
it exists, a US table where it does not — and the shifted glyph is used only when
the layout agrees with that table, because `Shift+Slash` is not `?` on a keyboard
where `Slash` types `:`.

**Contexts decide what is live, and conflicts are checked against every set of
contexts that can be live at once.** `F` translates down in flight and frames in
the planetarium, which is not a conflict because nobody is in both — but `global`
_is_ live alongside everything, so the naive rule ("conflicts within a context")
misses the pair that actually shipped as a bug: `Space` was the pause key and the
cinema player's transport, both handlers ran, `clock.paused` flipped twice, and
the documented control did nothing at all with nothing to see in the console.
`LIVE_SETS` enumerates the app's states, an ambiguity is two actions at the same
specificity, and a shadow is an inner context taking a chord an outer one holds.
There are four shadows and every one is deliberate.

The editor refuses `Tab`, `Escape`, `F11`, `F12` and anything with `Meta` or
`Ctrl` — but that is a refusal to _rebind_, not to dispatch: `Escape` is the
cinema library by default, and refusing to read it would leave that binding with
nothing to fire it.

Three shell flags disappear into contexts. `axes: mode === 'flight'` is a
context claim. `pause: mode !== 'cinema'` is the cinema being more specific.
`mode !== 'docs'` is the reading room muting `time.pause` where the reading room
is, rather than the pause binding carrying a list of modes it is not in.

### Navigate is deleted; the Catalog is the one navigator

The Catalog is in both workspaces, with a verb that depends on the mode: a row
looks in the planetarium and offers Orbit, Land, Face and Burn in flight.
Cutscenes, scenarios and the self test are a Harness section on the Controls
instrument, which is where scaffolding belongs. `G` is unbound and stays
reserved for the galaxy map. The alternative — a smaller author's Travel panel —
keeps two navigators, which is the ambiguity this exists to remove.

### Preferences are a registry with one storage call site

`apps/game/src/state/preferences.ts` declares every key once: default, guard,
revive, migrate, and a group. A call site takes a **definition** rather than a
key string, so a preference that does not exist is a name that does not resolve.
Dynamic keys are families with a prefix, one guard, and a per-member default
override.

**`localStorage` is called from that file and nowhere else in
`apps/game/src`** — not for tidiness, but because the export, the import and the
live subscription each have to know the whole set, and none of them is possible
with the calls spread across five modules. Applying an import reaches the mounted
hooks through that subscription, so nothing reloads; a reload here rebuilds the
`WebGPURenderer` and loses the camera.

An export carries what somebody chose rather than what the registry holds:
exporting the defaults would turn a fresh profile's file into a snapshot that
pins today's defaults on every machine it reaches, and an absent key has to keep
meaning "the default".

## Consequences

**Provable by grep, which is the point.** One `addEventListener('keydown'` in
`apps/game/src` outside tests, one `localStorage` call site, and no key name
written as a string literal in a label.

**Three invariants in [`AGENTS.md`](../../AGENTS.md)**, mirrored in
[`.claude/rules/react-shell.md`](../../.claude/rules/react-shell.md): never a
second window-level key listener, never a `localStorage` call outside
`preferences.ts`, never a key name in a label.

**The plate rig has to run in the planetarium.** `ir.preset` moves the
observatory, and the observatory only produces a camera while a layer is holding
it — a stance the planetarium pushes on mount. Run from the menu, every verb
succeeds and every plate is a picture of the menu: seven files, all the right
size, all wrong. The capture script names the page for that reason.

**Two host ports arrive with it.** `setFlightLens` lets `ir.preset` and
`ir.rise` fit the lens they solve, and `setChrome`/`setLayers` let a script reach
the state a plate is defined to be taken in. None of them is a second producer of
anything: the lens port writes the same flight lens a slider writes, and
`engine.lens` still resolves the cutscene arm first.

**Deferred, with the seam named.** Gamepad and HOTAS — the action ids are the
seam. Bindings in the save — the `controls` group is what would sync. A bookmark
store — a preset whose address the viewer wrote is a bookmark and `pictures.ts`
is the record, so the store is what is missing. The flight canopy's
hold-to-free-look — the aim offset is the mechanism. Photo-mode export — the
plate capture is the same act. And a lens below 20°, which Earthrise at the
photograph's 11.4° asks for and the terrain predicate's saturation answers.

## Related

- [ADR-0017](0017-the-lens.md) — the lens this is the instrument for
- [ADR-0011](0011-application-shell-and-modes.md) — the shell the contexts are contexts of
- [ADR-0012](0012-dockable-panels.md) — the workspace the panels live in
- [ADR-0007](0007-persistence.md) — what a save holds, and why preferences are not in one
- [Planetarium](../design/planetarium.md) · [ux](../design/ux.md) — the surfaces
- [The terrain plan](../../design/plans/terrain.md) — the milestone this serves
