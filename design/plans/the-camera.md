# The camera: bright worlds and a visible sky

Make Enhanced the default view of InertialRef: a composed image with detailed
planets, readable stars and a visible Milky Way. Automatic and Manual offer
photographic exposure of the same scene. This is the implementation plan for
[ADR-0037](../../docs/adr/0037-the-enhanced-camera.md).

Status: C1–C4 are complete. C5 has a new completion record on the branch
created from PR #73 at `9e26512`; final low-albedo image review and the repeat
gate remain pending. The [camera completion record](#camera-completion-record)
contains the current evidence. M6's physical model, local dust and linear
photometry remain independently calibrated. The
[assembled galaxy record](the-galaxy.md#assembled-image-and-motion-record)
preserves the earlier measurements and remaining source-morphology limits.

The sections below retain the original implementation and acceptance criteria.
The completion record distinguishes image inspection, runtime measurements and
features outside this sequence.

| Step | Result                                                                                        | Verification                                                                                 |
| ---- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| C1   | Three-mode policy, strict compatibility parser and preference migration.                      | Integrated policy, migration and canonical-isolation checks pass.                            |
| C2   | Physical sky storage, explicit Enhanced visibility processing and one final output transform. | Matched foreground/sky review passes for Earth and Luna; final Bennu review remains pending. |
| C3   | Shared photographic processing, physical metering and explicit adaptation.                    | Manual isolation, held/clamped adaptation, continuous rebases and real WebGL fallback pass.  |
| C4   | Camera Mode controls, version 2 pictures/URLs, scoped instruments and ordinary-view cache.    | Sixteen native SDR fixtures restore exact pose, time, lens and processing.                   |
| C5   | Image review, transition recordings, display lifecycle and complete-frame measurements.       | Final low-albedo fixture and repeat gate remain pending; measured limits are recorded below. |

Generate matched Earth, Earth-and-band, Luna, night-side and Bennu review
links against the Cloudflare version URL:

```sh
node scripts/camera/preview.mjs --origin "$PREVIEW_URL"
node scripts/camera/preview.mjs --json > /tmp/camera-review.json
```

Each mode triplet shares a complete pose, photographic time and lens. A
separate long Manual view changes shutter only. The generated version 2
library can also be imported into Presets. Start review in standard SDR;
output capabilities remain the reviewer's choice.

## Camera completion record

The implementation follows PR #73 at `9e26512`. The `bface6f` checkpoint has
sixteen native SDR fixtures at 1920×1080 / DPR 1, reviewed through the complete
WebGPU sensor chain on Apple M5 and Chrome 152. Agent inspection accepts the
Earth, Earth-and-band, Luna and night-side triplets. Enhanced retains the
subject and sky; Automatic and short Manual suppress faint light beside a
sunlit subject. The long Manual exposure reveals the band and clips Earth.
The surface correction at `4249c28` normalizes the tint of mapped bodies,
keeps terrain palettes and orbital bakes in physical reflectance, and applies
one Enhanced visibility gain across sphere and ground. The 3% terrain/water
legibility floor belongs only to Enhanced; photographic surfaces retain the
actual scattered atmospheric light. Final Bennu and terrain/sphere image
review remains pending.

Earth's city-light mask excludes the blue background of its colorized night
map. The night-side Automatic view now adapts to the source light without
emitting the map's ocean/land background. Enhanced uses an explicit diffuse
response that preserves dark lanes. These processing and source corrections
leave `galaxy@5`, `galaxy-field@5` and `galaxy-tsl@8` unchanged. Photographic
hulls receive physical illumination; Enhanced fill and a script's declared
staging have explicit owners in
[ADR-0037](../../docs/adr/0037-the-enhanced-camera.md).

Automatic holds its exposure through a floating-origin rebase. A live
six-second run records 361 frames and 360 origin changes while photographic
time advances at 1000× with canonical time paused. Every frame remains
calibrated; the maximum per-frame EV change is 0.0009867663. The GPU continuity
checks also verify that motion blur bypasses the rebase frame and resumes on
the following continuous frame. A camera cut still invalidates the relevant
history.

The 360-frame mode-switch recording and 240-frame pause/resume recording pass
agent visual inspection and decoded-pixel checks. Mode boundaries occur at
the requested changes, Automatic adapts smoothly, Manual holds its exposure,
and the final Enhanced frame reproduces its initial pixels. Paused ranges
42–102 and 162–239 contain identical frames; motion resumes at frame 103
without an exposure jump. The initially suspected missing crescent is absent
from the recorded-byte evidence and is not a confirmed product flicker.

Real WebGL renders Enhanced in sRGB and retains a requested
Automatic preference while using lens-controlled Manual exposure. Its visible
explanation is "Automatic needs WebGPU. This view uses the manual lens
exposure." The measured fallback EV is 14.6147. Display lifecycle checks switch
Standard sRGB to negotiated Extended display-P3 and back, verify renderer
retirement, resize to 1440×900 CSS / DPR 2, and reload the finished sky archive.
The resulting 2880×1800 scene retains the bounded 960×600 physical history.

At `bface6f`, the full `pnpm check` passes 2,031 regular tests and eight slow
tests, including graph, formatting, lint, typechecks, documentation and builds.
The GPU suite passes 109 tests in 37 files, and `pnpm sim --self-test` passes
12/12. The verification log preserves an initial randomized ellipse-comparison
failure, reproduced against unchanged PR #73 physics at seed `972706803`.
Its state-derived period differs from the nominal elements by 4.833 μs; after
nearly 50 revolutions, the relative velocity discrepancy exceeds that test's
empirical bound by 3.674 parts per million. Physics and tolerances are unchanged.
At `4249c28`, the surface correction passes 51 focused CPU tests and 27 GPU
tests in three files, plus typechecks, lint and formatting. The complete
repeat gate after that correction remains pending.

### Return-frame costs

The matched 36-second return plus held tail uses Enhanced, 18.836226925409882 mm,
f/2.8, 1/60 s and ISO 100. Both runs preserve their canonical hash, mode and
lens; their initial canonical hashes differ, so the comparison matches lens
and route rather than an identical world state.

| Measurement                                  | PR #73 baseline           | Camera `bface6f`         |
| -------------------------------------------- | ------------------------- | ------------------------ |
| Survey preparation, mean / p95 / maximum     | 0.532 / 2.799 / 7.900 ms  | 0.022 / 0.101 / 0.600 ms |
| Starfield callback, mean / p95 / maximum     | 0.285 / 1.100 / 12.201 ms | 0.197 / 0.399 / 9.799 ms |
| Host reply application, mean / p95 / maximum | 1.381 / 6.200 / 9.000 ms  | 1.512 / 6.301 / 9.201 ms |
| Engine frame intervals above 25 ms           | 12 of 2,400               | 7 of 2,399               |
| Engine frame interval p95 / maximum          | 18.399 / 42.701 ms        | 18.600 / 62.101 ms       |
| Independent rAF interval p95 / maximum       | 18.2 / 34.7 ms            | 18.6 / 51.8 ms           |
| Independent rAF intervals above 25 ms        | 1 of 2,398                | 1 of 2,397               |

The completed field keeps its exact resolved envelope while another survey
runs. Sampled extinction source writes fall from 162,122 to 63,046; mapping
writes and temporal resets increase as complete envelopes reach their
consumers. Both sample windows add 1,638 cube tiles, one archive write and no
archive hits or failures. The sky worker's unchanged source values occupy
about 38% fewer serialized bytes by omitting unused system properties.

These traces establish lower synchronous survey and starfield CPU cost.
They do not establish a lower worst-frame interval or improved frame rate.
The independent rAF timestamps and intervals between engine callbacks have
different boundaries; neither is a compositor recording or drained GPU cost.
The earlier 1/3200 s diagnostic is not part of this matched comparison.
Morphology remains an approximate physical model, and sustained 60 fps is not
a universal claim. The 960-pixel history cap and progressive cubes remain the
bounded quality choices for the visible sky.

The current local evidence lives in `.scratch/camera-completion/`: `final/`
contains native plates and exact picture records, `transitions/` contains
display and motion records, `live-rebases.json` records exposure continuity,
and `perf/return-analysis.md` separates CPU spans, rAF intervals, allocations
and transfer measurements. Final low-albedo plates and complete sensor costs
are still being collected before this record is closed.

## The picture we are building

Earth's clouds, oceans and terminator remain legible while the surrounding sky
shows stars and the broad Milky Way band. Luna keeps sunlit relief. A dusty
galactic lane separates bright star clouds instead of becoming a gray veil.
The image has a clear foreground subject and enough contrast to read depth.
Revealing faint light does not mean raising every black pixel.

Enhanced is an idealized HDR composite. It should be beautiful without asking
the player to understand exposure first. It operates on sRGB SDR as well as
supported P3 and extended-range outputs. The default is judged on an ordinary
display first; additional headroom gives highlights more room.

| Mode              | Player promise                                             | Exposure behavior                                                                            |
| ----------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Enhanced, default | Bright worlds and faint space appear together.             | Authored dynamic-range compression with declared visibility processing.                      |
| Automatic         | The view behaves like an automatically exposed photograph. | One metered exposure; bright subjects suppress faint stars, dark views allow them to emerge. |
| Manual            | The player chooses the photograph.                         | Aperture, shutter and ISO determine exposure; the meter cannot add gain.                     |

Automatic and Manual use the same photographic source light, optics and
response. They differ in exposure control. A photographic image may clip
highlights or lose stars, but it still uses a display response; Manual does not
mean raw RGB channel clipping. Enhanced does not promise literal accumulation
over its displayed shutter duration. The existing sensor is an instantaneous
simulation of exposure, as ADR-0032 records.

Fewer bright sources in a night-side view can permit a longer automatic
exposure. This depends on the framed light, including the atmosphere and glare,
rather than a day/night flag or a universal claim about light pollution.

## Implemented separation

The camera keeps the lens, one sensor chain, histogram metering, optical
passes and negotiated output, plus M6's local dust and calibrated V radiance.
`SensorSettings` declares `mode`, photographic `look`, compensation, adaptation
rate, comfort range, white balance and the existing display peak. A look does
not select exposure control or change source light. Composite/Direct and their
curve names exist only at the strict compatibility boundary and in explicitly
identified historical diagnostics. [ADR-0037](../../docs/adr/0037-the-enhanced-camera.md)
records the processing choice; [ADR-0033](../../docs/adr/0033-presets-hold-a-photographic-instant.md)
records portable views.

The following constraints remain the acceptance checklist for that separation.

| Keep                                                                      | Replace or cut                                                               |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Lens arithmetic and camera/lens precedence.                               | A tone-curve name deciding exposure or physical lighting.                    |
| Photometric source data, dust transport and calibration checks.           | Tuning galaxy emission to overcome the default tone curve.                   |
| One scene/sensor/output owner, warm-up and resource disposal.             | Treating a global exposure increase as the solution for Enhanced.            |
| Physical photographic exposure, glare, focus, motion and output encoding. | The requirement to preserve Natural's ACES image and Sol-anchored star ramp. |
| Conservative visibility optimizations with image evidence.                | Natural's daylight omission as the ordinary gameplay performance solution.   |
| Authored cinematic exposure and portable photographic time.               | Implicit fixed exposure caused merely by entering a galaxy viewpoint.        |

## Work ownership and order

This plan owns camera policy, sensor presentation, controls, compatibility and
the image gate. [The galaxy plan](the-galaxy.md) owns radiance, dust,
population selection, cached-sky rendering and travel. [Performance](perf.md)
owns measurement evidence. [The sensor index](the-sensor.md) points here;
there is one sequence for camera work.

| Step | Result                                                                  | Dependency                                                                  |
| ---- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| C1   | Camera policy and compatibility are explicit and testable.              | `codex/galaxy` at the implementation base, including M6.                    |
| C2   | Enhanced preserves a bright foreground and faint sky in one image.      | C1; use the baseline M6 field and preserve its calibration checks.          |
| C3   | Automatic and Manual share a photographic model with reliable metering. | C1 and C2's separation of source light from processing.                     |
| C4   | Controls, presets and authored scenes use the three modes.              | C2 and C3; M7's ordinary-view cache before changing the production default. |
| C5   | Images, transitions and full-frame cost meet the new direction.         | C4, M6 and M7. Repeat galaxy acceptance after M8–M10.                       |

M6 supplies source records, local clouds and photometric tests under linear
radiance or a fixed declared photographic exposure. Its physical work is
implemented independently of Enhanced. M7 establishes cache ownership and
bake/live identity against that versioned field, with camera C2 defining how
the sensor consumes the cached radiance.
M8–M10 remain galaxy work. M11 needs C5 as well as those milestones before
claiming the full journey is accepted. C5's review of the current star population
does not claim that M10's resolved-star dust is implemented.

Implementation steps are recorded as coherent local commits with focused
evidence. This completion branch follows the explicit PR #73 base recorded
above; the dependency chain remains visible in its history.
This plan does not authorize merging or rebasing another agent's branch.

### Ordinary-view cache and support contract

The ordinary renderer retains physical V-anchored sky radiance, with each
half-float unit representing 1,000 nW m⁻² sr⁻¹. It publishes complete 32-, 128- and 512-pixel-face
cubes in succession. The tiers contain 6, 96 and 1,536 tiles of 32×32 pixels;
two tiles are submitted per frame. Three slots retain completed locations and
an incomplete replacement.
Partial faces never publish, and canceled generations cannot publish into a
reassigned slot. These are bounded work and allocation counts, not measured
full-frame performance.

A cache is eligible within 0.15 pc of its baked observer position. Beyond that
ceiling the renderer replaces it, using a bounded live target until an eligible
cube is ready. Rotation and lens changes sample the same physical directions.
The physical GPU contract compares cache and live rays within 1% at the tested
inside/outside positions, including a 0.14 pc offset within the reuse ceiling.
That sampled-radiance bound does not establish coarse-tier image quality,
dust-lane contrast or transition continuity; those remain C5 image gates.

Enhanced compresses the retained sky's luminance before conversion to the
scene's half-float target, preserving zero and hue while keeping foreground
depth and the common optical chain. Its declared visibility gains do not alter
the physical field. Automatic and Manual share photographic inputs and a
neutral response; imported Gentle/Crisp shoulders remain explicit styling.

Enhanced supports ordinary sRGB SDR. P3 gamut and negotiated extended output
remain independent display capabilities. WebGPU supports physical Automatic
metering. WebGL visibly marks Automatic unavailable and identifies the
lens-controlled Manual fallback without rewriting the selected preference.
Manual and pinned staging cannot consume automatic gain. Backend support does
not close C5's image or performance gates.

## C1. Separate camera policy from style and output

Define a pure camera policy in `packages/rendering` with three modes and an
explicit response choice. Keep output gamut and headroom in the output owner.
The policy resolves effective exposure, processing and any staging override
once for the sensor and its consumers. Reuse the existing engine, presentation
bridge and preference registry. Do not add a camera producer or React-owned
adaptation state.

Write a migration for `RENDER_SENSOR` before changing the default:

| Stored value                          | Intended migration                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Composite + Natural, or no preference | Enhanced.                                                                                                                |
| Composite + Neutral, Gentle or Crisp  | Automatic; preserve white balance and exposure comfort settings. Curve styling maps explicitly to the photographic look. |
| Direct                                | Manual; retain aperture, shutter and ISO. The new photographic response is an intentional appearance change.             |

Do not silently reset malformed imports or let a curve toggle select a new
mode. Test the parser and preference migration with all baseline combinations,
including a held meter, tight clamps and unknown values. A migrated preference
is written through `state/preferences.ts`. Camera settings never alter the
world's state hash.

Audit `ExposureMeter`, `GameEngine.galaxyPose`, `GameEngine`'s lighting policy,
`scene/Sensor.tsx`, star sprites, the tone map and `SensorSection`. The audit's
deliverable is removal or explicit compatibility ownership of every
`naturalResponse()` branch. C1 establishes the contract without presenting an
unfinished Enhanced renderer as the new production default.

## C2. Compose Enhanced from retained radiance

Build a bounded prototype through the real sensor chain at fixed poses. Start
with a hue-conscious compression curve and test its limits. If one radiance
target or one curve loses the faint sky, retain physical sky radiance in its
owned target until an explicit sensor composition stage can use it. Separate
exposure domains or local tone mapping are candidates to measure, not a
prescribed second renderer. Keep one final output transform.

The precision gate comes first. M4's two exposures are 26.5165 stops apart.
Demonstrate that pre-exposure and half-float storage retain both foreground
detail and a nonzero diffuse signal at those operating points. A later tone
curve cannot recover a signal already rounded to zero. Record each stored
quantity's units and scale; expose physical input and presentation gain
separately. Keep conservation and photometry tests before composite processing.

The composition must retain full-resolution foreground depth and silhouette
coverage, atmospheric transmission, dust attenuation, and the resolved/diffuse
light split. Test a bright limb against faint structure for halos, leaks and
double-counted glare. Decide and document how Enhanced's lifted sky feeds the
PSF and noise without contaminating the physical meter. Automatic and Manual
continue to receive the unmodified photographic inputs.

Remove Natural-image equality as the default acceptance gate. Keep source
calibration tests and any retained diagnostic response tests. The Sun's
analytic glow, star stop-down and dark-body lift need explicit Enhanced
ownership or removal after matched images justify it. They must not leak into
photographic modes or silently survive under a renamed curve.

C2 ends with matched Earth, Luna, dark-asteroid and galactic plates, GPU
precision/occlusion tests, measured added cost, and a written processing choice.
Use modest buffers and bounded submissions during development. The live march
is acceptable for this prototype; it is insufficient for a production default.

## C3. Make the photographic pair trustworthy

Automatic meters scene radiance before Enhanced processing. Exclude labels,
orbit traces, landing marks and other instrument overlays. Test a sparse sky,
a small bright disk, empty pixels and an all-dark frame. The implementation
excludes empty bin zero and weights log luminance by light over the
40th–99.9th percentile interval. Its sparse-disk and hot-pixel tests retain a
subject while trimming isolated outliers; image review must still establish
that a bright Luna amid empty sky exposes correctly.

Keep adaptation and comfort clamps explicit. Tightening a range applies even
when adaptation is held. A mode switch, camera cut or photographic-time scrub
cannot consume a stale meter result. Define reset/hold behavior against the
existing simulation and presentation clocks; paused Manual or pinned frames
repeat, and asynchronous readback cannot change them.

Manual ignores automatic gain. Doubling shutter or ISO gives one stop before
the response; multiplying f-number by sqrt(2) removes one stop. Automatic
reports the effective EV and compensation over the lens settings without
secretly writing aperture, shutter or ISO. Holding Automatic holds its current
exposure; it does not change the selected mode to Manual.

The WebGL fallback marks Automatic unavailable with a visible explanation
and identifies its lens-controlled Manual fallback. A fixed calibration must
not be labeled Automatic. Verify Enhanced's supported SDR path at a measured
quality level; backend support alone is not image acceptance.

## C4. Put the modes in the player's controls and saved views

Replace the Response/Rendering combination in the Canopy section with one
three-choice Camera Mode control. Enhanced describes its HDR composite;
Automatic offers exposure compensation and adaptation; Manual exposes shutter,
aperture and ISO through the existing lens controls. Keep white balance and
optics available where meaningful. Hide controls that do nothing in the active
mode. Tone-curve variants are outside the initial interface scope.

Keep HDR Output and peak luminance in display settings. The readout describes
the active encoding and fallback without claiming that P3 implies HDR. A gamut
or output change preserves camera mode, exposure control and field calibration.

Extend the preset envelope and dotted-query format in
`packages/devtools` with versioned camera-processing fields. Define a documented
default for version 1 pictures, which store a lens but no sensor mode. Preserve
their pose, time and lens, map absent processing to Enhanced, and state that
historical image appearance is not guaranteed. Capture the selected mode and
relevant settings in new pictures; do not serialize adaptation history or
display hardware. Test old JSON, old URLs, new round trips and invalid fields.
ADR-0033 remains the owner of photographic time and canonical-state isolation.

Audit bundled presets, galaxy instruments, homepage framing and cinematic
effects. Ordinary galaxy travel keeps the player's mode. Fixed photometric
instruments explicitly request photographic exposure. Authored scripts retain
their declared staging and release it on exit; they cannot rewrite a global
preference. Check PR #69's preview, descent and landing marks in every mode.

Change the production default only with M7 available for an ordinary Enhanced
view. Recapture affected reference plates and preset thumbnails with declared
settings; do not rename legacy labels while silently retaining legacy lighting.

## C5. Acceptance through the actual image

The [camera completion record](#camera-completion-record) contains the current
C5 image, transition, backend and performance evidence. The
[assembled galaxy evidence](the-galaxy.md#assembled-image-and-motion-record)
retains the earlier source and journey measurements. The checklist below is
the original acceptance contract; it remains useful for a changed renderer,
field or camera policy. Source-morphology approximations and measured frame
limits remain explicit in both records.

Use identical pose, time, lens geometry and scene data across each mode triplet.
Record mode, aperture, shutter, ISO, effective exposure or composite gains,
field version, renderer revision, backend, buffer size and output encoding.
Pair image masks with numerical diagnostics; document thresholds with the first
reviewed reference set rather than inventing brightness tolerances here.

| Scene                                     | Enhanced                                                                             | Automatic                                                                        | Manual                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Sunlit Earth plus Milky Way               | Clouds, oceans and limb retain detail; stars and band are visible in the same frame. | Exposure settles on the lit subject; faint stars and band fall below visibility. | A surface exposure loses the band; a long exposure reveals it and clips Earth. |
| Sunlit Luna plus stars                    | Relief and star hierarchy read together.                                             | Faint stars disappear when the disk is the metered subject.                      | Exposure changes give the expected tradeoff without automatic compensation.    |
| Night-side view with little bright light  | Dark space gains structure without a uniform gray lift.                              | Stars emerge as exposure adapts within its limits.                               | The held exposure stays fixed until adjusted.                                  |
| Bennu or another low-albedo body          | The subject is readable and retains its dark character.                              | Response follows metering; no hidden albedo correction.                          | Relative brightness at matched light and settings remains meaningful.          |
| Earth limb, dust lane and foreground star | No sky painted over the disk, edge halo, dust reversal or flat star ranking.         | Physical extinction and scene glare remain.                                      | Same physical attenuation at a stated fixed exposure.                          |
| Local sky to outside disk and return      | Continuous picture through cache transitions, with useful foreground detail.         | No forced instrument pin; adaptation follows the view.                           | No automatic exposure changes along the trip.                                  |

Capture transitions, mode switches and PR #69's descent with `--cast`. Check
exposure pumping, brightness pops, noise stability, occlusion and pause/resume.
A still cannot close those gates. The plate review also checks the image's
composition; a nonzero sky pixel alone is not acceptance.

Test sRGB SDR first, then negotiated P3 SDR where supported and extended output
at the supported authored headroom. Exercise resize, output fallback and
renderer retirement. Extra output headroom must not be required to find stars
or preserve planetary detail.

Profile the complete moving and settled frame with Enhanced's visible sky at
1920×1080 DPR 1 and the recorded 1440×900 CSS / DPR 2 operating point. Include
Earth orbit, free look, descent, cold cache, warm cache and return from outside
the disk. Count actual submissions and report memory and cancellation behavior.
M7's 0.05 ms cube-sampling target remains an isolated-pass budget. M11's
original universal 2 ms live target is superseded by the
[declared field@5 operating points](the-galaxy.md#completion-measurements-7-september-2026)
and their bounded half-resolution, stride-8 history with a 960-pixel long-edge
cap. Forty moving volume draws measure 2.225 / 4.501 / 6.296 ms for face-on,
edge-on and inside views at 1080p, and 2.460 / 5.525 / 7.399 ms at a
2880×1800 drawing buffer. These established physical-volume costs exclude
the native scene, resolved stars and sensor; this branch does not change that
field or live-rendering policy. C5 measures the complete frame against the
declared operating points and records any additional bounded quality choice.
Hiding the default sky does not close this gate.

Run the focused CPU/GPU suites, `pnpm check` and `pnpm sim --self-test` on the
implementation tip. Attach reviewed plates, transition captures and a complete
cost table. Update implementation ADRs and capability claims only for behavior
the checks and images establish.

## Scope that waits

The following sensor work is removed from the galaxy integration checklist and
does not gate C1–C5. Each needs its own implementation and evidence when chosen.

| Follow-up                                  | Dependency and acceptance                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-glass iris sampling                    | Use the existing glass records; verify blur shape and the half-pixel defocus gate.                                                                                         |
| FFT diffraction                            | Iris sampling, then kernel energy/orientation tests and measured rebuild/convolution cost. Retain the proposed 1 ms rebuild and 1.5 ms/frame at 1080p as unproven budgets. |
| Spectral attachment and narrowband filters | Real Hα/OIII/SII emission from the galaxy model, declared units and channel mapping, broadband equivalence when disabled.                                                  |
| Photo export and tether workflow           | Stable C4 camera records; verify dimensions, color encoding, address/time metadata and held-frame repeatability.                                                           |
| Display-headroom discovery                 | A supported measurable browser signal; preserve authored peak limits and fallback meanwhile.                                                                               |
| Additional response styles                 | Evidence that a style adds a useful choice without changing mode, source lighting or metering.                                                                             |

[The upscaler](the-upscaler.md) remains a separate performance proposal. Whole-
scene temporal reconstruction, reversed-Z conversion and new reactive buffers
are not prerequisites for Enhanced or the galaxy's own cached sky.
