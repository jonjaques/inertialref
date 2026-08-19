# Streaming

> **The question:** how is only the relevant slice of a galaxy in memory, without
> "loading screens" or a space-mode/planet-mode split?
> **The answer:** loading and unloading are ordinary methods called every so
> often, and existence is separated from being loaded.
>
> Code: `packages/simulation/src/world.ts` (`updateInterest`),
> `apps/game/src/engine/terrainStreamer.ts`

---

## Existence is not residency

Six things have to stay distinct, or streaming turns into a cache-coherency
problem. Five of them exist today:

```mermaid
flowchart TB
    EXIST["<b>universe existence</b><br/>a function of the seed<br/><i>everything, always</i>"]
    GEN["<b>generated state</b><br/>materialised on demand<br/><i>systems, bodies, patches</i>"]
    SIM["<b>simulation state</b><br/>frames installed, entities stepping"]
    REND["<b>render visibility</b><br/>in the scene this frame"]
    PERS["<b>persistent state</b><br/>mutations that survive"]
    NET["<b>network relevance</b><br/><i>deferred — see roadmap</i>"]

    EXIST --> GEN --> SIM --> REND
    EXIST --> PERS
    SIM -.-> NET

    style EXIST fill:#0369a1,stroke:#0c4a6e,color:#fff
    style NET fill:#334155,stroke:#1e293b,color:#94a3b8,stroke-dasharray: 5 5
```

An object can exist canonically — be addressable, be describable, be referenced
by a save — with no frames installed and no Three.js object anywhere. "Where is
the third planet of HIP71683?" is answerable without loading HIP71683.

---

## System streaming

```mermaid
sequenceDiagram
    participant E as engine
    participant W as World
    participant G as galaxy generator

    E->>W: updateInterest(playerPosition, 6 ly)
    W->>G: systemsWithin(centre, radius)
    G-->>W: catalogue hits + procedural cells
    loop each not-yet-loaded system
        W->>W: generateSystem(seed, stub)
        W->>W: installSystemFrames()
        Note right of W: closures, not evaluations —<br/>installing is cheap
    end
    loop each loaded system beyond 1.25 × radius
        W->>W: refuse if an entity is inside it
        W->>W: uninstallSystemFrames()
    end
```

Two details that make this safe:

- **Unloading refuses** if any entity's frame chain passes through the system.
  You cannot pull the floor out from under a ship.
- **Regeneration is exact.** Unload a system, reload it, and the JSON is
  byte-identical — asserted by a test. Unloading is therefore free of
  consequence, which is what makes it usable as an ordinary operation rather
  than a risky one.

The 1.25× hysteresis on the unload radius stops a system thrashing when the
player hovers at the boundary.

---

## Terrain streaming

The streamer is asked, every frame, what should be visible, and reconciles.

```mermaid
flowchart TB
    CAM["camera position"] --> BODY{"is a body<br/>at 'surface' LOD?"}
    BODY -->|no| CLEAR["clear everything"]
    BODY -->|yes| LEVEL["level = f(radius, altitude)<br/><i>finer as you descend</i>"]
    LEVEL --> CENTRE["region under the camera<br/><i>in body-fixed axes</i>"]
    CENTRE --> BLOCK["3×3 block around it"]
    BLOCK --> RECON{"for each wanted region"}
    RECON -->|"cached heightfield"| MESH["rebuild mesh if the<br/>origin generation changed"]
    RECON -->|"not cached"| JOB["submit a worker job<br/><i>deduplicated by key</i>"]
    JOB --> CACHE["cache the heightfield"]
    RECON --> EVICT["drop meshes nobody wants (heightfields survive until the cache passes 64)"]

    style JOB fill:#065f46,stroke:#064e3b,color:#fff
```

**What is cached, and why that split:** heightfields are cached; meshes are not.
A [floating-origin rebase](rendering.md#the-floating-origin) invalidates every
vertex position but not a single elevation sample — and the elevations are the
expensive half (14 octaves of 3D noise per sample). So a rebase rebuilds meshes
from cached noise, which is cheap.

Patch keys are `body|face.level.i.j`, so the same patch is never requested
twice concurrently, and the request set is stable while the player hovers —
meaning most frames submit nothing at all.

---

## What makes this possible at all

Streaming is only tractable because of two properties established elsewhere:

| Property | Why streaming needs it | Where |
|---|---|---|
| Content is a pure function of address | Unloading loses nothing; reloading is exact | [determinism](determinism.md) |
| Generation is order-independent | Patches can arrive from workers in any order | [determinism](determinism.md) |
| Identity exists without residency | A save can reference an unloaded system | [identity](identity.md) |
| Frames install as closures | Installing a system costs no generation | [frames](frames.md) |

Take away any one of them and streaming becomes a cache-coherency problem
instead of a memory-management one.

---

## Two things worth knowing

**No pool means no terrain.** `TerrainStreamer` returns early without one, so a
browser that cannot construct module workers gets main-thread starfield surveys
and no streamed ground at all. That is the real degradation path; there is no
inline-worker fallback in the browser.

**Rebasing is handled in one place.** A patch records the origin generation it
was built against and `#ensure` rebuilds it when that goes stale — for the ~9
patches that should be visible, and nothing else. An explicit `rebuild()` used to
run alongside it from the frame loop, walking the whole 64-entry heightfield
cache and re-adding patches `update()` had just pruned: a frame of off-screen
geometry uploads on every rebase, which is every 4096 m of camera travel. It is
gone.

---

## Current limits

| Limit | Consequence | Roadmap |
|---|---|---|
| Interest is a radius scan over generation cells | Fine at 6 ly; a spatial index is needed for large radii | [roadmap](../roadmap.md#streaming-and-scale) |
| Terrain is a 3×3 block at a single level | No mixed-resolution quadtree, so the horizon is limited | [roadmap](../roadmap.md#terrain) |
| Patches do not stitch across faces or levels | Hairline seams at boundaries | [roadmap](../roadmap.md#terrain) |
| No prediction of where the player is going | Patches pop in rather than pre-loading | [roadmap](../roadmap.md#streaming-and-scale) |

---

## Related

- [Determinism](determinism.md) · [Identity](identity.md) · [Workers](workers.md)
- [Rendering](rendering.md#terrain-meshing) — what happens to a heightfield
