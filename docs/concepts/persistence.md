# Persistence

> **The question:** what is worth storing, when the entire universe can be
> regenerated from a seed?
> **The answer:** the seed, the tick, and the handful of things that have no
> address to regenerate from. About **600 bytes** for a flown session.
>
> Decision record: [ADR-0007](../adr/0007-persistence.md) ·
> Code: `packages/persistence/`, `packages/protocol/src/save.ts`

---

## The model

```mermaid
flowchart LR
    BASE["<b>deterministic base universe</b><br/>seed + address + algorithm version<br/><i>free, infinite, identical everywhere</i>"]
    MUT["<b>persistent mutations</b><br/>deliberate departures from<br/>what generation would produce"]
    PLUS(("+"))
    WORLD["the world the player sees"]

    BASE --> PLUS
    MUT --> PLUS
    PLUS --> WORLD

    style BASE fill:#0369a1,stroke:#0c4a6e,color:#fff
```

Storing generated content would be storing a **cache** — one that goes stale the
moment a generator changes, and that is measured in terabytes if the player
travels. So a save contains:

| Stored | Not stored |
|---|---|
| global seed, galaxy id | every planet, moon, orbit |
| simulation tick | every star |
| algorithm versions | any heightfield |
| dynamic entities (ships) | any terrain mesh |
| which systems were loaded | anything with an address |
| mutations | |

A test asserts the shape of that claim rather than trusting it: the serialised
save must be **under 2 KB** and must not contain the string `elevations`.

---

## The test that actually matters

Not "does the file have the right fields". This:

```mermaid
sequenceDiagram
    participant W as world (flown 500 ticks)
    participant S as save
    participant R as restored world

    W->>W: stateHash() → H
    W->>S: captureSave()
    S->>R: restoreSave()
    R->>R: stateHash() → H'
    Note over W,R: assert H == H'
    W->>W: runTicks(300)
    R->>R: runTicks(300)
    Note over W,R: assert hashes <b>still</b> equal
```

Round-tripping to an identical [state hash](determinism.md#determinism-in-the-simulation-not-just-generation),
and then *staying in step* when both are stepped further. The second half is
what catches state that was restored but not restored *completely*.

It caught exactly that: **control input** was missing from the save, so a save
taken mid-burn resumed coasting. The hashes matched at rest and diverged 300
ticks later. Control input is canonical state, not a UI detail.

---

## Loading is three separable stages

```mermaid
flowchart LR
    TEXT["save text"] --> PARSE["<b>parse</b><br/>JSON.parse"]
    PARSE --> MIG["<b>migrate</b><br/>v0 → v1 → … → current"]
    MIG --> VAL["<b>validate</b><br/>against the current schema"]
    VAL --> BUILD["<b>rebuild</b><br/>systems, then frames, then entities"]

    PARSE -.- E1["malformed JSON"]
    MIG -.- E2["unknown version / newer build"]
    VAL -.- E3["bad shape, with a path:<br/><code>entities[0].state.position</code>"]
    BUILD -.- E4["references a frame it cannot rebuild"]

    classDef err fill:none,stroke:none,color:#b91c1c,font-style:italic
    class E1,E2,E3,E4 err
```

Each stage fails distinguishably, and every failure is a `Result` rather than a
throw — data arriving from storage is not programmer error, and the caller must
be made to consider it.

**Migrations operate on raw, unvalidated data** and are never typed against the
current interfaces. A migration written against today's `SaveGame` silently
changes meaning the day that interface changes. Keeping them separate lets the
validator stay strict instead of decaying into "these fields are probably
there".

A save from a **newer** schema is refused, not best-effort loaded. It may
contain state this build cannot represent, and silently dropping it loses a
player's progress.

### The v0 migration exists on purpose

v0 never shipped to anyone; it was the shape the game had for about an hour. It
is kept because **a migration chain with no migrations in it is a chain nobody
has ever run**, and the first real migration should not be the first one
executed in anger.

---

## Regeneration on load

Anything a save references must be rebuildable from its identifier:

```mermaid
flowchart TB
    SAVE["save says: entity #0 is in<br/><code>sf:g:milky-way/s:SOL/b:0@0.350000,-1.100000</code>"]
    NOTEX["that frame does not exist<br/>in a fresh world"]
    PARSE["parse the id → body address + lat/lon"]
    LOAD["load the system"]
    TERR["sample terrain at the quantised direction<br/><i>deterministic, so identical</i>"]
    INSTALL["install the surface frame"]
    DONE(["ship is back on the exact same rock"])

    SAVE --> NOTEX --> PARSE --> LOAD --> TERR --> INSTALL --> DONE
    style DONE fill:#065f46,stroke:#064e3b,color:#fff
```

This is the persistence model working as intended — *store the reference,
regenerate the content* — and it is why the frame id has to determine the frame
completely. See [frames](frames.md#surface-frames-and-the-identity-trap) for the
two bugs that taught us so.

---

## Storage is a port

```mermaid
flowchart LR
    SS["<b>SaveStore</b> (interface)"] --> IDB["IndexedDB<br/><i>apps/game</i>"]
    SS --> MEM["in-memory<br/><i>tests, headless runner</i>"]
    SS -.-> FUT["a server, later"]
    style SS fill:#0369a1,stroke:#0c4a6e,color:#fff
```

IndexedDB rather than localStorage: localStorage is a synchronous 5 MB box that
blocks the main thread — fine for 600 bytes, wrong the moment terrain mutations
arrive. Starting there avoids a migration later.

Verified in Chrome: save → step 500 ticks → load → hash returns to the saved
value.

---

## Offline-first

Persistence is half of it. The other half is the **service worker** caching the
app shell — navigation is network-first (a deploy reaches an online player),
everything else same-origin is cache-first (Vite content-hashes filenames, so a
cached asset cannot be stale).

Together they mean the game needs no server at all. Demonstrated rather than
asserted: with the preview server **stopped** and `fetch()` failing, the page
loads, the game runs, terrain streams from real workers, and all twelve
capability checks pass.

There is nothing else to fetch, because content comes from the seed.

---

## What mutations will look like

The `mutations` array is empty today and its shape is provisional — but the
field exists so that adding the first one is a migration of *data* rather than a
change of *model*:

```
{ address, kind: 'discovered' | 'destroyed' | 'placed' | 'terrain', data, tick }
```

See the [roadmap](../roadmap.md#persistent-mutations).

---

## Related

- [Determinism](determinism.md) — why so little needs storing
- [Identity](identity.md) — what a save references
- [ADR-0007](../adr/0007-persistence.md) — the full decision
