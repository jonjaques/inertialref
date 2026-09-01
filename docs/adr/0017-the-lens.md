# ADR-0017: The camera has a lens, and the field of view is derived from it

Status: accepted · 2026-08-28

## Context

The engine stated its field of view in nine places and three values.

| Site                                                         | Says                               | For                           |
| ------------------------------------------------------------ | ---------------------------------- | ----------------------------- |
| `GameEngine.DEFAULT_FOV`                                     | 65°                                | the flight camera             |
| `App.tsx`, the `<Canvas camera>` prop                        | 65°                                | R3F's camera at construction  |
| `devtools/observatory.ts` `#fovDeg`                          | 65°, re-pushed every step          | the framing solver's standoff |
| `cutscenes/tngIntro.ts` `FOV`                                | 45°                                | the cinematic lens            |
| `render/flare.ts`                                            | `camera.fov ?? 65`                 | flare placement               |
| `render/warpEffects.ts`, twice                               | `camera.fov ?? 45`                 | the streaks                   |
| `planetarium/project.ts`                                     | `camera.fov ?? 65`                 | label projection              |
| `packages/rendering/src/terrainSelect.ts` `DEFAULT_VIEWPORT` | 60° over 1080 px                   | **the terrain SSE predicate** |
| `packages/rendering/src/lod.ts`                              | "~0.2 mrad ... at a 60 degree FOV" | the representation thresholds |

Three of those are fallbacks that fire exactly when the camera is not a
`PerspectiveCamera` — which is when the picture is least like the one they
assume — and two of them disagree with each other by 20°.

The one that mattered most is the eighth, because it is not a fallback. It is
the terrain refinement predicate's only source of optics, and it is a guess:
60° over 1080 pixels is neither the flight lens, nor the cinematic one, nor
anything the field-of-view slider's 20–110° passes through except in transit.
A node refines while `distance < spacing · scale` where `scale` goes as
`pixelsPerRadian`, so the guess sets how much terrain exists — every patch count
in [the terrain plan](../../design/plans/terrain.md), the `maxPatches` cap, and the level
the horizon settles at.

[Phase 1](0015-terrain-level-of-detail.md) made that predicate live. Phase 2 is
the geology, whose acceptance criterion is a plate review — "reads as a Moon,
not as noise" — and a band stack tuned against a 60° assumption and then looked
at through a 20° lens is a judgment made from plates composed through the wrong
optics. The cheap moment to fix it is after the machinery exists and before
anything is judged with it.

Underneath the arithmetic there is a second problem: [art](../design/art.md)
commits to photo mode with _"aperture and focal length — real depth of field and
real diffraction"_ and exposure _"quoted in real units"_, and an angle can
produce none of the three.

## Decision

**A lens is a lens, not an angle.** `packages/rendering/src/lens.ts` holds a
`Lens`: focal length, sensor gauge, zoom, f-number, focus distance, shutter and
gain. The field of view is derived from the first three. The reverse does not
work — given 65° there is no f/2.8 and no 18.84 mm; given 18.84 mm on a 24 mm
gauge, 65° is one line. Arithmetic, no Three.js, Node-tested, the same bargain
`cinematic.ts` and `observer.ts` make.

**The gauge is the sensor's vertical extent, and it is fixed at 24 mm.** Three's
`filmGauge` is the _long_ side and `getFilmHeight()` divides it by the aspect
ratio, so `setFocalLength` yields an angle that changes when the window does.
That is right for a strip of 35 mm film cropped to a format and wrong for a
sensor: a lens whose angle moved on a resize would move the terrain selection,
the observatory's standoff, and every composed shot with it. `CameraRig` writes
`camera.fov`, which Three treats as vertical and aspect-independent, and never
touches `filmGauge` or `setFocalLength`. The horizontal field is derived where
it is needed, from the viewport, which is where the aspect ratio lives.

**Every shipped composition keeps its exact angle.** `lensForFov(deg)` is the
one-way bridge every existing call site converts through, and it preserves the
angle rather than rounding to tidy glass: 18.836226925409882 mm and
28.970562748477143 mm. Taking the nearest millimeter moves the flight field from
65° to 64.6°, and `framingDistance` goes as `1/tan(fov/2)`, so every framed body
and every `SHOTS` bookmark would stand off 0.85% further for a reason that
appears nowhere in the diff.

**Zoom multiplies the focal length. It is not the dolly, and neither is
framing.** Three acts that shared one control:

