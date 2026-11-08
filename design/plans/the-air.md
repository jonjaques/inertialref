# The air: what is left

What the air, the ring and the camera's metering still have open after the
stack that measured them — #170, #171, #172, #179, #180, #181 and #182, which
land together as stack 183. Every entry is a defect in the tree as it lands,
with the figure that shows it, its operating point, where it came from (a pull
request's own account of what it left out, or the review pass over the whole
stack), and the fix where one is known. A figure a reviewer reported from the
code and nobody reproduced says so.

[ADR-0056](../../docs/adr/0056-the-air-is-measured-and-its-gain-is-pi.md) holds
the physics and [ADR-0037](../../docs/adr/0037-the-enhanced-camera.md) the
camera and Enhanced's ring. The look council's own findings — the rims, the
twilight domes, Titan's collars — are [its defects log](look-council-defects.md),
and its protocol is [its plan](look-council.md). What the air costs is in
[perf](perf.md#the-air).

---

## The camera

### At night Enhanced's meter opens to its dark clamp

Inside the air Enhanced takes Automatic's meter (`meteredShare`), and on the
ground at night the frame holds only light staged at display level — the
visibility fill, the composed galaxy, the near field — which no exposure moves.
The meter has nothing to settle on and opens to `range.dark`, about 16 stops
under the calibration, and a sunlit Moon, under the histogram's 99.9% trim,
draws that far over. Reported by the review of #171 from the code; not
reproduced. The choice is a look: the meter keeps a night ground visible, and a
bound on the opening by the daylight left keeps the Moon's relief and the
ground black. Either way the staged light belongs out of the histogram.

### WebGL has no dusk opening

The meter is null on the WebGL backend. Automatic falls back to Manual there
and Enhanced to nothing: at civil dusk the zenith, about 1 cd/m², draws black
at the calibration's 14.6 EV. Reported by #171's review. A bound computed on
the CPU, like the one above, serves both backends.

### The upscaler is told Enhanced's pre-exposure is 1

`sensor.ts` hands FSR `reading.pre` only under photographic processing.
Enhanced meters inside the air, so its history is stored at one exposure and
blended into the next while it adapts: a smear on a pan from a bright ground to
a dusk sky. Enhanced's radiance mixes pre-exposed scene light with staged light
at display level, so neither 1 nor `reading.pre` is right for it; the staged
part has to be composed after the upscaler, or carried apart.

### The hull's light is a frame behind a cut, and its windows are not staged

`CameraRig`'s staged gain and `Bodies`' disk cap read `engine.exposure`, the
last frame's reading, while the sensor applies a cut's adaptation at once: on
the first frame of a cut from orbit to a civil-dusk ground the hull's ambient,
fill and key draw about 2,048 times too bright. The emissive windows and
nacelle grilles (`shipMaterial.ts`) are authored against the calibration and
not staged, so under an opened exposure they blow out over a hull that is. And
the hull's key light ignores the air's transmittance, because `CameraRig` runs
before `Bodies` computes it. All three want the frame's exposure and air
decided before either consumer runs.

### A ground plate can be taken while the exposure is still opening

`ir.settled()` waits for the sky's cubes and the terrain, not for the sensor,
and Enhanced opens with a 3.5 s time constant on the ground while the capture
waits one second after settling. A dusk ground plate depends on how long boot
and arrival took. Reported by #171's review; no plate has shown it yet.

### The galaxy, the stars and the sun's disk take the sensor's white for the scene unit

A scene unit is the sun above the air, `SCENE_UNIT_LUMINANCE`: E⊥/π, 42,590
cd/m², the unit the air's gain of π is anchored to. `SURFACE_LUMINANCE`,
30,000 cd/m², is the sensor's calibration white, 1.420 times (0.506 stop)
under it, and four conversions divide by the white as though it were the unit:

- the galaxy's backdrop (`render/galaxyVolume.ts`) and the star sprites
  (`render/materials.ts`), which sit in a sky converted through the unit, so
  against the sunlit world both draw 1.42 times bright;
- the stars' visibility floor, `SKY_VISIBILITY.night` (`starVisibility.ts`),
  whose magnitude loss under a sky in scene units is off by up to 0.22;
- the sun's disk (`render/bodyUniforms.ts`, `diskCompression` and
  `starAsBody`), drawn at 1.6 × 10⁹/30,000 = 53,333 units where a disk that
  lights an albedo-one surface to one unit is π/Ω = 46,240, 1.153 times, and
  compressed by Enhanced with an exponent of 0.191 where the unit gives 0.197.
  `SOLAR_LUMINANCE` is the disk at sea level, 108.7 klx at 1 AU, 0.81 of E⊥.

