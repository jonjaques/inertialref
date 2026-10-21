# ADR-0055: A long lens refines only the ground its frame can reach, and the lens goes to 11.4°

Status: accepted · 20 Oct 2026. Amends the whole-disk selection of
[ADR-0015](0015-terrain-level-of-detail.md), the long end of the lens in
[ADR-0017](0017-the-lens.md) and the Earthrise clamp in
[ADR-0018](0018-the-instrument.md).

## Context

The field-of-view slider stopped at 20° because the terrain predicate
saturated its patch cap there ([ADR-0017](0017-the-lens.md)). Earthrise at the
photograph's framing — Earth a sixth of the frame, and Earth is 1.9° across
from Luna — wants 11.4°, so the preset had the right geometry and an Earth too
small in it.

The predicate refines while a patch's cell subtends more than `cellPixels` at
the lens's pixel angle, and [ADR-0015](0015-terrain-level-of-detail.md) applies
that to the whole visible disk at one scale. At the flight lens that is the
right shape: the frame is most of what a standing eye can see. At a telephoto
it is not. A pixel angle is a claim about what is inside the frame, and an
11.4° frame is a sliver of the disk; refining all of it at that angle spends
the cap on ground behind and beside the camera.

Measured standing at two meters over every survey site of Earth, Luna, the
four zoo bodies, Gliese 908 IV and the far-shore world — sixty eyes — and over a
32-step descent onto each basin, at 1920×1080 display pixels and 16 px a cell,
with the cap at 1,280 and its coarsening ladder (`COARSEN_STEP`):

| Lens, whole disk | Standing, uncapped | Standing, cut at the loosest rung | Descent peak |
| ---------------- | ------------------ | --------------------------------- | ------------ |
| 65°, flight      | 456–1,061          | 0 of 60                           | 704–917      |
| 20°              | 932–4,815          | 0 of 60, coarsened on 40          | 1,187–2,610  |
| 11.4°            | 2,063–12,330       | **8 of 60, all short underfoot**  | 2,769–6,389  |

Raising the cap was rejected in ADR-0017 and is rejected again for the same
reason at a larger number: a patch is 270 KB of buffers, and 12,330 of them is
3.3 GB for a lens the player has narrowed onto a subject.

## Decision

**Past the flight lens, the selection refines at the lens only where the
frame can reach, and at the flight lens everywhere else; with that, the long
end of the lens is 11.4°.**

- `selectTerrain` takes a `view` — the camera's forward in body-fixed axes. With
  a lens longer than `REFERENCE_LENS`, which is the flight lens, a node whose
  ground can reach the frame's cone refines at the lens and every other node at
  the reference. The cone is the frame's half-diagonal widened by
  `VIEW_MARGIN_PIXELS`, 1,024 of the lens's own pixels. Without a view, or at
  the flight lens and wider, the selection is the whole-disk one field for
  field: a property test holds that, and 180 eyes return the same 39,821
  patches with and without the change.
- **The ground a node can hold is bounded by a capsule along its axis**, from
  `(radius − relief)·cos θ` to `radius + relief`, thickened by the column's
  widest half-width. The relief is a vertical claim — a summit can rise into the
  frame and a canyon can fall into it — and the capsule keeps it vertical.
- **A node is in view only if its parent was.** The scale then never rises down
  the tree, which is what the `MORPH_END` handover argument assumes.
- **Where the two regimes meet, the patch in view takes its morph band at the
  reference scale.** A coarser neighbor outside stopped at the reference's
  range, a fraction of the in-view patch's range at the lens, so a band taken at
  the lens would still be sliding at the neighbor's edge. At the reference scale
  it has arrived on its parent's grid first, exactly as within one regime. The
  cost is that patch's own level, which is what the margin keeps out of the
  frame: a patch near its own range is 1,024 px across at 16 px a cell.
- **The cap bounds the balanced tree.** Two regimes grade across the frame's
  edges, and the 2:1 rings that do it are hundreds of patches the walk's own
  count never sees: a descent onto Luna at 11.4° whose every walk fitted came
  back over the cap on 22 of 32 steps. An overrun after the balance pass climbs
  the ladder like an overflow during the walk.
- **The engine owns the camera's pose.** `GameEngine.cameraPose()` is the pose
  the frame is drawn from — the script's, the observatory's or the walker's, or
  `flightCameraPose` on the ship arm — and both the streamer and `CameraRig` read
  it. The streamer turns its render-space forward into the body's axes through
  the rotation its patches are placed with.
- **A held selection is retaken once the view has turned `VIEW_TURN_PIXELS`**,
  a quarter of the margin, and never at the flight lens or wider, where the
  view is not an input to the walk.
- **`FOV_MIN` is 11.4°.** It is the photograph's framing, and it is where the
  cap holds: every eye looking at the horizon fits, and the only cut trees are
  three of sixty eyes looking straight down beside a cube corner.

## Alternatives considered

**Raising the cap.** Above, and in ADR-0017. It buys the ground behind the
camera.

**A bounding sphere for the in-view test.** The obvious construction, and it
does not work: its radius cannot be less than the body's relief, 9.9 km on
Earth, so every node within ten kilometers holds the eye inside its sphere and
is in view — behind the camera as much as in front. Standing on Earth's basin
at 11.4° looking at the horizon that left 3,289 patches; the capsule takes the
same eye to 1,756, against 5,504 for the whole disk.

**A frustum against the datum sphere alone.** Tighter than the capsule and
wrong in exactly the pictures a telephoto takes: ground the relief lifts into
the frame would refine at the reference, so a summit rising into the frame is
drawn nearly three levels coarse until the camera turns toward its base.

