# The sensor: post-processing, exposure and the second pass at HDR

[art](../../docs/design/art.md) says the canopy is a sensor, and this page is
the plan for building the sensor: the two response modes, exposure as a control,
glare, depth of field, motion blur, noise, grading, and a second pass at the
extended-range output. Every effect here is a property of the instrument
[ADR-0017](../../docs/adr/0017-the-lens.md) already defines. None has a slider
of its own.

What this page is not: the atmosphere, the ground and the star population have
their own plans, and the Milky Way is [the galaxy](the-galaxy.md), which depends
on § 4 of this one for its brightness and on nothing else here.

## Implementation status

[ADR-0031](../../docs/adr/0031-the-sensor-response.md) records the implemented
chain and the deliberate changes to this proposal. Natural preserves the
production lighting calibration, ACES fit and integrated sky; Neutral and the other Composite presets
use the hue-preserving response and physical stellar flux. Direct uses the lens
exposure. This preserves the default look while exposing photographic choices.

Exposure, the histogram meter and clamps, the PSF halo, near/far defocus,
tile-based motion, detector noise, vignetting, lateral color, SDR dither, P3
output, white balance and response presets are implemented. The meter reduces
on the CPU after an asynchronous GPU readback. The scene MRT packs velocity
and reciprocal depth into one attachment. Three held Enterprise portraits
exercise the camera and focus controls.

Open work: the FFT diffraction tier, glass-specific iris sample rotation,
spectral emission and narrowband filters, photo export and tether controls,
and the complete per-pass performance matrix below. Browser headroom discovery
remains unavailable in the measured Chrome configuration. The explicit peak
cap remains necessary. The numbered sections below retain the proposed design
and budgets for comparison; they are not a completion checklist.

---

## Where the numbers come from

