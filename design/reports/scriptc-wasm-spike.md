# scriptc as a route to WebAssembly

A research spike, run 26 Sep 2026, on whether compiling the core packages to
WebAssembly through [scriptc](https://github.com/vercel-labs/scriptc) buys
performance. The hypothesis going in: the packages already have the shape an
ahead-of-time compiler wants — no third-party dependencies, scalar float math,
integer hashing, typed arrays at the boundaries — and a native or wasm build of
the same source might run the terrain field faster, with SIMD as a further
prize. The companion plan, for the day the gate below opens, is
[`../plans/wasm.md`](../plans/wasm.md).

**Answer: no, not with scriptc 0.1.5, on three independent grounds.** The
compiled field runs **4–5× slower than V8 natively and 15–20× slower as wasm**;
the wasm scriptc emits is a **WASI command with a `main` and no exported
functions**, so a browser cannot call into it; and the time it would save is on
the wrong resource, because the GPU producer already runs the same field
**80×** faster than the CPU pool
([ADR-0023](../../docs/adr/0023-the-gpu-producer.md)). Each is sufficient on its
own. None is permanent, and the last section names what would have to change.

Operating point for every figure here: a cloud container with four vCPUs of an
Intel Xeon at 2.10 GHz, Node 26.10.0 (V8 14.6), scriptc 0.1.5 with its bundled
LLVM at `-O2`, native x86-64, and a wasm32-wasi module run by the same V8
through `node:wasi`. That is one machine and a slow one; the ratios are the
finding, not the absolute nanoseconds, and every row in a table was produced by
the same TypeScript file with the same printed checksum.

---

## What scriptc is

The facts that decide the question, read off the package and its emitted C
rather than the announcement.

- **A TypeScript-to-native compiler that treats wasm as another native
  target.** It parses and type-checks with the real TypeScript compiler, lowers
  to a typed IR, and emits C or LLVM IR, then objects and executables. It is
  labeled a Vercel Labs experiment, Apache-2.0, and moves fast: 45 releases
  between 13 Jul and 26 Sep 2026, 708 commits, 0.1.5 published the morning of
  this spike.
- **Three tiers.** A construct compiles statically, runs in an embedded
  quickjs-ng under `--dynamic` (about 620 KB), or is refused with a numbered
  diagnostic and a rewrite hint. `scriptc coverage <file>` reports the split
  per statement. A refused construct in reachable code fails the build; the
  percentage is a measure of how far a rewrite would have to go, not of how
  much runs.
- **Every `number` is a `double`.** The emitted C declares `fib` as
  `double sc_f_fib(double)`. Loop induction variables are the one integer
  specialization. The `|0`, `>>>`, `^`, `&`, `<<` chain this repository's
  hashing is written in lowers to **runtime calls** — `scr_bit_xor`,
  `scr_bit_or`, `scr_bit_ushr`, `scr_bit_and`, `scr_bit_shl` — each taking and
  returning a `double`.
- **Typed arrays are runtime objects.** `Float64Array` is a refcounted
  `ScrBytes`, and every read is a call, `sc_bytes_get_f64(bytes, index)`, with
  a bounds check; nothing is a pointer into linear memory the optimizer can
  see through.
- **Objects are monomorphic structs, heap-allocated and reference-counted.**
  An interface return such as `FieldSample { value, dx, dy, dz }` is a
  `calloc` per call and a `free` when the count drops. There is no escape
  analysis. `WeakMap` and `WeakSet` are refused outright — "weak collections
  observe garbage collection, which reference counting never exposes".
- **The standard library is a lowering table, not an engine.** Of 558
  projected surfaces, 394 are static. The gaps that this codebase hits:
  `Math.imul`, `Math.fround`, `Math.tanh`, `Math.cosh` have no lowering;
  `Set` and `Map` elements are limited to numbers and strings;
  `Number.prototype.toString` and `Number.parseInt` need `--dynamic`; classes
  compile only in a restricted form, and one of the repository's own is refused
  in every module graph that reaches `@inertialref/shared`; a module cycle
  with top-level code is refused at preflight.
- **The wasm target is WASI Preview 1, as a program.** The link recipe names
  `entry_symbol: "main"`. The README states that on wasm32-wasi, "native FFI,
  and library-mode archive builds are rejected with `SC3002`" — library mode,
  the one path that exports named C symbols, exists only for native targets
  and the mobile static-archive case. The object ABI is "experimental,
  compatibility exact-runtime-version". There are no exported functions for a
  JavaScript host to call, no way to hand it a `Float32Array` view, and no
  threads: the wasm runtime pack is built with `SCR_THREAD_INSTANCES` excluded.
- **The shipped wasm path needs Zig.** `SCRIPTC_CC=zigcc` drives `zig cc` for
  its WASI libc and compiler-rt. Zig's download host is unreachable from this
  container, so the module here was linked by hand: `--emit=obj` for
  wasm32-wasi (which needs only Node), the 20 unconditional objects of
  `@scriptc/runtime-wasm32-wasi`, Ubuntu's `wasi-libc` package, and two
  compiler-rt builtins (`__multi3`, `__lshrti3`) compiled from a few lines of
  C. The result runs; the pack's own `zig` route would be the same objects.
- **No SIMD.** The emitted objects are MVP WebAssembly. The compiler passes no
  `simd128` or other target feature, so LLVM cannot vectorize even the loop
  shapes that invite it, and nothing in the compiler mentions SIMD.

---

## How much of the core compiles today

`scriptc coverage` over the packages as they stand, unmodified. "Statements"
is the compiler's own unit.

| Entry                                   | Statements | Static | Blockers in reached code                                                                                                     |
| --------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/procedural/src/field.ts`      | 143        | 97%    | `Math.imul` ×3                                                                                                               |
| `packages/procedural/src/index.ts`      | 447        | 90%    | `Math.imul`; `Set<LogSink>`, `Set<TimingSink>`; a class with no lowering; `Number.parseInt`, `toString` are `--dynamic` only |
| `packages/spatial/src/index.ts`         | 316        | 98%    | `Math.fround`; the shared logging sets and class                                                                             |
| `packages/physics/src/index.ts`         | 540        | 98%    | `WeakMap<OrbitalElements, Quat>`; `Math.fround`, `Math.cosh`; the shared sets and class                                      |
| `packages/universe/src/craters.ts`      | 977        | 95%    | `Math.imul`, `Math.fround`, `Math.tanh`; namespace destructuring; tuple indexed by a variable                                |
| `packages/universe/src/bands.ts`        | 1,262      | 95%    | the above plus `WeakMap<SurfaceParameters, TerrainSketch>` and `MapIterator.next`                                            |
| `packages/universe/src/sketch.ts`       | 1,118      | 95%    | the same set                                                                                                                 |
| `packages/universe/src/terrain.ts`      | —          | —      | preflight `SC1016`: `terrain.ts ↔ drainage.ts` is a cycle with top-level code at `drainage.ts:310`                           |
| `packages/simulation/src/world.ts`      | —          | —      | preflight: the same cycle plus `system.ts ↔ solar/system.ts` at `solar/system.ts:55`                                         |
| `packages/rendering/src/terrainMesh.ts` | —          | —      | preflight: the same two cycles                                                                                               |
| `packages/simulation/src/flight.ts`     | —          | —      | preflight: the same two cycles                                                                                               |

The hypothesis about shape is largely right: nine in ten statements compile,
and the field module is at 97% with a single missing intrinsic. The blockers
are shallow and few — `Math.imul` is one lowering upstream; the two cycles
are two moved top-level reads; the `WeakMap` memoization on the canonical path
is a design choice this repository has already revisited once for the wire
(`decodeSurface` misses it on every job). None of that is what stops the idea.

---

## The measurement

Three programs, each run under Node 26 as ordinary TypeScript, as a scriptc
native executable, and as a scriptc wasm32-wasi module executed by the same V8.
Every variant prints the same checksums, so the same work is being compared.

**The noise field**, `packages/procedural/src/field.ts` as it stands, with its
`Seed` type inlined so the file imports nothing. `Math.imul` has no lowering,
so a second copy spells it as an exact double-arithmetic polyfill; Node runs
both, scriptc runs the polyfilled one. A third copy, `flat`, restructures the
module the way an ahead-of-time compiler wants — the noise writes its four
numbers into a module-level `Float64Array` instead of returning a record, and
the option spread per call is gone — to separate the cost of allocation from
the cost of arithmetic. 300,000 samples; five repetitions; middle value.

| ns per sample, lower is better   | Node, `Math.imul` | Node, polyfill | scriptc native | scriptc wasm |
| -------------------------------- | ----------------: | -------------: | -------------: | -----------: |
| `fbmField`, 6 octaves            |               692 |            904 |          3,295 |       12,900 |
| `ridgedField`, 8 octaves, damped |               862 |          1,174 |          4,187 |       17,000 |
| `fbmField`, flat, 6 octaves      |               707 |              — |          2,860 |       11,800 |
| `ridgedField`, flat, 8 octaves   |             1,040 |              — |          3,832 |       16,000 |

Native is **4.8× slower** than V8 on the original and **3.7–4.1× slower** on
the flat rewrite; wasm is **15–20× slower**. Removing the record allocation
and the spread recovers 8–13%, so allocation is a minor term. The field's
own comment records the same shape of finding about V8 — a closure at three
call sites costs 200 ns, five times the rest of the function — and here the
whole function is the closure: every `^` and `>>>` in `gradientAt` is a call
through the runtime with a double on each side, eight corners a sample, and
every gradient table read is a bounds-checked accessor call.

**Three micro-benchmarks** isolate the three kinds of arithmetic the core is
made of.

| ns per operation, lower is better              |                               Node | scriptc native | scriptc wasm |
| ---------------------------------------------- | ---------------------------------: | -------------: | -----------: |
| Kepler's equation, 8 Newton steps, `sin`/`cos` |                                267 |            244 |          285 |
| `dot4` over `Float64Array` rows, 4,096 lanes   |                                1.6 |            9.5 |         16.4 |
| `mix32`, one MurmurHash3 finalizer             | 4.1 (`Math.imul`) / 7.3 (polyfill) |           29.6 |         47.0 |

Plain double arithmetic with transcendentals is at **parity**: LLVM and
TurboFan produce the same code for the same doubles, and the libm call
dominates. The two shapes the terrain field is actually built from are not.
Typed-array reads are **6× slower native and 10× as wasm**, because each is a
call. The integer hash is **7× slower native and 11× as wasm** against the
`Math.imul` spelling the codebase uses, because ToInt32 is a runtime function
on a double rather than an `i32`. The dot loop is the one shape that invites
vectorization, and it does not vectorize: the accessor calls hide the memory
from LLVM, and the target has no `simd128` to vectorize into.

**The results are bit-identical across all three runtimes** on 20,000 samples
of the ridged field (printed to fifteen decimals) and on 20,000 evaluations of
`sin`, `cos`, `exp`, `log`, `atan2`, `pow`, `acos` and `sqrt` (a sum near
3.3 × 10⁶ printed to nine). The field uses only `+ − × ÷` and `floor` and
integer operations, all exactly specified, so that agreement is expected; the
transcendental agreement is a measurement about musl's libm and V8's on these
inputs, not a guarantee, and the canonical rule stands either way: the
canonical field runs on one engine, and a producer that differs in the last
bit is a different producer with its own cache namespace
([ADR-0045](../../docs/adr/0045-generated-terrain-is-a-disposable-cache.md)).

---

## Where the time is, and why a faster kernel does not change it

The CPU time of this project is one function. `generateHeightfield` in
`packages/universe/src/terrain.ts` evaluates the band stack at 4,761 samples a
bordered patch, and the crater ladder — a divergent three-dimensional lattice
walk with data-dependent bounds and early exits, "a million cells a patch" —
is most of it. Measured on an Apple M5 in Node 26: **24 to 69 ms a patch on
one core** across the zoo (Gliese 1061 d 62.3, Iapetus 69.6, Miranda 23.5),
9.8 ms with no craters. Everything else is one to three orders smaller: the
mesh build 0.25 ms a patch, selection 0.11–0.31 ms, the engine 0.19–0.23 ms a
frame, a physics tick under a microsecond, the drainage graph 50–110 ms once
a body.

The GPU producer evaluates the same stack: **10.0 ms for sixteen tiles against
805.6 ms** for the same sixteen from the CPU pool, and a converged Luna at two
meters in **4.4 s against 25.5–32.7 s**. ADR-0023 considers WASM in its
alternatives and rejects it on exactly this arithmetic: "at best a small
multiple on the same cores… a different resource, not a faster use of the one
already saturated." The measurement here is stronger than the ADR assumed —
it is not a small multiple, it is a division — but even a hypothetical wasm
kernel at 2× V8 leaves the drawn path 40× behind the GPU it already has. What
the CPU path is still for is the canonical contact sample, one `elevationAt`
at a time from the tick, and the fallback when WebGPU is absent; neither is
where a frame is lost.

The crater walk is also the part SIMD cannot help. The samples are independent
lanes, which is why the GPU port is one invocation per sample, but inside a
sample the ladder is a triple loop with `break` and `continue` on a density
test — the shape that serializes a vector unit. The uniform work (eight
corner hashes, thirty plate dot products, the strided drainage segments) is
real but is not the dominant term.

---

## Integration, if the numbers had come out the other way

For completeness, because these hold for any wasm route and not only scriptc:

- **The page is not cross-origin isolated.** `crossOriginIsolated` is false
  and `performance.now()` steps in 100 µs; there is no `SharedArrayBuffer`
  and no wasm threads without COOP/COEP headers on the Worker.
- **`packages/*` take no third-party runtime dependency and no DOM or Node
  API.** A wasm loader is host code, a port implemented by `apps/game` and by
  `apps/headless`, the way `WorkerPort` is; `Worker` is constructed in one
  file (rule 8), and the module would be too.
- **Node is a first-class runtime for the canonical field.** `pnpm sim`, the
  test suite and the headless ledger step the same code the browser does. A
  wasm canonical path has to be the canonical path in Node as well, or the two
  are two producers.
- **A WASI command talks through stdin, stdout and files.** Without exported
  functions, each job would be a fresh `_start` with the request serialized in
  and the heightfield serialized out through a WASI shim in the Worker — a
  copy each way of the 4,761 × 3 outputs, and a 1.3 MB module (the runtime
  included) instantiated per Worker.

---

## What would have to change before this is worth running again

Upstream, in scriptc, in order of leverage:

1. **A library or reactor mode for wasm32** exporting named functions with a
   C ABI, and linear memory the host can view as typed arrays. Issues #260
   and #265 on embedding are the nearest open threads; library mode exists for
   native targets already.
2. **Integer specialization of ToInt32 chains** — an `i32` for a value that is
   only ever masked, shifted and multiplied — and `Math.imul`. This is the
   whole hash.
3. **Typed-array access as a pointer read**, so LLVM can see the memory,
   inline the bound, and vectorize.
4. **`simd128` as a target feature.**

Here, regardless of the compiler, and each worth doing on its own merits:

- The two module cycles with top-level code, `terrain ↔ drainage` and
  `system ↔ solar/system`, which any whole-program tool refuses.
- The `WeakMap` memoization on the canonical path, which the wire already
  misses on every job and falls back to a string key.

The gate, and the plan that opens when it does, are in
[`../plans/wasm.md`](../plans/wasm.md). The roadmap row that asked for
evidence has it: the existing kernels are not insufficient, the pool is not
the bottleneck, and the tool that would compile the same source produces code
an order of magnitude slower than the engine it replaces.