Moving the white to the unit fixes all four and moves every plate: a manual
exposure opens 0.51 EV at a fixed lens, the calibration EV readouts move, and
the galaxy and the stars dim to 0.70 of the world. No emitter is calibrated
against either constant yet, so the move improves no picture there is to
judge. The weather's phase 5 calibrates the moon, airglow and the stars
together and re-scores `night-side`, and fixes these conversions with them.
Recorded by the weather's phase 0, which names the scene unit and changes no
constant's value; the figures are computed from the constants.

An absolute emitter added before then divides its physical radiance by
`SCENE_UNIT_LUMINANCE`, and under Enhanced staging by its body's `sunlight`
as well. Staging draws every body's sunlight at 1 (`bodyUniforms.ts`), so an
emitter that skips the second division changes its ratio to the sun with the
camera mode: 2.32 times on Mars, whose sunlight is 0.431. That figure is
inferred from the staging code, not measured.

## The sun's disk and the flare

### A photographic disk can clip the half-float target before the shell dims it

`diskThroughAir` divides the disk by the column's transmittance so the shell's
gray composite can multiply it back, capped at `DISK_THROUGH_AIR_CEILING` over
the opening. Under Automatic or a manual exposure the physical disk is about
53,000 times the scene gain, and a 2° sun's red at 1/T̄ reaches 65,504 in
`sensorRadiance` where its green does not, so the shell dims a disk whose hue
is already squashed. Drawing the disk after the shell, additively and in its
through-air color, removes the pre-division and with it the ceiling and the
division by the opening. Reported by #170's review.

### From orbit the flare sets behind the sunk sphere

Every occluder but the ground under a standing eye is the drawn sphere, sunk a
full relief under the datum, 29 km on Mars, so from 1.04 radii the sunset's
glow holds the sun at 0.55 and reaches under the ridge line. The occluder
wants the datum, or the drawn radius toward the sun. The council's log carries
the symptom as open.

### A ghost's disk is the projection of a sphere on the axis

`ghostCover` takes a body as a disk about its projected center with radius
`tan(angle)/tanHalf`, which holds on the axis. Twenty degrees off it, with a
15° angular radius, the far limb lies a quarter further out, and a ghost on an
off-center crescent's far limb survives partly faded.

### Inside an oblate giant's shell the eye's up is not the shell's

`standingIn` takes the eye's radius in the space stretched along the spin axis
and its up from the unstretched one. Terrestrial shells are round, so only an
eye inside a giant's air meets it.

### Two white dots on the civil-dusk horizon

In #170's civil-dusk frame. Not investigated.

## The ground, the sea and the sphere

### The terminator steps at the descent gate

The ground carries the sun past its horizon by `√(2h/R)` of each point's own
height inside `BEAM_TERMINATOR`, and the sphere, which has no elevation to
read, keeps the band its relief spans, 6° on Mars. Rule 59's text names it as
the one term the two do not share. The sphere reading the archive's elevation
where one exists, or the ground easing toward the band across the gate, closes
it.

### Mars's ground takes a fifth of its light from a sky the sphere does not have

The dust's `visibleThickness` is 0.57, so the ground and the sea take 19% of
the beam as skylight, where a gas-lit Mars took 5%. The sphere has no skylight
term and draws the whole beam, so near the terminator, where the sky does not
fall with the cosine, the step at the gate widens. Nor does the sphere have
the deep-sky term the ground and the sea take under Titan's air. A skylight on
the sphere from the same palette field closes both.

### `visibleThickness` weighs the dust at a third of its measure

