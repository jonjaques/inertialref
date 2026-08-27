# Streaming

> **The question:** how is only the relevant slice of a galaxy in memory, without
> "loading screens" or a space-mode/planet-mode split?
> **The answer:** loading and unloading are ordinary methods called every so
> often, and existence is separated from being loaded.
>
> Code: `packages/simulation/src/world.ts` (`updateInterest`),
> `packages/rendering/src/terrainSelect.ts`,
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
    W->>G: systemsWithin(center, radius)
    G-->>W: catalog hits + procedural cells
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
    CAM["camera position"] --> BODY{"a solid body,<br/>relief over 8 px?"}
    BODY -->|no| CLEAR["clear everything<br/><i>the sphere is the honest picture</i>"]
    BODY -->|yes| WALK["walk the quadtree from the six cube faces"]
    WALK --> REFINE{"one grid cell<br/>over 16 px?"}
    REFINE -->|"yes, and the children are cached"| WALK
    REFINE -->|no| BALANCE["restrict to a 2:1 balance<br/><i>the morph closes one level, not two</i>"]
    BALANCE --> DRAW["the draw set"]
    WALK --> AHEAD["the same walk from where<br/>the eye will be in 2 s"]
    AHEAD --> QUEUE["queue the pyramid under it,<br/>coarsest first, 8 a frame"]
    QUEUE --> JOB["worker: bordered heightfield"]
    JOB --> CACHE["cache the heightfield"]
    CACHE --> MESH["build geometry, 4 a frame"]

    style JOB fill:#065f46,stroke:#064e3b,color:#fff
    style BALANCE fill:#0369a1,stroke:#0c4a6e,color:#fff
