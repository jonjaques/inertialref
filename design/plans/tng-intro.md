# tng-intro — what is left of the accuracy pass

`tng-intro` (`packages/devtools/src/cutscenes/tngIntro.ts`) is a shot-for-shot
study of the 1987 television title sequence, staged in the real Solar System.
Every timing and every composition in it is a measured number, so a render can
be dumped and diffed against the reference edit numerically rather than argued
about: `capture_render.mjs`, then `compare_render.py` over four channels —
titles, subject, orientation and exposure — with `frame_similarity.py` for what
no mask covers and `compare_sheets.py` for the eyes. The inner loop is in
[the cinematics guide](../../docs/guides/cinematics.md); the script's own
architecture is [ADR-0010](../../docs/adr/0010-cinematic-director.md).

Timing, the cut structure, the titles, the lighting geometry and the staged
flight are landed and held by `packages/devtools/src/cutscene.test.ts` and
`apps/headless/src/hullClearance.test.ts`.

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

**The subject channel scores the largest lit mass, so it is blind to the camera
being inside the ship.** That is `hullClearance.test.ts`'s job, and it is
deliberately a test rather than a runtime clamp: a director that quietly pushed
the camera out would make an authoring mistake invisible.

**It is also blind to the largest lit mass not being the ship.** Through
f1096–1104 the reference's brightest object is the first warp flash's wash, and
its centroid moves as the flash forms — which is why `WARP_OUT_1_RAIL` misses
the tracked track there by 0.14 of the frame and is right to.

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
written down at `SHIP_CRUISE`'s close-pass comment; read it before touching a
range beat.

---

## 2. The staging, and what is still authored

Every straight pass in the piece is a line now, and its attitude is derived
from that line rather than authored beside it. Two forms, because the reference
constrains the camera differently in different shots.

**The cruise is a `TrackedPass`.** There is no text on screen through f532–1091,
so nothing measures the camera as locked, and the shot is a starship flying past
— which is a thing a camera does something about. The hull is a `LinePath`, the
camera stands at `ship − range · standoff`, and the framing is solved through
`frameTarget`, so the screen mark and the apparent size are satisfied by
construction: sampled against every authored beat, the reproduction error is
0.000. What the camera buys is everything the diff is blind to. The nose is on
its own velocity to 0.000° at every frame instead of a mean 54°; the hull's
speed is one number instead of a range from 0.5 to 629 m per frame; and the
camera swings 130° around the pass, which the starfield shows.

**The titles shot flies rails against a locked camera.** The reference measures
that camera locked wherever text is on screen — 375 to 433 matched starfield
inliers at scale 1.0000 — so a solved camera is not available, and the physics
comes from the rail alone. With the camera holding still that is enough: a
straight ship is a straight _image_ line. The three wipes, both warp-outs and
the credit descent are `LinePath`s; `cutscene.test.ts` audits every throttle for
reversal at four samples a frame and projects every rail back to the beats it
was fitted to.

**What is still authored is the skim**, f2131–2379, and deliberately. Its beats
are a camera-clearance solution rather than a trajectory — a straight line
fitted to them wants to pass 33 m from the hull's centre — so the hull's nose
still sits a mean 89° off its own path there, on the one stretch the reference
cannot arbitrate.

### The next piece, if there is one

The credit sequence wants to be **one straight rail with a camera that tilts**:
the ship descends toward the lens, passes overhead, and the camera pitches up to
watch it go to warp. That is what the reference is, it would fold the skim and
both of its neighbours into a single pass, and it is the only staging that makes
the skim physical. The reason it is not done is the locked-camera constraint:
the pan can only begin at f2032, because Wheaton's credit is the last text on
screen and nothing may move before it clears. Whether 350 frames is enough to
carry a tilt that follows a ship overhead is a question for a capture, not for
this file.

Two smaller things:

- **`fitLinePath` does not exist as a shipped solver.** Every direction and
  throttle in the file was fitted offline and landed as numbers with a residual
  test beside them. That is honest and it is not reusable; a second scene would
  fit its lines by hand again.
- **The fits are against the ~25 authored beats, not the per-frame track.**
  `data/reference/tng-subject-track.json` carries hundreds of tracked boxes and
  nothing reads it yet. Weighting each by its width confidence is what would
  turn the descent's 0.09-of-the-frame residual at f1920–1960 into a statement
  about the reference rather than about which beats were hand-read.

**Non-goals.** Keyframe asset formats, camera rigs, a `camera` entity, spline
editors, and depth of field — the reference has no measurable DOF, everything in
it is at optical infinity.

---

## 3. What a fresh capture says

`capture_render.mjs` over the whole piece, then `compare_render.py`, against the
committed `analysis/render-diff.csv` baseline. Mean absolute per-frame error;
the arrow is baseline → now.

