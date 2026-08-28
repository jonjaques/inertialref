# Planetarium

The mode with no ship. What it is for, why it is not the galaxy map, and the
one rule that keeps it from becoming a second game.

---

## The one idea

> **The planetarium is a _view_ of the same universe, not a mode with its own
> rules.**

Every other mode is about a ship: where it is, what it can reach, what that
costs. The planetarium removes the ship entirely. There is no fuel, no heat, no
Δv, nowhere you cannot go and nothing you can break. You point a camera at
something and look at it.

That sounds like a sandbox and it is not. It is a **reading room for the same
data the game is built on** — the real catalog, the real orbits, the real
physical parameters — and it exists because this project has one asset no
competitor has: a sky that is derived from measurements rather than painted, and
which is therefore worth examining rather than merely flying through.

Space Engine is the reference, and the debt is worth stating plainly. What is
different here is that the planetarium and the flight simulation are the **same
running world**: you can leave a ship in orbit of Mars, spend ten minutes on
Saturn's rings, and come back to find the ship exactly where it was with the
same state hash. There is no "load a different mode".

✅ **Built.** Camera — in orbit and standing on the ground — catalog with folds
and class filters, orbit traces, labels, the body record, composed shots,
dockable panels, touch. What is not built is listed at the bottom, along with the
astronomy nothing has measured yet.

---

## The rule that keeps it honest

**The planetarium never writes canonical state.**

Not the clock, not the ship, not an entity, not a save. It moves a camera and
reads. The engineering form of that rule is `packages/devtools/src/observatory.ts`,
which produces a _presentation eye_ and has no verb that mutates anything — and
the test that guards it compares `world.stateHash()` before and after a session
of flying around.

Two things follow, and both are load-bearing:

