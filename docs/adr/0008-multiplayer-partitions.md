# ADR-0008: Authority partitions by star system, behind a port

Status: proposed · 2026-08-19 · **design only — multiplayer is a later phase**

## Context

Multiplayer is explicitly deferred. This ADR exists anyway, for one reason: to
make sure the simulation never grows a hidden assumption that authority is
global. Retrofitting that assumption out is a rewrite; keeping it out costs one
file and one interface.

The likely backend direction is Cloudflare Workers plus Durable Objects. The
spec is equally explicit that core simulation code must not import Cloudflare
APIs.

## Decision

**A partition is the unit of authority**, and the candidate partition is the
**star system**.

The reason is physical rather than architectural: a star system is also the unit
of gravitational coupling. Under patched conics (ADR-0002) two ships in
different systems cannot influence each other at all, so nothing has to be
reconciled across a partition boundary. Interstellar space partitions by
generation cell for the same reason.

`partitionForAddress` and `partitionForPosition` map addresses and positions to
opaque string keys. Authority follows an entity's **frame chain**, not its
address — a ship has no address at all, but a ship inside Sol belongs to Sol's
partition.

What exists today is exactly that: a mapping to opaque keys, in `universe`, with
no networking, no transport and no vendor import anywhere in the graph.

Two amendments, from a later review:

- It is no longer purely design. `partitionForPosition` is a live consumer —
  `devtools/inspect.ts` puts the partition key on every entity inspection and
  the debug overlay shows it as "authority". Being able to see which partition
  an entity would belong to, a phase before any partition exists, is the cheapest
  possible test of whether the rule makes sense.
- The frame-chain rule is implemented, but _not_ through this ADR's own API:
  `inspect.ts` scans the chain for an `s:` prefix itself rather than calling
  `partitionForAddress`. The two agree only because the frame-id grammar and the
  partition-key grammar are both `s:<system>`. That is a coincidence one rename
  away from being a bug, and it is the first thing to fix when this phase starts.
  `partitionForAddress`, `partitionsAdjacent`, `formatPartition` and
  `partitionForFlight` have no callers at all.

## Sketch, to be validated rather than assumed

```
Persistent universe
  ├── partition "s:SOL"        ← one authority, the players currently in Sol
  ├── partition "s:HIP71683"   ← another
  └── partition "c:12,-3,7"    ← interstellar space, by generation cell
```

A Durable Object per key is one plausible binding. The simulation would reach it
through an `AuthorityPort` interface — join, leave, submit intent, receive
authoritative state — with a `LocalAuthority` implementation for single-player
that is not a stub but the normal case (ADR: offline-first is the requirement,
not a mode).

Because the base universe is deterministic, an authority only has to replicate
what a client cannot derive: entity states and persistent mutations. That is the
same set a save file contains, which is not a coincidence and is worth
preserving.

## Alternatives considered

- **One authority for the whole universe.** Does not scale, and is the exact
  assumption this ADR exists to prevent.
- **Partition by spatial grid throughout.** Uniform, but cuts star systems in
  half — the one place where objects genuinely interact.
- **Partition per player (peer-to-peer).** No authority, so no way to resolve
  conflicting mutations to shared persistent state.

## Consequences

- Handoff between partitions is a real problem this defers, not solves: a ship
  crossing from Sol's authority to interstellar space needs its state migrated.
  The frame-transition machinery is the natural place for it, since it already
  handles the equivalent locally.
- `PARTITION_ENTRY_RADIUS` and the entry rule are guesses. They should be
  validated against real latency and real player density before anything is
  built on them.
- Nothing in `packages/*` imports a vendor SDK today, and `pnpm graph` will now
  notice if a future package adds one: it rejects any third-party runtime
  dependency in `packages/*` outright. When this ADR was written that sentence
  was aspirational — the check discarded every non-workspace edge before looking
  — so the rule was documented as enforced while nothing enforced it.
