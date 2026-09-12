# Art direction

The Canopy presents a composed universe through three camera modes. Enhanced
is the default art direction; Automatic and Manual offer photographic exposure.
The source data remains physically grounded in every mode.

The three camera modes and their processing are implemented in
[ADR-0037](../adr/0037-the-enhanced-camera.md). This page states the image goals;
[the performance plan](../../design/plans/perf.md#the-camera) holds the measured
limits of the frame those goals are drawn in. The optical
and ACES diagnostic baseline remains in
[ADR-0031](../adr/0031-the-sensor-response.md).

---

## The Canopy is a sensor, not a window

The single idea this page turns on.

> **What you see through the canopy is not light arriving at your eye. It is an
> image, composited from hull sensors, with gain, integration time and a
> selectable response curve. It is a camera, and you are operating it.**

This resolves four problems at once, which is how you know it is the right
fiction rather than a convenient one:

| Problem                                                 | How the sensor fiction resolves it                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Beauty vs honesty**                                   | Physical light includes structure below human visual thresholds. A long photographic exposure can reveal it; Enhanced instead compresses brightness differences to compose that light beside bright worlds. Its displayed shutter does not promise literal accumulation over that duration. |
| **Eleven orders of magnitude of luminance**             | A camera has gain and a response curve, and both are things a pilot adjusts. Exposure becomes a _control_ rather than an invisible automatic that fights the player.                                                                                                                        |
| **The flip problem**                                    | After the flip you are pointed backwards, engine-toward-destination — and the emotional core of the game is looking at the thing you are approaching. A composited view can face any direction without breaking first person, because you are looking at a screen, not out of a hole.       |
| **[Pillar 4](charter.md#pillar-4--you-are-one-person)** | Still one person, one seat, one viewpoint. The camera moves; the head does not.                                                                                                                                                                                                             |

**There is also a real window.** A physical viewport, smaller, off to one side,
showing the actual direction with no processing at all — dim, high-contrast,
mostly black. It exists to make the distinction legible, and to be the thing
players look through when they want to know what it really looks like out there.

> 🎮 Designer's Note: This is the load-bearing idea of the visual design and it
> should be established in the first thirty seconds. The powered-down cockpit at
> 0:00 shows the true window: Earth, harsh, blown out on the day side, black on
> the night side. Then the canopy comes up and the same view resolves into
> something composed. The player learns what the canopy is by watching it turn on.

---

## The three camera modes

The player can select any mode from the Canopy controls. The same camera
policy applies in flight, the planetarium and photo controls; authored cinema
and fixed diagnostic instruments identify their exposure overrides.

### Enhanced

Enhanced is the default, described as an HDR composite. A sunlit Earth keeps
cloud detail, oceans and a readable terminator while stars and the diffuse
Milky Way remain visible around it. Luna keeps its relief. Dust lanes remain
darker than the star clouds beside them. The image has depth and a foreground
subject, rather than a uniform lift of every shadow.

The sensor deliberately compresses brightness differences to produce this
image. It can treat faint space and bright surfaces differently, with that
processing declared and inspectable. The underlying light, geometry and
extinction remain calibrated. A longer shutter alone cannot reveal the galaxy
beside a correctly exposed sunlit world.

Enhanced works on ordinary sRGB SDR displays. It uses additional gamut and
luminance headroom when output supports them. Its name does not depend on the
monitor, and its readout does not pretend the composite has one photographic EV.

### Automatic

Automatic uses physical source brightness and meters a photographic exposure.
A view exposed for sunlit Earth or Luna loses faint background stars. When
little bright light remains in frame, exposure can rise and stars emerge within
the player's comfort limits. Looking from a planet's night side does not itself
force a brighter sky; a bright limb, planetshine, atmosphere or glare still
contributes light.

Adaptation is bounded and can be held. Holding exposure leaves the mode
Automatic, and tightened comfort limits still apply. Exposure compensation lets
the player bias the meter without changing the lens. Automatic shares its
photographic tone response with Manual and applies none of Enhanced's selective
visibility lift. On WebGL, the controls explain that Automatic is unavailable
and identify the lens-controlled Manual fallback.

### Manual

Manual uses the same photographic image model, with aperture, shutter and ISO
under the player's control. A long exposure reveals faint space and can clip a
sunlit world; a short one preserves the world and loses the faint light. The
meter cannot undo the player's setting.

Manual remains accessible for photographs and comparisons at known settings.
It has a display response, rather than requiring raw channel clipping to prove
physical intent. Its readout names the actual exposure.

Camera mode, tone styling and display output have separate jobs. A tone-curve
change cannot enable metering or alter physical source light. The controls use
one authored Enhanced look and one shared neutral photographic look. Imported
Gentle and Crisp settings retain their photographic shoulders; tone variants
are outside the initial controls.

---

## Where license is granted, and where it is not

The whole point of the sensor fiction is that this line can be drawn precisely
rather than argued case by case.

### Never — the data is not negotiable

Anything a player can check against a catalog. If it is wrong, the game has
lied and [pillar 2](charter.md#pillar-2--the-sky-is-real) is gone.

`position` · `parallax and distance` · `spectral class` · `effective temperature`
· `mass` · `radius` · `luminosity` · `orbital elements` · `confirmed exoplanet
parameters` · `which stars are scoopable` · `body count and provenance` ·
`a body's figure` · `geometric albedo`

A star's **color** is on this list, because it is computed from its effective
temperature. A K dwarf is orange. It does not get to be a nicer orange.

A body's **figure** is on it for a sharper reason: below about 200 km across,
gravity has not rounded a body off and its _shape is its identity_. Phobos is
27 × 22 × 18 km with a nine-kilometer crater in one end. 216 Kleopatra is a dog
bone. Bennu is a spinning top with a ridge round its equator. Drawing any of them
as a sphere is not a simplification, it is a picture of a different object —
which is why twenty-five of them ship as measured shape models and every
half-extent in `packages/universe/src/solar/` is a published number. See
[ADR-0013](../adr/0013-measured-figures.md).

### Granted — the image is photographed, not measured

Everything downstream of the physics, where a real imaging system would also be
making choices:

| Licensed                                           | Bounded by                                                                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exposure, composite compression, highlight rolloff | It is a camera. There is no "correct" curve.                                                                                                                                      |
| Integration time — making the faint visible        | The structure must actually be there                                                                                                                                              |
| Saturation and color mapping                       | Hue is fixed by physics; how vividly it is rendered is a sensor choice                                                                                                            |
| Atmospheric scattering coefficients                | Tuned within the real range for the modeled composition                                                                                                                           |
| Aurora intensity and occurrence                    | Requires a magnetic field and an atmosphere, both of which are generated properties                                                                                               |
| Ring particle albedo and phase function            | Within the range Cassini actually measured                                                                                                                                        |
| Dust, nebulosity, zodiacal light brightness        | Present where it is present; source brightness is calibrated; Enhanced controls its presentation                                                                                  |
| Glare, bloom, diffraction spikes                   | A property of the aperture, which is a designed object                                                                                                                            |
| Surface material response                          | Albedo comes from the biome; roughness and detail are art                                                                                                                         |
| The shape _below_ the published half-extents       | The extents are measured; what happens between the samples of a model, or in place of one, is generated. Volume is preserved exactly, so the body is never a different size       |
| Per-body exposure at close range                   | Enhanced only, as a declared presentation lift. The geometric albedo stays unchanged and the body retains its dark character; Automatic and Manual have no hidden body correction |

Source radiance and image processing have separate acceptance checks. Catalog
measurements, geometric albedo and dust columns are never tuned to make the
composite work. Enhanced may reveal existing light, but it cannot draw stars
through a planet, undo an opaque dust lane, or invent an illuminated night side.

The test for a visual flourish is whether the light or structure exists in the
model and whether the declared processing explains the picture. A single
photographic exposure need not contain the whole Enhanced composition.

---

## The beauty budget

What specifically makes it beautiful. **Every item on this list is real**, which
is the whole argument of this page: the cosmos does not need help, it needs to be
rendered properly and integrated long enough to see.

|                                    | Why it is spectacular                                                                                   | Real?                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Multiple-scattering atmosphere** | Twilight, the blue hour, godrays through terrain, the color of the sky from inside and from above       | ✅ Bruneton-style precomputed transmittance and scattering             |
| **Aurora**                         | Curtains of green and crimson over a night-side pole, visible from orbit                                | ✅ Needs a magnetosphere and an atmosphere — both generated properties |
| **Ring systems**                   | Forward scattering makes rings _blaze_ when backlit; shadow bands across the planet; spokes             | ✅ Cassini measured the phase function                                 |
| **Zodiacal light and gegenschein** | A vast faint cone along the ecliptic. Almost never rendered in a game.                                  | ✅ Sunlight on interplanetary dust                                     |
| **The galactic plane**             | Dust lanes, star clouds, the bulge — as a long exposure sees it                                         | ✅ This is what astrophotography looks like                            |
| **Planetshine**                    | A moon's night side lit blue by the planet it orbits                                                    | ✅ Earthshine; computable from the geometry                            |
| **Eclipses and transits**          | A moon's shadow crossing a cloud deck below you                                                         | ✅ Falls out of real orbits, for free                                  |
| **Limb effects**                   | Limb darkening on a star; atmospheric refraction and the green flash at a planet's edge                 | ✅                                                                     |
| **Terminator detail**              | Kilometer-long shadows at the day–night line, which is why every good orbital photograph is taken there | ✅                                                                     |
| **Noctilucent clouds, airglow**    | A thin green band above the limb at night                                                               | ✅                                                                     |
| **Ice and water**                  | Subsurface scattering in ice, specular sun-glint off a sea                                              | ✅                                                                     |
| **Sensor glare**                   | Diffraction spikes, ghosting, and a real point-spread function around a star                            | ✅ It is a lens                                                        |

**None of that requires a single falsified number.** It requires a good
atmosphere shader, a good phase function, and the willingness to integrate.

**Deferred direction: narrowband composite, declared.** Once line emission and
spectral filters exist, the canopy identifies the false-color mapping and lets
the player select a filter
— switch to broadband and watch the nebula almost vanish into the noise floor.

This is exactly what a real observatory does, it makes the largest license in the
design into a mechanic and a teaching moment, and it is entirely consistent with
[the sensor fiction](#the-canopy-is-a-sensor-not-a-window). The player is never
shown something untrue; they are shown something _processed_, and told which
processing.

---

## HDR

HDR output is a display option, independent of Enhanced, Automatic and Manual.
sRGB and Display P3 describe color spaces; extended luminance describes output
headroom. Every camera mode needs a useful SDR image. Extra headroom serves
highlights without changing physical calibration or the selected camera mode.

**The game renders and outputs in HDR.** Not merely an HDR internal pipeline that
tonemaps to SDR at the end — actual extended-range output to displays that can
show it.

This is verified rather than aspirational. Three.js's WebGPU renderer has a
working HDR path, and **one constructor parameter turns the whole thing on**:

```js
// outputType: HalfFloatType does two things at once, and both are required:
//   WebGPUUtils.getPreferredCanvasFormat() → 'rgba16float'
//   WebGPUBackend                          → context.configure({ toneMapping: { mode: 'extended' } })
const renderer = new THREE.WebGPURenderer({
  antialias: true,
  outputType: THREE.HalfFloatType,
})
```

> ⚠️ **Setting `renderer.outputColorSpace = ExtendedSRGBColorSpace` alone does
> nothing.** In r185 `ExtendedSRGBColorSpace` is an _addon_
> (`three/examples/jsm/math/ColorSpaces.js`), not a core export, and the
> `toneMappingMode` it declares is never read — `ColorManagement.getToneMappingMode()`
> has no caller anywhere in `src/`. The WebGPU backend derives the mode solely
> from `outputType`, verified against the r185 sources.

`renderOutput(color, toneMapping, outputColorSpace)` in TSL gives explicit control
inside a post chain — remembering `postProcessing.outputColorTransform = false` so
the transform is not applied twice.

### Detection: measured, and it does not work

[Spike 1](../spikes.md#1--hdr-display-detection) put the three candidate signals
in front of three browsers on one physical display, at the same second:

| Signal                                           | Chrome 151             | Safari 26.5            | Firefox 153 |
| ------------------------------------------------ | ---------------------- | ---------------------- | ----------- |
| `(dynamic-range: high)`                          | **true**               | **true**               | **false**   |
| `(dynamic-range: standard)`                      | true                   | true                   | true        |
| `(video-dynamic-range: high)`                    | false                  | false                  | true        |
| `screen.isExtended`                              | false                  | _absent_               | _absent_    |
| `screen.highDynamicRangeHeadroom`                | _absent_               | _absent_               | _absent_    |
| `dynamic-range-limit: standard` / `no-limit`     | ✅                     | ✅                     | ❌          |
| WebGPU `rgba16float` + `toneMapping: 'extended'` | ✅ verified end to end | ✅ verified end to end | **throws**  |

The display in that test is an ordinary laptop panel with **2× EDR headroom and no
reference HDR mode**, and Chrome and Safari both call it `dynamic-range: high`.
They are answering _"will extended range be carried?"_ — not _"is this display
worth authoring HDR for."_ Only the first question has an API, and **there is no
headroom API at all**, so the page cannot tell 2× from an XDR display's ~16×.

Three consequences, and all three are design constraints rather than
implementation notes:

1. **`auto` is a capability test, not a display test.** The media query says the
   compositor will carry the values; a WebGPU `configure` probe says this browser
   can produce them. Firefox fails the second and passes nothing else, so the
   probe is the load-bearing half.
2. **The tone curve must be headroom-agnostic.** It cannot be tuned to a peak
   luminance the page is not allowed to know. Design for graceful behavior across
   2×–16× rather than a mapping that assumes one of them.
3. **The three-state override stops being a nicety.** Auto will be wrong for
   somebody on every one of these browsers, in both directions.

```js
const canOutputExtendedRange =
  'gpu' in navigator &&
  window.matchMedia('(dynamic-range: high)').matches &&
  (await probeExtendedCanvas()) // configure rgba16float + toneMapping 'extended'
```

`dynamic-range-limit` computes to `no-limit` initially, so nothing is needed to
opt _in_; `standard` is the opt-_out_ lever and it inherits, which makes "clamp
this subtree" one CSS declaration. Attach a `change` listener to the media query
rather than reading it once — a window can move between displays.

**Firefox has no HDR output path at all** ([bug 1834395](https://bugzilla.mozilla.org/show_bug.cgi?id=1834395)),
so the SDR path is not a fallback for weak hardware; it is the path for an entire
browser. It has to be genuinely good.

| Requirement              | Specification                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internal pipeline        | Retain physical sky radiance in its owned target; apply Enhanced luminance compression before the scene half-float conversion; one final output encoding.                    |
| Output                   | Extended range when the browser and canvas support it; a useful SDR rendering of the selected camera mode otherwise.                                                         |
| The two paths must agree | The SDR render is a _tonemapped version of the same image_, never a differently-authored one                                                                                 |
| Peak luminance           | An authored cap on available output headroom, independent of camera exposure. The current chain supports up to 2× white; broader headroom is a separate capability question. |
| Tonemapper               | One authored Enhanced look and one photographic look shared by Automatic and Manual. Tone styling does not choose exposure policy.                                           |
| Adaptation               | Automatic uses 0.4 s toward bright and 3.5 s toward dark on bounded presentation time, separate from photographic time. Manual adds no automatic gain.                       |
| HUD                      | Composited _after_ tonemapping at fixed luminance, so it stays legible against a star                                                                                        |

> 🎮 Designer's Note: HDR output is also the strongest possible answer to
> [risk #4 — nobody finds it](risk.md). A browser tab that makes an HDR display
> visibly do something no other browser tab does is a demonstration that survives
> being seen over someone's shoulder. Build the HDR path early, not last.

---

## Photo mode

A first-class feature, not a bolt-on, for three reasons: the audience for this
game screenshots obsessively; the game's marketing is its own images; and a
camera the player can actually operate is the natural expression of the
[Canopy fiction](#the-canopy-is-a-sensor-not-a-window).

| Control                          | Notes                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Free camera                      | **Bounded to a tether from the ship** — pillar 4 survives, because the camera is a drone you deployed |
| Exposure, integration time, gain | The same controls the canopy has, at finer resolution                                                 |
| Aperture and focal length        | Real depth of field and real diffraction                                                              |
| Filters                          | Broadband, narrowband, and the false-color composites the nebula question hangs on                    |
| Time                             | Pause and step; the simulation is deterministic, so a stepped frame is exact                          |
| Export                           | Full HDR and tonemapped SDR, with the location's address stamped in the metadata                      |

**The instrument exists.** [ADR-0017](../adr/0017-the-lens.md) makes the camera a
lens rather than an angle — focal length on a 24 mm gauge, zoom, f-number, focus
distance, shutter and gain — and the camera panel already drives all of it and
prints what it implies: the sharp band, the blur circle against the pixel it has
to hide inside, the Airy disk against the f-number where it stops fitting, and
the exposure in stops. What photo mode adds is the tether, spectral filters and export. The lens-derived blur and the sensor response
follow [ADR-0037](../adr/0037-the-enhanced-camera.md), with the optical
calibration recorded in [ADR-0031](../adr/0031-the-sensor-response.md).

The numbers are why that split is safe rather than a deferral. At the flight
lens the hyperfocal distance is 5.37 m over a 1520 px buffer — it is a claim
about a display, so it is 3.8 m over 1080 px and 4.5 km at the telephoto end
with the zoom racked out — and at planetary range everything is past it and
sharp: defocus is a near-field effect, the hull, the cockpit, a rock two meters
away, and no lens the game is flown behind reaches a planet with it. Diffraction
and exposure are not like that. They act at every scale, which is why the parameters
and the optical passes share one sensor chain.

**The address in the metadata is the good part.** A screenshot carries the
address of where it was taken, and because the universe is a deterministic pure
function, anyone can paste that address and go there. The image _is_ a
coordinate.

---

## Influences

| Source                                | What is taken                                                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cassini, Juno and Voyager imaging** | The primary reference. Rings backlit, Saturn's terminator, Jupiter's poles. Real photographs of real things, and better than anything invented. |
| **SpaceEngine**                       | Bright planets and faint space together in the default view, with separate automatic and manual photographic exposure.                          |
| _Interstellar_ (2014)                 | Physically-derived spectacle; the practical, unglamorous cockpit                                                                                |
| _2001: A Space Odyssey_               | Restraint. Hard shadows, no fill light, silence. One light source.                                                                              |
| **Astrophotography**                  | The integrated look — what a sensor sees that an eye does not. The faint structure and color Enhanced reveals through declared processing.      |
| **Elite Dangerous**                   | Cockpit HUD legibility; holographic instrument language                                                                                         |
| **Hardspace: Shipbreaker**            | Industrial, worn, legibly functional hardware                                                                                                   |

**Deliberately not an influence:** No Man's Sky's invented palette, and the
"space fantasy" nebula backdrop. We can be as vivid as a narrowband composite;
we cannot be vivid where there is nothing.

---

## Continuity — the no-pop-in specification

The brief's hardest visual requirement: _orbit → reentry → landing → egress →
walking, with no pop-in._
[Pillar 1](charter.md#pillar-1--one-continuous-space) makes it non-negotiable.

Discrete LOD tiers pop. The current `packages/rendering/src/lod.ts` selects one of
four tiers from angular radius, with a single set of thresholds and no
hysteresis. It is correct, and it will visibly pop. Six changes fix it.

**1. Hysteresis.** Promote at θ, demote at 0.85 θ. Requires `selectLod` to take
the current tier as an input — the one place this specification touches existing
code directly.

**2. Cross-fade across the band.** Both representations render, blended by
`smoothstep(0.85θ, θ, angularRadius)`, dithered with temporally-stable blue noise
rather than sorted transparency.

**3. Impostors generated from the sphere, not authored.** The `billboard` tier is
rendered from the same BRDF and lighting as `sphere`, by rendering to a small
offscreen target reused across frames. The transition becomes a _resolution_
change rather than a _representation_ change. **Highest-value item in this list**
— an authored impostor will never match, and the mismatch is what the eye catches.

**4. Terrain geomorphing.** ✅ A vertex slides onto the position its parent's
coarser grid holds for it, arriving exactly as the parent takes over, over the
band `[1.25, 1.8]` of the node's own split range. The normals morph with it over
two cells — which is one of the parent's — and so does the surface cover, or the
switch trades a pop for a shimmer that never stops.
[ADR-0015](../adr/0015-terrain-level-of-detail.md),
[ADR-0020](../adr/0020-the-face.md).

**5. Edge stitching and cube-face wrapping.** ✅ A patch is generated with two
rings of border outside it, so its normals are central differences _everywhere_,
including the edge, and two patches agree exactly along the one they share. A
one-sided difference there is half the gradient over half the span, which draws
as a lit hairline along every boundary; taking the rows from the neighboring
patch instead makes a patch's geometry depend on which of its neighbors happen
to be loaded. The quadtree walks all six cube faces and is restricted to 2:1,
which is the gap the morph can close.

**6. Predictive streaming with a per-frame generation budget.** ✅ Twenty-four
requests a frame, against a set taken from where the eye will be in two seconds
and asking for the whole pyramid under it, coarsest first. Without it a fast
descent outruns generation, which is pop-in caused by scheduling, and no amount
of blending fixes it. The velocity is measured in body-fixed axes: a hovering
camera co-moves with the body at its orbital velocity, so a universe-frame drift
pushed two seconds ahead aims the request set along the orbit rather than along
the camera's track over the ground.

**A burn makes this harder than a cruise did.** Under
[the new travel model](flight.md#the-burn) the camera can be doing 20 c one
minute and standing still the next, and the second half of every burn is spent
_decelerating toward_ something at a rapidly changing rate. Predictive streaming
must extrapolate against the burn solution, which it can, because the solution is
known in advance — the nav computer already computed it.

### Also required

| Item                                   | Why                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| Scatter fade by scale                  | Instanced rocks scale from zero rather than alpha-popping                           |
| Reversed-Z depth                       | With the existing depth compression, keeps a 2 m rock and a gas giant in one buffer |
| One atmosphere shader at all altitudes | Two means a visible switch, which breaks pillar 1                                   |
| Shadow cascade cross-fade              | A cascade boundary sweeping the ground during descent is very visible               |

### The acceptance test

> **A single continuous 90-second recording, from 400 km orbit to a walking
> player picking up a rock, in which no frame shows a discontinuity.** Reviewed
> frame by frame. Milestone gate for
> [M2](production.md#m2--the-believable-world), pass/fail.

---

## Palette

Physics decides the world's color. This palette is for the **interface**, which
must stay legible against everything from interstellar black to a star at display
peak luminance.

| Token        | Hex       | Used for                                                                                                                   |
| ------------ | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `instrument` | `#7FD4E8` | Primary HUD readouts, reticles, the burn plan. Pale cyan reads as projected light and never occurs naturally in the scene. |
| `observed`   | `#4C9AFF` | Catalog-backed bodies and data                                                                                             |
| `projected`  | `#8A94A6` | Generated bodies — desaturated, because a projection should look provisional                                               |
| `surveyed`   | `#4ADE80` | Your own observations and discoveries                                                                                      |
| `caution`    | `#F5A623` | Heat above 80%, fuel reserve, a burn solution that will not close                                                          |
| `critical`   | `#EF4444` | Integrity loss, module failure, life support                                                                               |
| `void`       | `#05070C` | Interface backgrounds and scrims. Never pure black — a scrim must be distinguishable from space.                           |

**HUD luminance is fixed, in nits, after tonemapping.** In an HDR pipeline a UI
element specified in sRGB values will either vanish against a star or glow like
one. The HUD is composited at a specified absolute luminance, and the requirement
is 4.5:1 against a fully blown-out background — verified with the tonemapper in
the loop.

**No information is carried by color alone** — provenance uses dash pattern,
scan state uses glyphs, all three colorblind palettes tested against the
star-glare case. See [ux](ux.md#accessibility).

---

## Ships and hardware

**Industrial, worn, and legibly functional.** Every visible element should look
like it does something: radiator panels that are visibly radiators, hardpoints
that visibly deploy, an intake that is visibly an intake.

This is a scope decision as much as an aesthetic one. Ships are
[assembled from parts](content.md), and a functional-industrial language is one
where parts _should_ look modular — panel seams, bolts, differing metals and wear
at the joins read as authentic rather than as a seam in the generator.

| Guideline                              |                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| Silhouette first                       | A hull must be identifiable as a black shape at 200 m                              |
| Material variety over geometric detail | Three materials on a flat panel beats a thousand triangles                         |
| Wear where hands and exhaust go        | Procedural masks driven by the parts layout                                        |
| Radiators are the visual signature     | They glow, and how brightly is [a readout you can see from outside](ships.md#heat) |
| No decoration                          | Nothing exists to look good. Things look good because they work.                   |

---

## Animation

Very little, all of it in service of continuity.

| Moment                   | Requirement                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The flip**             | The signature image. Freefall, silence, the ship rotating, the destination swinging into view, the drive relighting and the floor arriving the other way. Everything unsecured floats and then falls. |
| **Seat entry / exit**    | One continuous first-person move from standing to seated. The world never cuts.                                                                                                                       |
| **Canopy power-up**      | A constrained photographic view resolves into Enhanced, revealing the sky while retaining bright-world detail. This is authored staging, with the player’s mode restored afterward.                   |
| **Airlock cycle**        | 6 s, with a real pressure gauge on a physical door                                                                                                                                                    |
| **Hardpoint deploy**     | 1.2 s, mechanical, with drag and signature changing on the same timeline                                                                                                                              |
| **Suit and ship gauges** | Never instant. A gauge that snaps reads as UI; one that moves reads as an instrument.                                                                                                                 |
| **Hands**                | Always present, holding things with mass                                                                                                                                                              |

**No third-person animation exists.** There is no character to animate from
outside, which removes an entire discipline from the critical path — one of the
largest scope savings
[pillar 4](charter.md#pillar-4--you-are-one-person) delivers.

---

## Related

- [technical](technical.md) — the WebGPU and HDR pipeline this requires
- [flight](flight.md#the-burn) — why the camera's velocity range got harder
- [ux](ux.md) — the Canopy's controls, and the palette in use
- [content](content.md#terrain) — the biomes and material sets
- [ADR-0003](../adr/0003-render-coordinates.md) — floating origin and depth compression
