# Rings: what the record promises and what the frame draws

Nine bodies in Sol carry a ring system and one of them reads as having rings.
The catalog says so, the object panel says so, and the picture does not — which
is the shape of a defect worth writing down, because the first three guesses
about it are all wrong.

## What is not wrong

**Every ringed body draws its rings.** The mesh is built wherever
`body.rings !== null` and drawn wherever the body is past the `point` tier.
Uranus's system is in the frame; it is a faint dark ellipse around a crescent.
Nothing is missing, nothing is culled, and there is no threshold on optical
depth anywhere in the draw path.

**The photometry is right, including the part that looks wrong.** A ring is
brightest _backlit_ when it is thin, which is why Voyager found Jupiter's from
behind. Measured on the real adapter, face-on, over a uniform slab:

| τ    | lit    | backlit | backlit / lit |
| ---- | ------ | ------- | ------------- |
| 0.02 | 1.6e-4 | 8.6e-3  | 52.3          |
| 0.10 | 3.7e-3 | 3.8e-2  | 10.5          |
| 0.40 | 3.8e-2 | 9.8e-2  | 2.56          |
| 0.70 | 7.9e-2 | 1.1e-1  | 1.39          |
| 1.10 | 1.2e-1 | 9.7e-2  | 0.79          |

The crossover at τ ≈ 1 is the published behavior and the material gets there
on its own, from single scattering through a slab, with no forward-scattering
term written for the purpose. The table was taken at `ω₀ = 0.6`; the material
carries 0.9 now, on both terms, so every row scales by 1.5 and no ratio moves.

**It is not aliasing — for a smooth strip.** The obvious explanation for a
system of hairlines is that they fall between samples. Measured against the
size of the ring in the frame, at τ 0.7 with a generated strip, the mean
brightness over the annulus was flat across three orders of magnitude of ring
size. That was true of a strip with no fine structure; the strip carries a
grain now and is mipmapped for it, below.

## What was wrong

**A generated ring system's character was its host's kind, and nothing else.**
`proceduralRingStrip` branched once: an ice giant got six to eleven dark
threads, a gas giant got three to five bright broad bands. So every generated
ice giant in the galaxy wore the same near-invisible system, and the variety a
player saw across a hundred worlds was two looks — one of which measured
3.8e-4 over the annulus, which is nothing.

That is the wrong model for everywhere but Sol. No exoplanetary ring system
has ever been photographed, so its character is exactly the kind of thing the
generator should draw from the seed, and the design bible's license is for
this. The frequency already said so in its own docstring — one giant in six,
chosen "to make them a find rather than wallpaper" — and the same argument
applies one level down, to what a find looks like when it is found.

**And Sol's mapless rings were drawn by the same coin.** Uranus, Neptune and
Jupiter carry no ring photograph, and neither do Haumea, Quaoar, Chariklo and
Chiron, so all seven went through the generator — where a kind-lean is a
probability, and for Uranus a two-in-five chance of a Saturn sheet on the one
body whose thirteen narrow rings are the reason the thread architecture
exists. The art doctrine settles every Sol body by what is published.

## What the strip draws now

A **character** per system: an architecture, a particle albedo and a tint,
drawn once because a ring is the debris of one event. The host leans the
architecture rather than deciding it — a gas giant is 55% sheet, 25% mixed,
20% threads; an ice giant 30 / 25 / 45 — and the albedo and tint follow the
architecture, because the three have a common cause: a sheet is clean water
ice and reads cream, ice or tawny near Saturn's 0.5, a thread system is
processed rubble in charcoal or rust near Uranus's 0.03, with pale blue and
slate as the rare finds.

A **profile** from the character. A sheet is three to seven plateaus with a
gap beside each, a diffuse inner edge and a sharp outer one, a grain of
density waves across every plateau at eighteen to sixty cycles per strip, up
to two Cassini divisions cut clean through, up to two ringlets shepherded in
the gaps, and a C ring of faint dust planetward of the first bright band
three times in five. A thread system is four to twelve hairlines, one in five
paired, the outermost dominant and densest, with a haze of dust between them
half the time. Mixed is a sheet inside and threads outside, with dust
between. The densest band is at alpha one, which is where the record's
optical depth lands.

**Sol's seven are looked up** in a table keyed by address — Uranus thirteen
charcoal threads, Neptune five in rust, Jupiter a single reddened sheet that
draws nothing at 3 × 10⁻⁶, and the four small bodies as the one or two rings
their occultations found. `proceduralRings.test.ts` holds the table to the
catalog both ways: every key is a mapless ringed body in Sol, and every such
body has a key.

Measured over twelve seeds at τ 0.7, mean brightness over the annulus,
against the single value each class produced before:

