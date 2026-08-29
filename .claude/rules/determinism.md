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
  enters at exactly one call: `clock.advance`.
- **Never make generation depend on order.** Derive the seed from the address, never draw
  from a shared stream. If generating a different object first changes this one's output,
  it is wrong.
- **Never write entity state through `world.entities.update`.** Use `teleport` for a
  discontinuous move, `setControl` / `setFlightAssist` / `killRotation` for input — those
  reset interpolation history and the landed set, and `update` does not.
- **Never assert that something is landed.** Landedness is a consequence of the contact
  test, owned by `World.#land`.
- **Never pass a bare `Vec3` to anything that samples terrain.** The argument is a
  `BodyFixedDirection`; the only producers are `bodyFixedDirection`, `geodeticDirection`
  and `regionDirection`. Sampling in inertial axes leaves the mountains behind as the
  planet rotates — it has shipped twice.
- **Never read a field value off something chosen by rank.** A ranked distance is
  continuous; the identity holding it is not, so a property read off "the nearest" or
  "the second-nearest" is a cliff wherever the ranking changes — and that locus runs
  through a plate's interior, not along its boundary. Weight every candidate inside a
  margin, normalise, and sum (`plateProperty`), or use a lattice with no ranking in it
  (`craters.ts`). The weight reaches zero before a candidate can leave the set.
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
