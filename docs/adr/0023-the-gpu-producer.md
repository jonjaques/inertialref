# ADR-0023: The GPU produces the heightfield the CPU defines

Status: accepted · 30 Aug 2026

## Context

A bordered 65×65 heightfield is 4,761 samples of the band stack — hypsometry,
belts, volcanism, relief, ice, the crater ladder, the presentational tail and
the grit — and costs 22 to 50 ms a patch on an M5 in Node, 45 to 187 ms in a
browser worker with the frame beside it ([perf](../../design/plans/perf.md)). A
two-meter stance on Luna wants 777 to 1,100 of them. At the pool's measured
ceiling of 41.6 jobs a second on eight workers, the ground sharpens for ~24 s
after an arrival, and on a retina window for over a minute. The plan's
condition for this phase — adopt the GPU only if the measurements say so — is
met, and it is a wall clock rather than a projection
([the terrain plan](../../design/plans/terrain.md) § 4).

The other half of the context is the invariant the plan was written around.
`elevationAt` in `packages/universe` is float64, deterministic and versioned,
and it decides where a ship lands. The GPU is float32: a unit vector resolves
6e-8 radians, which at a moon's radius is a tenth of a meter, and the crater
ladder's lattice-cell tests flip at cell boundaries in float32 — measured as
44 m of crater over-count on Luna and 190 m on Earth at coarse levels before
the slab test went integer. Nothing that reaches the GPU may become canonical,
and the drawn field must still agree with the canonical one to a stated
tolerance, per body and per band.

## Decision

**The GPU produces the drawn heightfield tiles; the CPU function stays canon
and the fallback; a source is a port; the tolerance is a test on the real
adapter.**

1. **The kernel is a port of the band stack, not a rewrite.**
   `packages/universe/src/terrainKernel.ts` packs a surface into records and
   words — 30 plates, 14 hotspots, 4 stripes, `MAX_CRATER_LEVELS + 4` crater
   levels, 16 rays, 112 words — and `writeTileFrame` packs a tile's per-rung
   integer frame: the floor and fraction of the lattice coordinate at each
   crater level, computed in float64 before upload. Every shape table the
   bands read (`HYPSOMETRY_SHAPE`, `CRATER_SHAPE`, `COVER_SHAPE`, the rest) is
   exported from the band's own file and read by both paths, so a change to a
   band is a change to one table and one test.
2. **Precision lives in the frame, not in the float.** `apps/game/src/render/terrainKernel.ts`
   is the TSL compute kernel, one thread a sample, sixteen tiles a dispatch,
   elevation and packed cover out. A sample's direction is a float64-exact
   tile corner plus an in-kernel `delta`; the crater existence tests are u32
   threshold compares (`LEVEL_DRAW_AT`, `PEAK_DRAW`); the sphere test is done
   in 48-bit integers on the frame-relative chord against packed
   `floor(cells²)` and `ceil(cells²)`; `tanh` is a WGSL function, because
   Metal's underflows for the tiny arguments the tail hands it. The CPU
   function's `'exact'` chord path adopts the same integer slab test — a
   presentational change, unversioned, because the tail is not canon.
3. **A source is a port over the pool.** `HeightfieldSource` in
   `packages/workers/src/tasks.ts` — `kind`, `available`, `submit(payload)` —
   is what `TerrainStreamer` asks for heightfields. `poolHeightfieldSource`
   wraps the pool; `createTileProducer(renderer)` in
   `apps/game/src/render/terrainProducer.ts` is the GPU one, installed by `App`
   at renderer ready once `warm()` has compiled the pipeline behind the boot
   cover. One batch in flight, one body a batch, uploads keyed on
   `seed|maxElevation|roughness|seaLevel`. `?producer=cpu` refuses it; a
   failure sets `available = false` and the streamer falls back to the pool
   for the rest of the session. WebGL 2 never sees it.
4. **Tolerance is measured where the arithmetic runs.** Under `pnpm test:gpu`
   on the physical adapter: `terrainKernel.gpu.test.ts` holds every zoo body
   and Luna, Earth and Mercury at levels 0 through the drawn floor to
   `3e-5 · maxElevation + halfWidth · 2⁻²¹`; `terrainBands.gpu.test.ts`
   isolates each band with its own bound; `terrainProducer.gpu.test.ts` holds
   a batch bit-identical to the same tiles produced singly, interleaves bodies,
   cancels a queue, and refuses a wrong resolution.

