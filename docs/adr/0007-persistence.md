# ADR-0007: A save is the seed, the tick, and what could not be regenerated

Status: accepted · 2026-08-19

## Context

The universe is a pure function of (seed, address, algorithm version). Storing
any of it is storing a cache — one that goes stale the moment a generator
changes, and that is measured in terabytes if the player travels.

## Decision

```
Universe = deterministic base universe + persistent mutations
```

A save contains exactly:

- the global seed and the galaxy id,
- the simulation tick,
- the algorithm versions it was generated with,
- dynamic entities (ships), which have no address to regenerate from,
- which systems were loaded,
- `mutations` — deliberate departures from what generation would produce.

Not one planet, moon, orbit, star or heightfield. Measured: a flown session
saves in **580 bytes**, and the test asserts the file does not grow with the
size of the universe visited.

The test that matters is not that the file contains the right fields; it is that
`stateHash()` after a save/load round trip is **identical** to the hash before
it, and that both worlds stay in step when stepped a further 300 ticks.

**Loading is a pipeline of three separable stages**: parse JSON → migrate
through a chain of single-step migrations → validate against the *current*
schema. Migrations operate on raw, unvalidated data and are never typed against
the current interfaces, because a migration written against today's `SaveGame`
silently changes meaning the day that interface changes. Keeping them separate
lets the validator stay strict instead of decaying into "these fields are
probably there".

A save from a **newer** schema is refused rather than best-effort loaded: it may
contain state this build cannot represent, and silently dropping it loses a
player's progress.

Storage is behind a `SaveStore` port. The browser uses IndexedDB (localStorage
is a synchronous 5 MB box that blocks the main thread — fine for 600 bytes,
wrong the moment terrain mutations arrive); Node tests and the headless runner
use an in-memory store.

## Alternatives considered

- **Snapshot everything.** Simple, and it makes the save the source of truth —
  which throws away the entire benefit of determinism and grows without bound.
- **Store generated content lazily as a cache with the seed as the key.** A
  reasonable *optimisation* later; as a persistence model it confuses the cache
  with the record.

## Consequences

- `mutations` is empty in this milestone and its shape is provisional, but the
  field exists so that adding the first one is a migration of data rather than a
  change of model.
- Anything a save references must be regenerable from its identifier. Surface
  frames are rebuilt from their frame id, which is why the id has to determine
  the frame completely (ADR-0002).
- Control input is part of the save. It is canonical state, not a UI detail — a
  save taken mid-burn that resumed coasting is a different universe, and the
  round-trip determinism test caught exactly that.
- Changing a generation algorithm changes what an old save loads into. The
  version manifest makes that detectable; deciding what to *do* about it
  (regenerate, pin the old version, migrate content) is future work.
