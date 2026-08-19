# ADR-0004: Identity is an address, and the address is the seed path

Status: accepted · 2026-08-19

## Context

A procedurally generated universe has no database of objects to hand out ids
from. A star has to be identifiable before it is generated, after it is
unloaded, in a save file written last year, and in a network message from a
client that has never loaded it.

Identity must not derive from array ordering, memory addresses, Three.js object
ids, render lifecycle, worker scheduling or connection order — every one of
those varies between two runs that have to agree on the same universe.

## Decision

An address is a path through the containment hierarchy, written as
slash-separated typed segments:

```
g:milky-way                                        a galaxy
g:milky-way/s:HIP71683                             a star system
g:milky-way/s:HIP71683/b:2                         the third planet
g:milky-way/s:HIP71683/b:2.0                       its first moon
g:milky-way/s:HIP71683/b:2/r:3.6.12.44             a surface region
g:milky-way/s:HIP71683/b:2/r:3.6.12.44/o:7         an object in it
```

The same string is the **seed path** (ADR-0005), the save-file reference, the
log field, the debug-overlay display and the harness argument. One
representation, parsed and formatted round-trip-exactly.

Runtime entities carry an `EntityId` in one of two flavours, distinguishable at
a glance:

- `@g:milky-way/s:SOL/b:2` — a generated thing; its identity *is* its address.
- `#7` — a dynamic thing (a player ship) with no address to derive from.

Dynamic ids come from a counter stored in the save rather than a UUID: a random
id would make two replays of the same session disagree, and the counter is
exactly as unique while staying deterministic.

System ids are either a real catalogue designation (`HIP71683`) or an encoded
cell coordinate plus index (`P2s_1e_3_7`), so a procedural star's id decodes
back to the cell that generates it — resolution is one cell generation rather
than a lookup in a galaxy-wide index that would have to exist somewhere.

## Alternatives considered

- **Integer ids from a counter.** Requires a registry, which requires the
  universe to be enumerated, which it cannot be.
- **Hash of properties.** Two identical asteroids collide; changing a generator
  changes every id.
- **Separate id and address.** Two things to keep in sync, and a mapping table
  to persist. The address is already unique and already needed.

## Consequences

- Addresses are long. `g:milky-way/s:HIP71683/b:2.0` is 28 characters where an
  integer would be 4. They compress well and appear once per entity in a save.
- Bodies are addressed by *orbital index*, so changing how a system lays out its
  orbits renames its planets. That is what algorithm versioning is for
  (ADR-0005): the rename is deliberate and detectable, not silent.
- Region addresses are cube-sphere quadtree coordinates rather than lat/lon, so
  the two poles are not singularities in the one system that has to address
  every patch of ground.
- Anything that can be named can be scripted: `ir.orbit('g:milky-way/s:SOL/b:2')`
  works from the browser console, from a test, and from the headless runner.
