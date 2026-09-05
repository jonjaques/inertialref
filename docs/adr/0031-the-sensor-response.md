# ADR-0031: The sensor reads the lens, and Natural preserves the production response

Status: accepted · 4 Sep 2026

## Context

[The sensor plan](../../design/plans/the-sensor.md) builds on
[ADR-0029](0029-the-sensor-spine.md): the scene already belongs to one chain,
but exposure, focus and shutter have no effect on its output. A physically
exposed sky and a luminance-only tone curve also change the production image:
stars disappear beside a lit hull, and saturated highlights retain more color.
The visual constraint is to preserve that familiar default while making the
photographic responses deliberate camera choices.

## Decision

**One sensor chain reads the lens; Natural retains the production lighting calibration, ACES fit and
integrated sky, while the other Composite presets and Direct collect physical
stellar flux.**

- Surfaces use a solar-calibrated luminance scale of 30,000 cd/m² for an
  albedo-one surface. Stellar luminance and incident irradiance derive from
  luminosity, radius and distance. These are visible-light estimates from
  bolometric catalog values, not spectral photometry. Scene materials apply
  pre-exposure before the half-float target; offscreen reflectance bakes do not.
- The WebGPU meter samples every fourth pixel in each axis into 64 log bins.
  A bounded asynchronous readback feeds the CPU percentile reducer. It excludes
  empty sky and meters the 40th–95th percentile of the remaining samples.
  Adaptation uses simulated time, with 0.4 s toward bright and 3.5 s toward dark.
  Rate, bright/dark range and display peak are preferences. A tightened range
  binds even with adaptation held. WebGL uses a fixed Composite calibration.
- Direct uses the lens's EV. The photographic Composite presets add automatic
  gain without writing ISO. Natural holds the surface calibration, bounded by
  the comfort range, and retains the production dark-body lift and star stop-down.
  A script pins an EV offset from the surface calibration and explicitly opts
  into calibrated lighting where its reference staging needs it. The readout
  distinguishes those fixed frames from metered ones.
- Natural uses the production ACES matrices and fit. Its sky retains the
  seventeen-magnitude visibility ramp, compensated for the sensor's total
  exposure so a scripted exposure offset does not erase the integrated stars. This is
  declared Composite processing, not a physical claim about the detector.
  Neutral uses the fit on luminance with uniform RGB scaling; Gentle and Crisp
  use that response with different HDR shoulders. Direct clips channels.
- The pass carries two half-float attachments: radiance and velocity.xy with
  reciprocal view-space depth. Reciprocal depth represents nearby meters
  without overflowing on astronomical distances. Lens-derived defocus gathers
  near/far layers at half resolution and bypasses all draws for a sharp frame.
  Motion uses tile-max, neighbor-max and a depth-weighted gather, bounded at
  twenty pixels. The planetarium and documentation disable motion through
  their presentation stances.
- Glare redistributes 1.5% of the image through six downsample/upsample octaves,
  without a threshold. Natural also retains the calibrated analytic Sun glow
  and horizontal streak: the faint solar point beside Titan cannot fund that
  broad production halo from its sampled image alone. The other responses use
  the sensor PSF alone for the core. Analytic ghosts and the scripted corona remain. The
  detector adds tick-indexed shot/read noise, lens-derived lateral color and
  Direct vignetting. White balance defaults to the unchanged D65 calibration.
- The final output is opaque, with triangular dither on SDR. An extended
  WebGPU canvas uses P3 only when its configuration and the encoder can agree.
  Missing configuration reporting or a failed P3 configure retains sRGB.
  `CanvasGamut` owns the negotiated color space, reapplies the agreement after
  every canvas resize, and commits that live value after R3F configures output.
  Renderer diagnostics read the same value. Disposal removes the resize listener.
  Display headroom remains an authored maximum of two, reduced by the peak cap.
- Every optical pass and the output quad register through the warm-up. Internal
  quads read plain textures; one dependency graph schedules the scene and each
  optical pass once per render call. The chain restores renderer state on a
  throw. `engine.exposure` and `engine.sensorDiagnostics` expose the live result.
  Each optical pass privately pairs its materials with their render targets;
  warming, drawing, resizing and disposal use those same records. The sensor
  calls `warm(renderer)` and reads `outputTexture`, without inspecting the
  pass's internal stages. Each pass retires its resources once.

## Alternatives considered

**Make the hue-preserving curve and physical star field the default.** The
curve passes its color measurement, but a pinned surface exposure removes the
familiar star field. Automatic gain also takes a framed Bennu from the
calibrated EV 14.61 to EV 8.11, making a dark asteroid nearly white. Natural
retains the calibrated lighting and exposure as well as the curve; metered
exposure remains an explicit photographic choice.

**Subtract the direct core to measure a small glare skirt after half-float
resolve.** Rejected as a kernel measurement: the 400-unit point resolves to
399.787, a 0.053% frame error, but subtracting its 394-unit core attributes a
3.55% error to the six-unit skirt. The test measures the isolated kernel within
2% and the combined frame within 0.1% separately.

**Switch to the half-resolution layer as soon as a blur exceeds half a pixel.**
Rejected: a 0.5625-pixel circle replaced an alternating 0/1 signal with 0.5,
softening the reference hull. Coverage now fades through the subpixel interval.
A large circle elsewhere in frame also cannot darken a nearer layer by reducing
its gather coverage: normalized color and edge opacity have separate jobs.

## Consequences

The default is visually close to production, not pixel-identical. Glare,
noise and P3 still change the image. At headroom one, the Natural tone
curve itself agrees with stock ACES to 1e-6 on the GPU. Neutral's measured hue
drift for 3,000 K and 10,000 K sources across radiances 0.1–100 is below 0.00002°.
The two-meter defocus calibration measures 36.318 px against the thin-lens
35.834 px, within the half-pixel gate. Paused pinned frames repeat exactly in
the GPU test; automatic adaptation still receives asynchronous meter readings.

The three Enterprise portraits exercise held composition and close focus;
each camera clears the shipped hull by the existing fifteen-meter test margin.
Their thumbnails are vendored captures. Clearing chrome also hides the debug
cinematic transport, so those captures contain only the picture.

Star sprites supply their instance position to both sides of the velocity
calculation. The unit quad only describes the pixel footprint; using it as the
previous position invents motion between a star and the render origin. The
homepage's automatic phase sweep is sampled inside the observatory at render
time, so pausing the simulation holds the camera too. Its keyboard context
leaves game controls to the browser while keeping Settings and the keys sheet.

An offscreen WebGL 2 draw of a gray calibration plane through the full chain
at four samples reads opaque [163, 165, 164, 255] with no GL error; that is a
one-off check during verification, not a test in the tree. P3 is confirmed in
Chrome 152. three configures the canvas lazily and forgets the configuration
on every resize, so the canvas and encoder renegotiate from the canvas target's
`resize` event. A failed P3 reconfiguration switches both to the restored sRGB
declaration; a later successful resize can recover P3. Without that agreement,
the first `setSize` after the renderer is built can return the canvas to sRGB
while the encoder keeps writing P3 primaries.

The FFT diffraction tier and spectral emission attachment are not implemented.
Neither are narrowband filters, a photo export/tether workflow, a spectral
calibration, or automatic display-headroom discovery. Iris samples currently
use the flight glass's blade pattern. The meter reduces on the CPU rather than
in a second GPU kernel. These are open parts of the plan, not capabilities the
response control claims to provide.