| host      | was    | min    | median | max    |
| --------- | ------ | ------ | ------ | ------ |
| ice giant | 3.8e-4 | 3.0e-5 | 4.5e-3 | 1.2e-2 |
| gas giant | 5.9e-3 | 1.1e-4 | 8.2e-3 | 2.3e-2 |

The typical generated ice giant is twelve times brighter than the one look it
had, the gas giant's median is up by a third, and both span two to three
hundred times between their faintest and brightest. `rings.gpu.test.ts` holds
the spread and the photometry.

**The strip is mipmapped**, the way `planetTextures.ts` loads a photographed
one, because the grain needs it: sixty cycles across 512 texels is a cycle
every eight, and a ring a hundred pixels across samples one texel in five —
a moiré that crawls with the camera. Filtering is sampler state, so no program
changes and the stand-in the pipeline was warmed with stays the one the ring
binds.

**`ω₀` is 0.9.** The strip's colour multiplies the single-scattering albedo,
and the strip is where the darkening lives — Saturn's B ring is 0.51 in its
photograph, Uranus's rubble 0.06 — so at 0.6 the albedo was in the product
twice and the lit face of a τ 1 sheet sat at a sixth of its planet. Clean
water ice in the visible is 0.9 and the product is then the 0.5 to 0.6
Cassini measured for the bright rings. Both terms carry it, so the crossover
above does not move.

## Considered and declined

**Normalizing the strip so the record's number is an annulus mean.**
`RingSystem` calls its figure a mean normal optical depth, and the shader's
thickness is `opticalDepth · band.a` — so read literally the strip should be
scaled until its own mean is one, and a thread system, whose bands cover a
few percent of the annulus, would have each hairline carry thirty times the
quoted depth. The published numbers refuse it. Uranus is recorded at 0.5 and
its ε ring is measured at 0.5 to 2.3: the figure in the record behaves as the
main ring's depth, not as an average over thousands of kilometers of gap.
Normalizing would make the panel's number agree with the annulus and disagree
with the ring, which is the worse of the two. The profile peaks at one
instead, so the quoted depth lands on the densest band.

It also cannot be done in the strip alone. Alpha is a byte in [0, 1], so a
profile whose peaks exceed one clamps rather than scales, and a true
normalization would have to divide in the material — a uniform the generator
computes and the shader spends. That is the shape the change would take if
the record ever carries a real annulus mean.

**Untinting the rings.** They are already untinted: a mapless strip carries
its own colour and `Bodies.tsx` gives it white, because dyeing it with the
body's colour is how Uranus's charcoal threads came out cyan once. Only a
photographed strip takes the tint.

**A floor under the lit face near equinox.** A sheet whose star is within a
few degrees of the ring plane is drawn dark, because a flat slab lit at
grazing incidence intercepts almost nothing — and Saturn's rings did go dark
at the 2009 equinox. What the slab lacks is the ring's own thickness and
multiple scattering, which kept Cassini's equinox pictures at a few percent
rather than a few thousandths. A μ₀-independent term would buy that and is
not written, because it is a number nobody here has measured; the geometry
lever is spent instead — see below.

## Deliberately unchanged

- **Jupiter draws nothing, at τ = 3 × 10⁻⁶.** It is a dust band that no
  photograph from outside a spacecraft has ever shown, and the arithmetic
  above puts it below one part in 10⁵ of the frame at every geometry. Correct
  as it stands.
- **Sol's four giants, Haumea, Quaoar, Chariklo and Chiron keep their
  published optical depths.** The character table decides what a strip looks
  like, not how thick it is.

## The geometry lever

Most of what makes a generated ring system faint is where its star sits: a
planet of ordinary tilt spends most of its orbit with the star within a few
degrees of the ring plane, and the slab is honest about that. Saturn's rings
are a sight because of 26.7°; Uranus's would be, at 82°, if they were not
charcoal. The planet tilt draw now stretches its tail — one planet in eleven
lands past 34°, up to 86° — from the same single gaussian, so no other draw in
a system moves. It is a distribution the Solar System's own eight support,
two of which are on their sides.

## The seam

`apps/game/src/render/proceduralRings.ts` writes the strip and
`createRingMaterial` in `apps/game/src/render/planet.ts` reads it. The
character draw touches nothing in `packages/universe`: a ring system's radii,
optical depth and existence are canonical and stay exactly where they are, so
no ring moves and no version is spent. What is still open is a ring system
whose record carries more than one number — a per-ring profile, which is what
would let a normalized strip mean anything — and the multiple-scattering term
above, which wants a measurement before it wants a line of TSL.

## Related

- [ADR-0014](../../docs/adr/0014-the-record-with-holes-in-it.md) — the record
  the object panel draws, and why a stated number has to mean something
- [Art](../../docs/design/art.md) — the doctrine that settles Sol's seven
