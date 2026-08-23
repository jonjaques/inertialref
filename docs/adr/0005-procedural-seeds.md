# ADR-0005: Hierarchical seed derivation, never a shared stream

Status: accepted · 2026-08-19

## Context

The universe is a pure function of a global seed. It has to be generated on
demand, out of order, in an unknown number of workers, with an unknown subset
loaded — and produce the same universe every time.

The failure mode to avoid is concrete:

```ts
rng.next()
rng.next()
rng.next()
```

Inserting one planet shifts every value drawn afterwards, so adding a body to a
system silently rewrites its neighbors, and two workers generating regions in
different orders produce two different universes.

## Decision

A seed is 128 bits held as four uint32 lanes. Content is generated from
`derive(parentSeed, label)` down a path of stable labels — the address path from
ADR-0004 — and never from a shared sequential stream.

```
rootSeed("inertialref") → "g:milky-way" → "s:SOL" → "b:2" → "b:0" → "surface"
```

A region's content therefore depends only on its own address. Traversal order,
worker count, async scheduling and how much of the universe is loaded are all
irrelevant, which is asserted directly: the whole catalog is generated in
shuffled order and compared against sequential order.

**PRNG: xoshiro128\*\*.** 32-bit state, 2^128 period, expressible entirely in
`Math.imul` and shifts — which ECMAScript specifies exactly, so Chrome, a Web
Worker, Node and a future server produce identical streams. Floating-point-based
hashing does not promise that.

**Noise is stateless.** Every sample is a pure function of (seed, lattice
coordinate), because terrain patches are generated in whatever order workers
pick them up and a noise function carrying a stream would produce a different
planet depending on which way the player flew round it.

**Golden vectors.** `procedural.test.ts` pins the exact output of the root seed,
two derivations, the first four uint32s, and a noise and fBm sample. These are
not testing that the numbers are right — any stream would do — they are testing
that the numbers never change. A silent change to the PRNG regenerates every
player's universe from under their save file.

**Versioning.** Generators carry an `AlgorithmVersion`. Bumping it deliberately
produces a different universe; the save records the versions it was written
with, so "this save was made with terrain v2" is a statement the loader can act
on rather than a mystery.

## Alternatives considered

- **`Math.random` with a seeded shim.** Not reproducible across engines, and the
  global stream is the order-dependence trap by construction.
- **PCG64 / splitmix64 via BigInt.** Better statistical properties, roughly an
  order of magnitude slower, and BigInt in the terrain inner loop is not viable.
- **One RNG per system, drawn sequentially.** Order-independent _between_
  systems but not within one; adding a planet still rewrites its siblings.

## Consequences

- Derivation costs a hash per level of the path. Terrain samples derive once per
  patch, not per sample.
- Sibling labels differing by one character must produce unrelated seeds, or
  adjacent planets come out suspiciously similar. Measured: 5,000 sibling
  derivations differ by 64 of 128 bits on average, with no collisions.
- Changing a generator is a versioned, deliberate act. The golden vectors make
  an accidental change fail loudly in `pnpm test`. (There is no CI in this
  repository; `pnpm check` is the gate, run by hand.)
