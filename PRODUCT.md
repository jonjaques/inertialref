# Product

<!-- impeccable:product-schema 1 -->

Durable product truth for InertialRef: who it is for, what it is, and what
future work must preserve. It is not a design document and holds no visual
decisions — [`docs/design/`](docs/design/) is the game design bible, and
[`DESIGN.md`](DESIGN.md) owns the visual system.

**Two interfaces, deliberately split.** One exists and one is specified. Every
section below marks which it is talking about, because confusing them is the
single most expensive mistake available here:

|        | Built today                                           | Specified, not built                                                  |
| ------ | ----------------------------------------------------- | --------------------------------------------------------------------- |
| What   | The dev dock, the flight strip, the cutscene overlay  | The cockpit HUD, the two maps, the ship panel, the almanac, the visor |
| Where  | `apps/game/src/hud/`                                  | [`docs/design/ux.md`](docs/design/ux.md)                              |
| For    | Authoring and debugging a running simulation          | Playing the game                                                      |
| Status | Scaffolding, and it says so in its own source comment | The destination                                                       |

---

## Platform

web

---

## Users

**Today, confirmed.** Two audiences actually touch an interface:

1. **The maintainer and the coding agents he directs.** The dock exists so an
   author can see what the simulation thinks is true while it runs. Legibility
   under debugging outranks polish, and every control has a harness equivalent
   so that anything doable by clicking is reproducible in a test.
2. **People sent the link.** The build is deployed at
   <https://inertialrefd.jaquers.workers.dev>. They form an impression in about
   a minute, from a first viewport, with no context and no instructions.