Every figure below is one of three things, and each is labeled: a **measurement**
from `design/plans/perf.md` or a spike, taken on an Apple M5 at 1600×900 DPR 1
in the occluded rig, or at 1920×1080 in [spike 2](../../docs/spikes.md#2--tsl-and-the-atmosphere-integral);
a **published number** with its source; or a **budget**, which is a claim this
plan makes and the phase that lands it measures. A budget is not a measurement, and the perf
plan's caveats apply to all of it: `renderer.info.render.timestamp` double-counts
the output pass and read 14.6 ms for a 7.27 ms frame, so every GPU figure a phase
records comes from `render/measure.ts` — wall clock across a drained queue — or a
raw timestamp query.

Three facts about three r185, read from the installed source rather than the
docs, shape the architecture and are stated here so nobody re-derives them:

- **The renderer already tone-maps once, at the end.** Materials never apply the
  curve; `Renderer._getFrameBufferTarget` draws the scene into an internal
  `HalfFloatType` target whenever a tone mapping is selected and `_renderOutput`
  blits it through `renderOutput(toneMapping, outputColorSpace)`. Additive stars
  already sum in linear radiance. `RenderPipeline` uses the same node, honors a
  `CustomToneMapping` registered on `renderer.library`, and clamps nothing — the
  sRGB OETF encodes 2.0 as 1.353 and the quad draws straight into the
  `rgba16float` canvas.
- **`toneMappingExposure` is a per-frame uniform handed to the curve as its
  second argument.** `installToneCurve`'s `Fn([color, exposure])` already
  multiplies by it. The exposure hook exists; what is missing is a producer.
- **A `useFrame` at priority 1 takes the render away from R3F.** `update()` runs
  every subscriber and then draws only `if (!internal.priority)`. So the sensor
  owns the frame by mounting one callback, after every priority-0 consumer and
  after `EngineTick` at −1, and nothing else changes.

---

## 1. Principles

Four rules, each of which decides several of the items below.

**Every effect reads the lens, and the lens has one producer.** The blur circle
is `circleOfConfusion(lens, viewport)`; the streak is `lens.shutter` against the
frame's simulated interval; the noise is `lens.iso` against a full well; the
glare is the aperture's point-spread function; vignetting is the field angle. A
strength slider on any of them would be a second lens. The two knobs the bible
grants are the response curve's shoulder — Composite's licensed curve — and the
comfort clamps, and both are preferences rather than effect parameters. Anything
the settable fields cannot carry — the iris blade count, the glass's vignetting
correction, its scatter fraction, its lateral color — is a property of the lens
_design_, constant per preset, and lives beside `LENS_PRESETS` as a `Glass`
record rather than on `Lens`, because a photographer does not set it.

**Radiance is linear and physical until the response.** The scene carries
luminance in a stated unit, the exposure is a number derived from EV, and the
curve is the last thing that touches a pixel. The reason this needs stating is
float16, and § 4 has the arithmetic.

**The picture is a function of the tick.** Adaptation integrates over
`clock.renderTime`; noise is a hash of the pixel and the tick; motion blur reads
the simulated frame interval. Nothing here reads wall time, which is what keeps
`tng-intro`'s frame-by-frame criteria and photo mode's "a stepped frame is exact"
true with the chain on. Where a shot needs a fixed exposure it says so in
`CinematicEffects`, because a pinned exposure is staging.

**One chain, two parameter sets.** Direct and Composite are the same passes with
different numbers: a linear-clip response against the filmic one, the lens's own
gain against an automatic one, the raw cos⁴ falloff against a flat field, the
true PSF against the same PSF. A mode is a record, not a branch, which is the
same argument the one-curve-two-ranges design makes: two pipelines cannot drift
apart if there is one.

---

## 2. The chain

Built in `render/sensor.ts` around one `RenderPipeline`, driven by
`scene/Sensor.tsx` from a `useTimedFrame('sensor', …, 1)` so it lands on the
Render track beside the other ten. `postProcessing.outputColorTransform = false`,
and the chain ends in its own `renderOutput`, because the response has to be
chosen per mode and the alpha has to be written as 1 — the pass's clear alpha
reaches `output.a`, and an alpha-0 pixel on the `rgba16float` canvas is the
compositor artifact `flare.ts` documents.

```
scene ─▶ pass(scene, camera)          MRT: output · velocity · viewZ        rgba16float, MSAA as today
      ─▶ depth of field               half res, near/far, scatter-as-gather   § 5
      ─▶ motion blur                  tile max / neighbor max                § 6
      ─▶ glare                        PSF mip chain; FFT convolution tier    § 3
      ─▶ sensor                       residual exposure · noise · vignette · lateral color   § 4, § 7
      ─▶ response                     Direct: linear to clip · Composite: the tone curve     § 4
      ─▶ output                       P3 or sRGB encode · SDR dither · alpha 1                § 8
HUD   ─▶ DOM, after, at fixed luminance — unchanged
```

Two things the order encodes. The lens-side effects — defocus, the shutter,
diffraction — happen in radiance before the sensor sees anything, so they read
the unclamped buffer and a star's glare is computed from the star's radiance,
not from a thresholded copy of it. The sensor-side effects — gain, noise, the
response — happen after, and nothing after the response touches color except the
encode.

`viewZ` is written to the MRT rather than recovered from the depth texture. The
depth buffer is logarithmic and, past 2e6 m, compressed
([ADR-0003](../../docs/adr/0003-render-coordinates.md)); a view-space Z from the
vertex stage is metric in the uncompressed near field, which is the only field
the blur circle is ever non-zero in — the hyperfocal distance tops out at 4.47 km
with the telephoto racked out, three orders inside the compression boundary.
Half-float precision there is relative, about 10⁻³, and the circle of confusion
is `(d − s)/d`, so the error it carries is the same order and never a pixel.

`velocity` is three's `VelocityNode`: NDC now minus NDC last frame, from a
per-object previous world matrix and a per-camera previous view. A rebase is a
rigid translation of render space applied to the camera and every object alike,
so the model-view product is unchanged across one and the velocity of a body at
rest is zero on a rebase frame. That is a property, and `sensor.gpu.test.ts`
asserts it rather than trusting the argument.

What three ships and what this chain writes itself, from the r185 source:

| Effect         | `three/addons/tsl/display`                                                                                 | Here                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Bloom          | `bloom()`: threshold, five separable Gaussians at half res, no firefly clamp                               | Written: an energy-conserving mip chain with the PSF's radial profile, no threshold          |
| Depth of field | `dof()`: `smoothstep` over a world-unit "focal length", 64-tap gather, disc only, nothing reads the camera | Written: the lens's own circle of confusion, near/far, pre-multiplied gather, the iris shape |
| Motion blur    | `motionBlur()`: N samples along the velocity, uniform weights, no tiling                                   | Written: McGuire's tile-max / neighbor-max, depth-ordered weights                            |
| Velocity       | `velocity` — used as is                                                                                    |                                                                                              |
| Grain          | `film()`                                                                                                   | Written: shot and read noise in linear, § 7; `film()` is display-space grain                 |
| Lateral color  | `chromaticAberration()` — used as is, driven from `Glass`                                                  |                                                                                              |
| LUT            | `lut3D()` — used as is, with a LUT this code generates                                                     |                                                                                              |
| Anti-aliasing  | `traa()`, `smaa()`, `fxaa()`                                                                               | Not used; § 10                                                                               |

Boot learns the chain's target and not yet the chain. `warmRenderer` binds a
target of the pass's shape around every compile, so the scene's pipelines are
built for the pass rather than for a framebuffer nothing draws into
([ADR-0029](../../docs/adr/0029-the-sensor-spine.md)). `RenderPipeline` still
builds its quad material on the first `render()`, and a pipeline compiled on the
first presented frame is exactly the hitch the warm-up census exists to hide, so
phase 1 gives `render/warmup.ts` a producer for the chain's own materials,
registered by label like every other one.

---

## 3. Glare is the aperture's point-spread function

The aperture is a designed object and the bible licenses its artifacts on that
basis, so the glare is _computed from the aperture_ rather than drawn. Two
components, one source.

**The halo.** A lens scatters a fraction of every pixel's light into a wide,
roughly `1/θ²` skirt — the veiling glare index of a coated lens is a published
1–3% (budget: 1.5%, on `Glass`). A mip chain carries it: downsample with the
13-tap filter, upsample tent, weights fitted to the PSF's radial profile so the
sum over the chain is exactly the scatter fraction and the direct image keeps the
rest. No threshold. A threshold is how a sunlit planet gets a halo while a
first-magnitude star, forty stops fainter and much more visible against black,
gets none; the profile applied to unclamped radiance gives each its own.

**The spikes.** An N-blade iris diffracts a point source into 2N spikes (N when
N is even), each falling as roughly `1/θ²` along its length. At the flight
lens's 6.7 mm aperture and 550 nm the first null is 0.10 mrad — the
`angularResolution` `lens.ts` prints — which is a twelfth of a pixel at 848 px/rad
over 1080 lines, so the _core_ is sub-pixel and the sprite the star field already
draws stands in for it. The spikes are not sub-pixel: a source at 10⁵ times
diffuse white has a spike ten pixels long still above white, and a hundred
pixels long at a twentieth of it. They are computed as an FFT convolution of the
buffer's hot pixels with a kernel that is the Fourier transform of the iris
polygon, baked at boot from `Glass.blades` and the lens, 512² at quarter
resolution, recomputed on a zoom or aperture change (budget: **1 ms** for the
kernel, once per change). The convolution is a quality tier — Composite _full_ —
because a 512² forward and inverse FFT per frame is a budget of **1.5 ms** on the
target laptop, half the post line on its own, and the halo alone is most of the
look.

**What this retires and what it keeps.** `flare.ts`'s `glow` and `streak` are a
hand-drawn halo and a hand-drawn spike for one source; once the PSF exists they
are two drawings of what the chain now computes for every source — the star, the
drive's exhaust, a specular sea, an engine's radiator — and they go. The ghost
chain, the aperture ring and the corona stay as sprites: ghosts are internal
reflections along the axis of symmetry, which no convolution produces, and the
corona is anchored on the _occluder_, which needs `flareMath.ts`'s analytic
answer to which body is in front. `flareArtifacts` and the planetarium's Glare
slider keep their meaning — the ghost chain — and the "Lens flare" switch keeps
its.

**What it does to the star field.** Today a star's prominence is a ramp relative
to the brightest star in view, spent on sprite size as well as intensity,
because a sprite that is only smaller stops reading as fainter at one pixel. Once
the halo and spikes are the PSF, the sprite is the PSF's core at a fixed 1.5–2 px
and its intensity is _flux_ — luminosity over distance squared, in the scene's
unit, through the same exposure as everything else. Sirius looks bigger than
its neighbors because its wings are brighter, which is the sentence the material
already has in a comment. The ramp and its floors go with the glow and the
streak, and § 4 says what the faint end looks like in each mode.

---

## 4. Exposure

### The unit, and why float16 needs pre-exposure

The scene carries **luminance in cd/m²**, scaled by a constant, and everything
emissive states its value in those terms: the Sun's disk at **1.6 × 10⁹ cd/m²**
(published), a sunlit albedo-1 surface at about **3 × 10⁴**, the Milky Way's
band at 22 mag/arcsec² or **2 × 10⁻⁴** (published, via
`L = 1.08 × 10⁵ · 10^(−0.4 S)`), a dark sky at 21.9 or 1.7 × 10⁻⁴. The disk to
the band is thirteen orders of magnitude. Half-float carries 12 with the subnormals
and about 9 at full precision — 65,504 down to 6.1 × 10⁻⁵ — so **no fixed scale
puts both in the buffer**, and this is not hypothetical: today's constant
exposure means the internal target holds raw values, and whichever end is drawn
outside the range is silently clipped or zeroed.

Frostbite's answer is the standard one and it is the one taken: **pre-exposure**.
Every scene material multiplies its radiance by last frame's total exposure at
output, so the buffer holds values near 1 whatever the scene is, and the sensor
pass applies only the _residual_ — this frame's exposure over last frame's. A
sunlit planet in Composite puts the band at 6.7 × 10⁻⁹ of saturation, which
underflows to zero, and that loses nothing: it is 27 stops under white,
fourteen below any display's floor, invisible in that frame at any gain.
Whatever underflows was not going to be seen; whatever could be seen survives.
The multiplier is one uniform in the material factories under `render/`;
the ship's standard material takes it through `material.outputNode`, and
`materials.gpu.test.ts` holds each one to it.

The alternative — an `rgba32float` scene target — is declined. Blending into a
32-bit float attachment needs `float32-blendable`, an optional WebGPU feature,
and the star field is twenty thousand additive draws; it is also twice the
bandwidth on a frame that is fragment-bound near a planet.

### Direct: the lens's own exposure

Saturation is `L_sat = 1.2 · 2^EV100` cd/m² (Lagarde & de Rousiers, _Moving
Frostbite to PBR_, 2014), with `EV100` from `exposureValue(lens)` — **EV 8.9** at
the default f/2.8, 1/60 s, ISO 100, which saturates at 573 cd/m². That is an
interior exposure, and a cockpit is an interior: pointed out of the canopy at a
sunlit planet it blows out six stops over, and pointed at the night sky it
records the Sun's brightest neighbors and nothing else. Both are what the bible
says Direct does — _"a star in frame destroys the frame"_, _"invisible, unless
you dwell long enough to integrate it"_ — and the second is the invitation:
shutter and ISO become sliders in `LensSection` beside aperture and focus, and a
thirty-second shutter shows the Milky Way, with star trails, because motion
blur reads the same field.

### Composite: automatic gain, with the star as the ceiling

Composite adds a **gain** beside the lens: a derived `Exposure` record on the
engine — set EV from the lens, auto EV offset from the meter, adapted EV, the
clamps — read by the frame loop and printed by `OpticsSection` as
`EV 8.9 set · +6.3 auto`. The gain is never written into `lens.iso`. The lens has
one producer, and a meter writing the ISO would be a second one wearing the
readout's clothes.

The meter is a luminance histogram, in compute: `textureLoad` over the pass
output at a quarter of the resolution, 64 log₂ bins over 32 stops in a
`workgroupArray` with `atomicAdd`, flushed to a `storage().toAtomic()` buffer, a
second kernel reducing it to a target EV. It meters the **40th to 95th
percentile** rather than the mean, because the mean of a sky is black with a
planet in it and the meter would open all the way to expose the black; and the
target puts that band's upper edge at the shoulder. Three's compute primitives
cover all of it — `workgroupArray`, `atomicAdd`, `workgroupBarrier`,
`storage`, `instanceIndex`, `getArrayBufferAsync` — and there is no built-in to
reach for. The readback is asynchronous with one frame of latency, which the
adaptation below makes invisible; the alternative of reading the buffer inside
the curve's `Fn` is possible on WebGPU and impossible on the WebGL backend, and
the fallback's exposure is the lens's set value plus a fixed Composite gain, no
meter.

**Adaptation** is exponential approach with two time constants, **0.4 s toward
bright and 3.5 s toward dark** (the bible's numbers), integrated over the
simulated frame interval from `clock.renderTime`. The **clamp** is two
preferences, both registered in `state/preferences.ts` under `display`: a rate
multiplier and a range in stops either side of the set exposure, defaulting to
+8/−4. The range is what stops Composite from turning a black sky into a
noise-floor gray; the rate is the comfort setting
[ux](../../docs/design/ux.md#accessibility) names as the single most important
one in the game. A third preference, the peak cap, is § 8's.

**The star is the reference white, and that is the curve's business.** With the
meter exposing for the picture, the Sun's disk is always at the clamp — it is
10⁵ times a sunlit surface — and _"a G star's disk reaches display peak"_ is a
statement about where the curve's headroom ends, not about the meter. The two
per-body exposure adjustments the renderer carries — the star stopping down as
its disk grows from 0.015 to 0.1 rad, and `adaptationFor` opening a body under
0.12 albedo as it fills the frame — are what a global meter does on its own: a
disk that is the picture drives the histogram, and so does a dark asteroid. Both
retire when the meter lands, and the acceptance test is the same two pictures:
Bennu at 500 m reads at its 0.12 target, and the Sun filling the frame reads as
its surface.

**The faint end, in each mode.** Through a physical exposure the flux ramp is
gone, so a sixth-magnitude star is 10⁻¹⁰ of the Sun's disk and, in Direct at
EV 8.9, not there. That is correct and it is the design. In Composite the gain
opens to the clamp, the sky reaches the noise floor § 7 gives it, and the field
resolves to about the limiting magnitude a sensor at that gain would reach —
eighth to tenth — with the noise that comes with it. The magnitude floors in
`materials.ts` exist because a constant exposure has no other way to show a
faint star; a variable one does not need them.

### The scripted picture

A `CinematicSample` carries a `Lens`; `CinematicEffects` gains `exposure`, an EV
offset a shot pins, 0 everywhere else. `tng-intro` is measured frame by frame
against a reference edit, and a meter that re-exposed the shot on the hull's
albedo would move every one of those criteria; the script states its exposure
and the measurement stands.

---

## 5. Depth of field and the iris

The parameters exist; the pass does not. The circle of confusion in pixels at
distance `d` for a lens focused at `s` is

```
c(d) = A · f · |d − s| / (d · (s − f)) / pixelPitch,     A = f / N
```

with every symbol already in `lens.ts`, and the near/far limits it implies are
the ones `OpticsSection` prints. Two consequences settle the design:

- **It is a near-field pass.** Hyperfocal is 5.37 m at the flight lens over
  1520 lines and 4.47 km with the telephoto racked out; at planetary range every
  pixel's circle is under half a pixel. The pass runs at half resolution, and
  the sensor pass computes the frame's maximum circle for free while it meters,
  so when nothing in frame blurs the pass does not run — which is most of the
  time in flight, and never in photo mode near a hull.
- **Layers, not a gather.** The blur is split near and far about the focus
  plane, each gathered at half resolution with the circle pre-multiplied into the
  color so a sharp foreground does not bleed into a soft background, the near
  layer dilated so its edge softens outward — the _Call of Duty: Advanced
  Warfare_ construction (Jimenez, 2014) — and the sample pattern is the iris:
  `Glass.blades` sides, the polygon rotated by the blade angle, so a defocused
  star is a nonagon at f/2.8 and a circle wide open. The pattern is a constant
  array per glass, not a texture.

Photo mode's focus control is the existing `focus` slider; the panel's "In
focus" row is the acceptance readout, because the picture and the number come
from one function.

---

## 6. Motion blur and the shutter

The streak of a pixel is its velocity times the fraction of the frame the
shutter was open:

```
blur = velocity_ndc · clamp(shutter / Δt_sim, 0, 1)
```

`Δt_sim` is the simulated interval between the last two presented frames, from
`clock.renderTime`. At 1× on a 60 Hz display a 1/60 s shutter is a full-frame
streak, a 180° cinema shutter is half, and at 100,000× warp the same shutter is
a 1/1680 of the frame's motion — the picture is a sharp frame every 28 minutes
of simulated time, which is exactly what a camera at that shutter would record,
not a smear. So warp needs no special case; the formula has one.

The pass is McGuire et al. (2012): tile-max over 20 px tiles, neighbor-max, then
a per-pixel gather along the neighborhood's dominant velocity with depth-ordered
weights, so a fast ship in front of a still planet blurs over the planet and the
planet does not blur over the ship. Blur length is clamped at the tile size,
which bounds the cost and is what makes a thirty-second Direct exposure in orbit
show star trails a tile long rather than a frame wide.

Off in the planetarium and the docs, on in flight and cinema. The planetarium's
camera is an instrument with no shutter of its own — it flies to a target over
`log(distance)` and a streaked fly-to is motion for its own sake — and that is a
presentation stance the mode pushes, not a switch a component writes.

---

## 7. The sensor's own signature

Three small effects, each a number on `Glass` or `Lens` and none a slider.

**Noise.** Photon shot noise is `√N` on `N` electrons; a full well of 20,000 e⁻
at ISO 100 puts the signal-to-noise ratio at 141 at saturation and 14 at 1% of
it, and gain divides the well: at ISO 12,800 saturation is 156 e⁻ and the ratio
12.5. Read noise is 3 e⁻, a floor of 1.5 × 10⁻⁴ of saturation at base ISO —
which is the floor Composite lifts shadows to, with the noise that is there.
Added in linear before the response, from a hash of the pixel and the tick, so a
stepped frame is exact and a paused one is still. Direct crushes below it; that
is the bible's row.

**Vignetting.** A rectilinear lens falls off as cos⁴ of the field angle. At the
flight lens the corner of a 16:9 frame is 52° off axis and cos⁴ is 0.14 — nearly
three stops, which is what a 65° lens with no correction actually does. Real
wide glass is designed to recover most of it, so `Glass.vignettingCorrection`
holds what the design recovers (0.6 for the flight lens, budget), Direct shows the
remainder, and Composite flattens the field. Cheap, physical, and a first-order
part of why a photograph reads as a photograph.

**Lateral color.** Three's `chromaticAberration()` driven by a coefficient on
`Glass` — a quarter of a pixel at the corner of the flight lens, less on the
cinematic one. Placed lens-side, before the sensor, because it is a shift of the
image and not of the numbers.

---

## 8. The second pass at HDR

What the first pass built is right: one curve, the probe as the load-bearing
signal, the three-state override. What "even better" means is five specific
things.

1. **Physical exposure through the existing hook.** § 4 is the largest change to
   the picture on the extended path, because the curve's headroom is finally
   spent by a value that means something: the shoulder sits where the meter puts
   it, and a star's disk lands in the lift because it is 10⁵ over white, not
   because a sprite was authored bright.

2. **The hue of a hot star is measured before the curve is chosen.** The RRT fit
   in `tonemap.ts` skews per channel toward white as radiance climbs, and a
   K star's limb rendered through it turns a nicer orange than its temperature —
   which the bible forbids. Three also ships `agx` and `neutral`; the decision
   between keeping the ACES fit, swapping the curve under the same headroom
   lift, or applying the fit on luminance alone is made by a measurement, not a
   preference: hue angle of a 3,000 K and a 10,000 K blackbody across
   radiances 0.1 to 100, in `tonemap.gpu.test.ts`, drawn by `drawGraph` on a
   float target. The test `CONTEXT.md` says is missing is the same test. The
   outcome is an ADR either way, because [art](../../docs/design/art.md#hdr) says
   "ACES-derived" and the record has to say why that held or why it moved.

3. **Wide gamut.** A blackbody at 3,000 K and the pink of Hα are outside sRGB,
   and the extended-range canvas can carry P3 — but three never passes a
   `colorSpace` to `context.configure`, and setting `outputColorSpace` to the
   addon `DisplayP3ColorSpace` alone makes the blit encode P3 into a canvas
   declared sRGB, which is wrong colors rather than more of them. The
   experiment: re-`configure` the context after `renderer.init()` with
   `colorSpace: 'display-p3'` and the same `toneMapping`, register the P3
   space through `ColorManagement.define`, and verify on a P3 panel that a
   `(1, 0, 0)` in P3 lands outside sRGB in a captured frame. It is a spike in
   the sense of `docs/spikes.md`, and it gates phase 5; `blackbodyColour` then
   emits XYZ and the encode chooses the primaries.

4. **Headroom is still authored, and it gets a cap.** No browser exposes the
   display's headroom unflagged; the `ScreenDetailed` proposal exists and
   Chrome carries it behind a flag, and re-checking that is a line in every
   phase's verification, not a dependency. So `EXTENDED_HEADROOM` stays 2, the
   curve stays continuous in it, and the **peak cap** — the preference
   [ux](../../docs/design/ux.md#accessibility) lists beside the adaptation clamp —
   becomes a uniform that lowers it, so a viewer who wants the range without the
   glare has the control the bible promised.

5. **The SDR path gets dither.** An eight-bit encode of a 21-to-23 mag/arcsec²
   gradient — the galaxy's band against the sky — bands visibly, and Firefox is
   an entire browser on that path. Triangular-PDF dither at ±1 LSB in the output
   pass, hashed like the noise, on the standard path only; the extended one is
   sixteen bits of float and needs none. Measured by counting distinct values
   across the ramp before and after.

Two things the second pass leaves exactly as they are, on purpose: the HUD stays
DOM, composited after, with `dynamic-range-limit` holding the backdrop blur
under a star; and the probe-over-media-query asymmetry in `resolveOutputMode`
stands, because nothing in the platform has changed the finding that the media
query is wrong in both directions.

---

## 9. Grading is a declared filter

_"Mapped, not invented; saturation follows the sensor's response, not a mood."_
So grading here is three things and none of them is an authored LUT:

- **The response.** Composite's curve with its shoulder, and named presets of
  the shoulder — the "selectable response curve" of the canopy fiction. One
  uniform that already exists.
- **White balance, declared.** The sensor is calibrated to D65 and stays there
  by default, because a camera auto-balanced to a K star would render its light
  white and that is the "nicer orange" rule in reverse. Photo mode offers a
  balance control, and the readout says it is set.
- **The filter set.** Broadband, and the narrowband composite the bible resolved
  — Hα, OIII, SII mapped to channels, declared on the readout. The composite
  needs the _scene_ to carry emission lines, which today nothing emits; the
  galaxy's HII regions are the first thing that will. The seam is an
  `emission` MRT attachment beside `output`, three narrowband channels, that the
  filter pass composites when the filter is not broadband and ignores when it
  is. Named here, built when there is something to put in it.

`lut3D()` is used where a 3D LUT is the cheapest way to apply a fitted transform
— the P3 gamut map on the SDR path, a preset's response — and the LUT is
generated by this code from parameters, at boot, never loaded.

---

## 10. Declined, with the arithmetic

- **Temporal anti-aliasing (`traa`).** Declined for now. The star field is
  sub-pixel sources on a shell that is rewritten in one frame every few minutes
  and every ninth frame at warp, and a history buffer either ghosts through the
  rewrite or rejects most of the sky every frame; MSAA and the supersampled tier
  already cover geometry. Revisit if the depth-of-field or motion-blur gathers
  need a temporal filter to hide their sample counts, and then only with the
  shell excluded from history.
- **Three's `dof()`, `bloom()` and `motionBlur()` as shipped.** Each is the
  simple form of its effect — a `smoothstep` circle that reads no lens, a
  thresholded Gaussian chain, an unweighted line — and each would need its
  physics grafted on. Writing the three passes against the lens costs about
  what adapting them would and leaves nothing to explain.
- **A screen-space ghost pass (`lensflare()`, Frostbite-style).** It ghosts
  every bright pixel, which under a physical exposure is the whole galactic
  band, and it cannot answer which body is in front of the star. The sprite
  chain has the analytic answer and the corona; it stays.
- **A `float32` scene target instead of pre-exposure.** § 4.
- **A vignette, grain or bloom slider.** § 1. The place to change how the
  picture looks is the lens, the glass, or the response.
- **Authored `.cube` LUTs.** An image by another name, and a mood rather than
  a mapping.

---

## 11. Phases

Each phase lands on its own, is gated by a measurement, and ends with the
decision it settled written into an ADR and the section above it deleted.

**Phase 0 — the spine** has landed:
[ADR-0029](../../docs/adr/0029-the-sensor-spine.md) records the decision, the
plate gate and the cost at five operating points, level with the frame the
renderer drew for itself. The one piece of it still open is the chain's own
warm-up producer, below.

**Phase 1 — exposure.** The unit, pre-exposure in every material, the
`Exposure` record, the histogram kernel and its CPU twin, adaptation and the two
clamp preferences, Direct and Composite as a preference and a keymap action,
shutter and ISO sliders, the readouts, `CinematicEffects.exposure` pinned in
`tng-intro`. The star stop-down and `adaptationFor` retire. Gate: `tng-intro`'s
measured criteria hold; Bennu at 500 m and the Sun filling the frame both read as
before; `exposure.test.ts` holds the arithmetic — monotone in EV, pre times
residual equals total, the time constants converge, the clamp binds; the
histogram kernel against its CPU count on the real GPU; the WebGL fallback
draws with the fixed gain.

**Phase 2 — glare.** The PSF mip chain, `Glass` on the presets, the star sprites
as PSF cores at flux, the flare's glow and streak retired, the FFT tier behind a
preference. Gate: a star's halo integrates to the scatter fraction within 2%
(`psf.gpu.test.ts`); the sky from Earth orbit at Composite shows a field to about
eighth magnitude and the perf plan's `Render/starfield` figure does not move;
FFT tier measured at 1080p and recorded.

**Phase 3 — depth of field.** The near/far pass, the iris pattern, the early-out
from the meter. Gate: the blur circle drawn on a calibration target at 2 m and
at the hyperfocal distance matches `circleOfConfusion` within half a pixel; the
pass costs nothing when no pixel blurs, measured.

**Phase 4 — motion blur.** Velocity in the MRT, the tile passes, the shutter
fraction, the rebase property test, the planetarium's stance. Gate: a body at
rest has zero velocity across a rebase; a thirty-second exposure in orbit draws
trails; cost at 1080p recorded.

**Phase 5 — the sensor and the output.** Noise, vignetting, lateral color, SDR
dither, the hue measurement and its ADR, the P3 spike and — if it passes — the
P3 encode and XYZ colors. Gate: distinct-value count across the sky ramp on the
SDR path; the hue drift numbers in the ADR.

**Phase 6 — grading and filters.** The response presets, white balance in photo
mode, the `emission` seam. Gate: the readout states every processing that is on.

Budgets at 1080p on the target laptop, to be replaced by measurements as each
phase lands:

| Pass                     | Budget  | Runs                            |
| ------------------------ | ------- | ------------------------------- |
| Spine, MRT resolve, blit | 0.15 ms | always                          |
| Histogram and reduce     | 0.05 ms | Composite                       |
| PSF mip chain            | 0.40 ms | always                          |
| FFT spikes               | 1.50 ms | Composite full, a preference    |
| Depth of field           | 0.80 ms | only when the meter sees a blur |
| Motion blur              | 0.60 ms | flight and cinema               |
| Sensor pass and output   | 0.20 ms | always                          |

Without the FFT the always-on set is **0.8 ms** and the whole set 2.2 ms,
against the 3.0 ms line [technical](../../docs/design/technical.md#frame-budget--166-ms)
gives atmosphere and post together. What the atmosphere's LUT path costs per
frame at each operating point is not in the perf plan and phase 1 measures it
first, because the post budget is what is left after it.

---

## 12. The order it is worth taking

1. **Phase 1.** Nothing else on this page is honest until the exposure is, and
   the galaxy plan is waiting on it. The spine it hangs from is in
   ([ADR-0029](../../docs/adr/0029-the-sensor-spine.md)).
2. **Glare.** The largest visible change per millisecond, and it retires two
   sprites and a magnitude ramp.
3. **The P3 spike**, early and in isolation, because it might fail in the
   browser rather than in the renderer and the answer changes phase 5's shape.
4. **Depth of field**, because photo mode is a first-class feature and it is
   the effect the lens has been promising in a readout since ADR-0017.
5. **Motion blur, then the sensor's signature.** Each small, each measurable.

---

## Caveats that shape these numbers

- **Every millisecond above is a budget until its phase measures it.** The
  spine's line is measured — level with the frame it replaced, at five
  operating points, in [ADR-0029](../../docs/adr/0029-the-sensor-spine.md) —
  and the rest are claims. The M5 is well above the target laptop, and the perf
  plan's rig is 1600×900; a 1080p figure on the target is what the table wants
  and nothing here has one yet.
- **The atmosphere's per-frame cost is unmeasured on the LUT path.** Spike 2's
  7.27 ms is the raymarch the LUTs replaced; the number that bounds this plan's
  budget is the one the LUTs cost now.
- **The pre-exposure argument assumes the adaptation rate bounds the frame-to-
  frame change.** A script that pins an exposure 27 stops from the meter's in
  one frame would read a zeroed buffer for that frame. No shot does; the
  `CinematicEffects` pin is an offset, and a test that steps it by more than the
  clamp in one tick belongs in phase 1.
- **The hue measurement decides a curve, not a look.** Whichever curve wins, the
  headroom lift and the SDR-equals-tonemapped-HDR property are retained, and the
  test asserts both.

## Not in this plan, deliberately

Reversed-Z, which [art](../../docs/design/art.md#also-required) lists and
[ADR-0003](../../docs/adr/0003-render-coordinates.md) calls complementary — a
depth-buffer change, not a sensor one. Ambient occlusion, screen-space
reflections and global illumination, which three ships and which a hull in
sunlight would benefit from; none is a property of the sensor and each is a
lighting question for the ship plan. Nebulae, zodiacal light and airglow, which
are scene emitters — this page gives them an exposure to be seen at and a
filter to be seen through.

## Reproducing

```bash
# the chain's cost at an operating point: `ir.gpu()` is `measureGpuFrameMs`
# through the chain, the perf dock's "measure gpu" button without a click.
# Pin the world with a save loaded *after* the look, so the star survey has
# settled and two runs are at one tick — ADR-0029 has the protocol and why.
node scripts/drive.mjs --url 'http://localhost:5173/?timing=full' \
  --js "await ir.gpu(60)" --down

# a still at headroom 1 for the phase-0 diff, then the same at extended range.
# The override is the `render.hdr` preference on /settings/display, and
# changing it remounts the canvas; set it, then:
node scripts/drive.mjs --url 'http://localhost:5173/' --shot spine.png --down

# the kernels on the real GPU: histogram, PSF energy, the curve's hue, velocity across a rebase
pnpm test:gpu -- sensor psf tonemap
```
