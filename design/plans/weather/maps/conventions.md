# Map: conventions and gates for new render code, and the TSL idioms in this repo

Area: what a new render module (the weather plan's passes, kernels, materials)
must do to pass this repository's gate and to read like the code around it.
Tree: `/Users/jonjaques/.t3/worktrees/inertialref/t3-e896a8db` at `c2a50f1`
(three `0.185.1`, `@types/three` `0.185.4`, `webgpu` (Dawn) `0.6.2`,
`@webgpu/types` `0.1.74`). Paths are relative to that root; three's sources are
under `node_modules/.pnpm/three@0.185.1/node_modules/three/`. Line numbers are
as of this tree. "Inference" marks anything not read directly off the code.

Plan sections this serves: `design/plans/the-weather.md` §3 last bullet (one GPU
job; compile-ahead through `render/warmup.ts`, rule 61; every pass through
`runQuadPasses`), §5.2 last bullet (every read inside a loop names its level),
§12 "three r185" (a plain read in a loop is undefined; `Storage3DTexture` mips;
`r8unorm` storage needs tier 1; no f16 from TSL; MRT 32 bytes a sample; a quad's
camera nodes are the quad's; reversed depth reverses the draw list;
compile-ahead through `warmCompile`).

---

## 0. The ten things that fail first

1. **A `.sample()` inside a fragment-stage loop that can exit early is
   undefined on Chrome.** three prepends `diagnostic( off, derivative_uniformity );`
   to every WGSL module unless the user agent matches `Firefox|Deno`
   (`three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js:245-251`), so Tint
   accepts an implicit-derivative `textureSample` in non-uniform control flow
   and the result is undefined. Write `.sample(uv).level(float(0))`
   (`render/galaxyTemporal.ts:114,129,157`; `render/galaxyStructure.ts:51-53`,
   which `render/galaxyKernel.ts:621-658` reads inside `Loop` + `Break`).
   Outside the fragment stage (compute, vertex) the builder already emits
   `textureSampleLevel(…, 0)` (`WGSLNodeBuilder.js:343-411`).
2. **`Loop`, `If`, `.toVar()` and the accumulators must be inside a `Fn`.**
   Built at material scope they are never emitted; the graph compiles cleanly
   and draws a vacuum (`render/air.ts:261-264`, `render/planet.ts:579-586`).
3. **Nested `Loop`s need named indices.** A nested single-parameter `Loop`
   declares its own `i`, and the outer index read inside silently becomes the
   inner one (`render/terrainKernel.ts:180-185`; the module-local helper
   `loop(name, bounds, type, body)` at `:815-824` is not exported).
4. **A stand-in `DataTexture` left at its nearest default freezes the program
   at `textureLoad` with no sampler** (rule 56); **two texture nodes over one
   texture object compile to one binding** (rule 57). Both are invisible until
   the real map is bound.
5. **A compile that walked nothing resolves like one that built everything.**
   `compileAsync` skips invisible objects and frustum-culls; only
   `warmCompile` / `warmRenderer` / `warmSensorPass` / `warmPipeline` in
   `render/warmup.ts` handle that (rule 61), and a warm against the wrong
   attachment shape builds a pipeline nothing draws with.
6. **Inside a `QuadMesh` pass the TSL camera nodes are the quad's
   orthographic camera.** The scene camera reaches a quad only as uniforms
   (`render/galaxyTemporal.ts:51-60`, `render/galaxyVolume.ts:119-126`).
7. **`QuadMesh` has `v = 0` at the top of its attachment;** the GPU harness's
   `drawGraph` and a `PlaneGeometry` have `v` up (`render/galaxyVolume.ts:206-213`,
   `render/gpuHarness.ts:424-436`). `galaxyOrientation.gpu.test.ts` holds the
   galaxy's composed rows to the CPU ray.
8. **The scene MRT is nearly full.** No `requiredLimits` is passed
   (`render/createRenderer.ts:180-193`), so `maxColorAttachmentBytesPerSample`
   is the default 32. Inference from the WebGPU format table: the temporal
   layout (`output` rgba16float, `motion` rgba16float, `meterMask` r8unorm,
   `velocity` rg16float, `reactive` rgba8unorm; `render/sceneLayout.ts:92-105`)
   already costs 30 bytes a sample with alignment, leaving 2. Verify on the
   device before planning an attachment (§11).
9. **`pnpm test:gpu` is not in the gate.** The Stop hook never runs a shader.
   Run the GPU file yourself (it takes the GPU lock, rule 68) before claiming
   a graph works; CI runs the suite on a paravirtual Metal device.
10. **`packages/devtools/src/observatory.ts` scores 90.91 against an fta cap of 91.** Almost any growth there fails `fta:check`; keep weather logic out of
    it and out of `engine/GameEngine.ts` (82.81).

---

## 1. The gate: what runs, when, and what fails

### 1.1 The Stop hook — `.claude/hooks/gate.mjs`

- Registered in `.claude/settings.json` under `hooks.Stop` (`timeout: 900`).
- Runs only if `.claude/.cache/dirty-source` exists (`gate.mjs:97`). The format
  hook writes that marker for an edit to `*.ts | *.tsx | *.mjs | *.json` through
  `Edit|Write|NotebookEdit` (`.claude/hooks/format-edited.sh:42-49`). Markdown
  and CSS do not trigger it; a file changed through the shell never sets it.
- Claims the marker by rename (`dirty-source` → `gate-source`); refuses to judge
  a checkout with no `node_modules` (`gate.mjs:112-118`).
- Runs `node <session cwd>/scripts/check.mjs --only gate --json` with an 840 s
  timeout (`gate.mjs:72,188-199`) — the session's own checkout, so a worktree
  gates itself and stamps its own tree.
- On a red stage it exits 2 with the stage's tail (≤ 6,000 chars) and names the
  command `pnpm check --only <stage>`. At most `MAX_BLOCKS = 3` blocks per prompt
  (`gate.mjs:69`; counter in `.claude/.cache/gate-<session>.json`), then it
  lets go and asks you to say the gate is red.
- `IR_SKIP_GATE=1` disables it (`gate.mjs:94`).

### 1.2 The format hook — `.claude/hooks/format-edited.sh`

- PostToolUse on `Edit|Write|NotebookEdit`: `prettier --write` on
  `*.ts *.tsx *.js *.jsx *.mjs *.cjs *.json *.jsonc *.css *.md *.html *.yml *.yaml`
  (`format-edited.sh:32-38`), with prettier resolved from the session checkout.
- `.prettierrc.json`: `semi: false`, `singleQuote: true` (prettier 3 defaults
  otherwise: 80 columns, trailing commas). `.prettierignore` skips
  `.claude/skills/webgpu-threejs-tsl/`, `.scratch/`, `data/reference/`,
  `apps/server/.cloudflare/`, `apps/server/.wrangler/`.
- Do not run `pnpm format` or `pnpm lint` after tool edits. Do run
  `node_modules/.bin/prettier --write <paths>` on anything written by a shell
  command, a generator or a script (`CLAUDE.md` § "Edits are formatted for you").

### 1.3 `scripts/check.mjs` — the stages

One graph under `availableParallelism()` cores. A passing stage is stamped in
`.data/check/<stage>.json` with a key of the working tree's content, the Node
version and the stage's argv (`check.mjs:364-451`); a later run on a
byte-identical tree reuses it. `--force` ignores stamps; `--list` prints them.

| Stage                     | Command                                                                         | In `gate` |
| ------------------------- | ------------------------------------------------------------------------------- | --------- |
| `graph`                   | `pnpm graph` → `scripts/check-graph.mjs`                                        | yes       |
| `knip`                    | `pnpm knip:check` (`--include files,dependencies,unlisted,unresolved,cycles`)   | yes       |
| `fta`                     | `pnpm fta:check` = `fta . --score-cap 91`                                       | yes       |
| `lint`                    | `pnpm lint` = `oxlint`                                                          | yes       |
| `typecheck:core`          | `node_modules/typescript7/bin/tsc -p tsconfig.json`                             | yes       |
| `typecheck:game`          | `… -p apps/game/tsconfig.json`                                                  | yes       |
| `typecheck:headless`      | `… -p apps/headless/tsconfig.json`                                              | yes       |
| `typecheck:server`        | `… -p apps/server/tsconfig.json`                                                | yes       |
| `typecheck:ingest`        | `… -p apps/ingest/tsconfig.json`                                                | yes       |
| `typecheck:astro`         | `pnpm --filter @inertialref/game check`                                         | yes       |
| `test`                    | `pnpm test` = `vitest run` (root `vitest.config.ts`)                            | yes       |
| `format`                  | `pnpm format:check` = `prettier -c .`                                           | no        |
| `spelling`                | `pnpm spelling:check`                                                           | no        |
| `brand`                   | `pnpm brand:check`                                                              | no        |
| `presets`                 | `pnpm presets:check`                                                            | no        |
| `slow`                    | `pnpm test:slow` (`apps/game/vitest.slow.config.ts`)                            | no        |
| `sim`                     | `node apps/headless/src/main.ts --self-test` (twelve capability checks)         | no        |
| `media`, `docs`, `bundle` | optional media pull, `pnpm docs:build`, `pnpm --filter @inertialref/game build` | no        |

`GROUPS.gate` is `check.mjs:260-270`; `pnpm typecheck` is `check.mjs --only
typecheck` (the six type stages). `pnpm test:gpu` is in **no** stage. CI
(`.github/workflows/check.yml`) runs `pnpm check` on `ubuntu-latest` and a
separate `gpu` job, `pnpm test:gpu` on `macos-15` — a paravirtual Apple GPU with
no `timestamp-query`, whose adapter `scripts/gpuAdapter.mjs` prints into the job
summary; that job checks out without LFS, so no `*.gpu.test.ts` may read a
model or a plate.

### 1.4 Type projects and the compiler flags code must satisfy

| Project                       | Covers             | Lib / types                                                                                                                        |
| ----------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `tsconfig.json`               | `packages/*/src`   | `lib: ["ES2023"]`, `types: []` — no DOM, no Node                                                                                   |
| `apps/game/tsconfig.json`     | the client         | ES2023 + DOM + DOM.Iterable + WebWorker; `node`, `vite/client`, `@webgpu/types`; `jsx: react-jsx`; `paths: { "@/*": ["./src/*"] }` |
| `apps/headless/tsconfig.json` | the Node runner    | Node types                                                                                                                         |
| `apps/server/tsconfig.json`   | the Worker         | workerd + `.cloudflare/types/index.d.ts`                                                                                           |
| `apps/ingest/tsconfig.json`   | offline builds     | Node types                                                                                                                         |
| (`astro check`)               | `.astro` templates | —                                                                                                                                  |

`tsconfig.base.json` flags, and what each costs a render module:
`allowImportingTsExtensions` (import `./quadPass.ts` with the extension;
hand-written code imports relatively — `@/` is for the shadcn registry);
`verbatimModuleSyntax` (`import type` / inline `type` for types);
`erasableSyntaxOnly` (no `enum`, no constructor parameter properties, no runtime
`namespace` — `const` objects and unions); `strict`; `noUncheckedIndexedAccess`
(array reads are `T | undefined`: the code writes `this.#history[0]!` or
`data[i] as number`); `noImplicitOverride` (`override updateBefore`,
`override setup`, `override dispose` on a `TempNode`); `noImplicitReturns`;
`noUnusedLocals`; `noUnusedParameters` (prefix an unused parameter `_`, as
`(_origin, direction) =>` in `galaxyTemporal.gpu.test.ts:15`);
`noFallthroughCasesInSwitch`.

### 1.5 `pnpm graph` — layering (`scripts/check-graph.mjs`)

Layers, from each `package.json`'s `inertialref.layer`: `shared` 0;
`procedural`, `spatial` 1; `physics` 2; `universe` 3; `simulation`,
`protocol` 4; `net`, `persistence`, `rendering`, `workers` 5; `devtools` 6.
A package depends only on strictly lower layers. The script also fails on:

- **any third-party runtime dependency in `packages/*`** (`check-graph.mjs:48-54`)
  — the mechanical half of "`packages/rendering` must not import three"; an
  undeclared `three` import there would instead fail `knip:check` (unlisted)
  and `typecheck:core` (no DOM types);
- an `@inertialref/<pkg>/node` import in `apps/game/src`, `apps/game/astro` or
  `apps/server/src` (`:87-116`);
- a cycle between packages (`:118-137`). A cycle **inside** a package is knip's
  `cycles: "error"` (`knip.jsonc` header), and a module-scope read across one is
  a TDZ `ReferenceError` (`apps/headless/src/moduleGraph.test.ts`).
  `render/sceneTarget.ts` exists to break a `sensor.ts` ↔ `warmup.ts` cycle
  (`sceneTarget.ts:8-13`).

`apps/game` depends on every package plus `three`; `apps/headless` and
`apps/ingest` may import `@inertialref/rendering`. So the weather's pure
arithmetic — step schedules, shell intersections from heights, period
reductions, budget sizing, history validity — is testable in plain Node if it
lives in `packages/rendering` (layer 5: may import `universe`, `simulation`,
`spatial`, `procedural`, `shared`) or in a three-free file under
`apps/game/src/render/` (`bodyUniforms.ts` is that pattern: no three import,
`bodyUniforms.test.ts` beside it).

### 1.6 `knip:check`

Fails on unused **files**, unused or unlisted **dependencies**, **unresolved**
imports and **cycles**; never on unused exports (`knip.jsonc` header). Entries
that make a file "used": `apps/game` — `astro/pages/**/*.astro`, `public/sw.js`,
`src/render/gpuSetup.ts`, `src/workers/universe.thread.ts`, its three config
files, `src/**/*.test.{ts,tsx}`; `packages/*` — `src/index.ts`,
`src/**/*.test.ts`, `node/**/*.test.ts`; `apps/ingest` — `src/main.ts` and its
tests. A new `packages/rendering/src/x.ts` needs an `export * from './x.ts'` line
in `packages/rendering/src/index.ts` before the app can reach it (its test alone
keeps knip quiet). A new dependency goes in the package that imports it.

### 1.7 `fta:check` — the complexity cap

`fta.json`: `output_limit: 25`, `exclude_under: 25`, `extensions: [".mjs"]`. The
cap is 91, "one above the worst file", and is lowered when the worst file
improves; a data table past it is a filename exclusion with its reason, never a
higher cap (`check.mjs:118-129`, `docs/guides/development.md:142-170`). fta
counts code, not comments. Measured on this tree (`fta . --json`; lines are
fta's code lines):

| File                                          | Score | cyclo | lines |
| --------------------------------------------- | ----- | ----- | ----- |
| `packages/devtools/src/observatory.ts`        | 90.91 | —     | 1253  |
| `apps/game/src/render/terrainKernel.ts`       | 85.54 | 21    | 2314  |
| `packages/devtools/src/harness.ts`            | 84.41 | —     | 1214  |
| `apps/game/src/engine/GameEngine.ts`          | 82.81 | 108   | 987   |
| `apps/game/src/render/starExtinctionCache.ts` | 79.42 | 114   | 747   |
| `apps/game/src/render/terrain.ts`             | 75.65 | 6     | 695   |
| `apps/game/src/render/galaxyKernel.ts`        | 73.12 | 22    | 815   |
| `apps/game/src/scene/Bodies.tsx`              | 72.92 | 70    | 594   |
| `apps/game/src/render/planet.ts`              | 71.59 | 5     | 470   |
| `apps/game/src/render/galaxyVolume.ts`        | 70.35 | 68    | 502   |
| `apps/game/src/render/water.ts`               | 69.16 | 7     | 422   |
| `apps/game/src/render/sensor.ts`              | 68.26 | 54    | 452   |

Tests are scored too (`terrainKernel.gpu.test.ts` 75.20,
`materials.gpu.test.ts` 72.18). Inference: a 2,300-line kernel scores about 85,
so a cloud march, its history and its composite want separate modules rather
than one file, and the harness and observatory files have almost no room.

### 1.8 `oxlint` (`.oxlintrc.json`)

Plugins `react`, `typescript`, `oxc`; type-aware rules off.
`react/rules-of-hooks: error`, `react/only-export-components: warn`
(`allowConstantExport`), `react/no-multi-comp: error` (rule 44); both of the
last two are off for `apps/game/src/components/ui/*.tsx`. There is no import
restriction: **rule 60 (`three/webgpu`, never `three`) is enforced by review
only.** Nothing greps for `from 'three'`, and `apps/game/package.json` lists
`three`, so the wrong import type-checks and builds.

### 1.9 `spelling:check` (full check, not the gate)

`scripts/spelling/dictionary.mjs` rejects British **identifier declarations**;
prose is review. Weather-shaped traps in its table: `vapour`, `grey`,
`sulphur` / `sulphate` (Venus's sulfuric deck), `metre`, `litre`, `colour`,
`centre`, `neighbour` (a 3 × 3 neighborhood), `artefact`, `behaviour`,
`favour`, `modelling` / `modelled`, `levelled`, `labelled`, `analyse`, and the
`-ise` stems `normalis`, `quantis`, `discretis`, `parameteris`, `polaris`,
`linearis`, `stabilis`, `optimis`, `initialis`, `characteris`, `visualis`,
`synthesis(e)`.

---

## 2. Invariants that bind a new render module

Canonical list `AGENTS.md:55-122`; full text `docs/agents/invariants.md`.

| Rule   | Imperative (AGENTS.md line; invariants.md line)                                                              | What it means for weather code                                                                                                                                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2      | No `Math.random` / `Date.now` / `performance.now` in canonical code (56)                                     | Weather is presentation, but a preset must reproduce its sky (plan §3): jitter comes from a frame index or a blue-noise phase, never `Math.random`. `performance.now()` is legal under `apps/` for timing.                                                                                                                                                                      |
| 3      | `console.timeStamp`, `performance.mark`, `performance.measure` only in `engine/browserTiming.ts` (57; 108)   | Emit through `getTimer('game.render')` and `timer.measure(label, start, end, RENDER_PHASE)` behind `if (timer.on)`; properties only under `timingDetailed()`; labels are constants (`.claude/rules/timing.md`). `galaxyVolume.ts:470,500-515` is the worked example. Under `packages/` nothing may name `performance.` (`apps/headless/src/coreHostApis.test.ts` greps for it). |
| 8      | `Worker` only in `engine/browserWorker.ts` (62; 156)                                                         | A CPU-side map or atlas bake goes through the pool as a typed, versioned task: `defineTask({ name, version, run, transfers })` (`docs/guides/extending.md:121-150`); a payload change without a version bump is the trap.                                                                                                                                                       |
| 15     | Never persist anything regenerable (69; 219)                                                                 | The weather is a cache of a function of time; nothing enters a save (plan §3).                                                                                                                                                                                                                                                                                                  |
| 21     | React Compiler must not memoize a component reading mutable state (75; 254)                                  | A dock panel or HUD readout of weather diagnostics reads engine fields → `'use no memo'` (`hud/PerfPanel.tsx:62`). Not license to hand-write `useMemo`.                                                                                                                                                                                                                         |
| 44     | One component per file (98; 495)                                                                             | `scene/Clouds.tsx` holds one component; its constants and types go in a sibling `.ts`.                                                                                                                                                                                                                                                                                          |
| 46, 47 | New `docs/*.md` listed in `scripts/docs/wings.mjs`; plans only in `design/` (100-101; 506, 517)              | An ADR per landed phase; the plan loses that section.                                                                                                                                                                                                                                                                                                                           |
| 52     | No two planetary radii subtracted in a shader; no screen-space derivative of a planetary position (106; 562) | Shell entry and exit from heights resolved on the CPU (`cloudShellAltitude`); for example `r² − R_s² = (h − h_s)(2R + h + h_s)` is the cancellation-free form of the discriminant (inference). Fades by distance × the lens's pixel angle, never `dFdx(local)`.                                                                                                                 |
| 53     | Drawn vs canonical ground (107; 580)                                                                         | A cloud base or fog read off the ground reads the drawn field; nothing canonical reads the weather.                                                                                                                                                                                                                                                                             |
| 56     | No stand-in `DataTexture` at its nearest default (110; 630)                                                  | Every texture node a weather material binds before its data exists starts on a 1×1 (or 1×1×1) stand-in with `magFilter = minFilter = LinearFilter`, of the same filterability as the real texture — half float, not float (§3.5).                                                                                                                                               |
| 57     | Never build two texture nodes over one stand-in object (111; 649)                                            | One stand-in object per node, and one per role across every material (`air.ts:116-119`). It holds for any texture object: two nodes over one history texture compile to one binding.                                                                                                                                                                                            |
| 58     | No fine lattice coordinate from an absolute float32 direction; no lattice decision in a float (112; 665)     | Noise lattices read an anchor-split or tile frame formed in float64 (`groundWear.ts:280-322`); a cyclone or cell exists when a `u32` hash is under a threshold the CPU computes.                                                                                                                                                                                                |
| 59     | No shading term on the ground without the sphere (113; 687)                                                  | Cloud shadow and light (`cloudSunlight`, phase 2) land in `render/terrain.ts`, `render/water.ts` and `render/planet.ts` in one change. Today the sphere has `cloudShade = 1 − cover · cloudShadow` (`planet.ts:463-464`); `terrain.ts` and `water.ts` contain no cloud term at all (no match for `cloud`).                                                                      |
| 60     | Never import `three` in `apps/game` (114; 708)                                                               | `three/webgpu` and `three/tsl` only; `packages/*` import no three at all. Not mechanically enforced (§1.8). `three/addons/...` appears only for loaders.                                                                                                                                                                                                                        |
| 61     | Never hand-write a compile-ahead (115; 713)                                                                  | `warmCompile` / `warmRenderer` / `warmSensorPass` / `warmPipeline`, registered with `warmAtMount` / `register` / `trackAtMount` (§3.8).                                                                                                                                                                                                                                         |
| 65     | A readout neither changes the frame nor stops it (119; 745)                                                  | A weather `report` or `diagnostics` getter never throws, never writes renderer state, and reports `bytes: 0` after dispose (`galaxyTemporal.ts:188-204`).                                                                                                                                                                                                                       |
| 68     | GPU work holds the machine's GPU lock (122; 790)                                                             | A new GPU runner (a phase-0 sweep script) takes `acquire()` from `scripts/gpuLock.mjs` before its first GPU work and keeps it until its last GPU process is gone; `pnpm test:gpu` and `scripts/drive.mjs` already hold it. A refusal is a stop.                                                                                                                                 |

Also binding, from `.claude/rules/rendering.md`: presentation uses the
snapshot's instant — `clock.renderTime`, or the observatory's held instant,
which `snapshot()` passes through as `renderTime`
(`packages/simulation/src/snapshot.ts:280-292`) and which reaches materials as
`BodyFrame.renderTime` (`bodyUniforms.ts:46-47`); `figure: null` means round,
and the shells are on the figure's side of `bodyUniforms`' one branch
(`shellFlattening`, `bodyUniforms.ts:346-348`); compression is radial about
the eye; a varying never takes an attribute's name; the ground and the sphere
shade alike.

---

## 3. TSL idioms in `apps/game/src/render`

### 3.1 Imports and node types

- Classes, constants and types come from `three/webgpu` (`Mesh`,
  `NodeMaterial`, `MeshBasicNodeMaterial`, `QuadMesh`, `RenderTarget`,
  `DataTexture`, `Data3DTexture`, `StorageBufferAttribute`,
  `StorageInstancedBufferAttribute`, `TempNode`, `NodeUpdateType`,
  `HalfFloatType`, `LinearFilter`, `type Node`, `type WebGPURenderer`); node
  functions from `three/tsl` (`Fn`, `If`, `Loop`, `Break`, `select`, `uniform`,
  `texture`, `texture3D`, `cubeTexture`, `storage`, `instanceIndex`,
  `textureLoad`, `uv`, `vec2`..`vec4`, `float`, `uint`, `int`, `exp`, `mix`, …).
  Named imports, never `import * as THREE`.
- Types are `Node<'float'>`, `Node<'vec3'>`, …; `@types/three` 0.185 declares
  the operators on those and not on `Node` (ADR-0030 § Context). Where the
  typings are narrower than WGSL, re-narrow in one place:
  `asVector` / `asField` / `mixPerChannel` / `maxInt` in `render/noiseNodes.ts:47-77`;
  `terrainKernel.ts:795-809` keeps `F/U/I/V2/V3/V4/Bool` aliases with `asF…`.
- `attribute<'vec3'>('name', 'vec3')` and
  `instancedBufferAttribute<'vec3'>(attribute, 'vec3')`: the type argument is
  load-bearing, because the type parameter is unconstrained
  (`terrain.ts:508-515`, `plumes.ts:241-256`).

### 3.2 Materials

- Scene objects: `MeshBasicNodeMaterial` with `colorNode` (and `opacityNode`,
  `positionNode`), wrapped once by
  `sensorRadiance(material, overlay = false, instrument = false, reactive = …)`
  (`render/radiance.ts:95-112`), which sets `outputNode` to
  `vec4(output.rgb.mul(sceneRadianceGain).min(65_504), output.a)` and writes the
  MRT properties `MotionOverlay`, `MeterOverlay` and `ReactiveCoverage`
  (`render/sensorMrt.ts:38-40`). A translucent shell passes `reactive: 'alpha'`
  (the deck, `planet.ts:753-758`); ADR-0044 says who writes what (opaque 0;
  atmosphere, clouds and rings their alpha; water 0.3; overlays 1).
- Offscreen quads: `new NodeMaterial()` with `fragmentNode` and a `name`, drawn
  by a `QuadMesh` through `runQuadPasses` (§3.8). No `sensorRadiance`: the
  radiance stays physical and linear (`linear: true`).
- One graph per archetype; per-body difference is uniforms and bindings, so 130
  bodies compile once (`planet.ts:57-65`). A quality step that changes the
  program is a second material, never a uniform (`water.ts` builds `FULL_SEA` and
  `PLAIN_SEA`, `:268-269`), because a value swap rebuilds nothing.
- Translucent: `transparent = true`, `depthWrite = false` (`planet.ts:771-772`).
- Vertex work and varyings: `material.positionNode = Fn(() => { …; v.assign(x); return moved })()`
  with each varying declared `varying(vec3(), 'terrainShaded')` under a name no
  attribute has (`terrain.ts:489-535`). `positionPrevious.assign(moved)` keeps
  the velocity attachment honest for a moved vertex (`terrain.ts:525-528`).

### 3.3 `Fn`, control flow and loops

- `Fn(() => { … })()` produces the node; statements exist only inside it
  (§0 item 2). `Fn((builder) => …)()` decides at build time from the renderer:
  `sceneFarDepth` (`render/sceneDepth.ts:12-14`), the WebGL miss in
  `landReflection` (`seaReflection.ts:318-320`).
- Named WGSL functions: `Fn(([h]: [Node<'uint'>]) => …).setLayout({ name, type, inputs })`
  (`noiseNodes.ts:197-234`; `latticeNoise` `:280-356`); a test can then assert
  `fragmentShader.toContain('latticeNoise')` (`materials.gpu.test.ts:179-181`).
  `wgslFn(code, uses(...))` for bit-exact primitives (`terrainKernel.ts:197-228`).
- `If(cond, () => …).Else(() => …)`; `select(cond, ifTrue, ifFalse)` or
  `cond.select(a, b)`. Keep a nested branch's result in an outer
  `vec4(0).toVar()` assigned inside the branches — GLSL loses outer variables in
  a nested select's isolated branches (`galaxyTemporal.ts:161-174`).
- `Loop(count, ({ i }) => …)`; an early exit is `If(done, () => { Break() })` at
  the top of the body (`galaxyKernel.ts:621-624`, `seaReflection.ts:365-375`).
  Name nested loops (§0 item 3).
- A constant array indexed by a runtime value spills to the stack on Metal:
  85 ms against 19 ms for the same work as bit arithmetic (`noiseNodes.ts:186-196`).
- Mutable values: `.toVar()`, then `.assign`, `.addAssign`, `.mulAssign`
  (`air.ts:278-346`). A JS reassignment of a node variable inside `If` is
  invisible to TSL (the skill's `docs/compute-shaders.md` § CRITICAL).
- A step's light is its integral over constant density, with a series below
  τ = 0.01 where the subtraction cancels in float32: `stepShare`
  (`air.ts:351-373`) — the plan's §5.2 bullet, already written once.

### 3.4 Uniforms, and how CPU float64 reaches them

- Declared once per material or module: `uniform(0)`, `uniform(1, 'uint')`,
  `uniform(new Vector3())`, `uniform(new Vector2(1, 1))`, `uniform(new Color())`;
  written as `.value = n` or `.value.set(...)` / `.copy(...)`.
- Per-frame writes compare first (`scene/Bodies.tsx:785-803`: `setNumber`,
  `setColor`, `setVector`), because a write that changes nothing is pure cost.
- Shared, renderer-resolved uniforms: `uniform(0).onRenderUpdate(({ renderer }) => …)`
  (`radiance.ts:11-35`). Per object: `uniform(new Vector3()).onObjectUpdate(({ object }) => wearOf(object).x)`
  (`terrain.ts:417-430`, `water.ts:295-317`). `onFrameUpdate` is unused;
  `uniformArray` appears only in tests.
- **Float64 decides, float32 draws** — the four patterns in the tree:
  1. _Heights from the CPU._ `cloudShellAltitude(eyeFromCenter, orientation, radius, flattening)`
     (`packages/rendering/src/cloudShell.ts:8-19`) feeds `CloudUniforms.eyeAltitude`
     (`bodyUniforms.ts:465-470`); held by the property test `cloudShell.test.ts`
     (radii 1e3–1e8 m, flattening 0.5–1, error under 1e-6 m).
  2. _Clocks reduced by a period._ `WAVE_CLOCK_PERIOD = 6_400` s, chosen so every
     drift × period is a whole number of the noise period (`water.ts:199-208`),
     held by `water.test.ts:18-35`. Presentation time is about 8.2 × 10⁸ s after
     J2000, which float32 holds to 64 s.
  3. _Coordinates split into a cell and an offset._ `anchorGround` sets
     `macroCell = floor(anchor / MACRO_METERS)` and
     `macroOffset = anchor − macroCell · MACRO_METERS` in float64; `grainOrigin` is
     the anchor wrapped by its period (`groundWear.ts:280-322`); `waveWrap`
     (`water.ts:182-186`).
  4. _A precise height in the shader without radii._
     `altitude = (2(a·l) + l·l) / (|p| + |a|) + anchorAltitude` (`terrain.ts:566-589`).
- The air marches in sea-level units about the body's center
  (`planet.ts:494-501`: `positionWorld.sub(center).div(seaLevel)`), where float32
  resolves about 0.76 m of height at Earth's radius. Inference: a cloud march
  with 3 m steps near the eye wants eye-relative meters and CPU-resolved heights
  over each shell, not that frame.
- Observation (inference; harmless today): the deck's
  `drift = time / deck.rotationPeriod − time / body.rotationPeriod`
  (`bodyUniforms.ts:483`) is uploaded unreduced. For Earth in 2026 it is about
  −586 turns, where one float32 step is 6.1 × 10⁻⁵ turn, 2.4 km of equator —
  under the map's 19.6 km texel and over a cloud cell. A volumetric field's wind
  phase must be reduced on the CPU.
- A ray a quad builds comes from the eye's basis, `Q.basis(pose.orientation)`,
  and `plane = (tan(fov / 2) · aspect, tan(fov / 2))` (`galaxyTemporal.ts:261-277`).

### 3.5 Textures

- `texture(map)` then `.sample(uv)`, or `texture(rt.texture, uv())`
  (`galaxyTemporal.ts:48-50`). Swap the bound texture with `.value = other`
  (ping-pong, `galaxyTemporal.ts:284-287`). 3D: `texture3D(map)`
  (`noiseNodes.ts:84-85`); cubes: `cubeTexture(rt.texture)` (`planet.ts:303-304`).
- `textureLoad(texture, uvec2)` for integer reads (`meter.ts:55`). three reads
  any **unfilterable** texture with `textureLoad`: a non-float component type,
  `FloatType` on a device without `float32-filterable`, nearest both ways, or
  multisampled (`WGSLNodeBuilder.js:804-811`). The filterability of what a node
  is first compiled with decides the program.
- Tables: half-float `DataTexture`, linear, clamp to edge,
  `generateMipmaps = false`, `needsUpdate = true` (`atmosphereLuts.ts:69-88`,
  through `DataUtils.toHalfFloat`); read at texel centers with
  `texelCentered(coordinate, [width, height])` (`air.ts:82-98`).
- The 3D noise today is built on the CPU: `noiseTexture()` is a 128³ RGBA8
  `Data3DTexture`, repeat-wrapped on three axes, linear, no mips, one object
  per session (`noiseTexture.ts:69-118`). A four-channel fetch costs about four
  times a one-channel one (19.4 against 11.9 fps, `noiseTexture.ts:51-60`).
- **No storage texture exists in this repo yet** — no `StorageTexture`,
  `Storage3DTexture`, `storageTexture` or `textureStore` anywhere in `apps/` or
  `packages/`. r185's API: `new Storage3DTexture(w, h, d)` (linear filters,
  `wrapR` clamp; it inherits `generateMipmaps = true` from `Texture`, so set it
  `false`; `setSize` disposes) and `textureStore(storageTexture, uvw, value).toWriteOnly()`
  inside a compute `Fn` (`three/src/nodes/accessors/StorageTextureNode.js:1-35,309-330`).
  Every non-compressed texture is created with texture-binding, copy and
  render-attachment usage, plus storage-binding for a storage texture
  (`WebGPUTextureUtils.js:354-364`). three requests every adapter feature it
  knows, `texture-formats-tier1` and `shader-f16` among them, with
  `requiredLimits: {}` (`WebGPUBackend.js:224-245`, `WebGPUConstants.js:337-348`).
  `enableShaderF16()` (`WGSLNodeBuilder.js:1672`) has no caller in three's
  `src/`, so no node emits `f16`.
- Name every texture: `texture.name` becomes the GPU texture's label
  (`WebGPUTextureUtils.js:369`) and the timeline's fallback label.

### 3.6 Stand-ins (rules 56 and 57)

```ts
// planet.ts:113-127 — the 2D pattern
function pixel(r: number, g: number, b: number, a: number): Texture {
  const map = new DataTexture(new Uint8Array([r, g, b, a]), 1, 1, RGBAFormat)
  map.magFilter = LinearFilter
  map.minFilter = LinearFilter
  map.needsUpdate = true
  return map
}
const WHITE = pixel(255, 255, 255, 255)
const RING_WHITE = pixel(255, 255, 255, 255) // the same white, its own object
```

- Others: `LUT_WHITE` / `LUT_BLACK` (`air.ts:121-129`, chosen so a missing table
  draws a vacuum); `BLANK` (`terrain.ts:1652-1682`, where nearest is a Tint
  refusal and a black frame); the cube stand-ins `BLANK_REFLECTANCE` /
  `BLANK_RELIEF`, four-texel half-float linear `CubeRenderTarget`s with no mips
  (`planet.ts:149-178`).
- Choose the stand-in's value so the graph draws nothing wrong while it waits:
  a vacuum; `CLEAR` for a clear deck, `WHITE` for an opaque mapless one
  (`planet.ts:714-717`).
- Held by `materials.gpu.test.ts`: `textureSignature(fragmentShader)` counts
  `texture_2d<f32>` and `texture_cube<f32>` bindings, samplers and read calls,
  and refuses a vacuous match (`:218-253`); every `set…` material is compiled
  with its stand-in and with a real map and the two signatures compared
  (`:269-391`: the ground, the atmosphere, the planet, the clouds, the rings).
  A new material with a `setX(texture)` joins that `describe` and
  `every production material compiles` (`:142-210`).

### 3.7 Render targets

```ts
// galaxyTemporal.ts:30-39
function target(name: string): RenderTarget {
  const value = new RenderTarget(1, 1, {
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
  })
  value.texture.name = name
  return value
}
```

- Created at 1×1 and sized per frame with `setSize(w, h)` (a no-op when equal),
  from `renderer.getDrawingBufferSize(vector)`, bounded by a budget
  (`galaxyVolume.ts:398-416`). Report bytes as width × height × 8 for RGBA16F,
  and 0 after dispose.
- Offscreen data targets are single-sample and depthless; the scene pass's
  targets are another shape (`sceneTarget.ts`: four samples, half float, a
  `DepthTexture` of `FloatType` under reversed depth, one texture per layout row
  named by the row). A pipeline is keyed on that shape, which is why the warm-up
  has two recipes (§3.8).
- Half float for anything sampled linearly (inference from §3.5: `FloatType` is
  unfilterable on a device without `float32-filterable`, and nothing in the tree
  says the CI device offers it). RGBA32F appears only as a test readback target.
- A shared, immutable table per renderer is leased:
  `acquireGalaxyStructure(renderer) → { table, release() }`, refcounted in a
  `WeakMap<WebGPURenderer, …>` (`galaxyStructure.ts:92-121`). A `WeakMap` keyed
  on the renderer is also how stand-in targets avoid pinning a replaced renderer
  (`sceneTarget.ts:32-40`).

### 3.8 Quad passes, compile-ahead and the census

```ts
// quadPass.ts:61-66
export function runQuadPasses(
  renderer: Renderer,
  quad: QuadMesh,
  state: QuadPassState, // { linear?, autoClear?, scissor? }
  passes: (draw: QuadDraw) => void, // draw(label, target, material, face?)
): void
```

- `draw` calls `namePass(target, label)` (`passTimeline.ts:160-162`), binds the
  target, sets `quad.material` and renders; the `finally` restores the target
  with its cube face and mip, the MRT, the tone mapping, the color space,
  `autoClear` and the scissor test (`quadPass.ts:67-97`). `linear: true` means
  `setMRT(null)`, `NoToneMapping` and the working color space. Labels are
  constants, because a label is an aggregation key.
- Compile-ahead, `render/warmup.ts`:
  - `warmCompile(renderer: WarmRenderer, { object, camera, scene })` — the
    visibility toggle in one synchronous task, the rejection swallowed (`:221-234`).
  - `warmRenderer(gl, layout)` — binds the scene-layout stand-in target and
    `sensorMrt(layout)`, issues one `compileAsync` per renderable, restores
    (`:170-192`). For anything drawn in the scene pass:
    `warmCompile(warmRenderer(gl, engine.sceneLayout(gl)), { object, camera, scene })`.
  - `warmSensorPass(renderer, quad, [{ target, material }, …])` — offscreen quads
    into their own single-sample targets, unbound last-in-first-out (`:578-615`).
  - `warmPipeline(pipeline, output)` — a `RenderPipeline`'s quad (`:543-569`).
  - The census: `warmAtMount({ label, units, run(done) })` (`:527-540`);
    `register` (idempotent by label, because StrictMode does everything twice);
    `trackAtMount(label, units)` for frame-driven producers (`:631-634`);
    `preload.ts:221-238` is the boot floor (`'compiling the sky'`). Labels are
    prose for the boot status line.
  - Compute has no `compileAsync`: warm a kernel by dispatching it once with its
    work count at zero (`starExtinctionCache.ts:645-658`:
    `this.#count.value = 0; await renderer.computeAsync(this.#compute!)`).
  - Keep warmed objects alive: three's pipeline cache is refcounted, and
    disposing the warm material evicts what was compiled (`preload.ts:55-59`).
  - A module memoizes its warm — `this.#warm ??= …then(() => { if (!this.#disposed) this.#ready = true })`
    — and draws nothing until `#ready` (`galaxyTemporal.ts:205-219`).

### 3.9 A node that draws offscreen work: `TempNode` and `updateBefore`

`GalaxyVolumeNode extends TempNode<'vec4'>` (`galaxyVolume.ts:96`) sets
`updateBeforeType = NodeUpdateType.RENDER` (`:204`; once per render call — the
default `FRAME` is gated on three's own rAF counter, `sensor.ts:172-190`),
exposes `outputTexture = passTexture(this as unknown as PassNode, this.#target.texture)`
(`:128-131`), runs `runQuadPasses` from `override updateBefore({ renderer }: NodeFrame): undefined`
(`:418-516`), holds the target when nothing changed (`#dirty`, `:451-463`), and
is read by a scene mesh's material (`createGalaxyBackdrop`, `:533-557`:
`renderOrder = -1000`, far depth via `sceneFarDepth`, `frustumCulled = false`,
invisible until ready). In the sensor, a node in the post chain joins the
presented frame by adding `nodeObject(node).min(65_504).mul(0)` to
`post.outputNode`'s dependency sum (`sensor.ts:280-297`). Each three render
context records on its own command encoder and is submitted at `finishRender`
(`WebGPUBackend.js:938-941`; `submit(…encoder.finish())` at `:1278`), so a pass
drawn from a scene object's `updateBefore` is submitted before the scene pass
that triggered it. Inference: it cannot read that pass's own depth, which is
why the plan's composite needs a split or a second pass.

### 3.10 Compute kernels and storage buffers

```ts
// meter.ts:36-50 and 97-102, abridged
const bins = new StorageBufferAttribute(new Uint32Array(HISTOGRAM_BINS), 1)
const counts = storage(bins, 'uint', HISTOGRAM_BINS).toAtomic()
const width = uniform(1, 'uint')
const clear = Fn(() => {
  If(instanceIndex.lessThan(uint(HISTOGRAM_BINS)), () => {
    atomicStore(counts.element(instanceIndex), uint(0))
  })
})().compute(HISTOGRAM_BINS)
// …
count.count = Math.ceil((width.value * height.value) / 64) * 64
renderer.compute(count)
void renderer.getArrayBufferAsync(bins).then(…)
```

- `storage(attribute, 'vec4' | 'uint' | …, n)` with `.toReadOnly()` or
  `.toAtomic()`, written by `.element(i).assign(v)` (`terrainKernel.ts:1043-1060`,
  `starExtinctionCache.ts:405-410`). `StorageInstancedBufferAttribute` when a
  material reads the buffer per instance (`starExtinctionCache.ts:315-336`).
- Dispatch: `renderer.compute(node, dispatchSize?)`, where `dispatchSize` is a
  count, `[x, y, z]` or an indirect buffer (`three/src/renderers/common/Renderer.js:2707-2718`);
  before init it warns and defers to `computeAsync`. `terrainProducer.ts:343`
  passes a per-batch count.
- **Guard the index.** A compute node dispatches whole workgroups of 64 and
  WGSL clamps an out-of-range write onto the last element
  (`docs/guides/testing.md:423-427`); every kernel tests
  `instanceIndex.lessThan(total)`.
- An error scope around a dispatch is pushed and popped in one task, around the
  dispatch alone, never across an await (`terrainProducer.ts:560-590`).
- Name a kernel for the timeline: `computeLabel` reads the compute node's
  `name` (`passTimeline.ts:183-189`) and r185 has `ComputeNode.setName()`. No
  kernel in the app is named today, so they all read as `compute`.
- Readback is `renderer.getArrayBufferAsync(attribute)`, one outstanding staging
  read at a time (`meter.ts:97-118`).
- No compute path runs on WebGL here: a module takes a `cpu` / `compute` option
  decided from `renderer.backend.isWebGPUBackend` (`scene/Starfield.tsx:23-41`,
  `StarExtinctionCache`'s `cpu` branch).

### 3.11 Cameras and depth inside passes

- In a quad, `cameraPosition`, `cameraProjectionMatrix` and
  `cameraNear` / `cameraFar` are the quad's (plan §12). Pass the scene camera as
  uniforms, and linearize the scene's depth with the scene camera's near and far
  passed the same way. `perspectiveDepthToViewZ(depth, near, far)` already
  branches on `builder.renderer.reversedDepthBuffer`
  (`three/src/nodes/display/ViewportDepthNode.js:227-239`).
- WebGPU depth is reversed float32 (`createRenderer.ts:184`; the camera spans
  0.05 m to 10¹⁰ m, `docs/concepts/rendering.md:828-837`); WebGL is
  logarithmic (`createRenderer.ts:195-211`). `sceneFarDepth` and
  `expandedLineDepth` (`sceneDepth.ts`) are the two depth helpers.
- The sea's depth copy is a nearest `FloatType` `DepthTexture`, read with
  `textureLoad` (`seaReflection.ts:281-286`). `SeaFrameNode` is the one split of
  the scene pass (`seaReflection.ts:50-56,124-140`).

### 3.12 Per-body uniforms: `bodyUniforms.ts` → `Bodies.tsx`

- `bodyUniforms(body: RenderBody, frame: BodyFrame, maps: BodyMaps, star: Rgb | null): BodyUniforms`
  (`render/bodyUniforms.ts:338`) decides every per-frame number in Node, with no
  Three object in reach. `BodyFrame = { keyLight, keyColor, visibility, renderTime, eye }`
  (`:40-50`); `BodyMaps = { normal, night, clouds, bake }` (`:56-62`).
- `CloudUniforms` (`:92-103`): `scale` (the shell, render meters);
  `entryDistance` (`placement.scale · lift · 0.25`); `eyeAltitude`
  (`cloudShellAltitude(eye − position, orientation, shell, shellFlattening)`);
  `baseColor` (white when mapped, else `appearance.color`); `sunsetColor`
  (`appearance.haze?.limb`); `opacity` (`deck.opacity`); `drift` (§3.4). The lift
  is `max(altitude / trueRadius, 0.004)` (`:458`). `PlanetUniforms.cloudShadow`
  is 0.55 with a cloud map and 0 without; `cloudHeight = altitude / trueRadius`
  (`:432-436`).
- `scene/Bodies.tsx` applies them each frame: the frame (`:379-388`; eye is
  `scene.camera.position`, `renderTime` is `engine.snapshot?.renderTime ?? 0`),
  `bodyUniforms(...)` (`:435-445`), the planet's cloud uniforms (`:525-526`),
  the deck (`:532-553`: `setTexture(maps.clouds)`, `entryDistance`,
  `eyeAltitude`, `baseColor`, `sunDirection`, `sunColor`, `sunsetColor`,
  `opacity`, `drift`). Visuals are built lazily by
  `materialize(star, clouded, ringed)` (`:328-377`; the deck `renderOrder = 1`,
  the rings 2) under `createBodyResidency`.
- Pinned by `bodyUniforms.test.ts`: the figure branch (`:96-146`), mapped-body
  tuning, cloud shadow 0.55 or 0 (`:198-206`), the deck's tint (`:220-227`),
  drift as the difference of the two rates (`:240-244`).

### 3.13 Draw order and the scene sort

`renderOrder` in the scene: galaxy backdrop −1000 (`galaxyVolume.ts:554`),
starfield −2 (`Starfield.tsx:52`), a body drawn at the surface tier −1, else 0
(`bodyUniforms.ts:565`), the deck 1 (`Bodies.tsx:353`), rings 2 (`:362`), entry
trace parts `index + 1` (`EntryTrace.tsx:53`), the cinematic sky 8, the plume
disk 9, plumes and the flare 10, warp effects and the entry sheath 11, pad dust 12. Terrain, the sea and the ships are 0; the sea is transparent and draws
after every opaque. `installSceneOrder(renderer)` (`sceneOrder.ts:10-24`)
compensates r185's reversal of the whole list under reversed Z: the
`groupOrder`, `renderOrder` and `id` keys are multiplied by −1 and only the
depth key changes meaning; transparent draws sort far to near. The GPU harness
installs it too (`gpuHarness.ts:364-371`).

### 3.14 The scene pass, its layout and reconstruction

- `createSensor(renderer, scene, camera, layout, frame?, diagnostic?)`
  (`sensor.ts:139`): `pass(scene, camera, { samples })` named `'scene'`, the depth
  texture's type from the layout, `setResolutionScale`, `setMRT(sensorMrt(layout))`,
  `updateBeforeType = NodeUpdateType.RENDER` (`:161-190`). FSR's inputs are
  `scenePass.getTextureNode('output' | 'depth' | 'velocity' | 'reactive')`
  (`:191-208`); then defocus → motion → PSF → signature → the `RenderPipeline`
  output (`:220-300`). `render()` restores a dozen pieces of renderer state in a
  `finally` (`:472-557`). A composite between the scene and FSR changes this
  wiring.
- `sceneLayout(picture, backend)` interns one frozen layout per resolved picture
  (`sceneLayout.ts:127-153`); rows are
  `{ name, channels: 1 | 2 | 4, storage: 'half' | 'byte', blend }` (`:49-55`);
  `WRITES` gives each row its value (`sensorMrt.ts:46-61`). A new attachment is a
  row, a `WRITES` entry, a stand-in shape and a byte count, all read from the one
  table.
- History resets: the sensor keys FSR's history on
  `[pictureEpoch, mode, stagingLook, processing, historyKey, pinned]`
  (`sensor.ts:485-496`); `engine.declareCut()` increments `pictureEpoch`
  (`GameEngine.ts:706-711`; called by the observatory, cutscenes, the surface
  arm, on-foot and maneuvers); `historyKey` carries the galaxy seed, the target,
  the galaxy view and a held time (`Sensor.tsx:100-107`). `GalaxyTemporalVolume`
  resets on a resize, a version change, a missing pose or a turn past π/8
  (`galaxyTemporal.ts:220-240`).

### 3.15 Timing and logging

- `const timer = getTimer('game.render')`, then
  `if (timer.on) timer.measure('galaxy.draw', started, performance.now(), RENDER_PHASE)`,
  with properties only under `timingDetailed()` (`galaxyVolume.ts:86-87,470,500-515`).
  `RENDER_PHASE` and `BOOT_PHASE` are in `engine/frameTiming.ts:67,77`.
- Per-frame scene work goes through `useTimedFrame(name, callback, priority = 0)`
  (`scene/useTimedFrame.ts:29-44`), which also skips a frame held by a GPU
  measurement (`framesHeld()`).
- `const log = getLogger('game.<area>')`; `log.warn('message', { fields })`. No
  `console.*` in render code.

---

## 4. Exposing a module to the debug tooling and the harness

The galaxy is the template.

1. **Scene component** (`scene/GalaxyVolume.tsx:19-139`): GPU objects built in
   `useEffect` and retired by its cleanup, which "retires exactly the instance it
   creates" under StrictMode; `engine.galaxyRenderer = report`, cleared on
   cleanup only if it is still this report (`:79,103`);
   `warmAtMount({ label: 'warming the galaxy', units: 2, run })` (`:80-100`); a
   per-frame `useTimedFrame('galaxy', …)` writes `configure(...)` and
   `mesh.visible = volume.active && volume.ready` (`:112-137`). Mounted in
   `scene/SceneView.tsx:84-109`, where order is not load-bearing: priority is
   (the sensor last at 1, `EngineTick` at −1, orbital bakes at −0.25).
2. **Engine hook**: `galaxyRenderer: (() => GalaxyRenderReport) | null`
   (`GameEngine.ts:712`), wired into the render host as
   `galaxyRender: () => this.galaxyRenderer?.() ?? null` (`:1045`).
3. **Render host port** (`packages/devtools/src/host.ts:217-344`): one member
   per question, with a default in `renderHost(overrides)` written member by
   member (`:354-386`) so a headless host answers honestly. Report types are
   plain data in `packages/devtools` (`GalaxyRenderReport`,
   `packages/devtools/src/galaxy.ts:54`), with no three in them.
4. **Harness**: `ir.settled()` (`packages/devtools/src/harness.ts:711-744`) is
   what a capture waits for — `{ ok, galaxy, terrain }` today; plan §5.5 adds
   the weather's history phases, shadow slices and cache levels. `ir.passes(frames)`
   (`:1685-1687`) runs `PassTimeline.measure` (`GameEngine.ts:433-441`);
   `ir.gpu(frames)` is the figure to quote, taken A/B in one boot
   (`docs/guides/harness.md:660-710`). `ir.help()` lists the verbs (`:1751-1831`).
5. **Pass names**: every label shows in `ir.passes()`; the timeline's fallback is
   `"<texture.name> <w>×<h>[ ×<samples>]"` (`passTimeline.ts:171-181`).
   `quadPass.gpu.test.ts:120-261` asserts the optical and galaxy labels and that
   no label carries a size suffix; `docs/guides/harness.md:668-680` lists the
   names. Both take the weather's passes.
6. **Quality levers**: `render/quality.ts` — named steps, each one lever with a
   measured cost, read by the frame loop from `engine.surfaceQuality` and
   persisted through `state/preferences.ts` (rule 34) and `state/engineKnobs.ts`.

---

## 5. Tests

### 5.1 Which suite

- `pnpm test`: plain Node. `vitest.config.ts` includes `packages/*/src/**/*.test.ts`,
  `packages/*/node/**/*.test.ts`, `apps/*/src/**/*.test.ts`,
  `scripts/**/*.test.mjs`; excludes `**/*.gpu.test.ts` and `**/*.slow.test.ts`;
  20 s timeout; at most four workers. A plain test may import a render module
  (`water.test.ts` imports `water.ts`, which imports `three/webgpu`) as long as
  it creates no WebGPU device. `galaxyTemporal.test.ts` builds the **GLSL** in
  Node — `new WebGPURenderer({ forceWebGL: true, canvas: { width, height } })`
  and `backend.createNodeBuilder(object, renderer).build()` — which is how the
  plan's "WebGL draws the far march alone" can be held inside the gate.
- `pnpm test:gpu`: `apps/game/vitest.gpu.config.ts` includes
  `{apps,packages}/*/src/**/*.gpu.test.ts`; its setup file
  `apps/game/src/render/gpuSetup.ts` installs `navigator.gpu` from Dawn's
  `create([])`, a `self` whose animation frame never fires, `scheduler.yield`,
  and deliberately no `document`; its `globalSetup` is `scripts/gpuSuiteLock.mjs`
  (the GPU lock; `IR_GPU_WAIT=<seconds>` queues); forks; 20 s test and hook
  timeouts. One file:
  `pnpm vitest run --config apps/game/vitest.gpu.config.ts <substring>`.

### 5.2 The harness (`render/gpuHarness.ts`)

`openGpu(width = 64, height = 64): Promise<GpuSession>` (`:334`): reversed
depth, `installSceneOrder`, an opaque black clear (an empty pixel reads
`(0, 0, 0, 255)`). The verbs (`:120-201`):
`drawGraph(graph, { width?, height?, float?, into? })` (the fragment of a
`PlaneGeometry` quad, `v` up, no tone curve), `draw(scene, camera, options)`,
`read(target)`, `compile(object, camera, scene)` (refuses an invisible object,
turns culling off), `shader(object, camera, scene) → { vertexShader, fragmentShader }`,
`compute(kernel)`, `readBuffer(buffer)`, `warnings()`, `reported()`,
`pipelinesBuilt()`, `holdNextPipeline()` (release it in a `finally`),
`dispose()`. `adapterOffers(feature)` (`:329-332`) is a top-level-await skip on
the hardware's own answer (`quadPass.gpu.test.ts:54`). Readbacks are unpadded,
row 0 at the top; only RGBA8 and RGBA32F read back.

### 5.3 Patterns worth copying

- Per-pixel inputs to `drawGraph`:
  `uniformArray(points, 'vec3').element(int(uv().x.mul(n)))`
  (`noiseNodes.gpu.test.ts:47-51`) — the graph against the CPU function it ports,
  under a named floor (`ARITHMETIC = 2e-5`, `:53-58`).
- A module with `warm` / `render` / `sample` / `report`: `galaxyTemporal.gpu.test.ts`
  (fills every phase, reprojects, counts `resets`, `report.bytes === 0` after
  dispose).
- Warm-ups held: `warmup.gpu.test.ts:296-326` (a depthless quad warmed by
  `warmSensorPass` builds no pipeline on its first draw) and `:86-117`
  (`warmCompile`, then a draw: `pipelinesBuilt()` unchanged and the frame lit).
- Structure, never a snapshot: count bindings, look for identifiers
  (`materials.gpu.test.ts:393-410`). The `.level()` rule is testable this way
  (inference): compile the march in a material, read `fragmentShader`, assert
  `textureSampleLevel` and no bare `textureSample(` — pixels on one GPU cannot
  show an undefined derivative to be wrong.
- Timeline names: `quadPass.gpu.test.ts:198-260` measures through a real
  `createSensor` on a renderer of its own, because the tone curve and the
  scene-target declaration are per renderer.
- Property tests in Node, with `fast-check`, for every mathematical claim
  (`packages/rendering/src/cloudShell.test.ts`; §8.4). Bounds name
  their limit; a regression test is seen failing against the defect before it
  is kept (`.claude/rules/testing.md`).

### 5.4 Tests that pin the deck today, and move when it retires

`cloudEntry.gpu.test.ts` (coverage clears with no culling step; the rim fades
with the nadir), `materials.gpu.test.ts` (`'the planet, its clouds and its rings'`
compile; the `'the clouds'` stand-in), `bodyUniforms.test.ts` (the cloud cases
above), and the boot warm group compiles a deck (`preload.ts:16` imports
`createCloudMaterial`, `:118` adds its mesh to the group).

---

## 6. The `.claude/skills/webgpu-threejs-tsl` skill

Third-party (`skills-lock.json`: `dgreenheck/webgpu-claude-skill`), kept in
upstream formatting (`.prettierignore`), linked from `.agents/skills/`.
`SKILL.md` (93 lines) indexes `docs/core-concepts.md` (types, operators,
uniforms, control flow), `docs/materials.md`, `docs/compute-shaders.md`
(instanced arrays, workgroups, barriers, atomics, readback, and the "property
assignment versus JS reassignment" trap), `docs/post-processing.md`
(`RenderPipeline`, renamed from `PostProcessing` in r183), `docs/wgsl-integration.md`
(`wgslFn`), `docs/device-loss.md`, `docs/limits-and-features.md`
(`requiredLimits` through the renderer's constructor), `REFERENCE.md` (a
cheatsheet whose version notes stop at r178), and examples and templates. Where
it differs from house style: `import * as THREE` (the repo uses named imports),
raw `renderer.compileAsync` / `computeAsync` (the repo goes through
`warmup.ts`), `MeshStandardNodeMaterial` with lights (the repo hand-writes its
lighting), and no guidance on stand-ins, uniformity, the MRT budget or
reversed depth. Treat it as API reference only.

---

## 7. The documents side

### 7.1 ADRs

- The number is one past the highest file in `docs/adr/`: `0062` is the highest,
  so the next is **0063** on this tree (`0049`, `0050` and `0054` have never
  existed in any local ref). Re-list the directory when writing: a sibling
  branch can take a number first (`d7c4616 docs: the stations record is ADR-0060, because main took 0059 for the soundtrack`).
- The shape (`.claude/skills/adr/SKILL.md`; the latest style is `0062`, `0061`,
  `0056`): `# ADR-00NN: <the decision, stated as decided>`, then
  `Status: accepted · D Mon YYYY`, optionally followed by `. <what it amends or
records>`; `## Context`; `## Decision` (one bold sentence, then bullets or
  `###` subsections); `## Alternatives considered` (each named, with why it
  lost); `## Consequences` (measured figures with the machine and the operating
  point; what got worse; known gaps); optionally `## Related`. Real numbers,
  not adjectives (`docs/adr/README.md:269-279`).
- In the same change: a row in `docs/adr/README.md`'s table
  (`| [00NN](00NN-slug.md) | Short name | accepted | One line |`); an entry in
  `scripts/docs/wings.mjs`' "Decision Records" group (`:104-236`) as
  `['docs/adr/00NN-slug.md', 'Sentence-case label']` (rule 46 — the docs build
  fails otherwise); a `CONTEXT.md` entry; and if it creates an invariant, the
  imperative in `AGENTS.md`, a one-liner in the matching `.claude/rules/*.md`, a
  row and a `### Rule N` in `docs/agents/invariants.md`, and the Cursor
  adapter's `globs:` kept in step (`.claude/rules/README.md`).
- When a plan's phase lands, its decision moves into the ADR and the plan loses
  the section (rule 47; ADR-0062 and its `CONTEXT.md` entry are the worked
  example). A `{@link}` in a doc comment is checked by TypeDoc.

### 7.2 `CONTEXT.md`

`## <the finding, as a claim> (DD Mon YYYY)`, placed immediately before
`## Known gaps` (line 13209 today). The cumulative sections
`## Bugs the tests found (worth not reintroducing)` (line 265) and
`## Known gaps` are appended in place, and `## Current state` (line 18) changes
when a capability claim does. Content: decisions with their reasoning,
measurements with their conditions, real causes, and what was tried and
rejected (`.claude/skills/context-log/SKILL.md`).

### 7.3 The PR template (`.github/pull_request_template.md`)

`## What changed` (the commit body's voice), `## Invariants` (which rules and
how each holds; "None" is a fine answer), `## Screenshots` (captioned; `/drive`,
`ir.preset(...)`, `ir.chrome(false)`, `ir.layers(false)`), `## Verification`
(`pnpm check` green; `pnpm sim --self-test` n/12; a regression test seen
failing without the fix; CONTEXT or ADR updated), `## Left out`. It ends with
the attribution line the session's system reminder gives.

### 7.4 Commit messages

`git log --oneline -30` subjects are `type(scope): a declarative claim`, often
with a comma and a second clause: `feat(rig): every GPU job holds one lock, and
a rig is held to the point and the tree it asked for (#188)`,
`docs(plans): the weather is a function of time, and the clouds are a volume (#190)`,
`fix(planetarium): a click on a drawn station is tested against its triangles`.
Render-area scopes in the last 400 commits: `render` 17 (13 `feat`, 4 `fix`),
`galaxy` 7, `terrain` 2, `camera` 2, `scene` 1. Every commit has a body: why,
why the obvious approach failed, the numbers with the conditions they were
taken under, a `Tests:` list closing with what each test fails against, and the
`Co-Authored-By` trailer the system reminder specifies (`fc34532` is a model
body). Commit each reversible step as it goes green; never on `main`; pushing
and the PR are `/ship` (`docs/agents/working.md:163-201`). Code and docs are in
the present tense; history lives only in commits, ADRs and `CONTEXT.md`
(`.claude/rules/writing.md`).

---

## 8. Templates

Names (`cloudTrace.ts`, `CloudTrace`, `cloudMarch`, the labels) are
placeholders; the shapes are the repository's. Prettier would leave these as
they are under `.prettierrc.json`.

### 8.1 A render module (`apps/game/src/render/cloudTrace.ts`)

```ts
import {
  DataTexture,
  HalfFloatType,
  LinearFilter,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  RGBAFormat,
  Vector2,
  Vector3,
  type Node,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  Break,
  exp,
  float,
  Fn,
  If,
  Loop,
  texture,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import { getTimer, invariant } from '@inertialref/shared'
import { RENDER_PHASE } from '../engine/frameTiming.ts'
import { runQuadPasses } from './quadPass.ts'
import { warmSensorPass } from './warmup.ts'

/*
 * <What this pass draws, in one paragraph, and why the obvious form does not
 * work: the constraint, the number that settled it, the test that holds it.>
 */

const timer = getTimer('game.render')

/** Steps a ray may take. A constant, so the loop's bound is uniform. */
const STEPS = 64
/** Meters a step crosses. <Where the figure comes from.> */
const STEP_METERS = 50

/*
 * The field's stand-in until the bake lands: linear, like the map it stands
 * in for, and its own object. A nearest one compiles `textureLoad` with no
 * sampler and the real map is then read through that program (rule 56); one
 * object under two nodes is one binding (rule 57).
 */
const FIELD_STAND_IN = /*@__PURE__*/ (() => {
  const map = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat)
  map.magFilter = LinearFilter
  map.minFilter = LinearFilter
  map.needsUpdate = true
  return map
})()

/**
 * The march along one view ray: what the cloud scatters toward the eye in
 * `rgb`, its transmittance in `a`. A function of its own so a test can compile
 * it in a material and read its WGSL.
 */
export function cloudMarch(
  field: ReturnType<typeof texture>,
  direction: Node<'vec3'>,
): Node<'vec4'> {
  return Fn(() => {
    const transmittance = float(1).toVar()
    const light = vec3(0).toVar()
    Loop(STEPS, ({ i }) => {
      If(transmittance.lessThan(0.01), () => {
        Break()
      })
      const t = float(i).add(0.5).mul(STEP_METERS)
      // Non-uniform control flow from here on: every read names its level.
      const sigma = field
        .sample(direction.xz.mul(t).mul(1e-4).add(0.5))
        .level(float(0)).r
      const through = exp(sigma.mul(STEP_METERS).negate())
      light.addAssign(vec3(transmittance.mul(sigma).mul(through)))
      transmittance.mulAssign(through)
    })
    return vec4(light, transmittance)
  })() as Node<'vec4'>
}

function target(name: string): RenderTarget {
  const value = new RenderTarget(1, 1, {
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
  })
  value.texture.name = name
  return value
}

export interface CloudTraceReport {
  readonly width: number
  readonly height: number
  readonly draws: number
  readonly ready: boolean
  readonly bytes: number
}

export class CloudTrace {
  readonly #rays = target('Cloud trace')
  readonly #material = new NodeMaterial()
  readonly #quad = new QuadMesh(this.#material)
  readonly #field = texture(FIELD_STAND_IN)
  readonly #output = texture(this.#rays.texture, uv())
  /*
   * The scene camera, as uniforms: inside a quad pass the camera nodes are
   * the quad's own orthographic camera.
   */
  readonly #right = uniform(new Vector3(1, 0, 0))
  readonly #up = uniform(new Vector3(0, 1, 0))
  readonly #forward = uniform(new Vector3(0, 0, -1))
  readonly #plane = uniform(new Vector2(1, 1))
  /** The eye's height over the layer's base, meters, resolved in float64. */
  readonly #eyeOverBase = uniform(0)
  #warm: Promise<void> | null = null
  #ready = false
  #disposed = false
  #draws = 0

  constructor() {
    // An expression of uniforms, so it may be built outside the `Fn`; a
    // `.toVar()` here would not be.
    const screen = uv().mul(2).sub(1)
    const direction = this.#forward
      .add(this.#right.mul(screen.x.mul(this.#plane.x)))
      .add(this.#up.mul(screen.y.mul(this.#plane.y)))
      .normalize()
    this.#material.fragmentNode = cloudMarch(this.#field, direction)
    this.#material.name = 'Cloud trace'
  }

  /** Point the trace at a baked field; null puts the stand-in back. */
  setField(map: DataTexture | null): void {
    const next = map ?? FIELD_STAND_IN
    if (this.#field.value !== next) this.#field.value = next
  }

  configure(view: {
    readonly right: Vector3
    readonly up: Vector3
    readonly forward: Vector3
    readonly halfTan: number
    readonly aspect: number
    readonly eyeOverBase: number
  }): void {
    invariant(view.halfTan > 0, 'A trace needs a positive field of view')
    this.#right.value.copy(view.right)
    this.#up.value.copy(view.up)
    this.#forward.value.copy(view.forward)
    this.#plane.value.set(view.halfTan * view.aspect, view.halfTan)
    this.#eyeOverBase.value = view.eyeOverBase
  }

  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#warm ??= warmSensorPass(renderer, this.#quad, [
      { target: this.#rays, material: this.#material },
    ]).then(() => {
      if (!this.#disposed) this.#ready = true
    })
    return this.#warm
  }

  render(renderer: WebGPURenderer, width: number, height: number): boolean {
    if (!this.#ready || this.#disposed) return false
    this.#rays.setSize(Math.max(1, width), Math.max(1, height))
    const started = timer.on ? performance.now() : 0
    runQuadPasses(
      renderer,
      this.#quad,
      { linear: true, autoClear: true },
      (draw) => {
        draw('clouds trace', this.#rays, this.#material)
        this.#draws++
      },
    )
    if (timer.on)
      timer.measure('clouds.trace', started, performance.now(), RENDER_PHASE)
    return true
  }

  /** The trace, as a node: one node for every reader (rule 57). */
  sample(): Node<'vec4'> {
    return this.#output
  }

  /** A readout: never throws, never writes (rule 65). */
  get report(): CloudTraceReport {
    return {
      width: this.#rays.width,
      height: this.#rays.height,
      draws: this.#draws,
      ready: this.#ready && !this.#disposed,
      bytes: this.#disposed ? 0 : 8 * this.#rays.width * this.#rays.height,
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#rays.dispose()
    this.#material.dispose()
  }
}
```

`QuadMesh` writes `v = 0` at the top; whoever reads `sample()` through a
`PlaneGeometry` must agree, and a GPU test should hold one asymmetric case. A
3D field is the same shape with `texture3D` and a 1×1×1 linear
`Data3DTexture` stand-in with `generateMipmaps = false`.

### 8.2 A scene component (`apps/game/src/scene/Clouds.tsx`, a sketch)

```tsx
import { useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import type { WebGPURenderer } from 'three/webgpu'
import type { GameEngine } from '../engine/GameEngine.ts'
import { CloudTrace } from '../render/cloudTrace.ts'
import { warmAtMount } from '../render/warmup.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/** The effect owns GPU objects; StrictMode cleanup retires exactly the instance it creates. */
export function Clouds({ engine }: { engine: GameEngine }) {
  const gl = useThree((state) => state.gl)
  const live = useRef<CloudTrace | null>(null)
  useEffect(() => {
    const trace = new CloudTrace()
    live.current = trace
    warmAtMount({
      label: 'warming the clouds',
      units: 1,
      run: async (done) => {
        await trace.warm(gl as unknown as WebGPURenderer)
        done()
      },
    })
    return () => {
      if (live.current === trace) live.current = null
      trace.dispose()
    }
  }, [engine, gl])
  useTimedFrame('clouds', () => {
    const trace = live.current
    if (trace === null) return
    // configure() from engine state; render() wherever phase 0 places the
    // composite.
  })
  return null
}
```

### 8.3 A GPU test (`apps/game/src/render/cloudTrace.gpu.test.ts`)

```ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  DataTexture,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
} from 'three/webgpu'
import { positionLocal, texture } from 'three/tsl'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { CloudTrace, cloudMarch } from './cloudTrace.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(64, 48)
})
afterAll(() => gpu?.dispose())

/*
 * A transmittance of one through a vacuum, read back from a half-float
 * target: half float resolves 2⁻¹¹ at one, which is the floor.
 */
const HALF_AT_ONE = 2 ** -11

/** A 1×1 map loaded the way a real one is: linear both ways. */
function linearPixel(): DataTexture {
  const map = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat)
  map.magFilter = LinearFilter
  map.minFilter = LinearFilter
  map.needsUpdate = true
  return map
}

it('draws a vacuum on its stand-in, and leaves nothing allocated behind it', async () => {
  const trace = new CloudTrace()
  try {
    await trace.warm(gpu.renderer)
    expect(trace.render(gpu.renderer, 64, 48)).toBe(true)
    const pixels = await gpu.drawGraph(trace.sample(), {
      float: true,
      width: 64,
      height: 48,
    })
    for (let y = 2; y < 46; y += 7)
      for (let x = 2; x < 62; x += 9)
        expect(Math.abs(pixels.at(x, y)[3] - 1)).toBeLessThanOrEqual(
          HALF_AT_ONE,
        )
  } finally {
    trace.dispose()
  }
  expect(trace.report.bytes).toBe(0)
})

it('reads every texture in the march at an explicit level', async () => {
  const map = linearPixel()
  const material = new MeshBasicNodeMaterial()
  material.colorNode = cloudMarch(texture(map), positionLocal.normalize())
  const mesh = new Mesh(new PlaneGeometry(2, 2), material)
  const scene = new Scene()
  scene.add(mesh)
  scene.updateMatrixWorld(true)
  const camera = new PerspectiveCamera(60, 4 / 3, 0.1, 10)
  camera.position.z = 2
  camera.updateMatrixWorld()
  try {
    const { fragmentShader } = await gpu.shader(mesh, camera, scene)
    // Structure, never a snapshot: the claim is the read, not the bytes.
    expect(fragmentShader).toContain('textureSampleLevel')
    expect(fragmentShader).not.toMatch(/\btextureSample\(/)
  } finally {
    mesh.geometry.dispose()
    material.dispose()
    map.dispose()
  }
})
```

A feature-dependent file (an `r8unorm` storage volume, a `float32-filterable`
read) skips on the adapter's own answer:
`const TIER1 = await adapterOffers('texture-formats-tier1')`, then
`describe.skipIf(!TIER1)(…)`. Inference: whether CI's paravirtual adapter offers
it is not recorded; the `gpu` job's adapter summary says.

### 8.4 A Node property test

Copy `packages/rendering/src/cloudShell.test.ts`: one `fc.assert(fc.property(…))`
per mathematical claim, `fc.double({ min, max, noNaN: true })` generators that
span the radii the universe holds (1e3 to 1e8 m there), and a bound whose number
says where it came from (`1e-6` m there). It runs in `pnpm test`, so the gate
holds it on every turn.

### 8.5 An ADR (`docs/adr/0063-<the-decision-as-a-slug>.md`)

```markdown
# ADR-0063: <The decision, stated as decided — a claim, not a topic>

Status: accepted · <D Mon 2026>. <Records phase N of the weather plan; amends
ADR-00NN where it does.>

## Context

<The forces, with numbers and where they were measured: the machine, the
browser, the display size, the operating point. Include the embarrassing ones.>

## Decision

**<One sentence.>**

- <A bullet that makes it precise: the module, the pass, the rule.>
- <…>

## Alternatives considered

**<Alternative one>.** <Why it lost, with the figure that settled it.>

**<Alternative two>.** <…>

## Consequences

- <Measured: `ir.gpu()` A/B in one boot at 1920×1080 and 2880×1800 on the M5,
  Chrome 152 — the table.>
- <What got worse, and what is still open.>

## Related

- <The plan section it closed, the `CONTEXT.md` entry, the tests that hold it.>
```

With it: `scripts/docs/wings.mjs` gains `['docs/adr/0063-<slug>.md', '<Sentence-case label>'],`
at the end of "Decision Records"; `docs/adr/README.md` gains a table row; and
`CONTEXT.md` gains an entry before `## Known gaps`.

### 8.6 A `CONTEXT.md` entry

```markdown
## <The finding as a claim, and the bug that must not come back> (DD Mon 2026)

<What landed and why, the figures with their conditions, what was tried and
rejected and why. Links to the ADR rather than restating it.>
```

### 8.7 A commit

```
feat(render): <what the clouds now do, as a claim>

<Why. Why the obvious approach did not work, with the number that settled it
and the conditions it was taken under (machine, size, operating point). The
rejected alternative in a sentence.>

Tests:
- <what it holds>;
- <what it holds>.
Each fails against the variant it guards: <a read without .level(0), a nearest
stand-in, a layer mixed per step instead of per segment>.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

## 9. What the weather work must change or hook into, in this area

| Plan item                                 | Where it hooks                                                                                                                                                                                                                                                   | Constraint                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every pass named on the timeline (§3)     | `runQuadPasses(…, (draw) => draw('clouds …', target, material))`; a compute kernel's `.setName('clouds …')`                                                                                                                                                      | Constant labels; added to `quadPass.gpu.test.ts`' name assertions and to `docs/guides/harness.md:668-680`.                                                                                                                                                                             |
| Compile-ahead (§3, §12)                   | `warmSensorPass` for quads; `warmCompile(warmRenderer(gl, engine.sceneLayout(gl)), …)` for scene objects; a zero-count `computeAsync` for kernels; `warmAtMount` labels; archetypes in `preload.ts`                                                              | Rule 61; keep warmed objects alive; phase 0's cold-compile figure is the census's.                                                                                                                                                                                                     |
| Noise volumes baked on the GPU (§5.1)     | New to the repo: `Storage3DTexture` and `textureStore` in a compute `Fn`                                                                                                                                                                                         | `generateMipmaps = false`; R8 storage needs `texture-formats-tier1`; hold the bake with a GPU test that samples the volume back through `drawGraph`.                                                                                                                                   |
| Reads inside the march (§5.2)             | Every `.sample()` in a fragment-stage loop                                                                                                                                                                                                                       | `.level(float(0))`; a WGSL-structure GPU test (§8.3).                                                                                                                                                                                                                                  |
| Eye heights over the shells (§3, §5.2)    | `bodyUniforms.ts` (`CloudUniforms` or its successor), `cloudShellAltitude` in `packages/rendering`                                                                                                                                                               | Float64 on the CPU, the figure branch respected (`shellFlattening`), rule 52; Node tests and properties.                                                                                                                                                                               |
| Time offsets (§3)                         | A CPU-side period reduction like `WAVE_CLOCK_PERIOD`                                                                                                                                                                                                             | A test that every drift × period closes on the field's own period (`water.test.ts`).                                                                                                                                                                                                   |
| Lattice and cell decisions (§4.4, §4.5)   | Anchor-split or tile frames (`groundWear.ts:280-322`, `writeTileFrame`)                                                                                                                                                                                          | Rule 58; `u32` thresholds from the CPU, never `toUnit(hash) < p` in float32.                                                                                                                                                                                                           |
| Trace at ¼, history at ½ (§5.5)           | The `GalaxyTemporalVolume` template; resets from `pictureEpoch` and `historyKey`                                                                                                                                                                                 | Half-float history; reject non-finite values; a `report` getter; `ir.settled()` waits on it.                                                                                                                                                                                           |
| The composite (§5.6)                      | `sensor.ts:161-208` (scene pass → FSR wiring), `sceneLayout.ts` rows, `sensorMrt.ts` `WRITES`, `reactive` and `velocity`                                                                                                                                         | MRT 32 bytes, about 2 left under temporal (inference); a second scene pass or a split like `SeaFrameNode`; no pnpm patch to three (ADR-0030: there is no `patches/` and no `patchedDependencies`).                                                                                     |
| A composite drawn as a scene object (§12) | The `renderOrder` table (§3.13), `installSceneOrder`                                                                                                                                                                                                             | Survive the reversed list; test under `openGpu`, which has reversed depth and the scene order installed.                                                                                                                                                                               |
| One shadow (§6.1, phase 2)                | `terrain.ts`, `water.ts` and `planet.ts` together; the hull's light (`CameraRig.tsx`); the flare's occluders (`flareMath.ts`, testable in Node)                                                                                                                  | Rule 59; each new texture node gets its own linear stand-in and joins `materials.gpu.test.ts`.                                                                                                                                                                                         |
| The sphere's far march (§5.4)             | `planet.ts` `createPlanetMaterial` (one graph for every body), `Bodies.tsx`                                                                                                                                                                                      | Per-body difference stays uniforms; a variant is a second pipeline for every body.                                                                                                                                                                                                     |
| WebGL draws the far march alone (§11.3)   | `Fn((builder) => …)` gates; `cpu` / `compute` options from `isWebGPUBackend`                                                                                                                                                                                     | Hold the GLSL build in plain Node (`galaxyTemporal.test.ts`) so the gate sees it.                                                                                                                                                                                                      |
| The deck retires (phase 3)                | `createCloudMaterial` (`planet.ts:682-789`), `CloudUniforms`, `cloudShadow` / `cloudHeight`, `maps.clouds`, `Bodies.tsx:532-553`, `preload.ts:16,118`                                                                                                            | Move or delete `cloudEntry.gpu.test.ts` and the cloud cases of `materials.gpu.test.ts` and `bodyUniforms.test.ts`; rewrite `docs/concepts/rendering.md` and `planet.ts`' map table in the present tense; recapture plates (`pnpm presets:plates <id>`) and run `pnpm presets:compare`. |
| Diagnostics and settling (§5.5)           | A `RenderHost` member and its `renderHost()` default (`packages/devtools/src/host.ts`), an engine hook like `galaxyRenderer`, `harness.ts` `settled()`                                                                                                           | Report types are plain data in `devtools`; `harness.ts` scores 84.41 and `observatory.ts` 90.91.                                                                                                                                                                                       |
| Phase-0 measurement (§9)                  | `ir.gpu()` A/B in one boot, `ir.passes()`; a sweep script if one is needed                                                                                                                                                                                       | Rule 68: a new runner takes `acquire()` from `scripts/gpuLock.mjs`; a quiet machine; one GPU job at a time.                                                                                                                                                                            |
| Mie tables generated offline (§5.3)       | `apps/ingest/src/<name>.ts` writing a `*.generated.ts` headed `// Generated by …` (as `packages/universe/src/galaxy/skyCalibration.generated.ts` is), run as `node apps/ingest/src/<name>.ts …` behind `if (process.argv[1] === fileURLToPath(import.meta.url))` | Reachable from a test for knip; formatted after generation; only `*.glb`, `*.blend` and the audio masters are LFS today.                                                                                                                                                               |
| A weather quality lever                   | `render/quality.ts`, `state/preferences.ts`, `state/engineKnobs.ts`                                                                                                                                                                                              | Named steps with a measured cost; a graph change is a second material.                                                                                                                                                                                                                 |
| CPU-side weather maps on workers, if any  | `defineTask` in the registry, the pool                                                                                                                                                                                                                           | Rule 8; a version bump with any payload change.                                                                                                                                                                                                                                        |
| Documents for each landed phase           | ADR 0063 and on, `wings.mjs`, `docs/adr/README.md`, `CONTEXT.md`; the plan's section removed                                                                                                                                                                     | Rules 46 and 47; the present tense.                                                                                                                                                                                                                                                    |

---

## 10. What breaks if done naively

1. Loop reads without `.level()` — undefined results on Chrome, fine on Firefox
   (§0 item 1; plan §5.2 and §12).
2. A march built at material scope — a vacuum and no error (§0 item 2).
3. A nested light-tap `Loop` inside the view `Loop` without names — the outer
   index silently reads the inner one (§0 item 3).
4. A nearest or `FloatType` stand-in for a half-float, linear volume — a frozen
   `textureLoad` program, or a refused module where a gradient sample names an
   undeclared sampler (rule 56); one stand-in under two nodes — one binding, and
   the second map never bound (rule 57).
5. A `Storage3DTexture` left with `generateMipmaps = true` — a mip chain three
   allocates and cannot fill (plan §5.1 and §12).
6. A full-screen pass using `cameraPosition` or `cameraProjectionMatrixInverse` —
   the quad's camera; a ray built from `uv()` without minding `QuadMesh`'s `v` —
   the picture mirrored about the horizon (`galaxyVolume.ts:206-213`).
7. A scene-pass attachment added without counting its bytes — a pipeline the
   device refuses at `maxColorAttachmentBytesPerSample` (plan §12).
8. A composite drawn as a scene object, its `renderOrder` chosen by forward-Z
   intuition — the wrong order under reversed depth unless `installSceneOrder`
   is accounted for (plan §12, `sceneOrder.ts`).
9. A hand-written `compileAsync` — invisible and culled objects compile nothing
   and resolve as if they had; a warm against the canvas builds a variant the
   scene pass never uses (rule 61, ADR-0030).
10. A disposed warm material — the pipeline it compiled is evicted
    (`preload.ts:55-59`).
11. A `TempNode` left at `NodeUpdateType.FRAME` — it draws once per three frame,
    not once per render call, so `ir.gpu()`'s forty renders time one trace
    (`sensor.ts:172-190`).
12. A compute kernel without its index guard — the last element holds whichever
    excess invocation ran last (`docs/guides/testing.md:423-427`).
13. An error scope held across an await — it interleaves with three's own
    pipeline scopes (`terrainProducer.ts:560-590`).
14. A time or a position uploaded as float32 from an epoch or a planetary
    radius — steps of 64 s, of half a meter, or 2.4 km of drift (§3.4).
15. A shading term on the ground only, or on the sphere only — a step at the
    eight-pixel relief gate (rule 59).
16. A readout that throws or writes — the scene can disappear over a number
    (rule 65).
17. A pass label built per frame, or holding an address — an unbounded set of
    aggregation keys (`.claude/rules/timing.md`).
18. Code added to `observatory.ts` or `harness.ts` — fta's cap (§1.7).
19. A file written by a shell command or a generator and not formatted —
    `format:check` fails in CI, not in the Stop hook.
20. A new `docs/` page missing from `wings.mjs` — `docs:build`, `build` and
    `check` fail (rule 46).
21. A GPU test that needs LFS, or a feature the CI adapter lacks, without a
    skip — the macOS job goes red for the hardware, not the code.
22. Taking the Stop hook as a shader check — it never runs one; "an unavailable
    or skipped GPU does not count as a passing shader check"
    (`docs/guides/testing.md:382-388`).
23. Importing `three` instead of `three/webgpu` — nothing fails; the material is
    a classic one the renderer converts behind your back (rule 60, review only).
24. A British identifier (`vapour`, `grey`, `neighbour`, `normalise`) —
    `spelling:check` in the full check.

---

## 11. Inferences to verify, and open questions

- **The MRT budget**: the 30-of-32-bytes figure for the temporal layout uses the
  WebGPU specification's render-target pixel byte costs from memory, not
  re-read here (rgba16float 8, rg16float 4, r8unorm 1, rgba8unorm 8; 16-bit
  formats aligned to 2). Context7 did not return the table. Confirm with a GPU test that adds one
  row and reads the device's refusal, or read the specification's format table.
- **The CI adapter's features**: whether the `macos-15` paravirtual device offers
  `texture-formats-tier1`, `float32-filterable` or `shader-f16` is not recorded
  in the tree; the `gpu` job's adapter summary would say.
- **f16**: `enableShaderF16()` has no caller in three's source; whether a
  `wgslFn` body that needs `enable f16;` works through the builder is untested.
- **A compute trace or a quad trace**: the repo's marches run as fragment quads
  (the galaxy) and its batch work as compute (terrain, extinction, the meter). A
  compute trace gets level-0 reads for free but has no MRT, no blending and no
  `runQuadPasses` naming (it is named by `setName`); phase 0 decides.
- **The `.level()` GPU test**: plan §5.2 asks for a test that fails without it.
  Pixels on one GPU cannot reliably show undefined behavior, so a
  WGSL-structure assertion is proposed here; there is no precedent in the tree.
- **Where a weather report type lives**: `packages/devtools`, beside
  `GalaxyRenderReport`, by analogy; `settled()`'s shape changes with it, and
  `harness.ts` has about 6.6 points of fta headroom.
- **"The sky's calibration is committed as generated data"** (plan §5.3) most
  plausibly means `packages/universe/src/galaxy/skyCalibration.generated.ts`,
  generated by `apps/ingest/src/galaxyReference.ts`; confirm before copying its
  shape for the Mie tables.
- **The ADR number**: 0063 is next on this tree; a sibling branch or an open PR
  can take it first.
- **Existing reads in non-uniform flow**: `seaReflection.ts:399` samples
  `frame.sample(uv)` inside an `If` in the fragment stage, which is not the
  plan's rule; it is outside this area and unmeasured.
