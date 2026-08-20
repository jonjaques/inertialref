# Galaxy

Real astronomy as the substrate, procedure as the filler, and the design that
lets published data change underneath a running game without breaking it.

> This page owns [pillar 2](charter.md#pillar-2--the-sky-is-real). It also
> contains the one mechanic in this bible that no other game in the genre could
> implement, because it depends on the universe being a versioned pure function.

---

## The three-layer body model

Every object in the galaxy is exactly one of three things, and the player can
always tell which.

```mermaid
flowchart TB
    OBS["<b>Observed</b> ✅<br/>from a published catalogue<br/><i>truth, with a citation</i>"]
    PRJ["<b>Projected</b> 🟡<br/>generated from observed properties<br/><i>what the ship's computer expects</i>"]
    SUR["<b>Surveyed</b> ⬜<br/>you flew there and scanned it<br/><i>your own observation</i>"]

    OBS -->|"generation fills the gaps"| PRJ
    PRJ -->|"you go and look"| SUR
    OBS -->|"you go and look"| SUR

    style OBS fill:#0369a1,stroke:#0c4a6e,color:#fff
    style PRJ fill:#334155,stroke:#1e293b,color:#fff
    style SUR fill:#065f46,stroke:#064e3b,color:#fff
```

The distinction is not cosmetic. It is the fiction that makes procedural content
honest, and it is the mechanism that lets real data arrive later without lying to
anyone:

> **The game never claims a generated planet is real. It claims the ship's
> computer projects one, from the star's mass, luminosity and metallicity.
> Projections are drawn dashed and dimmed. When astronomy resolves one — or
> contradicts it — that is not a retcon, it is science.**

Every body carries `provenance`, and the UI shows it everywhere the body appears:

| Provenance | Drawn as | Panel shows |
|---|---|---|
| `observed` | Solid, full colour | Catalogue name, designation, source, release |
| `projected` | Dashed outline, 60% opacity | "Projected from stellar parameters — not confirmed" |
| `surveyed` | Solid, with your survey stamp | Your scan date, tick, and catalogue version |

> 🎮 Designer's Note: This is the single highest-leverage idea in the bible.
> Every procedural space game has to choose between claiming its content is real
> (dishonest, and it breaks the moment a player checks) and admitting it is fake
> (which deflates it). The third option — *it is a stated prediction, and going
> to look is the game* — turns the seam into the premise. It also means the
> project can ship with a thin catalogue and get better forever without a single
> design change.

---

## Data sources

The catalogue is an **ingest**, not a hand-transcription. Today
`packages/universe/src/catalog.ts` holds 18 hand-entered nearby stars with real
ICRS positions, parallaxes, spectral types and component counts — deliberately
shaped, as its own comment says, so that swapping the source changes nothing
downstream.

| Dataset | Provides | Scale | Licence posture |
|---|---|---|---|
| **Gaia DR3** (ESA) | Astrometry, parallax, photometry, radial velocity | ~1.8 billion sources [Source: ESA Gaia Data Release 3, June 2022] | ⛔ **CC BY-NC 3.0 IGO — non-commercial.** Verified 2026-08-19. Credit line `Credit: ESA, Gaia DPAC`. See [spike 4](../spikes.md#4--gaia-and-hyg-attribution-terms) — **this keeps Gaia out of the shipped bundle** |
| **HYG v4.4** | Merged Hipparcos + Yale + Gliese, pre-cleaned, game-sized | 119,614 rows, 109,390 with usable parallax [Source: `hyg_v44.csv`, measured] | CC BY-SA 4.0 — attribution required, share-alike reaches the packed binary |
| **NASA Exoplanet Archive** | Confirmed exoplanets, orbital elements, masses, radii | **6,336** confirmed planets; 861 within 150 ly around 550 hosts [Source: archive TAP service, read 2026-08-19 — the archive updates weekly, never hard-code it] | No licence stated. Operated by Caltech under NASA contract; **not confirmed public domain**. Use the requested acknowledgement |
| **CNS5 / Gliese** | Completeness within 25 pc | ~5,900 objects [Source: Golovin et al., *The Fifth Catalogue of Nearby Stars*, 2023] | Open, attribution |
| **Open Exoplanet Catalogue** | Cross-check, community corrections | — | MIT |

**Start with HYG.** It is the right size to ship in a browser, it is already
merged and cleaned, and it covers exactly the volume where players will spend
their first hundred hours. It is also the only one of the three whose licence is
unambiguous.

> **The dataset moved.** HYG now lives at
> [codeberg.org/astronexus/hyg](https://codeberg.org/astronexus/hyg) — the GitHub
> repository is frozen and its newest file is v4.1. Files are git-lfs pointers, so
> a plain `raw/` fetch returns a 133-byte pointer instead of data; use the
> `media/` path. The ingest should pin the URL and assert on the decompressed row
> count so this fails loudly rather than silently ingesting a pointer.

**Gaia is not a "later, larger ingest".** Its licence forbids commercial use,
which is a restriction this project deliberately chose not to carry — see
[sustainability](sustainability.md#data-licensing-is-the-constraint-that-bites).
Until ESA answers a written request, Gaia is a source the ingest may *consult* for
verification, not one it ships.

### The horizon of knowledge

Gaia's completeness falls off with distance. Within ~25 parsecs the catalogue is
close to complete; at a few kiloparsecs it holds only the intrinsically bright,
and the great majority of the Milky Way's estimated 100–400 billion stars
[Source: standard estimates; see NASA/ESA Milky Way summaries] has never been
individually catalogued by anyone.

**The galaxy map draws that boundary.** A visible, irregular shell — the surface
beyond which everything is projection. Inside it, the sky is a record. Outside
it, the sky is a hypothesis.

And it **moves outward** as astronomy improves. A player who returns after a
Gaia data release watches the frontier of human knowledge expand around them.
That is not a feature anybody has to build twice; it is the same ingest pipeline,
rendering its own coverage.

---

## Catalogue revisions

The hard problem the whole three-layer model exists to solve.

**The problem.** Generation is a pure function of seed and address, which is what
makes the universe reproducible, streamable and 696 bytes to save. But the
catalogue is an *input* to generation, and the catalogue changes. A star with no
known planets today may have three confirmed next year. If that shifts every
generated body around it, then every save, every Almanac entry and every
discovery record referring to those bodies is silently wrong.

### The four rules

**Rule 1 — the catalogue version is an explicit generation input.**

```
bodies(system, seed, catalogueVersion) → BodyManifest
```

Same seed and same catalogue version produce the same universe, forever, on any
machine, offline. Determinism is completely preserved; it simply now has two
inputs instead of one. `packages/procedural` already versions generation
algorithms through `algorithm()` and `manifest()` — the catalogue version joins
that manifest and rides the same machinery.

**Rule 2 — address indices are issue ordinals, not orbital ordinals.**

This is the load-bearing change and it now has one:
[ADR-0009](../adr/0009-issue-ordinal-addressing.md). Today `b:2` reads as
"the third planet". It must instead read as "the third body ever issued in this
system", with orbital order computed for display. Then a newly confirmed planet
interior to everything else takes the *next free index* rather than index 0, and
nothing renumbers.

```
g:milky-way/s:HIP71683/b:2      ← always this body, forever, whatever its orbit
```

*Why not just sort by semi-major axis?* Because then confirming a hot Jupiter
inside every known orbit shifts every index in the system by one, and every save
in existence now points at the wrong world. An orbital ordinal is derived data
wearing an identity's clothes. See
[ADR-0004](../adr/0004-entity-addressing.md), whose first stated property —
addresses derive from containment, never from order — this rule extends to
containment order itself.

**Rule 3 — the body manifest is append-only. Retirement is a tombstone.**

```
{ index: 4, provenance: 'projected', status: 'retired',
  retiredIn: 'hyg-4.2', supersededBy: 6 }
```

A retired body stops being generated and stops being rendered. Its address
remains valid, resolvable and meaningful forever. Saves that reference it load.
Almanac entries that describe it still describe something.

**Rule 4 — projections yield to observations, never the reverse.**

When a revision confirms a real body whose orbit overlaps a projected one, the
projection is retired and the observation is issued at a new index. Overlap is
defined generously — within a factor of 1.5 in semi-major axis — because the
point is to avoid two bodies visibly occupying the same orbit, not to be precise
about a projection that was always a guess.

### What the player sees

The mechanic. A revision is a **diegetic event**, not a patch note.

```
┌─ CATALOGUE REVISION ────────────────────────── hyg-4.1 → hyg-4.2 ─┐
│                                                                   │
│  3 systems in your Almanac are affected.                          │
│                                                                   │
│  HIP 71683 · Alpha Centauri            ▸ 1 confirmed, 1 retired   │
│    + b:6   confirmed planet, 1.07 M⊕, 0.04 AU     [observed]      │
│    − b:2   projected body retired, superseded                     │
│      your survey of 2026-09-14 is retained as a historical entry  │
│      discovery credit retained                                    │
│                                                                   │
│  HIP 8102 · Tau Ceti                   ▸ 2 confirmed              │
│  HIP 16537 · Epsilon Eridani           ▸ 1 orbit refined          │
│                                                                   │
│                              [ REVIEW ]        [ ACKNOWLEDGE ]    │
└───────────────────────────────────────────────────────────────────┘
```

**Discovery credit is never revoked.** You were the first to survey what was
believed to be there, and that remains true. The Almanac keeps the historical
entry with its catalogue version stamped on it, and adds the new body as a fresh,
unsurveyed target — which is a reason to go back.

**What this buys, for free:**

| | |
|---|---|
| Recurring content | Real astronomy publishes continuously, forever, at no cost to this project |
| A reason to revisit | A surveyed system can become unsurveyed again, honestly |
| A defence against staleness | The galaxy improves without anyone authoring anything |
| Something genuinely novel | It requires the universe to be a versioned pure function, which is precisely what milestone 1 proved |

**Resolved: continuous ingest, event-shaped delivery.**

Revisions land in the pipeline whenever astronomy publishes them, so the game is
always exactly current with the real record. But **the player receives them on
sync** — when they next dock or connect — as a single accumulated notice covering
everything that changed since their last sync. Publication is continuous;
*arrival* is an event, which is what the drama needed.

This is the harder option and it should be built knowing that. It makes every
ingest a live compatibility surface, so the [diff gate](#ingest-pipeline) between
versions is not a nicety — it is the thing standing between continuous ingest and
silently corrupting a hundred thousand saves. It needs to fail loudly on any
identity change and it needs to run on every single ingest, automatically.

**Resolved: the persistent universe runs one global catalogue version, advanced
on an announced schedule.**

Ingest stays continuous behind it. Solo modes are therefore the bleeding edge —
current with astronomy the moment it publishes — and the shared world lags on a
stable, well-tested version that everyone in it agrees on. Two players in a system
always see the same planets.

The divergence is real and worth stating plainly: a player who surveys a body in
solo may find the persistent universe has not caught up yet. Their Almanac stamps
the version, so the record stays honest, and the shared world corrects on the next
scheduled advance.

### What real data buys

Worth stating plainly, because it is easy to assume real data is merely flavour.

- **Systems are unequal, truthfully.** Sol has eight planets and hundreds of
  moons. Barnard's Star, six light-years away, has nothing confirmed. That
  variance is not a difficulty curve; it is a fact, and it makes arrival
  genuinely uncertain in a way a designed distribution never is.
- **Routes have real texture.** Class M dwarfs dominate the neighbourhood and
  scoop slowly, so the good refuelling stars are sparse and their positions are
  not negotiable.
- **Players can check.** Someone will fly to Tau Ceti, read the panel, and open
  Wikipedia. If the numbers match, the game has earned a kind of trust that no
  amount of art direction buys.
- **Multiple-star systems are real and currently simplified.** α Cen, Sirius,
  Procyon, 61 Cyg and 40 Eridani are all multiples and are modelled as single
  stars today; `components` records the truth so the simplification is visible
  rather than hidden. Binaries are a [content](content.md) item, not an
  architectural one — a binary is two bodies in one system frame.

---

## The galaxy map

⬜ **Designed, not built.**

A 3D representation of the Milky Way. Elite Dangerous's is the reference and it
is the best interface in the genre; this one has more real data to show and
should show it.

### Scale tiers

Rendering 1.8 billion stars is not possible and not desirable. Three tiers, and
the transition between them is a cross-fade, not a mode switch
([pillar 1](charter.md#pillar-1--one-continuous-space) applies to interfaces
too):

| Tier | Range | What is drawn | Source |
|---|---|---|---|
| **Local** | 0 – 150 ly | Every catalogued star individually, at true position, coloured by blackbody temperature from its real spectral class | Catalogue |
| **Regional** | 150 ly – 5 kly | Catalogued bright stars individually; the rest as a sampled point cloud | Catalogue + generated |
| **Galactic** | 5 kly – 100 kly | A density volume — arms, bar, bulge, halo | Generated |

The **horizon of knowledge** shell is drawn across all three as a translucent,
irregular boundary with a completeness readout: *"catalogue completeness at this
distance: 4%"*.

### Interactions

| Action | Input | Result |
|---|---|---|
| Orbit / pan / zoom | Drag, right-drag, wheel | Camera; the cockpit is still visible and still running behind it |
| Select system | Click a star | Info panel: real data, provenance, citation, your survey status |
| Plot route | Select destination | Route computed; see below |
| Bookmark | `B` on a selected system | Saved to a personal list, syncs online, works offline |
| Search | `/` then type | Name, designation (HIP/HD/Gliese/2MASS), or catalogue id |
| Filter | Panel, multi-select | See table below |
| Measure | Shift-click two systems | Straight-line distance and minimum jump count |

**Filters** — each one is a real data field, not a game-invented tag:

`spectral class` · `scoopable` · `has confirmed planets` · `has projected planets`
· `distance from here` · `distance from Sol` · `visited by me` · `surveyed by me` ·
`first-discovered by me` · `first-discovered by anyone` · `within jump range` ·
`within N jumps` · `binary/multiple` · `catalogue completeness`

`first-discovered by anyone` is the one that will matter most socially. Turning it
on beyond a few hundred light-years should render the map almost entirely dark,
and that darkness is the invitation.

### Route planning

Two routes, always both offered, and the difference between them is the strategy:

```
   ┌───────────────────────────────────────────────────────────────┐
   │  SOL → HIP 91262 (Vega)                          25.04 ly     │
   ├───────────────────────────────────────────────────────────────┤
   │  ⚡ FASTEST          3 jumps    11.2 t fuel    ⚠ 1 dry leg    │
   │     max-range hops; leg 2 ends at a class T dwarf             │
   │                                                               │
   │  ◆ ECONOMICAL       7 jumps     2.4 t fuel    ✓ all scoopable │
   │     threads G and K stars; 4 min longer                       │
   └───────────────────────────────────────────────────────────────┘
```

**The router is constrained by real spectral classes.** Its cost function:

```
cost(leg) = fuel(d) + λ_time · jumpTime + λ_dry · dryPenalty(destination)

Where:
  fuel(d)     = C · (M/100) · d^2.2      — see flight.md
  jumpTime    ≈ 18 s charge + tunnel + realign
  dryPenalty  = ∞ if the tank cannot reach a scoopable star from there
```

Because fuel cost is superlinear in distance (exponent 2.2) while jump *time* is
roughly constant per jump, the two routes genuinely diverge, and the choice is
real. A player with a full tank and somewhere to be takes the fast route; a
player 300 ly out takes the economical one and does not think twice.

**Hard refusal.** The router will not plot a route it cannot complete. If no
route exists, it says which leg fails and why — *"no scoopable star within 8.4 ly
of leg 4"* — rather than plotting something that strands you.

---

## The system map

⬜ **Designed, not built.**

Deliberately **abstract**, per the brief. The galaxy map is about truth; the
system map is about navigation, and navigation wants legibility over realism.

```
      HIP 71683 · Alpha Centauri A                    G2V   1.079 M☉
      ─────────────────────────────────────────────────────────────
      scan: DISCOVERY ✓   detail 3/7   surface 1/7

          ☉ ──○──────●─────────◐──────────○────────────◑
              b:0    b:1       b:3        b:4          b:2
              0.4AU  0.9AU     1.7AU      4.2AU        11.6AU
              ▲      ▲         ▲          ▲            ▲
              │      │         │          │            └ ring system
              │      │         │          └ gas giant · 3 moons
              │      │         └ ⌾ SURVEYED · landable · thin CO₂
              │      └ ● detail scanned · rocky · no atmosphere
              └ ○ projected · not confirmed

      ● observed   ○ projected   ⌾ surveyed by you   ◐ partially surveyed
```

Log-scaled distance so both a hot Jupiter at 0.04 AU and an ice giant at 30 AU
are visible at once. Selecting a body plots a burn to it and closes the map;
that is the primary path from *deciding* to *going*, and it must be one click and
under 200 ms.

| Element | Shows |
|---|---|
| Body row | Provenance, scan state, class, landability, atmosphere, moon count |
| Orbit line | Semi-major axis, log-scaled; eccentricity as line thickness |
| Gravity shading | Sphere-of-influence extent, and the capture geometry a burn has to arrive into |
| Distance / TTA | Live from the ship's current position, updating |
| Ring / belt bands | Drawn as bands, selectable as regions |

**Resolved: two tiers of the same overlay.** Both keep the cockpit running behind
them — the map is a HUD layer, never a place you go.

| Tier | For | Behaviour |
|---|---|---|
| **Compact** | Routine target selection; the common case | A strip over the lower canopy at 70% opacity. Bodies, scan state, distance. One click plots a burn and it closes. Must be under 200 ms open-to-plotted. |
| **Planning** | Long routes, multi-leg expeditions, cargo and passenger runs | Expands to fill the canopy. Full orrery, filters, route comparison, multi-leg sequencing, fuel and time projected across the whole itinerary. |

The compact tier is used hundreds of times a session and has to be instant. The
planning tier is used once per expedition and can take as long as it needs; it is
where the thinking happens.

---

## Ingest pipeline

⬜ **Designed, not built.**

Not a design question so much as a named piece of work, because it is on the
critical path for everything above.

```mermaid
flowchart LR
    RAW["raw dataset<br/>HYG csv · NASA archive"] --> NORM["normalise<br/>ICRS → galactic<br/>units → SI"]
    NORM --> RES["resolve identity<br/>HIP/HD/Gliese/2MASS<br/>→ one SystemId"]
    RES --> DIFF["diff vs previous<br/>version"]
    DIFF --> PACK["pack<br/>binary, chunked<br/>by galactic cell"]
    PACK --> SHIP["ship<br/>bundled ≤ 25 ly<br/>streamed beyond"]

    style RES fill:#7f1d1d,stroke:#450a0a,color:#fff
    style DIFF fill:#0369a1,stroke:#0c4a6e,color:#fff
```

The red box is the hard one. **Cross-catalogue identity resolution** — deciding
that HIP 71683, HD 128620, GJ 559 A and a 2MASS designation are one system — is
the step where an ingest silently corrupts itself, and it is what
[Rule 2](#the-four-rules) depends on. It gets its own tests, golden vectors, and a
manual review list for the nearest few hundred systems.

The blue box is what makes revisions possible at all: a **structured diff**
between catalogue versions is the input to the revision notice, and it must be
generated by the pipeline rather than reconstructed at runtime.

### Measured: the local tier is cheap

[Spike 3](../spikes.md#3--catalogue-bundle-size) packed HYG v4.4 into a 16-byte
record and measured it. The worry was misplaced by an order of magnitude.

| Radius | Stars | HYG rows as JSON | Packed | **+ ids + names, brotli** |
|---|---|---|---|---|
| 25 ly | 166 | 92.4 KB | 2.6 KB | **4.1 KB** |
| 50 ly | 978 | 541.8 KB | 15.3 KB | **21.1 KB** |
| 100 ly | 4,049 | 2.18 MB | 63.3 KB | **81.9 KB** |
| **150 ly** | **7,529** | 4.04 MB | 117.6 KB | **143.6 KB** |

Plus **15.2 KB brotli** for all 861 confirmed planets around 550 host systems
inside the same radius. **Total local tier: ~159 KB brotli**, against a client
that is 260 KB brotli today.

**Resolved: bundle everything to 150 ly.** No streaming boundary, no preparation
screen, no download to be honest about. The whole thing lands the cold download
around 420 KB, well inside the 4-second budget.

The record layout, because it is the whole answer:

| Bytes | Field | Note |
|---|---|---|
| 0–8 | position, 3 × int24 | 1.13 AU per step at 150 ly — four orders below the parallax error, so the quantiser is free |
| 9 | spectral class | class × subclass × giant flag |
| 10–11 | absolute magnitude, int16 ×100 | luminosity is `10^((4.85 − M)/2.5)`; **storing both is storing it twice** |
| 12–13 | colour index B−V, int16 ×1000 | `-32768` for unknown |
| 14–15 | flags, reserved | component count, has-name, provenance |

Store it **columnar, not interleaved** — the same fields structure-of-arrays
compress 7–8% better under brotli because like values sit together. And when this
does eventually stream, **50 ly cells**: 173 non-empty cells for a 150 ly sphere at
a 12% compression penalty, against 1,030 cells and a 26% penalty at 25 ly.

### Completeness is the real constraint

The number that changes the design is not the byte count:

| Volume | HYG entries | Best census | HYG coverage |
|---|---|---|---|
| 10 pc (32.6 ly) | 324 | 462 objects / 317 systems — RECONS 2018.3 | ~70% |
| 25 pc (81.5 ly) | 3,072 | 5,931 objects — CNS5, Golovin et al. 2023 | **~52%** |

CNS5 is 5,230 stars plus 701 brown dwarfs, so HYG holds about **59% of the known
stars within 25 pc and none of the brown dwarfs**. Its character also changes with
distance: the share of entries carrying a Gliese nearby-star identifier falls from
**95% at 50 ly to 80% at 100 ly to 47% at 150 ly**, and the apparent-magnitude
histogram peaks at V≈8. Inside ~50 ly HYG is volume-complete; by 150 ly it is
magnitude-limited wearing the same shape.

**This is a gift to the design, not a problem.** [The horizon of
knowledge](#the-horizon-of-knowledge) already draws the boundary between record
and hypothesis — and this says the boundary is **much closer for M dwarfs than for
bright stars**, which makes it an irregular, spectral-type-dependent surface
rather than a sphere. Drawing it as a sphere would be the kind of lie the design
has already promised not to tell. Feed the shell from actual per-class
completeness, and it becomes the most honest object in the game.

### One parsing gotcha, found the hard way

HYG spectral types are not uniform MK strings. Within 150 ly: **610 entries have
no spectral type at all**, **163 are white dwarfs** (`DA2`, `DZ`…), and roughly 200
use Yale-style prefixes (`dM4`, `sdK7`, `gK5`). A naive `spect[0]` test classifies
6,551 of 7,529 — **87%, quietly wrong about the rest**. Strip the prefix, treat
`D…` as its own class, and put a golden-vector test on the parser.

---

## Related

- [flight](flight.md#jump) — jump range and fuel, which the router consumes
- [exploration](exploration.md) — what scanning does to a projection
- [content](content.md) — what generation puts in the gaps
- [ADR-0004](../adr/0004-entity-addressing.md) — the addressing rules Rule 2 extends
- [ADR-0005](../adr/0005-procedural-seeds.md) — the seed derivation Rule 1 rides on
- [`docs/concepts/determinism.md`](../concepts/determinism.md) — why the catalogue version has to be an explicit input
