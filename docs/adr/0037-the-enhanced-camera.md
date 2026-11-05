# ADR-0037: Enhanced composes the default sky; Automatic and Manual expose it photographically

Status: accepted · 7 Sep 2026; amended 30 Oct 2026, the air in front of the
sky is part of what Enhanced compresses, and Enhanced opens up for the
daylight left in a darkening sky. Camera policy, processing and
surface-light separation are implemented and verified. The camera plan
records image and runtime acceptance, including the limits of each
measurement.
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

Standing inside an atmosphere, Enhanced meters. In space the calibration is
the point: the sun is the same sun wherever the ship is. On the ground the
light itself goes away. Measured air puts a civil-dusk zenith near
0.65 cd/m², thirteen stops under a noon one, and at the calibration that sky
drew black where a camera or an eye has opened by some ten stops. No figure
for the light at the eye says what the frame holds: keyed on the zenith and
the direct sun, Enhanced opened 4.1 stops on Mars with the sun 2.6° under the
surface's horizon, where the zenith was dark and the horizon, still sunlit
from 7.7 km up, was not, and the sky drew white. So inside the air Enhanced
takes the meter Automatic takes, at Automatic's rates and within its comfort
range, with no compensation: the exposure is the calibration above the air,
the meter a fifth of the way into it, and a blend between
(`meteredShare`). On the ground Enhanced and Automatic agree about the
light; what Enhanced adds there is its staging. A pinned or staged exposure
ignores the meter. What Enhanced stages rather than measures is held at
its display level while the exposure is away from the calibration
(`stagedLight`): the composed galaxy, the three-percent night fill, the lens
flare, and the near field's key, fill and ambient, alongside the integrated
stars, which already carried the inverse.

From orbit, Enhanced draws the limb a second time. The physical limb is a
line: Earth's gas falls off over 8.5 km, a seventh of a percent of the
radius, two pixels on a disk four hundred across, and a camera's limb is
that line and no more. The deep-space composite is where the bible licenses
a cheat, and the bright line the home page draws on the disk's edge is one.
Outside the air, the shell marches the air again as the body's own gas,
without its ozone, stretched to fall off over three of its own scale heights
(`LIMB_STRETCH`, 25 km on Earth) or a fifth of the eye's height over the
datum, whichever is less (`limbFalloff`, `LIMB_STANDOFF`), so the eye is
never inside the gas it draws — the same column `LIMB_GAIN` times over,
ending at two of its fall-offs (`LIMB_CEILING_FALLOFFS`), read through the
body's own tables at the height the stretch maps a sample to, and drawn
`LIMB_BRIGHTNESS` times over (`marchLimb` in `render/air.ts`, ADR-0056 for
the physics). At four fall-offs the crown, lit clear of the reddened foot,
is a periwinkle band twice the height of the orange under it, and Mars's
sunset limb a broad blue-white arch where a photograph has a thin line. A multiple of the gas and not a
fraction of the radius, so it is the same ring on every world; at a
twenty-fifth of the radius the ring stood off Earth's disk as a halo four to
seven percent of the radius wide, which the owner rejected, and a fraction
small enough for Earth is under Titan's own gas. The brightness is a
radiance gain because the stretched foot is optically thick along a
tangent — sixteen in Earth's blue — so more column only raises the height
where the ring turns opaque; at six the line is the brightest thing on the
disk's edge and a sunrise from low orbit is orange under white under blue.
The aerosol rides in the ring at its whole column and scatters without
taking: stretched, it is a band 3.6 km thick at the ring's foot, a dozen
deep along the tangent, and what it would take is the limb's own line,
while its forward lobe — fifty times its side-scatter — is the orange every
photograph of a limb has toward the sun, and its gray the white between
the orange and the blue. Its fall-off is stretched with the gas's but never
past the gas's own scale height, so the lobe stays at the foot on every
world: Mars's dust is mixed with its gas and Titan's haze is three times
its gas, and spread up the ring either paints a broad tan-white arch over
a limb photographed as a thin line. At a quarter of the column the foot of
Earth's sunrise limb is an orange thread under a periwinkle band. The ozone
stays in the physics, where it turns a twilight zenith blue from the ground;
stretched up the ring and drawn six times over, its tent took the orange out
of the band between the foot and the crown, so a low-orbit sunrise read
orange under violet with no white between and every lit rim a blue-violet. Nothing authors a color. The
ring's crown is blue because the sun reaches it clear; its foot is orange
toward the sun because the table's column reddens the beam there and the
lobe throws it forward; and the ring ends where the sun sets on the gas as
it stands on this planet, foot first — a backlit Earth wears it all round.
The ring is the shell's alone, drawn past the silhouette. The sphere, the
ground and the sea take the physical air's light: the lifted gas is the
same column a second time at nadir, and composed over the disk it laid a
blue veil that turned a Blue Marble's Sahara magenta (143 : 125 : 137 where
the physics draws 140 : 114 : 109). Under the same lift they take none of
its extinction (`clearedFromOrbit`): from orbit the measured air dims a
surface twice, on the sun's way down and the eye's way out, to about two
thirds of its own light at nadir, and reddens it toward the terminator, so
a half-lit Earth's day side read dark brown under a hard terminator where
the composite has a pale face. Enhanced lights the surface at its own light, in the
hue the beam's slant gives it over the column overhead — white at the
subsolar point, peach on a sunward crescent — shows it without the view
path's extinction, and keeps the air's light over it, which is the haze
toward the limb, lit by the beam cleared halfway so the day side brightens
into a pale haze before the terminator as the composite's does. A beam the
column has all but put out keeps its own dimming under a third of the
overhead light, or it lights the air over the night side orange; the sphere, the ground and the sea take it from the one lift, and on
the ground the lift is nothing. The shell 20 km past the edge reads within
thirty percent of the disk 20 km inside it, so the edge does not step. The ring takes no light from the limb's own line, which seen through
it keeps a quarter of its blue and turns a sunrise's band gray from low
orbit, nor from the stars behind it, where a stretched gas wears a dark
halo wherever its own light is under a count. The lift comes in over two
shell heights up from the top of the air (`limbLift`), full by three hundred
kilometers on Earth, where the reference photographs are taken from, so a
ship climbing out keeps the sky it had, and the shell mesh grows to the
ring's ceiling with it (`limbReach`); the photographic views never see it.

