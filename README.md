<div align="center">

# InertialRef

**An open-source, browser-based 6-DoF simulation of the Milky Way** — from
galactic distances down to inch-scale interaction on a planetary surface, with no
loading screens and no scale seams.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node 26+](https://img.shields.io/badge/node-26%2B-brightgreen.svg)](#prerequisites)
[![pnpm 11](https://img.shields.io/badge/pnpm-11-orange.svg)](#prerequisites)
[![12/12 capabilities](https://img.shields.io/badge/capabilities-12%2F12%20proven-success.svg)](#the-twelve-capabilities-proven)

**[Try it → inertialref.jonjaques.com](https://inertialref.jonjaques.com)**

[Quick start](#quick-start) · [What it does](#what-it-does-today) ·
[Architecture](#architecture-in-one-page) · [Development](#development) ·
[Documentation](#documentation) · [Contributing](#contributing)

</div>

---

## What this is

This repository contains the **first milestone**: a vertical architectural proof.
It is deliberately a platform first and a visual demo second — **the graphics are
primitives; the point is what is underneath them.**

The hard problems in a game at this scale are precision, determinism and
identity, and all three are solved and demonstrated here rather than asserted. You
can fly from the galactic center to a mountainside, resolve an inch, save the
whole universe in under 700 bytes, and get the same answer twice.

> **Status: pre-alpha, single maintainer, no release.** There is no gameplay yet.
> [`docs/roadmap.md`](docs/roadmap.md) says what is deliberately not built and
> where each piece will attach.

---

## Quick start

### Prerequisites

| Requirement               | Version                    | Why                                                                                                                                                                                                             |
| ------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js**               | **26 or newer**            | The headless runner executes the TypeScript sources directly through type stripping — that is how `pnpm sim` works with no build step                                                                           |
| **pnpm**                  | **11** (11.22.0 pinned)    | The lockfile is pnpm's, and `packages/*` are source-only workspace links                                                                                                                                        |
| **A browser with WebGPU** | Chrome, Edge or Safari 26+ | The client renders through `WebGPURenderer` with TSL. WebGL 2 is a retained fallback, so Firefox runs — without extended-range HDR output, which it [cannot do at all](docs/spikes.md#1--hdr-display-detection) |
| **git**                   | any                        |                                                                                                                                                                                                                 |

Nothing else. There is no native toolchain, no Python, no database, and
`packages/*` have **zero third-party runtime dependencies** — a rule the build
enforces rather than documents.

<details>
<summary><b>Getting Node 26 and pnpm</b></summary>

The version of pnpm is pinned in `package.json`'s `packageManager` field, so the
simplest path is to let Corepack read it:

```bash
corepack enable          # ships with Node; installs the pinned pnpm on first use
```

For Node itself, any version manager works. With [mise](https://mise.jdx.dev):

```bash
mise use -g node@26
```

or with nvm:

```bash
nvm install 26 && nvm use 26
```

Check both:

```bash
node --version    # v26.x or newer
pnpm --version    # 11.x
```

</details>

### Run it

```bash
git clone git@github.com:jonjaques/inertialref.git
cd inertialref
pnpm install
pnpm dev                 # → http://localhost:5173
```

One command starts both halves — Vite on 5173 and the Cloudflare Worker on 8787,
with `/api` and `/ws` proxied to it. `pnpm dev:client` and `pnpm dev:server` are
the halves if you want one without the other, and `pnpm preview` builds and then
serves the result through the real Worker, which is the closest thing to
production that runs locally.

That is the whole setup. No environment variables you have to set, no services to
start, no API keys — the universe is generated from a seed, and the game is
fully playable with the server stopped.

<details>
<summary><b>Two things this repository deliberately does not contain</b></summary>

Neither is needed to run the game, the tests or the build.

- **The cutscene's reference audio.** The scene is cut against a piece of music
  that is somebody else's; it is served from the site's own R2 bucket and pulled
  in at build time (`pnpm media:pull`), never committed. Without it the cutscene
  plays silent, which is what a fork gets and is a supported outcome rather than
  a failure. `scripts/media.mjs` has the reasoning.
- **Raw catalog downloads.** 34 MB of HYG to produce a 458 KB asset, and the
  asset is committed. `pnpm catalog:fetch` re-downloads them if you want to
  rebuild.

</details>

### First sixty seconds

Open the browser console. The whole simulation is scriptable from there:

```js
ir.help() // everything the harness can do
ir.targets() // everywhere you can go, nearest first — start here
ir.goTo('b:2') // system or body; accepts the forms a human types
await ir.selfTest() // the twelve milestone capabilities, executed
await ir.scenario('surface') // land on the first solid world
ir.status() // full structured state
```

**Start with `ir.targets()`** — every other verb takes an address and none of them
will tell you one. The same verbs are on the author's instruments, opened from
the IR menu at the bottom center, so anything you can do by clicking is
reproducible in a test.

The harness object also drives the headless runner, so a scenario that reproduces
a bug in Chrome can be replayed without a browser:

```bash
pnpm sim --self-test           # no browser, no DOM, no WebGL
pnpm sim --targets --goto b:2  # the same navigation, from a terminal
pnpm sim --help                # all flags
```

> **One gotcha.** Chrome throttles `requestAnimationFrame` in backgrounded tabs,
> so a freshly reloaded page that is not focused sits at tick 0 until you click
> it. That is the browser, not the clock.

---

## What it does today

- A galaxy centered on the **real galactic center**, with **7,123 real star
  systems out to 150 light-years** — HYG v4.4 converted through ICRS → galactic
  coordinates — and procedural stars filling the gap the catalog leaves.
- **702 confirmed exoplanets** around 443 of them, with their published orbits,
  masses and radii, plus the eight planets of the Solar System. Every body says
  whether it is `observed` or `projected`; the game never claims a generated
  planet is real.
- **Stars named the way people name them** — `Sirius`, `Alpha Centauri`,
  `Tau Ceti`, `61 Cygni` — with every alternate designation searchable, and one
  stable address per system whatever the catalog calls it next year.
- **The real Solar System** — eight planets and twenty moons with measured
  radii, oblateness, axial tilts, rotation periods, albedos and ring geometry,
  drawn from NASA and USGS surface, elevation, cloud and ring maps. Earth has its
  clouds, its city lights and sun-glint on its oceans; Saturn is visibly oblate
  and casts its shadow across its own rings.
- **Deterministic star systems everywhere else** — planets, moons, orbits,
  atmospheres and terrain, all a pure function of a global seed and an address.
- A debug spacecraft with **6-DoF flight**, patched-conic gravity, atmospheric
  drag, sphere-of-influence frame transitions, and landing.
- **Streamed cube-sphere terrain**, generated in a worker pool.
- **Save and load to IndexedDB in under 700 bytes**, because a save is a reference
  and not a copy.
- **Genuinely offline** — a service worker caches the app, and with the server
  stopped the game still loads, streams terrain from its workers, and passes all
  twelve capability checks.
- Six **dockable authoring panels** in the browser — `navigate`, `controls`,
  `telemetry`, `perf`, `graphics`, and `camera` — that call the harness and
  nothing else, so anything you can do by clicking is reproducible in a test.

### The twelve capabilities, proven

The first milestone had twelve things to demonstrate ([the full list, with what
each measures](docs/vision.md#what-is-proven-today)). They are **executable rather
than described** — `await ir.selfTest()` in the browser, or `pnpm sim --self-test`
in Node:

```
12/12 capabilities proven
PASS  1. Deterministic generation — Alpha Centauri identical across runs, differs by seed
PASS  2. Stable addressing — 8 bodies addressed and round-tripped
PASS  3. Astronomical distances — Sol to Alpha Centauri: 4.3650 ly
PASS  4. Movement within a system — 6.81 km under thrust in 10 s
PASS  5. Approach a planet — fell 18.74 m in 60 s at 0.0104 m/s², within 0.03% of free fall
PASS  6. Frame transitions — entered b:g:milky-way/s:SOL/b:0 after traveling 8 Mm
PASS  7. Precision near the surface — 1 inch resolved to 9.4 µm, 8.18 kpc from the galactic center
PASS  8. Meter-scale rendering — 1 m separation survives float32 at 8.18 kpc
PASS  9. Origin rebasing — 500 rebases, 2560 km of origin travel, zero drift
PASS 10. Worker task — 4225 terrain samples generated in a worker, identical to local generation
PASS 11. Save round trip — 696 bytes restored to an identical state hash
PASS 12. Frame-rate independence — identical state hash 804b2d58 at tick 513
```

CI runs this on every pull request, alongside `pnpm check`.

---

## Architecture in one page

```
UniverseVector (sector + offset)      canonical position, sub-millimeter anywhere
        ↓ reference frames             semantics of motion; identity-preserving
frame-local Vec3                       what gameplay and physics work in
        ↓ floating origin              rebased on a 1024 m grid, exactly
render space                           small numbers, float32-safe
        ↓ LOD + depth compression      angular size preserved, depth compressed
Three.js
```

Five decisions carry most of the weight:

1. **Positions are sectorized**, not doubles — an int32 sector index per axis plus
   a double offset inside a 2⁴⁰ m sector. Sub-millimeter everywhere within
   249,000 ly of the origin, and crossing a sector boundary is _exact_.
2. **Frames are not a precision mechanism**; the coordinates already are. They
   carry the semantics of motion, and re-framing provably does not move anything.
3. **Seeds derive down a path of labels**, never along a shared stream, so
   generation order, worker count and load state cannot change the universe.
4. **64 Hz fixed tick**, because 1/64 is exact in binary. Wall clock decides only
   how many steps to run.
5. **A save is a reference, not a copy**: seed, tick, and the handful of things
   that could not be regenerated.

Full reasoning, alternatives and consequences are in [`docs/adr/`](docs/adr/).

---

## Repository layout

```
apps/
  game               React + React Three Fiber client, WebGPU/TSL renderer
  headless           Node runner — no DOM, no React, no WebGL
  ingest             turns published catalogs into the packed star asset
packages/
  shared             units, invariants, structured logging          (layer 0)
  spatial            UniverseVector, frame graph, floating origin    (1)
  procedural         PRNG, hierarchical seeds, noise                 (1)
  physics            Kepler, rigid body, atmosphere, thrusters       (2)
  universe           addressing, catalog, generation, terrain      (3)
  simulation         clock, entities, flight, streaming, snapshots   (4)
  protocol           versioned, validated wire and save schemas      (4)
  workers            typed tasks, transport ports, job pool          (5)
  persistence        save/load, migrations, store port               (5)
  net                authority port, local authority                 (5)
  rendering          canonical→render bridge, LOD, terrain meshing   (5)
  devtools           inspection, capability checks, harness          (6)
data/catalog/        the packed star catalog, committed, CC BY-SA 4.0
docs/                concepts, ADRs, guides, and the design bible
scripts/             the dependency-graph checker
```

Every package below `apps/` runs unchanged in the browser main thread, a Web
Worker and Node. A package may depend only on **strictly lower layers**, and
`pnpm graph` enforces it — along with rejecting any third-party runtime dependency
in `packages/*`.

---

## Development

### Commands

| Command                       | What it does                                                            |
| ----------------------------- | ----------------------------------------------------------------------- |
| `pnpm dev`                    | Vite on :5173 **and** the Worker on :8787, in one terminal              |
| `pnpm dev:client`             | Just Vite — keeps its interactive `r` / `o` / `q` keys                  |
| `pnpm dev:server`             | Just `wrangler dev`                                                     |
| `pnpm preview`                | Build, then serve it through the real Worker on :8787                   |
| `pnpm test`                   | Vitest, Node environment only — no DOM is ever registered               |
| `pnpm typecheck`              | Five independent tsconfig projects; see below                           |
| `pnpm lint`                   | **oxlint**, not eslint (`oxlint --fix` applies autofixes)               |
| `pnpm graph`                  | Dependency layering + cycle check, and prints the graph                 |
| `pnpm brand`                  | Re-render every icon, the share card and the crawler files              |
| `pnpm build`                  | Optional media pull, `typecheck`, then `vite build`                     |
| **`pnpm check`**              | **The gate: graph → brand → format → lint → typecheck → test → build.** |
| `pnpm sim --self-test`        | Headless run plus the twelve capability checks                          |
| `pnpm vitest run <substring>` | A single test file                                                      |

**Do not report a task complete without `pnpm check` passing.** CI runs exactly
that command, so there is no separate list of CI stages to drift out of step.

### Things that will otherwise surprise you

- **There are five tsconfig projects, not one, and no project references.** They
  type-check the real environments: `tsconfig.json` covers `packages/*` with
  **no DOM lib** (the core must run in a browser, a worker, and Node),
  `apps/game/tsconfig.json` adds DOM/WebWorker/JSX, `apps/headless/tsconfig.json`
  adds Node types, plus the Worker and the catalog ingest. Why references were
  rejected is in [development](docs/guides/development.md).
- **`strict`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly` and
  `verbatimModuleSyntax` are all on.** So: no `enum`, no parameter properties,
  `import type` for type-only imports, and **local imports carry their `.ts`
  extension** — Node runs the sources directly.
- **Vite 8 with the Oxc transform, and React Compiler is on.** Do not hand-write
  `useMemo`/`useCallback` memoization. (`useMemo` for a stable Three.js object is
  a different thing and is fine.)
- **Tests live beside the code and run in plain Node.** That is the check that the
  core stays free of DOM, React and WebGL. Reach for
  [`fast-check`](https://fast-check.dev) property tests for anything mathematical —
  several real bugs here were found that way and would not have been found
  otherwise.
- `packages/*` are **source-only workspace links**. There is no build step between
  an edit and a test.

### The rules that actually matter

[AGENTS.md](AGENTS.md) is the working card. Each rule in it exists because
violating it is a rewrite later rather than a refactor — for example:

- Never put an absolute position in a `Vec3`. `UniverseVector` is the only thing
  that may claim to be one.
- Never use `Math.random()`, `Date.now()` or `performance.now()` in anything
  canonical. Wall clock enters at exactly one call.
- Never make generation depend on order. Derive a seed from the address.
- Never persist anything regenerable. If you want to store generated content, you
  want a cache, and it is not a save.

Read it before changing anything. Agents should continue in
[docs/agents/](docs/agents/README.md). Humans should continue in
[docs/](docs/README.md).

---

## Documentation

[`docs/`](docs/README.md) is the map. Voice and where each audience should look
are in [`docs/STYLE.md`](docs/STYLE.md).

|                                                   |                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| [Getting started](docs/guides/getting-started.md) | Run it, drive it, and five things to try                                 |
| [Vision and scope](docs/vision.md)                | What this is for, and the principles behind it                           |
| [Architecture](docs/architecture.md)              | The system in one sitting                                                |
| [Concepts](docs/README.md#concepts)               | How each mechanism works, and why                                        |
| [ADRs](docs/adr/README.md)                        | Twelve decisions that are expensive to reverse                           |
| [Development](docs/guides/development.md)         | Commands, toolchain, conventions                                         |
| [The harness](docs/guides/harness.md)             | The scriptable API, in full                                              |
| [Testing](docs/guides/testing.md)                 | Property tests, golden vectors, state hashes                             |
| [Extending](docs/guides/extending.md)             | Adding a body type, a task, a save field                                 |
| [Roadmap](docs/roadmap.md)                        | What is deliberately not built yet, and the seam for each                |
| [Spikes](docs/spikes.md)                          | Five questions that needed a measurement, and the numbers that came back |
| [Design bible](docs/design/README.md)             | What the game is, and why each mechanic is shaped that way               |
| [Agent handbook](docs/agents/README.md)           | How coding agents should work here                                       |
| [CONTEXT.md](CONTEXT.md)                          | Build log: what exists, what was decided, which bugs must not return     |

---

## Status and limitations

Stated plainly, because discovering these by surprise is worse than reading them:

- **Multiplayer is not implemented** and is a later phase. The seams exist
  (partition mapping, no vendor imports) and the design sketch is
  [ADR-0008](docs/adr/0008-multiplayer-partitions.md).
- **Multiple-star systems are modeled as single stars.** The catalog records
  the true component count, so the simplification is visible rather than hidden.
- **Gravity is patched-conic** — no n-body perturbation.
- **Collision is ground contact only** — no hull, no entity-to-entity.
- **Terrain patches do not stitch** across cube faces or between LOD levels yet.
- **Almost nothing is measured on the target machine.** The dev dock's perf tab
  (`P`) plots frame time, engine time, draw calls, worker queue and heap, and can
  time GPU frames properly — but every number recorded so far is from an Apple M5
  at 1000×760, not the 2023-class laptop at 1920×1080 the budgets are written
  for. Cold load to interactive is still unmeasured.
- **The graphics are primitives.** The renderer is WebGPU and TSL and the HDR
  output path is real, but what it draws is spheres, cones and boxes. Compute
  terrain, GPU-driven instancing and Bruneton atmosphere LUTs are the
  [migration's](docs/design/technical.md#the-webgpu-migration) remaining half.
- **The atmosphere is an analytic shell, not scattering.** Uniform density and a
  path length, standing in for the precomputed LUTs that
  [spike 2](docs/spikes.md#2--tsl-and-the-atmosphere-integral) made a requirement.

---

## Contributing

Contributions are welcome, and the design's shape makes some kinds much easier
than others.

1. **Read [AGENTS.md](AGENTS.md) first.** It is the working card, and its rules
   are not stylistic. The rest of the agent handbook is
   [docs/agents/](docs/agents/README.md).
2. **Read the ADR for the area you are touching.** They are short, and they exist
   because those decisions are expensive to reverse.
3. **Find the test that covers the behavior you are changing.** If there is not
   one, that is the first thing to write.
4. **`pnpm check` must be green**, and any meaningful architectural change should
   be reflected in the ADRs and in [CONTEXT.md](CONTEXT.md).

Good first areas: terrain and LOD work, physics and orbital mechanics, the
procedural generators, and anything in [`docs/spikes.md`](docs/spikes.md) marked
as still needing hardware. Harder: anything touching coordinates, determinism or
addressing — not because contributions are unwelcome there, but because the
invariants are subtle and the ADRs should be read carefully first.

There is no `CONTRIBUTING.md` or `CODE_OF_CONDUCT.md` yet; both are
[acknowledged gaps](docs/design/sustainability.md).

---

## License

**[Apache-2.0](LICENSE).**

The project is non-commercial, but it is deliberately **not** licensed with a
non-commercial clause — such a clause is not an open source license under the OSI
definition and would make the project ineligible for most package ecosystems. The
right way to be non-commercial is a genuine open license and simply not
commercializing it. The reasoning is in
[sustainability](docs/design/sustainability.md#licensing).

### Astronomical data

`data/catalog/` is a **derived database** and is not covered by the Apache
license. It is CC BY-SA 4.0. The terms were verified rather than assumed
([spike 4](docs/spikes.md#4--gaia-and-hyg-attribution-terms)):

| Source                     | Terms                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| **HYG database** v4.4      | CC BY-SA 4.0. Share-alike reaches the packed catalog, which ships as its own asset with its own notice |
| **NASA Exoplanet Archive** | No license stated; operated by Caltech under NASA contract. Its requested acknowledgment is carried   |
| **Gaia** (ESA)             | **CC BY-NC 3.0 IGO — non-commercial.** Deliberately unused, for exactly that reason                    |

Share-alike attaches to the database and not to the software that reads it —
CC BY-SA 4.0 § 4(b) says "but not its individual contents" — so Apache-2.0 on
`packages/*` and CC BY-SA 4.0 on the catalog cover different works and do not
conflict. See [`NOTICE`](NOTICE), `data/catalog/LICENSE.md`, and
[the catalog guide](docs/guides/catalogue.md).

---

<div align="center">

Built by [Jon Jaques](https://github.com/jonjaques) · Issues and discussion at
[jonjaques/inertialref](https://github.com/jonjaques/inertialref)

</div>