```

**The selection rule is not in the streamer.** Everything above the queue — the
traversal, the error predicate, the horizon cull, the balance and the morph
bands — is `selectTerrain` in `packages/rendering`: a pure function of a body's
radius and relief, an eye distance and a body-fixed direction. The streamer
calls it twice a frame and owns only the cache, the worker jobs and the meshes.
That split is what makes "what would this camera ask for?" answerable without a
GPU, and it is why the terrain budget has measured numbers in it at all — the
browser asks the question once a frame, `ir.descend` asks it a few hundred times
in a millisecond ([harness](../guides/harness.md#measuring-terrain)).

### The four rules the traversal follows

**Refine while a patch's own grid cell is coarser than the screen can tell.**
Ulrich's screen-space-error predicate wants the mesh's true vertical deviation,
and on a planet that number is startlingly small — Earth's relief is two parts
in a thousand of a cube face, and a patch's 64 quads cut it by another 64. So
the error is a patch's _sample spacing_, the way Cesium's shipping tiles carry
it: the size of the smallest thing a patch can express.

**Stop where the field stops.** Past some level a patch is a bilinear upsample
of its parent — on Mercury a level-9 patch differs from one by 12 cm, and levels
10 through 12 by nothing a float can hold. `surfaceDetailFloor` measures that
per body from the field itself rather than assuming it, and it lands between
level 7 and 10 across the zoo against the 12 the old rule saturated at.

**Measure to the ground, not the datum.** A node is a cone of directions crossed
with the shell `[radius − relief, radius + relief]` that ground can occupy, and
the distance is to the nearest point of _that_ — zero when the eye is inside the
shell, which is what standing on the ground means.

**Keep neighbors within one level.** The [CDLOD](rendering.md#terrain-meshing)
morph slides a patch onto its _parent's_ grid, so it closes a one-level gap
exactly and a two-level gap not at all. An unrestricted tree produced gaps of up
to six, drawn as dashed black arcs along every level ring; the tree is restricted
to 2:1, which is the classical answer and the rule Transvoxel's transition cells
assume.

**What is cached, and why that split:** heightfields are cached and so is the
geometry built from them. A [floating-origin rebase](rendering.md#the-floating-origin)
invalidates neither: patch vertices are body-fixed and anchor-relative, so the
pose goes back on at draw time rather than into the buffer.

A cache smaller than the working set does not degrade, it **oscillates** — and
the streamer holds two selections at once, the drawn one and the request one,
which diverge because the second is taken from where the eye is going. Sized at
a flat 512 against a working set of six hundred, every frame evicted ground the
next frame wanted: the draw set collapsed from 350 patches to 19 and refined
back, over and over, which is terrain strobing at every altitude. Both caps come
from the selection's own ceiling now.

Patch keys are `body|face.level.i.j` — `terrainPatchKey`, one definition and
three readers — so the same patch is never requested twice concurrently, and the
request set is stable while the player hovers.

### What is drawn while it loads

Refinement only enters ground that is already in the cache, so a patch whose
field has not arrived is never a hole: its parent is drawn instead, covering the
same ground more coarsely. A descent therefore _sharpens_ rather than filling
in. The request set is taken from where the eye will be in two seconds and asks
for the whole pyramid under it, coarsest first — without the ancestors it would
climb one worker round trip per level, and a streamer starting empty would draw
six cube faces and stay there until a level-nine patch arrived.

### Where terrain is not drawn

A body's relief has to cover more than eight pixels before any of this runs.
Past that distance the mesh and the datum sphere are the same picture, and the
sphere already carries a normal map and, on four bodies in Sol, a photograph —
so drawing generated ground over it replaces a measured picture with an invented
one. Earth draws its map down to 2,000 km of altitude and its ground below that;
Miranda, with 10 km of relief on a 236 km radius, keeps terrain out to eight
thousand kilometers, because there the relief _is_ the shape of the body.

---

## What makes this possible at all

Streaming is only tractable because of two properties established elsewhere:

| Property                              | Why streaming needs it                       | Where                         |
| ------------------------------------- | -------------------------------------------- | ----------------------------- |
| Content is a pure function of address | Unloading loses nothing; reloading is exact  | [determinism](determinism.md) |
| Generation is order-independent       | Patches can arrive from workers in any order | [determinism](determinism.md) |
| Identity exists without residency     | A save can reference an unloaded system      | [identity](identity.md)       |
| Frames install as closures            | Installing a system costs no generation      | [frames](frames.md)           |

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

| Limit                                            | Consequence                                                                 | Roadmap                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------- |
| Interest is a radius scan over generation cells  | Fine at 6 ly; a spatial index is needed for large radii                     | [roadmap](../roadmap.md#streaming-and-scale) |
| The selection is not frustum-culled              | A whole disk is generated, of which the renderer draws about a third        | [roadmap](../roadmap.md#terrain)             |
| Vertex attributes are float32                    | 203 KB a patch, so a whole-disk selection is 45–126 MB                      | [roadmap](../roadmap.md#terrain)             |
| The mesh is built on the main thread             | 0.25 ms a patch, budgeted at four a frame; the worker already has the field | [roadmap](../roadmap.md#terrain)             |
| Three noise bands and one flat color per body    | The ground reads as geometry rather than as a place                         | [roadmap](../roadmap.md#terrain)             |
| A mapped body's terrain is not its published map | Procedural ground under a photographic albedo, near the surface only        | [roadmap](../roadmap.md#terrain)             |

**The morph closes one level, and that is a constraint rather than a setting.**
A vertex slides toward the position its _parent's_ grid holds for it, so where
two levels meet the finer patch arrives exactly on the coarser one's vertices.
Where three levels meet it arrives on a grid the coarser patch has no vertex on,
and the difference is a hairline of open sky. A wide enough LOD band removes the
possibility by construction — measured, the tree balances itself once a level's
band is 3.7 patches wide — but that costs 500 to 1,000 patches for one disk
against 300 to 600, so the band stays narrow and the tree is restricted instead.

---

## Related

- [Determinism](determinism.md) · [Identity](identity.md) · [Workers](workers.md)
- [Rendering](rendering.md#terrain-meshing) — what happens to a heightfield
