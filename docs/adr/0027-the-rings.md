# ADR-0027: The rings — a system's character is drawn from the seed, Sol's seven are looked up, and the darkening lives in the strip

Status: accepted · 3 Sep 2026

## Context

Eight bodies in Sol carry a ring system and one of them read as having rings.
The catalog said so, the object panel said so, and the picture did not — and
the first three explanations were all wrong. The mesh is built wherever
`body.rings !== null` and drawn past the `point` tier, so nothing was culled
and no threshold on optical depth existed anywhere in the draw path. The
photometry was right, including the part that looks wrong: a thin ring is
brightest _backlit_, which is why Voyager found Jupiter's from behind. Measured
on the real adapter, face-on, over a uniform slab:

| τ    | lit    | backlit | backlit / lit |
| ---- | ------ | ------- | ------------- |
| 0.02 | 1.6e-4 | 8.6e-3  | 52.3          |
| 0.10 | 3.7e-3 | 3.8e-2  | 10.5          |
| 0.40 | 3.8e-2 | 9.8e-2  | 2.56          |
| 0.70 | 7.9e-2 | 1.1e-1  | 1.39          |
| 1.10 | 1.2e-1 | 9.7e-2  | 0.79          |

The crossover at τ ≈ 1 is the published behavior and the material reaches it on
its own, from single scattering through a slab, with no forward-scattering term
written for the purpose. The table was taken at `ω₀ = 0.6`; every row scales by
1.5 at the 0.9 decided below and no ratio moves. It was not aliasing either —
mean brightness over the annulus was flat across three orders of magnitude of
ring size, for a strip with no fine structure.

What was actually wrong is that **a generated ring system's character was its
host's kind and nothing else.** `proceduralRingStrip` branched once: an ice
giant got six to eleven dark threads, a gas giant three to five bright broad
bands. Every generated ice giant in the galaxy wore the same near-invisible
system, measuring 3.8 × 10⁻⁴ over the annulus, which is nothing. A player
crossing a hundred worlds saw two looks.

That is the wrong model everywhere but Sol. No exoplanetary ring system has
ever been photographed, so its character is exactly what the generator should
draw from the seed — the frequency docstring already made this argument one
level up, choosing one giant in six "to make them a find rather than
wallpaper," and it applies again to what a find looks like once found.

And Sol's mapless rings went through the same coin. Uranus, Neptune and
Jupiter carry no ring photograph, and neither do Haumea, Quaoar, Chariklo and
Chiron — seven bodies through a generator where a kind-lean is a probability,
which gave Uranus a two-in-five chance of a Saturn sheet on the one body whose
thirteen narrow rings are the reason the thread architecture exists at all.
Saturn is the eighth, and the only one with a photograph to bind.

## Decision

**A ring system has a character, drawn once from the seed, because a ring is
the debris of one event.** An architecture, a particle albedo and a tint, with
the host leaning the architecture rather than deciding it — a gas giant is 55%
sheet, 25% mixed, 20% threads; an ice giant 30 / 25 / 45. Albedo and tint
follow the architecture because the three share a cause: a sheet is clean
water ice and reads cream, ice or tawny near Saturn's 0.5; a thread system is
processed rubble in charcoal or rust near Uranus's 0.03, with pale blue and
slate as the rare finds.

**The profile is generated from that character.** A sheet is three to seven
plateaus with a gap beside each, a diffuse inner edge and a sharp outer one, a
grain of density waves at eighteen to sixty cycles per strip, up to two Cassini
divisions cut clean through, up to two ringlets shepherded in the gaps, and a C
ring of faint dust planetward of the first bright band three times in five. A
thread system is four to twelve hairlines, one in five paired, the outermost
dominant and densest, with a haze of dust between them half the time. Mixed is
a sheet inside and threads outside.

**Sol's seven mapless systems are looked up in a table keyed by address.** The
art doctrine settles every Sol body by what is published, so Uranus gets
thirteen charcoal threads, Neptune five in rust, Jupiter a single reddened
sheet, and the four small bodies the one or two rings their occultations found.
`proceduralRings.test.ts` holds the table to the catalog both ways — every key
is a mapless ringed body in Sol, and every such body has a key — because a
key-set test that only checked one direction could not see a swap.

**`ω₀` is 0.9, and the darkening lives in the strip.** The strip's colour
multiplies the single-scattering albedo, so at 0.6 the albedo was in the
product twice and the lit face of a τ 1 sheet sat at a sixth of its planet.
Clean water ice in the visible is 0.9; the product is then the 0.5 to 0.6
Cassini measured for the bright rings. Both the single and transmitted terms
carry it identically, so the backlit crossover does not move.

**The profile peaks at one rather than normalizing to an annulus mean**, so the
record's quoted optical depth lands on the densest band.

**The strip is mipmapped**, the way `planetTextures.ts` loads a photographed
one. Sixty cycles across 512 texels is a cycle every eight, and a ring a
hundred pixels across samples one texel in five — a moiré that crawls with the
camera. Filtering is sampler state, so no program forks and the stand-in the
pipeline was warmed with stays the one the ring binds.

