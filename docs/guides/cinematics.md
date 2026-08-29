# Cinematics

How scripted scenes are authored, sampled, and applied. The design intent is
[cinema](../design/cinema.md). The decision is
[ADR-0010](../adr/0010-cinematic-director.md).

---

## A scene is a shot list, not a camera move

Each shot owns its camera and its lens, placed against its own subject. Cuts
hide in darkness, behind a flash, or under a body filling the frame. Authored as
one continuous spline, a scene becomes a camera crossing astronomical units
between beats and aiming at whatever sits between them.

Time derives from `renderTime`, never a wall clock. A script's
`prepare(world)` resolves the stage once; its `sample(frame)` is pure.

---

## Where the code lives

| Layer                | Path                                              | What it is                                                                                          |
| -------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Pure arithmetic      | `packages/rendering/src/cinematic.ts`             | Easings, fade envelopes, camera routes, screen-space routes, solvers. Property-tested in Node.      |
| Director and scripts | `packages/devtools/src/cutscene.ts`, `cutscenes/` | A `CutsceneScript` per file; register it in `harness.ts`.                                           |
| Application          | `apps/game`                                       | `engine.cinematic`, warp-effect quads, the DOM title overlay, the Controls panel's Harness section. |

Choreograph in the frame. A hull's beats are
`(frame, screen x, screen y, range)` via `screenOffset` — the same terms a
tracked bounding box reports. `screenRoutePosition` interpolates range in
log space so a four-decade approach does not overshoot through the lens.

**Derive orientation from the path; author attitude as an overlay.** A
straight pass has one attitude — `orientationAlong(path, up)` is
`lookAlong(direction, up)` and does not depend on the frame — so a hull on a
fitted line cannot slide, by construction. Do **not** finite-difference the
_screen_ spline to get a heading: near the lens, sub-pixel wobble becomes
large angular velocity. `withAttitude(base, bankDeg, pitchDeg)` is the sparse
overlay for the places the ship really does maneuver, and for the places its
attitude and its flight path genuinely differ — `tng-intro`'s cruise flies
nose-down along a climbing track, which is why the camera sees the saucer's
top through the approach.

`linePath` is the trajectory type that goes with it: an anchor, a unit
direction, and an `advance` profile splined in **log-range along the line**.
Its advance must stay strictly on one side of the anchor — log space has no
zero crossing — and the fix for a pass that crosses it is to move the anchor,
which is free, because `anchor + t·direction` is invariant under sliding the
anchor and re-basing every `t`.

An effect is staging. It belongs in `CinematicEffects`, where a shot turns
it on, and it is 0 everywhere else. Do not derive a cinematic look from
geometry alone (for example an eclipse corona from occlusion). At
planetarium range the physical corona is a fraction of a degree past the
limb; a cinema-authored halo is not.

---

## Authoring rules

- **A shot's exit beats are not dead, and two shots hand a prop over on a
  shared knot.** A Catmull-Rom segment's tangent comes from the knot past its
  far end, so beats authored after the cut shape the segment the shot still
  renders. `tng-intro`'s cruise carried three of them and flew a whole warp-out
  across its own last twelve frames — 432 m to 17.4 km, in the clear, before
  the next shot's entry knot snapped the hull back thirty times larger. The
  handover is one knot now, repeated in both lists. Attitude works the same
  way in the other direction: `routeOrientation` holds its first beat before
  that beat's frame, so a facing list that begins at the _next_ shot's beats
  pins the handed-over prop to the wrong heading for every frame before it.
- Camera-relative choreography is **offset beats**, never absolute beats off
  a moving camera.
- Do not per-frame look-at a hull near the lens.
- **A shot carries a lens, not an angle.** `sample()` returns a `Lens`; build it
  once with `lensForFov(deg)` and keep the exact focal length that comes out.
  Rounding it to a tidy millimeter moves the field, `framingDistance` goes as
  `1/tan(fov/2)`, and every beat fitted against the reference edit is a test that
  then fails. The screen-space helpers still take the angle — a frame is an angle
  and an aspect ratio ([ADR-0017](../adr/0017-the-lens.md)).
- Light is staging. A key's screen position is a product of two dot products
  that must both carry the right sign.
- Whiteouts are honest scene changes.
- Ask the font for its cap height rather than guessing it.

The proving scene (`tng-intro`) is timed against a frame-analyzed reference
edit at `~/Developer/tng-inertial`. `analysis/timeline.json` is the measured
spec and `data/frames/` holds the per-frame imagery; read the timeline's
`corrections` block before trusting its motion narrative. Measured numbers
(credit grid, fade windows, the locked camera, the flash envelope) are
regression tests in `cutscene.test.ts`. Change those numbers only to make the
recreation more faithful, and say so in the commit.

---

## The iteration loop

Two rungs, and the cheap one answers most questions.

**Sample the director in Node.** `openSession()` builds the world,
`harness.play('tng-intro')` prepares the script, and
`harness.cutsceneSample(epoch + frame / fps)` returns the frame — camera pose,
lens, hull pose, texts, effects — with no browser and no dev server. A
throwaway
script in a git-ignored `.scratch/` that prints a body's standoff in radii, its
angular radius, where its center and limb land on screen, where the star lands,
and the elongation, converges a camera knot in a second where a capture costs a
minute. **The first sample anchors frame 0 to its epoch**, so sample frame 0
first or every later frame is offset by the one you asked for.

**Then capture, because only a GPU can answer exposure.** Per shot, not the
whole piece:

```bash
cd ~/Developer/tng-inertial
node scripts/capture_render.mjs --out .data/shot --from 1755 --to 2100   # ~45 s
uv run scripts/compare_render.py .data/shot --out /tmp/shot-diff.csv
```

`--port` attaches to a Chrome that is already up, and keys that Chrome's
profile directory, so two agents capturing at once must use different ports.
There is **no `--help`**: passing it starts a full 2742-frame capture. Never
write to `analysis/render-diff.csv` from a partial capture — it is the
committed baseline the whole comparison is against.

Read the **signed** per-band table, not the mean-absolute one. Two large errors
of opposite sign average to a small number: the Saturn pass scored a
respectable +3.1 of exposure error across f413–470 while running −26.5 through
its entry and +18.7 through its exit, and the flat summary is what hid it.

Three things the reference's `subj_*` channel is not, and each has produced a
wrong beat table: it is **truncated** when the box touches a frame edge,
**saturated** when the subject fills the frame, and **inflated** when a second
lit component crosses the tracker's area floor. Where any of those hold, the
width is not a range. The channel that survives all three is a rigid landmark
on the subject itself — for the hull, the pair of Bussard collectors.

The reference audio is not in git and must not be. Publishing a full-sequence
render needs a rights check first. See [development](development.md).

`data/reference/tng-subject-track.json` is committed and is the one thing here
derived from that video: 1639 frames of bounding box, centroid and principal
axis for whatever the reference has lit in each frame. **Measurements, not
media** — there is no imagery in it and none should be added — and it is here
so `pnpm vitest` can hold a line fit or a beat table to the reference without a
frame dump. Regenerate it with `scripts/export_track.py` in the analysis
repository; the same rights care that applies to a render applies to anything
that would carry pixels.

---

## Related

- [Client](client.md) — camera precedence
- [Harness](harness.md) — `ir.play`, `ir.seekCutscene`
- [Driving](../agents/driving.md) — browser capture gotchas