The neutral look keeps a light's hue through the whole curve, and over its
top 5% it rolls a saturated light toward white rather than down. Mixing
toward the gray of its own luminance, only as far as its brightest channel
needs, keeps both the luminance and the hue angle. Scaled down instead, a
2° sun drew darker than its own aureole (0.55 against 0.79), where a camera
clips the disk to a pale core. A star's darkened limb, below that top 5%,
keeps the color it is drawn with.

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

The air in front of the sky is part of the sky being compressed. Standing
inside an atmosphere, the eye sees the field through the air's own light, and
a lift measured against the field alone draws the galactic bulge through a
noon sky, brighter than the air it is seen through. `Bodies` publishes the
luminance of the zenith over the eye as `airLuminance`, from the shell's own
march along one radial (`zenithSkyRadiance`, held to the drawn zenith on the
GPU), and the composition adds it, lifted by the same gain, to the
compression's denominator. In a vacuum the term is zero and the field is
composed as above. Under a noon sky the field keeps its physical share of the
air, which is nothing a display can show, and it returns as the air darkens
through twilight. Integrated stars lose the eye's response to the same sky
(`skyMagnitudeLoss`: 2.5 · 0.59 · log₁₀(1 + B/B_night) magnitudes, fitted to a
6.5 limit under a moonless sky and −4 under a 5,000 cd/m² day). Both apply
under Enhanced only; the photographic views add the air and the field
physically and need neither. How bright that air is, and when it goes dark, is
[ADR-0056](0056-the-air-is-measured-and-its-gain-is-pi.md)'s measurement, not
a camera setting.

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
the last quarter of a deck-altitude before the eye crosses the shell. One
float64 eye altitude fades the entire oblate deck, including grazing rays,
and follows render compression. Front-face culling cannot remove a bright
veil in one frame. Distant coverage is
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
bake/live identity belong to [ADR-0038](0038-the-stars-and-the-diffuse-sky.md). Photographic
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
Motion blur bypasses origin changes, camera cuts and time discontinuities,
then resumes with continuous transforms. Exposure-key changes alone preserve
that transform history. Defocus readbacks require the submitted lens and
viewport, independently of exposure generations changed by a photographic scrub. Automatic reports Calibrating until it has a meter reading,
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
behavior, physical continuity and surface-light separation. Image acceptance is
a separate question from instrumented timing, and both are recorded rather than
asserted: sixteen matched mode triplets, two transition recordings and four
descent casts are inspected in [`CONTEXT.md`](../../CONTEXT.md), and the
complete-frame operating points, the two journeys and the optical costs are in
[the performance plan](../../design/plans/perf.md#the-camera). Enhanced draws
the sky in ordinary gameplay, so those are whole-frame figures at named points
and not a claim of sustained 60 fps — dense ground at a native Retina buffer
runs around 30–34 fps. The source's smooth dust morphology remains an
approximation; a camera response cannot recover missing structure.
[ADR-0038](0038-the-stars-and-the-diffuse-sky.md) owns the resolved-star and
diffuse-sky implementation.
