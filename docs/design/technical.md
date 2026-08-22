# Technical requirements

The WebGPU migration, performance budgets, and the browser constraints that shape
every visual decision in [art](art.md).

> Architecture is in [`docs/architecture.md`](../architecture.md) and is not
> repeated here. This page covers what the _game_ requires that the platform does
> not yet provide.

---

## What exists

|                       |                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Simulation core       | 11 layered TypeScript packages, ~13,700 lines, framework-free below `apps/`                                             |
| Renderer              | Three.js 0.182 `WebGPURenderer` with TSL, via React Three Fiber 9. WebGL 2 backend retained as the fallback             |
| Build                 | Vite 8 with the Oxc transform; React Compiler on                                                                        |
| Runtime               | Node 26, pnpm 11; Node runs the TypeScript sources directly                                                             |
| Bundle                | 1.90 MB, **541.4 KB gzip / 412.7 KB brotli**, dominated by Three.js, **no code splitting**                              |
| Simulation throughput | ~1.25M ticks/s in-browser for one entity; ~100–105k ticks/s headless including frame resolution                         |
| Offline               | Service worker + IndexedDB + a migration chain, verified with the server stopped                                        |
| Gate                  | `pnpm check` — graph, lint, typecheck, test, build. Runs in CI on every pull request, alongside `pnpm sim --self-test`. |

---

## The WebGPU migration

