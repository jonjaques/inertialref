# ADR-0037: Enhanced composes the default sky; Automatic and Manual expose it photographically

Status: accepted · 7 Sep 2026. Camera policy, processing and surface-light
separation are implemented and verified. The camera plan records image and
runtime acceptance, including the limits of each measurement.
Supersedes the default-image preservation requirement in
[ADR-0031](0031-the-sensor-response.md), the ordinary-view daylight omission
policy in [ADR-0032](0032-the-stellar-field.md), and the bible's two-mode
camera direction. Their implementation measurements remain valid for the
responses they tested.

## Context

The default camera needs to show detailed bright worlds against a visible star
field and diffuse Milky Way. Natural preserves a production calibration and
integrated star sprites, but its ordinary daylight response hides the diffuse
galaxy. The engine consequently omits that volume in daylight views.

The M4 comparison makes the conflict concrete. A 2,400 s exposure reveals the
galaxy and clips Earth; 1/40,000 s preserves Earth and loses the faint field at
the same pose, aperture and ISO. The 26.5165-stop separation is useful evidence
for a photographic camera. It does not satisfy the default art direction.

The requested reference is SpaceEngine's distinction between HDR, Auto and
Manual. Its [2017 rendering explanation](https://spaceengine.org/news/blog170415/)
describes an HDR view with planets and stars visible together, alongside two
photographic modes that differ in who sets exposure. This decision adopts that
visual distinction, without prescribing SpaceEngine's rendering technique.

## Decision

**Enhanced is the default HDR composite; Automatic meters one photographic
exposure, and Manual gives that exposure to the player.**

Enhanced deliberately compresses the brightness differences between bright
surfaces, stars and faint extended emission. Its normal Earth-orbit view shows
planetary detail and recognizable galactic structure together, within the
display's limits. Dark lanes stay dark relative to neighboring star clouds;
bright stars retain their hierarchy; the planet remains the foreground subject.
The result needs no long-shutter setup or galaxy-instrument preset.

Automatic and Manual share physical source brightness, lighting, optics and a
bounded photographic response. Automatic meters scene light and adapts within
the player's comfort limits. Manual uses aperture, shutter and ISO without
meter-driven gain. Neither applies Enhanced's selective visibility treatment.
Exposing for sunlit Earth or Luna suppresses faint stars. A view with little
bright light permits Automatic to reveal them; Manual requires a change of
settings. A night-side coordinate alone does not decide exposure. Bright limbs,
planetshine, atmospheric scattering and glare can still affect the image.

There are three separate choices:

- Camera mode determines exposure and composite behavior.
- A tone curve determines the rendering of that mode's image. Changing a curve
  does not change metering, source light, or which mode is active. The controls
  expose one authored Enhanced look and the shared neutral photographic look.
  Imported Gentle and Crisp settings retain their explicit photographic shoulders.
- Display output determines gamut and available luminance headroom. Enhanced
  works on ordinary SDR sRGB displays. Display P3 is a gamut, and extended
  luminance is a separate capability, as distinguished by
  [CSS Color HDR](https://www.w3.org/TR/css-color-hdr-1/).

The interface calls the default **Enhanced**, with **HDR composite** in its
description. **HDR output** names the separate display setting. Automatic's
readout states metered exposure; Manual states the lens exposure; Enhanced
states its composite processing instead of claiming one physical EV describes
the whole image. A fixed diagnostic or cinematic exposure identifies its
override in the readout.

`resolveCameraPolicy` in `packages/rendering` resolves selected mode, response
style, effective exposure control and any staging override. `ExposureMeter`
reports effective EV, gain relative to the lens, compensation and the override.
A positive compensation brightens Automatic; it cannot add gain to Manual.
Enhanced holds the 30,000 cd/m² surface calibration and declares its separate
sky processing. Display peak and output negotiation do not select a mode.

Enhanced compresses diffuse sky luminance before the scene's half-float
conversion. The owned sky target retains physical V-anchored radiance in
nW m⁻² sr⁻¹; the composition reads that radiance and applies a presentation
gain followed by bounded luminance compression. Uniform RGB scaling preserves
chromaticity, zero remains zero, and the physical target stays available for
photographic views and diagnostics. The full-resolution scene applies depth
and silhouette coverage before the composed sky enters the common optics.
Atmospheric transmission and modeled dust attenuation remain upstream of this
visibility treatment. The lifted sky feeds glare and detector noise in Enhanced.
Automatic meters only its photographic inputs.

The diffuse gain is `2^23`, with a scene-luminance ceiling of `0.5` before the
shared display response. The wider shoulder preserves contrast between faint
background, dark lanes and bright star clouds. It changes no source radiance,
physical cache or photographic exposure, and adds no passes or allocations.

Enhanced also owns the dark-body visibility lift, integrated star visibility
and analytic solar core. Its near-field ambient and camera fill reach the hull
and props. Photographic views disable both; only a script's explicit
`calibratedLight` staging can retain them. Automatic and Manual use physical lighting and stellar
flux with the same hue-preserving photographic response. A script can explicitly
request calibrated lighting and the measured ACES staging look with
`calibratedLight`; this is an authored override with a fixed exposure, and it
releases when the script exits. Scripts do not rewrite the viewer's preference.
Ordinary galaxy travel preserves the selected mode. Fixed photometric
instruments request their stated photographic exposure explicitly.

The source model stays calibrated independently of camera mode. Catalog
luminosities, geometric albedos, dust columns and emitted radiance do not change
to make Enhanced attractive. Visibility processing belongs to the presentation
chain and remains inspectable. It respects foreground occlusion, atmospheric
transmission and dust extinction. It cannot paint a sky over a planet, restore
stars hidden behind opaque dust, or manufacture illumination on an unlit body.
Any dark-surface lift is an explicit Enhanced treatment.

A mapped surface takes reflectance from its texture and hue from a normalized
tint. A mapless surface takes reflectance from its physical palette. The sphere,
streamed ground and orbital reflectance bake share that convention; a bake
contains no camera visibility gain. Enhanced applies its bounded dark-body gain
once, at the scene material. Its 3% terrain and water fill is also visibility
processing. Photographic modes retain modeled atmospheric scattering but apply
neither that floor nor the dark-body gain.

Cloud maps remain thin weather shells. Their coverage clears continuously over
the last quarter of a deck-altitude of view path before the eye crosses the
shell; front-face culling cannot remove a bright veil in one frame. The interval
uses view-space distance and follows render compression. Distant coverage is
unchanged, and every camera mode uses the same approximation. This is not a
volumetric cloud model.

One sensor chain and the existing camera/lens producers remain in charge.
Camera settings and adaptation are presentation state, outside the canonical
world and its hash. [ADR-0029](0029-the-sensor-spine.md) continues to govern
the chain; [ADR-0017](0017-the-lens.md) governs the lens. Pre-exposure, optical
resource ownership, output negotiation and the numerical evidence in ADR-0031
remain useful. Its Natural image is a reference, not a release constraint.

Enhanced makes the diffuse sky part of ordinary gameplay cost. Eligibility
cannot follow the Natural daylight predicate. The owned ordinary-view cache
retains physical sky radiance and bounds its updates. Cache behavior and
bake/live identity belong to [ADR-0032](0032-the-stellar-field.md). Photographic
culling needs a conservative visibility bound through the actual optics and
response, including glare, rather than an exposure label alone.

Automatic samples every fourth pixel in each axis into 64 logarithmic bins.
An R8 instrument mask excludes samples covered by labels, orbit traces, landing
marks and other instruments. The reducer excludes empty bin zero, trims the
40th–99.9th percentile interval and weights log luminance by light. A small lit
disk can then dominate faint sky without an isolated hot pixel setting exposure.
Comfort limits apply to retained physical luminance with the current settings,
even when adaptation is held. Holding exposure leaves the mode Automatic.

Adaptation uses the engine's accumulated `presentationTime`, with frame deltas
bounded at 0.1 s and time constants of 0.4 s toward bright and 3.5 s toward dark.
Photographic time still places bodies and controls motion and detector noise.
Camera cuts, mode changes and photographic-time scrubs reset meter history;
generation checks discard asynchronous results from an earlier history.
Manual and pinned frames ignore meter gain and repeat at a held instant.

Camera continuity is measured in universe coordinates with the render origin
and its orientation. A 4,096 m origin rebase cannot become an exposure cut.
The physical displacement and recent velocity distinguish a discontinuity from
continuous travel; target, lens and held-time changes also invalidate history.
Motion blur bypasses the origin-change frame independently and resumes with
continuous transforms. Stale readbacks cannot update either exposure or the
defocus extent. Automatic reports Calibrating until it has a meter reading,
then Metered or Held according to the adaptation setting.

The WebGL fallback supports Enhanced SDR and lens-controlled Manual. Automatic
is visibly unavailable because that backend has no supported meter readback.
A requested Automatic view uses a labeled Manual fallback while retaining the
selected preference. A fixed calibration is never reported as metered exposure.

The preference owner migrates valid Composite + Natural to Enhanced, the other
Composite curves to Automatic, and Direct to Manual. Natural maps explicitly
to the neutral photographic look; Gentle and Crisp preserve their shoulders.
White balance, adaptation rate and comfort limits survive. The lens preference
retains aperture, shutter and ISO. Migration is written through
`state/preferences.ts`; malformed imports are rejected without resetting the
current selection.

## Alternatives considered

**Rename Natural and retain its behavior.** This leaves bright planets and the
diffuse galaxy mutually exclusive and preserves the wrong performance premise.

**Raise one global exposure or brighten the galaxy field.** The first clips
the foreground; the second corrupts calibration for every consumer. Enhanced
needs a declared presentation response with enough precision to retain faint
light until that response can use it.

**Make photographic exposure the default.** Scientifically useful, but it
does not meet the requested composition. Automatic and Manual provide it.

**Require an HDR monitor.** The default composition must work in sRGB SDR.
Extra display headroom improves highlights without deciding camera behavior.

**Keep Direct and Composite as additional player modes.** This duplicates
exposure policy and tone-curve choices. Their serialized settings need an
explicit migration; linear clipping can remain a developer diagnostic.

## Consequences

Enhanced spends processing and cache memory to retain faint structure beside
bright foregrounds. One global exposure cannot cover the 26.5165-stop M4
comparison without losing either the galaxy or surface detail. The physical
field remains independently calibrated, and its diagnostics bypass Enhanced.

Version 2 pictures and `shot=2` URLs record camera processing without adaptation
history or display hardware. Version 1 restores Enhanced while preserving its
pose, photographic time and lens; historical image equality is not promised.
[ADR-0033](0033-presets-hold-a-photographic-instant.md) owns that portable format.

Numerical tests establish exposure arithmetic, strict migration, histogram
behavior, physical continuity and surface-light separation. The
[camera completion record](../../design/plans/the-camera.md#camera-completion-record)
combines inspected mode triplets with transition recordings, backend lifecycle
checks and complete-frame costs. It distinguishes image acceptance from
instrumented timing and preserves occasional long-frame limits. The source's
smooth dust morphology remains an approximation; a camera response cannot
recover missing structure. The
[assembled galaxy record](../../design/plans/the-galaxy.md#assembled-image-and-motion-record)
retains the historical measurements. [ADR-0038](0038-the-stars-and-the-diffuse-sky.md)
owns the resolved-star and diffuse-sky implementation.