**A finer or coarser reference.** Measured on the same eye, the reference lens
barely moves the count: 0.15 to 0.67 of the flight lens's scale gives 1,708 to
1,726, the flight lens 1,756, 2.25 times it 1,969 and 3.4 times it 2,595. The
ground outside is set by 2:1 grading across the level gap, not by the
reference's own predicate. The flight lens wins on the other count: nothing
outside the frame is ever coarser than the flight lens would draw it, so a turn
streams the telephoto's increment over ground already resident and never a hole.

**No margin.** Cheaper — 1,477 patches at no margin, 1,555 at 512 px and 1,756
at 1,024 on Earth's basin at 11.4° — and it puts the ring of demoted patches in
the frame's edges, where every one of them draws a level coarse.

**Retaking the selection every frame of a turn.** Two walks a frame for ground
the margin already covers. Measured at 11.4° on the basin, shore and corner of
Earth, Luna, Miranda, Gliese 908 IV and the far-shore world, a turn of 256 px
asks for at most 33 patches the selection before it did not hold — four frames
of the streamer's eight-a-frame build budget, with 768 px of margin left.

**A floor at 10° or 8°.** At 10° Earthrise frames at its solved angle at every
instant of the month, where 11.4° clamps it for about half the orbit by up to
5%. It also doubles the cut trees straight down to six of sixty, one of them
away from any cube corner, with overruns to 21%, and puts 117 scatter regions on Luna
against a ceiling of 96. At 8° eyes at the horizon start to cut too, 5 of 240,
and a descent onto Miranda looking down is cut on 16 of 32 steps.

**Tightening the capsule with each node's own elevation range.** The lever for
the nadir case: a node's column is the body's whole relief tall, so a camera
looking straight down refines a disk as wide as a canyon the body's relief
could hold. The selection runs before a node's field exists, so the bound it
would need is a pyramid of elevation ranges the streamer does not keep. Named
here as the next lever rather than built.

## Consequences

Measured over the same sixty eyes and eight descents, looking at the horizon
(four headings a site) and straight down:

| Lens        | Horizon, standing | Cut        | Descent peak | Cut        | Nadir, cut |
| ----------- | ----------------- | ---------- | ------------ | ---------- | ---------- |
| 20°         | 669–2,315         | 0 of 240   | 932–1,388    | 0 of 256   | 0 of 60    |
| **11.4°**   | 929–3,491         | 0 of 240   | 1,221–1,946  | 0 of 256   | 3 of 60    |
| 10°         | 1,005–3,786       | 0 of 240   | 1,338–2,123  | 0 of 256   | 6 of 60    |
| 8°          | 1,054–4,487       | 5 of 240   | 1,495–2,492  | 0 of 256   | 14 of 60   |
| 11.4° at 8× | 3,003–17,760      | 231 of 240 | 4,586–8,305  | 167 of 256 | —          |

**The cap holds at the new floor everywhere but beside a cube corner.** The
three cut trees at 11.4° are all the `corner` site looking straight down, over
the cap by at most 12%, and none of them is short of the floor underfoot. A
corner is where `regionSpacing`'s nominal spacing over-refines by up to a level
(ADR-0015), and a long lens multiplies every ring. On a 1600×900 window at DPR
2 the horizon cuts 26 of 240 eyes, 20 of them at corners, by up to 26%, still
none short underfoot; the same window at 20° over the whole disk cut 8 of 60
standing eyes, every one of them short of the floor.

**The zoom channel is still uncovered.** At 11.4° with the zoom
racked to 8× the frame wants several times the cap even inside itself, and the
disk goes coarse by a stated amount on nearly every step, as ADR-0017 said it
would at 20°.

**A turn costs a few frames of detail, never a hole.** Ground swinging into the
frame was refined at the flight lens and sharpens as the telephoto's increment
streams. The memo retakes the walk every 256 px of turn.

**The headless probes ask a different question.** `ir.descend` and
`ir.terrainBaseline` have no camera to aim, so they refine the whole disk at
whatever lens they are handed; `ir.terrain().outside` counts the patches the
live streamer refined at the flight lens instead.

**Everything the long end implies moved with it.** 120.22 mm on the 24 mm
gauge and 5,410 px/rad over 1080 display pixels. The hyperfocal distance with
the zoom racked out is 13.9 km over a 1520 px buffer, so `FOCUS_MAX` is 30 km
rather than 10; the smallest rock is two pixels at 1,353 m, which is 88
scatter regions on Luna against the ceiling of 96; a 100 px drag at 8× without the lens's own
sensitivity would sweep twenty field-widths.

**The billboard threshold follows the lens to 3.08e-5 of angular radius**, and
the one body it moves in Earthrise's sky is Saturn: seen from Luna at that
instant it subtends 4.36e-5, a point at 20° and a billboard at 11.4°. With the
zoom racked out the threshold is 3.85e-6 and the body that crosses is Neptune.
That is still a plate review rather than a unit test, as
[the terrain plan](../../design/plans/terrain.md) says.

**Earthrise takes the field it solves.** 11.53° at the preset's instant, with
Earth 380,396 km away, and the vendored plate is taken at that angle.

---

## Related

- [ADR-0015](0015-terrain-level-of-detail.md) — the whole-disk selection this refines past the flight lens
- [ADR-0017](0017-the-lens.md) — the lens, and the saturation that set the old floor
- [ADR-0018](0018-the-instrument.md) — the instrument, and the Earthrise clamp
- [ADR-0011](0011-application-shell-and-modes.md) — the camera's one producer, which `cameraPose()` keeps one
- [Streaming](../concepts/streaming.md) — the selection in the streamer