| Act         | Changes                  | Parallax | Where it is now                       |
| ----------- | ------------------------ | -------- | ------------------------------------- |
| **Zoom**    | focal length × `zoom`    | no       | the lens sliders, in both panels      |
| **Dolly**   | the camera's distance    | yes      | the wheel, the pinch, and two buttons |
| **Framing** | distance, to fill a size | yes      | `F`, a preset, and **Frame**          |

The planetarium's View panel told the reader that narrowing the lens "pulls the
camera back rather than magnifying" and that "the subject stays the same size".
It did neither: `setFov` recorded an angle and nothing re-solved the standoff
until the next `focus`. The copy described a coupling nobody wired, which is
what happens when three acts share one number and no object owns it.

**The circle of confusion is a display pixel, not a film convention.** The
1/1500-of-the-diagonal rule is a claim about a 10×8 print at 25 cm; this image is
looked at through whatever drawing buffer the browser has. `c` is
`gauge · 1.5 / heightPixels`, which on a 24 mm gauge over 1520 px is 23.7 µm —
close enough to the 29 µm full-frame convention to be a sanity check rather than
a coincidence, and it moves with the display the way the blur it predicts does.

**The terrain viewport is display pixels, not the drawing buffer's.** `App.tsx`
multiplies the device ratio by `aaDprFactor`, so at 4× AA the buffer is twice the
display in each axis. Supersampling raises the sample count, not the detail a
viewer can resolve, and feeding the raw buffer height into the predicate asks for
6.5× the patches to render geometry the resolve filter averages away. The engine
divides its own supersampling factor back out; the place to spend on sharper
terrain is `cellPixels`, where it is a decision with a number on it.

**One producer, one lens.** [ADR-0011](0011-application-shell-and-modes.md)
already forbids a second producer of the camera pose, with the precedence
**cutscene, then observatory, then the ship**. The lens follows the same order
through the same code: a `CinematicSample` carries a `Lens` rather than a bare
`fov`, the observatory reads the host's lens instead of being pushed a scalar
every step, and the flight lens is the fallback. The three `?? 65` /
`?? 45` fallbacks are deleted rather than reconciled — a consumer that cannot see
the lens is a bug, not a case to have a default for.

The order has two arms rather than three, because the observatory has no lens of
its own: it solves a standoff against whatever the camera panel is set to. That
makes it the one consumer that must **not** read the composed lens, and the host
port says so — `framingLens()` returns the flight lens alone, beside the
`lensView()` that everything else reads. It produces a camera only when the
cutscene arm is null, so framing against a script's lens is the arm depending on
the one it is the fallback for; and because `focus` and `frameTarget` _store_ the
distance they solve, the error outlives the scene. Measured before the split:
focusing Earth during `tng-intro` parks the camera 29,761,384 m out against the
20,779,658 m the flight lens asks for — 43% too far, and nothing recomputes it.

**`LOD_THRESHOLDS.billboard` is derived from the pixel angle.** The comment
beside it read "~0.2 mrad is roughly a pixel at a 60 degree FOV on a 1080p
display". A pixel there is `atan(1/935)` — 1.07 mrad, five times larger — so the
threshold's angular _radius_ of 2e-4 described a body about a third of a pixel
across. The constant was doing a real job, because a star is always sub-pixel and
must still draw; the sentence beside it was not arithmetic. It is now a third of
a pixel of _diameter_, which comes out at 1.97e-4 at the flight lens over the
baseline and follows the lens the body is being looked at through. `sphere` and
`surface` stay constants: they are claims about representation, and a player who
narrows the lens has not moved closer to the planet.

## Alternatives considered

**Keeping the angle canonical and deriving a focal length from it.** One line
shorter and it forecloses photo mode: depth of field, diffraction and exposure
are all functions of the aperture, and an angle has none. Rejected.

**Three's `filmGauge` and `setFocalLength`.** They exist, and they encode a film
convention this camera is not: the gauge is the long side, so the angle they
produce is a function of the aspect ratio. Every consumer would then see the
field change on a window resize. Rejected; `camera.fov` is the only lens field
`CameraRig` writes — the aspect it writes beside it is the viewport's, not the
lens's.

**Rounding to tidy focal lengths** — 19 mm and 29 mm. `tng-intro`'s beats are
solved frame by frame against a frame-analyzed reference and its criteria are
tests, so a rounded focal length is a week of re-fitting. Rejected, and
`compositions.test.ts` is what holds the line: the cinematic 45° round-trips
bit-exactly, the flight 65° is one ulp out, and the induced motion in a framing
distance is 7.5 nanometers at Earth's radius.

