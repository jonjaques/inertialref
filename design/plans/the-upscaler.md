# The upscaler: implementation and reproduction

The implementation and preset acceptance are complete, with one defect open
below.
[ADR-0044](../../docs/adr/0044-the-sensor-reconstructs-the-display.md) records
the architecture, complete-frame measurements, image comparisons, resource
lifetime and fallback evidence. [Rendering](../../docs/concepts/rendering.md#the-picture-record-and-reconstruction)
and [the harness](../../docs/guides/harness.md#measuring-the-picture) describe
the controls and diagnostics. This file retains the reproduction procedure.

## The velocity attachment does not mask its overlays

`sensorMrt` masks the optical `motion` attachment with
`motionOverlay.oneMinus()` and blends it `SrcAlpha`/`OneMinusSrcAlpha`, so a
draw that is light without a surface leaves the attachment to what it covers.
The temporal `velocity` attachment is fed by the same node and has neither, so
a plume, a flare, a warp streak, an entry trace or a cinematic overlay writes
its own vectors over its whole footprint and FSR reprojects, dilates and locks
neighbors from them — for pixels the overlay never covered. Reactivity does
not repair it: it suppresses history only where the overlay drew.

**Mirroring `motion` exactly does not build.** Dawn refuses the pipeline —
`Color blending srcFactor (BlendFactor::SrcAlpha) … is reading alpha but it is
missing from fragment output` — because the attachment is `RGFormat` and three
emits a two-component fragment output for it. That is the constraint that made
`reactive` RGBA8. Masking without the blend is not the other half of the fix:
it writes zero where the surface's vector belongs, which tells reconstruction
the ground is still.

Two candidates, both of which move what the frame numbers were measured with.
Widening the attachment to RGBA16F costs 4 B/px over a full-resolution target
— about 16% of the MRT's write bandwidth at the recorded temporal Quality
resolution, and a re-measurement of both presets at both display ratios.
Reading the already-masked `motion.rg` when optics are on costs nothing and
removes an attachment, but leaves the optics-off temporal path needing its own
answer.

The defect is stated by a GPU probe: a temporal sensor, a 40 × 40 surface at
z = −4 through `sensorRadiance`, a 0.5 × 0.5 overlay at z = −2 that travels
with the eye so its own screen motion is zero, and a 0.25-unit camera pan
between two frames with `nodeFrame.frameId` advanced. Read
`sensor.sceneTarget`'s `velocity` texture through
`gpu.drawGraph(vec4(texture(velocity).rg, 0, 1), { float: true })`: the bare
edge reads −0.108 of clip space and the covered center reads 0. Both should
read −0.108.

## Restore the shipped external-system presets

Use the committed presets without substituting generated summit sites:

| ID                  | Shipped label           |
| ------------------- | ----------------------- |
| `tau-ceti-dusk`     | Tau Ceti Dusk           |
| `far-shore`         | The Far Shore           |
| `far-ringrise`      | Rings Beyond the Center |
| `centauri-daybreak` | Centauri Daybreak       |
| `tau-ceti-moonrise` | Under Tau Ceti III      |

For a browser fixture, use the public URL restore path through the driver:

```bash
node scripts/drive.mjs --url http://localhost:5173/planetarium \
  --preset tau-ceti-dusk --width 1600 --height 900 --dpr 1 --wait 4000
```

In an existing planetarium session, `ir.preset(id)` restores the same record.
Record `ir.capturePicture(id, label)` so the
address, seed, generation versions, stance, held time, lens and processing
travel with the result. Wait for `ir.terrain().pending` to reach zero and record
patch count, render/display dimensions, browser, machine and build. The
quantitative matrix uses Tau Ceti Dusk and The Far Shore; all five presets
receive runtime image checks. Keep CSS size at 1600 × 900 and run DPR 1 and 2
separately, since the display-referred terrain selection changes their workloads.

## Measure the complete presented frame

Pause the world, hide chrome and instrument layers, and select standard
sharpness. At each preset and DPR, compare native MSAA, spatial Quality and
Performance with MSAA, and temporal Native, Quality and Performance. Change
the picture through the preference or settings panel while retaining the
renderer. Record its identity and `ir.world.stateHash()` before and after.

Set `ir.timing('off')`, allow the rebuilt sensor to settle, discard one
`await ir.gpu(60)` warm-up batch, then take five further 60-frame batches.
Report the median milliseconds per complete presented frame. Enable
`ir.timing('full')` afterward to collect per-pass GPU samples through
`ir.picture()`, then turn it off again. Those samples are separate from the
complete-frame measurements and require timestamp-query support.

Record `initMs` and `workingTextureBytes` at both display ratios. The first
times kernel initialization before working-texture configuration and scene
warm-up. The second counts raw upscaler textures, excluding scene and optical
targets, allocation padding and driver overhead; it is not total device VRAM.
The URL `?picture=bilinear:quality` supplies a spatial diagnostic comparison
without changing the saved preference.

## Hold and compare the picture

Capture native, Spatial Quality and Temporal Quality at the same preset and
display ratio. For temporal stills, let at least two `phaseCount` cycles present
after the cut and capture at phase zero. Hold presentation through the frame
hold helper while taking the screenshot so capture timing cannot change phase.
Compare two boots of the same temporal setting before interpreting differences
against native.

The recorded RGB8 RMSE uses a 1600 × 870 crop from DPR 1 captures, excluding the
bottom 30 pixels of UI. State the encoding and crop with any image error;
screenshot differences do not measure motion stability. Inspect native and
reconstructed terrain edges, water, atmosphere, ring layers and bright effects
across the five presets. A camera pan adds a bounded motion observation; name
its frame count and rate rather than extending it to every flight path.

## Check transitions and fallback

Exercise off, MSAA, supersampling, Spatial Balanced and Ultra, and Temporal
Balanced, Ultra and Native, then return to native MSAA. Track raw working
texture creation and destruction, renderer identity, canonical hash and the
display terrain viewport. Resize to an odd CSS size and verify rounded input
dimensions while the camera retains the display aspect. The recorded resize
uses 937 × 613 CSS pixels at DPR 2: 1874 × 1226 display and 1249 × 817 Quality.

Restore a preset, change pose at the same body and time, and restore it again.
Check a successful and failed save load, observatory release, a cinematic seek
and an actual authored shot boundary. Camera discontinuities must declare cuts;
continuous framing and repeated idle release remain quiet. For a gameplay
save/load, compare the hash immediately and after one paused second.

Force adapter acquisition to return null in an isolated Chrome document, then
warm and render through the production renderer factory and sensor. Verify
`WebGLBackend`, logarithmic depth, native resolution, zero FSR textures and the
unchanged stored temporal preference. The recorded fallback probe is a
64 × 64 scene; it does not claim full-preset WebGL image acceptance.

The optical passes retain their separate undilated surface motion and
reciprocal depth. FSR's dilated guides do not replace that contract. Dynamic
resolution, generated frames and a WebGL FSR path remain outside this work.
