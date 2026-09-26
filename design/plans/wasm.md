# WebAssembly for the terrain field: the gated plan

What to do with a wasm kernel, and the conditions under which doing anything
is justified. The measurement that closes the question for now is
[`../reports/scriptc-wasm-spike.md`](../reports/scriptc-wasm-spike.md): scriptc
0.1.5 runs the noise field 4–5× slower than V8 natively and 15–20× slower as
wasm, emits a WASI command with no exported functions, and the CPU path it
would speed up is already 80× behind the GPU producer
([ADR-0023](../../docs/adr/0023-the-gpu-producer.md)). This plan exists so that
the work is not re-derived from scratch when one of those facts moves, and so
that the seam it would land in is named before anyone cuts it.

## The gate

No phase below starts until **all three** hold, each with a figure attached:

1. **The CPU pool is the bottleneck at a named operating point.** The GPU
   producer is unavailable or refused (`?producer=cpu`, WebGL 2, a device
   without compute), and `pnpm sim --terrain-baseline` shows the pool's queue,
   not the main thread's build, deciding convergence time there. Today the
   main-thread build is the queue with the GPU on, and the pool is the fallback.
2. **A toolchain compiles the field to a module the Worker can call.** Exported
   functions with numeric arguments, linear memory the host reads as
   `Float32Array` and `Uint8Array` views, no per-job instantiation. For scriptc
   that is a wasm32 library or reactor mode; for AssemblyScript, Rust or C it
   is the default.
3. **The compiled field beats V8 on the field itself by at least 2× on the
   spike's three programs**, re-run unchanged: the noise field (original and
   flat), the `dot4` loop and the `mix32` chain, with the checksums matching.
   Parity is not a reason to carry a second implementation of canon.

If the gate opens, the phases run in order and each is committed and measured
before the next.

## Phase 1 — the flat contract, on the CPU path (no wasm yet)

`surfaceKernel()` in `packages/universe/src/terrainKernel.ts` already packs a
body into a `Float32Array` of records and a `Uint32Array` of words, with
drainage as another pair, and `writeTileFrame` writes a per-tile frame from
float64. That is the GPU contract, and it is the wasm contract too. This phase
gives the CPU pool the same shape:

- A `generateHeightfieldPacked(records, words, drainage, frame, out)` that
  evaluates the band stack from the packed record rather than from
  `SurfaceParameters`, writing into caller-owned `Float32Array`/`Uint8Array`.
  The existing `generateHeightfield` becomes a thin caller of it.
- Held to the GPU's tolerance test on every zoo body and to bit equality with
  the object-reading path where the object path remains canon.
- Measured with `pnpm sim --terrain-baseline` at two operating points that
  differ in the variable the claim is about (a cratered airless body and an
  atmosphered one).

Worth doing on its own: it removes the per-job `decodeSurface` object and the
`WeakMap` miss the wire pays today, and it is the precondition for any kernel
that is not JavaScript.

## Phase 2 — the module and its host port

- **Toolchain choice, ranked by what the gate measured.** scriptc, if its
  wasm library mode exists, because the source stays the source. Otherwise
  AssemblyScript for a TypeScript-shaped port with explicit `i32`/`f64` and
  `simd128`, accepting that it is a second implementation with its own
  algorithm version. Rust or C only if AssemblyScript's codegen loses the 2×.
- **The port.** A `HeightfieldSource` with `kind: 'wasm'` in
  `packages/workers/src/tasks.ts`, selected by `Heightfields` beside the pool
  and the GPU producer, with the same `submit(surface, request)` and the same
  cancellation handle. The module is instantiated once per Worker by host
  code in `apps/game` (beside `browserWorker.ts`, the one `Worker` site) and by
  `apps/headless` for Node; `packages/*` never import it or load a file.
- **Memory.** The packed record and frame are copied into the module's linear
  memory once per body and once per tile; the heightfield is read back as a
  view and transferred out as today. No `SharedArrayBuffer` until the page is
  cross-origin isolated, which is a hosting decision with its own ADR.
- **Cache namespace.** A producer namespace of its own in
  `HEIGHTFIELD_CACHE_REVISION` and the heightfield cache key
  ([ADR-0045](../../docs/adr/0045-generated-terrain-is-a-disposable-cache.md)),
  because a kernel that differs in the last bit is a different producer.

## Phase 3 — canon, or not

The wasm field is **drawn** terrain until proven otherwise, held to the GPU's
tolerance. Making it canonical — the field the contact test integrates — needs
bit equality with the JavaScript field across every zoo body and Luna, Earth
and Mercury at every level, in Chrome, in a Worker and in Node, and a
`TERRAIN_ALGORITHM` version if it cannot be had. The spike measured bit
identity on 20,000 samples including transcendentals; that is a reason to run
the test, not a reason to skip it.

## Phase 4 — the decision

An ADR, in the form of ADR-0023: the figures at the two operating points, the
alternatives it beat, and what the measurement makes visible next. If the
module loses to the pool at either point, the branch closes with the report
and this plan loses its phases.

## What this plan is not

- Not a plan to move the mesh build, selection or the engine to wasm. Each is
  under a millisecond a frame; the spike's numbers make them slower.
- Not a plan to replace the GPU producer. The wasm field is the fallback's
  fallback.
- Not a bet on scriptc. It is the tool that prompted the question, and the
  plan watches its wasm library mode, integer specialization and `simd128`
  because those are the three things between it and the gate.
