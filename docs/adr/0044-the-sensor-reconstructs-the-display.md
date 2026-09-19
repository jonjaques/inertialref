# ADR-0044: The sensor reconstructs a smaller scene at display size

Status: accepted · 19 Sep 2026. Supersedes the logarithmic WebGPU depth
convention of [ADR-0003](0003-render-coordinates.md) and the anti-aliasing
renderer remount described in [ADR-0029](0029-the-sensor-spine.md).

## Context

Terrain, atmospheric shells and transparent effects shade the same display
pixels. Reducing the scene target reduces that fragment work, but a bilinear
resolve loses edges and detail. Temporal reconstruction also needs motion and
linearizable depth. The logarithmic depth buffer preserves the scene's range
but cannot be passed through the perspective depth formula FSR uses.

Anti-aliasing and reconstruction cannot be independent switches. Temporal FSR
requires single-sampled input, while supersampling and reduced render scale
ask the same target to grow and shrink. Rebuilding the renderer for an edge
setting also destroys unrelated device resources and recompiles the scene.

## Decision

**The sensor owns reconstruction, one picture record owns its legal settings,
and WebGPU uses reversed floating-point depth.**

`render/picture.ts` defines `aa`, `scale` and `sharpness`. Native MSAA remains
the default. Spatial FSR accepts raw or four-sample input at reduced resolution;
temporal FSR accepts zero samples at native or reduced resolution. Supersampling
uses native scale and doubles each drawing-buffer axis. The ratios are 1.5 for
Quality, 1.7 for Balanced, 2 for Performance and 3 for Ultra performance.
Sharpness is off, standard at 0.8, or crisp at 1.

`render.picture` migrates saved `render.aa` choices once. The page's `?picture=`
override does not write the preference. The resolver preserves an unsupported
wish while WebGL uses native scale and resolves temporal edges to MSAA. The
panel disables unavailable choices and explains why. Picture changes rebuild
the sensor; output-format changes still rebuild the renderer.

WebGPU uses `reversedDepthBuffer` and a `FloatType` scene depth attachment.
WebGL selects logarithmic depth before backend initialization. A standard
float depth buffer over the 0.05 m to 10¹⁰ m camera range loses distant
separation; reversing it preserves relative precision without a fragment depth
write. `declareSceneTarget` carries the samples, formats and attachment layout
to both the scene pass and the warm-up stand-in.

Depth convention also governs explicit depth writes and ordering. The scene's
far depth is zero on reversed WebGPU and one on the logarithmic fallback;
expanded line ribbons derive depth from their emitted clip-space vertex.
Three r185 reverses the entire draw list for reversed depth, including authored
layer order. `sceneOrder.ts` compensates the layer and stable-ID keys so a
galaxy backdrop cannot draw over the foreground.

`render/upscale.ts` wraps the raw `Upscaler` from `@pmndrs/upscaler` 0.2.0.
It runs once per render call on three's device, between the small scene pass
and the display-size optical passes. Three's native velocity uses the
unjittered projection. The sensor applies jitter and clears it in `finally`
beside its renderer-state restoration. Jitter preserves the display lens aspect,
including when reduced render dimensions round differently. Resizing reconfigures the working
textures and resets history. Explicit camera cuts advance the presentation-only
`pictureEpoch`; mode, staging and processing-domain changes also reset history.

The sensor remains the exposure owner. Photographic processing supplies its
resolved pre-exposure and residual conditioning; Enhanced supplies unity
because its separately composed sky and surfaces do not share one physical
exposure scalar. FSR's own automatic meter is disabled. Reconstruction does
not introduce another tone curve or change the opaque output guarantee.

The scene's temporal layout adds velocity and an RGBA8 reactive attachment.
Red carries rejection coverage; alpha carries material opacity for independent
coverage blending. Opaque surfaces replace the hidden background, and
translucent coverage combines as a union. Max blending retained the galaxy
background's rejection underneath solid terrain, preventing accumulation.
WebGPU rejects source-alpha blending on an R8 fragment output, so correct
occlusion spends three extra bytes per render pixel. Opaque surfaces and starfield sprites write zero;
atmosphere, clouds and rings write their alpha; water writes 0.3. Star disks,
additive overlays and instrument geometry write one, including flares, plumes,
warp effects and traces. The shared `sensorRadiance` wrapper supplies the
coverage, so an overlay does not need to name a render-target layout.

The existing optical motion/depth attachment remains separate: it preserves the
surface behind additive overlays and stores reciprocal view distance. FSR's
temporal guides carry closest-depth-dilated UV motion and linear depth, which
do not supply that same contract. Defocus and shutter motion do not reuse them;
a conversion would need separate compatibility measurements.

## Alternatives considered

- The library's stock node keys work to three's frame counter and owns its
  timing and jitter hooks. The sensor already owns each of those decisions,
  including repeated measurement renders in one task.
- Feeding logarithmic depth into the perspective reconstruction formula gives
  a monotone value with the wrong distance, corrupting disocclusion tests.
- A second scene render for an automatically generated reactive mask spends
  the scene work reconstruction is intended to reduce. An MRT attachment
  carries reactivity in the existing draw.
- Reducing the terrain selection's pixel budget with render scale changes
  geometry detail. Selection and lens angles remain display-referred.
- Bilinear reconstruction is a diagnostic baseline, not a player preference.
  Dynamic resolution and generated frames are outside this implementation.

## Consequences

The native picture keeps the existing default and device lifetime. A temporal
picture spends additional attachments, compute work and history storage; a
smaller scene does not guarantee a faster complete frame. Performance and image
acceptance use generated worlds outside Sol, at both display ratios, with a
fixed camera and photographic instant. The measurements below record that
acceptance; the [reproduction protocol](../../design/plans/the-upscaler.md)
retains the comparison procedure.

