# CONTEXT.md — InertialRef build log

Working memory for agents. `INITIALPROMPT.md` is the spec; this file records what
actually exists, what was decided and why, and what is deliberately not done yet.
Update it when a package lands or a decision changes.

## Current state

Milestone 1 (the vertical architectural proof from `INITIALPROMPT.md`) — in progress.
Multiplayer is explicitly deferred to a later phase; only the seams exist.

| Package | Layer | State |
|---|---|---|
| `shared` | 0 | done — units, brands, invariants, structured logging |
| `spatial` | 1 | done — UniverseVector, frame graph, floating origin |
| `procedural` | 1 | done — PRNG, hierarchical seeds, noise, algorithm versions |
| `physics` | 2 | done — Kepler, rigid body, atmosphere, thrusters |
| `universe` | 3 | done — addressing, star catalogue, generation, terrain, frames |
| `simulation` | 4 | done — clock, entities, flight, streaming, snapshots |
| `protocol` | 4 | pending |
| `workers` | 5 | pending |
| `persistence` | 5 | pending |
| `rendering` | 5 | pending |
| `devtools` | 6 | pending — the scriptable harness lives here |
| `apps/game` | — | pending |
| `apps/headless` | — | pending |

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

## Known gaps

- Binary and multiple-star systems are modelled as single stars (`components`
  in the catalogue records the truth).
- No n-body perturbation; patched conics only.
- Terrain has no persistence of modifications yet (the schema anticipates it).
- Collision is ground contact only — no hull, no other entities.