## Alternatives considered

- **More workers, or WASM.** Eight workers is the measured ceiling — runs
  dilate 45% from four to eight as the extra threads land on E-cores — and
  WASM is at best a small multiple on the same cores. The kernel is 80× a
  tile in the harness: 10.0 ms for sixteen tiles against 805.6 ms for the same
  sixteen on the CPU, and it is a different resource, not a faster use of the
  one already saturated.
- **Proland's whole shape: a texture-array cache with normals and the LOD
  morph on the GPU.** The plan's phrase. The heightfield is the 22–50 ms; the
  normal passes and the mesh are 0.25 ms a patch in `buildPatch`, and moving
  them means moving the mesh arithmetic down a layer first
  (`packages/workers` and `packages/rendering` are the same layer). That is
  the next seam, not this decision, and the build being the queue is the
  measurement that opens it.
- **Make the GPU canon.** Float32, adapter-dependent transcendentals, no bit
  equality across devices. Landing must not depend on the adapter. Rejected on
  the invariant the plan already states.
- **A scalar mirror of the kernel, tested in Node.** Refused by rule: the test
  is the graph on the real GPU ([testing](../guides/testing.md)).
- **A tile a dispatch, or many in flight.** The readback round trip dominates
  below sixteen, the uniform upload is per body, and a second batch in flight
  only deepens a queue the streamer already cancels on a turn.

## Consequences

- Luna, 2 m stance, 1600×900, converged: **4.4 s** at eight builds a frame
  (8.2 s at four, 3.5 s at sixteen) against **25.5–32.7 s** from the pool at
  any of them; at 1920×1200 on a 2× ratio, **7.5 s** against **61.4 s**.
  `BUILDS_PER_FRAME` is eight, 2 ms of the frame, and the main-thread build is
  now the queue — the number the next phase is measured against.
- Every band's shape table is shared, and a band's change is a kernel change:
  `pnpm test:gpu` is the check, and it needs a physical adapter, so it is
  outside `pnpm check` and a CI without a GPU cannot run it.
- The structure around the bands is shared as well. `BAND_STACK` in
  `packages/universe/src/bandStack.ts` is the one description of which stages
  there are, in what order, behind which gate — spelled once against the body
  and once as the packed slot the kernel reads — and `evaluate`, the kernel and
  the band test all take their gates from it. `packedStageOn` decodes a gate
  from a packed record, so `bandStack.test.ts` holds the packer's encoding to
  the body's over the whole zoo in Node; the tolerance test is left holding
  the bands' arithmetic, which is the only thing it has to. It is a
  description, not a third executable spelling: the bodies stay two, and a
  kernel that walked the table would be the scalar mirror this decision
  refuses, one level up.
- Two producers agree only to the tolerance. A screenshot from the GPU and one
  from `?producer=cpu` differ at the sub-meter tail, and a figure about the
  drawn ground names its producer (`ir.terrain().producer`).
- A tile frame is exact through level 23 and `writeTileFrame` refuses deeper.
  The producer says so through `HeightfieldSource.maxLevel`, and the streamer
  sends a deeper region to the pool — not to a refusal, which it would re-ask
  of the same source every frame. The drawn floor is well below in any case.
- The producer's `warm()` is a pipeline compile registered as one census unit
  behind the boot cover — registered from the effect that opens the warm-up
  session, because a registration from the renderer's `onReady` precedes the
  session and runs detached, uncounted. A device lost mid-session is a
  fallback to the pool, not a rebuild.
- Known and unexplained: the kernel's level-0 offset term, which is the
  `halfWidth · 2⁻²¹` in the bound; and at 1920×1200 on a 2× ratio both
  producers converge at level 7 and 954 patches, identically, which is a
  question about selection at display pixels rather than about production.

## Related

- [ADR-0015](0015-terrain-level-of-detail.md) — the quadtree the tiles fill.
- [ADR-0019](0019-the-geology.md) and [ADR-0021](0021-the-ground.md) — the
  band stack and the drawn tail the kernel ports.
- [ADR-0022](0022-the-timeline.md) — `gpu heightfields` on the Terrain track.
- [Streaming](../concepts/streaming.md) § "Where the heightfields come from",
  [Workers](../concepts/workers.md), [the terrain plan](../../design/plans/terrain.md)
  § 11 Phase 5.
