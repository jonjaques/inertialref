---
paths:
  - 'packages/simulation/**'
  - 'packages/procedural/**'
  - 'packages/universe/**'
  - 'packages/spatial/**'
  - 'packages/physics/**'
---

# The canonical core — determinism and addressing

Reasoning: `AGENTS.md` § "The rules that actually matter", ADR-0001..0009.

- **Never put an absolute position in a `Vec3`.** `UniverseVector` is the only type that
  may claim to be an absolute position; a `Vec3` is a displacement or a frame-local
  coordinate.
- **Never call `Math.random()`, `Date.now()` or `performance.now()` in anything
  canonical.** Generation derives from seeds, simulation from the integer tick. Wall clock
  enters at exactly one call: `clock.plan`, which `World.advance` hands the frame's
  delta. `clock.settle` takes a count of ticks, not a second.
- **Never make generation depend on order.** Derive the seed from the address, never draw
  from a shared stream. If generating a different object first changes this one's output,
  it is wrong.

- **Never hold an algorithm version because the draw order is intact.** Order protects a
  body's _neighbors_ and says nothing about the body. `planetTilt` consumes exactly one
  gaussian, as the `Math.abs` before it did, so nothing downstream shifted in the stream —
  and 142 poles in 6,496 moved, the worst by 41°, into a manifest that still said
  `system@3`. `world.stateHash()` cannot catch it either: a landed entity's numbers are
  body-frame-relative and identical on both sides of a pole that moved. If a generated
  **value** changed, spend the version. `system@4` is that bump, and
  [ADR-0027](../../docs/adr/0027-the-rings.md) records the argument it settles.
- **Never write entity state around the world's verbs.** `world.entities` is the read
  half of the store. A ship that starts moving is spawned moving (`spawnShip` takes the
  velocity); after that, `teleport` for a discontinuous move, `setControl` /
  `setFlightAssist` / `killRotation` for input — each carries the interpolation, landed-set
  and rails bookkeeping a write needs.
- **Never assert that something is landed.** Landedness is a consequence of the contact
  test, owned by `World.#land`.
- **Never let a coasting entity keep its epoch through a move it did not make.** An
  entity with `rails` set is propagated from the epoch, not the state; every world
  method that moves one drops it, and the epoch is hashed and saved. ADR-0025.
- **Never pass a bare `Vec3` to anything that samples terrain.** The argument is a
  `BodyFixedDirection`; the only producers are `bodyFixedDirection`, `geodeticDirection`
  and `regionDirection`. Sampling in inertial axes leaves the mountains behind as the
  planet rotates — it has shipped twice.
- **Never read a field value off something chosen by rank.** A ranked distance is
  continuous; the identity holding it is not, so a property read off "the nearest" or
  "the second-nearest" is a cliff wherever the ranking changes — and that locus runs
  through a plate's interior, not along its boundary. Weight every candidate inside a
  margin, normalize, and sum (`plateProperty`), or use a lattice with no ranking in it
  (`craters.ts`). The weight reaches zero before a candidate can leave the set.
- **Never read the drawn ground where the canonical one belongs, or the reverse.**
  `groundElevation`/`surfaceRadius` are what the contact test integrates and what a save
  records; `drawnElevation`/`drawnSurfaceRadius` are that plus the presentational tail
  and are what the material and a composing camera are made from;
  `drawnGroundElevation` is the same with the sea clamp off — the seabed, which is what
  the mesh is built from under the sea's own sheet and only there: a mapped body gets
  no sheet and its mesh keeps the clamp (`HeightfieldRequest.seabed`). `drawnElevation` differs from the canonical field by at most
  `drawnDivergence` — 1.25 m — and `drawnGroundElevation` is below it by the depth of the sea. Physics reading the drawn one puts a landing
  behind a term the renderer may change; a mesh reading the canonical one draws a plane
  at two meters. ADR-0021.
- **Never persist anything regenerable.** A save stores references and mutations. If you
  want to store generated content you want a cache, and it is not a save.
- **Never make the star catalog ambient.** It is a generation input alongside the seed
  and is passed as an argument everywhere. A singleton would make the catalog _version_
  a hidden input, which invalidates every save the next time astronomy publishes.
- **Never sort a system's planets by orbit and call it order.** `b:2` is the third body
  _issued_, not the third one out. `orbitalOrder` is for display — ADR-0009.
- **Axes are right-handed, +Y up**, reference plane XZ, forward −Z. Textbook orbital
  mechanics is +Z up; `physics/frameConvention.ts` converts once, at that boundary and
  nowhere else. Units are SI — meters, seconds, kilograms, radians.
- **If you add a field to canonical state, add it to `world.stateHash()`.** The fields it
  omitted were exactly the ones a shipped bug lived in.
- **A lattice decision is never taken in a float.** The crater ladder's `'exact'` slab test
  in `craters.ts` and the per-tile frame in `terrainKernel.ts` are integers so the CPU and
  the GPU walk the same cells — `rendering.md` carries the invariant, ADR-0023 the reason.
