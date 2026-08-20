# ADR-0001: Universe coordinates are sectorised fixed-point plus a double offset

Status: accepted · 2026-08-19

## Context

InertialRef has to represent positions from galactic distances down to
inch-scale interaction on a planetary surface. The Milky Way is roughly 1e21 m
across; an inch is 2.5e-2 m. That is about 23 orders of magnitude of dynamic
range, and every position in the game has to live somewhere in it.

The obvious representations all fail somewhere in that range:

| Representation            | Fails how                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `float64` absolute metres | 52-bit mantissa: at the galactic rim an ULP is ~100 km.                                                                                              |
| `float32` absolute metres | Useless past a few kilometres.                                                                                                                       |
| `int64` millimetres       | 2^63 mm is 0.97 ly. The galaxy needs ~100,000.                                                                                                       |
| `int64` metres            | 975 ly. Still two orders short.                                                                                                                      |
| `BigInt` / int128         | Works, but BigInt arithmetic is roughly an order of magnitude slower than double math in the inner loop of a 64 Hz simulation, and serialises badly. |

## Decision

A position is an **int32 sector index per axis plus a float64 offset in metres
within that sector**, where the sector edge is **2^40 m** (≈ 7.35 AU).

```ts
interface UniverseVector {
  sx
  sy
  sz: number // int32 sector index
  ox
  oy
  oz: number // metres, normalised into [0, 2^40)
}
```

The invariant — offsets normalised into `[0, SECTOR_SIZE)` — is maintained by
every constructor. Nothing else in the codebase may claim to be an absolute
position.

**The sector size is a power of two on purpose.** Carrying an out-of-range
offset into the sector index is then exact in IEEE-754: `o / 2^40` is an
exponent shift, `Math.floor` of it is exact, `k · 2^40` is exact, and
`o − k · 2^40` is exact by Sterbenz's lemma because the operands are within a
factor of two. Crossing a sector boundary introduces **zero** error. That is
what makes this safe to use as canonical state rather than as a rendering trick.

## Resulting numbers

| Quantity                        | Value                           |
| ------------------------------- | ------------------------------- |
| Sector edge                     | 2^40 m ≈ 1.0995e12 m ≈ 7.35 AU  |
| Addressable half-extent         | 2^71 m ≈ 2.36e21 m ≈ 249,000 ly |
| Worst-case resolution, anywhere | 2^40 × 2^-52 m ≈ 0.24 mm        |

Measured: an inch-scale displacement 8.18 kpc from the galactic centre resolves
to within 9.4 µm (capability check 7). The naive double representation cannot
resolve it at all — `8000 * PARSEC + 0.0254 === 8000 * PARSEC` is `true`.

## Alternatives considered

- **Relative-to-player coordinates.** Removes absolute identity, so two clients
  cannot agree on where anything is without a shared anchor. Rejected: it makes
  multiplayer and persistence harder for a precision benefit we do not need.
- **Frame-relative only, no absolute position.** This is the common engine
  approach. Rejected because "where is that star" then has no answer without
  walking a frame chain, and streaming needs that answer for systems that are
  not loaded (see ADR-0002).
- **Larger sectors, fewer bits of index.** A 2^50 m sector gives more range and
  ~0.25 m resolution — too coarse. A 2^30 m sector gives sub-micrometre
  resolution and only 243 ly of range.

## Consequences

- Positions are 6 numbers, JSON-serialisable, structured-cloneable, and cost
  nothing to send to a worker.
- Differences between two positions come back as an ordinary `Vec3` in metres,
  so all downstream maths is plain double arithmetic.
- The 0.24 mm floor is a hard limit. Sub-millimetre gameplay (assembling
  machinery from millimetre parts) would need a smaller sector, which costs
  range. Nothing planned needs it.
- `fromMeters` is limited by the double it is handed, not by this scheme: a
  galactic-scale literal has already lost precision before it arrives. It is
  used for placing catalogue stars, whose published positions are uncertain by
  far more, and is the wrong tool for anything else.
