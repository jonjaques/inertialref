# The camera: bright worlds and a visible sky

Make Enhanced the default view of InertialRef: a composed image with detailed
planets, readable stars and a visible Milky Way. Automatic and Manual offer
photographic exposure of the same scene. This is the implementation plan for
[ADR-0037](../../docs/adr/0037-the-enhanced-camera.md).

Status: C1–C4 implementation is complete on the camera branch created from
`codex/galaxy` at `b50a1f22df424e24a7165fa811374694221c6c98`. M6's physical
model, local dust and linear photometry remain independently calibrated.
C5 CPU/GPU verification passes, with matched SDR captures, real WebGL fallback
and negotiated extended P3 checked. Manual visual
acceptance is deferred to the user's feedback on the Cloudflare PR preview.
The galaxy completion branch implements M7–M11 and repeats sixteen exact
public-picture captures plus outward/return recordings. The
[assembled galaxy record](the-galaxy.md#assembled-image-and-motion-record)
separates passing checks from remaining morphology, night-emission and
return-frame limits; those limits are not called visual acceptance.

The sections below retain the implementation and acceptance requirements.
Implemented processing is not a claim that every matched image, transition or
full-frame cost has passed review.

| Step | Implementation status                                                                                     | Acceptance still open                                                             |
| ---- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| C1   | Three-mode policy, strict compatibility parser and preference migration; integrated checks pass.          | No separate implementation gate remains.                                          |
| C2   | Physical sky storage, explicit Enhanced visibility processing and one final output transform.             | Matched scene plates, limb/occlusion review and measured added cost through C5.   |
| C3   | Shared photographic processing, physical metering, held/clamped adaptation and verified backend fallback. | Exposure-transition review through C5.                                            |
| C4   | Camera Mode controls, version 2 pictures/URLs, scoped instruments, ordinary-view cache and 13 SDR plates. | User feedback through C5.                                                         |
| C5   | CPU/GPU suites pass; matched images, fallback, resize, frame costs and transitions recorded.              | Cloudflare preview image feedback, transitions and complete performance evidence. |

Generate matched Earth, Earth-and-band, Luna, night-side and Bennu review
links against the Cloudflare version URL:

```sh
node scripts/camera/preview.mjs --origin "$PREVIEW_URL"
node scripts/camera/preview.mjs --json > /tmp/camera-review.json
```

Each mode triplet shares a complete pose, photographic time and lens. A
separate long Manual view changes shutter only. The generated version 2
library can also be imported into Presets. Display output remains the
reviewer's choice; start in standard SDR. Measurements and their limits are
recorded in [CONTEXT](../../CONTEXT.md#the-sky-had-to-survive-before-it-could-be-revealed-07-sep-2026).
That is the historical camera-branch measurement. The assembled galaxy
records 0.030–0.047 ms isolated cube sampling, a deliberately revised live
volume budget and a 960-pixel history cap. Its whole outward/return recordings
expose a slower return; held GPU costs do not establish sustained 60 fps.

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
evidence. The preview PR names the exact `codex/galaxy` base and its dependencies.
This plan does not authorize merging or rebasing another agent's branch.

### Ordinary-view cache and support contract

The ordinary renderer retains physical V-anchored sky radiance, with each
half-float unit representing 1,000 nW m⁻² sr⁻¹. It first publishes a complete
32-pixel-face cube, then replaces it with a complete 128-pixel-face cube.
Both use 16-pixel tiles; the tiers require 24 and 384 tile submissions.
Three slots per tier retain completed locations and an incomplete replacement.
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

The [assembled galaxy evidence](the-galaxy.md#assembled-image-and-motion-record)
repeats the technical checks against field@5/kernel@8. Sixteen native SDR
images restore exact public pose, instant, lens and processing; two complete
journeys preserve canonical state, mode and lens. The cold-picture shutter
race is fixed by binding preferences before route restoration.

The requested PR carries that evidence for review. Artistic acceptance remains
with the user. The recorded image limitations include smooth projected dust
morphology and Earth's colorized night-map background being emitted as light;
the latter keeps the night Automatic fixture from showing a star-dominated
exposure. The return also has frame-time spikes. These findings remain open
against the intended checklist below; implementation and passing suites do not
erase them.

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
M7's 0.05 ms sampling and M11's 2 ms live-volume targets are budgets to prove;
they are not evidence that the full frame fits. If a target fails, choose and
test a bounded quality fallback before release. Hiding the default sky does
not close this gate.

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