The single largest technical item in the plan, and the enabler for
[M2](production.md#m2--the-believable-world).

### What it buys

| Capability                         | Why it matters here                                                                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Compute shaders**                | Terrain generation, quadtree selection and geomorphing on the GPU. Currently CPU-side in a worker pool — correct, but a ceiling.                                                                |
| **GPU-driven instancing**          | Scatter, asteroid fields, star point clouds. [Content](content.md) needs hundreds of thousands of instances.                                                                                    |
| **Clustered forward+**             | Many lights, needed for stations, interiors and multi-star systems                                                                                                                              |
| **Storage buffers, indirect draw** | Culling on the GPU; the CPU stops being the draw-call bottleneck                                                                                                                                |
| **`rgba16float` throughout**       | The [eleven orders of magnitude of exposure](art.md#hdr) requires HDR everywhere, not a post pass                                                                                               |
| **Extended-range output**          | `WebGPURenderer({ outputType: HalfFloatType })` with `outputColorSpace = ExtendedSRGBColorSpace` gives genuine HDR presentation. There is no WebGL equivalent — this capability is WebGPU-only. |

### What has landed

The renderer swap itself, on 2026-08-20. `apps/game/src/render/` holds it:
`WebGPURenderer` with `logarithmicDepthBuffer`, TSL node materials for every
surface the game draws, the extended-range output path behind a capability probe
and its three-state override, and an ACES-derived tone curve that is the stock
curve exactly at headroom 1 and lifts only the highlights above it. WebGL 2 is
retained as `WebGPURenderer`'s own fallback backend rather than a second renderer,
so there is one set of node graphs and no second material path to keep in sync.

**What has not**: compute shaders, storage buffers, indirect draw and GPU-driven
culling — the capabilities in the table above that the table promised. Nothing
here uses a compute pass yet. The star field is instanced, and it is the only
thing that is. The atmosphere is an analytic shell awaiting its LUTs.

Three things came out of doing it that are worth carrying forward:

- **WebGPU has no point size.** `PointsNodeMaterial.sizeNode` is silently ignored
  on a `Points` object under the WebGPU backend — every point is one pixel — and
  works fine on the WebGL fallback. Anything wanting sized points is a `Sprite`
  with an instanced position attribute. A rendering bug that appears _only_ on the
  primary backend is the worst-shaped one available.
- **A `vec3` clamped against `float` bounds compiles and renders black.** TSL
  builds the node from whatever it is handed; the generated WGSL `clamp` had
  arguments that did not agree on a type, and it produced no warning, no
  exception and no console output — just an entirely black frame.
- **React Three Fiber cannot release a `WebGPURenderer`.** Its unmount path calls
  `renderLists.dispose()` and `forceContextLoss()`, both WebGL-only and both
  optional-chained, so both are silent no-ops. Two renderers then share a canvas
  and disagree about its size, every frame submits an invalid command buffer, and
  the tab dies. It does not reproduce at devicePixelRatio 1, so a headless check
  calls it fixed when it is not.

### The path

**Three.js `WebGPURenderer` with TSL first**, not a hand-written WebGPU renderer.

_Rationale._ `packages/rendering` deliberately does not import Three.js — it emits
positions, scales, orientations and vertex buffers as plain data, and `apps/game`
applies them. That boundary means the renderer swap is confined to the app layer
and can be done incrementally, with the WebGL path kept working alongside it. A
hand-written renderer is a six-month project that buys control this game does not
yet need; TSL gets compute and HDR immediately.

**The escape hatch matters.** Terrain, atmosphere and the star-field passes are
the three places where a custom pipeline may eventually be worth it. The design
should keep them expressible as standalone passes so that decision stays
available.

### Measured: TSL costs nothing

[Spike 2](../spikes.md#2--tsl-and-the-atmosphere-integral) wrote the same
single-scattering atmosphere raymarch twice — once in TSL, once by hand in WGSL —
harvested the WGSL that three's node system generates, and ran **both through one
raw WebGPU harness**: same `rgba16float` 1920×1080 target, same fullscreen
triangle, GPU time from `timestamp-query`, A and B interleaved, outputs verified
pixel-identical first.

| 32 view × 8 light samples, 1920×1080, Apple M5 | Hand-written | TSL-generated | Ratio      |
| ---------------------------------------------- | ------------ | ------------- | ---------- |
| Orbit, 400 km                                  | 0.393 ms     | 0.393 ms      | **1.000×** |
| High, 60 km                                    | 7.274 ms     | 7.274 ms      | **1.000×** |
| Ground, 2 m                                    | 7.274 ms     | 7.274 ms      | **1.000×** |
| Pipeline build, median of 6                    | 1.00 ms      | 0.90 ms       | 0.90×      |
| Source size                                    | 3,859 B      | 5,196 B       | +35%       |

**Resolved: TSL for everything, including the atmosphere.** The generator inlines
every `Fn` and hoists every intermediate to a function-scope `var` where a person
would write `let` — the one structural difference that could have cost register
pressure — and on Metal the backend compiler removes the difference entirely. The
15% threshold the spike set was met by a factor of ten.

three's renderer around it is nearly free too: the canvas output pass costs
**0.11 ms (1.5%)**, measured as wall clock across a drained queue.

> ⚠️ **`renderer.info.render.timestamp` is not trustworthy on the canvas path.**
> It reported 14.615 ms for a frame whose true cost is 7.27 ms — it double-counts
> when there is an output pass, and the first run of this spike concluded "TSL is
> 2× slower" on the strength of it. Measure with a raw timestamp query, or with
> wall clock across `queue.onSubmittedWorkDone()`. This will bite the benchmark
> harness too.

The escape hatch stays open on principle, but it is no longer pointed at the
atmosphere. What the atmosphere actually needs is
[precomputed LUTs](#the-atmosphere-does-not-fit-the-budget-at-any-language), which
is a different problem.

### Fallback

WebGPU availability is good on desktop Chrome, Edge and Safari 26+, and weaker
elsewhere. Measured 2026-08-19 on macOS: `navigator.gpu` is present in **all
three** of Chrome 151, Safari 26.5 and Firefox 153 — but Firefox rejects
`rgba16float` canvas configuration, so _WebGPU present_ and _HDR possible_ are
different questions and must be probed separately. The WebGL path is **retained as a reduced-fidelity fallback**, not deleted:
no compute terrain, simpler atmosphere, fewer instances, lower LOD ceiling. The
game must remain playable on it, because "it's a link" is the pitch and a link
that fails is worse than an install.

---

## Performance budgets

**Target: 60 fps at 1920×1080 on a 2023-class laptop with integrated or entry
discrete graphics.** That is the machine the audience actually has, and a browser
game that requires a desktop GPU has given up its only distribution advantage.

### Frame budget — 16.6 ms

| Stage                     | Budget | Notes                                                                                            |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| Simulation ticks          | 0.5 ms | 64 Hz fixed; typically 0–2 ticks per frame. Currently far under.                                 |
| Snapshot + scene build    | 1.5 ms | Plain-data; already measured cheap                                                               |
| Terrain reconciliation    | 1.0 ms | Upload and swap only; generation is off-thread                                                   |
| Culling + draw submission | 2.5 ms | Target: GPU-driven, so this falls with WebGPU                                                    |
| GPU — geometry            | 5.0 ms |                                                                                                  |
| GPU — atmosphere + post   | 3.0 ms | The atmosphere integral is the expensive one — and **a direct raymarch does not fit**, see below |
| Headroom                  | 3.1 ms | Non-negotiable; the budget is 80%, not 100%                                                      |

### The atmosphere does not fit the budget at any language

The measurement that came out of [spike 2](../spikes.md#2--tsl-and-the-atmosphere-integral)
sideways, and it is the more important half of it:

**7.274 ms for 256 samples per pixel at 1080p on an Apple M5** — a GPU far above
the target machine — is already **2.4× over this table's 3.0 ms line**. Scaled to
fit, the budget buys about 105 samples per pixel, roughly 16 view × 6 light, which
is not enough for a clean horizon.

So **Bruneton's precomputed transmittance and multiple-scattering LUTs are a
requirement, not an optimisation.** The spike asked whether TSL could express the
integral cheaply enough; it can, and the integral still cannot be evaluated
per-pixel per-frame in any language. Budget for LUT precomputation and its
invalidation policy at M2, not for a faster inner loop.

### Other budgets

> **Where these numbers come from now.** The dev dock's **perf** tab (`P`) plots
> frame period, engine time, ticks per frame, draw calls, worker queue depth and
> JS heap over a four-second window, with a `measure gpu` button that times GPU
> frames the way [spike 2](../spikes.md#2--tsl-and-the-atmosphere-integral) says
> to — wall clock across a drained queue, never
> `renderer.info.render.timestamp`. The right-hand column below is what it read
> on 2026-08-20.
>
> **Read the machine before the numbers.** They were taken on an Apple M5 in a
> 1000×760 window at devicePixelRatio 2 — a GPU far above the target machine and
> about a third of the target's pixels. They establish that the instrument works
> and that nothing is pathological; they are not evidence that the budget is met
> on a 2023-class laptop at 1920×1080, and the row that matters most — cold load
> — is still unmeasured.

| Budget                                         | Target                                | Current                                                                                                              |
| ---------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Cold load to interactive                       | ≤ 4 s on a 20 Mbit connection         | Unmeasured                                                                                                           |
| Client bundle, gzipped                         | ≤ 900 KB with code splitting          | **541.4 KB gzip / 412.7 KB brotli**, measured 2026-08-21, no splitting                                               |
| Catalogue, 150 ly, over the wire               | Was a guess at ~2 MB                  | **159 KB brotli**, measured — [spike 3](../spikes.md#3--catalogue-bundle-size)                                       |
| Material sets, per biome                       | ≤ 12 MB                               | —                                                                                                                    |
| Peak JS heap                                   | ≤ 900 MB                              | **66–74 MB** across orbit, approach and surface                                                                      |
| Terrain patch generation                       | ≤ 8 ms per patch per worker           | Measured; within                                                                                                     |
| Worker queue latency, p95                      | ≤ 40 ms                               | Instrumented and plotted; still unmeasured _under load_                                                              |
| GPU, whole frame                               | (within the 5.0 + 3.0 ms lines above) | **1.85–2.70 ms** on an M5 at 1000×760                                                                                |
| Engine — ticks, snapshot, scene build, terrain | 3.0 ms (sum of the first three lines) | **0.19–0.23 ms**                                                                                                     |
| Save size                                      | ≤ 4 KB                                | 696 bytes today                                                                                                      |
| Draw calls                                     | ≤ 1,200                               | **10–17** — the scene is spheres and one instanced star field, so this says more about the content than the renderer |

> 🎮 Designer's Note: The right-hand column used to be mostly "unmeasured", and
> the first thing the instrument found was not a budget overrun. It was that
> **time warp did not work**: the simulation clock capped every frame at eight
> ticks, which is 7.5× real time at 60 fps, so of the seven detents the dock
> offers — 1× to 100,000× — everything past 5× ran at the same speed and the
> difference went into a `droppedTicks` counter nothing displayed. It had been
> that way since the clock was written and no amount of playing found it,
> because the only symptom was a number that did not do anything.
>
> That is the argument for the harness, made better than the argument could be.
> An overlay is not a nicety for a project whose defects are shaped like this
> one — a plot that showed _requested against delivered_ would have shown it on
> the first afternoon.

---

## Browser-specific constraints

The ones that will actually cause problems, with what they force.

| Constraint                                                | Consequence                                                                                                                                                           | Mitigation                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No `SharedArrayBuffer` without cross-origin isolation** | Worker results must be copied or transferred, not shared                                                                                                              | Transferables already used; COOP/COEP headers are available if it becomes necessary, at the cost of embedding third-party content                                                                                                                                                   |
| **Tab backgrounding throttles timers**                    | A returning tab could try to run thousands of ticks                                                                                                                   | **Already solved** — a step budget in the clock, in exactly one place                                                                                                                                                                                                               |
| **Memory pressure kills the tab, silently**               | A long session in a dense system is the risk case                                                                                                                     | Hard caps on streamed patch count and instance buffers; measure before M2                                                                                                                                                                                                           |
| **WebHID is Chromium-only**                               | Full-fidelity HOTAS exists in Chrome and Edge and nowhere else; Mozilla's position is _negative_ and Safari has not shipped it                                        | Measured — [spike 5](../spikes.md#5--webhid-and-gamepad-for-hotas). Gamepad API everywhere as the floor; **name the browser when promising HOTAS**. See [ux](ux.md#controls).                                                                                                       |
| **Gamepad API caps at 16 axes / 32 buttons**              | A many-button HOTAS silently loses inputs: on macOS Chromium indexes buttons by HID usage and drops any usage above 32 without reporting it                           | WebHID for those devices. Do not build binding UI that assumes `gamepad.buttons` is the device's real button set.                                                                                                                                                                   |
| **Audio requires a user gesture**                         | First sound must follow an interaction                                                                                                                                | The FTUE's `POWER` prompt is the gesture, by design                                                                                                                                                                                                                                 |
| **No filesystem**                                         | Saves are IndexedDB; export is a download                                                                                                                             | Already handled; export/import of the 696-byte save is trivial and should be exposed                                                                                                                                                                                                |
| **Shader compilation stalls**                             | A first-frame hitch when entering a new visual state                                                                                                                  | Pre-warm pipelines during the [jump tunnel](flight.md#jump) — which is the one place the game has six spare seconds. Measured: an atmosphere-class pipeline builds in ~1 ms warm, but the **first** compile of a session cost 8.5 ms, so the warm-up is per-session, not per-shader |
| **HDR display detection does not work**                   | Chrome and Safari report `(dynamic-range: high)` for a 2×-headroom laptop panel; Firefox reports `false` for the same display and cannot output extended range at all | Measured — [spike 1](../spikes.md#1--hdr-display-detection). `auto` is a **capability probe**, not a media query; the tone curve must be headroom-agnostic; the three-state override is mandatory.                                                                                  |

---

## Required engineering, by area

Nothing here is architectural. Everything lands on a seam that already exists.

| Area           | Work                                                                                                 | Seam                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Terrain**    | Quadtree LOD, geomorphing, edge stitching, cube-face wrapping, materials                             | `terrainLevelFor` already returns a level; the streamer needs per-patch levels                                |
| **LOD**        | Hysteresis, cross-fade, sphere-derived impostors                                                     | `selectLod` takes the current tier as a new input — see [art](art.md#continuity--the-no-pop-in-specification) |
| **Streaming**  | Predictive loading, per-frame generation budget, a spatial index for interest                        | `updateInterest`; `systemsWithin` already bounds and refuses oversized queries                                |
| **Simulation** | Move to a Web Worker when entity counts rise                                                         | Mechanical, not architectural — the snapshot is already structured-cloneable                                  |
| **Replay**     | An input log of `(tick, entityId, controlInput)` plus a driver                                       | Everything else exists: canonical tick, state hash, persisted input                                           |
| **Catalogue**  | The [ingest pipeline](galaxy.md#ingest-pipeline) and catalogue versioning in the generation manifest | `algorithm()` and `manifest()` already version generation                                                     |
| **Character**  | A controller attached kinematically to a rotating surface frame                                      | The same approach `flight.ts` takes for a landed ship                                                         |
| **Automation** | ~~CI~~ ✅ · a stored save fixture, performance regression tests, a formatter                         | CI runs `pnpm check` plus the capability self-test on every PR                                                |

---

## Third-party dependencies

Deliberately few, and the list should be read as a commitment rather than an
inventory.

| Dependency                                   | Layer                | Note                                                                                                                                                                              |
| -------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three.js                                     | `apps/game` only     | Never below the app layer; `pnpm graph` enforces it. Imported as `three/webgpu` and `three/tsl` — both share `three.core.js`, so class identity holds across the two entry points |
| React + React Three Fiber                    | `apps/game` only     |                                                                                                                                                                                   |
| Vite, Vitest, oxlint, TypeScript, fast-check | Tooling              |                                                                                                                                                                                   |
| `@webgpu/types`                              | Tooling, `apps/game` | Types only. Arrives transitively through `@types/three` as well; named explicitly because that reference is three's to remove                                                     |
| **Nothing else**                             |                      | No physics library, no networking SDK, no analytics, no telemetry, no vendor SDK anywhere in `packages/*`                                                                         |

The absence of a vendor SDK in the package graph is
[ADR-0008](../adr/0008-multiplayer-partitions.md)'s explicit requirement and is
enforced by the layer check. It should survive the persistent universe.

---

## Related

- [art](art.md) — the rendering doctrine this must deliver
- [production](production.md) — when each item lands
- [`docs/architecture.md`](../architecture.md) — the system as built
- [`docs/roadmap.md`](../roadmap.md) — the engineering gap list this draws from