**A planet's axial tilt draws a stretched tail**, because most of what makes a
generated ring system faint is where its star sits: a planet of ordinary tilt
spends most of its orbit with the star within a few degrees of the ring plane,
and the slab is honest about that. Saturn is a sight because of 26.7°; Uranus
would be at 82° if it were not charcoal. One planet in eleven now lands past
34°, up to 86°, from the same single gaussian. The Solar System's own eight
support the distribution, two of them on their sides.

**That tail spends `SYSTEM_ALGORITHM` on 4.** The reasoning that first held the
version is recorded here rather than left implicit, because it is wrong and
must not be reused: keeping the draw order protects a body's _neighbors_ and
says nothing about the body. `planetTilt` consumes exactly one gaussian, as the
plain `Math.abs` did, so nothing downstream shifts in the stream — and the angle
that comes back is different on 142 of 6,496 generated bodies, the worst by 41°.
Those are not presentation: `spinEvaluator` builds the body-fixed frame from
`axialTilt` and `rotationPeriod`, so a moved pole moves the ground terrain is
sampled on and the pose a landed entity is held against. `world.stateHash()`
cannot see it, because a landed entity's numbers are body-frame-relative and
identical on both sides.

**One bump covers every field that moved, not one bump per field.** The
hydrostatic spin floor lengthens a rotation period and `polarRadius` moves on
1,515 bodies; the second of those is presentation — `datumRadius` reads the
equatorial radius whenever `figure` is null, so the flattening reaches the
dossier and the silhouette and never the ground's datum or the contact test —
and it rides along rather than earning a number of its own. A version is what a
loader compares, and it answers one question: is the world this save was
written against the world this build generates. `system.ts` carries the
argument at the constant and [determinism](../concepts/determinism.md) carries
the rule.

## Alternatives considered

**Normalizing the strip so the record's number is an annulus mean.**
`RingSystem` calls its figure a mean normal optical depth, and the shader's
thickness is `opticalDepth · band.a`, so read literally the strip should be
scaled until its own mean is one — and a thread system, whose bands cover a few
percent of the annulus, would have each hairline carry thirty times the quoted
depth. The published numbers refuse it. Uranus is recorded at 0.5 and its ε
ring is measured at 0.5 to 2.3: the figure behaves as the main ring's depth,
not as an average over thousands of kilometers of gap. Normalizing would make
the panel's number agree with the annulus and disagree with the ring, which is
the worse of the two. It also cannot be done in the strip alone — alpha is a
byte in [0, 1], so a profile whose peaks exceed one clamps rather than scales,
and a true normalization would have to divide in the material, on a uniform the
generator computes and the shader spends. That is the shape this takes if the
record ever carries a real annulus mean.

**Untinting the rings.** They are already untinted: a mapless strip carries its
own colour and `Bodies.tsx` gives it white. Dyeing it with the body's colour is
how Uranus's charcoal threads came out cyan once. Only a photographed strip
takes the tint.

**A floor under the lit face near equinox.** A sheet whose star is within a few
degrees of the ring plane is drawn dark, because a flat slab lit at grazing
incidence intercepts almost nothing — and Saturn's rings did go dark at the
2009 equinox. What the slab lacks is the ring's own thickness and multiple
scattering, which kept Cassini's equinox pictures at a few percent rather than
a few thousandths. A μ₀-independent term would buy that, and it is not written,
because it is a number nobody here has measured. The tilt tail is spent
instead: it is a distribution with published support, where the scattering term
would be an invention.

**Keeping the kind branch and simply brightening it.** It fixes the measurement
and not the complaint. Two looks brightened are still two looks, and the
variety a player meets across a hundred worlds is the thing that was missing.

## Consequences

- A generated system spans two to three hundred times between its faintest and
  brightest. Measured over twelve seeds at τ 0.7, mean brightness over the
  annulus: the typical ice giant goes from 3.8 × 10⁻⁴ to a median 4.5 × 10⁻³ —
  twelve times brighter — and the gas giant's median rises by a third to
  8.2 × 10⁻³. `rings.gpu.test.ts` holds the spread and the photometry.
- **`system@4` invalidates every save's system references.** That is what the
  version is for, and the alternative was worse: two builds reporting `system@3`
  while placing Proxima Centauri II's pole 41° apart, with nothing at the
  handshake or in the state hash able to notice.
- The record's optical depth now means the densest band rather than an annulus
  mean. That matches the published figures and leaves `RingSystem` — one
  annulus, one number — describing less than the strip draws. A per-ring
  profile in the record is what would let a normalized strip mean anything, and
  is the open work.
- Jupiter still draws nothing, at τ = 3 × 10⁻⁶, and that is correct: it is a
  dust band no photograph from outside a spacecraft has shown, and the
  arithmetic puts it below one part in 10⁵ of the frame at every geometry.
- Sol's four giants and its four ringed small bodies keep their published
  optical depths. The character table decides what a strip looks like, never
  how thick it is.
- Mipmapping the strip costs the memory of the chain and a generation pass; it
  buys a ring that does not crawl at distance, which no amount of supersampling
  in the frame would have fixed.

## Related

- [ADR-0014](0014-the-record-with-holes-in-it.md) — the record the object panel
  draws, and why a stated number has to mean something
- [ADR-0026](0026-the-liquid.md) — the bake and the material this draws beside
- [Art](../design/art.md) — the doctrine that settles Sol by what is published
- [Determinism](../concepts/determinism.md) — why a draw that keeps its place
  in the stream can still be a version
