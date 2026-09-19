# The upscaler: remaining acceptance

The picture record, reversed WebGPU depth, spatial and temporal reconstruction,
URL overrides, cut declarations and diagnostics are implemented.
[ADR-0044](../../docs/adr/0044-the-sensor-reconstructs-the-display.md) records
the architecture; [rendering](../../docs/concepts/rendering.md#the-picture-record-and-reconstruction)
and [the harness](../../docs/guides/harness.md#measuring-the-picture) describe
the implemented behavior. This plan holds the measurements and image acceptance
that are still open. Library performance figures are not application results.

## Compare the complete frame outside Sol

Use generated-world summits on Proxima Centauri b and Gliese 1061 d, plus an
orbit and a moving hull over generated terrain. Record each exact body address,
seed, stance, lens, photographic instant and surface record. Hold CSS size at
1600×900 and run DPR 1 and 2 separately; display-referred terrain selection makes
them different workloads.

For each point, compare native MSAA, spatial Quality and Performance, temporal
Quality and Performance, temporal native, and the bilinear diagnostic. Record
actual render/display dimensions, converged patch counts and the median of
repeated `ir.gpu()` samples after an excluded warm-up. Detailed timing supplies
per-pass reconstruction readings; report them separately from the complete
chain. Name the machine, browser, build and concurrent load. A faster compute
pass does not establish a faster presented frame.

Measure cold initialization through `ir.picture().initMs` and record
`workingTextureBytes` at both display ratios. That count covers raw upscaler
textures only, not total device VRAM. A resize and repeated picture changes
must release the previous working textures.

## Inspect the reconstructed image and motion

Capture native and spatial plates at the same stance, inspect edges and fine
ground detail, and report image error beside the pictures. For temporal plates,
allow at least `phaseCount` presented frames after every cut and compare at a
recorded phase. Two boots of the same build define the plate's variation before
any native-versus-temporal error is judged.

Inspect a moving hull silhouette, atmosphere, water, rings, flares and plumes on
generated worlds. The `motion`, `disocclusion`, `age` and `reactivity` views must
agree with the moving surface and reveal no retained trail through a cut.
Exercise orbit-to-surface movement, a forced origin rebase, a resize, a preset,
a load and a shot boundary. Include held photographic time with presentation
frames still running, and a horizon at the near plane.

Depth acceptance includes near-ground layering and water over its bed outside
Sol. Secondary small-body fixtures can probe close geometry and extreme ranges.
The fallback must retain logarithmic depth and native rendering on WebGL while
keeping the user's stored WebGPU preference.

## Verify controls and lifecycle

Confirm that off, MSAA, supersampling and temporal changes retain the renderer
and rebuild the sensor. Compare native edge modes to their corresponding
baseline pictures. Check the pixel detail line while resizing and switching
display ratio, and verify that URL overrides remain absent from saved settings.
The complete temporal target layout must warm before its first visible frame.

The existing optical passes keep their separate motion/depth contract. FSR's
dilated temporal guides do not replace the undilated surface motion and
reciprocal depth that exclude additive overlays. Guide reuse requires a new
compatibility measurement and is not required to complete this implementation.

## Scope

Dynamic resolution, generated frames and a WebGL FSR path are outside this
work. Terrain detail stays display-referred; a reduced render scale does not
silently choose fewer patches. Exposure, glare and camera response remain
[ADR-0037](../../docs/adr/0037-the-enhanced-camera.md)'s.