| Consequence                              | Why it matters                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| It can be entered and left at any moment | There is nothing to save and nothing to restore, so it is a button rather than a mode switch                                   |
| It cannot be an exploit                  | Discovery credit ([exploration](exploration.md#discovery-credit)) is earned by _going_ somewhere. Looking at Vega is not going |

> 🎮 Designer's Note: The second one is the whole reason this rule is stated in
> the bible rather than left as an implementation detail. The moment the
> planetarium can scan, survey or bank anything, the survey game has a free
> mode that plays it for you.

---

## The camera

Two arms, and which one holds the camera is a question with one answer: the
orbit arm above 1.5 radii, the surface arm below it. They meet exactly, with no
band that is both or neither.

### In orbit

Three numbers — **azimuth, elevation, distance** — around a chosen target. Not a
free 6-DoF camera, and that is a decision rather than a limitation.

A free camera is what a flight mode is _for_. Orbiting a subject is the only
model in which "look at Jupiter" has an unambiguous answer, it is what makes the
mode usable with one finger on a phone, and it removes the failure every
free-fly space browser has: being lost, at an unknown scale, pointed at nothing.

| Gesture               | Does                           |
| --------------------- | ------------------------------ |
| Drag                  | Orbit                          |
| Wheel / pinch         | Dolly, logarithmically         |
| Click / tap an object | Focus it, and the camera flies |
| `↑ ↓ ← →`             | Orbit — shift for coarse       |
| `+` / `−`             | Dolly                          |
| `F`                   | Frame the target               |
| `Home`                | Back to Earth                  |

**Zoom, dolly and framing are three acts, and the View panel has three
controls.** Zoom multiplies the focal length: it magnifies and changes no
parallax, so the limb does not turn and the moons do not shift against the disk.
A dolly moves the camera and changes all of that. Framing is a solve — the
standoff that makes the subject fill a stated fraction of the frame at whatever
lens is fitted, which is what `F` and **Hold Framing** run.

One control cannot describe all three without saying something false about two
of them — "the subject stays the same size" is a claim about the solve alone,
and a panel that prints it under a lens slider is describing a coupling nobody
can wire, because a lens change does not move a camera.
[ADR-0017](../adr/0017-the-lens.md) is the object that keeps the three apart.

**Distance is logarithmic everywhere.** The range this camera covers is from a
kilometer above a moon to a hundred light years — nineteen decades. Interpolated
linearly, a fly-to spends 99.9% of its time in the last decade and reads as a
cut; every zoom is a multiply and every transition eases over `log(distance)`.
The same trap [ADR-0010](../adr/0010-cinematic-director.md) documents for a
cinematic approach, met again at a larger scale.

**Zoom-out is capped absolutely, not relative to the target.** A radius-relative
ceiling puts Luna's at 0.003 ly and a star's at 0.3 ly, so "zoom out until the
neighboring stars appear" — the single most planetarium-shaped gesture there is
— would work at a star and refuse at a moon, for a reason no player could infer.

### Fly-to is a move, not a cut

Selecting a new target keeps the orbit angles and moves only the distance. The
camera travels; it does not teleport. Two reasons: resetting the angles on every
click reads as the interface reasserting itself over the player, and the
_travelling_ is the thing worth seeing — a fly-to from Earth to Proxima that took
no time would have taught nothing about four light years.

### On the ground

The orbit arm stops at 1.5 radii and is right to: half a radius up is where a
planetarium stops showing you a world and starts showing you ground with no
horizon in it. What that clamp also costs is the ability to _inspect_ a surface,
because terrain only exists below the floor the camera cannot go under — and
flying a ship at a mountain is a canonical change, a physics problem and several
minutes.

So there is a second arm. Five numbers about a point _on_ the ground — latitude,
longitude, height, heading, pitch — against the orbit arm's three about a point
in space. Its ceiling is half a radius, which is the orbit arm's floor, and a
stance is nullable rather than a mode flag beside the orbit state, so the two
cannot disagree about where the camera is.

Three of its rules are decisions rather than details:

- **Height is above the ground under you, never above the datum.** Terrain dips
  below the datum as often as it rises above it, so a height above the datum puts
  the camera underground on any peak and a kilometer up in any basin — the one
  thing a control called altitude must never do.
- **The scrub is logarithmic**, for the reason distance is, and worse: the band
  is 2 m to 3,186 km on Earth. Linearly, the approach, the low pass and the
  landing all live in the last pixel, so the control that exists to reach two
  meters would be the one control that cannot.
- **The default pitch tracks the horizon**, `acos(r / (r + h))`. From 400 km that
  is 19.79° _below_ level, so a camera held level at the top of a descent is a
  picture of empty sky. The small-angle `√(2h/r)` is 2.6% wrong there and grows.

**Entering is a cut, not a fly-to**, which is the one place this arm disagrees
with the one above it. The orbit arm eases because a move across fourteen decades
has to read as a move. This arm is the instrument a plate is captured through,
and an ease means every capture waits an unspecified number of frames for a
filter to settle before the picture is the picture.

**Where you can stand is found, not authored.** A seeded world has no place
names, and typing coordinates into a sphere lands on the same undifferentiated
mid-slope every time. A beam search over the body's own field finds four — the
highest ground, the lowest, where the land crosses the sea, and the steepest —
and two more are chosen for the renderer rather than for the geology: the corner
where three faces of the addressing cube meet, and the pole, where the east/north
basis is singular. A survey of interesting ground would never wander into either.
Because they are derived, "the highest ground on this world" is still the
interesting place after the generator changes, and a latitude written down last
month is not.

---

## The tools

Everything is a **panel**, and every panel is dockable — see
[ux](ux.md#dockable-panels).

| Panel       | Answers                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| **Catalog** | Where can I go? Search the whole index, fold the systems, filter the classes |
| **Object**  | What is this? The record — physical, orbit, rotation, air, light             |
| **View**    | Names, orbit traces, the ship, the lens, the glare                           |
| **Shots**   | Nine composed pictures, the light on its own, and the way out                |
| **Surface** | What is it like down there? The named sites, the height scrub, and a compass |
| **Time**    | Pause, warp, and what the clock is actually delivering                       |

The camera's own readings — range, altitude, how much of the frame the subject
fills, the two orbit angles, the frame id — are **not** in the object panel.
They are facts about where you are standing rather than about the thing being
looked at, and on a page about Mars they read as a debugger. They live in the
author's Camera instrument, beside the lens they describe. The Surface panel is
that rule applied once more: descending is a camera act, so it is a camera panel
and not a section of the record.

### The catalog

Sol is a hundred and twenty-nine bodies, and a flat list of them in issue order
is not something anybody browses twice. Three controls, and each answers a
question a list cannot.

**The folds.** One line per system, expanded where the camera is. The default is
re-derived from the target on every render rather than stored — a set of _open_
addresses freezes it, so flying to Proxima would leave Sol as the expanded one.
What is stored is the set of systems the reader has changed.

**The classes.** Six chips: stars, planets, moons, dwarfs, asteroids, comets.
Turning off the rubble is the single most useful press in the panel. An empty
selection means _everything_, because a filter whose worst state is an empty
list that looks exactly like a failed survey is a control with a trap in it. A
star whose own class is off stays when something under it survived, and a moon
stays when its planet was the thing removed — and a promoted moon sorts by
where its _parent_ was, or nine rocks orbiting at a kilometre appear above
Mercury.

**The radius.** 5, 10, 25 or 50 light years. A search ignores it and reaches the
whole index, because "what is near me" and "what is called this" are different
questions and only one of them can run per keystroke.

**The neighborhood rail** is the part a list cannot be. Proxima at 4.24 ly and
Sirius at 8.6 ly are two rows differing by a numeral and the factor of two never
lands; on a scale it lands in 28 px. The dots are real stars at real distances
in their real colours — [art](art.md) puts a star's colour on the list of things
this game may not invent — and clicking one flies the camera there. The scale is
√r: a survey's volume grows as r³, so linearly the whole neighborhood piles into
the left tenth, and logarithmically the observer's own zero has nowhere to go.

### Shots

`Framing` and `Compositions` were two banks of word-buttons and they were never
two kinds of thing — a framing is a composition that happens not to move the
light. Nine identical rectangles of type, and the two things that separate any
two shots are _how much of the frame the body fills_ and _where the terminator
falls_, both of which are pictures.

So they are drawn, to the geometry the solver uses: the disk's radius is
`fill × half the frame height`, which is what `frameTarget` solves a distance
for, and the terminator is a half-ellipse of projected width `r·cos φ`, which is
why it collapses to a straight line at 90°. The thumbnail is a prediction rather
than an illustration.

The light stays as its own row of five phase glyphs, because changing it
_without_ losing your framing is the commonest thing anyone does here and a
whole shot cannot express it. The two scale jumps are absolute distances rather
than framings — one AU from Jupiter is a planet in a frame and one AU from Sol
is most of the inner system — so they are labelled "Step Back" and kept apart.

### Names

A label is the difference between "a bright dot" and "Sirius", and it is the
single feature that turns a rendered starfield into a planetarium. Drawn in the
DOM over the tone-mapped frame, thinned greedily so a system seen from outside
is a sky rather than a list, and the leader ends on the body's limb so a name
never covers the thing it names.

**A label layer is not a boolean.** Eighteen names is right for a system and
wrong for a planet with two moons, so the density is a three-step — 8, 18, 40 —
rather than a constant or a slider. And the thinning is greedy by _screen size_,
which means from far enough out Sol's ninety-two asteroids and comets are the
same handful of pixels as Mercury and take the slots in whatever order the scene
lists them: a sky captioned with six provisional designations and no planets.
Minor bodies are therefore a switch of their own. A dwarf planet is not in that
class, for the same reason its orbit is drawn.

### Orbit traces

Affordable here for a reason specific to this engine: **orbits are analytic**
([ADR-0006](../adr/0006-simulation-clock.md)), so a whole period is 96 closed-form
evaluations rather than 96 integration steps that would drift off the body they
belong to.

Four rules, every one of which the naive version gets wrong in a way that only
shows on screen:

- **A trace is relative to its primary, re-anchored to now.** Sampling a moon's
  absolute position over one of its months also sweeps the planet through a
  twelfth of its year, so the trace comes out as an open corkscrew.
- **A trace starts where the body is.** It is drawn as a tail behind the subject,
  and a curve that is geometrically right but phase-shifted is invisible until
  somebody looks at the tail.
- **Traces are contextual, and rubble is not context.** What is drawn is the
  subject's siblings and the things going round it. Everything at once, in a
  system seen from inside, is a dozen ellipses edge-on — a fan of near-straight
  lines that says nothing. That was written when a star's children were eight
  planets; Sol has sixty-seven now, and drawn all at once they are a hundred and
  twenty-nine lines with the subject somewhere behind them. So an asteroid, a comet or
  a dwarf planet's orbit is drawn when it **is** the subject or goes round it,
  and the planets stay — "where is this relative to the planets" is the question
  a planetarium exists to answer, and eight ellipses answer it. **`Scope: all`
  is the deliberate way to ask for the cage** — from outside a system it is the
  picture, the whole architecture of the place at once, and from inside it is a
  fan of edge-on lines. Which is why it is a switch a reader throws rather than
  the default, and why it is a field on the presentation stance rather than
  component state: the frame loop reads it.
- **Sample in eccentric anomaly, not in time.** By Kepler's second law a
  near-parabolic body spends nearly all of its period near aphelion, so equal
  steps in time put nearly all the samples in the same place. At e = 0 the two
  are identical and nobody notices; C/2020 F3 (NEOWISE) is 0.99913, and its
  ninety-six samples were sixty-nine years apart with the two bracketing
  perihelion at 38 AU on opposite sides. The trace was a flat-ended lens through
  the middle of the Sun, and whenever the comet was near perihelion it was
  nowhere near its own orbit line. `M = E − e·sin E` is Kepler's equation run
  _forwards_ and needs no solver; the same ninety-six points then walk the
  ellipse at nearly constant arc length.

### The light, in the photographer's terms

Full, gibbous, half, crescent, rim — the same vocabulary the flight harness's
[camera bookmarks](../../packages/devtools/src/shots.ts) use, over the same
solver, so the two cannot disagree about what "gibbous" means. Each is solved
against where the star **actually is now**, so a phase means the same thing at
any point in a planet's year.

---

## Mobile

The planetarium is the mode that works on a phone, and the first one that does.

Piloting on a touchscreen is a design problem this project has not solved and
should not pretend to. Looking is not: one finger orbits, two pinch, a tap
focuses, and the panels become a bottom sheet with a tab strip. **Every panel is
reachable; no panel is exclusive to the desktop.**

Docking is deliberately not offered on a phone. "Left" and "right" have no
meaning on a 390 px screen, so a drag that moved a panel between zones would be
a gesture with an invisible effect — worse than no gesture. The panel _set_ is
still the same stored layout, so a workspace arranged on a desktop and opened on
a phone keeps its panels and rotating a tablet back restores the columns.

**The shots carry the weight on touch.** A phone has one finger and no keyboard,
so a composed shot is the only way to reach a framing that would otherwise take a
drag, a pinch and a phase solve — and a drawn thumbnail is the only way to say
which framing it is without a caption a phone has no room for.

---

## The URL is the document

`/planetarium?at=g:milky-way/s:SOL/b:5` opens on Jupiter. The address bar is
rewritten on every focus, so it always describes what is on screen, and that
makes a view a thing you can send someone.

The address is the same string generation, saves, logs and the console all use
([ADR-0004](../adr/0004-entity-addressing.md)) — there is no second identifier
for "a place in the planetarium". The search box accepts everything `ir.goTo`
accepts, through the same resolver, because a search box with its own vocabulary
would be a second addressing scheme in one build.

---

## What this is not

**It is not the galaxy map.** The [galaxy map](galaxy.md#the-galaxy-map) is a
gameplay instrument on the canopy: route planning, jump range, fuel, filters
about _your_ survey status, and a horizon of knowledge. It answers "where can I
get to and what will it cost". The planetarium answers "what is out there and
what does it look like", has no route planner and no notion of range, and is not
drawn on any surface inside the ship because there is no ship.

They will share a catalog index and nothing else.

**It is not photo mode.** [Photo mode](art.md#photo-mode) is entered from the
Canopy console during play, keeps the ship, and exports an image stamped with the
address. The planetarium has no ship to be in.

---

## Not built

| Thing                        | Note                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bookmarks                    | ⬜ The address is already the whole record; the store is what is missing                                                                                       |
| Measure between two objects  | ⬜ Shift-click two things, get a distance                                                                                                                      |
| Walking the surface          | ⬜ The camera stands, turns and changes height. It does not travel across the ground: a stance is a coordinate, so a walk is a rule for changing one over time |
| Export a still               | ⬜ Photo mode's export, without the ship                                                                                                                       |
| Scale tiers beyond the local | ⬜ [galaxy](galaxy.md#scale-tiers) specifies three; the local one is what exists                                                                               |
| Survey status as a filter    | ⬜ [galaxy](galaxy.md#interactions) filters by what _you_ have visited. That is a gameplay fact and the planetarium has no player                              |

Filters over the catalog are ✅ built — by class and by survey radius. What is
not built is the half of [galaxy](galaxy.md#interactions)'s set that is about
the player's own survey, and that half is deliberately absent: looking at Vega
is not going there, and a mode with no ship has nothing to filter by.

---

## The record that is not filled in yet

The object panel draws a row for every field a planetarium is expected to carry,
including the ones nothing has measured — muted, marked **no data**, with the
reason attached. [ADR-0014](../adr/0014-the-record-with-holes-in-it.md) is the
argument for that; this is the list, and the engineering half of each reason.

The panel's copy is written **in the universe's voice** — "no magnetometer has
been flown through it", never "the generator does not produce one". The galaxy
is real, `projected` means the ship's computer worked a world out from its
star's parameters rather than anybody having flown there
([galaxy](galaxy.md)), and a mode whose whole subject is that the sky is not a
program may not tell a reader that it is. A test greps every reason for the
vocabulary that would break it.

### On a body

| Field                   | Where the value will come from                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composition             | A layered interior model — core, mantle, volatile fraction — that the generator derives alongside the density it already computes. Real bodies want it packed in `solar/`.                                                                                                                                                                                                                                                                                                              |
| Age                     | A formation date per system, then per body. Procedural: one draw per system seed. Solar: published, not yet packed.                                                                                                                                                                                                                                                                                                                                                                     |
| Bond albedo             | The equilibrium temperature balances absorbed sunlight against re-radiation, and the fraction absorbed is `1 − Bond`. The record carries `geometricAlbedo`, and the two are not proportional — Earth is 0.306/0.434, Mercury 0.088/0.142, Mars 0.250/0.170 — so every figure runs cool: Earth reads 241 K against a published equilibrium of 255. Closing it needs a phase integral, and inventing one is the "plausible number" ADR-0014 rejects, so the row names the albedo it used. |
| Surface temperature     | A greenhouse model over the atmosphere that already exists, plus thermal inertia. Earth’s measured 288 K against a published 255 K equilibrium is the 33 K this accounts for — and it stacks on the Bond gap above, so the two arrive together or not at all.                                                                                                                                                                                                                           |
| Atmospheric composition | Gas fractions on `Atmosphere`, which currently carries a density, a scale height and a ceiling. The scattering colour is already tuned from an implied composition.                                                                                                                                                                                                                                                                                                                     |
| Circulation             | Bands and a jet profile on `CloudLayer`, which has a rotation rate and nothing else.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Magnetic field          | A dipole moment from mass, rotation and composition. It is also the gate on aurora, which [art](art.md) already licenses the renderer to draw.                                                                                                                                                                                                                                                                                                                                          |
| Pole direction          | Right ascension and declination on `Body`. `axialTilt` is a magnitude with no direction, so nothing can place a season.                                                                                                                                                                                                                                                                                                                                                                 |
| Precession              | A secular term on the pole. Needs the pole first.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Element drift           | Secular variation on `OrbitalElements`. The two-body solve is right at J2000 and drifts after it.                                                                                                                                                                                                                                                                                                                                                                                       |
| Resonances              | A relationship between two records rather than a field on either. Wants a `resonances` table per system.                                                                                                                                                                                                                                                                                                                                                                                |
| Apparent magnitude      | A phase function. Size, albedo and geometry are all on file already.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Exosphere               | A sputtered-envelope model for airless bodies — Mercury's sodium, Luna's argon.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Ring divisions          | Multiple annuli on `RingSystem`, plus the shepherd moons that hold the gaps open.                                                                                                                                                                                                                                                                                                                                                                                                       |
| Ring particle size      | A size distribution, which is also what would let the forward-scattering blaze be derived rather than tuned.                                                                                                                                                                                                                                                                                                                                                                            |
| Designation history     | Naming authority and prior designations, alongside the name the packed data ships.                                                                                                                                                                                                                                                                                                                                                                                                      |

### On a star

| Field              | Where the value will come from                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Age, metallicity   | Isochrone fitting needs both, and neither is in the packed catalog. Metallicity is the one a future generator wants first — it sets planet occurrence rates. |
| Rotation, activity | A rotation period from age and class, then starspots and a flare rate.                                                                                       |
| Variability        | Luminosity is a constant. Cepheids, eclipsing binaries and long-period variables all hold still.                                                             |
| Companions' orbits | The catalog records the component _count_; separations and mutual orbits are a second table.                                                                 |
| Debris disk        | An infrared excess in the source data, then a belt in the generator.                                                                                         |
| Proper motion      | A second epoch. One is packed, so nothing can move.                                                                                                          |
| Radial velocity    | Not packed. It is what a jump planner eventually wants.                                                                                                      |
| Constellation      | The eighty-eight boundaries, as a lookup over the J2000 sky.                                                                                                 |

**Every one of these is a row on screen today.** Filling one in is a two-line
diff — the label and its place in the group do not move — and `pendingCount` in
the panel's header is the count going down. There is no separate ledger to keep
in step; this table is about _sources_, and the rows themselves are generated by
the code that draws them.

---

## Related

- [modes](modes.md) — where this sits among solo, online and the persistent universe
- [ux](ux.md#the-application-shell) — the shell, the routes and dockable panels
- [galaxy](galaxy.md) — the two in-game maps this is deliberately not
- [cinema](cinema.md) — the other mode with no ship
- [ADR-0011](../adr/0011-application-shell-and-modes.md) — routes, modes and who owns the camera
- [ADR-0014](../adr/0014-the-record-with-holes-in-it.md) — why an unmeasured field is a row rather than an omission