| band          | \|dcx\|       | \|dcy\|       | \|dw\|            | exposure    |
| ------------- | ------------- | ------------- | ----------------- | ----------- |
| earth         | 0.070 → 0.104 | 0.011 → 0.022 | 0.229 → 0.220     | 22.8 → 17.8 |
| eclipse       | 0.080 → 0.073 | 0.042 → 0.037 | 0.097 → 0.083     | 10.0 → 4.1  |
| jupiter       | 0.070 → 0.054 | 0.064 → 0.075 | 0.061 → 0.059     | 4.0 → 3.8   |
| saturn        | 0.033 → 0.026 | 0.056 → 0.040 | 0.095 → 0.080     | 17.1 → 4.3  |
| cruise-entry  | 0.013 → 0.038 | 0.025 → 0.060 | 0.050 → 0.076     | 1.6 → 3.3   |
| cruise-close  | 0.069 → 0.075 | 0.172 → 0.137 | 0.199 → 0.267     | 14.1 → 13.9 |
| bank-away     | 0.052 → 0.060 | 0.142 → 0.086 | 0.049 → 0.117     | 8.5 → 13.2  |
| flash-1       | 0.107 → 0.031 | 0.033 → 0.023 | 0.127 → 0.089     | 33.5 → 4.0  |
| wipe-1        | 0.024 → 0.112 | 0.034 → 0.062 | 0.046 → 0.165     | 12.5 → 4.1  |
| descent-early | 0.043 → 0.013 | 0.248 → 0.055 | 0.165 → 0.075     | 2.3 → 2.0   |
| descent-late  | 0.051 → 0.010 | 0.106 → 0.114 | **0.427 → 0.094** | 7.8 → 4.6   |
| skim          | 0.071 → 0.070 | 0.053 → 0.046 | 0.013 → 0.050     | 16.2 → 9.2  |
| flash-2       | 0.100 → 0.237 | 0.040 → 0.085 | 0.124 → 0.302     | 28.3 → 11.4 |
| end-cards     | 0.050 → 0.017 | 0.014 → 0.011 | 0.066 → 0.055     | 2.9 → 0.7   |

Signed, where §4 states a target: cruise-close dw −0.184 → −0.262, bank-away dcy
−0.130 → −0.053, descent-late dw **−0.427 → −0.093**.

`frame_similarity.py` — global SSIM and gradient difference on a 240 px
luminance image, which is the complement to the four masked channels and sees
what none of them cover — ranks the frames worth opening. Three runs dominate:
**f948–1031** (SSIM 0.06 at worst), **f136–172** (0.18), and the three wipe
exits **f1316–1322 / f1442–1449 / f1563–1570** (0.08).

### The three things the eyes found, in order

1. **The hull is too dark, and it is not a staging problem.** Through the whole
   cruise the reference's ship carries bright red Bussards, a blazing blue
   deflector and lit window rows; ours is a grey disc. That is what
   `cruise-close`'s dw −0.262 is made of: the subject channel scores the largest
   _lit_ mass, and at 311 m our lit mass is 0.585 of the frame where the
   reference's is clipped at 1.000, on a hull whose geometric silhouette
   subtends 1.02. The shortfall is shading, not range — and moving the camera
   in to close it costs the hull-clearance margin, since 311 m is already inside
   the saucer's own 233 m radius.

2. **The wipes want hull-scale motion blur.** The reference's f1442–1445 is a
   saucer smeared into a comet across the frame. Ours is a crisp hull and then a
   thin blade: `warpEffects.ts`'s smear is one quad stretched between two
   frames' screen positions, which is the right idea at a tenth of the size the
   shot needs. Pulling the wipe wash back from 0.55 to 0.30 took those bands'
   exposure error from ~12 to ~4 and left this standing in plain sight.

3. **The Earth shot's disk is 20% too small** (dw 0.220, the largest width error
   left in the piece) and its centroid sits 0.10 left. That is a standoff, and
   the reference's own f239 says 4.90 radii against the 4.30 the script holds —
   held there deliberately, because the eclipse's f240 camera is built from the
   same number and the match cut matters more than the last frame's diameter.
   Worth revisiting now that both sides could move together.

---

## 4. Acceptance criteria not yet met

From `compare_render.py` on a full fresh capture. "Mean" is mean absolute
per-frame error against the reference; signed where stated.

- **Choreography bands**: cruise close and descent-late signed dw within ±0.06;
  bank-away signed dcy within ±0.04; every band's mean |dcx| and |dcy| ≤ 0.03.
- **Eyes last**: `compare_sheets.py` over each stage's frames. The numbers gate;
  a human signs off.

Each stage ends with a capture and a diff of the frames it touched, and the last
one is a full-sequence capture, diff and sheet review. Publishing any
full-sequence render requires the rights check in
[the cinematics guide](../../docs/guides/cinematics.md).

One standing judgment: the reference is itself a fan recreation, and where it
contradicts physics the script stages the shot the reference is _trying_ to be
rather than the frame it produced.
