# ADR-0045: Generated terrain is a bounded, disposable cache

Status: accepted · 19 Sep 2026. Extends the cache option in
[ADR-0007](0007-persistence.md); saves still contain no generated terrain.

## Context

A repeated descent asks for the same heightfields across runs. The in-memory
streamer cache cannot avoid generating them after a browser reload or another
test process. A persistent cache can, provided its identity includes every
input and it can be discarded without changing the world.

A seed alone is insufficient. Surface grammar, relief, sea level and request
shape all change the result. `seabed` changes whether sampling applies the
water clamp. CPU and GPU producers agree within a measured bound, not byte for
byte, so one producer's cached tile cannot silently become the other's answer.

## Decision

**A `CachedHeightfieldSource` validates regenerable tiles through a host store;
cache failure falls back to the original source, and no cache joins a save.**

The portable wrapper lives in `packages/workers`. Its key contains the complete
encoded `SurfaceParameters`, every `HeightfieldRequest` member, a producer
namespace, the terrain algorithm version, the heightfield task version and
`HEIGHTFIELD_CACHE_REVISION`. The current CPU namespace is `cpu`; the browser's
GPU namespace includes `terrain-tsl@1`. Adding a request field therefore changes
identity without relying on a separate hand-maintained list of key fields.

Host stores index the stable input serialization by its SHA-256 digest and
retain the full signature in the payload. A read must match that full key and
its region, resolution and border. Validation also checks typed-array lengths,
finite elevations, the water field's finite-or-NaN convention, extrema and a
checksum of the payload. A malformed or corrupt entry is removed and generated
again. A digest match alone never makes a tile valid.

The revision is an explicit maintenance obligation. Bump
`HEIGHTFIELD_CACHE_REVISION` when drawn-field arithmetic, cached payload shape
or a producer implementation changes without a corresponding canonical terrain
or task-version bump. A kernel-specific namespace revision separates producer
implementations as well. Old versions can remain on disk until bounded eviction
reclaims them; they cannot match a request from the new version.

The browser uses IndexedDB database `inertialref-terrain`, separate from saves.
It defaults to 8,192 entries and 256 MiB of estimated record bytes. Tile writes,
recency metadata and eviction share one transaction. Opening a blocked database
or a stalled transaction fails after a bounded wait. Private-mode denial,
quota exhaustion and transaction errors cost regeneration, not a missing tile.

Node uses built-in SQLite in `.data/heightfields/tiles.sqlite`, with defaults
of 65,536 entries and 4 GiB of serialized payload bytes. Transactions make tile
replacement and least-recently-used eviction atomic across test processes.
Both stores update recency on reads and writes, and enforce the entry and byte
limits together. The limits account for payloads, not exact filesystem usage.

A completed source job returns its tile without awaiting the storage write.
`flush()` waits for outstanding writes. Cancellation before a read completes
prevents a miss from starting generation; cancellation during generation reaches
the original job. Clearing increments the shared store generation, drains
writes and clears storage so older in-flight requests cannot repopulate it.

## Alternatives considered

- Generated tiles in `SaveGame` would make a cache part of the player's record,
  enlarge saves and blur the boundary between generation and mutation.
- A seed-only key aliases different requests and surface records. A hash alone
  also omits the exact-input comparison required before accepting stored data.
- Sharing CPU and GPU entries hides their different arithmetic from tests and
  can change the picture after fallback. Producer namespaces preserve that
  distinction.
- An unbounded directory of one file per tile leaves eviction and concurrent
  replacement to each caller. SQLite supplies transactions and bounded storage
  without a service or external database dependency.
- Awaiting writes before delivery makes quota and disk latency terrain latency.
  Writes are opportunistic; correctness depends on generation, not retention.

## Consequences

A warm run skips field generation for valid hits while still exercising the
streamer, meshes, contact physics and canonical state. Generator tests must
continue to call generation directly; a cached descent does not prove new
arithmetic unless its revision changes or the store is cleared.

The browser and headless runner share the key and validation policy, with native
storage adapters. Diagnostics distinguish hits, misses, invalid rows, storage
errors, pending writes and retained bytes. Cache clearing is independent of
save deletion. Geometry, GPU textures and canonical simulation state are not
stored in this archive.

Storage bookkeeping and validation add work to every hit. A cold cache also
pays writes. Performance claims therefore name cold or warm state and measure
an identical descent; a cache being present is not evidence of a speedup.

### Measured CPU descent

On 19 September 2026, the Proxima Centauri b slow landing fixture takes
92.37 s of test time from an empty archive and 3.19 s in the warm repeat.
All four terrain and contact assertions pass in both runs. The warm run reports
1,246 hits, zero misses or storage errors, and 88,486,528 serialized bytes in
1,246 retained tiles. These are one cold run and one warm run of the CPU fixture,
not browser frame times or a claim about another body's working set.

A separate real-database replay verifies identical requests without another
generator call and with the same canonical state hash. The landing runs can
advance different numbers of simulation ticks while their streaming converges,
so their final hashes are not compared to one another.
