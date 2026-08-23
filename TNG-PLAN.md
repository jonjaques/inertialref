# TNG-PLAN — bringing `tng-intro` to cinematic accuracy

An engineering plan for the next pass over the title-sequence recreation
(`packages/devtools/src/cutscenes/tngIntro.ts`), written against a fresh
verification run on 23 Aug 2026. Everything numeric below is measured, either
by the reference pipeline in `~/Developer/tng-inertial` or by fits computed for
this plan; where a claim is a judgment rather than a measurement, it says so.

**Baseline for this plan.** A full 2742-frame capture of the current build
(`~/Developer/tng-inertial/.data/render2`, dumped today) diffs against the
reference identically to the committed `analysis/render-diff.csv` — the
on-disk diff is current, and the corrections narrated in `tngIntro.ts` are in
this baseline. The sequence is roughly half right: timing, titles, the cut
structure, and the first half of the cruise are essentially exact; the
deficits are concentrated in ship illumination at small apparent size, the
choreography of the two close approaches, orientation between authored beats,
and the warp-out staging.

---

## 1. Assessment of the current architecture

The architecture is sound and most of it should not move.

- **A scene is a shot list** (ADR-0010). Eight shots, each with its own
  camera placed against its own subject; the `CUTS` table
  (`tngIntro.ts:648`) is read by both the script and its tests. Cuts hide in
  darkness, behind flashes, or under a body filling the frame — verified by
  the tests in `cutscene.test.ts` ("covers every cut with darkness, a flash,
  or a full frame").
- **Pure arithmetic in `packages/rendering/src/cinematic.ts`**: Catmull-Rom
  routes, slerped aim routes, screen-space routes with log-range
  interpolation, fade/flash/spark envelopes, and the one- and two-target
  framing solvers (`frameTarget`, `frameTwoTargets`). All Node-testable.
- **Ship choreography is authored in the frame**: `(frame, x, y, range)`
  screen beats — the same language the reference measurements speak — plus
  authored `FACING_*` beats giving the hull's forward vector in camera axes
  (`tngIntro.ts:567,578`), slerped between knots.
- **The verification loop closes**: `capture_render.mjs` (CDP, ~5 min for the
  full dump, `--from/--to` for cheap per-shot loops), `compare_render.py`
  (three channels: titles, subject, exposure), `compare_sheets.py` (eyes).

Two structural weaknesses cause most of what Starfleet is complaining about:

1. **Orientation is authored, not derived.** The facing beats are sparse
   hand-written vectors; between knots the slerp has no reason to agree with
   the direction the screen-space spline is actually moving the hull, so the
   nose and the velocity diverge mid-segment — the "sliding" read. The
   f1000→f1035 pair (`tngIntro.ts:573-574`) slerps through roughly 120° in 35
   frames, and every intermediate orientation is whatever slerp passes
   through, not a flight attitude.
2. **Screen-space splines are the primary representation, not a
   measurement-fitting constraint.** Between sparse knots the interpolant is
   free to sag or wander; the late descent (below) reaches full frame ~15–20
   frames after the reference does for exactly this reason.

## 2. What is working — preserve it

Measured in today's diff; do not regress any of these:

| What                                 | Evidence                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Timing, fades, credit grid           | title channel Δcx 0.008 / Δcy 0.002 through the credits — essentially perfect                                      |
| The main-title throw                 | fit to p = 1.93, predicts tracked frames to a thousandth; title-shot subject Δ 0.021                               |
| The cut structure and static cameras | camera-hold tests pass; locked-off starfield matches reference `motion.json` (scale 1.0000)                        |
| Cruise entry f676–856                | signed error dcx −0.002, dcy +0.025, dw +0.013 — the best ship stretch in the piece                                |
| Skim placement f2100–2360            | dcy −0.008, dw −0.008 (dcx −0.057 is the one loose channel)                                                        |
| The director lifecycle               | play/stop/seek/restore, deterministic `renderTime` clock — no changes needed                                       |
| The wipe recipe                      | one animation, offset ×2, mirrored ×1 — this _is_ the measurement (and see §5: it is also a perfect straight line) |

## 3. Primary causes of the visual inaccuracies

Ranked by how much screen time each one damages.

**(a) The hero ship is invisible whenever it is small.** During the credit
descent the render's ship fails to register as a bright mass for nearly the
entire run — missing-subject runs f1770–1784, 1786–1832, 1834–1849,
1851–1898, 1900–1916, 1918–1964, 1966–1984 — while the reference shows a
small but clearly lit hull at the top edge (compare f1785: reference has the
saucer at (0.470, 0.023) w 0.080; the render shows almost nothing). The
incoming wipe hull is likewise undetectable at f1417–1424 and f1539–1543.
That is 200+ frames of the subject of the piece not reading. This is
lighting/material, not choreography: the beats put the hull where the
reference has it, at the right size, and it does not catch light.
_Observation: the JTVFX hull is strongly self-lit (window rows, panel glow)
even at w 0.06. Assumption to verify in the browser: the render's key
placement is fine and the deficit is emissive/exposure at small scale._

**(b) The two close approaches drift from the measured track.** Signed
render-minus-reference means from today's diff:

| Band                    | dcx    | dcy        | dw         | Reading                                             |
| ----------------------- | ------ | ---------- | ---------- | --------------------------------------------------- |
| cruise close f856–976   | +0.069 | −0.061     | **−0.186** | hull grows too slowly, sits high-right of reference |
| bank-away f976–1090     | +0.018 | **−0.137** | −0.004     | exits too early / rides too high                    |
| descent late f1990–2100 | +0.052 | +0.106     | **−0.427** | growth reaches full frame ~15–20 frames late        |

At f916 the reference hull is w 0.959 at (0.337, 0.335) — the camera already
inside the envelope, saucer overhead-left — while the render shows the whole
ship at w 0.478, nose-on, centered. At f2085 the reference fills the width
(w 0.974) entering the skim; the render is at w 0.302. _Caveat: the subject
channel measures the lit mass, so (a) and (b) are partially the same number —
fix lighting first, then re-judge the choreography bands._

**(c) Orientation between beats** — cause 1 in §1. No measurement channel
exists for it today (§7 adds one), but the mechanism is visible by
construction: nothing ties the slerped facing to the spline's velocity.

**(d) Warp-out staging.** The reference keeps the stretching hull readable
through both flashes — at f2397 it is still w 0.681 at (0.493, 0.543), a
recognizable ship with glowing nacelles mid-streak; at f1106 a small ship
shape with a modest trail at (0.654, 0.701). The render hurls the hull to
`atWidth(0.0008)` (`tngIntro.ts:474`) and draws a thin lens line across the
quadrant instead. Flash exposure is also still hot: flash-1 mean error 16.5,
flash-2 28.3.

**(e) The Earth opening is mis-staged.** Worst shot in the piece: subject
Δwidth 0.229, exposure error 22.4. At f150 the reference has terrain filling
the right two-thirds, limb slashing top-right→bottom-left, blue atmosphere
rim, the sun as a warm ball at upper-left, stars visible. The render has the
limb curving the other way, terrain washed-out pale, no sun in frame, no
stars. The phase-ramp strategy (`tngIntro.ts:723-788`) is right in intent —
the reference is physically self-contradictory and the ramp is the honest
version — but its current execution does not produce the reference's
composition at any point in the shot.

**(f) Small, definite items.** Saturn entry: at f413 the reference shows a
ring sliver at the corner (w 0.095 at (0.967, 0.889)); the render opens with
w 0.31 of planet already on screen. Eclipse entry f240–260 runs bright where
the reference is nearly black (eclipse-in exposure 17.5). The outro card's
`(JTVFX)` accent renders inside the blue mask, dragging the measured centroid
to 0.494 where the reference's blue-only centroid is 0.371 — the reference's
accent is gold and out of mask. The skim's background stars are streaked in
the reference (f2214 — baked motion blur conveying camera speed) and static
in the render.

## 4. The measured case for physically-staged ship motion

For this plan, straight-line fits were run against the measured screen tracks
(camera-space positions recovered through the same lens math the script uses):

| Pass                      | Perpendicular residual          | Advance          | Verdict                                                                                |
| ------------------------- | ------------------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| cruise approach f676–896  | 109 m over a 4.0 km path (2.7%) | monotone         | **straight line** (residual ≈ ⅙ hull length, concentrated in the noisy far-end widths) |
| wipe approach f1288–1316  | 19 m over 35.9 km (0.05%)       | monotone         | **exactly a straight line** — max screen error of the on-line projection is 0.017      |
| credit descent f1775–2100 | 134 m over 6.9 km (2.0%)        | monotone         | **straight line**                                                                      |
| skim f2180–2380           | 17 m over 303 m (5.5%)          | **non-monotone** | genuinely curved — keep authored                                                       |

A _constant-velocity_ line does not fit (the reference holds range f760–f792
— both w ≈ 0.40 — then rushes in), so the honest model is **fixed direction,
varying speed**: the ship flies a straight line and throttles. That is
precisely the "enormous starship: massive, stable, deliberate, approximately
linear" brief, and it is what the reference footage actually contains. The
only authored maneuvers the reference shows are the bank-away f976–1120
(f1080: stern quarter from below, visibly banked), the skim, and the
warp-outs.

## 5. Architectural changes

One addition to `packages/rendering/src/cinematic.ts`, one derivation rule,
one solver in devtools. No new asset format, no timeline JSON — the shot list
stays code.

**5.1 `linePath` — a straight trajectory with an authored advance profile.**
`{ anchor: Vec3, direction: Vec3 (unit), advance: readonly {frame, t}[] }` in
camera axes, with `t` splined in **log-range along the line** (the existing
log-space insight, applied to one scalar instead of three channels).
Evaluating it gives position; differentiating it gives velocity for free.
The wipe becomes one `linePath` used three times (mirror = negate the lateral
component of `anchor`/`direction`), which is now also the measurement.

**5.2 Orientation derives from the path; maneuvers are overlays.**
`orientationAlong(path, upHint)` = `lookAlong(direction, up)` — constant per
line, maximally stable, sliding impossible by construction. Authored attitude
becomes a sparse _overlay_ (bank/pitch relative to the derived frame),
present only where the reference maneuvers: the bank-away, the skim, the
warp-out hold. `FACING_CRUISE`/`FACING_TITLES` (`tngIntro.ts:567,578`)
disappear for straight passes; their bank numbers survive as overlays. Do
not derive orientation by finite-differencing the _screen_ splines — near
the lens, sub-pixel wobble becomes large angular velocity; derive from the
fitted line, which is smooth by construction.

**5.3 A fit solver, and the screen beats become the assertion.**
`fitLinePath(track, fov, aspect)` — weighted least squares (weight range
constraints by width confidence; a w 0.10 box fixes range far more loosely
than a w 0.95 one) — lives in devtools/tests, not in the sample path. Input
is the reference's **per-frame** subject track, which `render-diff.csv`
already carries (`ref_subj_cx/cy/w` for every frame — hundreds of tracked
boxes against the ~15 hand-read beats the current lists were built from).
The measured screen beats stay in the file as the spec; a test projects the
fitted line back to screen and asserts residuals against them. Authoring
stays in the measurement's language; staging becomes physical.

**Non-goals.** Keyframe asset formats, camera rigs, DOF simulation (the
reference has no measurable DOF — everything is at optical infinity), a
`camera` entity, spline editors. One scene exists; the vocabulary it needs is
arithmetic (ADR-0010's argument still holds).

## 6. Camera and ship-motion strategy

- **Cameras: keep every static camera static.** The reference measures them
  locked (`motion.json` scale 1.0000 through credits); translation cannot
  move a shell starfield anyway. The planet passes keep their standoff-spline
  cameras and `frameTarget`/`frameTwoTargets` aim solving — that machinery is
  already systematic; the Earth shot needs re-solving, not new machinery.
- **Ship: straight `linePath` + throttle for every pass the fits bless**
  (cruise approach, all three wipes, the descent, both warp-out exits —
  a warp-out is the extreme throttle case of the same line), authored curves
  only for the bank-away and the skim.
- **Frame the skim's speed with an effect, not a camera move**: a directional
  star-streak drive in `CinematicEffects`, on during f2100–2360, matching the
  reference's baked motion blur (f2214). _This is an interpretation — the
  only place this plan reproduces a look by effect rather than by staging;
  verify against the reference sheet and drop it if it reads wrong._
- **Warp-outs: the ship stays on stage.** Keep the hull at readable scale
  ~10 frames longer with an elongation/streak treatment anchored on the hull
  (`WarpFx.tsx`), shrink the bare lens-line, and re-anchor the residual at
  the measured exit points (f1106 (0.654, 0.701); f2397 (0.493, 0.543)).
  Bring flash means onto the measured 81–100 peak (currently +16.5/+28.3).

## 7. Tooling and visualization

In priority order; the first two gate the choreography work.

1. **An orientation channel in `compare_render.py`.** Principal-axis angle
   and aspect ratio of the subject mask, plus the nacelle-glow blobs (red
   pair / blue grilles are color-isolatable) as landmark points. This is what
   makes "is the hull oriented like the reference" a number instead of an
   opinion. Also: update its `SHOTS` buckets to the current cut table (it
   still carries `veil`, removed from the script), and add the signed
   per-band summary used in §3 (worst-N lists hide systematic sign).
2. **Export the reference subject track** (`ref_subj_*` columns) as a JSON
   the repo's tests can consume, so `fitLinePath` fits and beat assertions
   run in `pnpm vitest` without the imagery.
3. **A debug overlay behind an `ir` verb** (devtools layer): the active
   shot's authored track, the reference track as ghost boxes, and the
   nose/velocity vectors projected to screen. Cheap DOM/SVG over the canvas;
   makes a seek-and-compare loop visual instead of arithmetic.
4. **Property tests** (`property-tester` agent): nose-along-velocity within
   tolerance on every `linePath`; angular velocity bounded (< ~2°/frame
   outside authored maneuver windows); range monotone through approaches;
   the wipe mirror exact in x.
5. The per-shot capture loop is already cheap (`capture_render.mjs
--from 1755 --to 2100` ≈ 45 s) — document it as the inner iteration in
   `docs/guides/cinematics.md`.

## 8. Implementation order

Each stage ends with a capture + diff of the affected frames; numbers below
are the exit criteria (§9 collects them).

1. **Make the small ship read** (lighting/material; biggest visible win, no
   choreography risk). Diagnose at `ir.seekCutscene(1800)` — key angle vs
   emissive vs exposure — then fix the descent f1765–2100 and wipe entries.
   Files: `tngIntro.ts` (lockShot key), `ShipModel.tsx`/materials.
2. **Refit the close pass and late descent from the per-frame track**
   (tooling items 1–2 first). Re-derive f856–1090 and f1990–2130 so the
   growth curve and vertical placement match; fix the bank-away exit timing.
   This can land as densified beats before 5.1 exists — the fit tells you the
   beats either way.
3. **Land `linePath` + derived orientation** (§5) on the cruise approach
   first — it is already near-perfect, so it is the regression-guarded proof
   — then the wipes, descent, and warp-out exits. Delete the facing beats
   for straight passes; keep bank overlays.
4. **Warp-out staging** (§6): readable stretching hull, smaller lens line,
   measured anchors, measured flash means.
5. **Re-stage the Earth opening**: solve the composition at 4–5 knots with
   `frameTwoTargets` (disk _and_ sun on their measured marks — sun ≈
   (0.45, 0.43) throughout), fix the palette/exposure, keep the phase ramp.
6. **Small fixes**: Saturn entry sliver (f413), eclipse-entry exposure, gold
   `(JTVFX)` accent (`CutsceneOverlay.tsx` style), lens-spike width at
   f1133.
7. **The skim polish**: star-streak drive, and the −0.057 dcx placement.
8. **Full-sequence capture + diff + sheet review**; update
   `docs/guides/cinematics.md` and `CONTEXT.md` (`/context-log`).

Stages 1–2 are independent of 3 and can go in either order; 4–7 are
independent of each other. Each is one `worktree-implementer`-sized change.

## 9. Acceptance criteria

Per shot/band, from `compare_render.py` on a full fresh capture. "Mean" =
mean absolute per-frame error against reference; signed where stated.

- **Ship presence**: missing-subject frames inside the credit run < 10 total
  (from ~215); wipe entries detected from their first reference frame ±2.
- **Choreography bands** (after lighting is fixed, so the channel is
  honest): cruise close and descent-late signed dw within ±0.06; bank-away
  signed dcy within ±0.04; every band's mean |dcx|, |dcy| ≤ 0.03.
- **Orientation** (new channel): principal-axis angle mean error ≤ 5° on
  straight passes; no frame-to-frame swing > 2°/frame outside authored
  maneuver windows.
- **Exposure**: every shot's mean-luminance error ≤ 8, flashes on the
  measured 81–100 peak — except the `veil` window f253–260, which is an
  accepted deviation (the reference's foreground moon cannot be staged on
  Mars's anti-sun line; documented in `tngIntro.ts:903-921`).
- **Earth**: subject Δwidth ≤ 0.06, sun detected in frame on its measured
  mark ±0.05 from f150 on, exposure error ≤ 10.
- **Titles**: no regression — credits Δcx ≤ 0.01 / Δcy ≤ 0.005; outro blue
  centroid within 0.03 of the reference's 0.371 once the accent goes gold.
- **Tests**: `pnpm check` green, including the new property tests; the
  measured beats stay in `tngIntro.ts` and the line fits reproduce them
  within the solver's stated residuals.
- **Eyes last**: `compare_sheets.py` over each stage's frames — the numbers
  gate, a human (or vision pass) signs off.

Known uncertainties, restated: the subject channel conflates lighting with
geometry until stage 1 lands; the skim streaks are an interpretation; the
descent-invisibility root cause needs one browser session to pin; and the
reference itself is a fan recreation — where it contradicts physics (Earth
key light, §3e) the plan follows the script's existing policy of staging the
shot the reference is _trying_ to be. Publishing any full-sequence render
still requires the rights check in `docs/guides/cinematics.md`.

---

## 10. Corrections, from building it

Written after the implementation pass, in the form
`analysis/timeline.json`'s own `corrections` block takes: every claim below
was checked against a number, and each says what to measure to check it. The
plan's timings and its structure held. Several of its _motion_ and _cause_
claims did not — which is the reference pipeline's own lesson, met again.

**§3(f), the outro accent, was the wrong culprit.** The accent is already gold
and has never been inside the blue mask. Splitting the mask by row band shows
the 0.778 right edge sitting in the _label's_ rows (0.370–0.434), not the
name's (0.467–0.541): the caption "After The Recreation By" runs 2.8× the
width of the reference's "Video By", and a label rides its name's element flush
left, so its length is extent added to the right of the block. Shortening it
and putting the name on the reference's mark took the blue centroid from 0.495
to **0.373** against the reference's 0.371.

**§4's fit table is a fit to `tngIntro.ts`'s own beats, not to the reference.**
Refitting the same lines to the authored splines reproduces all four of its
numbers to within a few percent, including the skim's non-monotonicity.
Against the reference the real figures are: cruise approach ~730 m of path
(not 4.0 km) with a 9.5% perpendicular residual; credit descent ~800 m (not
6.9 km) at 5.0%, strictly monotone with zero backsteps; wipe ~9.5 km at
**0.13%**; and the skim is **not measurable at all** — 217 of its 282 tracked
frames are saturated and 273 touch a frame edge. So §8's advice to prove
`linePath` on the cruise "because it is already near-perfect" is backwards: the
wipe is the clean case, by two orders of magnitude.

**The mirrored wipe's offset is 126, not 128.** Reference against reference,
mirrored in x, the second wipe's own tracked boxes agree with the first's to a
thousandth on every frame at 126 and are two frames early at 128.

**§3(e)'s "physically self-contradictory" Earth was a bad ruler.** The 7.2°
sun–limb clearance came from measuring to the lit mask's bounding-box corner,
which sits at mid height rather than on the limb. Fitting the visible limb as a
cone gives **16.7°**, recovers the standoff on every frame rather than the one
unclipped one, and predicts the reference's own frame luminance to ±2.6 across
f140–200. There was no contradiction to stage around; the shot is
self-consistent and is now derived rather than tuned.

**The bank-away starts at f880–900, not f976** — cap-pair roll angle and cap
area ratio both break there, 76–96 frames earlier than the plan's window.

**`ref_subj_w` is not a range measurement in most of the bands the plan reads
it in.** It is truncated where the box touches a frame edge, saturated where
the hull fills the frame (84 frames at w ≥ 0.995 in the close pass alone), and
inflated where a second lit component crosses the tracker's 400-pixel floor.
The channel that survives all three is the pair of Bussard collectors.

**The reference's hull is nose-on or bow-quarter in every pass, never
broadside**, so its box width is the saucer's disc (463.7 m) rather than the
ship's length. `atWidth` still divides by `HULL` because the render's own
effective width is 618 m — two errors that have been cancelling, and correcting
either alone breaks the best stretch in the piece. Both are now written down in
the source.

**The titles shot had no warp-out beats at all.** From the f1092 cut the hull
held at the first wipe's entry knot — a 0.012-wide dot — and did not move for
twenty-six frames; `SHIP_CRUISE`'s exit beats belong to a shot that has already
ended. That is why §6's f1106 anchor was unreachable.

**§9's "flashes on the measured 81–100 peak" is one flash's peak.** The first
peaks at 100.0 and the second at 117.2, a constant ×1.17 in output mean at
every matched frame. And both start about two frames before their measured
start: f1085 and f2382 are threshold crossings in the shot detector, not the
frames the light begins — the same distinction `THRESHOLD_FRACTION` already
draws for the titles.

**The ~215 missing-subject frames are entirely in descent-_early_** (f1765–1990,
205 of them). Descent-late has none; its defect was purely growth rate.

**The camera was inside the ship, and no channel could see it.** Through the
skim the beats put the camera 125–170 m from the hull's origin — inside a
saucer 467 m across. Decoding the glTF's vertex positions in Node and reducing
them to a per-column height field in hull axes puts it _within the surface
envelope_ for forty-eight frames, f2234–2281, by up to 3.5 m, and within a
metre either side of that; at f2188 the shot is the inside of the saucer with
the engineering hull's battle bridge showing through the plating. The reference
diff is structurally blind to this — its subject channel scores the largest lit
mass, and an interior wall is a large lit mass — so it was found by eye and is
now held by `apps/headless/src/hullClearance.test.ts`, which walks every frame
the hull is on stage and asserts 15 m of daylight. Deliberately a test rather
than a runtime clamp: a director that quietly pushed the camera out would make
an authoring mistake invisible. The skim's ranges open from 125–170 m to
190–220 m, which is the least that clears it, and a knot at f2355 stops a
log-range spline undershoot that had put the camera back within 11 m of the rim
in the middle of a stretch whose authored knots were all clear.

**The skim star-streak interpretation (§6, §8.7) is dropped**, on the evidence
§6 asked for. The render is already +12 of exposure brighter than the reference
across the skim band, and +30 through f2378–2381; the reference's speed there
reads as motion blur on a saucer that fills the frame, not as background stars,
which are barely visible behind it. Adding a light-emitting effect to a band
that is already too bright would be reproducing a look by making a measured
number worse.
