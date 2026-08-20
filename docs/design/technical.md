# Technical requirements

The WebGPU migration, performance budgets, and the browser constraints that shape
every visual decision in [art](art.md).

> Architecture is in [`docs/architecture.md`](../architecture.md) and is not
> repeated here. This page covers what the *game* requires that the platform does
> not yet provide.

---

## What exists

| | |
|---|---|
| Simulation core | 11 layered TypeScript packages, ~13,700 lines, framework-free below `apps/` |
| Renderer | Three.js 0.182 via React Three Fiber 9, WebGL |
| Build | Vite 8 with the Oxc transform; React Compiler on |
| Runtime | Node 26, pnpm 11; Node runs the TypeScript sources directly |
| Bundle | ~1.15 MB, 324 KB gzipped, dominated by Three.js, **no code splitting** |
| Simulation throughput | ~1.25M ticks/s in-browser for one entity; ~100–105k ticks/s headless including frame resolution |
| Offline | Service worker + IndexedDB + a migration chain, verified with the server stopped |
| Gate | `pnpm check` — graph, lint, typecheck, test, build. Runs in CI on every pull request, alongside `pnpm sim --self-test`. |

---

## The WebGPU migration

The single largest technical item in the plan, and the enabler for
[M2](production.md#m2--the-believable-world).

### What it buys

| Capability | Why it matters here |
|---|---|
| **Compute shaders** | Terrain generation, quadtree selection and geomorphing on the GPU. Currently CPU-side in a worker pool — correct, but a ceiling. |
| **GPU-driven instancing** | Scatter, asteroid fields, star point clouds. [Content](content.md) needs hundreds of thousands of instances. |
| **Clustered forward+** | Many lights, needed for stations, interiors and multi-star systems |
| **Storage buffers, indirect draw** | Culling on the GPU; the CPU stops being the draw-call bottleneck |
| **`rgba16float` throughout** | The [eleven orders of magnitude of exposure](art.md#hdr) requires HDR everywhere, not a post pass |
| **Extended-range output** | `WebGPURenderer({ outputType: HalfFloatType })` with `outputColorSpace = ExtendedSRGBColorSpace` gives genuine HDR presentation. There is no WebGL equivalent — this capability is WebGPU-only. |

### The path

**Three.js `WebGPURenderer` with TSL first**, not a hand-written WebGPU renderer.

*Rationale.* `packages/rendering` deliberately does not import Three.js — it emits
positions, scales, orientations and vertex buffers as plain data, and `apps/game`
applies them. That boundary means the renderer swap is confined to the app layer
and can be done incrementally, with the WebGL path kept working alongside it. A
hand-written renderer is a six-month project that buys control this game does not
yet need; TSL gets compute and HDR immediately.

**The escape hatch matters.** Terrain, atmosphere and the star-field passes are
the three places where a custom pipeline may eventually be worth it. The design
should keep them expressible as standalone passes so that decision stays
available. `[OPEN QUESTION: does TSL's abstraction cost anything material for the atmosphere integral? Needs a spike before M2 is committed.]`

### Fallback

WebGPU availability is good on desktop Chrome, Edge and Safari 26+, and weaker
elsewhere `[Assumption: verify against current caniuse data at implementation time — this moves]`. The WebGL path is **retained as a reduced-fidelity fallback**, not deleted:
no compute terrain, simpler atmosphere, fewer instances, lower LOD ceiling. The
game must remain playable on it, because "it's a link" is the pitch and a link
that fails is worse than an install.

---

## Performance budgets

**Target: 60 fps at 1920×1080 on a 2023-class laptop with integrated or entry
discrete graphics.** That is the machine the audience actually has, and a browser
game that requires a desktop GPU has given up its only distribution advantage.

### Frame budget — 16.6 ms

| Stage | Budget | Notes |
|---|---|---|
| Simulation ticks | 0.5 ms | 64 Hz fixed; typically 0–2 ticks per frame. Currently far under. |
| Snapshot + scene build | 1.5 ms | Plain-data; already measured cheap |
| Terrain reconciliation | 1.0 ms | Upload and swap only; generation is off-thread |
| Culling + draw submission | 2.5 ms | Target: GPU-driven, so this falls with WebGPU |
| GPU — geometry | 5.0 ms | |
| GPU — atmosphere + post | 3.0 ms | The atmosphere integral is the expensive one |
| Headroom | 3.1 ms | Non-negotiable; the budget is 80%, not 100% |

### Other budgets

| Budget | Target | Current |
|---|---|---|
| Cold load to interactive | ≤ 4 s on a 20 Mbit connection | Unmeasured |
| Client bundle, gzipped | ≤ 900 KB with code splitting | 324 KB, no splitting, pre-WebGPU |
| Material sets, per biome | ≤ 12 MB | — |
| Peak JS heap | ≤ 900 MB | Unmeasured |
| Terrain patch generation | ≤ 8 ms per patch per worker | Measured; within |
| Worker queue latency, p95 | ≤ 40 ms | Instrumented; unmeasured under load |
| Save size | ≤ 4 KB | 696 bytes today |
| Draw calls | ≤ 1,200 | Unmeasured |

> 🎮 Designer's Note: The right-hand column is mostly "unmeasured", and that is
> the honest state. [`docs/roadmap.md`](../roadmap.md#performance-work) says it
> plainly: the design admits every optimisation technique and almost none are
> applied, because almost nothing is measured. **A benchmark harness is a
> prerequisite for M2**, not a nice-to-have — without it, every performance
> claim in this table is a guess and the WebGPU migration cannot be evaluated.

---

## Browser-specific constraints

The ones that will actually cause problems, with what they force.

| Constraint | Consequence | Mitigation |
|---|---|---|
| **No `SharedArrayBuffer` without cross-origin isolation** | Worker results must be copied or transferred, not shared | Transferables already used; COOP/COEP headers are available if it becomes necessary, at the cost of embedding third-party content |
| **Tab backgrounding throttles timers** | A returning tab could try to run thousands of ticks | **Already solved** — a step budget in the clock, in exactly one place |
| **Memory pressure kills the tab, silently** | A long session in a dense system is the risk case | Hard caps on streamed patch count and instance buffers; measure before M2 |
| **Gamepad / WebHID support is uneven** | HOTAS support is genuinely uncertain in a browser | Needs a spike. Do not promise HOTAS before it is proven. See [ux](ux.md#controls). |
| **Audio requires a user gesture** | First sound must follow an interaction | The FTUE's `POWER` prompt is the gesture, by design |
| **No filesystem** | Saves are IndexedDB; export is a download | Already handled; export/import of the 696-byte save is trivial and should be exposed |
| **Shader compilation stalls** | A first-frame hitch when entering a new visual state | Pre-warm pipelines during the [jump tunnel](flight.md#jump-) — which is the one place the game has six spare seconds |
| **HDR display detection is unverified** | The page may output extended range to a display that cannot show it, or fail to when it can | Spike `(dynamic-range: high)`, CSS `dynamic-range-limit` and `screen.isExtended` before M2 closes. Ship an explicit user override regardless. |

---

## Required engineering, by area

Nothing here is architectural. Everything lands on a seam that already exists.

| Area | Work | Seam |
|---|---|---|
| **Terrain** | Quadtree LOD, geomorphing, edge stitching, cube-face wrapping, materials | `terrainLevelFor` already returns a level; the streamer needs per-patch levels |
| **LOD** | Hysteresis, cross-fade, sphere-derived impostors | `selectLod` takes the current tier as a new input — see [art](art.md#continuity--the-no-pop-in-specification) |
| **Streaming** | Predictive loading, per-frame generation budget, a spatial index for interest | `updateInterest`; `systemsWithin` already bounds and refuses oversized queries |
| **Simulation** | Move to a Web Worker when entity counts rise | Mechanical, not architectural — the snapshot is already structured-cloneable |
| **Replay** | An input log of `(tick, entityId, controlInput)` plus a driver | Everything else exists: canonical tick, state hash, persisted input |
| **Catalogue** | The [ingest pipeline](galaxy.md#ingest-pipeline) and catalogue versioning in the generation manifest | `algorithm()` and `manifest()` already version generation |
| **Character** | A controller attached kinematically to a rotating surface frame | The same approach `flight.ts` takes for a landed ship |
| **Automation** | ~~CI~~ ✅ · a stored save fixture, performance regression tests, a formatter | CI runs `pnpm check` plus the capability self-test on every PR |

---

## Third-party dependencies

Deliberately few, and the list should be read as a commitment rather than an
inventory.

| Dependency | Layer | Note |
|---|---|---|
| Three.js | `apps/game` only | Never below the app layer; `pnpm graph` enforces it |
| React + React Three Fiber | `apps/game` only | |
| Vite, Vitest, oxlint, TypeScript, fast-check | Tooling | |
| **Nothing else** | | No physics library, no networking SDK, no analytics, no telemetry, no vendor SDK anywhere in `packages/*` |

The absence of a vendor SDK in the package graph is
[ADR-0008](../adr/0008-multiplayer-partitions.md)'s explicit requirement and is
enforced by the layer check. It should survive the persistent universe.

---

## Related

- [art](art.md) — the rendering doctrine this must deliver
- [production](production.md) — when each item lands
- [`docs/architecture.md`](../architecture.md) — the system as built
- [`docs/roadmap.md`](../roadmap.md) — the engineering gap list this draws from