The gas's term is the Rayleigh depth summed over three bands
(`TAU_RAYLEIGH_SUM`, 0.38) and the dust's is its depth at 550 nm alone.
Measured alike, Mars's dust scatters 1.15 of Earth's column, not 0.57, and its
ground's skylight is half its own measure. The council scored the ground views
on 0.57, so correcting the units moves them. Reported by #180's review.

### The sea's terminator takes the sheet at the datum

The beach beside a sea takes its sun past the horizon from its own height, and
the sea from none. Where a sea lies under its datum — the far shore's, 211 m —
direct light steps along the shoreline while the sun is within a degree of the
horizon, 0.56 on the sand against 0.70 on the water at an incidence of 0.01,
and the same steps around every lake above it. The fix is the ground's own
formula on the sheet: `SeaWear` carries `anchorAltitude` as `GroundWear` does,
`water.ts` takes the altitude as `terrain.ts` does and adds `pastHorizon`, and
a GPU test holds the sea and the ground to one daylight at the shore.

### The day's skylight ramp puts too much sky on the ground

Above the horizon `skylightLeft` is the linear ramp the day was tuned on, and a
sun overhead puts a quarter of the noon sky on the ground where a clear sky
measures 400 lx beside 10 to 25 klx of beam; under a sunset exposure it lights
high-albedo snow pastel pink. The published curve that would replace it is
unverified. From #170.

### The sunset's horizon band is pale where a photograph is orange

Once the single-scattered beam is gone the multiple-scattering term is near
white, so the band over a setting sun draws pale. From #171.

## The shape of the air

### A fast-spinning rocky world wears dense air over its poles

Terrestrial shells are round, because a walker's altitude is read against the
round terrain, and the drawn sphere keeps its flattening; the march holds every
height under the datum at sea-level density. A generated rocky world's day is
drawn from 6 to 72 hours, about 9% of the ones not locked spin under 12, and
there `rotationalFlattening` passes 1.3%: from orbit each pole wears about
80 km of sea-level air on an Earth-sized world, and the fastest flatten to
0.42. The root is round terrain under an oblate body, and a shell stretched
again puts a polar walker that far up in its own air, so one of the two shapes
has to give.

### Limb rays cross the gap under the datum at sea-level density

The shell stops a ray at the sunk sphere and measures its air from the datum,
so a ray outside the silhouette whose impact parameter falls between the two
crosses hundreds of kilometers of air at sea-level density: a flat bright band
21 km thick at Mars's equator and 41 km at its poles, five to ten pixels on a
1,600-pixel disk. The disk's own march stops at the datum for this reason. The
council's dark hairline between Mars's rim and its disk, and Titan's seam, sit
at the same silhouette; whether they are this band is unmeasured.

## The ring from orbit

### Over a giant's pole the ring waits for the equator's height

`limbLift` measures the eye against the equatorial datum and a giant's air is
oblate: over Saturn's pole the lift is nothing at 1,000, 3,000 and 5,000 km and
whole only by 8,000, where the stretched eye has it whole from 2,000. The fix
needs the oblate-shell decision (`giantKind`, in `apps/game`) inside
`buildScene`.

### The ring's mesh grows in every view

`bodyUniforms` grows the shell to the ring's reach under any camera, and the
shell is not an overlay, so across the annulus it writes its own velocity and
its back wall's depth over the starfield: temporal reconstruction reprojects
the stars by the limb with the planet's motion, and a photographic view marches
its fragments for nothing. The ring's ceiling is two of its fall-offs, under
the air's own top on Earth and Mars, so the mesh grows only where that ceiling
passes the top. Gating the growth on Enhanced is safe only if
`visibilityProcessing` and the sensor's `reading.processing` never disagree for
a frame.

### The ring's aerosol is a third of its column where its fall-off is capped

The aerosol falls off over the gas's height at most and keeps its 1/stretch
density, so where that cap binds the ring carries a part of the column the docs
promise: a third on Venus and the giants, a ninth on Titan's old authoring.
Reported by #179's review, before #180 put Mars's dust at its whole column;
unverified at the top.

### The ring fades to its mesh, not to its own ceiling

`marchLimb` fades to `limbReachOf`, the mesh's reach, so `LIMB_CEILING_FALLOFFS`
takes effect only where the air's top is under six scale heights: Earth's ring
runs to about four fall-offs, Titan's six, Jupiter's seven. The council scored
Earth's ring as it is.

