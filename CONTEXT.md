# CONTEXT.md — InertialRef build log

Working memory for agents. `INITIALPROMPT.md` is the spec; this file records what
actually exists, what was decided and why, and what is deliberately not done yet.
Update it when a package lands or a decision changes.

## Current state

Milestone 1 — the vertical architectural proof from `INITIALPROMPT.md` — is
**complete**: 12/12 capability checks pass in Node and in Chrome. Multiplayer is
deferred to a later phase; only the seams exist (ADR-0008).

Verified in Chrome, in **both dev and the production build**: the harness on
`window.ir`, terrain streamed from a worker pool, landing on a generated
surface, a sphere-of-influence frame transition mid-flight, and a save
round-tripping through IndexedDB to an identical state hash. With the preview
server **stopped**, the page still loads from the service worker and passes
12/12 — offline-first demonstrated rather than asserted. The browser runs
~1.25M simulation ticks/s for one entity; the headless runner does 110k ticks/s
including frame resolution.

| Package | Layer | State |
|---|---|---|
| `shared` | 0 | done — units, brands, invariants, structured logging |
| `spatial` | 1 | done — UniverseVector, frame graph, floating origin |
| `procedural` | 1 | done — PRNG, hierarchical seeds, noise, algorithm versions |
| `physics` | 2 | done — Kepler, rigid body, atmosphere, thrusters |
| `universe` | 3 | done — addressing, star catalogue, generation, terrain, frames |
| `simulation` | 4 | done — clock, entities, flight, streaming, snapshots |
| `protocol` | 4 | done — validation combinators, wire and save schemas |
| `workers` | 5 | done — typed tasks, ports, pool, four tasks |
| `persistence` | 5 | done — save/restore, migration chain, store port |
| `rendering` | 5 | done — LOD, depth compression, terrain meshing |
| `devtools` | 6 | done — inspection, twelve capability checks, harness |
| `apps/game` | — | done — React + R3F client, worker pool, IndexedDB saves |
| `apps/headless` | — | done — Node runner, 110k ticks/s, self-test in CI |

## Decisions that are expensive to reverse

Full reasoning is in `docs/adr/`. The short version:

1. **Positions are sector + offset, not doubles.** int32 sector index per axis
   plus a double offset inside a 2^40 m sector. Sub-millimetre everywhere in a
   249,000 ly cube. The power-of-two sector size makes carrying exact, so
   crossing a sector boundary adds zero error.
2. **Frames are not a precision mechanism.** The coordinates already are.
   Frames carry the semantics of motion and give rendering a local origin. A
   frame-local `Vec3` is only precise near its own frame — there is a test that
   documents that limit rather than hiding it.
3. **Seeds derive down a path of labels**, never along a shared stream. Golden
   vectors lock the PRNG output; changing them is deliberate and comes with an
   algorithm-version bump.
4. **Identity is an address**, and the address is also the seed path and the
   text form used in saves, logs and the harness.
5. **64 Hz fixed tick**, because 1/64 is exact in binary. Wall clock only
   decides how many steps to run.
6. **Orbits are analytic**, not integrated. Bodies have no interpolation error
   at any time warp, and an unloaded system can still answer where its planets
   are.
7. **Ships integrate only in non-rotating frames.** Landed ships are attached
   kinematically to a surface frame instead.
8. **Render compression keys off distance to the *surface*.** Keying off the
   centre put a planet's datum sphere 30 km from the terrain it represents.
9. **A save is a reference, not a copy** — 580 bytes for a flown session.

## Conventions worth knowing before editing

- **Axes: right-handed, +Y up.** System reference plane is XZ, forward is −Z.
  Textbook orbital mechanics is +Z up, so `physics/frameConvention.ts` converts
  once at that boundary and nowhere else.
- **SI internally.** Presentation units are branded and only exist for display.
- **Terrain is sampled in body-fixed axes.** Sampling it in inertial axes leaves
  the mountains behind as the planet rotates; this was a real bug.
- `packages/*` must run unchanged in the browser, a worker and Node. The root
  `tsconfig.json` gives them no DOM lib, which is how that is enforced.
- No TS project references: a referenced project may not disable emit. Three
  independent tsconfig projects, plus `pnpm graph` for the dependency layering.

## Commands

```bash
pnpm dev         # vite dev server (apps/game)
pnpm test        # vitest, node environment only
pnpm typecheck   # three tsconfig projects
pnpm lint        # oxlint
pnpm graph       # dependency layering + cycle check
pnpm build
pnpm check       # all of the above
pnpm vitest run <substring>   # single test file
```

## Bugs the tests found (worth not reintroducing)

Each of these was invisible in a running browser and caught by a test or by
driving the harness. They are listed because the same mistake is easy to make
again in a neighbouring system.

- Terrain sampled in **inertial** rather than body-fixed axes: mountains stood
  still while the planet rotated under them.
- **No ground contact at all**: a ship dropped from orbit flew through the
  planet. Contact must be tested after integrating, against the new position —
  at 20 km/s a tick covers 300 m.
- Moons generated **outside their planet's sphere of influence**, i.e. not
  actually bound to the planet they claimed to orbit.
- Surface frame ids were **not idempotent**: `(-1e-9).toFixed(6)` is
  `"-0.000000"`, which re-parses to `-0`, which formats as `"0.000000"`.
- The frame's geometry used unrounded angles while its id was rounded, so a
  restored landing site sat half a metre from the original.
- **Control input was not persisted**, so a save taken mid-burn resumed
  coasting.
- Terrain patches carried **radial normals**, shading a mountain range exactly
  like a smooth sphere — real relief rendered and was invisible.
- The harness host **captured `world` by reference**, so loading a save left the
  debug overlay reporting on the discarded world.
- A property test was **flaky, correctly**: depth compression is non-decreasing
  everywhere but only strictly increasing while the separation survives double
  precision.

## Known gaps

- Binary and multiple-star systems are modelled as single stars (`components`
  in the catalogue records the truth).
- No n-body perturbation; patched conics only.
- Terrain has no persistence of modifications yet (the schema anticipates it).
- Collision is ground contact only — no hull, no other entities.
