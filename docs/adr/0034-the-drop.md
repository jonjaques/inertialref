# ADR-0034: The drop is an eased entry onto the surface arm, aimed by a figure

Status: accepted · 6 Sep 2026

## Context

The planetarium has two camera arms and one way between them.
[ADR-0018](0018-the-instrument.md) put the orbit arm above 1.5 radii and the
surface arm below it, and `stand` is how the camera crosses: it **cuts**. That
is right, and its own docstring says why — the surface arm is the instrument a
plate is captured through, and an ease means every capture waits an unspecified
number of frames for a filter to settle before the picture is the picture.

What a cut cannot be is a thing to watch. Arriving on a world is the most
photographable act the mode has and it happened between two frames.

The other half is that there was no way to choose _where_. `surveySites` finds
six places on any body — the highest ground, the lowest, the shoreline, the
steepest, the addressing corner, the pole — because
[a seeded world has no place names](../design/planetarium.md) and typing a
latitude into a sphere lands on the same undifferentiated mid-slope every time.
Six derived sites is a good answer to "somewhere interesting" and no answer at
all to "there, that spot, the one I can see".

## Decision

**A figure dragged from the chrome onto a drawn world, and a ballistic entry
that the camera flies to where it lands.**

### The trajectory is the conic, and its periapsis is under the ground

`packages/rendering/src/entryArc.ts` is a Keplerian conic about the body's
centre through the release point and the touchdown, with its apoapsis at the
release. Its periapsis lies below the surface, which is what makes it an
_entry_ rather than an orbit, and drawing that continuation is what says so.

**The record holds `1 − e`, not `e`.** A drop from far out onto ground nearly
under the eye has `e` within 1e-13 of one, and the polar form's denominator
`1 − e·cos ψ` written as a subtraction loses every digit it has there. Written
`(1 − e) + 2e·sin²(ψ/2)` it is a sum of two positive terms and loses none. A
touchdown directly under the release has `e` exactly 1: the ellipse has
collapsed to a radial line, and that is the correct answer, drawn as one.

### The schedule is logarithmic in height, and the radius is not monotonic

The band from orbit to eye height is six decades. A linear descent spends 99.9%
of its time above the altitude where terrain is drawn and then arrives in a
frame — the same argument the surface arm's own scrub is built on. Measured on
Earth from 30,000 km, the halfway frame is at 1.7 km rather than at 15,000 km.

The camera's radius **rises** where the ground rises under it: the conic is
solved against the ground below the touchdown, the track crosses ground that is
higher, and the stance's height clamp lifts the eye over a ridge rather than
flying it through one. Bounded by the body's own relief — 9.9 km on Earth,
against the 12 m a test track actually meets.

### The camera watches the ground, then turns to the star

For the first two thirds the aim is the touchdown point, which is the picture:
the ground coming up. Over the last third the heading swings to the star's
bearing and the pitch rises to the horizon, so the frame the descent ends on is
the world it landed on, lit from where the light is.

**The heading is also eased toward the star as the aim steepens.** The bearing
of a point nearly under the eye swings with every meter of sideways travel, and
that is loudest exactly where the descent is fastest. Landing on the night side
faces the star's bearing with the star below the horizon, which is the honest
answer rather than a special case.

### The aid is scene geometry, in the body's own frame

It was an SVG in the HUD first and no amount of styling fixes that: an overlay
is flat. It cannot be occluded by the limb it crosses, its dashes do not shorten
with distance, and a ring it puts on the ground is a circle rather than the
ellipse a circle on a sphere is.

**And it is placed the way a terrain patch is, not the way a point is.** A body
is not drawn where its metric position says — render compression
([ADR-0003](0003-render-coordinates.md)) pulls it nearer and shrinks it so its
angular size survives, and `placement.scale` is the radius it comes out at. A
point put through its _own_ compression lands at a different depth from the
sphere it is meant to lie on: the ground ring sank inside the planet and
vanished. So the observatory answers in **body radii, in body-fixed axes**, and
the drawer hangs the aid off the placement the body was drawn with. One unit is
the drawn surface by construction, and the buffers are camera-independent.

### The figure is held at a fifth of the viewer's altitude, above the aim

