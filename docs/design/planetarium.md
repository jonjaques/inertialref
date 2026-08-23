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

✅ **Built.** Camera, catalog, orbit traces, labels, presets, dockable panels,
touch. What is not built is listed at the bottom.

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

Three numbers — **azimuth, elevation, distance** — around a chosen target. Not a
free 6-DoF camera, and that is a decision rather than a limitation.

A free camera is what a flight mode is _for_. Orbiting a subject is the only
model in which "look at Jupiter" has an unambiguous answer, it is what makes the
mode usable with one finger on a phone, and it removes the failure every
free-fly space browser has: being lost, at an unknown scale, pointed at nothing.

| Gesture               | Does                           |
| --------------------- | ------------------------------ |
| Drag                  | Orbit                          |
| Wheel / pinch         | Zoom, logarithmically          |
| Click / tap an object | Focus it, and the camera flies |
| `↑ ↓ ← →`             | Orbit — shift for coarse       |
| `+` / `−`             | Zoom                           |
| `F`                   | Frame the target               |
| `Home`                | Back to Earth                  |

**Distance is logarithmic everywhere.** The range this camera covers is from a
kilometer above a moon to a hundred light years — nineteen decades. Interpolated
linearly, a fly-to spends 99.9% of its time in the last decade and reads as a
cut; every zoom is a multiply and every transition eases over `log(distance)`.
The same trap [ADR-0010](../adr/0010-cinematic-director.md) documents for a
cinematic approach, met again at a larger scale.

**Zoom-out is capped absolutely, not relative to the target.** A radius-relative
ceiling puts Luna's at 0.003 ly and a star's at 0.3 ly, so "zoom out until the
neighbouring stars appear" — the single most planetarium-shaped gesture there is
— would work at a star and refuse at a moon, for a reason no player could infer.

### Fly-to is a move, not a cut

Selecting a new target keeps the orbit angles and moves only the distance. The
camera travels; it does not teleport. Two reasons: resetting the angles on every
click reads as the interface reasserting itself over the player, and the
_travelling_ is the thing worth seeing — a fly-to from Earth to Proxima that took
no time would have taught nothing about four light years.

---

## The tools

Everything is a **panel**, and every panel is dockable — see
[ux](ux.md#dockable-panels).

| Panel         | Answers                                                         |
| ------------- | --------------------------------------------------------------- |
| **Catalog** | Where can I go? Search by name or designation, browse by system |
| **Object**    | What is this? Real data, provenance, orbit, and its address     |
| **View**      | Names, orbit traces, the ship, the lens                         |
| **Presets**   | Lighting, framing, and a short tour                             |
| **Time**      | Pause, warp, and what the clock is actually delivering          |

### Names

A label is the difference between "a bright dot" and "Sirius", and it is the
single feature that turns a rendered starfield into a planetarium. Drawn in the
DOM over the tone-mapped frame, thinned greedily so a system seen from outside
is a sky rather than a list, and the leader ends on the body's limb so a name
never covers the thing it names.

### Orbit traces

Affordable here for a reason specific to this engine: **orbits are analytic**
([ADR-0006](../adr/0006-simulation-clock.md)), so a whole period is 96 closed-form
evaluations rather than 96 integration steps that would drift off the body they
belong to.

Two rules, both of which the naive version gets wrong in a way that only shows
on screen:

- **A trace is relative to its primary, re-anchored to now.** Sampling a moon's
  absolute position over one of its months also sweeps the planet through a
  twelfth of its year, so the trace comes out as an open corkscrew.
- **Traces are contextual.** What is drawn is the subject's siblings and the
  things going round it. Everything at once, in a system seen from inside, is a
  dozen ellipses edge-on — a fan of near-straight lines that says nothing.

### Lighting presets

Full, gibbous, half, crescent — the photographer's terms, and the same ones the
flight harness's [camera bookmarks](../../packages/devtools/src/shots.ts) use, so
the two cannot disagree about what "gibbous" means. Each is solved against where
the star **actually is now**, so a preset means the same thing at any point in a
planet's year.

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

**Presets carry the weight on touch.** A phone has one finger and no keyboard,
so a preset is the only way to reach a framing that would otherwise take a drag,
a pinch and a phase solve.

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

| Thing                        | Note                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| Bookmarks                    | ⬜ The address is already the whole record; the store is what is missing                 |
| Filters over the catalog   | ⬜ [galaxy](galaxy.md#interactions) lists the fields; the planetarium wants the same set |
| Measure between two objects  | ⬜ Shift-click two things, get a distance                                                |
| Surface-level free look      | ⬜ The observatory's floor is the datum sphere; standing on the ground is a flight mode  |
| Export a still               | ⬜ Photo mode's export, without the ship                                                 |
| Scale tiers beyond the local | ⬜ [galaxy](galaxy.md#scale-tiers) specifies three; the local one is what exists         |

---

## Related

- [modes](modes.md) — where this sits among solo, online and the persistent universe
- [ux](ux.md#the-application-shell) — the shell, the routes and dockable panels
- [galaxy](galaxy.md) — the two in-game maps this is deliberately not
- [cinema](cinema.md) — the other mode with no ship
- [ADR-0011](../adr/0011-application-shell-and-modes.md) — routes, modes and who owns the camera