### The lifted march weighs a step by its midpoint

The physical march takes each step's light as its integral, and `marchLimb`
keeps the midpoint rule. Under an aerosol sky, where the ring takes the dust's
extinction `LIMB_GAIN` times over, a perigee step holds about fifteen optical
depths and keeps under 1% of its light, so Mars's rim and the dust worlds' draw
dimmer than the integral would. The ring's brightness is set on the midpoint;
moving it is a re-measure.

### The night limb's cities shine through the slant

Under Enhanced from orbit the cleared transmittance draws a surface at its own
light, its night lights with it, so a city at the night limb draws at full
strength where production dims it to about 0.4 (`1 − 0.6·veil`). A physical
transmittance for emission beside the cleared one is the fix.

### The ring's foot square to the sun reads neutral-pink

Hillaire's Ψ is isotropic, and with the sun on the horizon the gas's
second-order light is the blue of the sky away from it, which a photograph
shows there too; the orange is toward the sun, in the lobe. From #172.

### A tinted aerosol can scatter more than it takes

Up to 1.34 in the red of a haze authored as a tint, measured on Titan's
authoring before #181. A haze that authors its depth takes what it scatters by
construction; the tinted ones are unverified at the top.

## Titan

### Titan's gas takes its color from the haze's particles

The gas's spectral split is read off `haze.color`, which for Titan is the
particles' single-scattering albedo, 0.95 : 0.9 : 0.74, so the gas takes red
more than blue — a depth of 0.376 : 0.357 : 0.293 — the reverse of Rayleigh,
and the blue fringe the council asked for has no gas to come from. The
authoring's 1.03 at 550 nm is the three-band sum; at 550 nm it is 0.357. The
gas wants its own Rayleigh color wherever the aerosol is the sky.

### Titan's face is drawn through its whole air from orbit

`limbShare` scales `RenderBody.limb`, which also switches on Enhanced's
clearing from orbit (`clearedFromOrbit`), so with no ring of its own Titan's
sphere, ground and sea are drawn through the full physical air under a dimmed
beam. The council's full face fell from 5.33 to 3.67 in Titan's one round. The
ring's share and the clearing want separate uniforms.

### The deep sky is one zenith under the eye

`skyOverhead` is the zenith over the datum under the camera, at the camera's
sun: ground past the terminator takes the day's zenith, and a view from outside
the shell takes none. A sky table baked beside Ψ and read per point answers
both, and frees the deep blend from the ring's constants (`LIMB_OWN_FROM`).

## The procedural families

### The far shore's horizon is a dark band

The dust family's sky under the shore's orange star lays a dark band along the
horizon, and the plate carries it: the council scored the scene 6.5 before
#182 and 4 after.

### The families' depths do not follow their air

The dust family's 0.4, the sulfuric deck's eight optical depths and the violet
haze's 0.25 are fixed numbers, where the aerosol scaled with `thickness`: a
world over 450 K with 0.05 kg/m³ of air wears the same opaque deck as one with
3.5.

### The sulfuric deck saturates Ψ's transfer

Under the exact integral an eight-depth deck at an albedo of 0.98 takes Ψ's
transfer factor to 0.976 against its cap of 0.95, in 32 of 1,536 texel
channels, red, inside the deck: there Ψ is 1/(1 − 0.95) where it should be
1/(1 − 0.976), 2.1 times low. The cap guards the series against divergence; a
deck this bright wants more of it.

### Nothing tests a family's depth reaching its body

`system.ts` carries `aerosolDepth` and `aerosolAlbedo` from the family into
`HazeLayer`, and dropping either fails no test.

## The rig

### No HDR capture exists of any of this

The rig takes SDR only. The extended-range lift, the disk's rank against its
aureole and the ring drawn six times over are held by GPU tests and have never
been looked at on an HDR display.

### `presets:compare` skips the dark pictures unless asked

Without `--all` six of the thirteen plates are not photographed — night-side,
titans-haze, jupiter-and-company, centauri-daybreak, far-ringrise and
solar-crescent — and #180's comparison passed with titans-haze and
centauri-daybreak moved 1.34% and 1.71%. A change to the air moves the dark
plates first.