At the viewer's full orbital radius the mark is 3.3 body-radii out at Earth,
which leaves a 65° frame exactly when the aim reaches a limb — where a horizon
comes from and where anybody composing a picture aims. A fifth puts it a
half-radius clear of the ground: outside the disk near a limb, so the fall is
drawn side-on, and still in frame. The cost is stated rather than hidden: aim
at the middle of the disk and that vertical points at the camera, so the fall
foreshortens.

Both rings are sized by **angle** rather than in meters, because the gesture
spans six decades and no fixed size survives that; the ground ring follows the
drawn terrain and floats a twelfth of its own radius over it, because a fixed
lift is a handful of float32 bits at a planetary radius.

### A ray that misses answers with the limb

The near limb is the one part of a sphere a pointer cannot land on from
outside — the ray grazes it at a tangent, and a pixel either way is the
difference between a hit and the sky. Refusing there makes the last few degrees
of every drop unreachable. A miss answers with the point on the surface nearest
the ray, which is continuous across the limb: the mark slides onto the edge and
stays there rather than blinking out.

### Nothing canonical is written

The drop is `Observatory.drop`, it rides the surface arm, and `standing` is true
from its first frame — which is what keeps the orbit writers refused for the
whole descent, so a wheel notch mid-drop cannot rewrite the state `ascend`
returns to. `ir.ascend()` abandons one in flight at the framing it left.
`observatory.test.ts` compares `world.stateHash()` across a drop.

## Alternatives considered

**Ease `stand` instead of adding a verb.** One arrival, one behavior, less
code. Rejected on the reason `stand` cuts in the first place: it is the plate
rig's entry point, and `pnpm presets:plates` would then capture an unspecified
frame of a filter settling. Two verbs, two intents.

**A click rather than a drag.** The camera already spends every click it has —
a click in the sky focuses whatever it hits — so this would cost the mode its
primary verb, or hide the gesture behind a modifier nobody would find. Picking
the figure up is an unambiguous statement of intent and nothing is decided
until it is let go.

**Land where you point, with the figure on the same ray.** The obvious reading,
and it draws nothing: the release and the touchdown are then on one line
through the eye, and a line pointing away from the camera foreshortens to a
point. The figure has to be somewhere the camera can see it _beside_ where it
lands, which is what holding it on the local vertical does.

**An overlay aid, with the arc projected to screen.** Shipped first and
replaced. It cannot be occluded, and it made the ring a circle on a plane
rather than an ellipse on a sphere. The measurements that killed it are in the
commit; the geometry that replaced it is above.

## Consequences

**Good.**

- Arriving on a world is something to watch, and the frame it ends on is the
  picture the gesture promised.
- Any spot on a drawn body is reachable, including the limb, which is where a
  horizon comes from.
- The aid is in the scene, so it is occluded, perspective-correct, and free
  during a frame where the hand held still.
- `ir.drop(lat, lon)` is the console's own verb, so a capture script composes
  the same descent a hand does.

**Costs, honestly.**

- **The aid draws the figure's fall, and the camera flies its own arc.** They
  end in the same place and take different paths there — the camera leaves from
  where it is, the figure from where it is held. The ring is a promise about
  the destination, not about the camera's route.
- Aiming at the middle of a disk foreshortens the fall to almost nothing. It is
  geometry rather than a bug, and the mark stays legible because both rings are
  angular.
- The drop is wall-clock timed rather than tied to the tick, like every other
  presentation ease. Pausing the simulation does not pause a descent, which is
  the same choice `TRAVEL_TAU` already makes and for the same reason.
- The gesture has no keyboard equivalent. `ir.drop` and the Ground section's
  site buttons are the two ways in without a pointer, and neither lets a
  keyboard choose an arbitrary spot.

## Related

- [ADR-0018](0018-the-instrument.md) — the two arms this crosses between
- [ADR-0003](0003-render-coordinates.md) — the compression the aid is placed through
- [ADR-0021](0021-the-ground.md) — the drawn radius the stance and the ring stand on
- [ADR-0011](0011-application-shell-and-modes.md) — the camera precedence this stays inside
- [Planetarium](../design/planetarium.md) — the mode's own account
