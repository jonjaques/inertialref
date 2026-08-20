# Competitive analysis

The three named comparables, two more that matter, and the specific gap this
project occupies.

---

## The gap, stated first

```
                    REAL ASTRONOMY
                          │
        Space Engine ●    │    ● InertialRef
        (not a game)      │      (the gap)
                          │
    ──────────────────────┼──────────────────────  SEAMLESS SCALE
                          │
          Starfield ●     │    ● Star Citizen
        (loading screens) │    ● Elite Dangerous
                          │    ● No Man's Sky
                          │
                    SYNTHETIC GALAXY
```

**Every axis of this design exists in a shipped product. The intersection does
not.** Space Engine has real astronomy and continuous scale and is a planetarium.
Elite has continuous scale and a game and a synthetic galaxy. Star Citizen has
fidelity and no galaxy. The empty quadrant is _real astronomy, continuous scale,
and a game_ — and none of the occupants can move into it without rebuilding their
foundation, because a synthetic galaxy is not something you retrofit real data
into.

---

## Star Citizen — Cloud Imperium Games, 2012–, unreleased

**What it is.** A first-person space and ground simulation at extraordinary
fidelity across a handful of hand-built star systems. Reportedly over $700M
raised and thirteen-plus years in development, still without a 1.0 release
[Source: CIG's published funding tracker at robertsspaceindustries.com/funding —
figure moves continuously; validate before external use].

**What it does better than anything.** Seamless ship interiors, physicalised
first-person interaction, and a sense of _presence_ in a machine that nothing
else matches. When it works, standing in a ship's hold while it manoeuvres is the
best thing in the genre.

**What we take.** Ship interiors as continuous space. First-person everything.
Physical interaction with objects that have mass.

**What we do differently.** Galaxy scale rather than set scale. Six hulls
assembled from parts rather than hundreds hand-modelled. A browser tab rather
than a 120 GB install. And a defined, shippable MVP.

**The lesson.** Star Citizen's scope has no floor, and it is the clearest
cautionary example available of what happens when a design document contains no
prioritisation. Every milestone in [production](production.md) exists partly to
avoid this outcome.

---

## Elite Dangerous — Frontier Developments, 2014

