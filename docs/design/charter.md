# Charter

The high concept, the pillars every feature must serve, and an honest account of
who this is for and what it is up against.

> Read this and [loops](loops.md) and you have the game. Everything else in this
> directory is depth.

| Version | Date       | Author     | Changes                                    |
| ------- | ---------- | ---------- | ------------------------------------------ |
| 0.1     | 2026-08-19 | Jon Jaques | First edition, written against milestone 1 |

---

## The one sentence

> **InertialRef is a first-person spaceflight simulator set in the real Milky
> Way, in which you can fly from interstellar space to a rock you can pick up
> without crossing a single mode boundary — and it runs in a browser tab.**

## The elevator pitch

Every star you can see from the cockpit is a star that exists. The nearby ones
come from published astronomy; the rest are generated, deterministically, from a
seed — and when new astronomy is published, the generated ones politely stand
aside for the real ones. You fly a ship whose drive does not accelerate you, it
reassigns which inertial frame you are at rest in, which is why you can cross a
star system in minutes and still have to spend four of them shedding velocity
before you arrive. There are no loading screens between orbit and the ground
because there is no boundary there to load across. And the whole thing is a URL.

## Why this is worth making

Three claims, in order of how load-bearing they are:

**1. Nobody has built the continuous version.** Elite Dangerous is seamless from
orbit to surface but its planets are airless outside expansions and its galaxy is
synthetic beyond the local bubble. Star Citizen is seamless and gorgeous inside a
handful of hand-built systems and is not a galaxy at all. No Man's Sky is a
galaxy and is not real, and its planet-to-space transition is a curated wipe. The
intersection — _real astronomy, continuous scale, one body, one cockpit_ — is
empty.

