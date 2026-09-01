# tng-intro — what is left of the accuracy pass

`tng-intro` (`packages/devtools/src/cutscenes/tngIntro.ts`) is a shot-for-shot
study of the 1987 television title sequence, staged in the real Solar System.
Every timing and every composition in it is a measured number, so a render can
be dumped and diffed against the reference edit numerically rather than argued
about: `capture_render.mjs`, then `compare_render.py` over four channels —
titles, subject, orientation and exposure — with `compare_sheets.py` for the
eyes. The inner loop is in
[the cinematics guide](../../docs/guides/cinematics.md); the script's own
architecture is [ADR-0010](../../docs/adr/0010-cinematic-director.md).

Timing, the cut structure, the titles, the lighting geometry and the fitted
attitudes are landed and held by `packages/devtools/src/cutscene.test.ts` and
`apps/headless/src/hullClearance.test.ts`. What is left is the staging of two
approaches, and the machinery that would make a staged approach a fit rather
than a hand-read.

---

## 1. What the measurement can and cannot see

The reference channels are instruments, and several of them lie in named
places. A number read out of the wrong band is the most expensive mistake
available here: it produces a confident cause for a defect that has a different
one.

**`ref_subj_w` is not a range measurement in most bands.** It is truncated where
the box touches a frame edge, saturated where the hull fills the frame — 84
frames of the close pass sit at w ≥ 0.995 against all four edges — and inflated
where a second lit component crosses the tracker's 400-pixel floor. The channel
that survives all three is the pair of Bussard collectors, 265.5 m apart: rigid,
immune to clipping, and immune to glow. Every refit beat is measured on that
channel and spliced to the box only where the box is interior.

**The skim is not measurable at all.** 217 of its 282 tracked frames are
saturated and 273 touch a frame edge. It stays authored, and no fit is proposed
for it.

**The wipe is the clean case, not the cruise.** Fitting straight lines to the
reference itself: the wipe approach is ~9.5 km of path at a 0.13% perpendicular
residual, the cruise ~730 m at 9.5%, the credit descent ~800 m at 5.0% and
strictly monotone. Two orders of magnitude separate the wipe from everything
else, so it is where a new staging primitive gets proved.

**The subject channel scores the largest lit mass, so it is blind to the camera
being inside the ship.** That is `hullClearance.test.ts`'s job, and it is
deliberately a test rather than a runtime clamp: a director that quietly pushed
the camera out would make an authoring mistake invisible.

**The skim band already runs +12 of exposure over the reference**, and +30
through f2378–2381. A directional star-streak drive there would reproduce the
reference's baked motion blur by making a measured number worse; the reference's
speed reads as blur on a saucer that fills the frame, not as background stars.
Settled, not open.

**Read the signed table, not the mean-absolute one.** Two large errors of
opposite sign average to a small one — the Saturn pass scored +3.1 of exposure
error while running −26.5 through its entry and +18.7 through its exit.

**`atWidth` and the reference's box width carry two errors that cancel**, and
correcting either alone breaks the best stretch in the piece. The arithmetic is
written down at `tngIntro.ts:488`; read it before touching a range beat.

---

## 2. What still measures wrong

The two close approaches drift from the measured track. The descent's defect is
purely growth rate — its hull reads, and the ~215 missing-subject frames the
first pass found were all in descent-_early_, which the staged fill closed.

| Band                    | Reading                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| cruise close f856–1090  | the hull grows too slowly and sits high-right of the reference               |
| bank-away f880–900      | the maneuver starts here — cap-pair roll angle and cap area ratio both break |
| descent late f1990–2100 | growth reaches full frame 15–20 frames after the reference does              |

The late descent's authored x also jags by 0.126 of the frame's width between
f2065 and f2075, where the current beats splice the box channel to the
Bussard-cap channel. No straight line contains that step, and the heading swings
82.0° off the nose at f2068 because of it — which is why the property test's
descent window stops at f2036 rather than f2080. Refitting the band from the
per-frame track closes the jag and the window together.

---

## 3. Physical staging

The straight passes are staged as screen-space splines through sparse knots.
Between knots the interpolant is free to sag or wander, and nothing ties the
hull's facing to the direction the spline is moving it. Both are addressed by
staging the passes as lines and deriving what can be derived.

One addition to `packages/rendering/src/cinematic.ts` exists already; one solver
in devtools does not. No new asset format and no timeline JSON — the shot list
stays code.

### 3.1 The line

`linePath` — `{anchor, direction, advance}` in camera axes, with the advance
splined in log-range along the line — is in `cinematic.ts` and is not yet what
the script's straight passes are made of. Evaluating it gives position;
differentiating it gives velocity for free. The wipe becomes one `linePath` used
three times, mirrored by negating the lateral component, which is also the
measurement. Prove it on the wipe first, then the descent and the cruise.

### 3.2 Orientation derives from the path; attitude is an overlay

`orientationAlong(path, upHint)` is constant per line, maximally stable, and
cannot slide because it cannot vary. Authored attitude stays as a sparse overlay
— bank and pitch relative to the derived frame — present only where the
reference maneuvers.

A fitted line gives the hull's **flight path**, not its attitude, and the two
genuinely differ: the reference's hull climbs the frame through the cruise while
the camera plainly looks down on the saucer's top, so the ship flies nose-down
along a climbing path. That is a real attitude and it is exactly what has to be
authored on top of a derived frame rather than derived from it.

Do not derive orientation by finite-differencing the _screen_ splines. Near the
lens, sub-pixel wobble becomes large angular velocity; derive from the fitted
line, which is smooth by construction.

### 3.3 The fit solver, and the screen beats as the assertion

`fitLinePath(track, fov, aspect)` — weighted least squares, weighting each range
constraint by its width confidence, since a w 0.10 box fixes range far more
loosely than a w 0.95 one — lives in devtools and tests, never in the sample
path. Its input is the reference's per-frame subject track, committed as
`data/reference/tng-subject-track.json`: hundreds of tracked boxes against the
~15 hand-read beats the current lists were built from.

The measured screen beats stay in the file as the spec, and a test projects the
fitted line back to screen and asserts the residual against them. Authoring
stays in the measurement's language; staging becomes physical. Until it exists,
the nose-on-chord property is asserted against the authored beats' own chord,
which is not the line they were fitted to — the descent passes at 14.16° against
its own 15.0° bound for exactly that reason.

**Non-goals.** Keyframe asset formats, camera rigs, a `camera` entity, spline
editors, and depth of field — the reference has no measurable DOF, everything in
it is at optical infinity. One scene exists and the vocabulary it needs is
arithmetic.

---

## 4. Acceptance criteria not yet met

From `compare_render.py` on a full fresh capture. "Mean" is mean absolute
per-frame error against the reference; signed where stated.

- **Choreography bands**: cruise close and descent-late signed dw within ±0.06;
  bank-away signed dcy within ±0.04; every band's mean |dcx| and |dcy| ≤ 0.03.
- **The fits reproduce the beats**: the measured beats stay in `tngIntro.ts` and
  the line fits reproduce them within the solver's stated residuals.
- **Eyes last**: `compare_sheets.py` over each stage's frames. The numbers gate;
  a human signs off.

Each stage ends with a capture and a diff of the frames it touched, and the last
one is a full-sequence capture, diff and sheet review. Publishing any
full-sequence render requires the rights check in
[the cinematics guide](../../docs/guides/cinematics.md).

One standing judgment: the reference is itself a fan recreation, and where it
contradicts physics the script stages the shot the reference is _trying_ to be
rather than the frame it produced.
