# The InertialRef design bible

What the game **is**, what the player **does**, and why each mechanic is shaped
the way it is.

> This is the design counterpart to the engineering documentation.
> [`docs/vision.md`](../vision.md) is the _charter_ — what the platform is for.
> This directory is the _game_ — what is built on top of it.
> Where the two disagree, vision.md wins and this directory is wrong.

---

## How to read this

Start with [charter](charter.md) and [loops](loops.md). Together they are about
twenty minutes and they contain the whole game in outline. Everything else is
depth on one system.

```mermaid
flowchart LR
    C["<b>charter</b><br/>what and why"] --> L["<b>loops</b><br/>what you do"]
    L --> S["<b>systems</b><br/>flight · ships · galaxy<br/>exploration · onfoot · combat"]
    S --> P["<b>presentation</b><br/>ux · art · audio · world"]
    P --> M["<b>production</b><br/>modes · technical<br/>competitive · production · risk"]

    style C fill:#0369a1,stroke:#0c4a6e,color:#fff
    style L fill:#0e7490,stroke:#155e75,color:#fff
```

> **Current version: 0.4.** All twenty-eight open design questions are resolved
> and recorded in [appendix](appendix.md#decisions-taken). **All five engineering
> spikes have now been run** ([`docs/spikes.md`](../spikes.md)) — four are closed,
> one waits on hardware — and their results are folded into the pages below. Two
> named content gaps remain. Earlier revisions: v0.3 resolved the design
> questions; v0.2 replaced the cruise throttle with
> [brachistochrone burns](flight.md#the-burn), established the
> [Canopy as a sensor rather than a window](art.md#the-canopy-is-a-sensor-not-a-window)
> with real [HDR output](art.md#hdr), and widened the jump-range spread to ~7.7×.
>
> **What v0.4 changed, in one line each:** Gaia is non-commercial and leaves the
> bundle · the catalog is 12× cheaper than estimated · TSL is free · HDR
> detection does not work and `auto` becomes a capability probe · HOTAS is a
> Chromium promise.

## Contents

### The game

| Page                          | What it settles                                                |
| ----------------------------- | -------------------------------------------------------------- |
| [charter](charter.md)         | High concept, the four pillars, positioning, audience          |
| [loops](loops.md)             | The micro, macro and meta loops, and what brings a player back |
| [progression](progression.md) | The three ratchets, and why there is no XP bar                 |

### Systems

| Page                          | What it settles                                           |
| ----------------------------- | --------------------------------------------------------- |
| [flight](flight.md)           | The Reference Drive, the three travel regimes, fuel       |
| [ships](ships.md)             | Hulls, modules, power, heat, damage, targeting            |
| [galaxy](galaxy.md)           | Real data, catalog revisions, the galaxy and system maps  |
| [exploration](exploration.md) | Scanning, discovery credit, the reward model, the economy |
| [onfoot](onfoot.md)           | The first-person layer, the suit, interaction, inventory  |
| [combat](combat.md)           | Ship combat and the deliberately scarce on-foot combat    |

### Content and presentation

| Page                  | What it settles                                                 |
| --------------------- | --------------------------------------------------------------- |
| [content](content.md) | What exists in the galaxy, in what quantity, generated how      |
| [world](world.md)     | Setting, tone, and the diegetic frame that holds it together    |
| [ux](ux.md)           | The shell and routes, cockpit, HUD, the two maps, accessibility |
| [art](art.md)         | The photorealism doctrine and the LOD continuity specification  |
| [audio](audio.md)     | Music, effects, and the problem of silence                      |

### Production

| Page                                | What it settles                                          |
| ----------------------------------- | -------------------------------------------------------- |
| [modes](modes.md)                   | Solo offline, solo online, persistent universe           |
| [planetarium](planetarium.md)       | Free navigation of the galaxy — the mode with no ship    |
| [cinema](cinema.md)                 | The player for scripted scenes, and its URL contract     |
| [technical](technical.md)           | WebGPU migration, performance budgets, targets           |
| [sustainability](sustainability.md) | Open source governance, contribution, funding            |
| [competitive](competitive.md)       | Star Citizen, Elite Dangerous, No Man's Sky, and the gap |
| [production](production.md)         | Milestones M2–M7 and the named MVP                       |
| [risk](risk.md)                     | The risk register                                        |
| [appendix](appendix.md)             | Glossary, open questions, revision history               |

---

## Status legend

Used throughout, matching [`docs/roadmap.md`](../roadmap.md):

✅ built and proven · 🟡 partially built · ⬜ designed, not built · ⛔ deliberately deferred

Design pages describe the **intended** system. Where something already exists in
code, the page says so and links to it. Where it does not, the page says what
seam it lands on. **A design page that cannot name its seam is speculative and
should be marked ⬜ and left alone** — the same rule
[vision.md](../vision.md#no-opaque-abstractions) applies to abstractions.

## Decisions, spikes and gaps

Design questions are resolved inline where they arise and collected in
[appendix](appendix.md#decisions-taken). The five `[OPEN QUESTION: …]` spikes that
needed a measurement rather than an opinion **have been run** — their results are
in [`docs/spikes.md`](../spikes.md) and folded into the pages that held the guess.
What remains is `[PLAYTEST: …]` values awaiting evidence, plus the hardware half
of [spike 5](../spikes.md#5--webhid-and-gamepad-for-hotas). Everything is listed
in the appendix so nothing hides in a paragraph.

## Related

- [`docs/vision.md`](../vision.md) — the charter this serves
- [`docs/architecture.md`](../architecture.md) — the system these designs run on
- [`docs/roadmap.md`](../roadmap.md) — engineering sequence; [production](production.md) is the design-facing view of the same work
- [`docs/adr/`](../adr/) — the thirteen decisions everything here assumes
- [`AGENTS.md`](../../AGENTS.md) — how to change any of it
- [`docs/agents/`](../agents/README.md) — the agent handbook