**Designed for, not yet reachable.** The audience the game is being built
toward, from [charter](docs/design/charter.md#audience):

- **Primary — the survey pilot.** 25–50, plays Elite Dangerous, Kerbal Space
  Program, Microsoft Flight Simulator, Outer Wilds. Reads a Wikipedia article
  about a star after visiting it. Values _knowing where they are_ more than
  winning. Will spend an hour flying somewhere quiet and call it a good evening.
- **Secondary — the technically curious.** Developers and astronomy hobbyists
  who open the console and type `ir.help()`. They are also the contributor pool.

**Explicitly not the target:** players who want a match to start, a lobby, a
score, or a session that resolves in ten minutes. Serving them damages the
momentum and single-viewpoint pillars.

**Session assumption:** 45–120 minutes typical, and the design must tolerate a
30-minute session ending mid-flight. A save is 696 bytes and restores an
identical state hash, so **quit anywhere is a hard requirement, not a nicety.**

---

## Product Purpose

A first-person spaceflight simulator set in the real Milky Way, in which you can
fly from interstellar space to a rock you can pick up **without crossing a single
mode boundary** — and it runs in a browser tab.

Every star visible from the cockpit is a star that exists. The nearby ones come
from published astronomy; the rest are generated deterministically from a seed,
and when new astronomy is published the generated ones stand aside for the real
ones. There are no loading screens between orbit and the ground because there is
no boundary there to load across.

Success at the current milestone is not a frame rate or a wishlist count. It is
that the assumptions everything else depends on are **proven executably rather
than asserted** — and they are: 12/12 capability checks pass in Node and Chrome,
online and offline.

Status is pre-alpha, single maintainer, no release, no gameplay.

---

## Positioning

> _Elite Dangerous's exploration loop, run on real astronomy, seamless all the
> way down to your hands, in a browser tab._

The mechanism a neighbouring product could not truthfully copy is the
**intersection**, which is empty today: real astronomy, continuous scale, one
body, one cockpit, zero install. Elite Dangerous is seamless but its galaxy is
synthetic beyond the local bubble. Star Citizen is seamless and gorgeous across
a handful of hand-built systems and is not a galaxy. No Man's Sky is a galaxy
and is not real.

Two supporting claims, both load-bearing:

- **The hard part is done and provable.** One inch resolves to 9.4 µm at
  8.18 kpc from the galactic center; 500 floating-origin rebases across 2,560 km
  produce zero drift; the same tick count produces the same state hash at 60 Hz,
  144 Hz and 100× warp. Projects with this ambition usually die on exactly these
  problems, years in, when they are a rewrite rather than a refactor.
- **Zero install is a distribution advantage nobody in the genre has.** The
  comparables are 100 GB downloads behind a store account. This is a link, and a
  696-byte save means **a coordinate is the share.**

Fidelity is where this project would always lose. Continuity, reality and reach
are where it can win outright, and every scoping argument resolves that way.

---

## Operating Context

**How it is driven today.** The console is a first-class interface, not a
fallback: `ir.targets()` before anything else, then `ir.goTo()`, `ir.status()`,
`ir.selfTest()`, `ir.shot()`, `ir.play()`. The same harness object drives the
headless Node runner, so a scenario that reproduces a bug in Chrome replays
without a browser. The dev dock calls the harness and nothing else.

**The seven interfaces, when the game exists.** Only two ever take over the
view; none of them stops the world. The cockpit HUD is projected on the canopy
and is always on; the system map is a 70 %-opacity overlay with the cockpit
visible behind it; the galaxy map takes the view while the ship keeps flying;
the ship panel and almanac are a physical console to the pilot's right; the
visor HUD is on the helmet; station services are terminals you walk to.

**Solo modes pause; the persistent universe does not.** Pausing is a host
decision — `apps/game` stops calling `advance(delta)` — not a branch in the
simulation core.

**Input.** Mouse and keyboard is the default and has to be _good_, not
tolerated. Gamepad is full parity. HOTAS/HOSAS is direct axis binding with no
emulation layer, via WebHID, which is **Chromium-only indefinitely** — Mozilla's
position is negative and settled, WebKit has not shipped it. The public phrasing
must therefore name the browser: "full 6-DoF axis binding with no emulation
layer, in Chrome and Edge."

**Offline is real.** A service worker caches the app; with the server stopped
the game still loads, streams terrain from its workers, and passes all twelve
checks.

**One environmental gotcha:** Chrome throttles `requestAnimationFrame` in
backgrounded tabs, so a freshly reloaded unfocused page sits at tick 0 until
clicked. That is the browser, not the clock.

---

## Capabilities and Constraints

**Rendering.** WebGPU with TSL, WebGL 2 as a retained fallback. Firefox runs
without extended-range HDR output, which it cannot do at all. Overlays are held
at standard range with `dynamic-range-limit` on a single `.hud-layer` wrapper —
without it, flying past a star pushes the HUD's own backdrop-filtered background
through the compositor at twice white and the readouts wash out at exactly the
moment they are being read. Chrome and Safari implement the property; Firefox
does not and has no extended range to need it.

**Client stack.** React + React Three Fiber on Vite 8, Tailwind 4, TypeScript
throughout, pnpm workspace. React Compiler is on. The HUD is absolutely
positioned over a canvas that fills the viewport and never scrolls.

**Core discipline.** `packages/*` carry **zero third-party runtime dependencies**
and no DOM lib — the same source runs in the browser main thread, a Web Worker
and Node. A package may depend only on strictly lower layers. Both rules are
enforced by `pnpm graph`, not documented. `pnpm check` is the gate.

**Production constraints that shape every feature.**

| Constraint                    | Consequence                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| One person plus coding agents | Every system must be generated or simulated, never hand-authored at volume. A feature needing 200 hand-made assets is not a feature. |
| Browser, ~10 W of laptop GPU  | Geometric fidelity sits well below the comparables; the budget goes to light transport and HDR output instead.                       |
| Non-commercial                | No revenue funds servers, so solo must be the complete experience and the persistent universe an addition.                           |
| No content pipeline           | Ships, stations and interiors are procedurally assembled from parts, not modeled.                                                   |
| Real data, forever changing   | Address stability and generation purity are non-negotiable.                                                                          |

**Deliberately not built, with the seam named for each** — multiplayer, n-body
gravity, hull and entity collision, terrain patch stitching, and a content
pipeline. See [roadmap](docs/roadmap.md).

**Undecided, and not to be invented.** Perf budgets are written for a 2023-class
laptop at 1920×1080 and every number recorded so far comes from an Apple M5 at
1000×760; cold load to interactive is unmeasured. The hardware half of the HOTAS
spike has never been run — no stick-and-throttle pair was available.

---

## Brand Commitments

- **Name:** InertialRef. Engine and game share it, resolved deliberately: the
  Reference Drive fiction makes it diegetic rather than technical, and for an
  open-source project the engine identity is an asset.
- **Three registers of on-screen language, never mixed in one panel.**
  **Instrument** text is monospace, uppercase, abbreviated. **Record** text is
  proportional, mixed case, precise, carrying units. **Correspondence** is
  proportional prose.
- **Truthfulness is identity, not a disclaimer.** Every body states whether it is
  `observed` or `projected`. The game never claims a generated planet is real,
  and never invents a nicer sky — if Barnard's Star is a dim red dwarf it is a
  dim red dwarf in the cockpit.
- **Open source, non-commercial, Apache-2.0.** No purchases, no cosmetics, no
  subscription, no ads, no engagement metrics. This is a design constraint before
  it is a business one: with no revenue to protect there is no reason to build a
  grind, a timer, or a scarcity that exists to be relieved.
- **Not a commitment:** the TNG title sequence, its two display faces in
  `apps/game/src/assets/fonts/`, and the cutscene director around it are a
  **demonstration** that the director and shot system work (ADR-0010). The fonts
  are placeholder and the real title sequence is unwritten. Do not treat the
  homage as identity, and do not build on it as though it were settled.

---

## Evidence on Hand

**Executable, not asserted** — `pnpm sim --self-test`, or `await ir.selfTest()`
in the browser. Twelve capability checks, each reporting a measurement rather
than a tick, run by CI on every pull request alongside `pnpm check`.

**Real data**, in `data/catalog/`: 7,123 real star systems out to 150 light-years
from HYG v4.4 converted through ICRS → galactic coordinates; 702 confirmed
exoplanets around 444 of them with published orbits, masses and radii; the eight
Solar System planets and twenty moons with measured radii, oblateness, axial
tilts, rotation periods, albedos and ring geometry, drawn from NASA and USGS
surface, elevation, cloud and ring maps.

**Attribution obligations, verified rather than assumed.** `data/catalog/` is a
derived database under **CC BY-SA 4.0**, not the Apache license that covers the
code. The NASA Exoplanet Archive's requested acknowledgement is carried. Gaia is
**deliberately unused** because ESA releases it CC BY-NC 3.0 IGO, and a
non-commercial clause is not an open source license. See `NOTICE` and
[the catalog guide](docs/guides/catalogue.md).

**Absences that future work must not fabricate.** There are no users, no
release, no testimonials, no press, no adoption numbers, and no benchmarks on
target hardware. There is no gameplay. Any claim in any of those categories
would be invented.

---

## Product Principles

1. **One continuous space.** No mode the player can name — no loading screen, no
   fade, no docking animation hiding a level swap. Any feature whose
   implementation is easiest as a separate scene is the wrong shape.
2. **Truth first; procedure fills the gaps and defers when truth arrives.** The
   interesting design work is making truth interesting, not replacing it.
3. **Momentum is law.** Nothing stops instantly. Every travel mechanic is
   fundamentally the problem of shedding velocity you already have, and no
   interface may make that problem disappear rather than showing it being solved.
4. **One body, one viewpoint.** Every interface element must answer "where is
   this displayed, physically?" An element that cannot answer is drawn on a
   surface in the world, or it does not exist.
5. **Claims are executable or they are not made.** A self-test that cannot fail
   informatively converts an unknown into a false assurance. This applies to
   product claims as much as to code.
6. **Today's instrument is scaffolding, and says so.** The dev dock is not a
   draft of the cockpit and must never be polished into one; the cockpit is
   specified separately and starts from the physical question, not from this
   layout.

---

## Accessibility & Inclusion

Specified against the future cockpit in
[ux.md](docs/design/ux.md#accessibility), and several items are load-bearing for
a game about looking at things rather than compliance boxes:

- **Contrast is the hard one.** HUD elements meet 4.5:1 against the brightest
  plausible background — which here is a star filling the canopy. That is the
  design case, not a corner case. _Whether the current dev dock meets it has
  never been measured._
- **No information by color alone.** Provenance carries a dash pattern as well
  as opacity; scan state uses glyphs. Protanopia, deuteranopia and tritanopia
  palettes.
- **Three text sizes** scaling all UI including the HUD; minimum body text 16 px
  at 1080p. Everything remappable including modifiers; a full one-handed scheme;
  no chorded inputs; no timing-critical input outside combat.
- **Motion sickness is a first-class concern.** FOV 60–110°, head-bob off by
  default, roll compensation, a global camera-shake reduction. The 180° flip
  under freefall is the highest-risk moment in the game and gets its own
  assist-flip option.
- **Reduced motion** disables the jump tunnel, the map cross-fades and HUD
  animation.
- **Exposure and HDR interact with accessibility and need care.** Flying from a
  star at display peak luminance to interstellar dark does a great deal of
  adaptation, which is genuinely uncomfortable for some players. Adaptation rate
  and range clamp default on; an HDR peak luminance cap is available; HDR output
  **must be overridable in both directions**, because auto-detection will be
  wrong for somebody on every browser.
- Audio cues that convey information — heat warning, lock warning, scan complete
  — always have a visual equivalent.