**2. The hard part is already done and it is provable.** Milestone 1 was not a
graphics demo; it was twelve executable claims about precision, determinism,
addressing and frame-rate independence
([the list, with measurements](../vision.md#what-is-proven-today)). One inch
resolves to 9.4 µm at 8.18 kpc from the galactic center. Five hundred floating-origin
rebases across 2,560 km produce zero drift. The same tick count produces the same
state hash at 60 Hz, 144 Hz and 100× warp. Most projects with this ambition die
on exactly these problems, years in, when it is a rewrite rather than a
refactor.

**3. Zero install is a distribution advantage nobody in this genre has.** The
comparable titles are 100 GB downloads gated behind a store account. This is a
link. That is not a small thing for a genre whose central pleasure — _look at
this thing I found_ — is inherently social and inherently a thing you want to
send someone. A 744-byte save means a coordinate **is** the share.

> 🎮 Designer's Note: The instinct will be to fight the browser and chase Star
> Citizen's fidelity. Resist it. The browser is not the compromise this project
> tolerates in order to ship — it is the reason the project is interesting.
> Fidelity is where we will always lose. Continuity, reality, and reach are where
> we can win outright. Every scoping argument in this bible resolves that way.

---

## The four pillars

Every feature must serve at least one. A feature serving none is cut. A feature
that _violates_ one needs an ADR, not a discussion.

```mermaid
flowchart TB
    P1["<b>One Continuous Space</b><br/>no mode you can name"]
    P2["<b>The Sky Is Real</b><br/>truth first, procedure fills gaps"]
    P3["<b>Momentum Is Law</b><br/>nothing stops instantly"]
    P4["<b>You Are One Person</b><br/>one body, one viewpoint, always"]

    style P1 fill:#0369a1,stroke:#0c4a6e,color:#fff
    style P2 fill:#0e7490,stroke:#155e75,color:#fff
    style P3 fill:#065f46,stroke:#064e3b,color:#fff
    style P4 fill:#334155,stroke:#1e293b,color:#fff
```

### Pillar 1 — One Continuous Space

There is no space mode and no planet mode. A player descending from orbit passes
through half a dozen internal representation changes and must not be able to name
a single one of them. No loading screen, no fade, no cutscene, no docking
animation that hides a level swap, no "entering atmosphere" transition.

_What this forbids:_ any feature whose implementation is easiest as a separate
scene. Interiors are in the world. Stations are in the world. The galaxy map is a
HUD overlay drawn over a still-running cockpit, not a screen you go to.

_Already proven:_ frame transitions mid-flight, floating-origin rebasing, landing.
_Still required:_ LOD cross-fade and terrain geomorphing — see
[art](art.md#continuity--the-no-pop-in-specification).

### Pillar 2 — The Sky Is Real

The catalog is truth. Procedure is what we do where truth is silent, and it
**defers** when truth arrives. A star's spectral class, mass, and position come
from published data wherever published data exists, and every derived property —
luminosity, habitable zone, color on screen — follows from it physically rather
than aesthetically.

_What this forbids:_ inventing a nicer sky. If Barnard's Star is a dim red dwarf
it is a dim red dwarf in the cockpit, and if that makes for a boring system then
the boring system is the content. The interesting design work is making truth
interesting, not replacing it.

_The data is real; the image is photographed._ The canopy is a sensor, not a
window — an image composited from hull sensors with gain, integration time and a
selectable response curve. That distinction is what lets the game be as beautiful
as the cosmos actually is without falsifying a single number, because nearly
everything that would make space more beautiful is _already there_ and merely
below the threshold of human vision. See [art](art.md#the-canopy-is-a-sensor-not-a-window).

_Consequence:_ the dataset changes underneath us, permanently and forever. That is
not a bug to be managed but the source of a mechanic — see
[galaxy](galaxy.md#catalog-revisions).

### Pillar 3 — Momentum Is Law

Nothing in the game stops instantly. Not the ship, not the player, not a thrown
object. Every travel mechanic — attitude thrusters, the main burn, even the jump
— is fundamentally a problem of _shedding velocity you already have_, and the fun
is in planning that well and then executing it.

_What this forbids:_ a brake key. Arcade "space friction". A travel mode that
snaps to a stop on arrival. Autopilot that makes the problem go away rather than
solving it visibly.

_How it is expressed:_ [brachistochrone burns](flight.md#the-burn) — accelerate,
flip, decelerate. Not a throttle you correct, a plan you commit to.

_Already proven:_ 6-DoF rigid-body integration, patched-conic gravity, drag,
landing at free-fall accuracy within 0.03%.

### Pillar 4 — You Are One Person

The camera is a head. It is always a head. There is no third-person chase view,
no orbital camera, no top-down tactical layer, no unit selection, no character
sheet you visit. You see a cockpit through a visor, or a corridor through a
visor, and the interface is diegetic wherever a real instrument could plausibly
show it.

_What this forbids:_ fleet command, base-building from above, an RTS layer, an
inventory screen that pauses the world.

_Consequence:_ every system in the game needs an answer to "where is this
displayed, physically?" That constraint is what will make the cockpit good.

> 🎮 Designer's Note: Pillar 4 is the one that will be argued with most, because
> a third-person camera solves a hundred small problems cheaply — spatial
> awareness in combat, seeing your own ship, screenshots. Elite Dangerous shipped
> without one for years and its cockpit is the most-praised thing about it. The
> discipline is the product.

---

## Genre and positioning

**Primary genre:** first-person spaceflight simulator.
**Secondary:** exploration/survey sim, with first-person interaction and light
systems-RPG progression.
**Tertiary, later:** 6-DoF ship combat; scarce, lethal on-foot encounters.

Positioned in one line each:

|                     | What it is                                      | What we take                                                                                 | What we do differently                                                                                                                                              |
| ------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Elite Dangerous** | The exploration loop, perfected                 | Fuel-gated route planning, first-discovery credit, cockpit discipline, the A–E module grades | A _real_ local galaxy rather than a synthetic one; seamless atmospheric worlds as the base case; _The Expanse_-style burns instead of supercruise; no grind economy |
| **Star Citizen**    | Fidelity and continuity in a few systems        | Seamless ship interiors, physicalised interaction, first-person everything                   | Galaxy scale instead of set scale; ships in a browser tab instead of a 120 GB install; shipping instead of not                                                      |
| **No Man's Sky**    | Procedural breadth and the joy of naming things | Discovery-as-reward, generation as content, planetary variety                                | Real astronomy underneath, real orbital mechanics, real momentum                                                                                                    |

The positioning sentence, for external use:

> _Elite Dangerous's exploration loop, run on real astronomy, seamless all the way
> down to your hands, in a browser tab._

See [competitive](competitive.md) for the full analysis.

---

## Audience

**Primary — the survey pilot.** 25–50, plays Elite Dangerous, Kerbal Space
Program, Microsoft Flight Simulator, Outer Wilds. Reads a Wikipedia article about
a star after visiting it. Owns a HOTAS or wants an excuse to. Values _knowing
where they are_ more than winning. Will spend an hour flying somewhere quiet and
call it a good evening.

**Secondary — the technically curious.** Developers, astronomy hobbyists, and
people who will open the console and type `ir.help()`. The open-source posture and
the harness are aimed squarely at them, and they are also the contributor pool —
see [sustainability](sustainability.md).

**Explicitly not the target:** players who want a match to start, a lobby, a
score, or a session that resolves in ten minutes. Nothing in this design is
optimized for them and attempts to serve them will damage pillars 3 and 4.

**Session assumption:** 45–120 minutes typical, and the design must tolerate a
30-minute session ending mid-flight. The save is 744 bytes and restores an
identical state hash, so _quit anywhere_ is already true and should be treated as
a hard requirement rather than a nicety.

---

## Business posture

Open source, non-commercial, no monetisation of any kind. No purchases, no
cosmetics, no subscription, no ads, no engagement metrics.

This is a design constraint before it is a business one, and a favorable one:
with no revenue to protect there is no reason to build a grind, a timer, or a
scarcity that exists to be relieved. Every reward in this game can be given for
the reason it should be given — because the player did something interesting.
See [sustainability](sustainability.md) for governance, licensing, and the real
cost question, which is hosting the persistent universe.

---

## At a glance

|                                                                                   |                                                                                              |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Working title**                                                                 | InertialRef (engine and game share the name) *(Resolved: engine and game share the name. The |
| [Reference Drive](flight.md#the-reference-drive) fiction makes it diegetic rather |
| than technical, and for an open-source project the engine identity is an asset.)* |
| **Genre**                                                                         | First-person spaceflight simulator / exploration sim                                         |
| **Platform**                                                                      | Browser (WebGPU); desktop wrapper considered later, not designed for                         |
| **Audience**                                                                      | 25–50, simulation-literate, hardcore-patient                                                 |
| **Modes**                                                                         | Solo offline · Solo online · Persistent universe                                             |
| **Business model**                                                                | Open source, non-commercial                                                                  |
| **Team**                                                                          | One person directing coding agents                                                           |
| **Engine**                                                                        | Custom TypeScript simulation core; Three.js today, WebGPU planned                            |
| **Current state**                                                                 | Milestone 1 complete — 12/12 capability checks pass in Node and Chrome, online and offline   |
| **Named MVP**                                                                     | **The Explorer** — see [production](production.md#the-mvp-the-explorer)                      |

---

## The honest constraints

Stated here so no page below has to relitigate them.

| Constraint                                       | Consequence for design                                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One person and coding agents                     | Every system must be _generated or simulated_, never authored by hand at volume. A feature requiring 200 hand-made assets is not a feature.                                  |
| Browser, WebGPU, ~10 W of GPU budget on a laptop | Geometric fidelity is well below Star Citizen. [art](art.md) spends the budget on light transport and HDR output instead, which is where this subject matter actually lives. |
| Non-commercial                                   | No revenue to fund servers, so [modes](modes.md) must make solo the complete experience and the persistent universe an addition.                                             |
| No content pipeline                              | Ships, stations and interiors must be procedurally assembled from parts, not modeled. See [content](content.md).                                                             |
| Real data, forever changing                      | Address stability and generation purity are non-negotiable. See [galaxy](galaxy.md).                                                                                         |

> 🎮 Designer's Note: The largest risk in this document is not technical. It is
> that the vision is a fusion of three games that cost, between them, something
> north of a billion dollars and thirty years, and this is one person. The
> mitigation is not optimism. It is [production](production.md), which names one
> shippable slice — **The Explorer** — and treats everything else as horizon.
> A bible that pretends the whole thing is one milestone is a bible that gets
> ignored by month four.

---

## Related

- [loops](loops.md) — the game in motion
- [competitive](competitive.md) — the three comparables, in detail
- [production](production.md) — the MVP and the milestones after it
- [`docs/vision.md`](../vision.md) — the platform charter this serves
