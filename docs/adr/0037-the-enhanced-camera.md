# ADR-0037: Enhanced composes the default sky; Automatic and Manual expose it photographically

Status: accepted direction · 6 Sep 2026. Implementation is planned.
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
  does not change metering, source light, or which mode is active. The first
  release uses one authored Enhanced look and one shared photographic look.
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

The source model stays calibrated independently of camera mode. Catalog
luminosities, geometric albedos, dust columns and emitted radiance do not change
to make Enhanced attractive. Visibility processing belongs to the presentation
chain and remains inspectable. It respects foreground occlusion, atmospheric
transmission and dust extinction. It cannot paint a sky over a planet, restore
stars hidden behind opaque dust, or manufacture illumination on an unlit body.
Any dark-surface lift is an explicit Enhanced treatment.

One sensor chain and the existing camera/lens producers remain in charge.
Camera settings and adaptation are presentation state, outside the canonical
world and its hash. [ADR-0029](0029-the-sensor-spine.md) continues to govern
the chain; [ADR-0017](0017-the-lens.md) governs the lens. Pre-exposure, optical
resource ownership, output negotiation and the numerical evidence in ADR-0031
remain useful. Its Natural image is a reference, not a release constraint.

Enhanced makes the diffuse sky part of ordinary gameplay cost. Eligibility
cannot follow the Natural daylight predicate. A cache, bounded updates and
measured quality tiers must make the visible sky affordable. Photographic
culling needs a conservative visibility bound through the actual optics and
response, including glare, rather than an exposure label alone.

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

Default reference images and the ordinary-orbit performance gate change.
Enhanced may require separate radiance storage or processing before a faint
signal is lost in a half-float scene target. The implementation choice needs
numerical evidence and matched image review; this ADR does not claim a global
tone curve alone can preserve that range.

The settings migration, preset format and scripted exposures need deliberate
handling. A rename cannot preserve the meaning of every saved shot.
[ADR-0033](0033-presets-hold-a-photographic-instant.md) still owns photographic
time and portable views; a versioned extension records camera processing.

The [camera plan](../../design/plans/the-camera.md) owns the implementation
sequence and image acceptance. Galaxy M6 retains physical calibration; M7
provides the cached sky needed for everyday Enhanced views. Additional optical
effects, spectral filters and photo export do not gate this camera change.