**What it is.** A 1:1-scale Milky Way — roughly 400 billion star systems
[Source: Frontier Developments' published figure] — with the genre's best
exploration loop and its best cockpit.

**What it does better than anything.** In-system travel pacing. Fuel-gated route
planning. First-discovery credit as a reward that has motivated a decade of play
with no material payoff. The discipline of never leaving the seat.

**What we take.** Frankly, a lot: the pip system, the
A–E module grades where D is best for explorers, first-discovery attribution, the
jump-range spread, and the shape of the galaxy map. These are solved problems and the correct move is to
take the solutions and spend the saved effort elsewhere.

**What we do differently.**

|                    | Elite                                                                       | InertialRef                                                                |
| ------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Galaxy             | Synthetic beyond the local bubble; ~150,000 real stars in a synthetic frame | Catalogue-first, procedurally filled, **and it updates as astronomy does** |
| Atmospheric worlds | Expansion content, still limited                                            | The base case                                                              |
| On foot            | _Odyssey_ — built as a shooter, to a mixed reception                        | Built as a survey and hazard layer                                         |
| Economy            | Credits, grind, engineering RNG                                             | Data only; no grind, no RNG                                                |
| Install            | ~50 GB                                                                      | A link                                                                     |
| Progression        | ~8× jump-range curve, with a long cage at the bottom                        | ~7.7×, same spread — but a steep early curve, so the cage phase is short   |

**The lesson.** Elite's most-loved system — exploration — has the least
mechanical machinery in it. Its least-loved systems are the ones with the most:
engineering RNG, grind gates, and the Odyssey shooter. Complexity is not what
made it good.

---

## No Man's Sky — Hello Games, 2016

**What it is.** A procedurally generated galaxy of roughly 18 quintillion planets
[Source: Hello Games' published figure], and one of the industry's great
redemption stories, having launched incomplete and improved continuously for
years.

**What it does better than anything.** The joy of naming things. Colour and
strangeness. A generator whose outputs surprise its own creators.

**What we take.** Discovery-as-reward. Naming as the emotional payoff. The
principle that generation _is_ content rather than a substitute for it.

**What we do differently.** Real astronomy underneath. Real orbital mechanics and
real momentum — NMS's flight is arcade by design. A genuinely continuous
planet-to-space transition rather than a curated one. And a much narrower scope:
no crafting, no base building, no farming.

**The lesson.** Two, and they point in opposite directions. Launching on a
promise you cannot verify is nearly fatal — which is why the twelve capability
checks are _executable_ rather than described. And a small team sustained a
galaxy-scale game for years through incremental generation work, which is direct
evidence that this project's shape is viable at this project's size.

---

## Space Engine — Vladimir Romanyuk, 2010–

**The most important comparable, and the one usually left off the list.**

**What it is.** A real-astronomy universe simulator: real catalogues, procedural
fill, seamless scale from intergalactic to surface. Everything this project
claims as its technical differentiator, done first and done well.

**What we take.** Proof that the approach works, and a great deal of prior art on
catalogue-plus-procedural hybridisation.

**What we do differently.** It is a **planetarium, not a game.** There is no
loop, no reward, no ship you operate as a machine, no reason to be anywhere in
particular. It also runs as a native application and has no multiplayer.

**The lesson, and it is the sharpest one here.** The technical achievement this
project is most proud of is _already fifteen years old in another product_. The
differentiator is therefore **not** "real astronomy at continuous scale" — it is
**a game built on it**. Any pitch that leads with the tech is a pitch that Space
Engine already answers. Lead with the loop.

---

## Starfield — Bethesda, 2023

**What it is.** A large first-person space RPG with over 1,000 planets, and
loading screens between essentially every context — ship to space, space to
surface, surface to interior.

**What we take.** Nothing mechanically. It is included because it is the most
recent large-budget attempt and its reception is instructive.

**The lesson.** The most consistent criticism of Starfield was the _absence_ of
continuity — that space travel was a menu and planets were disconnected boxes.
An enormous, well-funded team shipped a space game without seamlessness and the
audience noticed immediately and loudly. That is strong evidence that
[pillar 1](charter.md#pillar-1--one-continuous-space) is worth what it costs.

---

## Feature matrix

|                            | **InertialRef**      | Star Citizen | Elite Dangerous | No Man's Sky | Space Engine | Starfield |
| -------------------------- | -------------------- | ------------ | --------------- | ------------ | ------------ | --------- |
| Real star catalogue        | ✅ **and versioned** | ❌           | Partial         | ❌           | ✅           | ❌        |
| Updates with new astronomy | ✅                   | ❌           | ❌              | ❌           | Manual       | ❌        |
| Seamless orbit → surface   | ✅                   | ✅           | ✅              | Partial      | ✅           | ❌        |
| Seamless ship → on foot    | ✅                   | ✅           | Partial         | ✅           | ❌           | Partial   |
| Galaxy scale               | ✅                   | ❌           | ✅              | ✅           | ✅           | ❌        |
| Newtonian flight           | ✅                   | Partial      | ✅              | ❌           | N/A          | ❌        |
| First-person only          | ✅                   | ✅           | ✅              | ❌           | N/A          | ❌        |
| Runs in a browser          | ✅                   | ❌           | ❌              | ❌           | ❌           | ❌        |
| Playable fully offline     | ✅                   | ❌           | Partial         | ✅           | ✅           | ✅        |
| Deterministic universe     | ✅                   | ❌           | ✅              | ✅           | ✅           | ❌        |
| Open source                | ✅                   | ❌           | ❌              | ❌           | ❌           | ❌        |
| Photorealistic fidelity    | ❌                   | ✅           | Partial         | ❌           | ✅           | ✅        |
| Persistent multiplayer     | ⬜ later             | ✅           | ✅              | Partial      | ❌           | ❌        |
| Deep content breadth       | ❌                   | Partial      | ✅              | ✅           | ❌           | ✅        |
| Shipped                    | ⬜                   | ❌           | ✅              | ✅           | ✅           | ✅        |

The bottom four rows are the honest ones. **This project loses on fidelity,
breadth, and having shipped.** It wins on continuity, reality, reach, and
openness. Every strategic decision in this bible follows from reading that table
honestly.

---

## Positioning

> _Elite Dangerous's exploration loop, run on real astronomy, seamless all the way
> down to your hands, in a browser tab._

**Market gap:** there is no space simulator in a browser at any level of
seriousness, and there is no game — as opposed to a planetarium — built on real
catalogue data. The second gap is the defensible one; the first is the
distribution advantage that makes anyone look.

**Why now:** WebGPU makes browser rendering of this kind viable for the first
time; Gaia DR3 makes a real catalogue of a useful size freely available for the
first time; and a solo maintainer working with coding agents can produce
foundational systems work at a rate that was not previously possible — which is
the only reason a project of this shape is attemptable at this size.

---

## Related

- [charter](charter.md#genre-and-positioning) — the short version
- [production](production.md) — the plan that avoids the Star Citizen failure mode
- [risk](risk.md) — including the risk that Space Engine's existence deflates the pitch
