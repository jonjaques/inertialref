# InertialRef

An open-source, browser-based 6-DoF simulation of the Milky Way, spanning
galactic distances down to inch-scale interaction on a planetary surface.

This repository currently contains the **first milestone**: a vertical
architectural proof. It is deliberately a platform first and a visual demo
second. The graphics are primitives; the point is what is underneath them.

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

Then, in the browser console:

```js
ir.help()                    // what the harness can do
await ir.selfTest()          // the twelve milestone capabilities, executed
await ir.scenario('surface') // land on the first solid world
```

## What it does today

- A galaxy centred on the real galactic centre, with ~18 nearby stars from a
  real catalogue converted through ICRS → galactic coordinates, and procedural
  stars everywhere else.
- Deterministic star systems: planets, moons, orbits, atmospheres and terrain,
  all a pure function of a global seed and an address.
- A debug spacecraft with 6-DoF flight, patched-conic gravity, atmospheric drag,
  sphere-of-influence frame transitions, and landing.
- Streamed cube-sphere terrain generated in a worker pool.
- Save and load to IndexedDB in under 700 bytes.
- Genuinely offline: a service worker caches the app, and with the server
  stopped the game still loads, streams terrain from its workers, and passes all
  twelve capability checks.
- A debug overlay and a scriptable harness that expose every part of it.

## The twelve capabilities, proven

The first milestone had twelve things to demonstrate ([the full list, with what
each measures](docs/vision.md#what-is-proven-today)). They are executable rather
than described — `await ir.selfTest()` in the browser, or
`pnpm sim --self-test` in Node. Sample output:

```
12/12 capabilities proven
PASS  1. Deterministic generation — Alpha Centauri identical across runs, differs by seed
PASS  2. Stable addressing — 8 bodies addressed and round-tripped
PASS  3. Astronomical distances — Sol to Alpha Centauri: 4.3650 ly
PASS  4. Movement within a system — 6.81 km under thrust in 10 s
PASS  5. Approach a planet — fell 18.74 m in 60 s at 0.0104 m/s², within 0.03% of free fall
PASS  6. Frame transitions — entered b:g:milky-way/s:SOL/b:0 after travelling 8 Mm
PASS  7. Precision near the surface — 1 inch resolved to 9.4 µm, 8.18 kpc from the galactic centre
PASS  8. Meter-scale rendering — 1 m separation survives float32 at 8.18 kpc
PASS  9. Origin rebasing — 500 rebases, 2560 km of origin travel, zero drift
PASS 10. Worker task — 4225 terrain samples generated in a worker, identical to local generation
PASS 11. Save round trip — 696 bytes restored to an identical state hash
PASS 12. Frame-rate independence — identical state hash 804b2d58 at tick 513
```

## Architecture in one page

```
UniverseVector (sector + offset)      canonical position, sub-millimetre anywhere
        ↓ reference frames             semantics of motion; identity-preserving
frame-local Vec3                       what gameplay and physics work in
        ↓ floating origin              rebased on a 1024 m grid, exactly
render space                           small numbers, float32-safe
        ↓ LOD + depth compression      angular size preserved, depth compressed
Three.js
```

Five decisions carry most of the weight:

1. **Positions are sectorised**, not doubles — an int32 sector index per axis
   plus a double offset inside a 2^40 m sector. Sub-millimetre everywhere in a
   249,000 ly of the origin, and crossing a sector boundary is *exact*.
2. **Frames are not a precision mechanism**; the coordinates already are. They
   carry the semantics of motion, and re-framing provably does not move
   anything.
3. **Seeds derive down a path of labels**, never along a shared stream, so
   generation order, worker count and load state cannot change the universe.
4. **64 Hz fixed tick**, because 1/64 is exact in binary. Wall clock decides
   only how many steps to run.
5. **A save is a reference, not a copy**: seed, tick, and the handful of things
   that could not be regenerated.

Full reasoning, alternatives and consequences are in [`docs/adr/`](docs/adr/).

## Layout

```
apps/game        React + React Three Fiber client
apps/headless    Node runner — no DOM, no React, no WebGL
packages/
  shared         units, invariants, structured logging          (layer 0)
  spatial        UniverseVector, frame graph, floating origin    (1)
  procedural     PRNG, hierarchical seeds, noise                 (1)
  physics        Kepler, rigid body, atmosphere, thrusters       (2)
  universe       addressing, catalogue, generation, terrain      (3)
  simulation     clock, entities, flight, streaming, snapshots   (4)
  protocol       versioned, validated wire and save schemas      (4)
  workers        typed tasks, transport ports, job pool          (5)
  persistence    save/load, migrations, store port               (5)
  rendering      canonical→render bridge, LOD, terrain meshing   (5)
  devtools       inspection, capability checks, harness          (6)
```

Every package below `apps/` runs unchanged in the browser main thread, a Web
Worker and Node. A package may only depend on strictly lower layers; `pnpm
graph` enforces it.

## Commands

```bash
pnpm dev          # vite dev server
pnpm test         # vitest, node environment only
pnpm typecheck    # three tsconfig projects
pnpm lint         # oxlint
pnpm graph        # dependency layering + cycle check
pnpm build
pnpm check        # all of the above, in order
pnpm sim --self-test         # headless run + capability checks
pnpm vitest run <substring>  # one test file
```

## Status and limitations

- Multiplayer is **not implemented** and is a later phase. The seams exist
  (partition mapping, no vendor imports) and the design sketch is ADR-0008.
- Multiple-star systems are modelled as single stars; the catalogue records the
  true component count.
- Gravity is patched-conic — no n-body perturbation.
- Collision is ground contact only: no hull, no entity-to-entity.
- Terrain patches do not stitch across cube faces or between LOD levels yet.

## Documentation

[`docs/`](docs/) is the explanatory documentation — interlinked concept pages,
diagrams and decision records.

| | |
|---|---|
| [Vision and scope](docs/vision.md) | what this is for, and the principles behind it |
| [Architecture](docs/architecture.md) | the system in one sitting |
| [Concepts](docs/README.md#concepts) | how each mechanism works, and why |
| [ADRs](docs/adr/README.md) | eight decisions that are expensive to reverse |
| [Roadmap](docs/roadmap.md) | what is deliberately not built yet |
| [Design bible](docs/design/README.md) | what the game is, and why each mechanic is shaped that way |

## Contributing

`AGENTS.md` is the working guide, for humans and coding agents alike.
`CONTEXT.md` is the build log: what exists, what was decided, what is
deliberately unfinished.

## Licence

[Apache-2.0](LICENSE).

The project is non-commercial, but it is deliberately **not** licensed with a
non-commercial clause — such a clause is not an open source licence under the OSI
definition and would make the project ineligible for most package ecosystems. The
right way to be non-commercial is a genuine open licence and simply not
commercialising it. The reasoning is in
[sustainability](docs/design/sustainability.md#licensing).

Ingested astronomical data will carry its own terms — the HYG database is CC BY-SA,
and Gaia requires attribution — and those obligations attach at ingest, which has
not happened yet.