**Raising `maxPatches` so the telephoto end stops saturating.** Measured (below),
20° wants up to 1,418 patches against a cap of 768. That is 6.0 M vertices and
288 MB of vertex buffers, on a lens the player has deliberately narrowed and
where one level coarser is a four-pixel error rather than a two-pixel one.
Rejected; the number is recorded instead, and `saturated` already reports it.

**Clamping the field-of-view slider to the range the predicate is comfortable
with.** The slider is a composition control and the predicate is supposed to
follow the picture, not the other way round. Rejected — this whole record is the
argument for the predicate reading the lens the picture is actually taken with.

## Consequences

**Every terrain number moved, and was re-measured rather than scaled.** The
flight lens is 848 px/rad against the old assumption's 935. Standing at two
meters, 1920×1080, 16 px a cell:

| Lens            | px/rad | Earth | Zoo, standing | Zoo, descent peak | Saturated steps |
| --------------- | ------ | ----- | ------------- | ----------------- | --------------- |
| 60°, the guess  | 935    | 300   | 336–444       | 415–460           | 0 of 128        |
| **65°, flight** | 848    | 294   | 330–438       | 385–449           | 0 of 128        |
| 110°, wide end  | 378    | 264   | 300–408       | 334–415           | 0 of 128        |
| 20°, telephoto  | 3062   | 665   | 529–642       | 687–742           | **77–108**      |

**The plan's own arithmetic overstated the telephoto end by an order of
magnitude**, and finding out why is the useful part. It predicted 21× the
patches at 20°, from `scale²`. Measured, the uncapped demand is 808 to 1,418
patches — 1.9× to 3.2×. Refinement runs out of _levels_ before it runs out of
budget: `surfaceDetailFloor` puts the zoo's floor at level 9 or 10, and a
balanced whole-disk tree has a floor of its own. A predicate bounded above by
the field's own detail cannot spend the square.

**The cap binds at the telephoto end and nowhere else.** 60–84% of a descent's
steps at 20° are one level coarser than the predicate asked for, flagged
`saturated`. Every lens a player flies with clears it with room.

**The zoom channel goes three levels past the table, and no cap covers it.** The
rows above are all at zoom 1, because that is where the field-of-view slider
ends; the zoom control multiplies another 8× onto the focal length, so 20° at 8×
is a 2.5° field at 24,500 px/rad. Measured, Miranda's basin descent wants
**20,174** patches there — 26× the cap, `saturated` on 128 of 128 steps rather
than on 92. That is a telephoto held on a subject rather than a lens anything is
flown behind, and the answer is the one the cap already gives: the disk goes
coarse by a stated amount and reports that it did. It is recorded because the
measurement stops where the controls do not.

**A distant body's tier now follows the lens.** Atlas at 104,146 km draws as a
`point` at 110° and as a `billboard` at 20° — which is what the threshold always
claimed to do and could not. It also moves the point at which a distant star
becomes a billboard by 1.7%, in the picture nobody diffs; that is a plate review
rather than a unit test, and it was done at both ends of the slider.

**The panels are instruments now.** Focal length with the angle beside it, zoom,
f-stop and focus over logarithmic travels, and the derived readings under them:
the sharp band, the blur circle against the pixel it has to hide inside, the
Airy disk against the f-number where it stops fitting, and the exposure in
stops. Two of those settle scope on sight. **Depth of field can never affect
terrain** — the hyperfocal distance is 5.37 m at the flight lens on a 1520 px
buffer, so everything at planetary range is at infinity and sharp, which is why
the defocus _pass_ can be deferred without blocking a terrain phase while the
_parameters_ cannot. And the flight lens is diffraction-limited only past f/12,
so the aperture is a free control until it is not.

**A preference changed shape.** `camera.fov` held one angle; `camera.lens` holds
seven numbers. `usePersistentState` gained a `migrate` hook that runs inside the
lazy initializer, so the old key is read once through `lensForFov` — a player who
moved the slider keeps the picture they chose and gains an aperture they did not,
and the new key becomes canonical the first time they touch it.

**The lens is presentation and stays there.** It lives in `packages/rendering`,
never on an entity, never in a save beyond a preference, and the state hash of a
flying session does not know it exists.

---

## Related

- [ADR-0011](0011-application-shell-and-modes.md) — the camera-producer precedence this mirrors
- [ADR-0015](0015-terrain-level-of-detail.md) — the predicate that was reading the guess
- [ADR-0010](0010-cinematic-director.md) — the other camera the lens has to serve
- [Art](../design/art.md#photo-mode) — the sensor fiction this implements
- [Planetarium](../design/planetarium.md#the-camera) — zoom, dolly and framing, as three controls
- [The terrain plan](../../design/plans/terrain.md) — the milestone this serves