`ir.picture()` reports actual render/display dimensions, jitter phase, reset
count, initialization time and available per-pass GPU timings.
`workingTextureBytes` counts the library's raw texture allocations. It excludes
the scene and optical targets, allocation padding and driver overhead, and is
not total device VRAM. The compute initialization has its own warm-up census
unit. Debug views expose motion, depth, disocclusion, age, locks, exposure,
shading change and reactivity. The public `ir.timing('full')` switch enables
GPU timestamps when the device supports them; `off` disables query writes.
The renderer permits one readback batch in flight, resolving render and compute
queries together and skipping collection until both settle. The raw upscaler's
fresh-sample queue is drained each submission. Neither queue grows with flight
duration, and `game.render` logs the selected backend and resolved picture.

Reconstruction remains presentation state. Neither its preference, history,
cut counter nor working textures enter the canonical state hash or save.

### Measured preset frames

The held, shipped **Tau Ceti Dusk** and **The Far Shore** presets were measured
on an Apple M5 MacBook Air with 10 GPU cores and 32 GB memory, macOS 27.0,
Chrome 153.0.0.0 and Node 26.5.0, using the development server. The viewport
was 1600 × 900 CSS pixels at DPR 1 and 2. Each entry below is milliseconds
per complete presented frame: the median of five 60-frame batches after a
discarded warm-up batch, with timing instrumentation off. Detailed GPU pass
timings were sampled separately. All reconstruction settings used standard
sharpness; spatial rows retained four-sample MSAA.

| Preset        | DPR | Native MSAA | Spatial Quality | Spatial Performance | Temporal Native | Temporal Quality | Temporal Performance |
| ------------- | --: | ----------: | --------------: | ------------------: | --------------: | ---------------: | -------------------: |
| Tau Ceti Dusk |   1 |       3.683 |           3.508 |               3.285 |           4.283 |            4.303 |                3.980 |
| Tau Ceti Dusk |   2 |      11.252 |          11.022 |              10.640 |          14.180 |           11.630 |               10.578 |
| The Far Shore |   1 |       6.883 |           4.772 |               4.187 |           5.662 |            4.033 |                3.568 |
| The Far Shore |   2 |      22.558 |          18.788 |              13.163 |          23.015 |           18.722 |               15.043 |

Temporal reconstruction is not always faster. Temporal Quality costs more
than native MSAA on Tau Ceti Dusk at both display ratios, while Far Shore
benefits from the reduced scene. These are held frames on one machine, not
a frame-rate guarantee during flight. All 24 measurements preserved the
renderer object and canonical state hash. At each preset and DPR, patch
count and display-referred terrain selection also stayed constant across
picture settings.

At Tau Ceti Dusk, DPR 2, Temporal Quality's separately sampled reconstruction,
exposure, shading-change, accumulation and RCAS passes took 0.459, 0.131,
0.393, 2.687 and 0.459 ms respectively. Temporal Quality reported 78,706,817
raw working-texture bytes at DPR 1 and 314,868,017 at DPR 2. Those counts are
not total device VRAM. Its measured kernel initialization was 0.1–0.3 ms;
that timer excludes subsequent working-texture configuration and scene
warm-up.

For DPR 1 stills, RGB8 RMSE against native MSAA was 9.592 for Spatial Quality
and 8.579 for Temporal Quality on Tau Ceti Dusk; Far Shore measured 3.972 and
2.999 respectively. Each comparison used the same 1600 × 870 crop, excluding
the bottom 30 pixels of UI, with temporal captures held at jitter phase zero.
Two boots of Tau Ceti Dusk Temporal Quality differed by 0.271 RMSE. These
values describe encoded screenshot differences; they do not measure motion
stability or establish a perceptual quality threshold.

A separate Chrome lifecycle run switched through eight edge and scale
settings, including supersampling, Spatial Balanced and Ultra, and Temporal
Balanced, Ultra and Native. The renderer, canonical hash and display terrain
viewport were preserved. Instrumentation observed 58 raw FSR textures created
and 58 destroyed, with none remaining after the return to native MSAA. This
checks those setting transitions. A resize to 937 × 613 CSS pixels at DPR 2
produced a 1874 × 1226 display target and 1249 × 817 Quality input, while the
camera aspect remained 937/613.

Runtime image checks also cover **Rings Beyond the Center** (`far-ringrise`),
**Centauri Daybreak** (`centauri-daybreak`) and **Under Tau Ceti III**
(`tau-ceti-moonrise`), completing the five shipped external-system presets.
A 90-frame Far Shore camera pan measured 54.1 fps without isolated strobe
frames. That bounded observation does not prove every motion path. A gameplay
save/load at Tau Ceti Dusk's exact surface coordinates preserved its canonical hash
immediately and after one paused second; that run measured 0.4 ms kernel
initialization.

An isolated Chrome document forced adapter acquisition to return null, then
warmed and rendered a 64 × 64 scene through the production renderer factory and
sensor. It selected `WebGLBackend`, logarithmic depth and native resolution,
with reversed depth disabled and zero FSR working textures. The saved Temporal
Quality preference with standard sharpness remained intact. Only the expected
fallback warning appeared. This verifies the actual fallback path on a small
scene, not full-preset WebGL image acceptance.

The bilinear URL diagnostic also renders Tau Ceti Dusk at 1066 × 600 input
and 1600 × 900 display with 906 patches, while the stored MSAA, native,
standard-sharpness preference remains unchanged. The selected physical-GPU
suite passes 79 tests across twelve files covering the sensor, optical motion,
camera processing, reconstruction, reactive coverage and layered scene effects.
