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

`render/upscale.ts` wraps the raw `Upscaler` from `@pmndrs/upscaler` 0.2.0.
It runs once per render call on three's device, between the small scene pass
and the display-size optical passes. Three's native velocity uses the
unjittered projection. The sensor applies jitter and clears it in `finally`
beside its renderer-state restoration. Resizing reconfigures the working
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
fixed camera and photographic instant. The [remaining acceptance
plan](../../design/plans/the-upscaler.md) names the measurements still due.

`ir.picture()` reports actual render/display dimensions, jitter phase, reset
count, initialization time and available per-pass GPU timings.
`workingTextureBytes` counts the library's raw texture allocations. It excludes
the scene and optical targets, allocation padding and driver overhead, and is
not total device VRAM. The compute initialization has its own warm-up census
unit. Debug views expose motion, depth, disocclusion, age, locks, exposure,
shading change and reactivity.

Reconstruction remains presentation state. Neither its preference, history,
cut counter nor working textures enter the canonical state hash or save.
