# Rings: what the record still owes the strip

The ring phase landed. Its decision is
[ADR-0027](../../docs/adr/0027-the-rings.md) — a system's character is drawn
from the seed, Sol's seven mapless systems are looked up by address, `ω₀` is
0.9 with the darkening in the strip, and the axial-tilt tail is stretched so a
ring plane is not edge-on to its star for most of an orbit. Cite the ADR, not
this page.

What is left is one gap in the record and one term nobody here has measured.

---

## The record carries one number for a thing that has many

`RingSystem` is one annulus and one mean normal optical depth. The strip now
draws plateaus, divisions, shepherded ringlets, hairlines and a dust haze, and
none of that is in the record — so the object panel describes less than the
picture, and [ADR-0014](../../docs/adr/0014-the-record-with-holes-in-it.md)'s
standard, that a stated number has to mean something, is met only by putting
the profile's peak at the quoted depth.

That choice is deliberate and it is the reason the strip cannot be normalized:
alpha is a byte in [0, 1], so a profile whose peaks exceed one clamps rather
than scales. A true normalization has to divide in the material, on a uniform
the generator computes and the shader spends. **That is the shape the change
takes if the record ever carries a per-ring profile** — and until it does,
there is nothing for a normalized strip to mean.

The record would want, per ring: an inner and outer radius, an optical depth,
and whether the edge is sharp. Four numbers a few times over, which the
generator already has when it writes the strip and throws away.

`docs/design/planetarium.md` still lists ring divisions among the things the
record does not carry. That row is true of the data model and reads as though
the game has no ring divisions, which is no longer what is on screen.

## A floor under the lit face near equinox

A sheet whose star is within a few degrees of the ring plane is drawn dark,
because a flat slab lit at grazing incidence intercepts almost nothing. Saturn's
rings did go dark at the 2009 equinox — but Cassini's equinox pictures sit at a
few percent, not a few thousandths, because a real ring has thickness and
multiple scattering and a slab has neither.

A μ₀-independent term would buy it. It is not written because **it is a number
nobody here has measured**, and inventing one is how a photometric model stops
being evidence. The tilt tail was spent instead: it is a distribution the Solar
System's own eight support, two of them on their sides.

What this wants before a line of TSL: a measurement of the multiple-scattering
contribution at grazing incidence against a published Cassini figure, so the
term has a bound to be held to the way the lit/backlit crossover does in
`rings.gpu.test.ts`.

## Related

- [ADR-0027](../../docs/adr/0027-the-rings.md) — the phase that landed
- [ADR-0014](../../docs/adr/0014-the-record-with-holes-in-it.md) — why a stated
  number has to mean something
- [Art](../../docs/design/art.md) — the doctrine that settles Sol's seven
