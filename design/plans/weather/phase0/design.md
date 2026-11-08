# The weather, phase 0 (feasibility): engineering design

The plan is `design/plans/the-weather.md`, and this design covers its §10 row 0.
The tree is `feat/the-weather-stacked-prs` at `c2a50f1`, three 0.185.1.
I read the plan in full and the eight scratchpad maps in full (pipeline, temporal,
air, surfaces, deck, harness, record, conventions). Every map claim this design
leans on was re-read in the code first; §0.3 lists them. **Inference** marks
anything not read off code or run. No GPU was used. One headless CPU probe
(`openSession`, Node 26, outside the tree) listed the far-shore system's bodies
for §8.

This revision answers two adversarial reviews. Each finding was checked against
the code, the plan, or a computation, and the design was changed in place; the
**Critique log** at the end lists every finding, its verdict and what changed.
Three CPU computations were run for it, all outside the tree: the reviewers'
float32 altitude emulation, their Lorenz–Mie port for the glory, and the same
port for the small rows' extinction (§0.3).

This document binds the implementation packages of §11. If a package needs an
interface another package provides, the interface is in §3 and in the contracts
package (§11.1). If it is in neither place, the package does not invent it. It
asks the orchestrator.

---

## 0. The phase on one page

### 0.1 What phase 0 is

- Phase 0 lands every cloud pass the plan names: the maps, the cache, the sun's
  optical depth, the trace, the history and the composite. Each sits in its final
  place in the frame and draws a **placeholder** field: analytic weather scenarios
  through the real recipe (map coverage × genus profile × eroded noise).
- **Nothing is drawn on `main`.** The URL flag `?clouds=1` builds the cloud system
  for the page's lifetime. Without the flag, not one cloud object, pipeline,
  allocation or layer mark exists. With the flag, nothing draws until
  `engine.clouds.on` is set. `presets:compare`, the plates and the ledger never
  pass the flag, so none of them can move.
- All four choices are made against their alternatives by rules fixed before
  any measurement (§8.7): the composite's placement, the far field, the cache and
  the sun's optical depth. Cache and sun depth are decided together, as a 2 × 2,
  because the grid is summed through the volume. Every candidate is built far
  enough to measure fairly except the far field's `levels`, which the far-field
  rule's memory clause excludes under any accounting of its bytes; ADR-0064
  records that from the arithmetic (§1.3). The rest are measured on the
  fan-cooled Mac mini (Mac18,5, Apple M6, 32 GB) at 1920×1080 and 2880×1800,
  production build, A/B in one boot, and decided in ADRs. The losing code is
  removed before the PR lands (§1.6).
- Phase 0 also lands the offline Mie table for droplets (its glory test included)
  and settles the scene unit by naming, which moves no picture.

### 0.2 Decisions this design makes

1. **Every cloud pass is a three.js pass, written in TSL and named on the
   timeline.** That includes candidate B. The hand-rolled split ends the scene
   pass and _submits what the scene encoder holds_. It then swaps a fresh
   encoder into the render context and resumes on it, so the ordinary three
   renders and computes issued inside the split execute after the first half and
   before the resumed half (§4.2). No pass is raw WebGPU. That answers the
   pipeline map's objection to B (map §11.3 item 2).
2. **The trace, the history and the residual meter are compute passes.** They
   write `rgba16float` storage textures, every one made through one helper that
   turns three's storage mip chain off (§3.7). The trace writes 72 B a texel,
   which no 32-byte MRT holds, and a compute stage reads every texture at level
   0 by construction. Each pass is named with `ComputeNode.setName`. The depth
   copy, every bake and every progressive cache are fragment quads drawn through
   `runQuadPasses`. The composite is a scene object.
3. **One node drives a frame's cloud work.** `CloudFrameNode` (its own file,
   `cloudFrameNode.ts`) lives in the composite's material
   (`updateBeforeType = RENDER`, as the galaxy's and the sea's nodes are). It
   runs every cloud pass at the composite's draw. Under A that is inside pass B,
   before its first draw. Under B it is inside the split. Both placements
   therefore issue compute inside an open render, and the premise spike tests
   both (§11.1).
4. **Per-frame cloud state is built inside `sensor.render()`.** The sensor's
   frame closure carries `SensorFrame.clouds`, and the cloud system evaluates it
   in `beginFrame`, before `post.render()`. `ir.gpu()` and `ir.passes()`
   therefore measure real work with live uniforms. The forced-path levers make
   held frames take the expensive paths a held still loop never reaches:
   `reset` (the immediate regime), `cut` (every eye-anchored level and cascade
   rebuilt, as a teleport does), `scrub` and `warp` (the field's clock and the
   body-fixed sun both move) and `fly` (a synthetic eye velocity, so strips,
   dirty rectangles and re-anchors run) (§3.3).
5. **Composite light uses the ΔL form.** The trace outputs the cloud's own light
   `L_c`, the blocked air `B` (signed) and `T_c`, all relative to the span start
   `t₀`. The composite draws
   `out = T_c·scene + (1 − T_c)·L_a(0,t₁) + T'_a(0,t₀)·L_c + T_a(0,t₀)·B`.
   This is the plan's identity rearranged (§5.11): the cloud's light is dimmed
   by the transmittance a surface takes there, and the blocked air by the
   physical one the scene's own air was accumulated through. It equals the scene
   bit-for-bit wherever there is no cloud, whatever the quadrature. The thin form
   is the same expression with `B` dropped and `t₁ → d₁`. Where the scene stands
   in front of part of the cloud's depth, the whole cloud term is weighted by
   the share in front of it.
6. **The composite reproduces the air each pixel already carries.** Sky pixels
   take the shell's rule: no beam clearing, physical transmittance, 6 + 6 samples
   where the shell takes 12. Surface pixels take `airToward`'s rule: 4 + 4
   samples, the beam cleared by `clearedFromOrbit·ORBIT_AIRLIGHT`, and the
   cloud's light dimmed by the cleared transmittance. The class is the shell's
   own depth test: sky where the scene's depth lies at or past the air's outer
   far wall, within the depth copy's precision, and never against the shell's
   ground branch (§5.11). The trace classifies its own texel by the same test
   and accumulates `B` with that class's beam.
7. **A second clouded body draws its far march in the composite.** It uses the
   thin form, an atlas baked from the placeholder's own coverage function (it has
   no weather cube) and its own `AirUniforms` with their own stand-ins
   (rule 57). It does not go in the sphere material, whose one pipeline serves
   every body. ADR-0063 decides where phase 1 puts it (§12.1, question 4).
8. **Losing alternatives are deleted before landing.** The PR's commit after
   the measurement removes them, and the ADRs cite that branch commit. Levers
   that are quality steps or measurement forcing stay (§1.6).
9. **The scene unit is settled by naming, not by moving pictures.**
   `SCENE_UNIT_LUMINANCE = E⊥/π` is 42,590 cd/m². `SURFACE_LUMINANCE` stays 30,000
   as _the sensor's calibration white_, and the 1.420 ratio between them is
   pinned. The galaxy, star and disk conversions that use 30,000 as a unit are
   recorded as open defects for phase 5 (§7).
10. **A wet world is derived, not recorded:**
    `seaLevel !== null && liquidKind === 'water' && aerosolDepthOf(haze) < 1`,
    where `aerosolDepthOf` is the depth the air's own recipe draws
    (`haze.aerosolDepth ?? TAU_MIE·thickness`), exported once from
    `atmosphere.ts`. The far-shore world passes, since its haze is the dust family
    at τ 0.4. Earth passes. A sulfuric deck (τ 8), Titan's haze (τ 4.3) and an
    unauthored haze thicker than 8.3 do not (§3.1).
11. **Jitter is interleaved gradient noise with an R1 frame offset**, behind
    `traceJitter()`, standing in for spatiotemporal blue noise until phase 1
    ships a mask. The cost is one hash a ray either way (§5.5).
12. **The immediate regime traces every history pixel in four dispatches.** One
    per interleave phase, each at the trace's extent and `maxSteps/4`, each
    followed by a history kernel that writes that phase's pixels fresh. Nothing
    is written outside a texture, the trace textures keep their size, and the
    reset frame does one converging frame's ray budget (§5.14).
13. **The cascades scroll toroidally, as the plan says, and every sun-depth
    candidate rebuilds under one per-frame cap.** A cascade's front depth is
    stored as a pair of half floats, so storage does not decide the sun-depth
    choice (§3.12).
14. **The packages are staged.** The contracts, the CPU arithmetic, the TSL
    geometry and the placement mechanics land before the GPU fan-out, so no
    package builds on another's unimplemented internals, and the premises that
    would change formats are settled first by a GPU spike (§11).

### 0.3 Re-read in the code for this design

| Claim                                                                                                                                                                                                                                                                                                                                       | Where                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each `render()`/`compute()` makes and submits its own encoder; `finishRender` reads `renderContextData.encoder` fresh before submitting                                                                                                                                                                                                     | `three/…/WebGPUBackend.js:940`, `:1188`, `:1278`                                                                                                   |
| `copyFramebufferToTexture` ends the current pass, copies on the same encoder, sets every load op to `load`, begins again, restores viewport and scissor                                                                                                                                                                                     | `WebGPUBackend.js:2736–2856`; `Renderer.js:2970–3027` (a `Vector2` rectangle copies the texture's own size)                                        |
| Nested renders and computes save and restore `_currentRenderContext` and `nodeFrame.renderId`                                                                                                                                                                                                                                               | `Renderer.js:1531–1532/1763–1764`, `:2734/2811`                                                                                                    |
| `PassNode.setLayers(null)` returns the pass to the camera's own mask; the pass saves and restores `camera.layers.mask`                                                                                                                                                                                                                      | `PassNode.js:399, 518, 812–821, 874`                                                                                                               |
| `compileAsync` projects through `_projectObject`, which drops an object whose layers fail the camera's (so a warm-up with a camera that does not test layer 1 compiles nothing on it); lights are pushed only when their layers pass                                                                                                        | `Renderer.js:966–975`, `:3081–3087`                                                                                                                |
| A `RenderTarget3D` slice is bound as a 3D view with `depthSlice`; a layer of a 2D-array target as a one-layer view                                                                                                                                                                                                                          | `WebGPUBackend.js:625–690`                                                                                                                         |
| A colorNode material's `mrtNode` alone defines the outputs when the renderer's MRT is null                                                                                                                                                                                                                                                  | `NodeMaterial.js:559–583`                                                                                                                          |
| `StorageTexture` keeps `Texture`'s `generateMipmaps = true` and sets `mipmapsAutoUpdate = true`; a store binding marks the texture and its next sampled binding regenerates the chain with raw passes. `Storage3DTexture` extends `Texture`, so it allocates the chain and nothing fills it. A `RenderTarget`'s textures default to no mips | `StorageTexture.js:62`; `Texture.js:257`; `Textures.js:295–296, 538–540`; `Bindings.js:407–421`; `Storage3DTexture.js:13–40`; `RenderTarget.js:55` |
| Outside the fragment stage the WGSL builder emits `textureSampleLevel(…, 0)`; a fragment read is `textureSample` unless a level is named                                                                                                                                                                                                    | `WGSLNodeBuilder.js:345–411`                                                                                                                       |
| The sensor's chain, its restore list and its `pictureKey`                                                                                                                                                                                                                                                                                   | `render/sensor.ts:161–190, 285–296, 472–557`                                                                                                       |
| `SensorFrame` is evaluated inside `render()`; `engine.present` calls `chain.render()`; the chain is built in Sensor's mount effect, whose dependencies are `[gl, scene, camera, engine, picture, diagnostic, handover]`                                                                                                                     | `scene/Sensor.tsx:55–62, 69–145`; `render/sensor.ts:362`                                                                                           |
| `warmAtMount` registers a producer that holds the boot cover; it does not order anything before a component's own effect                                                                                                                                                                                                                    | `render/warmup.ts:527–540`                                                                                                                         |
| `<Canvas onCreated>` is where the app first holds the scene and camera (`engine.view`)                                                                                                                                                                                                                                                      | `App.tsx:778–783`                                                                                                                                  |
| `measureGpu`/`measurePasses` hold the loop; held `useTimedFrame` callbacks return early                                                                                                                                                                                                                                                     | `engine/GameEngine.ts:414–441`; `scene/useTimedFrame.ts:35`; `engine/frameHold.ts`                                                                 |
| `sensorRadiance` multiplies `output.rgb` by `sceneRadianceGain`; the shell's `colorNode` is `inscatter·sunColor·ATMOSPHERE_GAIN` with no gain of its own                                                                                                                                                                                    | `render/radiance.ts:95–112`; `render/materials.ts:410–423`                                                                                         |
| The shell's `far` is the outer wall, or the analytic sunk sphere where the ray meets it; the drawn sphere is a `SphereGeometry(1, 512, 256)` at the nearest tier, its facets inscribed                                                                                                                                                      | `render/materials.ts:344–375`; `scene/Bodies.tsx:156–160, 258`                                                                                     |
| `marchAir`, `airToward`, `sunThrough`, `clearedBeam`, `stepShare`, `crowdedSamples`, the stand-ins; `airToward` clears its march's beam by `clearedFromOrbit·ORBIT_AIRLIGHT`, `sunThrough` by `clearedFromOrbit` whole, the shell not at all; `crowdedSamples` reads no texture                                                             | `render/air.ts:121–129, 266–349, 351–373, 434–478, 711–743, 784–858`                                                                               |
| The air's aerosol depth is `haze.aerosolDepth ?? TAU_MIE·thickness`, `TAU_MIE = 0.12`; `aerosolDepth` is optional on the record                                                                                                                                                                                                             | `packages/rendering/src/atmosphere.ts:194, 466`; `packages/universe/src/system.ts:351–358`                                                         |
| `motion.z` is `1/(−positionView.z)` in render meters; defocus and the meter read it as inverse depth                                                                                                                                                                                                                                        | `render/sensorMrt.ts:52–57`; `render/defocus.ts:101, 155`; `render/meter.ts:76–77`                                                                 |
| `gpu.pipelinesBuilt()` wraps `createRenderPipeline` and `createRenderPipelineAsync` only; three builds compute pipelines with a synchronous `createComputePipeline`; the meter already dispatches compute in the sensor's frame                                                                                                             | `render/gpuHarness.ts:391–420`; `three/…/WebGPUPipelineUtils.js:417`; `render/meter.ts`                                                            |
| One query set holds 4,096 slots, 2,048 passes; `summarize` divides every label's total by the frames asked for, dropped or not                                                                                                                                                                                                              | `render/passTimeline.ts:141–146, 565–577`                                                                                                          |
| `runQuadPasses` renders each `draw` as its own render, so each quad is its own pass on the timeline                                                                                                                                                                                                                                         | `render/quadPass.ts:61–98`                                                                                                                         |
| `drive.mjs` keys the Chrome profile on the port, under `.data/drive/profile-<port>`, and keeps it; `--fresh` only re-boots the page                                                                                                                                                                                                         | `scripts/drive.mjs:227–235, 529`                                                                                                                   |
| Frame statistics are `ir.status().frame` (`fps`, `frameMs`, `ticksLastFrame`); there is no `ir.frameStats`                                                                                                                                                                                                                                  | `packages/devtools/src/harness.ts:288–302`; `host.ts:40–44`                                                                                        |
| `ir.profile(ms)` returns spans (`meanMs`, `p95Ms`, `maxMs` per name and track) and late frames                                                                                                                                                                                                                                              | `packages/devtools/src/harness.ts:1624–1652`; `profile.ts:93–158`                                                                                  |
| A body's spin is `rotationPeriod`, signed, seconds                                                                                                                                                                                                                                                                                          | `packages/universe/src/system.ts:242`; `frames.ts:297`                                                                                             |
| `SURFACE_LUMINANCE = 30_000` "under terrestrial sunlight"; `SOLAR_LUMINANCE = 1.6e9`; the anchor's `EXTRATERRESTRIAL_LUX = 133_800`                                                                                                                                                                                                         | `packages/rendering/src/exposure.ts:3–5`; `atmosphere.test.ts:284–293`                                                                             |
| The generated-data pattern, run as a script, reachable through its test                                                                                                                                                                                                                                                                     | `apps/ingest/src/galaxyReference.ts:181–226`; `galaxyReference.test.ts`                                                                            |
| knip entries: app tests, package `index.ts` and tests, ingest `main.ts` and tests, `scripts/**/*.mjs`                                                                                                                                                                                                                                       | `knip.jsonc:60, 82–114`                                                                                                                            |
| `settled()`'s exact shape; `renderHost()` defaults member by member                                                                                                                                                                                                                                                                         | `packages/devtools/src/harness.ts:711–744`; `host.ts:354–386`                                                                                      |
| Levers as engine fields (`surfaceQuality`); diagnostics in `QUERY`                                                                                                                                                                                                                                                                          | `GameEngine.ts:489`; `render/quality.ts`; `pages/paths.ts:268–353`                                                                                 |
| `engine.visibilityProcessing`, `requestSensorSettings`, `bodyFor`, `scene()`                                                                                                                                                                                                                                                                | `GameEngine.ts:757, 764, 1166, 1338`                                                                                                               |
| The wave clock's reduction                                                                                                                                                                                                                                                                                                                  | `render/water.ts:199–208, 685–689`                                                                                                                 |
| ADR-0062 is the highest; the next is 0063; the "Decision Records" group                                                                                                                                                                                                                                                                     | `docs/adr/`; `scripts/docs/wings.mjs:105–236`                                                                                                      |
| Far-shore is `P222_1_0_9 V`: rocky, 3,980 km, sea level 0.453, water, ground 343 K, air 2.43 kg/m³, dust haze at τ 0.4; its moon `V a` is 144 km and airless; `IV` is 3,464 km, has a dust haze and no sea                                                                                                                                  | headless probe (§8.1)                                                                                                                              |

**Computed for this revision, outside the tree, on the CPU:**

- The float32 emulation of §5.3's altitude, every operation through
  `Math.fround`, 2 × 10⁶ samples over the stated domain: worst 0.764 m over the
  whole domain, 0.088 m where h(t) ∈ [−1, 20] km, 0.123 m for Earth from 400 km
  with h(t) ∈ [0, 20] km (the reviewer's `scratchpad/review/altitude.mjs`, re-run).
- The reviewer's BHMIE port (`scratchpad/review-mie/glory.mjs`), monodisperse,
  re-run: the red band's (680 ± 40 nm) first intensity maximum past the central
  peak at 3.09°, 1.90°, 1.20° and 0.82° for r = 6, 10, 16 and 25 µm, against
  24/r = 4.00°, 2.40°, 1.50° and 0.96°; in white light (300 wavelengths,
  380–700 nm, an analytic CIE 1931 fit) the 10 µm drop's redness maxima at 2.19°
  and 3.70° against Laven's 2.40° and 3.70°; Q_ext from 2.08 to 2.42 across the
  2–4 µm rows and the three bands.

---

## 1. Scope

### 1.1 What lands, item by item

| Plan item                                                                     | What lands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Owner                                     |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Placeholder density through the real passes: **the maps**                     | Weather cube: a 2D face atlas (6 × 514², one-texel gutters), four RGBA8 MRT targets, baked from the placeholder's coverage function, one face a frame steady and six over six frames after a jump. Clipmap: six levels (250 m × 2ᵏ texels), a 256² 2D array, four RGBA8 MRT targets, baked from the cube, refreshed toroidally in strips with a time refresh of ⅛ of a level a frame. The far bakes take their coverage from the cube too, through `synopticMedium`, so the whole body is covered (§3.10) | WP4                                       |
| **the cache**                                                                 | Local volume: levels 50/200/800 m, each 256² × 32 (+2 guard slices) RG8, stacked in one `RenderTarget3D`, baked in slices on a per-frame budget. A max-mip bound (4³ bricks dilated by one texel, RGBA8 storage) for skipping empty space, which steps to the brick's exit. Beside it, the field path the volume caches                                                                                                                                                                                   | WP5                                       |
| **the sun's optical depth**                                                   | Cascades: three 512² RGBA16F sun-space Beer shadow maps (front depth as a pair of half floats, mean extinction, maximum optical depth), scrolled toroidally, one slice a frame for time, one cascade a frame rebuilt on a sun move or a jump. Grid: 128 × 128 × 32 R16F of optical depth to the sun, summed through the volume, ⅛ a frame, rebuilt whole on a sun move or a jump. Both under one per-frame cap. The light taps (2 or 4 over the first kilometer) and `sunThroughAt`                       | WP5                                       |
| **the trace**                                                                 | Compute at ¼ of min(render, CSS) axes. Adaptive steps, max-random segment mixing, the step-integral light, the phase shortcut through the Mie table, four depth knots, depth moments, the class-matched blocked air, handover to the far march by footprint, an immediate regime in four phase dispatches, a step counter. Four kernels, one per (cache, far) pair, and a sweep kernel                                                                                                                    | WP6                                       |
| **the history**                                                               | Compute at ½. A stride-2 interleave in Bayer order, reprojection in body-fixed axes with the wind applied first, parallax, depth and scene-depth rejection, a 3 × 3 variance clip, a NaN guard on read and on write, two regimes (converging kernels for each parity, and an immediate kernel that writes one phase's pixels)                                                                                                                                                                             | WP8                                       |
| **the composite**                                                             | A full-screen scene object in two placements, identity and thin forms, writes to `reactive`, `motion` and `meterMask`, a nearest-depth upsample, terrain occlusion by depth moments weighting the whole cloud term, a second-body far march, the knot consumer `cloudFront()`, the residual meter                                                                                                                                                                                                         | WP9                                       |
| **in their final places**                                                     | §4's schedule: after everything a cloud stands in front of, including the sea's depth, and before world transparency and the overlays. The split, the over pass, the frame node and the depth copy                                                                                                                                                                                                                                                                                                        | WP3, WP11                                 |
| **A sweep of fetches a second** (rays, steps, reads a step, R8 against RGBA8) | A sweep kernel at constant work: fixed 4 m steps, no stop, no exit, no sun, air or far march; reads from one fetch type at a time (§8.4). Levers `traceScale`, `fixedSteps`, `sweepReads`, `sweepExtra` and `noiseFormat`; batch `sweep`                                                                                                                                                                                                                                                                  | WP4 (medium), WP6 (kernel), WP10 (runner) |
| **The four choices**                                                          | The candidates of §1.3, batch `decisions`, the measurement instruments, the rules of §8.7                                                                                                                                                                                                                                                                                                                                                                                                                 | All; WP12 for the instruments             |
| **The thin form's error on the scene as built, Enhanced off and on**          | Composite modes `thin` and `residual`. The residual meter is compute after the frame, reading the scene as built with the composite inert. Batch `error`                                                                                                                                                                                                                                                                                                                                                  | WP9, WP10                                 |
| **A transparent object between two cloud layers**                             | The trace's four knots, `cloudFront()`, and `cloudFront.gpu.test.ts` covering lit in front and dark behind, then the reverse                                                                                                                                                                                                                                                                                                                                                                              | WP6, WP9                                  |
| **The Mie table, generated offline**                                          | `apps/ingest/src/mie.ts` (the series) and `mieTable.ts` (the generator) write `packages/rendering/src/mieDroplets.generated.ts`, with each row's red-band glory angle taken from the series. Its decoder is `packages/rendering/src/mieTable.ts`. The GPU upload is `render/cloudPhase.ts`                                                                                                                                                                                                                | WP2, WP5                                  |
| **The scene unit settled**                                                    | `SCENE_UNIT_LUMINANCE`, a renamed meaning for `SURFACE_LUMINANCE`, pinning tests, and recorded defects                                                                                                                                                                                                                                                                                                                                                                                                    | WP10                                      |

### 1.2 Done-when, item by item

**"§9's targets carry the M5's figures at 1080p and Retina"** becomes the M6
mini's figures. The ADRs name the hardware, Chrome's version and the thermal
state.

| §9 row                         | Phase 0 measures it?                                                            | Instrument                                                             |
| ------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Maps, clipmap and the max-mip  | Yes                                                                             | `ir.passes`: `cloud maps`, `cloud clipmap`, `cloud volume bound`       |
| Far atlas and reflection probe | The atlas yes; the probe is phase 1                                             | `cloud far atlas` (the probe row stays a target)                       |
| Local volume, if baked         | Yes                                                                             | `cloud volume`                                                         |
| Sun's optical depth            | Yes, both candidates                                                            | `cloud sun cascade`, `cloud sun grid`                                  |
| Trace at ¼ × ¼                 | Yes                                                                             | `cloud trace`                                                          |
| History at ½                   | Yes                                                                             | `cloud history`                                                        |
| Composite, and the split       | Yes, both placements                                                            | `scene over clouds` minus its draws without clouds, plus `cloud depth` |
| Shadowed air                   | **No**: phase 2 puts taps in `marchAir` (plan §6.3 assigns that A/B to phase 2) | stays a target                                                         |
| The sea's far reflection       | **No**: phase 1–2                                                               | stays a target                                                         |
| Near rain                      | **No**: phase 4                                                                 | stays a target                                                         |
| On the ground, dry / in rain   | Dry yes; rain is phase 4                                                        | `ir.gpu` A/B, `fair-cumulus`                                           |
| From orbit                     | Yes                                                                             | `ir.gpu` A/B at 400 km                                                 |

The kind of figure, crossed with the scenarios (§8.2) and both sizes:

| Kind                            | How                                                                                                                                                                                                                                                                           | Scenarios                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Steady                          | `ir.gpu(120)` ×3, min, 5 pairs (decisions) or 3 pairs (targets); `ir.passes(n)` with `n` from the frame's pass count (§8.3)                                                                                                                                                   | all                       |
| On a reset frame                | The larger of `force: 'cut'` (every eye-anchored level and cascade rebuilt each held frame, and the immediate regime) and `force: 'scrub'` (a 3 h jump each held frame, the sun turning with the body). `force: 'reset'` (the immediate regime alone) is recorded beside them | all                       |
| In memory                       | `ir.clouds().bytes`, declared from each texture's dimensions, texel size and level count, and held to the GPU textures' own size and levels by `cloudSystem.gpu.test.ts`                                                                                                      | all, recorded once a size |
| In cold compile                 | Boot census span `warming the clouds` on a Chrome profile deleted before each boot (the OS's Metal cache may be warm, and each figure says so), plus `cloudWarm.gpu.test.ts`: no render or compute pipeline built on the first frame of any lever set                         | boot                      |
| Broken-cloud horizon            | `broken-horizon`, ground, pitch +2°                                                                                                                                                                                                                                           | far-shore, Earth          |
| Inside a cloud                  | `inside`, eye at 1,200 m in a 800–1,800 m layer                                                                                                                                                                                                                               | far-shore, Earth          |
| Two decks                       | `two-decks`, ground, pitch +30°                                                                                                                                                                                                                                               | far-shore                 |
| A rapid scrub                   | `broken-horizon` with `force: 'scrub'`: every held frame jumps 3 h and the body-fixed sun turns with it                                                                                                                                                                       | far-shore                 |
| Two clouded bodies in one frame | On far-shore's moon `V a` with `V` in frame; and on far-shore with `IV` forced as the second                                                                                                                                                                                  | far-shore system          |

**"Each of the four choices is made against its alternatives, with the
reason."** ADR-0063 decides the placement. ADR-0064 decides the far field, the
cache and the sun's optical depth, the last two jointly. Each records the
figures, the rule from §8.7 that decided it, and what the loser cost. The far
field's `levels` is decided by arithmetic, and ADR-0064 shows it.

**"The glory's first ring sits at its radius in the table."** Two tests carry
it (§6.6). `apps/ingest/src/mie.test.ts` holds the series to Laven's own
quantity: the red rings of monodisperse drops in white light at 24/r and 37/r.
`packages/rendering/src/mieTable.test.ts` holds the committed table's red-band
ring to the series' own ring for that row, within the table's angular step.
Both are Node tests in the gate.

### 1.3 The four choices: candidates, the minimal fair build, and what happens to the loser

| Choice                                      | Candidates (plan's names)                                                                                                                                                                                                                                                                                                                                                                           | Minimal implementation that measures it fairly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Compared on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Composite placement**                     | **A**: two scene passes over a layer split. **B**: a hand-rolled split after the sea. **C** (pipeline map §11.4): riding the sea's own split                                                                                                                                                                                                                                                        | **A**: `CloudOverPassNode` in the sensor chain renders `scene` again with `camera.layers.mask = OVER`, `autoClear = false`, into the same target and MRT; `scenePass.setLayers(UNDER)` for the frame; under the flag every over-cloud object is marked `OVER_CLOUDS_LAYER`, the camera tests layers 0 and 1 from its creation, and the lights test every layer. **B**: `splitScenePass()` called from the composite's frame node, with the composite transparent at `renderOrder` 1.5; under the lever, orbit traces move to 1.75 and the cinematic staged sky to 1.25. **C is not built**: its saving is at most one split's cost on a sea frame, which B measures directly with `placement: 'empty-split'` (the split with no cloud work and a composite that discards). If that costs under 0.1 ms at Retina, C cannot pay for a seabed depth, sea-only frames and raw encoder work                                                                                                                                                                       | GPU `ir.gpu` A/B against clouds off, at both sizes, on ground with a sea (far-shore), inside, and from orbit. CPU: the `sensor` span and the late frames of `ir.profile`, because A walks the scene graph twice, with a threshold fixed in §8.7. Correctness (§4.3): which overlays end up under the clouds                                                                                                                                                                                                                                                               |
| **Far field**                               | Three-layer **atlas** (plan's candidate); the local volume's **coarse levels** carried out to the planet; density and light cached on **spheres** at the layers' heights (Weinrauch)                                                                                                                                                                                                                | **atlas**: 6 faces × 3 layers × 258² RGBA8 (fraction, log in-cloud τ, base, top), baked from the cube's coverage over 4 × 4 sub-columns × 8 heights a texel, marched as slabs one texel a step with per-column mixing and depth moments. **spheres**: per layer, a 6 × 258² RGBA16F cube atlas at the layer's mid-height (fraction, column τ, cached sun transmittance), met at at most two crossings. **levels is decided on paper.** Reaching the limb from the `orbit` stance (1,830 km of gnomonic plane on far-shore, 2,290 km on Earth) takes a sixth level of 51.2 km texels past the 3.2 and 12.8 km ones, because level 4's window ends at ±1,638 km. Its far levels alone are then 3 × 256² × 34 × 2 B = 13.4 MB, 2.8 times the atlas's 4.79 MB (2.9 with their bound), and the whole six-level volume is 26.7 MB, 5.6 times. The far-field rule excludes a candidate whose marginal memory is more than 2.5 times the smallest's (§8.7), so `levels` cannot win under either accounting, and building it would measure nothing the rule could use | The same bake budget a frame and the same handover footprint. Scored against the fine march over the same rays on the four handover cases (cirrus over cumulus, broken cumulus, an anvil, a grazing ray at sunset) in `cloudFarCompare.gpu.test.ts` (WP12, on the real field): the error averaged over each far texel's footprint decides, which separates the representation from the resolution the two candidates share; the per-pixel error at the handover is recorded for phase 1's cross-fade. Plus steady cost from orbit and on the horizon, and marginal memory |
| **Cache × sun's optical depth (one 2 × 2)** | The march reads **the field** (maps, profile and two noises a step) or a **baked local volume** with max mips (one read a step, plus detail noise where the cache is coarser than the footprint). The sun's depth is sun-space **cascades** of front depth, mean extinction and maximum optical depth (UE5's Beer shadow map) or a **grid** around the eye summed through the local volume (Nubis³) | **field**: `fieldMedium()`; four reads a step at the nominal setting; taps read the field. **volume**: three levels baked progressively, the bound, `volumeMedium()`; taps read the volume. The field remains the fallback beyond the volume's reach either way. **cascades**: 3 × 512², extents 12.8/51.2/204.8 km, 48 steps a texel through the union, scrolled toroidally with the exposed strips drawn the frame they appear, one 64-row slice a frame round-robin over the 24 slices for time, and one cascade a frame rebuilt whole on a sun move of 0.05° or a jump. **grid**: 128 × 128 × 32 cells on the volume's level-1 frame, 32 steps through the volume toward the sun, four slices a frame, rebuilt whole on a sun move or a jump. Both under one cap of 16.8 M texel-steps a frame. The grid needs the volume, so `(field, grid)` bakes the volume for the grid alone, and that cost is charged to it                                                                                                                                        | All four combinations against off: steady on `ground`, `horizon`, `inside`; `fly` on `ground` and `orbit`; `cut` and `scrub` on `horizon`; both sizes. The volume's image difference against the field (the field is the reference: the volume caches it). `T_cloud` against a 256-step brute-force sun march at in-cloud samples of five named scenarios at two suns (`cloudSunAccuracy.gpu.test.ts`, WP12, on the real field). Memory                                                                                                                                   |

### 1.4 What does not land, and why

| Not in phase 0                                                                                  | Why                                                                                                                                                                                                                                                                              | Where                                        |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Climatology, ISCCP, the overlap of measured types, orography                                    | Earth's data. The placeholder exists to measure the passes without it                                                                                                                                                                                                            | Phase 3                                      |
| Genus calibration to ISCCP's optical-depth classes                                              | Needs the real genus densities. Phase 0's σ values are §5.1's table, uncalibrated                                                                                                                                                                                                | Phases 1, 3                                  |
| Higher-order transport (octaves or the slab table), the irradiance table, the dark edge         | Physics phase 1 builds against references, and the transport is a measured choice whose cost depends on which one wins (an octave is arithmetic, a slab table is a read a step). Phase 0 draws first order and the placeholder sky term only, and claims nothing about the light | Phase 1                                      |
| `cloudSunlight` in the ground, sea, sphere, hull and flare; shadowed air                        | Rule 59: either all of them at once, at the descent gate, or none. The §9 rows stay targets                                                                                                                                                                                      | Phase 2                                      |
| Reflection probe, the sea's far reflection                                                      | They need the composite chosen first                                                                                                                                                                                                                                             | Phase 1                                      |
| Cyclones, rain, lightning, fog physics, wet ground, Neyret three-phase advection, the warp fade | Phase 0 has a single bounded drift that starts over every hour, counted as a jump (§5.4), and a placeholder `fog` scenario with no fog physics                                                                                                                                   | Phase 4                                      |
| Moon, airglow, cities                                                                           | Phase 5. The scene unit they calibrate against is named now (§7)                                                                                                                                                                                                                 | Phase 5                                      |
| WebGL's far march                                                                               | WebGL gets no cloud system; its report says so (§4.6)                                                                                                                                                                                                                            | Phase 1                                      |
| The STBN mask                                                                                   | IGN + R1 behind the same function (§5.5). Convergence quality is phase 1's to judge                                                                                                                                                                                              | Phase 1                                      |
| A footprint cross-fade with hysteresis at the handover                                          | Phase 0 switches along the ray at the handover distance. That exposes exactly the disagreement the far-field choice records                                                                                                                                                      | Phase 1                                      |
| Retiring Earth's deck                                                                           | When the lever serves Earth, the deck yields for that body (§4.3). On `main` it draws as today                                                                                                                                                                                   | Phase 3                                      |
| Ice and rain phase tables                                                                       | Droplets only. Cirrus in `cirrus-over-cumulus` reads the droplet table's largest row, declared                                                                                                                                                                                   | Phase 1                                      |
| Velocity for temporal FSR, blended by opacity                                                   | The `velocity` row has no blend. The upscaler plan's decided fix (FSR reads masked `motion.rg`) has not landed. Phase 0 writes `motion` correctly and discards where nothing is drawn (§3.16)                                                                                    | Before phase 1 ships clouds under `temporal` |
| The sun-disk convolution (`convolveDisk`) and its per-body upload                               | Its only consumer is the per-body upload. Phase 0 uploads the unconvolved table, whose fetch costs the same                                                                                                                                                                      | Phase 1                                      |
| Clouds in `ir.settled()`, and the `--settle` docs that say so                                   | Phase 0 takes no plate with clouds. The runner waits on the report's own `settle` field (§3.17)                                                                                                                                                                                  | Phase 1                                      |
| The far field's `levels` candidate, built                                                       | Excluded by the far-field rule's memory clause under any accounting (§1.3); ADR-0064 records the arithmetic                                                                                                                                                                      | Not built                                    |
| Any plate of a cloud picture                                                                    | Placeholder density is not judged                                                                                                                                                                                                                                                | Phase 1                                      |

### 1.5 Constraints held throughout

- **No picture moves on `main`.** Without the flag nothing is constructed and
  nothing is marked: no layer, no light mask, no camera mask (§4.7). With the
  flag and the lever off, the frame's pass list, `info.calls` and pixels are
  those of a chain without clouds (`cloudSensor.gpu.test.ts`), and every overlay
  still compiles at boot (the camera tests layer 1 from its creation).
- **Nothing canonical.** There is no hash, no save, no `GENERATION_VERSIONS`
  change, no `SurfaceParameters` or `SurfaceGrammar` field, and no write to
  `appearance.clouds`. Weather seeds come from
  `deriveSeed(surface.seed, 'weather')`, never from a body's `rng`. The wet
  world is a predicate (§3.1).
- **The rules that bind each module.** Rule 52: crossings and every altitude come
  from CPU heights, for the view rays, the light taps, the cascade and grid bakes
  alike (`altitudeAt`, §5.3). Rule 58: lattices read eye-relative,
  period-reduced frames, a level's plane coordinate is formed from the offset
  and float64 eye terms and never from an absolute direction (§3.9), and every
  lattice decision is a `u32`. Rule 56: every stand-in is linear. Rule 57: one
  stand-in object per node, and two `AirUniforms` in one material get their own.
  Rule 60: `three/webgpu` and `three/tsl` only, no three in `packages/*`. Rule
  61: compile-ahead through `render/warmup.ts`, render and compute alike. Rule
  65: reports never throw or write, and report 0 bytes after dispose. Rule 68:
  every GPU job holds the lock. Rule 59: no shading term on the ground, sea or
  sphere at all in phase 0.

### 1.6 What happens to the losers

**The losers are removed before landing.** After the measurement commit
(`chore(clouds): phase 0's figures, measured on the mini`, carrying the runner's
summary tables into the ADRs), one commit deletes the losing placement, far
field, cache path and sun-depth candidate, with their levers, tests, warm-ups
and pipelines. Each ADR names the branch commit the figures were taken at. The
PR is squash-merged, but GitHub keeps the PR's commits under `refs/pull/N/head`,
so a re-measurement checks out that commit.

The reasons:

1. **A selectable loser is a second model kept alive.** The plan's continuity
   rule is "one field at every distance … never a second model".
2. **Each candidate costs every boot.** Its pipelines are compiled at warm (cold
   compile is a Done-when figure), its targets exist at least as stand-ins, and
   its tests run in every `test:gpu`.
3. **Phase 1 stacks on phase 0's branch,** and it should build on one path.
4. **fta has little room.** `cloudTrace` with four variants and a sweep kernel,
   and `cloudComposite` with its residual meter, approach the cap of 91.

**Kept, because they are a quality step or measurement forcing every later phase
needs:** `traceScale`, `maxSteps`, `lightTaps`, `farFootprint`, `composite`
(`identity`, `thin`, and `residual` as a diagnostic; `thin` stays as a real mode
only where §8.7's rule allows it), `force` with all six values, `warp`,
`scrubSeconds`, `flySpeed`, `deck`, `stats`, `served` and `second`. **Removed
with the losers, because they are sweep-only:** `fixedSteps`, `sweepReads`,
`sweepExtra`, the sweep kernel and the sweep medium, and `noiseFormat` together
with the RGBA8 noise and its 8.39 MB.

---

## 2. Module layout

### 2.1 Layering

- **`packages/rendering`** (layer 5, no three, no DOM, no `performance.`) holds
  every piece of arithmetic a shader is held to: scenarios, shells, the clock,
  the cube-sphere, level frames, the budget, the overlap reference, the Mie
  table's decoder, and the noise's CPU reference. These are tested in Node by
  `pnpm test` and are in the gate.
- **`apps/game/src/render`** holds every GPU module: `three/webgpu` and
  `three/tsl` only. It also holds one three-free CPU module, `cloudFrame.ts`, on
  the `bodyUniforms.ts` pattern.
- **`packages/devtools`** holds the report type and the settle predicate as
  plain data. The harness gains one reader and nothing else, because
  `harness.ts` scores 84.4.
- **`apps/ingest`** holds the Mie series and its generator. They are Node-only
  and never shipped.
- **`scripts/clouds`** holds the measurement runner, which holds the GPU lock.

Files in both directories stay flat, as the tree's are, under a `weather*`
prefix (CPU arithmetic) and a `cloud*` prefix (GPU modules).

### 2.2 New files

| Path                                              | Purpose                                                                                                                                                                   | Owner                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `packages/rendering/src/weatherScenario.ts`       | Scenarios, genera, `scenarioCoverage`, `genusProfile`, `shellUnion`, `wetWorld`                                                                                           | WP1                       |
| `packages/rendering/src/weatherShells.ts`         | Eye heights over shell boundaries (float64), stable crossings, altitude along a ray and at a point, `unionSpan`                                                           | WP1                       |
| `packages/rendering/src/weatherClock.ts`          | Period reductions, `periodIndex` as u32 halves, `reducePoint`, `driftOffset`                                                                                              | WP1                       |
| `packages/rendering/src/cubeSphere.ts`            | Tangent-warped cube faces, texel coordinates, gutters                                                                                                                     | WP1                       |
| `packages/rendering/src/cloudFrames.ts`           | Level frames (snapped anchors, toroidal origins, dirty rectangles, float64 eye terms), sun cascades (toroidal, with rebuild flags)                                        | WP1                       |
| `packages/rendering/src/cloudBudget.ts`           | Trace and history extents; `textureBytes`                                                                                                                                 | WP1                       |
| `packages/rendering/src/cloudOverlap.ts`          | The segment-mixing reference the shader is held to                                                                                                                        | WP1                       |
| `packages/rendering/src/weatherNoise.ts`          | CPU reference of the baked Perlin–Worley, Worley and curl noises (tiling, hashed with `pcg4d`)                                                                            | WP4                       |
| `packages/rendering/src/mieTable.ts`              | The `MieTable` type, decoder, angle and row mapping, `samplePhase`, `phaseIntegral`                                                                                       | C (type and stub), WP2    |
| `packages/rendering/src/mieDroplets.generated.ts` | The generated droplet table (about 270 KB of text, §6.5)                                                                                                                  | C (stub), WP2 (generated) |
| `apps/ingest/src/mie.ts`                          | The Lorenz–Mie series (BHMIE structure, Wiscombe's term count), and the white-light ring finder                                                                           | WP2                       |
| `apps/ingest/src/mieTable.ts`                     | The generator: distribution, bands, angles, encoding, each row's red-band glory angle; runs as a script                                                                   | WP2                       |
| `apps/game/src/render/cloudFrame.ts`              | Three-free: `CloudFrameInputs` → `CloudFrame` (served body, heights, sun, reductions, forced paths, regime, extents)                                                      | WP1                       |
| `apps/game/src/render/cloudLevers.ts`             | Lever types, defaults, guard, reset key                                                                                                                                   | C (in full)               |
| `apps/game/src/render/cloudLayers.ts`             | `OVER_CLOUDS_LAYER`, `markOverClouds`, `UNDER_CLOUDS_LAYERS`                                                                                                              | C (in full)               |
| `apps/game/src/render/cloudUniforms.ts`           | The one uniform bundle every cloud module reads, and `write(frame)`, a mechanical copy of the frame's fields                                                              | C (in full)               |
| `apps/game/src/render/cloudNodes.ts`              | Shared TSL shapes (`CloudRay`, `CloudSample`, `CloudMedium`, …), `traceJitter`, `finiteOr`, the storage-texture helpers, the stand-in factories with real bindings        | C (in full)               |
| `apps/game/src/render/cloudGeometry.ts`           | The TSL arithmetic of §3.5b: the view direction, rays, shell crossings, altitude along a ray and at a point, the sun's cosine, samples, level-frame and cube-face lookups | C (in full)               |
| `apps/game/src/render/cloudPremises.gpu.test.ts`  | The premise spike (§11.1): what three r185 does for each premise a format depends on                                                                                      | C                         |
| `apps/game/src/render/cloudNoise.ts`              | The noise bake (`RenderTarget3D` slices, R8, plus an RGBA8 sweep variant) and its sampling nodes                                                                          | WP4                       |
| `apps/game/src/render/cloudProfile.ts`            | Genus × height profile table (a `DataTexture` from `genusProfile`)                                                                                                        | WP4                       |
| `apps/game/src/render/cloudMaps.ts`               | The weather cube atlas: bake, `scenarioCoverageNode`, and `synoptic()` / `channel()` nodes                                                                                | WP4                       |
| `apps/game/src/render/cloudClipmap.ts`            | The clipmap: toroidal strip bake from the cube, and `coverage()`, `column()` nodes                                                                                        | WP4                       |
| `apps/game/src/render/cloudDensity.ts`            | `fieldMedium()`, `synopticMedium()`, `analyticMedium()`, `sweepMedium()`: coverage × profile × eroded noise, fraction and footprint fade                                  | WP4                       |
| `apps/game/src/render/cloudVolume.ts`             | The local volume: slice bake, the dilated bound, `volumeMedium()`, the brick exit                                                                                         | WP5                       |
| `apps/game/src/render/cloudSunCascades.ts`        | The Beer shadow cascades, toroidal                                                                                                                                        | WP5                       |
| `apps/game/src/render/cloudSunGrid.ts`            | The optical-depth grid                                                                                                                                                    | WP5                       |
| `apps/game/src/render/cloudSunlight.ts`           | Light taps, `T_sun` composition, `cloudSunFn()`                                                                                                                           | WP5                       |
| `apps/game/src/render/cloudPhase.ts`              | The Mie table uploaded as RGBA16F, and `droplets(ν, r)`                                                                                                                   | WP5                       |
| `apps/game/src/render/cloudMarch.ts`              | The per-ray fine march as a TSL function (DI: medium, sun, phase), and its sweep mode                                                                                     | WP6                       |
| `apps/game/src/render/cloudKnots.ts`              | Knot recording in the march, and its texel layout                                                                                                                         | WP6                       |
| `apps/game/src/render/cloudTrace.ts`              | The trace kernels, one per (cache, far) pair, and the sweep kernel: dispatch, outputs, the immediate regime's phase dispatches, stats                                     | WP6                       |
| `apps/game/src/render/cloudFar.ts`                | `CloudFarField` selection and the shared slab arithmetic                                                                                                                  | WP7                       |
| `apps/game/src/render/cloudFarAtlas.ts`           | The atlas: block bake and slab march                                                                                                                                      | WP7                       |
| `apps/game/src/render/cloudFarSpheres.ts`         | The sphere caches: block bake and crossings march                                                                                                                         | WP7                       |
| `apps/game/src/render/cloudHistory.ts`            | The history kernels (each parity's converging kernel and immediate kernel)                                                                                                | WP8                       |
| `apps/game/src/render/cloudCompositeAir.ts`       | The per-pixel air reproduction: class, split marches built from `airMediumAt`, clearing                                                                                   | WP9                       |
| `apps/game/src/render/cloudComposite.ts`          | The composite material and its two meshes, MRT writes, the residual meter                                                                                                 | WP9                       |
| `apps/game/src/render/cloudFront.ts`              | `cloudFront()`: what a transparent object sees of the clouds in front of it                                                                                               | WP9                       |
| `apps/game/src/render/cloudSplit.ts`              | `splitScenePass()`                                                                                                                                                        | WP3                       |
| `apps/game/src/render/cloudOverPass.ts`           | `CloudOverPassNode` (placement A)                                                                                                                                         | WP3                       |
| `apps/game/src/render/cloudFrameNode.ts`          | `CloudFrameNode`: the composite's `updateBefore` that runs a frame's cloud work in its placement                                                                          | WP3                       |
| `apps/game/src/render/cloudDepth.ts`              | `CloudDepth`: the scene's distance, R16F km at render resolution, drawn inside the frame node's run, tied to the multisampled depth                                       | WP3                       |
| `apps/game/src/render/cloudSystem.ts`             | `createCloudSystem()`: owns everything, runs the frame in order, reports                                                                                                  | WP11                      |
| `packages/devtools/src/clouds.ts`                 | `CloudRenderReport`, `cloudsSettled()`                                                                                                                                    | C (types), WP11           |
| `scripts/clouds/measure.mjs`                      | The batch runner: lock, preview check, quiet-machine check, profile deletion, drive.mjs children, JSON and tables                                                         | WP10                      |
| `scripts/clouds/page.mjs`                         | Page-side protocols, exported as functions the runner stringifies into `--js`                                                                                             | WP10                      |
| `scripts/clouds/diff.mjs`                         | Display-referred image difference for the thin form's screenshots (`magick compare`)                                                                                      | WP10                      |

Tests for these files are listed in §9.

### 2.3 Existing files touched

| Path                                                                                                              | Change                                                                                                                                                                                                                                                                                       | Why                                                                                                                                                                                                              | Owner                       |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `packages/rendering/src/index.ts`                                                                                 | `export * from` the ten new modules                                                                                                                                                                                                                                                          | Reachability, for knip and the app                                                                                                                                                                               | C                           |
| `packages/devtools/src/index.ts`                                                                                  | `export * from './clouds.ts'`                                                                                                                                                                                                                                                                | The report type crosses the port                                                                                                                                                                                 | C                           |
| `packages/rendering/src/atmosphere.ts`                                                                            | `export function aerosolDepthOf(haze)`, and the recipe's own line (`:466`) calls it                                                                                                                                                                                                          | One definition of the depth the air draws, which `wetWorld` reads (§3.1)                                                                                                                                         | C                           |
| `apps/game/src/render/air.ts`                                                                                     | Exports `psiTableAt`, `clearedBeam`, `phasesToward`, `stepShare`, `crowdedSamples`, `ORBIT_AIRLIGHT`. An optional `read: { level }` on the three table reads. `sunThroughAt()`. `createAirUniforms({ ownStandIns })`. A stub `airMediumAt()`. **`marchAir` and `airToward` are not touched** | The trace and composite take the air's taps from its own code (rules 56, 57; plan §6.3's "identical taps"); `marchAir` keeps its node graph, so no existing material's WGSL can move                             | C; WP5 writes `airMediumAt` |
| `apps/game/src/render/warmup.ts`                                                                                  | `warmCompute(renderer, kernels)`                                                                                                                                                                                                                                                             | Rule 61 has no compute recipe today; the trace and history are compute                                                                                                                                           | C                           |
| `apps/game/src/render/passTimeline.ts`                                                                            | `nameResume(texture, label)`; the copy hook prefers it                                                                                                                                                                                                                                       | B's resumed pass reads `scene over clouds` and not `scene after copy after copy`                                                                                                                                 | C                           |
| `apps/game/src/render/gpuHarness.ts`                                                                              | `computePipelinesBuilt()`: `createComputePipeline` and `createComputePipelineAsync` wrapped as the render constructors are, on a counter of their own                                                                                                                                        | The census cannot see a kernel compiled at its first dispatch otherwise; a separate counter leaves every existing render-pipeline assertion as it is (the meter's kernel already compiles in the sensor's frame) | C                           |
| `apps/game/src/render/sensor.ts`                                                                                  | Optional `{ clouds }` option. Builds the system on WebGPU. `overPass` in the dependency sum after the scene term. `beginFrame`, `endFrame` and `afterFrame` around `post.render()`. History reset on the picture key. Diagnostics, warm, dispose                                             | The chain is where the frame is structured                                                                                                                                                                       | WP11                        |
| `apps/game/src/scene/Sensor.tsx`                                                                                  | `SensorFrame.clouds` inputs when the flag is on; registers `warming the clouds`; `engine.cloudSystemFactory` in its effect's dependencies                                                                                                                                                    | State evaluated inside the chain; rule 61; a late factory rebuilds the chain rather than being ignored                                                                                                           | WP11                        |
| `apps/game/src/App.tsx`                                                                                           | Under the flag: the cloud chunk resolved inside the canvas's renderer factory, and `camera.layers.enable(OVER_CLOUDS_LAYER)` in `onCreated`, beside `engine.view`                                                                                                                            | The first chain is built with the factory, and every boot warm-up compiles against a camera that already tests layer 1 (§4.3)                                                                                    | WP11                        |
| `apps/game/src/engine/GameEngine.ts`                                                                              | `clouds: CloudLevers`, `cloudsAvailable`, `cloudSystemFactory`; render-host member `clouds`                                                                                                                                                                                                  | Levers on the engine like `surfaceQuality`; the report through the port                                                                                                                                          | WP11                        |
| `packages/devtools/src/host.ts`                                                                                   | `clouds(): CloudRenderReport \| null` and its default                                                                                                                                                                                                                                        | The port's one member per question                                                                                                                                                                               | WP11                        |
| `packages/devtools/src/harness.ts`                                                                                | `clouds()` reader; one `help()` line. `settled()` is unchanged in phase 0                                                                                                                                                                                                                    | Measurement reads the report; plates with clouds are phase 1's                                                                                                                                                   | WP11                        |
| `apps/game/src/pages/paths.ts`                                                                                    | `QUERY.clouds`                                                                                                                                                                                                                                                                               | A page-lifetime diagnostic like `producer`                                                                                                                                                                       | WP11                        |
| `apps/game/src/scene/Bodies.tsx`                                                                                  | Under the lever, the served body's deck yields, and every deck hides under `deck: 'hidden'`; `markOverClouds(ringMesh)` under the flag                                                                                                                                                       | A traced body shows no deck; Earth's A/B can price its deck (§8.3); rings are world transparency                                                                                                                 | WP11                        |
| `apps/game/src/scene/CameraRig.tsx`                                                                               | Under the flag, lights `layers.enableAll()` where each light is created                                                                                                                                                                                                                      | A's pass B sees one light set (no rebuild)                                                                                                                                                                       | WP11                        |
| `scene/ThrusterFx.tsx`, `SunFlare.tsx`, `WarpFx.tsx`, `EntryTrace.tsx`, `OrbitTraces.tsx`, `CinematicStage.tsx`   | Under the flag, `markOverClouds(...)` on their roots after creation (the staged sky excepted). Under the lever, orbit traces take `renderOrder` 1.75 and the staged sky 1.25 when `placement === 'split'`                                                                                    | A's layer split; B's single list; nothing on `main`                                                                                                                                                              | WP11                        |
| `packages/rendering/src/exposure.ts`, `exposure.test.ts`, `atmosphere.test.ts`                                    | `SCENE_UNIT_LUMINANCE`, `EXTRATERRESTRIAL_ILLUMINANCE`; doc comments; pinning tests; the anchor imports the constant                                                                                                                                                                         | The scene unit (§7)                                                                                                                                                                                              | WP10                        |
| `design/plans/the-air.md`                                                                                         | Records the galaxy, star and disk conversion defects with their numbers                                                                                                                                                                                                                      | §7's resolution leaves them open, written down                                                                                                                                                                   | WP10                        |
| `docs/guides/harness.md`                                                                                          | Pass names, `engine.clouds`, `ir.clouds()`, the runner, the generated Mie table                                                                                                                                                                                                              | The docs that promise names                                                                                                                                                                                      | Docs step (§11.3)           |
| `docs/adr/0063…0066`, `docs/adr/README.md`, `scripts/docs/wings.mjs`, `CONTEXT.md`, `design/plans/the-weather.md` | §10                                                                                                                                                                                                                                                                                          | Rules 46, 47                                                                                                                                                                                                     | Docs step                   |

### 2.4 fta

The cap is 91. No new module may approach it.

- The trace is three files: `cloudMarch` (the loop and its sweep mode),
  `cloudKnots` and `cloudTrace` (kernels and IO).
- The far field is three: shared slab arithmetic plus one file per candidate.
- The composite is three: material and meter, air, and front.
- The placement is four small files: split, over pass, frame node, depth copy.
- `cloudSystem` orchestrates and holds no shader code.

**Files already near the cap:** `harness.ts` (84.4) gains one reader;
the predicate lives in `devtools/src/clouds.ts`. `GameEngine.ts` (82.8) gains
three fields and one adapter member. `observatory.ts` (90.9) is not touched.

A package whose file crosses 85 splits it before the done command, not after.

---

## 3. Interfaces

These are the seams. Each block is what the contracts package writes (§11.1),
with stub bodies where marked; §3.5b's geometry, §3.4's levers and layers and
§3.5's helpers land real there. A package changes a signature only through the
orchestrator.

### 3.1 The placeholder weather (`packages/rendering/src/weatherScenario.ts`, WP1)

```ts
import type { Vec3 } from '@inertialref/spatial'
import type { Body } from '@inertialref/universe'

/** What a placeholder layer can be: each a height profile and an extinction. */
export const CLOUD_GENERA = [
  'stratus',
  'stratocumulus',
  'cumulus',
  'altocumulus',
  'cirrus',
  'cumulonimbus',
  'fog',
] as const
export type CloudGenus = (typeof CLOUD_GENERA)[number]

/** One shell over the datum, and what fills it. Meters, per meter, micrometers. */
export interface CloudLayerSpec {
  readonly genus: CloudGenus
  /** Over the datum, meters; base < top. */
  readonly base: number
  readonly top: number
  /** Mean column cloud fraction the maps carry, 0..1. */
  readonly coverage: number
  /** In-cloud extinction at full density, 1/m (plan §5.1's km⁻¹ ÷ 1000). */
  readonly sigma: number
  /** One Worley cell of the base noise, meters. */
  readonly cellMeters: number
  /** How far the detail noise eats the edge, 0..1. */
  readonly erosion: number
  /** Effective droplet radius, µm: the phase table's row. */
  readonly radius: number
}

export const SCENARIO_IDS = [
  'fair-cumulus',
  'broken-horizon',
  'inside',
  'two-decks',
  'near-gap-far',
  'cirrus-over-cumulus',
  'anvil',
  'overcast',
  'fog',
] as const
export type ScenarioId = (typeof SCENARIO_IDS)[number]

export interface WeatherScenario {
  readonly id: ScenarioId
  /** At most MAX_CLOUD_LAYERS, sorted by base, disjoint. */
  readonly layers: readonly CloudLayerSpec[]
  /** A uniform placeholder wind at the eye, m/s. */
  readonly wind: { readonly east: number; readonly north: number }
  /** How coverage varies over the body. */
  readonly pattern: 'uniform' | 'bands' | 'blobs'
  /** Angular size of a band or a blob, radians. */
  readonly patternScale: number
  /** Seconds a blob's cell holds one draw before it draws again; 0 for never. */
  readonly patternPeriod: number
}

export const MAX_CLOUD_LAYERS = 3
export declare const WEATHER_SCENARIOS: Readonly<
  Record<ScenarioId, WeatherScenario>
>

/** The coverage the maps hold for `layer` at a body-fixed unit direction, at
 *  presentation time `t`. The CPU reference of the maps' bake. Blob cells hash
 *  (cell, periodIndex) with pcg4d against a u32 threshold (rule 58). */
export declare function scenarioCoverage(
  s: WeatherScenario,
  layer: number,
  direction: Vec3,
  t: number,
): number
/** The genus's density profile over a layer, h01 = 0 at its base and 1 at its
 *  top: continuous, 0 outside (0, 1), peak 1. The CPU reference of the profile table. */
export declare function genusProfile(genus: CloudGenus, h01: number): number
/** The lowest base and highest top, meters over the datum. */
export declare function shellUnion(s: WeatherScenario): {
  readonly base: number
  readonly top: number
}
/** Drawn with weather by default: a standing sea of water under an air whose
 *  aerosol is a haze, not a deck. Derived; stored nowhere (rule 17). */
export declare function wetWorld(body: Body): boolean
```

`wetWorld` is `body.surface.seaLevel !== null && body.surface.grammar.liquidKind === 'water' && (body.appearance.haze === null || aerosolDepthOf(body.appearance.haze) < 1)`.

`aerosolDepthOf(haze)` is `haze.aerosolDepth ?? TAU_MIE·haze.thickness`, the
depth the air's recipe draws (`atmosphere.ts:466`), exported from
`atmosphere.ts` in the contracts package and called there too, so the predicate
and the sky read one number. An unauthored aerosol is therefore not zero: a
water world under a thick unauthored haze, thicker than 1/0.12 = 8.3, already
carries τ ≥ 1 of aerosol in its tables and is not wet.

The aerosol bound is the line between a haze and a deck. A sulfuric
family's air (τ 8) and Titan's (τ 4.3) already _are_ a cloud the air's tables
draw, and a volume over them counts the cloud twice (plan §14). Dust (0.4) and
violet (0.25) are hazes. The sea test is `seaLevel !== null`, which every
reader in the tree uses today (record map §1.2), plus the liquid's kind.

The scenario values are placeholders. They are the plan's §5.1 σ values with
round placements, and WP1 may change them only through the orchestrator,
because the measurement batches name them.

| id                    | Layers: genus base–top (m), coverage, σ (1/m), cell (m), erosion, r (µm)                             | Pattern, wind (E, N m/s)       |
| --------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------ |
| `fair-cumulus`        | cumulus 1000–2400, 0.35, 0.068, 1200, 0.6, 8                                                         | blobs 0.02 rad, 3600 s; (8, 2) |
| `broken-horizon`      | cumulus 900–2200, 0.50, 0.052, 1500, 0.5, 10                                                         | uniform; (10, 0)               |
| `inside`              | stratocumulus 800–1800, 1.0, 0.035, 2000, 0.3, 10                                                    | uniform; (5, 0)                |
| `two-decks`           | stratocumulus 1000–1500, 0.6, 0.035, 1800, 0.4, 10 · altocumulus 4000–4800, 0.6, 0.040, 1000, 0.5, 7 | uniform; (8, 4)                |
| `near-gap-far`        | cumulus 1000–2400, 0.50, 0.068, 1200, 0.6, 8                                                         | uniform; (8, 0)                |
| `cirrus-over-cumulus` | cumulus 1000–2400, 0.35, 0.068, 1200, 0.6, 8 · cirrus 9000–10000, 0.5, 0.0002, 5000, 0.3, 32         | bands 0.05 rad; (12, 0)        |
| `anvil`               | cumulonimbus 1000–15000, 0.25, 0.093, 8000, 0.4, 12                                                  | blobs 0.05 rad, 7200 s; (6, 0) |
| `overcast`            | stratus 300–1000, 1.0, 0.057, 3000, 0.2, 8                                                           | uniform; (4, 0)                |
| `fog`                 | fog 0–150, 1.0, 0.0081, 500, 0.2, 6                                                                  | uniform; (1, 0)                |

### 3.2 Shells, the clock, the cube-sphere, frames, the budget and the overlap reference (WP1)

```ts
// packages/rendering/src/weatherShells.ts
/** The eye's height over every shell boundary, resolved in float64: what a
 *  shader forms crossings from, never two radii (rule 52). */
export interface ShellHeights {
  /** The datum radius, true meters: the radius the air and the ground measure from. */
  readonly datumRadius: number
  /** The eye over the datum, meters. */
  readonly eye: number
  /** [base₀, top₀, base₁, top₁, base₂, top₂] over the datum, ascending; an
   *  absent layer repeats the union's top, so it has zero thickness. */
  readonly boundaries: readonly number[]
  /** eye − boundary for each, formed in float64. */
  readonly eyeOver: readonly number[]
}
export declare function shellHeights(
  eyeFromCenter: Vec3,
  datumRadius: number,
  boundaries: readonly number[],
): ShellHeights
/** The distances at which a ray with up-cosine `mu` meets the sphere `eyeOver`
 *  below the eye: the stable quadratic of §5.2, or null when it misses. The
 *  sign is (b ≥ 0 ? 1 : −1), never Math.sign, and t_b = 0 where q = 0, so a
 *  level ray from an eye on a boundary is two zeros and not 0/0 (the shader's
 *  form is the same, §5.2). */
export declare function shellCrossings(
  datumRadius: number,
  eye: number,
  eyeOver: number,
  mu: number,
): readonly [number, number] | null
/** Height over the datum at distance `t` along that ray (§5.3). */
export declare function altitudeAlong(
  datumRadius: number,
  eye: number,
  mu: number,
  t: number,
): number
/** Height over the datum of an eye-relative point, given its up-component
 *  `up = up_e·o` and its squared length `o·o` (§5.3's form with μ·t → up). */
export declare function altitudeAt(
  datumRadius: number,
  eye: number,
  up: number,
  lengthSquared: number,
): number
/** The ray's span inside the union of the shells, clipped to [0, stop], or null. */
export declare function unionSpan(
  shells: ShellHeights,
  mu: number,
  stop: number,
): readonly [number, number] | null

// packages/rendering/src/weatherClock.ts
/** frac(t / period), float64. */
export declare function reduceTurns(t: number, period: number): number
/** t mod period, in [0, period), float64. */
export declare function reduceSeconds(t: number, period: number): number
/** floor(t / period) as two uint32 halves, exact for |t| ≤ 3.2 × 10¹² s. */
export declare function periodIndex(
  t: number,
  period: number,
): readonly [low: number, high: number]
/** The drift's period: the field slides for this long, then starts over (§5.4).
 *  A change of periodIndex(t, CLOUD_ADVECTION_PERIOD) is a jump (§3.3). */
export const CLOUD_ADVECTION_PERIOD = 3600
/** A body-fixed point reduced into [0, period) on each axis, float64. */
export declare function reducePoint(point: Vec3, periodMeters: number): Vec3
/** velocity × (t mod CLOUD_ADVECTION_PERIOD), reduced into the noise's period, float64. */
export declare function driftOffset(
  velocity: Vec3,
  t: number,
  periodMeters: number,
): Vec3

// packages/rendering/src/cubeSphere.ts
export type CubeFace = 0 | 1 | 2 | 3 | 4 | 5
/** The face of a direction and its tangent-warped coordinates in [−1, 1]
 *  (u = tan(a·π/4) on the face plane). */
export declare function cubeFaceOf(direction: Vec3): {
  readonly face: CubeFace
  readonly a: number
  readonly b: number
}
/** The unit direction at warped coordinates; |a|, |b| > 1 lands in the
 *  neighbor's gutter texels, which is what the bake writes there. */
export declare function cubeDirection(
  face: CubeFace,
  a: number,
  b: number,
): Vec3
export declare const CUBE_FACES: readonly {
  readonly normal: Vec3
  readonly a: Vec3
  readonly b: Vec3
}[]
/** The warped coordinate of texel `index` in a tile of `size` + 2·gutter texels. */
export declare function cubeTexelCoordinate(
  size: number,
  gutter: number,
  index: number,
): number
export declare function cubeTexelMeters(
  size: number,
  radius: number,
): { readonly center: number; readonly corner: number }

// packages/rendering/src/cloudFrames.ts
/** One clipmap or volume level: a tangent plane at a snapped anchor, addressed toroidally. */
export interface LevelFrame {
  readonly level: number
  /** Unit, body-fixed; snapped so two eyes in one snap cell give one anchor. */
  readonly anchor: Vec3
  readonly east: Vec3
  readonly north: Vec3
  readonly texelMeters: number
  readonly size: number
  /** The eye's gnomonic plane coordinates about the anchor, meters, float64. */
  readonly eye: readonly [number, number]
  /** (e·A, e·E, e·N): the eye's position from the center against the frame's
   *  axes, meters, float64. What a shader forms a sample's plane coordinate
   *  from, with the offset, eye-relatively (§3.9, rule 58). */
  readonly along: readonly [number, number, number]
  /** The integer texel at the window's low corner; texel (i, j) is stored at (i mod size, j mod size). */
  readonly origin: readonly [number, number]
  /** Bumps when the anchor moves: the level is rebuilt whole. */
  readonly epoch: number
}
export interface DirtyRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}
export interface LevelUpdate {
  readonly frames: readonly LevelFrame[]
  /** Per level, the toroidal rectangles the window's move exposed. */
  readonly dirty: readonly (readonly DirtyRect[])[]
  readonly rebuilt: readonly boolean[]
}
/** Snap: the anchor moves when the eye leaves the inner half of the window; the
 *  window's origin moves by whole texels. `previous` null rebuilds every level
 *  (a first frame, or force 'cut'). */
export declare function levelFrames(
  eye: Vec3,
  datumRadius: number,
  texelMeters: readonly number[],
  size: number,
  previous: readonly LevelFrame[] | null,
): LevelUpdate
export declare function planeOf(
  frame: LevelFrame,
  direction: Vec3,
  datumRadius: number,
): readonly [number, number]
export declare function directionOf(
  frame: LevelFrame,
  plane: readonly [number, number],
  datumRadius: number,
): Vec3
/** A sun-space cascade: an orthographic box along the sun, its texel grid
 *  snapped in sun space and addressed toroidally (plan §6.1: "scrolled as it moves"). */
export interface SunCascade {
  readonly toward: Vec3 // unit, toward the sun, body-fixed: the orientation, held until it moves 0.05°
  readonly right: Vec3
  readonly up: Vec3
  readonly center: Vec3 // eye-relative, body-fixed meters: a texel corner, snapped
  readonly extent: number // meters across
  readonly texelMeters: number
  readonly near: number // distance from center toward the sun to the near plane
  readonly depth: number // near to far, meters: the union's chord along the sun, with a margin
  /** The integer texel at the window's low corner; texel (i, j) is stored at (i mod size, j mod size). */
  readonly origin: readonly [number, number]
  /** Bumps when the orientation moves or the cascade is rebuilt (a jump, a cut). */
  readonly epoch: number
}
export interface CascadeUpdate {
  readonly cascades: readonly SunCascade[]
  /** Per cascade, the toroidal strips the scroll exposed: drawn the frame they appear. */
  readonly dirty: readonly (readonly DirtyRect[])[]
  /** Per cascade, whether its contents are stale whole: a new orientation, a jump or a cut. */
  readonly stale: readonly boolean[]
}
/** `jump` marks every cascade stale; a sun that moved more than 0.05° from a
 *  cascade's orientation re-orients it; `previous` null is a cut. */
export declare function sunCascades(
  eye: Vec3,
  sun: Vec3,
  shells: ShellHeights,
  extents: readonly number[],
  size: number,
  previous: readonly SunCascade[] | null,
  jump: boolean,
): CascadeUpdate
export const SUN_CASCADE_TURN = 0.05 // degrees: the sun move that re-orients a cascade

// packages/rendering/src/cloudBudget.ts
export interface Extent {
  readonly width: number
  readonly height: number
}
export interface CloudExtents {
  readonly render: Extent // the scene target
  readonly css: Extent // display pixels
  readonly trace: Extent // ceil(min(render, css) / 4) × traceScale, long edge ≤ 480 × traceScale
  readonly history: Extent // 2 × trace
}
export const CLOUD_TRACE_DIVISOR = 4
export const CLOUD_TRACE_LONG_EDGE = 480
export declare function cloudExtents(
  render: Extent,
  css: Extent,
  traceScale?: number,
): CloudExtents
/** Declared bytes: what the "in memory" column is made of. `levels` defaults to
 *  1, which every cloud texture has (§3.7). */
export declare function textureBytes(
  width: number,
  height: number,
  depth: number,
  bytesPerTexel: number,
  levels?: number,
): number

// packages/rendering/src/cloudOverlap.ts — the reference the shader's bookkeeping is held to
export interface CloudSegment {
  readonly fraction: number // the largest fraction the crossing met
  readonly depth: number // in-cloud optical depth so far
  readonly through: number // e^−depth
  readonly light: number // in-cloud light per unit source, accumulated
}
export declare const OPEN_SEGMENT: CloudSegment
/** One constant-medium step inside a segment: light += through·source·(1 − e^−σℓ). */
export declare function stepSegment(
  s: CloudSegment,
  fraction: number,
  sigma: number,
  source: number,
  length: number,
): CloudSegment
/** Close a segment behind what is in front: T = (1 − c) + c·e^−τ; the light enters as c·L. */
export declare function closeSegment(
  front: { readonly transmittance: number; readonly light: number },
  s: CloudSegment,
): { readonly transmittance: number; readonly light: number }
/** (1 − e^−τ)/τ with the series under τ = 0.01, as air.ts's stepShare. */
export declare function stepShare(tau: number): number
```

Contract values: the trace at 1920×1080 is 480 × 270 and the history 960 × 540.
At 2880×1800 (CSS 1440×900) the trace is 360 × 225 and the history 720 × 450.
Under temporal FSR at 1080p Quality the render target is 1280×720, so the trace
is 320 × 180. In supersample the render target is twice CSS, and the CSS rule
binds. The immediate regime has no extent of its own: it dispatches the trace
four times at the trace's extent (§5.14).

The trace grid is "a quarter of the scene target's axes" (plan §5.5) wherever
that is not larger than a quarter of the CSS axes. That holds the ray budget to
the display, not the drawing buffer: the "ray budget is held" at Retina.

### 3.3 The frame's CPU state (`apps/game/src/render/cloudFrame.ts`, WP1; three-free)

```ts
import type { Quat, Vec3 } from '@inertialref/spatial'
import type { Body } from '@inertialref/universe'
import type {
  Lens,
  RenderBody,
  RenderScene,
  ShellHeights,
  LevelUpdate,
  CascadeUpdate,
  CloudExtents,
  Extent,
  WeatherScenario,
} from '@inertialref/rendering'
import type { AtmosphereScattering } from './atmosphereLuts.ts' // type only: no three at runtime
import type { CloudLevers } from './cloudLevers.ts'

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** Everything the frame is built from, read off the engine inside sensor.render(). */
export interface CloudFrameInputs {
  readonly levers: CloudLevers
  readonly scene: RenderScene // engine.scene()
  readonly record: (address: string) => Body | null // engine.bodyFor; rotationPeriod for the forced sun
  readonly scattering: (body: RenderBody) => AtmosphereScattering | null // scatteringOf(engine, body)
  readonly renderTime: number // engine.snapshot.renderTime (rule 38)
  readonly visibility: boolean // engine.visibilityProcessing: sunlight staged to 1
  readonly enhanced: boolean // this frame's processing is 'enhanced'
  readonly pictureEpoch: number
  readonly historyKey: string // the sensor's own (Sensor.tsx:100–107)
  readonly camera: { readonly position: Vec3; readonly quaternion: Quat } // render space, unjittered
  readonly lens: Lens
  readonly css: Extent
  readonly render: Extent
  readonly delta: number // this render call's seconds
}

export interface CloudBodyFrame {
  readonly address: string
  readonly datumRadius: number // true meters (RenderBody.trueRadius)
  readonly compression: number // placement.compression
  readonly toBodyFixed: Quat // render axes → body-fixed (conjugate of RenderBody.orientation)
  /** Body-fixed true meters: conj(q)·(eye − center)/compression, float64, plus
   *  the synthetic path under force 'fly'. */
  readonly eye: Vec3
  /** Body-fixed unit, as TerrainPatches forms it, turned about the spin axis by
   *  the synthetic interval under 'scrub' and 'warp'. */
  readonly sun: Vec3
  readonly shells: ShellHeights
  readonly scattering: AtmosphereScattering | null
  readonly limb: number
  readonly limbFalloff: number
  readonly dayColor: Rgb // keyColor × (visibility ? 1 : sunlight), as the ground's
  readonly noiseOrigin: Vec3 // reducePoint(eye, base period)
  readonly detailOrigin: Vec3 // reducePoint(eye, detail period)
  readonly drift: Vec3 // driftOffset(wind, time, base period)
  readonly wind: Vec3 // body-fixed m/s at the eye
  readonly clipmap: LevelUpdate // six levels, 250 m × 2^k
  readonly volume: LevelUpdate // levels 50/200/800 m
  readonly cascades: CascadeUpdate
}

export type CloudRegime = 'converging' | 'immediate'
export type CloudResetReason =
  'none' | 'first' | 'key' | 'jump' | 'resize' | 'motion' | 'cut' | 'force'

export interface CloudCameraFrame {
  readonly right: Vec3
  readonly up: Vec3
  readonly forward: Vec3 // body-fixed
  readonly halfTan: number
  readonly aspect: number
  readonly pixelAngle: number // radians a trace texel subtends vertically
}

export interface CloudFrame {
  readonly levers: CloudLevers
  readonly scenario: WeatherScenario
  readonly served: CloudBodyFrame
  readonly second: CloudBodyFrame | null
  readonly time: number // the instant the field is drawn at; synthetic under force
  /** time − previous.time: the field's own Δt, which the history moves the wind by. */
  readonly frameSeconds: number
  readonly period: readonly [number, number] // periodIndex(time, scenario.patternPeriod)
  readonly camera: CloudCameraFrame
  readonly previousCamera: CloudCameraFrame | null
  readonly translation: Vec3 // eye − previous eye, body-fixed, float64
  readonly enhanced: boolean
  readonly regime: CloudRegime
  readonly reset: CloudResetReason
  readonly jump: boolean // the field's time moved discontinuously
  readonly frameIndex: number // +1 a render call: the jitter's and the interleave's
  readonly extents: CloudExtents
}

export declare function cloudFrame(
  inputs: CloudFrameInputs,
  previous: CloudFrame | null,
): CloudFrame | null
/** The body the trace serves: the one whose air the eye is inside, else the
 *  largest by angular radius among those with weather; `forced` wins. */
export declare function servedBody(
  bodies: readonly RenderBody[],
  eye: Vec3,
  wet: (body: RenderBody) => boolean,
  forced: string | null,
): RenderBody | null
```

The rules `cloudFrame` implements, so WP1 does not have to guess them:

- It returns `null` when `levers.on` is false or no body is served.
- **Time.** `time = renderTime` under `force: 'none' | 'reset' | 'cut' | 'fly'`.
  Under `scrub` it is `previous.time + levers.scrubSeconds` every call. Under
  `warp` it is `previous.time + delta·levers.warp`. This instant is synthetic
  and presentation-only. It never touches the world clock.
  `frameSeconds = time − previous.time` (0 on a first frame).
- **The sun under a synthetic clock.** Under `scrub` and `warp`, the served and
  second bodies' body-fixed suns are the scene's turned about each body's spin
  axis (`frames.ts`'s) by `−2π·(time − renderTime)/rotationPeriod`, formed in
  float64. A 3 h scrub on Earth turns the sun 45°, so the sun-depth caches
  re-orient as they would under a real one. The body's orbital motion over the
  interval (0.12° for Earth over 3 h) is left out, declared.
- **Fly.** Under `fly`, the eye moves along the camera's forward projected onto
  the eye's horizontal, by `flySpeed/60` meters a render call, accumulated from
  the call `fly` was set and dropped when it is cleared. A fixed step rather than
  `delta·flySpeed`, so a held loop moves the eye by the same amount every frame
  whatever the frame rate. The rays, the shells and every cache frame follow
  the moved eye; the scene's camera does not, so the picture is wrong under
  `fly` and the cost is the real one (it is a measurement lever).
- **Cut.** Under `cut`, `levelFrames` and `sunCascades` are called with
  `previous` null every call, as a teleport does: every eye-anchored level and
  every cascade is rebuilt, and the regime is immediate.
- **Jump.** `jump` is true when `|time − previous.time − expected| > max(1 s, 4·expected)`,
  where `expected` is `delta` under `none`, `reset`, `cut` and `fly`, and when
  `periodIndex(time, CLOUD_ADVECTION_PERIOD)` changed: the drift starts over
  there and the field moves by `|wind|·3600`, which under warp 1000 happens every
  3.6 s of wall time. It is always true under `scrub`. A held instant changed by
  the planetarium reads as a jump.
- **Regime.** `immediate` when `reset !== 'none'`. `reset` is `first`, or `key`
  when `cloudResetKey(levers)`, `pictureEpoch`, `historyKey`, the served address
  or the second address changed, or `resize` when the extents changed, or
  `jump`, or `motion`, or `cut` under `force: 'cut'`, or `force` under
  `force: 'reset' | 'scrub'`.
- **Motion.** `motion` means the camera turned more than 20° between calls, or
  the eye moved more than a tenth of its height over the nearest shell boundary.
  `fly`'s step (4.2 m a frame at 250 m/s, 128 m at 7.7 km/s) stays under both
  in every scenario, so `fly` measures the converging path with motion.
- **Ray budget.** `pixelAngle = 2·atan(halfTan)/extents.trace.height`.
- **Wind.** It is the scenario's (east, north) at the eye, rotated into
  body-fixed axes.

### 3.4 Levers and layers (`cloudLevers.ts`, `cloudLayers.ts`; real in the contracts package)

```ts
import type { ScenarioId } from '@inertialref/rendering'
export const CLOUD_PLACEMENTS = ['split', 'passes', 'empty-split'] as const // B, A, B without cloud work
export type CloudPlacement = (typeof CLOUD_PLACEMENTS)[number]
export const CLOUD_CACHES = ['field', 'volume'] as const
export type CloudCache = (typeof CLOUD_CACHES)[number]
export const CLOUD_FAR_KINDS = ['atlas', 'spheres'] as const // `levels` is decided on paper (§1.3)
export type CloudFarKind = (typeof CLOUD_FAR_KINDS)[number]
export const CLOUD_SUN_DEPTHS = ['cascades', 'grid'] as const
export type CloudSunDepth = (typeof CLOUD_SUN_DEPTHS)[number]
export const CLOUD_COMPOSITES = ['identity', 'thin', 'residual'] as const
export type CloudCompositeMode = (typeof CLOUD_COMPOSITES)[number]
/** The paths a held still loop never takes on its own (§3.3). */
export const CLOUD_FORCES = [
  'none',
  'reset',
  'cut',
  'scrub',
  'warp',
  'fly',
] as const
export type CloudForce = (typeof CLOUD_FORCES)[number]
/** The one read type the sweep adds to its base fetches (§8.4). */
export const CLOUD_SWEEP_EXTRAS = [
  'none',
  'clipmap',
  'profile',
  'detail',
  'curl',
  'level',
] as const
export type CloudSweepExtra = (typeof CLOUD_SWEEP_EXTRAS)[number]

/** Read by the chain every render call. Scripts write `engine.clouds = { ...engine.clouds, … }`. */
export interface CloudLevers {
  readonly on: boolean
  readonly scenario: ScenarioId
  readonly placement: CloudPlacement
  readonly cache: CloudCache
  readonly far: CloudFarKind
  /** Meters a trace texel spans where a ray hands over to the far march. */
  readonly farFootprint: number
  readonly sunDepth: CloudSunDepth
  readonly lightTaps: 0 | 2 | 4
  readonly composite: CloudCompositeMode
  readonly force: CloudForce
  /** Time scale under force 'warp'; seconds a call under 'scrub'; m/s under 'fly'. */
  readonly warp: number
  readonly scrubSeconds: number
  readonly flySpeed: number
  readonly traceScale: 0.5 | 1 | 2
  readonly maxSteps: number
  /** >0 selects the sweep kernel: exactly this many 4 m steps a ray (§8.4). With sweepReads ≥ 1. */
  readonly fixedSteps: number
  /** Base-noise fetches a sweep step makes, at decorrelated offsets; 0 outside the sweep. */
  readonly sweepReads: 0 | 1 | 2 | 4 | 6
  readonly sweepExtra: CloudSweepExtra
  readonly noiseFormat: 'r8' | 'rgba8'
  /** Force the served body, and a second clouded one, by address. */
  readonly served: string | null
  readonly second: string | null
  /** 'hidden' hides every deck mesh whatever `on` is: Earth's A/B prices its deck (§8.3). */
  readonly deck: 'auto' | 'hidden'
  /** Count steps a ray (one atomic a ray) for the report. */
  readonly stats: boolean
}
export const DEFAULT_CLOUD_LEVERS: CloudLevers = {
  on: false,
  scenario: 'fair-cumulus',
  placement: 'split',
  cache: 'field',
  far: 'atlas',
  farFootprint: 400,
  sunDepth: 'cascades',
  lightTaps: 2,
  composite: 'identity',
  force: 'none',
  warp: 1000,
  scrubSeconds: 10_800,
  flySpeed: 250,
  traceScale: 1,
  maxSteps: 192,
  fixedSteps: 0,
  sweepReads: 0,
  sweepExtra: 'none',
  noiseFormat: 'r8',
  served: null,
  second: null,
  deck: 'auto',
  stats: false,
}
export function isCloudLevers(value: unknown): value is CloudLevers {
  /* every field one of its values; fixedSteps > 0 exactly when sweepReads ≥ 1 */
}
/** The levers whose change resets the history: scenario, cache, far, farFootprint, sunDepth,
 *  composite, traceScale, noiseFormat, fixedSteps, sweepReads, sweepExtra, served, second. */
export function cloudResetKey(levers: CloudLevers): string {
  /* join */
}

// cloudLayers.ts
import { Layers, type Object3D } from 'three/webgpu'
/** Everything drawn over the clouds lives on this camera layer; layer 0 is everything under them. */
export const OVER_CLOUDS_LAYER = 1
export const UNDER_CLOUDS_LAYERS: Layers // only layer 0 enabled
export const OVER_CLOUDS_LAYERS: Layers // only layer 1 enabled
/** The object and every descendant, a Group included: a Group that fails the
 *  layer test sets no groupOrder for its children (Renderer.js:3084–3092).
 *  Called only under `QUERY.clouds`, and only once the camera tests layer 1
 *  from its creation (§4.3); otherwise a boot warm-up compiles nothing on the
 *  object, because `compileAsync` drops what the camera's layers do not test. */
export function markOverClouds(object: Object3D): void {
  object.traverse((o) => o.layers.set(OVER_CLOUDS_LAYER))
}
```

`farFootprint: 400` puts the handover where a trace texel spans under half the
smallest cell any scenario draws (1,000 m), so detail the fine march resolves is
never handed to a representation that cannot hold it.

`maxSteps: 192` is a phase 0 guess that the sweep replaces. The plan's
schedule covers about 13 km in 128 out-of-cloud steps (§5.5).

`flySpeed: 250` is a fast aircraft over the ground. The `orbit` and
`earth-orbit` scenarios set 7,700, a low orbit's speed.

### 3.5 The uniform bundle and the shared TSL shapes (`cloudUniforms.ts`, `cloudNodes.ts`; real in the contracts package)

```ts
// cloudUniforms.ts — one bundle; every cloud module is constructed with it and reads its nodes.
import type {
  Color,
  Matrix3,
  UniformNode,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu'
import type { AirUniforms } from './air.ts'

export interface CloudLevelUniforms {
  readonly anchor: UniformNode<Vector3>
  readonly east: UniformNode<Vector3>
  readonly north: UniformNode<Vector3>
  readonly eye: UniformNode<Vector2> // the eye's plane coordinates about the anchor, meters (float64-formed)
  readonly along: UniformNode<Vector3> // (e·A, e·E, e·N), meters (float64-formed): §3.9's eye-relative lookup
  readonly origin: UniformNode<Vector2> // the window's integer low corner, texels
  readonly texel: UniformNode<number> // meters
}
export interface CloudBodyUniforms {
  readonly datumRadius: UniformNode<number>
  readonly eye: UniformNode<number> // the eye over the datum, meters
  readonly eyeOver: UniformNode<Vector4> // eye − [base₀, top₀, base₁, top₁]
  readonly eyeOverHigh: UniformNode<Vector2> // eye − [base₂, top₂]
  readonly boundaries: UniformNode<Vector4>
  readonly boundariesHigh: UniformNode<Vector2>
  readonly eyeTerm: UniformNode<number> // h_e·(2R + h_e), float64-formed: §5.3's numerator
  readonly up: UniformNode<Vector3> // the eye's local vertical, body-fixed
  readonly sun: UniformNode<Vector3> // body-fixed, unit
  readonly sunUp: UniformNode<number> // dot(up, sun) at the eye
  readonly toBodyFixed: UniformNode<Matrix3> // render axes → body-fixed
  readonly noiseOrigin: UniformNode<Vector3>
  readonly detailOrigin: UniformNode<Vector3>
  readonly drift: UniformNode<Vector3>
  readonly compression: UniformNode<number>
  readonly cleared: UniformNode<number> // limb × enhanced: clearedFromOrbit's value
  readonly dayColor: UniformNode<Color>
  readonly air: AirUniforms // the second body's has its own stand-ins (rule 57)
  readonly clipmap: readonly CloudLevelUniforms[] // 6
  readonly volume: readonly CloudLevelUniforms[] // 3
  readonly active: UniformNode<number>
}
export interface CloudLayerUniforms {
  // three layers, packed by component
  readonly base: UniformNode<Vector3>
  readonly top: UniformNode<Vector3>
  readonly coverage: UniformNode<Vector3>
  readonly sigma: UniformNode<Vector3>
  readonly cell: UniformNode<Vector3>
  readonly erosion: UniformNode<Vector3>
  readonly radius: UniformNode<Vector3>
  readonly genus: UniformNode<Vector3> // the genus's index as a float
  readonly sigmaScale: UniformNode<number> // the volume's encoding scale: the largest σ
}
export interface CloudCameraUniforms {
  readonly right: UniformNode<Vector3>
  readonly up: UniformNode<Vector3>
  readonly forward: UniformNode<Vector3>
  readonly plane: UniformNode<Vector2> // (halfTan·aspect, halfTan)
  readonly previousRight: UniformNode<Vector3>
  readonly previousUp: UniformNode<Vector3>
  readonly previousForward: UniformNode<Vector3>
  readonly previousPlane: UniformNode<Vector2>
  readonly translation: UniformNode<Vector3> // eye − previous eye, body-fixed, meters
  readonly pixelAngle: UniformNode<number>
  readonly near: UniformNode<number>
  readonly far: UniformNode<number> // the scene camera's, for the depth copy
}
export interface CloudTraceUniforms {
  readonly size: UniformNode<Vector2> // the trace's extent: every dispatch, the immediate regime's four included
  readonly history: UniformNode<Vector2>
  readonly render: UniformNode<Vector2> // the scene target, for depth and the composite
  readonly phase: UniformNode<Vector2> // the interleave's (φx, φy): written before each dispatch
  readonly frame: UniformNode<number> // 'uint': the jitter's index
  readonly farDistance: UniformNode<number> // farFootprint / pixelAngle
  readonly maxSteps: UniformNode<number> // maxSteps, or maxSteps/4 in the immediate regime
  readonly fixedSteps: UniformNode<number>
  readonly sweepReads: UniformNode<number>
  readonly sweepExtra: UniformNode<number> // CLOUD_SWEEP_EXTRAS's index
  readonly lightTaps: UniformNode<number>
  readonly immediate: UniformNode<number>
  readonly thin: UniformNode<number>
  readonly frameSeconds: UniformNode<number> // CloudFrame.frameSeconds: the field's Δt, which the wind moves by
  readonly wind: UniformNode<Vector3> // body-fixed m/s
}
export interface CloudUniforms {
  readonly served: CloudBodyUniforms
  readonly second: CloudBodyUniforms
  readonly layers: CloudLayerUniforms
  readonly camera: CloudCameraUniforms
  readonly trace: CloudTraceUniforms
  readonly period: UniformNode<Vector2> // periodIndex's halves, written as two uint-exact floats ≤ 2²⁴, or 'uvec2' if three takes it
  write(frame: CloudFrame): void // compare-first, like Bodies' setters
}
export declare function createCloudUniforms(): CloudUniforms
```

`period` holds two u32 values. Phase 0's `blobs` pattern needs only the low
half, and the low half under 2²⁴ is exact in a float. The premise spike
(§11.1) settles whether a `uniform(new Vector2(), 'uvec2')` builds, before any
package uses it.

The bundle has no `eyeDirection`: nothing forms a position, a lattice
coordinate or a level lookup from an absolute direction (§3.9).

```ts
// cloudNodes.ts — the shapes every TSL module exchanges, and the helpers. Real in the contracts package.
import type { Node, StorageTexture, Storage3DTexture } from 'three/webgpu'
import type { CloudBodyUniforms } from './cloudUniforms.ts'

export interface CloudRay {
  readonly direction: Node<'vec3'> // unit, body-fixed
  readonly mu: Node<'float'> // dot(direction, the eye's up)
  readonly nu: Node<'float'> // dot(direction, sun): fixed along the ray, the phase's argument
  readonly start: Node<'float'> // t₀, meters
  readonly end: Node<'float'> // t₁, meters
}
export interface CloudSample {
  readonly offset: Node<'vec3'> // sample − eye, body-fixed meters (rule 58: never eye + offset)
  readonly distance: Node<'float'> // t
  readonly altitude: Node<'float'> // over the datum, from heights (§5.3)
  readonly sunMu: Node<'float'> // the sun's cosine over the sample's horizontal
  readonly footprint: Node<'float'> // meters a trace texel spans at t
}
export interface CloudMedium {
  readonly fraction: Node<'float'> // the cloudy share of the column the sample stands for; 1 when resolved
  readonly sigma: Node<'float'> // in-cloud extinction, 1/m
  readonly layer: Node<'int'> // −1 outside every layer
  readonly column: Node<'float'> // horizontal meters one segment may span here
  readonly radius: Node<'float'> // effective radius, µm
}
export type CloudMediumFn = (
  sample: CloudSample,
  body: CloudBodyUniforms,
) => CloudMedium
export interface CloudSun {
  readonly cloud: Node<'float'> // the cloud's transmittance to the sun
  readonly air: Node<'vec3'> // sunThroughAt: the beam through the air
}
export type CloudSunFn = (
  sample: CloudSample,
  medium: CloudMedium,
  body: CloudBodyUniforms,
) => CloudSun
export interface CloudSunDepthNodes {
  /** Optical depth from an eye-relative body-fixed point to the sun. */
  opticalDepth(offset: Node<'vec3'>): Node<'float'>
}
export interface CloudPhaseNodes {
  /** Droplet phase per band, sr⁻¹, at cos θ = nu, for an effective radius in µm. */
  droplets(nu: Node<'float'>, radius: Node<'float'>): Node<'vec3'>
}
export interface CloudFarResult {
  readonly light: Node<'vec3'> // L_c over [from, end], relative to `from`
  readonly air: Node<'vec3'> // B over [from, end], with the class's beam (§5.11)
  readonly transmittance: Node<'float'>
  readonly depthMean: Node<'float'> // meters
  readonly depthDeviation: Node<'float'>
}
export type CloudFarFn = (
  ray: CloudRay,
  from: Node<'float'>,
  body: CloudBodyUniforms,
  sky: Node<'bool'>, // the texel's class: the beam B is accumulated with
) => CloudFarResult

/** Interleaved gradient noise at the pixel plus an R1 step a frame: two numbers in [0, 1). */
export declare function traceJitter(
  pixel: Node<'uvec2'>,
  frame: Node<'uint'>,
): Node<'vec2'>
/** x where every component is finite, else `fallback`: an exponent test through bitcast,
 *  because WGSL has no isnan and a compiler may fold x != x away. */
export declare function finiteOr(
  x: Node<'vec4'>,
  fallback: Node<'vec4'>,
): Node<'vec4'>
/** Every storage texture the cloud system holds is made here: `generateMipmaps`
 *  and `mipmapsAutoUpdate` false, so three allocates one level and never
 *  regenerates a chain behind a compute write (§3.7). */
export declare function cloudStorageTexture(
  width: number,
  height: number,
  format: 'rgba16float' | 'rgba8unorm',
  name: string,
): StorageTexture
export declare function cloudStorage3DTexture(
  width: number,
  height: number,
  depth: number,
  format: 'rgba8unorm',
  name: string,
): Storage3DTexture
/** Stand-in node sets for a package's own tests and for the contracts' stubs,
 *  each binding 1 × 1 textures in its real module's number and kind (§3.7's
 *  inventory), so a kernel compiled against stand-ins counts the bindings the
 *  real one will. */
export declare const CLOUD_STAND_INS: {
  field(): CloudMediumFn // 7 sampled textures, the field's
  volume(): {
    medium: CloudMediumFn
    bound: (s: CloudSample, b: CloudBodyUniforms) => Node<'float'>
    brickExit: (
      s: CloudSample,
      r: CloudRay,
      b: CloudBodyUniforms,
    ) => Node<'float'>
  } // 2
  sunDepth(kind: 'cascades' | 'grid'): CloudSunDepthNodes // 1
  phase(): CloudPhaseNodes // 1
  far(): CloudFarFn // 1
}
```

**Dependency injection is the rule that makes parallel work possible.** The
march takes `CloudMediumFn`, `CloudSunFn` and `CloudPhaseNodes` as parameters,
and each bake takes the medium it bakes from as a parameter.

So every package's correctness tests drive its own module with **analytic
media** (a constant slab, two slabs, or a vacuum, all built from `CloudSample`
alone), bound through the stand-in sets so their binding counts are the real
ones. A package's tests may import what its base already holds (the contracts
package and wave 1's packages, §11), never a sibling's implementation in
flight. Integration (WP11) is the first place the wave-2 modules meet, and the
measurement instruments that need the real field run after it (WP12).

### 3.5b The geometry every GPU module forms rays and heights with (`cloudGeometry.ts`; real in the contracts package)

Every GPU package builds on this small, pure arithmetic, so it is not stubbed:
the contracts package writes it in full and holds it with
`cloudGeometry.gpu.test.ts` before anything branches (§11.1). Formulas are
§5.1–5.3's.

```ts
// cloudGeometry.ts
import type { Node } from 'three/webgpu'
import type {
  CloudBodyUniforms,
  CloudCameraUniforms,
  CloudLevelUniforms,
} from './cloudUniforms.ts'
import type { CloudRay, CloudSample } from './cloudNodes.ts'

/** The image point of trace texel `pixel` at `jitter` ∈ [0, 1)², row 0 at the top:
 *  x = 2(i + ½ + jx)/W − 1, y = 1 − 2(j + ½ + jy)/H. Every reader of a trace,
 *  history or depth texel goes through this and `screenTexel`, so none of them
 *  flips (the QuadMesh trap, temporal map §12.4). */
export declare function traceScreen(
  pixel: Node<'uvec2'>,
  jitter: Node<'vec2'>,
  extent: Node<'vec2'>,
): Node<'vec2'>
/** An image point → the integer texel of a texture of `extent`, row 0 at the top. */
export declare function screenTexel(
  screen: Node<'vec2'>,
  extent: Node<'vec2'>,
): Node<'ivec2'>
/** The body-fixed unit direction through an image point:
 *  normalize(forward + right·x·plane.x + up·y·plane.y), the basis rotated on the CPU. */
export declare function viewDirection(
  camera: CloudCameraUniforms,
  screen: Node<'vec2'>,
): Node<'vec3'>
/** A boundary's crossings for a ray of up-cosine `mu` from the eye (§5.2): sorted,
 *  and whether it meets the sphere. sign(b) is select(−1, 1, b ≥ 0) and t_b is 0
 *  where q = 0, so a level ray from an eye on a boundary is (0, 0), never 0/0. */
export declare function shellCrossing(
  body: CloudBodyUniforms,
  mu: Node<'float'>,
  eyeOver: Node<'float'>,
  boundary: Node<'float'>,
): {
  readonly near: Node<'float'>
  readonly far: Node<'float'>
  readonly hit: Node<'bool'>
}
/** The same quadratic for a ray from an eye-relative origin `o₀` along `d̂`:
 *  s² + 2s·[r_e(up·d̂) + o₀·d̂] + [c₀ + 2r_e(up·o₀) + o₀·o₀] = 0, with
 *  c₀ = (h_e − h_b)(2R + h_e + h_b) formed on the CPU. The cascade and grid
 *  bakes' sun rays, which do not pass through the eye. */
export declare function shellCrossingFrom(
  body: CloudBodyUniforms,
  origin: Node<'vec3'>,
  direction: Node<'vec3'>,
  boundary: Node<'float'>,
): {
  readonly near: Node<'float'>
  readonly far: Node<'float'>
  readonly hit: Node<'bool'>
}
/** The ray through `direction`: μ, ν, and its span inside the shell union, clipped
 *  to [0, stop] (true meters), from heights. `hit` false when the span is empty. */
export declare function cloudRay(
  direction: Node<'vec3'>,
  body: CloudBodyUniforms,
  stop: Node<'float'>,
): CloudRay & { readonly hit: Node<'bool'> }
/** Height over the datum at distance t along a ray of up-cosine mu (§5.3). */
export declare function altitudeAlong(
  body: CloudBodyUniforms,
  mu: Node<'float'>,
  t: Node<'float'>,
): Node<'float'>
/** Height over the datum of an eye-relative point: §5.3 with μ·t → up·o and t² → o·o.
 *  The light taps, the cascade and grid bakes and the volume bake all take
 *  their heights here (rule 52); none forms length(eye + o) − R. */
export declare function altitudeAt(
  body: CloudBodyUniforms,
  offset: Node<'vec3'>,
): Node<'float'>
/** The sun's cosine over the horizontal at an eye-relative point:
 *  (r_e·μ_sun,e + o·ŝ)/r(o), from heights. */
export declare function sunMuAt(
  body: CloudBodyUniforms,
  offset: Node<'vec3'>,
): Node<'float'>
/** The sample at distance t along a ray, with its footprint, pixelAngle·t. */
export declare function cloudSample(
  ray: CloudRay,
  t: Node<'float'>,
  body: CloudBodyUniforms,
  pixelAngle: Node<'float'>,
): CloudSample
/** A level's gnomonic plane coordinates of an eye-relative point, formed
 *  eye-relatively (§3.9): eye + Δu, with Δu from the offset and the level's
 *  float64 `along` terms. Never from an absolute direction (rule 58). */
export declare function levelPlane(
  level: CloudLevelUniforms,
  offset: Node<'vec3'>,
): Node<'vec2'>
/** Plane coordinates → the level's continuous toroidal texel coordinates. */
export declare function levelTexel(
  level: CloudLevelUniforms,
  plane: Node<'vec2'>,
): Node<'vec2'>
/** The inverse, for a bake: the eye-relative offset of the point at `plane` and
 *  `height` over the datum. With ρ = √(R² + u² + v²) and s = (R + h)/ρ,
 *  o = A·[(h − h_e) − (R + h)(u² + v²)/((ρ + R)ρ) + ((e·E)² + (e·N)²)/(r_e + e·A)]
 *    + E·(s·u − e·E) + N·(s·v − e·N),
 *  every term formed without subtracting two radii (rules 52, 58). */
export declare function levelOffset(
  level: CloudLevelUniforms,
  plane: Node<'vec2'>,
  height: Node<'float'>,
  body: CloudBodyUniforms,
): Node<'vec3'>
/** A body-fixed direction → the atlas uv of its face tile, gutters included
 *  (cubeSphere.ts's warp). For the cube and the far atlases, whose texels are
 *  19.6 km and up: a coarse lookup, not a lattice. */
export declare function cubeAtlasUv(
  direction: Node<'vec3'>,
  tile: number,
  gutter: number,
  columns: number,
  rows: number,
): Node<'vec2'>
```

`cloudGeometry.gpu.test.ts` holds it at 4,096 rays: crossings against exact
float64 roots computed in the test and against `weatherShells`; altitude along
a ray and at a point to |Δh| ≤ 0.25 m where h ∈ [−1, 20] km and
≤ 10⁻⁶·(R + t) elsewhere (§5.3); the sun's cosine to 10⁻⁶; a level ray (μ = 0)
from an eye on a boundary, which must give (0, 0) and no NaN; the plane
coordinate of an offset 100 km out against the float64 projection to 2 cm;
`traceScreen`'s row 0 at the top, read back through a texture the test wrote.

### 3.6 Air additions (`apps/game/src/render/air.ts`; additive in the contracts package, `airMediumAt` by WP5)

```ts
/** How a table is read. `level` names level 0, for reads in non-uniform control flow (plan §5.2). */
export interface TableRead {
  readonly level?: boolean
}
export function sunTableAt(
  air: AirUniforms,
  muSun: Node<'float'>,
  height01: Node<'float'>,
  read?: TableRead,
): Node<'vec3'>
export function psiTableAt(
  air: AirUniforms,
  muSun: Node<'float'>,
  height01: Node<'float'>,
  read?: TableRead,
): Node<'vec3'> // now exported
export function clearedBeam(
  air: AirUniforms,
  table: Node<'vec3'>,
  height01: Node<'float'>,
  strength: Node<'float'>,
  read?: TableRead,
): Node<'vec3'> // now exported
/** The beam at a height resolved off the CPU: sunThrough without length(point) − 1. */
export function sunThroughAt(
  air: AirUniforms,
  height01: Node<'float'>,
  muSun: Node<'float'>,
  cleared: Node<'float'>,
  read?: TableRead,
): Node<'vec3'>
export const ORBIT_AIRLIGHT = 0.5 // now exported
export function phasesToward(
  direction: Node<'vec3'>,
  sun: Node<'vec3'>,
): AirPhases // now exported
export interface AirPhases {
  readonly rayleigh: Node<'float'>
  readonly mie: Node<'float'>
  readonly forward: Node<'float'>
}
export function stepShare(
  stepTau: Node<'vec3'>,
  through: Node<'vec3'>,
): Node<'vec3'> // now exported
/** The sample placement marchAir uses, now exported: it reads no texture. */
export function crowdedSamples(
  origin: Node<'vec3'>,
  direction: Node<'vec3'>,
  near: Node<'float'>,
  far: Node<'float'>,
  samples: number,
  each: (point: Node<'vec3'>, stepLength: Node<'float'>) => void,
): void
/** One sample of the air: extinction, single scattering (×sunT) and multiple, per unit length, exactly marchAir's per-sample terms. */
export interface AirMedium {
  readonly extinction: Node<'vec3'>
  readonly single: Node<'vec3'>
  readonly multiple: Node<'vec3'>
}
export function airMediumAt(
  air: AirUniforms,
  height: Node<'float'>,
  muSun: Node<'float'>,
  phases: AirPhases,
  sunT: Node<'vec3'>,
  read?: TableRead,
): AirMedium
/** `ownStandIns`: this bundle's tables start on stand-in objects of their own, for a material
 *  that binds two bodies' air (rule 57: two nodes over LUT_WHITE are one binding). */
export function createAirUniforms(options?: {
  readonly ownStandIns?: boolean
}): AirUniforms
```

In the contracts package, `airMediumAt` is a stub returning zeros, and the rest
are real: `export` keywords, the optional `.level(float(0))` on the three table
reads, and the stand-in option. **`marchAir` and `airToward` are not touched in
phase 0.** With `read` undefined every existing caller builds the same node
graph it builds today, so no existing material's WGSL can move. The contracts
package confirms it once: the WGSL of the shell, the sphere, the ground and the
sea, generated on `c2a50f1` and on the contracts commit, hashes equal, and the
hashes go in that commit's body.

WP5 writes `airMediumAt` as a function of its own beside `marchAir`,
reproducing its per-sample terms, and `cloudLight.gpu.test.ts` holds the two to
one value (a one-sample march). The composite's split marches are built from
`airMediumAt` with `{ level: true }` over the exported `crowdedSamples`
(`cloudCompositeAir.ts`, §5.11), because the composite chooses its class per
pixel and its marches therefore sit in non-uniform control flow, where a
fragment read must name its level; `cloudCompositeAir.gpu.test.ts` holds those
marches to `marchAir` itself over the same segments. Plan §6.3's identical taps
are phase 2's, and phase 2 is where `marchAir` changes.

### 3.7 The resource shape every GPU module shares

```ts
// cloudNodes.ts (continued)
import type { Texture, WebGPURenderer } from 'three/webgpu'
import type { CloudFrame } from './cloudFrame.ts'

/** What a frame allows a progressive resource to do, and why it must do more. */
export interface CloudBudget {
  readonly slices: number
  readonly tiles: number
  readonly jump: boolean
  /** Texel-steps a sun-depth candidate may spend this frame: one cap for both (§3.12). */
  readonly sunTexelSteps: number
}

export interface CloudResource {
  readonly name: string // 'maps', 'clipmap', 'volume', …; the report's key
  /** Declared bytes of what it holds now, from dimensions × texel size × levels; 0 once disposed (rule 65). */
  readonly bytes: number
  /** Every GPU texture it holds now: the census's and the mip test's subject. */
  textures(): readonly Texture[]
  /** Work due at this frame's state that it has not done: a face, a level, a slice, a tile. */
  readonly pending: boolean
  /** Compile every pipeline it will ever draw with, through render/warmup.ts (rule 61). Idempotent. */
  warm(renderer: WebGPURenderer): Promise<void>
  /** Draw this frame's share: quads through runQuadPasses with constant labels, kernels named. */
  render(renderer: WebGPURenderer, frame: CloudFrame, budget: CloudBudget): void
  dispose(): void
}
```

Every module below implements `CloudResource`. A module allocates at its real
size only when the levers select it. Before that it holds 1 × 1 targets of the
real format, so warming builds the real pipelines: a pipeline depends on the
format, not the size. Its `bytes` count only what it holds.

**One level, always.** Every storage texture comes from `cloudStorageTexture`
or `cloudStorage3DTexture`, which set `generateMipmaps` and
`mipmapsAutoUpdate` to false. Left at three's defaults a `StorageTexture` is
allocated with its whole chain, nine or ten levels, and the next sampled
binding after each compute write regenerates that chain with raw render passes
`ir.passes` cannot name while `ir.gpu` counts them: about forty a frame across
the trace and the history, biasing the very figures phase 0 is for, and the
declared bytes a third short. A `Storage3DTexture` allocates its chain and
nothing fills it. Fragment targets are `RenderTarget`s, whose textures already
default to one level. `cloudSystem.gpu.test.ts` asserts
`backend.get(texture).texture.mipLevelCount === 1` for every texture the
system's resources list, and that each resource's declared `bytes` equals the
sum over its GPU textures' own size, format and levels.

**The binding inventory.** WebGPU's default limits bind 16 sampled textures and
4 storage textures a stage (three asks for none higher,
`createRenderer.ts:180–193`), and the limit counts every texture binding,
whether it is sampled through a sampler or read with `textureLoad`. Each node
set binds exactly this, and the stand-ins of §3.5 bind the same:

| Node set                     | Sampled textures                                                 |
| ---------------------------- | ---------------------------------------------------------------- |
| `fieldMedium`                | clipmap textures 0–2, base noise, detail noise, curl, profile: 7 |
| `volumeMedium` and its bound | the volume, the bound: 2                                         |
| a sun-depth candidate        | the cascades (2D array) or the grid (3D): 1                      |
| one body's air               | transmittance, Ψ: 2                                              |
| the phase                    | the Mie table: 1                                                 |
| a far field                  | its atlas: 1                                                     |
| the depth copy               | 1                                                                |

A trace kernel binds the field, one sun depth, the served air, the phase, one
far field and the depth copy: 13. With the volume, 15. Each kernel writes 4
storage textures, which is the limit, so the trace has no room for a fifth
output. The composite binds the history (3), the depth copy, both bodies' air
(4), the phase and the second body's atlas: 10. WP6's first test compiles every
trace kernel against the stand-ins and counts the bindings in the WGSL; a
package that would bind a seventeenth stops and asks the orchestrator.

### 3.8 Noise and profile (WP4)

```ts
// cloudNoise.ts
export const CLOUD_BASE_TEXELS = 128 // Perlin–Worley, R8 (and an RGBA8 sweep variant)
export const CLOUD_BASE_CELLS = 8 // Worley cells a period: one cell = 16 texels
export const CLOUD_DETAIL_TEXELS = 32 // Worley, R8, 4 cells a period
export const CLOUD_CURL_TEXELS = 128 // 2D curl, RG8
export interface CloudNoiseNodes {
  /** The base shape at a point in base-cell units (the period is CLOUD_BASE_CELLS). Level 0. */
  base(cells: Node<'vec3'>): Node<'float'>
  /** The same texel's four channels (base, and three octaves): the sweep's RGBA8 read. */
  baseWide(cells: Node<'vec3'>): Node<'vec4'>
  detail(cells: Node<'vec3'>): Node<'float'>
  curl(uv: Node<'vec2'>): Node<'vec2'>
}
export declare class CloudNoise implements CloudResource {
  readonly nodes: CloudNoiseNodes
  setFormat(format: 'r8' | 'rgba8'): void // a value swap between two textures of one binding type
  /* CloudResource */
}
// cloudProfile.ts
export declare class CloudProfile {
  /** genusProfile baked into 64 heights × 8 genera, RGBA8, linear, no mips. */
  profile(genus: Node<'float'>, h01: Node<'float'>): Node<'float'>
  readonly texture: DataTexture
  dispose(): void
}
```

**Bake.** The noise is drawn into `RenderTarget3D` slices
(`UnsignedByteType`, `RedFormat`; RGBA8 for the variant), one quad a slice,
through `runQuadPasses` under the label `cloud noise`, once, at warm.

- Repeat wrapping on S, T and R. `generateMipmaps = false`, so the texture
  has one level (temporal map §19.2).
- The lattice hashes modulo its period with `pcg4d` on integer cells, so the
  texture tiles exactly.
- `packages/rendering/src/weatherNoise.ts` is the CPU function the GPU test
  holds every texel to.
- Fragment slices need no `texture-formats-tier1` (an `r8unorm` _render
  attachment_ is core; `r8unorm` _storage_ is not). The premise spike in the
  contracts package proves three draws into a `RenderTarget3D` slice, and warms
  it with `warmSensorPass`, before any package starts (§11.1). If it cannot,
  the fallback is chosen there, before the fan-out, and recorded: compute into a
  `Storage3DTexture` (through `cloudStorage3DTexture`) with
  `texture-formats-tier1`, tests skipped where the adapter lacks it. The volume
  (§3.11) takes the same answer, so neither package learns it after the
  other has built on it.

### 3.9 Maps (WP4)

| Map          | Layout                                                                              | Texels                                       | Formats                                                                      | Refresh                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Weather cube | 2D atlas of six face tiles, 3 × 2, each 514² (512 + 1-texel gutter), tangent-warped | 19.6 km at Earth's equator                   | `RenderTarget(1542, 1028, { count: 4, type: UnsignedByteType })`: four RGBA8 | One face a frame steady, the cycle 6 frames; after a jump, all six over the next six frames                                                 |
| Clipmap      | 2D array, six layers of 256², repeat-wrapped (toroidal), baked from the cube        | 250 m × 2ᵏ, k = 0…5 (64 km to 2,048 km wide) | `RenderTarget(256, 256, { depth: 6, count: 4 })`                             | Exposed strips each frame the window moves; ⅛ of one level a frame for time; after a jump, levels 0–1 this frame and 2–5 over the next four |

**Channel packing.** This is phase 0's, and ADR-0064 records it. It differs from
the plan's §4.8 ordering so that a fine step reads one texel:

| Texture | R                         | G                 | B                          | A                       |
| ------- | ------------------------- | ----------------- | -------------------------- | ----------------------- |
| 0       | coverage, layer 0         | coverage, layer 1 | coverage, layer 2          | ice share, middle layer |
| 1       | log in-cloud τ, layer 0   | layer 1           | layer 2                    | rain rate               |
| 2       | convective share, layer 0 | layer 1           | layer 2                    | deep-convection rate    |
| 3       | wind east                 | wind north        | wetness (spare in phase 0) | puddles (spare)         |

Log τ is `log2(1 + τ)/log2(513)`, which carries τ up to 512 at 2.5% steps.
Wind is ±50 m/s, offset by 0.5. Phase 0 writes the placeholder into
textures 0–2. Texture 3 carries the scenario's wind.

**Where each map's values come from.** The cube is baked from
`scenarioCoverageNode`, the placeholder's coverage function ported to TSL
(`scenarioCoverage`'s rules: blob cells decided by a `u32` comparison of
`pcg4d(cell, period)`). The clipmap is baked from the cube, every level, and
adds nothing finer in phase 0, because the placeholder has no structure under
the cube's texel that the noise does not carry: one function at two
resolutions, as plan §4.8 has it, and the place phase 3's climatology and
orography go in. The far bakes of the served body read the cube too, through
`synopticMedium` (§3.10), and the second body's, which has no cube, read
`scenarioCoverageNode` directly.

```ts
// cloudMaps.ts — the cube feeds bakes; the fine march does not read it.
/** The placeholder's coverage of `layer` at a body-fixed direction, for `body`'s
 *  frame and the shared scenario uniforms: the cube bake's source, and the
 *  second body's far bake's (§3.13). */
export declare function scenarioCoverageNode(
  uniforms: CloudUniforms,
  body: CloudBodyUniforms,
  layer: Node<'int'>,
  direction: Node<'vec3'>,
): Node<'float'>
export interface CloudMapNodes {
  /** Texture 0 at a body-fixed direction (gutter-safe bilinear in its face tile, level 0). */
  synoptic(direction: Node<'vec3'>): Node<'vec4'>
  /** Texture k (1, 2, 3) at a direction. */
  channel(direction: Node<'vec3'>, texture: 1 | 2 | 3): Node<'vec4'>
}
export declare class CloudMaps implements CloudResource {
  readonly nodes: CloudMapNodes /* … */
}

// cloudClipmap.ts — what the fine march reads a step.
export interface CloudClipmapNodes {
  /** Each layer's coverage at the sample, from the finest level whose window holds it, faded
   *  over the outer fifth into the next (the fade band reads both levels). Level 0. */
  coverage(sample: CloudSample, body: CloudBodyUniforms): Node<'vec3'>
  /** (log τ, convective share, ice) of one layer: read once a segment. */
  column(
    sample: CloudSample,
    body: CloudBodyUniforms,
    layer: Node<'int'>,
  ): Node<'vec3'>
  /** The texel size of the level `coverage` reads: the column a segment may span. */
  columnMeters(sample: CloudSample, body: CloudBodyUniforms): Node<'float'>
}
export declare class CloudClipmap implements CloudResource {
  readonly nodes: CloudClipmapNodes /* … */
}
```

The fine march's reach is about 100 km at `farFootprint` 400 m, and the clipmap
covers 2,048 km, so the cube is read by bakes only: the clipmap's levels, the
far atlas and the sphere caches. That keeps the trace kernel at 13 sampled
textures (15 with the volume) against the default limit of 16 (§3.7).

**A level's lookup is formed eye-relatively** (rule 58). The plane coordinate
of a point P about anchor A with east E is `u(P) = R·(P·E)/(P·A)`. With
P = e + o, the eye's position e from the center and the sample's offset o,

```
u(e + o) = u(e) + Δu,   Δu = R·[(o·E)(e·A) − (e·E)(o·A)] / [(e·A + o·A)(e·A)]
```

and likewise for north with N. `u(e)` is the level's `eye` uniform and
(e·A, e·E, e·N) its `along`, all formed on the CPU in float64; `o·E` and `o·A`
are float32 dot products of the offset with unit vectors. No absolute direction
enters: normalizing `eyeDirection·R_eye + offset` in float32, as a direction
lookup would, carries about 0.4 m of error on Earth, 1% of a 50 m volume texel
and moving with the eye, where Δu's error is about 1 cm at 100 km. The bake
inverts the same projection (`directionOf`), so the bake and the lookup agree
by construction.

### 3.10 Density (WP4)

```ts
// cloudDensity.ts
export interface FieldMediumDeps {
  readonly uniforms: CloudUniforms
  readonly clipmap: CloudClipmapNodes
  readonly noise: CloudNoiseNodes
  readonly profile: CloudProfile
}
/** The fine march's medium: the clipmap's coverage × profile × eroded noise (§5.6). */
export declare function fieldMedium(deps: FieldMediumDeps): CloudMediumFn
export interface SynopticMediumDeps {
  readonly uniforms: CloudUniforms
  readonly maps: CloudMapNodes
  readonly noise: CloudNoiseNodes
  readonly profile: CloudProfile
}
/** The same recipe with its coverage read from the weather cube: the whole body,
 *  for the served body's far bakes, which reach the limb (1,830 km of gnomonic
 *  plane on far-shore from 400 km, 2,290 km on Earth), past the clipmap's
 *  ±1,024 km. */
export declare function synopticMedium(deps: SynopticMediumDeps): CloudMediumFn
/** The same recipe with its coverage from `scenarioCoverageNode`: the second
 *  body, which has no cube. */
export declare function analyticMedium(deps: {
  readonly uniforms: CloudUniforms
  readonly noise: CloudNoiseNodes
  readonly profile: CloudProfile
}): CloudMediumFn
/** The sweep's medium (§8.4): `sweepReads` base-noise fetches at decorrelated
 *  offsets, summed so none can be dropped, plus one read of `sweepExtra`'s type. */
export declare function sweepMedium(deps: FieldMediumDeps): CloudMediumFn
```

The three non-sweep media evaluate one expression (§5.6) and differ only in
where the coverage comes from, so the far field is the same field at every
distance. A far bake forms its sample's offset as `(R + h)·d − e` in float32,
whose error at 2,000 km is about half a meter: under 10⁻³ of a base cell, and
the bake's 4 × 4 sub-columns sample the noise statistically rather than as a
lattice decision.

### 3.11 The local volume and its bound (WP5)

```ts
// cloudVolume.ts
export const CLOUD_VOLUME_SIZE = 256
export const CLOUD_VOLUME_SLICES = 32 // + 2 guard slices a level, stacked in z
export const CLOUD_VOLUME_TEXELS = [50, 200, 800] as const
export interface CloudVolumeDeps {
  readonly uniforms: CloudUniforms
  readonly bake: CloudMediumFn /* what it caches: the field */
  readonly detail: CloudNoiseNodes
}
export declare class CloudVolume implements CloudResource {
  constructor(deps: CloudVolumeDeps)
  /** One read a step: R = √(σ/σ_scale), G = fraction, at the finest level holding the sample,
   *  plus detail-noise erosion where the footprint is finer than the level's texel. Level 0. */
  readonly medium: CloudMediumFn
  /** The largest R over the sample's 4³ brick and one texel around it: zero means
   *  no trilinear read anywhere in the brick can see cloud. */
  bound(sample: CloudSample, body: CloudBodyUniforms): Node<'float'>
  /** The distance along the ray at which it leaves the brick holding the sample. */
  brickExit(
    sample: CloudSample,
    ray: CloudRay,
    body: CloudBodyUniforms,
  ): Node<'float'>
}
```

**Layout.** One `RenderTarget3D(256, 256, 3 × 34, { type: UnsignedByteType, format: RGFormat })`
holds every level. Wrapping repeats on S and T (toroidal) and clamps on R. Level
L's 32 slices start at z = 34L + 1, with guard slices at 34L and 34L + 33 that
duplicate the edges, so trilinear filtering never mixes two levels.

**Vertical axis.** It is the scenario's shell union over the datum,
`(union.top − union.base)/32` meters a slice: 44 m for `fair-cumulus` and 438 m
for `anvil`. The horizontal axis is the level's gnomonic plane.

**Bake.** One quad a slice under the label `cloud volume`. It evaluates the
injected `bake` medium (the field) at texel centers, each formed by
`levelOffset` (§3.5b) from the texel's plane coordinate and its slice's height,
eye-relatively. The per-frame budget is 8 slices, prioritized by level 0, then
the dirty strips, then the time refresh, then levels 1 and 2. After a jump or a
cut, level 0 is rebuilt whole that frame (34 slices) and levels 1–2 follow at
the budget.

**Bound.** A compute kernel `cloud volume bound` writes, for each 4³ brick, the
largest `R` over the brick and the one-texel border around it: a 6³ footprint,
wrapping toroidally on S and T and reading the guard slices on R. A trilinear
read anywhere inside a brick takes the 2 × 2 × 2 texels around it, which reach
one texel past the brick's faces, so a per-brick maximum without the border
would let a read near a face see a cloudy neighbor the bound calls empty. The
output is an RGBA8 storage texture (64 × 64 × 30, through
`cloudStorage3DTexture`; RGBA8 storage is core). It runs over the bricks the
frame's slices touched and their neighbors.

**Skipping.** A step whose `bound` is zero advances to `brickExit`, the least
over the brick's three axes of the distance to its far face divided by that
coordinate's rate along the ray at the sample (from `levelPlane`'s and
`altitudeAt`'s derivatives in t, formed analytically), plus 0.5 m so a ray
never stalls on a face. Over a 200 m brick the curvature this linearizes is
under 3 mm. A fixed advance of a brick's width from wherever the sample sits
would carry the ray up to a whole brick into the next one, 14 optical depths of
cumulus at level 0.

**Idle.** A level whose window lies more than its own extent below the eye is
not baked (from orbit, none are) and is not `pending`.

### 3.12 The sun's optical depth, the light, and the phase (WP5)

```ts
// cloudSunCascades.ts
export const SUN_CASCADE_EXTENTS = [12_800, 51_200, 204_800] as const // meters; texels 25, 100, 400 m
export const SUN_CASCADE_SIZE = 512
export const SUN_CASCADE_SLICES = 8 // 64 rows a slice
/** The per-frame cap both candidates share, in texel-steps: one grid rebuild. */
export const SUN_DEPTH_FRAME_CAP = 16_777_216 // 128² × 32 cells × 32 steps; a cascade rebuild is 512² × 48
export declare class CloudSunCascades
  implements CloudResource, CloudSunDepthNodes
{
  constructor(uniforms: CloudUniforms, field: CloudMediumFn)
}
// cloudSunGrid.ts
export const SUN_GRID_SIZE = [128, 128, 32] as const // over the volume's level-1 window and the union's height
export declare class CloudSunGrid implements CloudResource, CloudSunDepthNodes {
  constructor(uniforms: CloudUniforms, volume: CloudVolume)
}

// cloudSunlight.ts
/** Tap midpoints and widths over the first kilometer toward the sun (§5.9). */
export const LIGHT_TAPS = {
  2: [
    [125, 250],
    [625, 750],
  ],
  4: [
    [50, 100],
    [200, 200],
    [450, 300],
    [800, 400],
  ],
} as const
export const LIGHT_TAP_REACH = 1000
export interface CloudSunDeps {
  readonly uniforms: CloudUniforms
  readonly medium: CloudMediumFn
  readonly depth: CloudSunDepthNodes
}
export declare function cloudSunFn(deps: CloudSunDeps): CloudSunFn

// cloudPhase.ts
/** The Mie droplet table (packages/rendering) uploaded as 1024 × 32 RGBA16F (RGB the bands), linear, no mips. */
export declare class CloudPhase implements CloudResource, CloudPhaseNodes {
  constructor(table: MieTable)
}

// packages/rendering/src/mieTable.ts — the type and a decoder of the stub table in the contracts package; WP2 the rest
export interface MieTable {
  readonly angles: number // 1024: θ_i = (π/2)(1 − cos(π·i/(angles − 1))), both ends dense (§6.4)
  readonly radii: number // 32 rows
  readonly radiusMin: number // µm, 2
  readonly radiusMax: number // µm, 32: r_j = radiusMin·(radiusMax/radiusMin)^(j/(radii − 1))
  readonly variance: number // the gamma's effective variance, 0.01
  readonly bands: readonly [number, number, number] // nm: 680, 550, 440, the air's
  readonly wavelengthsPerBand: number // 9
  readonly bandHalfWidth: number // nm, 40
  /** sr⁻¹, normalized to ∫p dΩ = 1, laid out [row][angle][band]: radii × angles × 3. */
  readonly phase: Float32Array
  /** Per row: Q_ext, single-scattering albedo and asymmetry, band-averaged. */
  readonly bulk: readonly {
    readonly extinction: number
    readonly albedo: number
    readonly asymmetry: number
  }[]
  /** Per row: the red band's first glory ring, degrees from the antisolar point,
   *  found on the series at full angular resolution by the generator (§6.6). */
  readonly gloryRed: readonly number[]
}
export declare function mieDroplets(): MieTable // decodes mieDroplets.generated.ts
export declare function angleOf(table: MieTable, index: number): number // radians
export declare function angleIndex(table: MieTable, theta: number): number // continuous
export declare function radiusOf(table: MieTable, row: number): number // µm
export declare function radiusIndex(table: MieTable, radius: number): number // continuous
/** Bilinear in (angle index, row), per band: what the GPU's linear read does. */
export declare function samplePhase(
  table: MieTable,
  cosTheta: number,
  radius: number,
): readonly [number, number, number]
/** ∫p dΩ of one row and band over the table's own grid (trapezoid in θ with sin θ). */
export declare function phaseIntegral(
  table: MieTable,
  row: number,
  band: number,
): number
```

**Cascade texel layout.** The cascades are `RenderTarget(512, 512, { depth: 3, type: HalfFloatType })`.
Each texel holds:

- R and A: the front depth along the sun from the near plane, in km, as a pair
  of half floats: `R = f16(z_front)` and `A = f16(z_front − R)`. Bilinear
  filtering is linear, so the filtered pair still sums to the filtered depth.
- G: mean extinction over the cloudy chord, in 1/km.
- B: maximum optical depth.

`T(z) = exp(−min(G·max(z − (R + A), 0), B))` (Hillaire 2020), with `z` the
reading sample's distance from the near plane along the sun, formed from its
eye-relative offset.

**Why the pair.** Across a cascade the along-sun distance from one
sun-perpendicular near plane to the layer varies by about `extent·cot(sun
elevation)`. At the basin's 37.5° that reaches about 19, 69 and 269 km at the
far edges of the three cascades, where one half float steps by 15.6, 62.5 and
250 m: at cumulus σ 0.068/m, rounding errors of up to ±0.5, ±2 and ±8 optical
depths, landing on exactly the front samples that carry a cloud's light. The
cascades would then fail §8.7's 3% `T_cloud` gate on storage precision rather
than on their method. The pair's residual is under 0.125 km at 269 km, which a
half float holds to 6 cm. A depth measured from each texel's own analytic entry
into the union fixes thin unions and not deep ones: through the anvil's
1–15 km union the front can sit 23 km behind the entry, a 15.6 m step again.
There is no validity channel: a cascade not yet built since a first frame or a
cut is read as clear by its own `valid` uniform, and `pending` holds until it is.

**Cascade bake.** Each texel marches 48 steps along its sun ray between the
ray's crossings of the union's top and base, formed from heights
(`shellCrossingFrom`, §3.5b) and with every step's height from `altitudeAt`
(rule 52). The label is `cloud sun cascade`.

**Cascade refresh, under the shared cap.**

| Event                                                                            | Cascades                                                                                                                                                                                              | Grid                                                                                 |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Steady                                                                           | One 64-row slice a frame, round-robin over the 24, for the field's time                                                                                                                               | Four slices a frame                                                                  |
| The eye moves (`fly`, a descent)                                                 | The grid of each cascade scrolls toroidally by whole texels; the exposed strips are drawn the frame they appear (at 7.7 km/s about five 25 m columns a frame on the inner cascade, 123 k texel-steps) | Its frame is the volume's level 1, also toroidal: the exposed strips, the same frame |
| The sun moves 0.05° (`SUN_CASCADE_TURN`) from an orientation, or the field jumps | Stale; one cascade rebuilt whole a frame, inner first (12.6 M texel-steps), each switching to its new orientation as it is drawn, so no cascade ever mixes two                                        | Rebuilt whole that frame (16.8 M)                                                    |
| A cut (`cut`, a teleport)                                                        | As a jump, from a first frame: each cascade read as clear until built                                                                                                                                 | As a jump                                                                            |

Nothing either candidate does in a frame exceeds `SUN_DEPTH_FRAME_CAP`; work
past it waits a frame and holds `pending`. 0.05° of sun moves a shadow cast
from 10 km of chord by 9 m, under the inner cascade's 25 m texel. At 1× that
re-orients Earth's cascades every 12 s, and under a 3 h scrub every frame.

**Grid.** The grid is `RenderTarget3D(128, 128, 32, { type: HalfFloatType, format: RedFormat })`,
holding τ from the cell center to the union's top along the sun, summed through
the volume in 32 steps whose heights come from `altitudeAt`. The label is
`cloud sun grid`.

### 3.13 The far field (WP7)

```ts
// cloudFar.ts
export interface CloudFarField extends CloudResource {
  /** The march past the handover, for the body these uniforms describe. Level-0 reads. */
  readonly far: CloudFarFn
}
export interface CloudFarDeps {
  readonly uniforms: CloudUniforms
  /** What it bakes from: synopticMedium for the served body (the cube's coverage,
   *  the whole body), analyticMedium for the second (§3.10). */
  readonly field: CloudMediumFn
  readonly phase: CloudPhaseNodes
  readonly body: 'served' | 'second'
}
import type { CloudFarKind } from './cloudLevers.ts'
export declare function createFarField(
  kind: CloudFarKind,
  deps: CloudFarDeps,
): CloudFarField
// cloudFarAtlas.ts: 6 faces × 3 layers × 258², RGBA8 (fraction, log in-cloud τ, base, top), a 1548 × 774 2D atlas
// cloudFarSpheres.ts: the same layout, RGBA16F (fraction, column τ, cached T_sun, spare)
export const FAR_BLOCK = 192 // texels: one scissored block a frame, 45 blocks a cycle
export const FAR_STEPS_A_LAYER = 32
```

**Base and top encoding.** Both are quantized over the layer's own range,
`[base_k − 500 m, top_k + 500 m]`.

**Bake.** Each texel is evaluated from the injected field over 4 × 4
sub-columns × 8 heights:

- fraction = the share of cloudy sub-columns (column τ > 0.1);
- τ_in = the mean τ over the cloudy ones;
- base and top = the extremes over the cloudy ones.

One scissored 192 × 192 block is drawn a frame as one quad, so the bake is one
pass a frame on the timeline, and 45 blocks cover the atlas. Nine separate tile
quads would be nine passes a frame, each with its own timestamp pair, against
a query set that holds 2,048 (§4.4). The labels are `cloud far atlas`,
`cloud far spheres` and `cloud far second` (the second body's atlas, baked from
`analyticMedium`, on the same schedule).

**The second body** always takes an atlas, whichever candidate the served body
uses, and draws through the composite in the thin form (§5.11).

### 3.14 The trace (WP6)

```ts
// cloudTrace.ts
export interface CloudTraceTextures {
  /** (L_c.rgb, T_c): the cloud's light reaching t₀ per unit sun irradiance, and its transmittance over the span. w × h. */
  readonly light: StorageTexture
  /** 2w × h. [2i, j]: (B.rgb, d_reproj km). [2i+1, j]: (d_end km, d_front km, deviation km, knots). */
  readonly aux: StorageTexture
  /** 2w × h. [2i, j]: (entry₀, exit₀, entry₁, exit₁) km. [2i+1, j]: (entry₂, exit₂, entry₃, exit₃) km. */
  readonly knotDepth: StorageTexture
  /** 2w × 2h. Knot k of texel (i, j) at (2i + (k & 1), 2j + (k >> 1)): (L.rgb, T) at the knot's exit. */
  readonly knotLight: StorageTexture
  /** The trace's extent, which every dispatch writes within, the immediate regime's included. */
  readonly extent: Extent
}
export interface CloudTraceDeps {
  readonly uniforms: CloudUniforms
  readonly media: {
    readonly field: CloudMediumFn
    readonly volume: CloudMediumFn | null
    readonly bound:
      ((s: CloudSample, b: CloudBodyUniforms) => Node<'float'>) | null
    readonly brickExit:
      | ((s: CloudSample, r: CloudRay, b: CloudBodyUniforms) => Node<'float'>)
      | null
    readonly sweep: CloudMediumFn
  }
  readonly sun: Readonly<Record<CloudSunDepth, CloudSunFn>>
  readonly phase: CloudPhaseNodes
  readonly far: Readonly<Record<CloudFarKind, CloudFarFn>>
  /** The render-resolution scene distance, km (R16F), from the depth copy. */
  readonly depth: () => Texture
}
export declare class CloudTrace implements CloudResource {
  constructor(deps: CloudTraceDeps)
  readonly textures: CloudTraceTextures
  /** The converging regime: one dispatch of the selected kernel at this frame's interleave phase. */
  render(renderer: WebGPURenderer, frame: CloudFrame, budget: CloudBudget): void
  /** The immediate regime's k-th dispatch (k = 0…3, Bayer order), at maxSteps/4;
   *  the system follows each with the history's immediate kernel (§5.14). */
  dispatchPhase(renderer: WebGPURenderer, frame: CloudFrame, k: number): void
  /** Mean and largest steps a ray when levers.stats, read back a few frames late; null otherwise. */
  readonly steps: {
    readonly mean: number
    readonly max: number
    readonly exhausted: number
  } | null
}
// cloudMarch.ts — the per-ray function, testable on its own with injected media.
export interface CloudMarchResult {
  readonly light: Node<'vec3'>
  readonly air: Node<'vec3'>
  readonly transmittance: Node<'float'>
  readonly reproject: Node<'float'>
  readonly end: Node<'float'>
  readonly front: Node<'float'>
  readonly deviation: Node<'float'>
  readonly stopped: Node<'float'> // where the fine budget ran out, or the far distance
}
export declare function cloudMarch(
  ray: CloudRay,
  jitter: Node<'float'>,
  sky: Node<'bool'>, // the texel's class (§5.11): the beam B is accumulated with
  deps: Omit<CloudTraceDeps, 'far' | 'depth' | 'sun'> & {
    readonly medium: CloudMediumFn
    readonly sun: CloudSunFn
  },
  knots: CloudKnotWriter | null,
): CloudMarchResult
/** The sweep's march (§8.4): fixedSteps steps of 4 m from t₀, no stop at t₁,
 *  no early exit, no sun, no air, no far march; the sweep medium every step. */
export declare function cloudSweepMarch(
  ray: CloudRay,
  jitter: Node<'float'>,
  deps: { readonly uniforms: CloudUniforms; readonly medium: CloudMediumFn },
): CloudMarchResult
// cloudKnots.ts
export interface CloudKnotWriter {
  record(
    entry: Node<'float'>,
    exit: Node<'float'>,
    transmittance: Node<'float'>,
    light: Node<'vec3'>,
  ): void
  /** Writes the four knots through finiteOr, so a NaN the history would have
   *  caught cannot reach cloudFront, which reads the knots directly. */
  flush(texel: Node<'uvec2'>): void
}
```

There are eight kernels, one per (cache, sun depth, far) triple, and the sweep
kernel, each named `cloud trace` (one label: one row on the timeline). A sun
depth is its own variant because the cascades (a 2D array) and the grid (a 3D
texture) are two binding types, and binding both would put the volume variants
at 16 of 16 sampled textures. Phase 0 keeps all nine while measuring and
removes eight before landing. Workgroups are 8 × 8. Every kernel guards
`globalId.xy < size`, and `size` is the trace's extent on every dispatch, so no
store lands outside a texture. Every output texture comes from
`cloudStorageTexture` (§3.7).

Under `stats` it adds one `atomicAdd` a ray to a 4 × u32 storage buffer (sum,
max, rays, exhausted). A separate kernel, `cloud stats`, clears it, and it is
read back as the meter does.

### 3.15 The history (WP8)

```ts
// cloudHistory.ts
export interface CloudHistoryTextures {
  readonly light: StorageTexture // (L_c.rgb, T_c)
  readonly air: StorageTexture // (B.rgb, d_reproj km)
  readonly depth: StorageTexture // (d_end km, d_front km, deviation km, age frames)
  readonly extent: Extent
}
export declare class CloudHistory implements CloudResource {
  constructor(uniforms: CloudUniforms, trace: () => CloudTraceTextures)
  /** The newest history: what the composite and the next frame read. */
  readonly textures: CloudHistoryTextures
  /** The converging regime: reproject, reject, clip and blend into the other parity. */
  render(renderer: WebGPURenderer, frame: CloudFrame, budget: CloudBudget): void
  /** The immediate regime: write phase k's pixels of the newest parity from the
   *  trace, age 0, and nothing else. After k = 3 every pixel is this frame's. */
  renderImmediate(renderer: WebGPURenderer, frame: CloudFrame, k: number): void
  reset(): void
  readonly report: {
    readonly resets: number
    readonly sinceReset: number
    readonly phase: number
    readonly rejected: number | null
  }
}
```

There are four kernels, each named `cloud history`: a converging kernel for
each parity (A→B and B→A) and an immediate kernel writing into each. Each binds
distinct texture objects, so no node ever shares a texture (rule 57). All six
storage textures are RGBA16F, through `cloudStorageTexture`: `rg16float`
storage needs tier 1. The immediate kernel writes three storage textures, under
the limit of four; one kernel writing the history and the knots together would
need five, which is why the immediate regime goes through the trace's own
textures a phase at a time (§5.14).

### 3.16 The composite, the knots' consumer, the split, the over pass, the frame node, the depth copy and the system

```ts
// cloudComposite.ts (WP9)
export interface CloudCompositeDeps {
  readonly uniforms: CloudUniforms
  readonly history: () => CloudHistoryTextures
  readonly depth: () => Texture // R16F km, render resolution
  readonly far: CloudFarFn // the second body's: atlas
  readonly phase: CloudPhaseNodes
  readonly frameNode: Node // CloudFrameNode: in the graph, so its updateBefore runs here
}
export declare class CloudComposite {
  constructor(deps: CloudCompositeDeps)
  /** Placement A: opaque list, OVER layer, renderOrder −1e6, CustomBlending (One, 1 − SrcAlpha; alpha Zero, One). */
  readonly passes: Mesh
  /** Placement B: transparent list, layer 0, renderOrder 1.5, the same blend. */
  readonly split: Mesh
  setMode(mode: CloudCompositeMode): void // a uniform: identity / thin / inert (residual)
  show(placement: CloudPlacement | null): void // at most one mesh visible
  /** The residual meter (§3.16 below): after the frame, under composite 'residual'. */
  measureResidual(renderer: WebGPURenderer, sceneTarget: RenderTarget): void
  readonly residual: CloudRenderReport['residual']
  warm(
    renderer: WebGPURenderer,
    layout: SceneLayout,
    camera: Camera,
    scene: Scene,
  ): Promise<void>
  dispose(): void
}
// cloudCompositeAir.ts (WP9) — the air a pixel already carries, split at t₀ (§5.11)
export interface CompositeAir {
  readonly sky: Node<'bool'> // the shell's own depth test: D at or past the air's outer far wall
  readonly toStart: Marched // L_a(0, t₀), T_a(0, t₀): physical throughput, beam cleared as the class's
  readonly toEnd: Node<'vec3'> // L_a(0, min(t₁, D)) built from the two segments
  readonly seen: Node<'vec3'> // T'_a(0, t₀): what the cloud's own light is dimmed by (cleared on surfaces under Enhanced from orbit)
}
/** The class test alone, which the trace calls for its own texel too (§5.11). */
export declare function skyClass(
  air: AirUniforms,
  eye: Node<'vec3'>,
  direction: Node<'vec3'>,
  depth: Node<'float'>,
  units: Node<'float'>,
): Node<'bool'>
export declare function compositeAir(
  air: AirUniforms,
  eye: Node<'vec3'>,
  direction: Node<'vec3'>,
  t0: Node<'float'>,
  t1: Node<'float'>,
  depth: Node<'float'>,
  sun: Node<'vec3'>,
  cleared: Node<'float'>,
  units: Node<'float'>,
): CompositeAir

// cloudFront.ts (WP9) — what a transparent object at `distance` along its own pixel's ray sees in front of it.
export declare function cloudFront(
  trace: () => CloudTraceTextures,
  uniforms: CloudUniforms,
  screen: Node<'vec2'>,
  distance: Node<'float'>,
): { readonly transmittance: Node<'float'>; readonly light: Node<'vec3'> }

// cloudSplit.ts (WP3)
export const SPLIT_LABEL = 'scene over clouds'
/** End the scene pass, put what its encoder holds on the queue, resume on a fresh encoder; three
 *  renders and computes `during` issues execute between the halves. False, and `during` not run,
 *  off WebGPU or outside an open render pass. */
export declare function splitScenePass(
  renderer: Renderer,
  during: () => void,
): boolean

// cloudOverPass.ts (WP3)
export declare class CloudOverPassNode extends TempNode<'vec4'> {
  constructor(scene: Scene, camera: Camera, target: RenderTarget, mrt: MRTNode)
  active: boolean
  /** vec4(0): in the sensor's dependency sum for its order, binding nothing in the post program. */
  override setup(): Node
  /** Renders the OVER layer into the scene target with load ops, the target named SPLIT_LABEL meanwhile. */
  override updateBefore(frame: NodeFrame): undefined
}

// cloudFrameNode.ts (WP3)
export interface CloudFrameDriver {
  /** True only between beginFrame and endFrame: compileAsync runs updateBefore while warming. */
  readonly inFrame: boolean
  readonly placement: CloudPlacement
  /** The frame's cloud passes, in §4.2's order. */
  run(renderer: WebGPURenderer): void
}
export declare class CloudFrameNode extends TempNode<'float'> {
  constructor(driver: CloudFrameDriver)
  /** float(0), added to the composite's opacity so the node is in its graph. */
  override setup(): Node
  /** Under 'split', splitScenePass(renderer, run); under 'passes', run(); under
   *  'empty-split', splitScenePass(renderer, () => {}). Nothing outside a frame. */
  override updateBefore(frame: NodeFrame): undefined
}

// cloudDepth.ts (WP3)
export declare class CloudDepth implements CloudResource {
  constructor(uniforms: CloudUniforms, layout: SceneLayout)
  /** View distance (along the ray) in render meters ÷ 1000, R16F, render resolution,
   *  clamped at 60,000 km; far depth stores the clamp. Row 0 is the top of the image. */
  readonly texture: Texture
  /** Ties the copy's source to the scene target's (multisampled) depth, as
   *  SeaFrameNode.#tie does, so the binding layout matches the frame's. */
  tie(sceneTarget: RenderTarget): void
  /* CloudResource: render draws `cloud depth`; warm compiles against the tied depth */
}

// cloudSystem.ts (WP11)
export interface CloudSystemDeps {
  readonly renderer: WebGPURenderer
  readonly scene: Scene
  readonly camera: Camera
  readonly layout: SceneLayout
  readonly scenePass: PassNode
}
export interface CloudSensorState {
  readonly processing: 'enhanced' | 'photographic' | string
}
export interface CloudSystem {
  readonly overPass: Node
  beginFrame(inputs: CloudFrameInputs | null, sensor: CloudSensorState): void
  endFrame(): void
  /** After post.render: the residual meter under composite 'residual'; stats readbacks. */
  afterFrame(renderer: WebGPURenderer): void
  resetHistory(): void
  warm(): Promise<void>
  readonly report: CloudRenderReport
  dispose(): void
}
export declare function createCloudSystem(deps: CloudSystemDeps): CloudSystem
```

**The frame node.** `CloudFrameNode` extends `TempNode<'float'>`, its
`setup()` returns `float(0)` and is added to the composite's opacity, and its
`updateBeforeType` is `RENDER`. Its `updateBefore()` returns at once unless
`driver.inFrame`. That keeps `compileAsync` (which runs `updateBefore` while
warming; see `upscale.ts:205`) from running cloud work at boot. The system is
its driver; WP3 tests it with a driver of its own. Inside a frame it does this:

1. Under `split`, call `splitScenePass(renderer, run)`. Under `passes`, call
   `run()`. Under `empty-split`, call `splitScenePass(renderer, () => {})`.
2. `run` draws, in order:
   1. the noise, once;
   2. the maps;
   3. the clipmap;
   4. the volume and its bound, if any lever needs them;
   5. the sun-depth candidate in use;
   6. the far field in use, and the second body's;
   7. `cloud depth`;
   8. in the converging regime, `cloud trace` then `cloud history`; in the
      immediate regime, four times over k = 0…3, `cloud trace` (phase k) then
      `cloud history` (phase k's pixels).

Under both placements the work in `run` is issued from inside an open render:
pass B's under A, the split scene pass's under B. Each piece is its own
encoder, submitted as it finishes. The premise spike (§11.1) proves for both
that nested computes and renders leave the outer render's context and target
intact and execute in the order issued.

**The composite's MRT writes.** The composite's material goes through
`sensorRadiance(material, false, false, 'alpha')`, which multiplies
`output.rgb` by `sceneRadianceGain` once, as it does for the shell's
`inscatter·sunColor·ATMOSPHERE_GAIN`. So no value below carries the gain
itself; one that did would draw the cloud and the identity's air at the gain's
square wherever the gain is not 1 (dusk, night, the `sunset` scenario).

| Row                        | Value                                                                                                                                                                                                                        | Rule                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `output`                   | `src.rgb = Φ·[(1 − T_c)·L_a(0, min(t₁, D)) + T'_a(0,t₀)·L_c + T_a(0,t₀)·B]·dayColor·π`, `src.a = Φ·(1 − T_c)`                                                                                                                | Premultiplied; negative `src.rgb` is allowed and does not clamp on float targets. Φ is 1 where the upsample found a history texel whose `d_end` matches the pixel's depth, else the depth moments' share in front of D (§5.11) |
| `reactive`                 | `vec4(src.a, 0, 0, src.a)` through `sensorRadiance(…, 'alpha')`                                                                                                                                                              | `union` blend                                                                                                                                                                                                                  |
| `motion`                   | `vec4(cloudVelocity.xy, 1/z, src.a)` through the material's `mrtNode`, with `z = d_reproj·1000·compression·cos(ray, camera axis)`: the cloud's view depth in render meters, as every other writer's `1/(−positionView.z)` is | `over` blends by opacity, with no threshold                                                                                                                                                                                    |
| `meterMask`                | 0                                                                                                                                                                                                                            | `max` keeps the surface's                                                                                                                                                                                                      |
| `velocity` (temporal only) | The cloud's velocity                                                                                                                                                                                                         | `none` replaces it, so the fragment discards where `src.a < 1/512` and the light term is under half float's step. Under `residual` it always discards. Declared (§12.2, risk 2)                                                |

The cloud's velocity is formed from the previous camera's projection of the
reprojected point, the same arithmetic as the history's. Writing `1/d_reproj`
in kilometers along the ray would read to defocus and the meter as a cloud a
thousand times nearer (and about 15% nearer again at the frame's corners), and
blur it to the 40-pixel cap whenever defocus is on.

**The residual meter** is a compute pass, `cloud residual`, at trace resolution.
It runs in `afterFrame`, when the composite is inert, so the resolved scene
target holds the scene as built. It reads that target ÷ the gain, the depth
copy, the history and the air, and computes three relative errors a texel:

- identity against thin;
- the identity's light residual;
- its transmittance residual × S, with `S = (scene − L_scene)/T_scene`.

It accumulates them into three 64-bin log histograms from 10⁻⁴ to 1 (atomics,
the meter's precedent), counts the texels whose class the trace and the
composite decided differently (the limb, chiefly), and reads both back
asynchronously into the report.

### 3.17 Levers, the report, and the `ir.*` surface (WP11)

```ts
// packages/devtools/src/clouds.ts — plain data, no three
export interface CloudHistogram {
  readonly bins: readonly number[] /* 64, log 1e-4…1 */
  readonly samples: number
}
export interface CloudSettle {
  readonly pending: boolean
  readonly history: string /* 'n/16' */
  readonly caches: string
}
export interface CloudRenderReport {
  readonly available: boolean
  readonly reason: 'webgl' | null
  readonly on: boolean
  readonly levers: Readonly<Record<string, string | number | boolean | null>>
  readonly served: string | null
  readonly second: string | null
  readonly regime: 'converging' | 'immediate' | 'off'
  readonly reset: string
  readonly extents: {
    readonly render: readonly [number, number]
    readonly css: readonly [number, number]
    readonly trace: readonly [number, number]
    readonly history: readonly [number, number]
  }
  readonly frames: number
  readonly resets: number
  readonly sinceReset: number
  readonly pending: {
    readonly maps: boolean
    readonly clipmap: boolean
    readonly volume: boolean
    readonly sunDepth: boolean
    readonly far: boolean
    readonly history: boolean
  }
  /** cloudsSettled(this), computed by the system: what the runner waits on. */
  readonly settle: CloudSettle | null
  readonly bytes: Readonly<Record<string, number>> & { readonly total: number }
  /** The cloud pipelines warmed: render and compute. */
  readonly pipelines: { readonly render: number; readonly compute: number }
  readonly steps: {
    readonly mean: number
    readonly max: number
    readonly exhausted: number
  } | null
  readonly residual: {
    readonly thin: CloudHistogram
    readonly light: CloudHistogram
    readonly total: CloudHistogram
    /** Trace texels whose class the trace and the composite decided differently. */
    readonly classDisagreement: number
  } | null
}
/** Null when there is nothing to wait for: no system, or levers off. */
export declare function cloudsSettled(
  report: Omit<CloudRenderReport, 'settle'> | null,
): CloudSettle | null
export const CLOUD_SETTLE_FRAMES = 16
```

| Surface            | Form                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL                | `?clouds=1` builds and warms the system for the page's lifetime (`QUERY.clouds`); absent means no system and no layer, light or camera mark                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Engine fields      | `engine.clouds: CloudLevers` (default `DEFAULT_CLOUD_LEVERS`, written by scripts). `engine.cloudSystemFactory: typeof createCloudSystem \| null`, and `engine.cloudsAvailable` is `factory !== null`. Under the flag the factory is set by a dynamic `import('../render/cloudSystem.ts')` awaited inside the canvas's renderer factory (`App.tsx`'s `gl={…}`), which R3F awaits before it mounts any child, so Sensor's first chain is built with it. Sensor.tsx passes the factory to `createSensor(…, { clouds: factory })`, so `sensor.ts` imports cloud code by type only, and lists `engine.cloudSystemFactory` among its effect's dependencies, so a factory that arrived late would rebuild the chain rather than be ignored |
| Render host        | `clouds(): CloudRenderReport \| null`, default `() => null`; production `() => this.sensorDiagnostics?.clouds ?? null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Sensor diagnostics | `SensorDiagnostics.clouds: CloudRenderReport \| null`; on WebGL with the flag, `{ available: false, reason: 'webgl', … }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Harness            | `ir.clouds()` returns the report. One `help()` line. `ir.settled()` is unchanged in phase 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The settle predicate: `pending` is `levers.on && (any cache pending || sinceReset < CLOUD_SETTLE_FRAMES)`.
That is four full interleave cycles. Phase 0 takes no plate with clouds, so the
predicate is the runner's (it waits on `ir.clouds().settle`), and folding it
into `ir.settled()`, with the `--settle` docs that describe it, is phase 1's,
when the first cloud plate needs it.

### 3.18 Additions to `warmup.ts`, `passTimeline.ts` and `gpuHarness.ts` (contracts, real code)

```ts
// warmup.ts
/** Build compute pipelines ahead of their first frame: one workgroup each, which the kernel's own
 *  bounds guard turns into nothing. r185 has no compute compile-ahead: a kernel's first dispatch
 *  builds it, and this is that dispatch, at boot. Failures are logged and swallowed, as warmCompile's. */
export async function warmCompute(
  renderer: WebGPURenderer,
  kernels: readonly ComputeNode[],
): Promise<void>;
// passTimeline.ts
/** Name the pass a framebuffer copy into `texture` resumes, in place of "<label> after copy". */
export function nameResume(texture: object, label: string): void;
// gpuHarness.ts, on the session object beside pipelinesBuilt()
/** Compute pipelines built since the session opened: createComputePipeline and
 *  createComputePipelineAsync, wrapped at the device as the render constructors are. */
computePipelinesBuilt(): number;
```

In the copy hook: `const resumed = RESUMES.get(texture) ?? `${label ?? 'pass'} after copy``.
The `texture` is the hook's first argument (`passTimeline.ts:304`).

### 3.19 Formats, sizes and declared memory

These are computed, not measured. Every texture has one level (§3.7).

| Resource                  | Format                      | 1920×1080         | 2880×1800         | Allocated when                          |
| ------------------------- | --------------------------- | ----------------- | ----------------- | --------------------------------------- |
| Base noise                | R8 128³                     | 2.10 MB           | same              | always (flag)                           |
| Base noise, sweep         | RGBA8 128³                  | 8.39 MB           | same              | `noiseFormat: 'rgba8'`                  |
| Detail, curl              | R8 32³; RG8 128²            | 0.07 MB           | same              | always                                  |
| Profile, phase            | RGBA8 64×8; RGBA16F 1024×32 | 0.26 MB           | same              | always                                  |
| Weather cube              | 4 × RGBA8, 1542×1028        | 25.36 MB          | same              | `on`                                    |
| Clipmap                   | 4 × RGBA8, 256²×6           | 6.29 MB           | same              | `on`                                    |
| Volume, 3 levels          | RG8 256²×102                | 13.37 MB          | same              | `cache: 'volume'` or `sunDepth: 'grid'` |
| Volume bound              | RGBA8 64²×30                | 0.49 MB           | same              | with the volume                         |
| Sun cascades              | RGBA16F 512²×3              | 6.29 MB           | same              | `sunDepth: 'cascades'`                  |
| Sun grid                  | R16F 128×128×32             | 1.05 MB           | same              | `sunDepth: 'grid'`                      |
| Far atlas                 | RGBA8 1548×774              | 4.79 MB           | same              | `far: 'atlas'`; +4.79 for a second body |
| Far spheres               | RGBA16F 1548×774            | 9.59 MB           | same              | `far: 'spheres'`                        |
| Depth copy                | R16F at render              | 4.15 MB           | 10.37 MB          | `on`                                    |
| Trace (light, aux, knots) | RGBA16F; 72 B a trace texel | 480×270: 9.33 MB  | 360×225: 5.83 MB  | `on`                                    |
| History, two parities     | 3 × RGBA16F, 48 B a texel   | 960×540: 24.88 MB | 720×450: 15.55 MB | `on`                                    |
| Stats, residual           | buffers                     | < 1 KB            | same              | `stats`, `residual`                     |

**The likely winner set** (field, cascades, atlas) totals about **83.5 MB** at
1080p and **76.9 MB** at Retina. Retina is smaller because the trace and the
history follow the CSS axes and only the depth copy follows the drawing buffer.
The volume path adds 13.9 MB. Every candidate allocated at once at 1080p is
about 121 MB, which a measurement never selects. The immediate regime adds
nothing: it reuses the trace's textures four times a frame (§5.14), where
allocating them at the history's extent would have added 28.0 MB at 1080p and
17.5 MB at Retina. The plan's §4.8 estimate was about 76 MB. Phase 0 reports
the measured `ir.clouds().bytes`, the declared figure, at both sizes, and
`cloudSystem.gpu.test.ts` holds the declared figure to the GPU textures'.

---

## 4. The frame schedule

### 4.1 CPU order, and where the frame's cloud state is captured

R3F's priorities are unchanged. They run EngineTick (−1), CameraRig (−0.5),
orbital bake (−0.25), the priority-0 consumers, then Sensor (1). Inside
`sensor.render()` (`render/sensor.ts`), the order becomes:

1. `const state = frame?.()`. With the flag on, Sensor.tsx's closure builds
   `state.clouds: CloudFrameInputs` from the engine (§3.3). Without it, the
   field is `null`.
2. Exposure is updated and `setSceneExposure` applied, as today. The frame's
   `processing` is now known.
3. The picture key. When it changes, call `upscale?.resetHistory()` **and**
   `clouds?.resetHistory()`.
4. **`clouds?.beginFrame(state?.clouds ?? null, { processing })`.** It runs
   `cloudFrame(inputs, previous)` and `uniforms.write(frame)`, so every
   per-frame uniform is written from inside the chain and a held loop measures
   it live. It sets the served and second bodies' `AirUniforms`
   (`set`/`lift`/`clear` from the frame's scattering, as Bodies does for the
   shell), the regime and the budgets. Under `passes` it also sets
   `scenePass.setLayers(UNDER_CLOUDS_LAYERS)` and `overPass.active = true`. It
   shows one composite mesh and stores the scene camera's near and far for the
   depth copy. This happens before step 5, so the captured camera is
   unjittered. The trace builds its rays from the pose anyway (§5.1).
5. `upscale?.beginFrame(…)`: the jitter goes on.
6. `post.render()` encodes the frame (§4.2).
7. `meter?.sample(…)`; then **`clouds?.afterFrame(renderer)`**: the residual
   meter under `composite: 'residual'`, and the stats readback.
8. `finally`: `upscale?.endFrame()`, then **`clouds?.endFrame()`**, which hides
   both composite meshes, calls `scenePass.setLayers(null)` and sets
   `overPass.active = false`. Then the existing restore runs, which already
   puts back `camera.layers.mask`.

`ir.gpu()` and `ir.passes()` call `engine.present` → `chain.render()`, so steps
1–8 run in every measured frame with fresh state. A held loop freezes
`renderTime` and the pose. `frameIndex` still advances, so the jitter and the
interleave keep moving, and `force` makes the reset, cut, scrub, warp and fly
paths real (§3.3).

### 4.2 The GPU timeline

Every three render or compute submits its own encoder when it finishes
(fact 2 of the pipeline map). The GPU runs submissions in order.

**Candidate B, the split (`placement: 'split'`), on a frame with the full sea:**

```
submitted before the scene's encoder       galaxy rays · galaxy history · galaxy volume   (nested in the backdrop's draw)
E_scene₁  scene                            opaques: backdrop, spheres, ground, rocks, hull, structures, entry-trace inks
          ↳ first sea sheet                SeaFrameNode: end · copy color + depth · resume       → 'scene after copy'
          transparents with order < 1.5    starfield (−2), shells and sea sheets (0), unserved decks (1), staged sky (1.25)
          ↳ composite (transparent, 1.5)   CloudFrameNode.updateBefore → splitScenePass:
                                             copyFramebufferToTexture(1×1): end · copy 1 texel · held beginRenderPass:
                                               submit(E_scene₁.finish()); E_scene₂ = createCommandEncoder(); return E_scene₂.beginRenderPass(d)
                                             run(), each its own encoder, submitted now, in this order:
                                               cloud maps · cloud clipmap · cloud volume · cloud volume bound ·
                                               cloud sun cascade | cloud sun grid · cloud far atlas | spheres · cloud far second ·
                                               cloud depth · cloud trace · cloud history   (immediate: trace · history four times)
E_scene₂  'scene over clouds'              composite draw · orbit traces (1.75) · rings (2) · entry 'through' (2) ·
                                           plumes (go 10) · flare (go 10) · warp (go 11) · sheath (11) · pad dust (12)
then                                       FSR (temporal) · defocus 0–3 · motion ×3 · psf ×12 · canvas · meter · cloud residual
```

**Candidate A, two passes (`placement: 'passes'`):**

```
submitted before the scene's encoder       galaxy passes
E_scene   scene (layers: UNDER)            every object on layer 0, the sea's split included; submitted at its finishRender
E_over    'scene over clouds'              CloudOverPassNode: renderer.render(scene, camera), layers OVER, autoClear false (load),
          (layers: OVER)                     the scene target and its MRT object (one RenderContext, sensor map §2.7)
          ↳ composite (opaque, −1e6)       CloudFrameNode.updateBefore → run(): the same cloud passes, nested in pass B's open
                                             render, each submitted before E_over
          composite draw, then entry-trace inks (opaque, 1, 3–6), then rings, traces, plumes, flare, warp, sheath, dust
then                                       FSR · optics · canvas · meter · cloud residual
```

**The empty split (`placement: 'empty-split'`)** is B with `run` empty and the
composite discarding every fragment. It is the split's own price: one store,
reload and resolve of every attachment, plus one submit.

**Candidate C, riding the sea's split, is not built.** It would save exactly
one split, and only on frames where the full sea is in view. It would read a
depth from before the sea (the copy precedes the sheet's own depth write,
`render/water.ts:337`). And it needs the cloud passes encoded on the scene's
own encoder, which is raw WebGPU. The empty split measures the most it can
save. If that is under 0.1 ms at Retina, C cannot pay for those constraints,
and ADR-0063 records it so.

**Both candidates give the trace this frame's depth with the sea in it.** Under
B the split follows the sheet, which writes depth and draws at order 0 against
the composite's 1.5. Under A, pass A holds the sheet. In both, the first half's
encoder is on the queue before `cloud depth` reads its depth attachment.

**The split's reach into three.** It uses what `SeaFrameNode` already uses:
`renderer._currentRenderContext`, `backend.get(context).encoder` and holding
`encoder.beginRenderPass` for one call. It adds one write,
`backend.get(context).encoder = next`. This is safe because `finishRender`
reads that field fresh before submitting (`WebGPUBackend.js:1188, 1278`).
Timestamps are unaffected: the pass timeline's query set is resolved on its
own encoder after the run (`passTimeline.ts:399–405`). The premise spike proves
the swap first (§11.1), and `cloudSplit.gpu.test.ts` pins all of it (§9).

### 4.3 What each candidate builds, beyond the shared system

|                                               | A, two passes                                                                                                                                                                                                         | B, the split                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New code                                      | `CloudOverPassNode`, added to the sensor's dependency sum after the scene term and before the upscaler, in both of the sensor's output branches; per-frame `scenePass.setLayers`                                      | `splitScenePass`                                                                                                                                                                                                                                                                                                          |
| Scene changes (WP11), all under the flag      | `markOverClouds` on rings, entry traces, orbit traces, plumes, flare, warp, sheath and pad dust; lights `layers.enableAll()` where CameraRig creates them; the camera's `layers.enable(OVER)` in `<Canvas onCreated>` | Under the lever only: orbit traces at `renderOrder` 1.75, the staged sky at 1.25                                                                                                                                                                                                                                          |
| Composite mesh                                | `passes`: opaque list, OVER, `renderOrder` −1e6                                                                                                                                                                       | `split`: transparent list, layer 0, `renderOrder` 1.5                                                                                                                                                                                                                                                                     |
| What ends up under the clouds that should not | Any overlay a later change forgets to mark: per object, fixable, and recorded as a rule in ADR-0063 if A wins                                                                                                         | **The entry-trace inks**: opaque instruments always draw before every transparent object, the composite must follow the transparent sea, and making the inks transparent switches on `Line2NodeMaterial`'s viewport read, which is another split (pipeline map §10.2). The defect is irreducible in B; ADR-0063 weighs it |
| CPU cost                                      | A second traversal and sort of the whole scene graph each frame (`ir.profile` measures it, and §8.7's rule counts it)                                                                                                 | One traversal                                                                                                                                                                                                                                                                                                             |
| Below three's public surface                  | No                                                                                                                                                                                                                    | Yes, the sea's class of internals plus one write                                                                                                                                                                                                                                                                          |

**The marks exist only under the flag, and the camera tests layer 1 from its
creation.** `compileAsync` drops every object whose layers the camera's do not
test (`Renderer.js:3081–3087`), and the boot's warm-ups (the flare, the
plumes, the warp, the landing effects, the rings) compile with R3F's camera.
So the camera's mask is set where the camera is created, `<Canvas onCreated>`
beside `engine.view`, and before any of those warm-ups runs; set in
CameraRig's frame callback, where every other camera write lives, it could
land after them and leave every overlay to compile on its first draw. Without
the flag nothing is marked at all, because pass B exists only with it: a mark
on `main` would buy nothing and risk the same trap.

**Pass B runs only on a frame that needs it.** With
`scenePass.setLayers(null)`, the default, the scene pass draws both layers in
one pass, as today. The rule is:
**`scenePass.setLayers(UNDER)` and `overPass.active = true` together, and only
on a frame with `on` and `placement: 'passes'`.** Every other frame keeps one
scene pass and today's pass list.

**A served body's deck yields.** When the lever serves a body that has a deck
(Earth), Bodies.tsx hides that body's deck mesh. It reads the served address from
the last frame's report, a one-frame lag that is invisible behind the volume.
Under `deck: 'hidden'` every deck hides whatever `on` is, which is how Earth's
A/B prices the deck it replaces (§8.3). Venus's deck, and Earth's whenever the
lever is off and the deck lever is `auto`, draw as today.

### 4.4 Pass names (`ir.passes`)

Every label is constant. Quads are named by `runQuadPasses` and kernels by
`setName`. Each quad is its own pass with its own timestamp pair
(`quadPass.ts:61–98`), so the counts below are what the query set holds.

| Label                                   | Kind                               | Steady (still)       | `fly`                              | `cut`               | `scrub` |
| --------------------------------------- | ---------------------------------- | -------------------- | ---------------------------------- | ------------------- | ------- |
| `cloud noise`                           | quad slices                        | warm only            |                                    |                     |         |
| `cloud maps`                            | quad (one face tile)               | 1                    | 1                                  | 1                   | 1       |
| `cloud clipmap`                         | quad strips (scissor)              | 1 (the time refresh) | up to 7                            | 3                   | 3       |
| `cloud volume`                          | quad slices                        | 0–8                  | 8                                  | 34                  | 34      |
| `cloud volume bound`                    | compute                            | 0–1                  | 1                                  | 1                   | 1       |
| `cloud sun cascade`                     | quad                               | 1                    | up to 4 (the slice and the strips) | 1 (a whole cascade) | 1       |
| `cloud sun grid`                        | quad slices                        | 4                    | up to 6                            | 32                  | 32      |
| `cloud far atlas` / `cloud far spheres` | quad (one block)                   | 1                    | 1                                  | 1                   | 1       |
| `cloud far second`                      | quad (one block)                   | 1 with a second body |                                    |                     |         |
| `cloud depth`                           | quad                               | 1                    | 1                                  | 1                   | 1       |
| `cloud trace`                           | compute                            | 1                    | 1                                  | 4                   | 4       |
| `cloud history`                         | compute                            | 1                    | 1                                  | 4                   | 4       |
| `cloud stats`                           | compute                            | with `stats`         |                                    |                     |         |
| `cloud residual`                        | compute                            | with `residual`      |                                    |                     |         |
| `scene over clouds`                     | the resumed half (B) or pass B (A) | 1                    | 1                                  | 1                   | 1       |

On top of today's roughly 27 passes a frame, a steady frame of the likely
winner (field, cascades, atlas) adds 8, the volume and grid arm 20, and a
`cut` or `scrub` frame of the volume and grid arm about 82. So `ir.passes(n)`
cannot take a fixed `n`: the runner counts the frame's passes with a one-frame
read first and takes `n = floor(2000 / passes)`, capped at 40, so 2,048 passes
are never reached (40 frames on the winner's steady frame, 18 on a cut of the
heaviest arm), and it refuses any read with `dropped > 0` (§8.3). `summarize` divides by the
frames asked for, so a read that dropped passes would report every label low.

### 4.5 Compile-ahead (rule 61)

`CloudSystem.warm()` awaits all of these. It is registered by Sensor.tsx as
`warmAtMount({ label: 'warming the clouds', units: 4, run })`, and only when
the flag built a system.

| Pipelines                                                                                                         | Recipe                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Noise and curl slices, maps, clipmap, volume slices, cascades, grid, far atlas, spheres, second atlas, depth copy | `warmSensorPass(renderer, quad, [{ target, material }, …])` against each pass's own target (a 1 × 1 stand-in of the real format). MRT passes put `mrt({ … })` in the quad's `fragmentNode`, so `warmSensorPass`'s MRT `null` is also the frame's. The depth copy is warmed against the scene target's real depth texture, tied as `SeaFrameNode.#tie` ties its copy, so the multisampled binding layout matches |
| Eight trace kernels and the sweep kernel, four history kernels, the bound, stats, residual                        | `warmCompute(renderer, kernels)` (§3.18)                                                                                                                                                                                                                                                                                                                                                                        |
| Both composite meshes                                                                                             | `warmCompile(warmRenderer(renderer, layout), { object, camera, scene })` for each, with `frustumCulled = false`. `CloudFrameNode.updateBefore` is inert outside a frame, so warming runs no cloud work                                                                                                                                                                                                          |
| The noise bake itself                                                                                             | Drawn once inside `warm()` after its pipelines exist, so the first frame reads baked noise                                                                                                                                                                                                                                                                                                                      |

`cloudWarm.gpu.test.ts` holds the census. After `warm()`, the first frame of
every lever set the decision batch uses builds no pipeline: both
`gpu.pipelinesBuilt()` and `gpu.computePipelinesBuilt()` are unchanged across
it. Three compiles a compute pipeline synchronously at its first dispatch
(`WebGPUPipelineUtils.js:417`), so a census of render pipelines alone would
pass with every kernel compiling in the first frame.

### 4.6 WebGL

The sensor builds no cloud system when `!('isWebGPUBackend' in renderer.backend)`.
That is `automaticAvailable`'s test (`sensor.ts:149`). With the flag on WebGL,
the report is `{ available: false, reason: 'webgl', on: false, … }`. It says so
as `SensorDiagnostics.automaticAvailable` declares Manual standing in for
Automatic. Nothing in phase 0 adds a GLSL path. Phase 1 gives WebGL the far
march in the sphere material.

### 4.7 Off by default

| State                                                | What exists                                                                                                                                                | What is drawn                                                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| No `?clouds=1` (every plate, compare and ledger run) | Nothing. `createSensor` is called without `{ clouds }`. No layer mark, no light mask and no camera mask is applied                                         | As today, pixel for pixel                                                                                                                        |
| Flag, `on: false`                                    | The system, its pipelines warmed, 1 × 1 stand-ins; the overlays on layer 1, the camera testing layers 0 and 1 from its creation, the lights on every layer | As today: no split, no pass B, no cloud pass. The post program has one more `+ 0` term and no new binding (`overPass.setup()` returns `vec4(0)`) |
| Flag, `on: true`                                     | Targets at real size for the selected candidates                                                                                                           | §4.2                                                                                                                                             |

`cloudSensor.gpu.test.ts` holds the second row against a chain built without
the option. It checks the pass labels (skipped without `timestamp-query`),
`info.calls` a frame, both pipeline counters over three frames after warming,
the frame's pixels read back equal, and that every overlay's warm-up builds its
pipelines at boot with the marks applied.

---

## 5. Physics and math

### 5.1 Frames and units

- **The trace and the far march** work in true meters, eye-relative, in the
  served body's **body-fixed** axes. A ray direction is
  `d = toBodyFixed · (forward + right·x·plane.x + up·y·plane.y)`, with the
  camera basis rotated on the CPU in float64 and `(x, y) ∈ [−1, 1]`, y up.
  The trace's texel row 0 is the top of the image. So `y = 1 − 2·(row + ½ + jy)/H`,
  and every reader agrees on it through `traceScreen()` and `screenTexel()` in
  `cloudGeometry.ts`. That avoids the QuadMesh flip trap
  (temporal map §12.4), because compute has no quad, and the depth copy's own
  rows are pinned by a test that draws a depth step (§9).
- **Scene distance** comes from the depth copy as view distance along the ray
  in render meters ÷ 1000, stored R16F and clamped at 60,000 km. Far depth
  stores the clamp, so it reads as sky. A half float steps by 2⁻¹¹ to 2⁻¹⁰ of
  its value, so every comparison against it carries a relative tolerance of at
  least 2 × 10⁻³ (§5.11). True meters are render meters ÷ `compression`. The
  served body is near the eye, so compression is 1 to rounding, but the
  division keeps a distant served body (from its moon) right.
- **The composite** draws as a scene object, with the scene camera's
  (jittered) nodes. It rebuilds the view ray from `screenUV` and
  `cameraProjectionMatrixInverse`, rotates it to body-fixed by
  `toBodyFixed · cameraWorldMatrix`, and forms everything else in the same
  axes as the trace.
- **The air** is in sea-level units about the center: eye = `eye/R`,
  t → t/R. These are the units `marchAir` takes, and they are rotation-invariant.
  The ground's and the sea's axes are body-fixed too.
- **Light** is per unit sun irradiance, before `dayColor` and π, as
  `marchAir`'s `inscatter` is. The composite multiplies by
  `dayColor·ATMOSPHERE_GAIN`, and its material's `sensorRadiance` multiplies by
  `sceneRadianceGain`, once, exactly as the shell's does. Clouds and air are
  therefore in one scene unit by construction (§7).

### 5.2 Shell crossings from heights (rule 52)

The eye sits at r_e = R + h_e and the ray has up-cosine μ. A boundary sits at
r_s = R + h_s. Then `r(t)² = r_e² + 2 r_e μ t + t²`, and the boundary is met
where `t² + 2bt + c = 0`, with

```
b = r_e·μ                                   r_e = R + h_e, in float32 (relative error only)
c = r_e² − r_s² = Δh·(2R + h_e + h_s)       Δh = h_e − h_s, formed on the CPU in float64 (eyeOver)
D = b² − c
q = −(b + σ·√max(D, 0)),  σ = select(−1, 1, b ≥ 0)    stable quadratic: no −b + √D cancellation
t_a = q,  t_b = q ≠ 0 ? c / q : 0                      sorted; none when D < 0
```

There is no radius subtracted anywhere. WGSL's `sign(0)` is 0, so the sign is
a `select`: with `sign`, an exactly level ray (μ = 0, b = 0) would give q = 0
and `t_b = c/0`, and a level camera (`inside` at pitch 0) can produce one. q is
0 only when b = 0 and D = 0, that is c = 0: a level ray from an eye on a
boundary, whose two crossings are both 0. A grazing ray has `D → 0`, and the
crossing's error is then `√(ulp(b²)) ≈ 0.5 km` at 400 km over Earth. That is
sub-pixel at the 2,000 km limb. An eye on a boundary has `Δh = 0`, so `c = 0`
and `t_b = 0` exactly. `weatherShells.ts` takes the same sign and the same
guard, so the CPU reference and the shader agree on the cases they are tested
at.

A ray from an eye-relative origin `o₀` along `d̂` (the cascade and grid
bakes' sun rays) has the same form with
`b = r_e(up·d̂) + o₀·d̂` and `c = c₀ + 2r_e(up·o₀) + o₀·o₀`, `c₀` the boundary's
`Δh·(2R + h_e + h_s)` (`shellCrossingFrom`, §3.5b).

`unionSpan` takes the lowest base's and the highest top's crossings and clips
them to `[0, min(stop, t at which the ray meets the ground)]` as the shell
does. An eye inside the union starts at 0. A ray leaving the union through its
top and grazing back in is held to the first interval in phase 0, which is
declared. The far march handles both intervals (§5.13).

### 5.3 Altitude along a ray, and at a point

```
h(t) = (h_e·(2R + h_e) + 2·r_e·μ·t + t²) / (r(t) + R),   r(t) = √(r_e² + 2 r_e μ t + t²)
h(o) = (h_e·(2R + h_e) + 2·r_e·(up·o) + o·o) / (r(o) + R),   r(o) = √(r_e² + 2 r_e (up·o) + o·o)
```

The second is the first with μ·t replaced by `up·o` and t² by `o·o`, so it
serves every eye-relative point: the light taps, the cascade and grid bakes,
the volume bake. `h_e·(2R + h_e)` is formed on the CPU in float64 (the body's
`eyeTerm`).

The numerator's middle term reaches about 1.3 × 10¹³ m² for Earth from
400 km toward the limb, where float32 resolves about 10⁶ m², so the error after
dividing by about 2R is about a decimeter. That was emulated with `Math.fround`
at every operation over 2 × 10⁶ samples (§0.3): 0.123 m for Earth from 400 km
with h(t) ∈ [0, 20] km, 0.088 m with h(t) ∈ [−1, 20] km over the whole domain
below, and 0.764 m worst over the whole domain, where h(t) reaches −1,600 km
and its relative error is 5 × 10⁻⁷. The bound is therefore stated where it
matters: **|Δh| ≤ 0.25 m for h(t) within [−1, 20] km of the datum, and
|Δh| ≤ 10⁻⁶·(R + t) elsewhere.** A quarter meter decides `base ≤ h < top`
for every layer, the thinnest being fog's 150 m. `weatherShells.test.ts` holds
that bound as a property of the formula itself (fast-check, every operation
through `Math.fround`, R from 10⁵ to 10⁸ m, h_e from −10⁴ to 4 × 10⁵ m, μ ∈
[−1, 1], t up to 3 × 10⁶ m). That is a property of the arithmetic, beside the
GPU test, not instead of it. `cloudGeometry.gpu.test.ts` holds the TSL port to
the same bound against exact float64 values computed in the test, and against
`weatherShells`, which lands before it (§11).

The sun's cosine over the sample's horizontal is
`μ_s(t) = (r_e·μ_sun,e + t·dot(d, ŝ)) / r(t)` along a ray, and
`(r_e·μ_sun,e + o·ŝ)/r(o)` at a point, with `μ_sun,e = dot(up_e, ŝ)`. It is
formed from heights, not from `normalize(eye + offset)`.

### 5.4 Time and lattices (rule 58, plan §3)

- **No absolute position enters a lattice.**
  - Noise reads `(noiseOrigin + offset + drift) / (cell·CLOUD_BASE_CELLS)` in
    base-cell units. `noiseOrigin = reducePoint(eye, P)` is formed in float64,
    with `P = cell·CLOUD_BASE_CELLS`.
  - The detail noise reads the same way with its own period.
  - A clipmap or volume texel comes from the eye's plane coordinates (float64)
    plus Δu, formed from the offset and the level's float64 `along` terms
    (§3.9), never from a normalized absolute direction.
- **No absolute time enters the shader.**
  - `drift = driftOffset(wind, time, P)`, which is
    `(wind·reduceSeconds(time, 3600)) mod P` in float64. The displacement is
    bounded by |wind|·1 h, about 36 km at 10 m/s.
  - The field resets its drift every hour of presentation time. The jump is
    placeholder behavior and is declared: Neyret's three phases (plan §4.5)
    are phase 4's. `cloudFrame` counts the wrap as a jump (§3.3), so the
    history resets there instead of smearing 36 km of motion over sixteen
    frames, and the caches rebuild.
  - The history moves the cloud by `wind·frameSeconds`, the field's own Δt
    (`time − previous.time`), so under warp the reprojection follows the drift
    the field actually took, not the wall clock's.
  - Blobs exist where `pcg4d(cell, periodIndex(time, patternPeriod))` falls
    under a u32 threshold the CPU computes. The cell is a face-grid index with
    16 texels a cell (an integer decision at a texel center), and the period
    index's two halves are uploaded as uints.
- **At the time limit (3.2 × 10¹² s)**, float64's ulp is 4.9 × 10⁻⁴ s, so the
  reduced times are exact to under a millisecond. `weatherClock.test.ts` sweeps
  them up to that limit.

### 5.5 The march (`cloudMarch.ts`)

```
ray: d, μ, ν = dot(d, ŝ); [t₀, t₁] = unionSpan(shells, μ, D_true(texel)); none → write the empty result
sky = skyClass(D_true(texel))                                      // §5.11: the class B is accumulated with
t_far = clamp(farFootprint / pixelAngle, t₀, t₁)                  // the handover, by footprint (never altitude)
ξ = traceJitter(pixel, frame).x;  Δ = 50 m;  t = t₀ + ξ·Δ
T_cl = 1;  L_c = 0;  B = 0;  air: T_a = 1, L_a = 0;  seg = OPEN;  steps = 0
loop while t < min(t₁, t_far) and steps < maxSteps:
    if T_cl·((1 − seg.c) + seg.c·seg.through) < 0.01: break                         // early exit at 1 %
    s = sample(t): altitude h(t) §5.3, offset t·d, sunMu §5.3, footprint = pixelAngle·t
    m = medium(s)                                                    // field or volume (§5.6); the volume skips to the brick's exit
    if seg open and (m.layer ≠ seg.layer or horizontal(t − seg.start) > seg.column): close(seg)   // §5.7
    if m.layer ≥ 0 and seg closed: open(seg, m.layer, t, m.column)
    Δ_out = min(1000, max(50, Δ·1.01));  Δ_in = clamp(0.3 / max(m.σ, 1e-9), 3 + 0.00375·t, Δ_out)
    Δ = m.σ > 0 ? Δ_in : Δ_out
    if seg open and m.σ > 0: step(seg, m, s, Δ)                     // §5.7–5.10: light taps only inside cloud
    if steps % 8 == 0 or a segment closed: air(s, accumulated length, sky)  // §5.11: the air on a coarse schedule
    t += Δ;  steps += 1
close(seg)
far = t < t₁ ? farMarch(ray, from = t, body, sky) : none            // §5.13, from where the fine march stopped
compose: L_c += T_a·T_cl·far.light;  B += T_a·T_cl·far.air;  T_cl *= far.transmittance
```

- **Steps** follow the plan: 50 m, growing 1% a step to 1 km, out of cloud.
  Inside cloud the step is held to an optical depth of 0.3 a step and floored
  at 3 m + 60 m per 16 km (Nubis Evolved's near-eye resolution).
  - The 0.3 bound is phase 0's addition. A fixed 3 m + 60 m/16 km step crosses
    a 1 km cirrus at grazing incidence in thousands of steps. Bounding τ a step
    keeps dense cloud fine and thin cloud cheap.
  - Out of cloud, the plan's growth covers about 13 km in 128 steps and 95 km
    in 302. A ray whose budget runs out before `t_far` hands its remainder to
    the far march, so no ray is cut short.
  - `stats.exhausted` counts those rays, and the far-field comparison scores
    that handover as well as the footprint's (§8.6).
- **Early exit** is at a total transmittance under 1%, counting the open
  segment's estimate.
- **Jitter** applies to the first step only. `traceJitter` is IGN of the trace
  pixel plus `frame·0.618034` (R1), mod 1. `.y` jitters the ray within its
  history pixel (§5.14).
- **The sweep is a different march** (`cloudSweepMarch`), because constant work
  cannot come out of this loop: under any step count it still stops at t₁, its
  in-cloud step adapts to σ, and every in-cloud step reads the sun's depth and
  the air. The sweep's loop is §8.4's.

### 5.6 The medium: placeholder density (`cloudDensity.ts`, CPU reference in `weatherScenario`)

At a sample with altitude h:

```
k     = the layer with base_k ≤ h < top_k (unrolled over three; −1 if none);  h01 = (h − base_k)/(top_k − base_k)
c3    = clipmap.coverage(s)                                   read 1 (2 in a level's fade band)
p     = profile(genus_k, h01)                                 read 2
n_b   = noise.base(cells(s))                                  read 3
n_d   = noise.detail(cells_d(s))·erosion_k·fade_d            read 4, skipped when fade_d = 0
curl  = noise.curl(…) displaces cells(s) by up to ¼ cell     once a segment, at its open
d     = saturate(remap(n_b·p, 1 − c_k, 1, 0, 1));  d = saturate(remap(d, n_d, 1, 0, 1))
σ_res = σ_k·d
f     = smoothstep(cell_k/4, cell_k, footprint)              // unresolved share: the cell under a texel
fraction = mix(1, c_k, f);   σ_in = mix(σ_res, σ_k·p̄_k, f)   // never a mean density (plan §3)
column   = clipmap.columnMeters(s)                            // the texel the coverage stands for
```

`remap(x, a, b, c, e) = c + (x − a)(e − c)/(b − a)`. Here `p̄_k` is the
profile's mean over the layer and `fade_d = 1 − smoothstep(cell_k/16, cell_k/4, footprint)`.
A step makes the plan's four reads (§5.2: the maps, the profile and two
noises); the curl that tears the edges is read once a segment, when it opens,
and displaces that segment's cells. The sweep's reads are §8.4's, not these.

The CPU reference evaluates the same expression with `weatherNoise`, so
`cloudDensity.gpu.test.ts` can hold the node to it at sampled points.

Volume mode replaces the reads with one read a step:
`σ = R²·σ_scale, fraction = G`. Erosion `n_d` comes in where the footprint is
finer than the level's texel. Before reading, the march checks `bound(s)`, the
brick's maximum dilated by one texel (§3.11). Zero advances t to
`brickExit(s)`, where the ray leaves the brick, and starts the next step there;
the empty step is not a segment step and adds no light.

### 5.7 Segment bookkeeping: maximum-random overlap (plan §3)

A **segment** is one layer's crossing of one column. It opens when a sample
enters a layer and closes when any of these happen:

- the sample's layer changes;
- the horizontal travel since it opened exceeds the column (the coverage
  texel's size);
- the march ends.

```
open(seg, k, t, column):  seg = { layer k, start t, column, c: 0, τ: 0, through: 1, light: 0, lightRadius: 0, sky: 0 }
step(seg, m, s, Δ):
    τ_s = m.σ·Δ;   e = exp(−τ_s);   share = (1 − e)                         // = τ_s·stepShare(τ_s), series under 0.01
    sun = sunFn(s, m)                                                        // §5.9
    J₁  = sun.cloud·sun.air                                                  // first order, no phase (§5.10)
    seg.light       += seg.through·J₁·share                                  // the step's integral (§5.8)
    seg.lightRadius += seg.through·J₁·share·m.radius                         // for the mean radius at the end
    seg.sky         += seg.through·share·Ψ_s·0.5                             // the placeholder sky term (§5.10)
    seg.through *= e;   seg.τ += τ_s;   seg.c = max(seg.c, m.fraction)
close(seg):
    T_seg   = (1 − seg.c) + seg.c·seg.through                                // one mix a segment
    A₁   += T_a·T_cl·seg.c·seg.light                                        // phase-free first order, span-relative
    R₁   += T_a·T_cl·seg.c·seg.lightRadius                                  // radius-weighted, for r̄
    A_s  += T_a·T_cl·seg.c·seg.sky                                          // isotropic
    r̄    = A₁ > 0 ? R₁/A₁ : r_k                                             // the layer's radius where no lit cloud was met
    knots.record(seg.start, t, T_cl·T_seg, P₁(ν, r̄)·A₁ + A_s/(4π))          // one phase fetch a knot, ≤ 4 a ray (§5.12)
    T_cl *= T_seg;   seg = OPEN
end of ray:  L_c = P₁(ν, r̄)·A₁ + A_s/(4π)                                   // the shortcut: one fetch a class (§5.10)
```

`r̄`'s guard matters on a ray that meets cloud nowhere the sun lights it:
there `R₁ = A₁ = 0`, the quotient is 0/0, and a NaN radius reads the phase
table at a NaN coordinate, whose product with `A₁ = 0` is NaN, not 0.

`B`, the blocked air, is not accumulated here. It is accumulated on the air's
coarse schedule against the running `T_cl` (§5.11), so a segment's close only
changes the factor later air samples see.

`cloudOverlap.ts` is the scalar reference.

- **Properties** (`cloudOverlap.test.ts`, fast-check):
  - (a) splitting every step of a segment into k steps leaves `T_seg` and its
    light unchanged to 1e-12 relative, for constant σ and source;
  - (b) `T_seg ∈ [e^(−τ), 1]`;
  - (c) `c = 1` gives Beer's law;
  - (d) the plan's example: a half-clear layer at τ 20, crossed in two steps,
    gives 0.5 and not 0.25;
  - (e) two segments of the same column multiply (random overlap between
    segments).
- **GPU** (`cloudTrace.gpu.test.ts`): the same five on the real kernel with
  injected slabs, to 1e-4 relative. A deliberately per-step-mixed variant
  built in the test fails (d), so the test can be seen to bite.

### 5.8 The step-integral light term

A step of constant extinction σ and constant source J over length ℓ adds
`∫₀ℓ T(s)·σ·J ds = T₀·J·(1 − e^(−σℓ))` to the light. That is the plan's
`(1 − e^(−σΔ))/σ` times σ, the integral the air already takes (ADR-0056). It
telescopes exactly when a step is split: `(1 − e^(−τ₁)) + e^(−τ₁)(1 − e^(−τ₂)) = 1 − e^(−(τ₁+τ₂))`.

Under τ = 0.01 the subtraction cancels in float32, so the term is computed as
`τ·stepShare(τ)` with air.ts's series. The constant-source assumption is the
step's one approximation. The step bound of τ ≤ 0.3 in cloud keeps its error
small, and phase 1's step-convergence reference measures it.

### 5.9 Light taps, the sun's optical depth, and the air

From a cloud sample at altitude h with sun cosine μ_s:

```
taps      = LIGHT_TAPS[lightTaps]                          // (midpoint, width) pairs over the first 1,000 m
for (m_j, w_j): p_j = offset + m_j·ŝ;  h_j = altitudeAt(p_j) (§5.3);  m = medium(p_j)
              tapSeg: c = max(c, m.fraction);  τ += m.σ·w_j                 // the taps are one segment: one column
T_taps    = (1 − c) + c·e^(−τ)
τ_beyond  = sunDepth.opticalDepth(offset + 1000·ŝ)          // cascades: exp form of §3.12; grid: trilinear τ
T_cloud   = T_taps·e^(−τ_beyond)
air       = sunThroughAt(air, h/(R·(top − 1)), μ_s, cleared, { level: true })
```

`sunThroughAt` is the beam `sunThrough` gives the ground, the sea and the sphere
(`air.ts:784`), formed from a CPU-resolved height. That includes Enhanced's
clearing from orbit. A cloud and the ground beside it therefore see one beam
(rule 59's spirit; phase 2 adds the cloud term to the surfaces).

The taps cost `lightTaps` medium evaluations an in-cloud step, plus one
sun-depth read and two air-table reads. That is the cost the cache choice moves
most: four reads a tap through the field against one through the volume.

**The reference for `cloudSunAccuracy.gpu.test.ts`** (WP12, on the real
field): a 256-step march of the field from the sample to the union's top along
ŝ, mixed with the same segment rule. It scores `T_cloud`'s RMS and worst error,
relative, at the in-cloud samples of five scenarios, each at two suns:
`fair-cumulus`, `two-decks` (one deck shading another), `anvil` (the deep
union), `overcast` (a uniform deck) and `cirrus-over-cumulus` (a thin layer
over a dense one), at 37.5° and at 5°.

### 5.10 The phase shortcut, and what phase 0 draws beyond first order

**First order.** The phase depends on ν, which is fixed along a ray, so the
loop accumulates first-order light **without** its phase, weighted by the radius
(`lightRadius`). At the ray's end, `P₁ = phase.droplets(ν, r̄)` with
`r̄ = Σ lightRadius / Σ light` is fetched once (plan §5.3's shortcut).

One RGBA16F read a ray of the uploaded Mie table: RGB is three bands. Phase 0
uploads the unconvolved table, whose fetch costs what a convolved one does. The
disk convolution and its per-body upload are phase 1's, with the table's first
consumer of the light.

**Higher orders are not drawn in phase 0.** Plan §5.3 makes them a measured
choice between octaves fitted to the slab reference and the slab's own table,
and the two cost differently: an octave is arithmetic on a texture-bound
march, a slab table is one more read a step. Phase 0 cannot measure the choice
before phase 1 makes it, so it draws neither and claims nothing about their
light; phase 1 measures the one it picks.

**The sky's light on the cloud** is a placeholder: the air's Ψ at the sample
(`Ψ_s`, read on the coarse air schedule, which already reads Ψ) × σ_s × 0.5,
isotropic. Phase 1 replaces it with the irradiance table.

### 5.11 The air inside the span, and the composite's identity

**The class, which both sides decide.** A pixel's scene carries one of two airs:
the shell's, where the shell's fragment survived the depth test, or a
surface's own (`airToward`), where something in front of the shell's far wall
killed it. The shell's mesh is a back-side sphere at the air's outer wall, so
its fragment survives exactly where the scene's depth lies at or past that
wall. The class is that test, in sea-level units:

```
F_out = closest + halfOuter                      // the outer wall's far crossing, as materials.ts:344–365 forms it
sky   = D ≥ F_out·(1 − 2×10⁻³)  or  D at the depth copy's clamp
```

It never uses the shell's ground branch (`closest − halfInner`, the analytic
sunk sphere). The drawn sphere is a `SphereGeometry(1, 512, 256)` whose facets
are inscribed, up to about 120 m inside the analytic sphere on Earth (240 m
across a facet's diagonal), so its depth lies behind the analytic one; tested
against that branch at 10⁻⁴ with a depth stored at 2⁻¹¹ to 2⁻¹⁰ relative, every
sphere pixel seen from orbit would read as sky, speckled where rounding
crossed back, and the two classes would differ in T' and in the beam pixel by
pixel across the whole disk. The tolerance is twice the half float's coarser
step; the shell's own mesh, tessellated too, lies inside its analytic wall by
far less than that at the distances a far wall stands.

The **trace classifies its own texel** by the same test, at its ray's depth,
and accumulates `B` with that class's beam. The composite classifies each
pixel. They disagree only where a trace texel straddles the boundary (the limb,
chiefly), and the residual meter counts those texels (§3.16).

**Trace side.** Along the span, the trace integrates the air-only light
`L_a(t₀,·)` and transmittance `T_a(t₀,·)`. It uses `airMediumAt` every eighth
step and at each segment close, with the constant-medium step integral over the
accumulated length, so the air costs two table reads every eight steps.

It accumulates the **blocked air**,
`B = Σ (T_cl(s) − 1)·T_a(t₀,s)·dL_a(s)`. That is the air light behind cloud
that the cloud hides, and it is ≤ 0. `T_cl(s)` is the closed segments'
transmittance, times the open segment's current mix `(1 − c) + c·through`.
**`dL_a` takes the class's beam**, the one the composite's own `L_a` is built
with: the table's unclear beam for a sky texel (the shell marches with no
`clearBeam`, `materials.ts:367–375`), and `clearedBeam` at
`cleared·ORBIT_AIRLIGHT` for a surface texel (`airToward`, `air.ts:737`). It is
not the cloud's own beam, `sunThroughAt` at full `cleared` (§5.9), which
matches neither: under Enhanced from orbit the two differ by about 10% under a
high sun and by more than 100% near the terminator, where `clearedBeam`'s 0.3
floor binds, and the difference would be a bias over every cloud that none of
the residuals below names.

The trace outputs `L_c` (the cloud's own light, relative to t₀ and attenuated
by the air in front of it inside the span), `B` and `T_c`.

**Composite side.** The scene holds `scene = L_a(0,D) + T_a(0,D)·S`. The
correct picture with a cloud inside `[t₀, t₁]` is

```
L_a(0,t₀) + T_a(0,t₀)·[L_j + T_j·(L_a(t₁,D) + T_a(t₁,D)·S)],   T_j = T_a(t₀,t₁)·T_c,   L_j = L_air(t₀,t₁) + L_c + B
```

Since `T_a(0,t₁)·[L_a(t₁,D) + T_a(t₁,D)·S] = scene − L_a(0,t₁)` and
`L_a(0,t₁) = L_a(0,t₀) + T_a(0,t₀)·L_air(t₀,t₁)`:

```
identity:  out = T_c·scene + (1 − T_c)·L_a(0,t₁) + T'_a(0,t₀)·L_c + T_a(0,t₀)·B
thin:      out = T_c·scene + (1 − T_c)·L_a(0,d₁) + T'_a(0,t₀)·L_c                 d₁ = d_reproj
```

`T'_a` dims the cloud's own light as a surface's is dimmed there (it is
`T_a` for sky pixels, `mix(T_a, 1, cleared)` for surface pixels). `B` takes the
physical `T_a`, because the air it cancels was accumulated through the physical
throughput in the scene's own march: an opaque cloud at t₀ then gives
`L_a(0,t₀) + T'_a·L_c` exactly, where `T'_a·B` would subtract
`(T'_a − T_a)·L_air(t₀,t₁)` more air than the scene ever drew.

Both are premultiplied over the scene: `src.a = 1 − T_c`. Three properties
follow.

- **No cloud, no change.** With no cloud, `T_c = 1` and `L_c = B = 0`, so
  `src = 0` and `out = scene` exactly, whatever the air's quadrature and
  whatever the exposure. The band-around-every-cloud failure of plan §6.3
  cannot arise from the identity.
- **The thin form is the identity's thin limit.** For one thin layer at d₁,
  `B = −(1 − T_c)·T_a(t₀,d₁)·L_a(d₁,t₁)`, and the two forms agree to rounding.
  They differ by `(1 − T_c)·[L_a(0,t₁) − L_a(0,d₁)] + T_a(0,t₀)·B`, the
  residual meter's first histogram, wherever cloud spreads along the span.
- **Where the identity is inexact:**
  - (i) The composite's `L_a(0,t₁)` is built from its own two segments, while
    the scene's air came from one march over `[entry, end]`, and the trace's
    `B` from its own coarse schedule. The residual is
    `T_c·{L_scene(0,end) − L_a(0,t₁) − T_a(0,t₁)·L_a(t₁,end)} + T_c·{T_scene − T_a(0,t₁)·T_a(t₁,end)}·S`,
    plus the difference between `−B` and the composite's `L_air(t₀,t₁)` over
    the blocked share.
  - (ii) Under Enhanced from orbit, surfaces dim S by the cleared
    `mix(T, 1, cleared)`, which does not compose over segments.
  - (iii) The ring Enhanced draws at sky pixels is dimmed by `T_c` even in
    front of a cloud.
  - The residual meter measures (i) and (ii) on the scene as built. (iii) is
    reported separately at the limb (§8.6).

**The air a pixel carries** (`compositeAir`).

| Class   | Test                                        | The scene's own air                                                                                         | The composite's split                                                      | Clearing                                                                                                            |
| ------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Sky     | `D ≥ F_out·(1 − 2×10⁻³)`, or D at the clamp | The shell: 12 crowded samples over `[near, far]`, no `clearBeam`, background dimmed by gray T̄               | `[near, t₀]` and `[t₀, t₁]`, 6 crowded samples each, no `clearBeam`        | `T'_a = T_a` (physical)                                                                                             |
| Surface | otherwise                                   | The sphere, ground or sea: `airToward`, 4 samples over `[entry, end]`, `clearBeam = cleared·ORBIT_AIRLIGHT` | `[entry, t₀]` and `[t₀, t₁]`, 4 crowded samples each, the same `clearBeam` | `T'_a = mix(T_a, 1, cleared)` (plan §5.6: the air in front of a cloud takes `clearedFromOrbit` as a surface's does) |

Both classes' marches are built from `airMediumAt` with `{ level: true }` over
`crowdedSamples` (§3.6): the class is chosen per pixel, so the marches sit in
non-uniform control flow, and a fragment read there must name its level.
`cloudCompositeAir.gpu.test.ts` holds each split march to `marchAir` over the
same segment, in uniform control flow, to 10⁻⁵ relative.

Known gaps, measured and not hidden:

- A sphere fragment's air ends on the datum under it, not at its sunk mesh's
  depth. That matters only below t₁, which from orbit is always above the datum.
- A hull carries no air of its own, so a hull seen through thin cloud far off
  takes a residual of `T_c·L_a(0,t₁)`.
- The shell's gray T̄ is not the product of its segments' means.

All three appear in the residual histograms. None is corrected in phase 0.

**Terrain in front of part of the cloud.** Where the full-resolution D falls
inside the cloud's depth range and no history texel's `d_end` matches it, the
share of the cloud in front of D is
`Φ = Φ_N((D − d_reproj)/max(deviation, 1 m))`, from the depth moments, the mean
and the deviation of the opacity-weighted depth (plan §5.4, Ghost of Yōtei's
form). `Φ_N` is the normal CDF, approximated by `0.5·(1 + tanh(1.2·x))`.
**Φ weights the whole cloud term**, not the transmittance alone:

```
src.rgb = Φ·[(1 − T_c)·L_a(0, min(t₁, D)) + T'_a(0,t₀)·L_c + T_a(0,t₀)·B],   src.a = Φ·(1 − T_c)
```

and Φ = 1 where a texel matched. Replacing only `T_c` by
`1 − (1 − T_c)·Φ` would leave `L_c` and `B` whole, so a ridge in front of the
cloud's depth (Φ → 0) would wear the cloud's light: every silhouette in front
of distant cloud, which is the `horizon` scenario at pitch +2°. The residual
meter cannot see that defect, because it runs with the composite inert, so
`cloudComposite.gpu.test.ts` holds it directly: a near opaque quad in front of
a far slab reads back as the quad alone.

### 5.12 Knots, and what a transparent object sees

**Recording.** A knot is recorded at each segment close whose `T_seg` is below
0.98. It holds (entry depth, exit depth, `T_cl` after the close, `L_c` so far
with the phase of the radius so far applied). With more than four, the fourth
knot absorbs the rest: its entry stays, and its exit, T and L take the latest.
Knots with T = 1 pad the set. The knots are written through `finiteOr`, since
`cloudFront` reads them directly and no history stands between.

**`cloudFront(screen, distance)`.** It reads the trace texel nearest the
object's pixel (knots are not reprojected; they are this frame's, and in the
immediate regime the last phase's, at the same extent) and finds the knot
interval holding `distance`:

- before a knot's entry: the previous knot's (T, L), flat across a clear gap;
- inside [entry, exit]: linear between the previous knot's and this knot's
  (T, L), the in-cloud attenuation of an object inside a layer.

It returns span-relative quantities. The air in front of t₀ is the object's own
material's business, and phase 0 ignores it (declared).

**The consumers.**

- An **additive** object multiplies its light by `transmittance`.
- An **alpha-blended** object replaces its color with
  `transmittance·color + light` and keeps its alpha. Then a blend of
  `α·(T·color + L) + (1 − α)·frame` is correct over a frame that already holds
  the cloud's light: the object is lit under the cloud in front of it and not
  darkened (plan §5.6).

`cloudFront.gpu.test.ts` is the plan's "transparent object between two cloud
layers", in two configurations:

- **lit in front, dark behind:** the near slab's per-layer light scale is 1,
  the far's 0;
- **the reverse.**

Each case places an additive and an alpha object between the slabs and holds
the result to the analytic two-slab value within 2%. It also asserts that the
two configurations differ by the analytic light difference, which a
transmittance-only curve would score as zero.

### 5.13 The far march (`cloudFar*.ts`)

The far march starts from `from`, the fine march's stop, and runs to t₁.

**Atlas.**

1. Intersect the ray with each layer's [base_k − 500, top_k + 500] shells
   (§5.2). That gives up to two intervals a layer, six in all, disjoint and
   processed in t order.
2. Step each interval one atlas texel a step, at most `FAR_STEPS_A_LAYER`.
3. At each step, read texel (c, τ_in, base, top) at the step's direction (one
   level-0 read in the face tile). The in-cloud path within this column's
   refined [base, top] is ℓ, and `τ_s = (τ_in/(top − base))·ℓ`.
4. **Each step is one segment** (one column):
   `T_seg = (1 − c) + c·e^(−τ_s)`, and the light is `c·J·(1 − e^(−τ_s))`, with
   `J = T_sun·P₁`.
5. `T_sun` is the product, over the layers above k along the sun, of
   `(1 − c_j) + c_j·e^(−τ_j/μ_s)` (one read each, at the sun ray's crossing
   column), times half the own layer's `e^(−τ_k/(2μ_s))`, times
   `sunThroughAt`.
6. Blocked air: this step's air light, from the coarse air schedule and with
   the texel's class's beam, × (T_seg − 1).
7. Depth moments accumulate as `w = T_before·(1 − T_seg)`, `m₁ += w·t_mid` and
   `m₂ += w·t_mid²`. The deviation is `√max(m₂/Σw − (m₁/Σw)², 0)`.

**Spheres.** At each layer's mid-height sphere, find the crossings (at most
two), read (c, τ_col, T_sun) and take `T = (1 − c) + c·e^(−τ_col/|μ_k|)`, with
μ_k the ray's cosine to the vertical at the crossing. The light is
`c·T_sun·P₁·(1 − e^(−τ_col/|μ_k|))`; the blocked air and the depth moments are
the atlas's.

There is no column mixing along a grazing chord. That loss is exactly what the
"grazing ray at sunset" case scores.

**Levels** is not built (§1.3).

### 5.14 The history (`cloudHistory.ts`)

- **The interleave is stride 2 in Bayer order**:
  (0,0), (1,1), (1,0), (0,1), `phase = order[frameIndex mod 4]`.
  - Trace texel (i, j) traces history pixel `(2i + φx, 2j + φy)` at a point
    jittered within it by `traceJitter(…).y`'s pair. Each history pixel takes a
    fresh sample every fourth frame (plan §5.5).
- **The immediate regime** traces every history pixel in one frame, at the
  converging frame's ray budget, through the trace's own textures: four
  dispatches at the trace's extent, k = 0…3 in Bayer order, each at
  `maxSteps/4` with `phase = order[k]`, and after each the history's immediate
  kernel writes phase k's pixels of the newest parity from the trace, at age 0.
  After the fourth, the parity holds this frame's image whole. Every store is
  inside its texture, the trace's textures keep their size, and the knots hold
  the last phase's, at the extent `cloudFront` always reads. A single dispatch
  at the history's extent into textures sized at the trace's would store three
  quarters of its texels out of bounds, which WGSL leaves to the
  implementation; sizing the trace at the history's extent instead costs
  28.0 MB at 1080p, and one kernel writing the history and the knots together
  needs five storage textures where the stage allows four.
- **Reprojection** (body-fixed):
  1. `X = d_cur·d_reproj` (the eye-relative point now).
  2. `X_prev = X + translation − wind·frameSeconds`: the eye's motion, then the
     cloud's drift over the field's own Δt. The body's turn needs nothing,
     because the axes turn with it.
  3. Project X_prev onto the previous basis and plane (`galaxyTemporal.ts:116–126`'s
     form, in meters).
- **Rejection.** A pixel takes the current value when any of these hold:
  - it lands outside the previous image, or behind it;
  - `!finite(history)` (`finiteOr`);
  - parallax `|translation|/max(d_reproj, 10 m) > 0.1`;
  - depth `|h.d_reproj − |X_prev|| > 0.2·max(d_reproj, 10 m)`;
  - the scene now stops the ray short of the old cloud: `d_end,cur < 0.9·h.d_reproj`;
  - a CPU reset.
- **Clip.** Take the mean μ and deviation σ of (luminance of L_c + B, T_c) over
  the 3 × 3 of the bilinear current at history resolution, and clamp the
  history into `μ ± 1.25σ`, scaling RGB by the luminance clamp.
- **Accumulation.**
  - Own-phase pixels: `h' = mix(clip(h), fresh, α)` with
    `α = max(1/(age + 1), 0.125)`.
  - Other pixels: `h' = clip(h)`, with `age + 1`.
- **The NaN guard** applies on read, as above, and on write:
  `h' = finiteOr(h', finiteOr(fresh, (0, 0, 0, 1)))`. A single NaN in a
  history blacks out the frame, and the stationary path copies history
  verbatim, so both ends are guarded (temporal map §8). `cloudHistory.gpu.test.ts`
  injects a NaN through a test-only uniform.

---

## 6. The offline Mie table

### 6.1 What phase 0 needs it for

1. The Done-when test: the glory's first ring at its radius.
2. The trace's end-of-ray phase fetch. It is real cost and real structure,
   though the light it produces is not judged.
3. The table phase 1's first-order light is built on.

Droplets only. Ice (Baum's aggregates) and rain (geometric optics with Airy's
correction) are phase 1's, in the same format.

### 6.2 The series (`apps/ingest/src/mie.ts`, with its white-light ring finder for §6.6)

This is Bohren and Huffman's BHMIE structure, with Wiscombe's (1980) term count
and starting index. It runs in float64, with complex numbers held as pairs.

```
x = 2πr/λ,  m = n(λ) + iκ(λ)  (κ = 0 in the visible: water's ~10⁻⁹ changes Q_abs by < 10⁻⁶)
N   = round(x + 4.05·x^(1/3) + 2)
D_n(mx): downward from N_mx = max(N, |mx|) + 16, D_{N_mx} = 0;  D_{n−1} = n/(mx) − 1/(D_n + n/(mx))
ψ_n, χ_n upward:  ψ₋₁ = cos x, ψ₀ = sin x;  χ₋₁ = −sin x, χ₀ = cos x;  f_n = (2n − 1)/x·f_{n−1} − f_{n−2};  ξ_n = ψ_n − iχ_n
a_n = ((D_n/m + n/x)ψ_n − ψ_{n−1}) / ((D_n/m + n/x)ξ_n − ξ_{n−1})
b_n = ((m·D_n + n/x)ψ_n − ψ_{n−1}) / ((m·D_n + n/x)ξ_n − ξ_{n−1})
π₀ = 0, π₁ = 1, π_n = ((2n − 1)/(n − 1))·μ·π_{n−1} − (n/(n − 1))·π_{n−2};  τ_n = n·μ·π_n − (n + 1)·π_{n−1}
S₁ = Σ (2n + 1)/(n(n + 1))·(a_n π_n + b_n τ_n),   S₂ = Σ (2n + 1)/(n(n + 1))·(a_n τ_n + b_n π_n)
Q_ext = (2/x²)·Σ (2n + 1)·Re(a_n + b_n),   Q_sca = (2/x²)·Σ (2n + 1)·(|a_n|² + |b_n|²)
g = (4/(x²·Q_sca))·Σ [ n(n + 2)/(n + 1)·Re(a_n a*_{n+1} + b_n b*_{n+1}) + (2n + 1)/(n(n + 1))·Re(a_n b*_n) ]
p(θ) = (|S₁|² + |S₂|²) / (2π·x²·Q_sca)            normalized: ∫ p dΩ = 1
```

### 6.3 The size distribution and the bands

**The size distribution** is Hansen and Travis's (1974) modified gamma,
`n(r) ∝ r^((1 − 3v)/v)·exp(−r/(r_e·v))`, at an effective variance v = 0.01
for every row.

That is a relative width of about 10%: narrow, because "the glory and the
corona survive only a narrow one" (plan §5.3). The value is recorded in the
generated file's header, and phase 1 may add rows of a broader width. The
quadrature is a shared log-radius grid from 1 to 64 µm at Δln r = 0.002 (2,080
radii), each radius evaluated once for each wavelength.

For row j, the weights are `w_i ∝ n(r_i; r_e,j)·r_i·Δln r`, truncated below
10⁻⁸ of their peak.

- Phase: `p_j = Σ w_i·C_sca,i·p_i / Σ w_i·C_sca,i`.
- Bulk: `Q_ext = Σ w_i·πr_i²·Q_ext,i / Σ w_i·πr_i²`, `ω = 1`,
  `g = Σ w_i C_sca,i g_i / Σ w_i C_sca,i`.

**The bands** are the air's 680, 550 and 440 nm (`atmosphere.ts`'s `BANDS`),
so a channel means the same wavelength in the cloud as in the sky. Each band
averages 9 wavelengths over ±40 nm with raised-cosine weights
`cos²(π(λ − λ_c)/80)`.

The weights are non-negative, so every channel's phase stays positive. sRGB's
color-matching functions have negative lobes that can push a ring's channel
below zero. The averaging also smooths the rings into a color gradient rather
than three monochrome copies.

**Water's real index** comes from Hale and Querry (1973) at 25 °C, interpolated
in λ. The table is in the generator, with the citation. WP2 transcribes it from
the source. This design quotes no digits from memory.

### 6.4 The angular axis and the radius axis

**Angles.** There are 1024 texels with `θ_i = (π/2)·(1 − cos(π·i/1023))`. Both
ends are dense: 0° and 180° are texel centers. The spacing is 0.042° at 1° from
either end, 0.064° at 2.4° and 0.28° at 90°.

- The glory's first ring for r_e = 10 µm (2.4°, by 24/r) spans about 38 texels
  from 180°. For 32 µm (0.75°) it spans about 18.
- A corona's first ring at 16/r is as dense near 0°.
- The cloudbow at about 138° gets 0.2° texels.

The lookup is `u = acos(1 − 2θ/π)/π`, with `θ = acos(ν)`: two acos a ray.

**Radii.** There are 32 rows, `r_j = 2·16^(j/31)` µm (2 to 32 µm), 9.4% apart.
Interpolating between rows whose rings sit 9% apart blurs a ring by 9%. The
sun's 0.53° disk blurs it more. The test in §6.6 checks the row centers.

### 6.5 Where the generated file lives, and its size

- **The generator** is `apps/ingest/src/mieTable.ts`, run as
  `node apps/ingest/src/mieTable.ts`. It writes
  `packages/rendering/src/mieDroplets.generated.ts`, and then
  `pnpm exec prettier -w` runs on that file (the galaxy reference's two steps,
  `docs/guides/harness.md:145–154`).
- **The output** is one exported constant:
  `{ format: 'inertialref/mie', version: 1, angles, radii, radiusMin, radiusMax, variance, bands, wavelengthsPerBand, bandHalfWidth, index: 'Hale & Querry 1973, 25 °C', phase: '<base64 of little-endian float16>', bulk: [...], gloryRed: [...] }`.
  `gloryRed` holds each row's red-band glory ring, found by the generator on the
  series itself at 0.005° steps, not through the table (§6.6). The phase holds
  1024 × 32 × 3 half floats, 196,608 bytes, which is 262,144 characters of
  base64. The file is about 270 KB.
- **Half precision holds the range.** p reaches about 10⁴ sr⁻¹ unconvolved at
  the largest row and 650 nm, under half's 65,504. Its smallest values, about
  10⁻², are normal halves.

It belongs in `packages/rendering`, and as TypeScript:

1. It is rendering data. The universe's generated files are generation inputs,
   one step from canonical, and this one is presentation.
2. A package decodes bytes a host supplies and fetches nothing. A TypeScript
   constant needs no host, so Node tests in `pnpm test` read it with nothing
   more than an import. The decoder includes its own small base64 reader,
   because `atob` is not in the core project's lib.
3. It follows the galaxy's precedent: a generator under `apps/ingest` writing a
   `*.generated.ts`.

The bundle never carries it on `main`. Only `cloudPhase.ts` imports it, and the
cloud modules are loaded by a dynamic `import('./cloudSystem.ts')` when
`?clouds=1` is present (§3.17, WP11). So the 270 KB is a chunk only the flag
fetches.

Runtime: about 81 million series terms (3 × 9 × 2,080 radii at an average of
about 400 terms) times 1,024 angles. My estimate is minutes on the mini. **I did
not run it.** WP2 records the real figure in the file's header.

### 6.6 Tests

**What Laven's figures are.** Laven's 24/r, 37/r, 56/r and 76/r degrees are the
red rings of a white-light image of monodisperse drops: the perceived color,
which his page says does not coincide with the peak intensity, and which he
warns a calculation at a few wavelengths misreads. A red band's own intensity
maximum is a different quantity: the reviewers' port of BHMIE, re-run here
(§0.3), puts the 680 ± 40 nm band's first maximum at 3.09°, 1.90°, 1.20° and
0.82° for monodisperse 6, 10, 16 and 25 µm drops, 17–22% inside 24/r, so a
test holding the band to 24/r within 15% fails on a correct table. In white
light the same port puts the 10 µm drop's red rings at 2.19° and 3.70° against
Laven's 2.40° and 3.70°: the series agrees with Laven when the quantity does.
So the Done-when is two tests, one for each half of the chain.

`apps/ingest/src/mie.test.ts` (Node, the gate):

| Test                                                                                                                                                                                                                                                                                                                                                                                                                                           | Bound                                                      | Source                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rayleigh limit: x = 0.01, m = 1.33 gives `p(θ) = 3(1 + cos²θ)/(16π)`                                                                                                                                                                                                                                                                                                                                                                           | 10⁻⁴ relative at 37 angles                                 | the small-sphere limit                                                                                                                                                                                                        |
| Bohren and Huffman's BHMIE example: m = 1.55, x = 5.213                                                                                                                                                                                                                                                                                                                                                                                        | Q_ext, Q_sca, Q_back to 10⁻⁵                               | **The values must be read from the book's Appendix A printout before the test is written.** This design does not quote them, because I would be quoting from memory                                                           |
| Optical theorem: `Q_ext = (4/x²)·Re S₁(0)`                                                                                                                                                                                                                                                                                                                                                                                                     | 10⁻⁹                                                       | identity                                                                                                                                                                                                                      |
| Forward and back: `S₁(0) = S₂(0)`, `S₁(π) = −S₂(π)`                                                                                                                                                                                                                                                                                                                                                                                            | 10⁻⁹                                                       | symmetry                                                                                                                                                                                                                      |
| Normalization: ∫ p dΩ = 1 on a fine Gauss–Legendre grid                                                                                                                                                                                                                                                                                                                                                                                        | 10⁻⁶ at x = 5, 50, 500                                     | definition                                                                                                                                                                                                                    |
| Extinction paradox: Q_ext(x = 1000, m = 1.33) → 2                                                                                                                                                                                                                                                                                                                                                                                              | 3%                                                         | large-sphere limit                                                                                                                                                                                                            |
| **Laven's rings (Done-when, the series).** Monodisperse drops of r ∈ {6, 10, 16, 25} µm in white light: 100 wavelengths uniform over 380–700 nm, an equal-energy spectrum, the CIE 1931 2° observer through Wyman, Sloan and Shirley's (2013) published fit, linear sRGB by the standard XYZ matrix. Redness is `R/(R + G + B)`; the first red ring is its first maximum past the antisolar point after its first minimum, the second the next | the first within 12% of 24/r, the second within 6% of 37/r | [Laven](https://philiplaven.com/p2c1.html); the bounds hold the reviewers' 10 µm figures (−8.8% and 0%) with room for the fit's error against CIE's tables, and the test's comment records the offsets its first run measures |

`apps/ingest/src/mieTable.test.ts`:

- the encoder and decoder round-trip a known table;
- the distribution's moments: the weights' effective radius and variance
  recover r_e and v to 1%;
- the committed file's `gloryRed`, `bulk` and three sampled rows of phase equal
  the series' recomputation for those rows (the ring to 0.01°, Q_ext and g to
  10⁻⁴, the phase to half float's rounding), so the metadata the rendering
  package's test reads is the series', not a free-standing number.

`apps/ingest/src/mieTable.slow.test.ts` (`pnpm test:slow`): one row at
Δln r = 0.002 against 0.001, worst relative difference under 1%. That is
convergence.

`packages/rendering/src/mieTable.test.ts` (Node, the gate) runs against **the
committed generated file**:

- **The table's glory (Done-when, the table).** For every row, the first local
  maximum after the first minimum of the red band's `p(π − ψ)`, read through
  `samplePhase` at the row's center radius and scanned at 0.005°, lies within
  one angular texel step at that angle (§6.4: 0.042° near 1°, 0.064° near 2.4°)
  of the row's `gloryRed`. That holds the angle warp, the encoding and the
  decoder to the series; the series is held to Laven above.
- **Normalization.** ∫ p dΩ over the table's own grid (trapezoid in θ with
  sin θ) is within 1% of 1 for every row and band.
- **Forward peak.** p(0) is each row's maximum, and p falls monotonically over
  the first `0.5·(10/r_e)` degrees.
- **Cloudbow.** For r_e ≥ 10 µm, a local maximum lies in [135°, 150°] (the
  fogbow and cloudbow, plan §8.1).
- **Bulk.** Q_ext lies within [1.9, 2.5] for every row and band and g within
  [0.80, 0.90], bounds taken from the series: at 2–4 µm the edge term and the
  interference ripple put Q_ext between 2.08 and 2.42 (§0.3), where
  "droplets ≫ λ" would say 2.

There is no convolution test: the disk convolution is phase 1's (§1.4).

---

## 7. The scene unit (plan §8.3)

### 7.1 The investigation

| Name                | Value                                                                                                            | What it calls a unit                                                                                                                                                                               | Read at                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0056's unit     | `ATMOSPHERE_GAIN = π`; the anchor converts cd/m² by `π·cd/E⊥` with E⊥ = 133.8 klx (`atmosphere.test.ts:284–293`) | An albedo-one surface under the sun **above the air** at 1 AU: E⊥/π = **42,590 cd/m²**. The plan writes 133.3 klx and 42,400; the test uses 133,800                                                | Every air call site (`materials.ts:410`, `planet.ts:592`, `terrain.ts:1432`, `water.ts:654`)                                                                                                                                                                                                                                                                        |
| `SURFACE_LUMINANCE` | **30,000 cd/m²**, "an albedo-one surface under terrestrial sunlight" (`exposure.ts:3–4`)                         | A surface under sea-level sunlight. But the surfaces' beam reaches the ground through `sunThrough`, 0.77 units at a noon zenith (air map §9.1, computed), so a unit is above the air, not under it | `sceneRadianceGain = SURFACE_LUMINANCE·pre` (`radiance.ts:29–31`), `integratedGainFor` (`radiance.ts:71–72`), the calibration EV (`exposure.ts`), the disk's cap (`Bodies.tsx:637`), the galaxy (`galaxyVolume.ts:548`, re-read), star sprites (`materials.ts:606`), the star-visibility floor (`starVisibility.ts:53`), disk radiance (`bodyUniforms.ts:291, 308`) |
| `SOLAR_LUMINANCE`   | 1.6 × 10⁹ cd/m² (`exposure.ts:5`)                                                                                | The sun's disk as seen **at sea level**: 1.6 × 10⁹ × 6.794 × 10⁻⁵ sr gives 108.7 klx. Above the air it would be about 1.97 × 10⁹ (E⊥/Ω)                                                            | `stellarLuminance` and `stellarIlluminance` (`photometry.ts`)                                                                                                                                                                                                                                                                                                       |

Every row except the galaxy line was taken from the air map. The galaxy line
was re-read for this design. WP10 re-reads each before editing.

The disagreements, computed:

- 42,590/30,000 = **1.420** (0.506 stop).
- The disk is drawn at 1.6e9/30,000 = 53,333 units, against π/Ω = 46,240 for
  "sunlight 1, white 1": 1.153×.
- The galaxy and the stars are converted through 30,000 while the sky they sit
  in is converted through 42,590. Against the sunlit world they are therefore
  1.42× bright in ratio.

### 7.2 Candidate resolutions

**(a) Set `SURFACE_LUMINANCE` to 42,590.** This moves:

- Manual exposure, by +0.51 EV at a fixed lens;
- the calibration EV readouts;
- the galaxy and the stars, ×0.70 relative to the world;
- the star-visibility floor, by up to 0.22 mag;
- disk compression, from 0.191 to 0.197.

Every photographic plate moves, and every plate with stars or the galaxy behind
it moves. That is most of the 13. No emitter is yet calibrated against either
constant, so the move improves no picture phase 0 can judge.

**(b) Name both. This is the resolution.**

- `SCENE_UNIT_LUMINANCE = EXTRATERRESTRIAL_ILLUMINANCE/π` with
  `EXTRATERRESTRIAL_ILLUMINANCE = 133_800`. Both are exported from
  `exposure.ts`, and the air's anchor test imports them instead of its local
  literal. **This is the scene unit.** Every absolute emitter from phase 4 on
  converts physical radiance into scene units by dividing by it: lightning,
  the moon, cities, airglow.
- `SURFACE_LUMINANCE = 30_000` keeps its value, renamed in its doc comment as
  **the sensor's calibration white**: the luminance the photographic exposure
  equates with one scene unit. That is a calibration 0.506 stop under the
  physical unit. It is not a definition of the unit.
- `SOLAR_LUMINANCE`'s doc says what it is: the disk at sea level, 108.7 klx at
  1 AU, 0.81 of E⊥.
- The conversions that use the white as if it were the unit (galaxy, stars,
  star floor, disk) are written into `design/plans/the-air.md` as one open
  defect with these numbers. They are fixed in phase 5, when the moon, airglow
  and stars are calibrated together and the `night-side` preset is re-scored
  (phase 5's own Done-when).
- **The Enhanced rule for emitters**, recorded in the same place: under Enhanced
  staging every body's sunlight is 1 (`bodyUniforms.ts:351`). An absolute
  emitter's scene value is therefore divided by `body.sunlight` there, or its
  ratio to the sun changes with the camera mode (×2.3 on Mars; inference from
  that code, air map §9.2).

**(c) Scale the air's gain to match 30,000. Rejected:** it is a fitted gain
over the sum, the error ADR-0056 removed, and it fails the anchor.

### 7.3 The test that pins (b), and whether anything moves

`packages/rendering/src/exposure.test.ts`:

- `SCENE_UNIT_LUMINANCE === EXTRATERRESTRIAL_ILLUMINANCE/Math.PI`, and within
  0.5 of 42,590.
- **The ratio `SCENE_UNIT_LUMINANCE/SURFACE_LUMINANCE` lies in [1.418, 1.422].**
  The assertion's message names it the sensor's half-stop calibration bias, so a
  change to either constant has to restate the bias consciously.
- `stellarIlluminance(1, AU)/EXTRATERRESTRIAL_ILLUMINANCE` lies in [0.80, 0.83]:
  `SOLAR_LUMINANCE` is the disk at sea level, recorded.

`atmosphere.test.ts` imports `EXTRATERRESTRIAL_ILLUMINANCE`, so its anchor and
the constant are one number.

**No picture moves.** No constant's value changes. ADR-0065 records it.

---

## 8. Measurement protocol

### 8.1 Machine, build, bodies

- **The machine** is the Mac mini, Mac18,5 (Apple M6, 32 GB), fan-cooled. Each
  figure names the hardware, Chrome's version (from the rig's operating point),
  the display size and the minutes under load. The interleaved A/B protocol,
  base and candidate in one boot, carries the thermal step (harness map,
  trap 8).
- **Quiet is checked, not assumed.** The GPU lock keeps other GPU jobs off the
  machine and nothing else: another agent's Stop-hook gate, a build or a Node
  suite takes worker runs from 45 ms to 285 (`.claude/rules/timing.md`) and
  perturbs `ir.profile` and every CPU-bound frame. Before and after each A/B run
  the runner samples `os.loadavg()` and scans the process table for `vitest`,
  `tsc`, `vite`, `oxlint`, `knip`, `pnpm` and another port's `drive.mjs`. It
  waits up to ten minutes for a quiet start; a run that ends under load is
  marked `quiet: false` in its row and re-run, and no marked row counts toward
  a decision. The batches run after integration with no implementation agent
  in flight (§11.3), so the waits are for strays.
- **The build** is production: `pnpm build && pnpm preview` (port 8787), and
  each drive invocation takes `--url http://localhost:8787/ --no-serve`. Dev
  React is about 5× the shipped CPU cost, and placement A's second traversal is
  a CPU cost.
  - The runner records `git rev-parse HEAD`, a clean `git status --porcelain`,
    and `apps/game/dist`'s build time against the last commit's time. The
    preview names no tree (harness map §3.6), so this is how the figure is tied
    to the code.
- **Bodies**, from the headless probe (`openSession` with the real catalog,
  `ir.preset('far-shore')`, walking `world.loadedSystems()`):
  - **The wet world** is far-shore, `g:milky-way/s:P222_1_0_9/b:4`
    (P222_1_0_9 V): 3,980 km, sea level 0.453, water, ground 343 K,
    2.43 kg/m³, dust haze at τ 0.4. `wetWorld` is true.
  - **Its moon** is `…/b:4.0` (V a): 144 km and airless. The address form is
    inferred from Luna's `s:SOL/b:2.0`.
  - **The neighbor** is `…/b:3` (IV): 3,464 km, 450 K, a dust haze and no sea.
    `wetWorld` is false, so the lever has to force it.
  - **Earth** is `g:milky-way/s:SOL/b:2`. It is `wetWorld` true, and its deck
    yields when the lever serves it.
  - No other body in far-shore's system is wet, so "two clouded bodies" forces
    the second.

### 8.2 Scenarios

Every drive call carries `--query clouds=1 --query chrome=0 --query layers=0 --query output=standard`,
plus the size. 1080p is `--width 1920 --height 1080 --dpr 1`; Retina is
`--width 1440 --height 900 --dpr 2`, a 2880 × 1800 buffer.

| Id              | Body, stance                                                                                                                                                                              | Weather                                          | Instant                               | Measures                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ground`        | far-shore, `ir.visit(FAR, { site: 'basin', height: 2, heading: 90, pitch: 10 })`                                                                                                          | `fair-cumulus`                                   | far-shore's instant (basin sun 37.5°) | §9 "on the ground, dry"; `fly` at 250 m/s                                                                                                        |
| `horizon`       | the same, pitch 2                                                                                                                                                                         | `broken-horizon`                                 | the same                              | broken-cloud horizon; placement on a sea frame (the basin has sea in view; WP10 confirms with the frame's `scene after copy`); `cut` and `scrub` |
| `inside`        | the same site, height 1,200, pitch 0                                                                                                                                                      | `inside`                                         | the same                              | inside a cloud                                                                                                                                   |
| `decks`         | the same site, height 2, pitch 30                                                                                                                                                         | `two-decks`                                      | the same                              | two decks                                                                                                                                        |
| `scrub`         | `horizon`                                                                                                                                                                                 | `broken-horizon`, `force: 'scrub'`               | the same                              | a rapid scrub (3 h a frame, the sun turning)                                                                                                     |
| `orbit`         | far-shore, `ir.visit(FAR, { latitude: 15, longitude: 34, height: 400000, heading: 0, pitch: -40 })` (limb at −24.7° in frame)                                                             | `broken-horizon`, `flySpeed: 7700`               | the same                              | §9 "from orbit"; far-field cost; `fly` at 7.7 km/s                                                                                               |
| `pair-moon`     | V a under the `rise` framing with V over its limb (the `earthrise` composition; WP10 resolves the exact `ir.rise`/`ir.compose` call with `ir.help()`), `served: …/b:4.0`, `second: …/b:4` | `fair-cumulus` on both                           | far-shore's                           | two clouded bodies (the second's far march over a large disk)                                                                                    |
| `pair-neighbor` | `ground`'s stance, `second: …/b:3`                                                                                                                                                        | `fair-cumulus`                                   | the same                              | two clouded bodies (a small second disk)                                                                                                         |
| `earth-ground`  | `--preset blue-marble`, then `ir.visit(EARTH, { latitude: 0, longitude: 0, height: 2, heading: 90, pitch: 10 })`                                                                          | `fair-cumulus`                                   | t = 0 (sun 63.5°)                     | Earth, its deck yielding                                                                                                                         |
| `earth-orbit`   | Earth, height 400000, pitch −35 (limb at −19.8°)                                                                                                                                          | `broken-horizon`, `flySpeed: 7700`               | t = 0                                 | Earth from orbit                                                                                                                                 |
| `sunset`        | far-shore preset stance (80 m, sun 4.58°), heading toward the sun                                                                                                                         | `near-gap-far`, eye raised to 1,500 m into a gap | preset instant                        | thin form at sunset                                                                                                                              |
| `fog`           | the `ground` stance                                                                                                                                                                       | `fog`                                            | the same                              | thin form in fog                                                                                                                                 |

The heights and pitches are design values. WP10 checks each stance's sun with
`ir.light()` and changes the instant only through the orchestrator.

### 8.3 The A/B protocol

This is the harness guide's (§9.1 of the harness map), with levers on
`engine.clouds`. It lives in `scripts/clouds/page.mjs`, which exports page-side
functions that the runner stringifies into `--js`. A `--file` body's top-level
`return` would not parse under oxlint in a committed file.

```js
export async function ab({
  base,
  candidate,
  pairs = 5,
  reads = 3,
  n = 120,
  settleCap = 240,
  profileMs = 0,
}) {
  const set = (levers) => {
    engine.clouds = { ...engine.clouds, ...levers }
  }
  const frame = () => new Promise((done) => requestAnimationFrame(() => done()))
  // Until the report's own settle says the caches and the history are done, or
  // the cap: a forced path (cut, scrub, warp, fly) never settles and waits the
  // cap, which is longer than the far atlas's 45-frame cycle.
  const settle = async () => {
    for (let i = 0; i < settleCap; i += 1) {
      await frame()
      const s = ir.clouds()?.settle ?? null
      if (i >= 4 && (s === null || !s.pending)) return i
    }
    return settleCap
  }
  const gpu = async () => {
    let best = Infinity
    for (let r = 0; r < reads; r += 1)
      best = Math.min(best, (await ir.gpu(n)).ms ?? Infinity)
    return best
  }
  // The frame's pass count first, then as many frames as fit under 2,048 passes.
  const timeline = async () => {
    const one = await ir.passes(1)
    const perFrame = one.passes.reduce((sum, p) => sum + p.count, 0)
    const frames = Math.max(
      1,
      Math.min(40, Math.floor(2000 / Math.max(perFrame, 1))),
    )
    const read = await ir.passes(frames)
    if (read.dropped > 0)
      throw new Error(`ir.passes dropped ${read.dropped} at ${frames} frames`)
    return { perFrame, frames, read }
  }
  const rows = []
  for (let p = 0; p < pairs; p += 1) {
    set(base)
    const bs = await settle()
    const b = await gpu()
    set(candidate)
    const cs = await settle()
    const c = await gpu()
    rows.push({ base: b, candidate: c, delta: c - b, settled: [bs, cs] })
  }
  set(candidate)
  await settle()
  const passes = await timeline()
  let cpu = null
  if (profileMs > 0) {
    cpu = { candidate: await ir.profile(profileMs) }
    set(base)
    await settle()
    cpu.base = await ir.profile(profileMs)
  }
  set(base)
  await settle()
  return {
    rows,
    passes,
    cpu,
    clouds: ir.clouds(),
    light: ir.light(),
    lens: ir.lens(),
    picture: ir.picture(),
    build: ir.build(),
  }
}
```

Reads are sequential, never concurrent: two runs of `ir.passes` at once throw.
`summarize` divides by the frames asked for, so a read with `dropped > 0` would
report every label low; the read is refused instead.

| Kind                                 | Base levers                     | Candidate levers                                                                        |
| ------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------- |
| Steady                               | `{ on: false }`                 | `{ on: true, …choice }`                                                                 |
| Reset (the immediate regime alone)   | `{ on: false }`                 | `{ on: true, force: 'reset', …choice }`                                                 |
| Cut                                  | `{ on: false }`                 | `{ on: true, force: 'cut', …choice }`                                                   |
| Rapid scrub                          | `{ on: false }`                 | `{ on: true, force: 'scrub', …choice }`                                                 |
| Fly                                  | `{ on: false }`                 | `{ on: true, force: 'fly', …choice }`                                                   |
| Warp (recorded, not a Done-when row) | `{ on: false }`                 | `{ on: true, force: 'warp', warp: 1000, …choice }`                                      |
| A choice                             | `{ on: true, X: a }`            | `{ on: true, X: b }`                                                                    |
| Earth, with its deck priced          | `{ on: false, deck: 'hidden' }` | `{ on: true, …choice }`, beside `{ on: false }` against `{ on: false, deck: 'hidden' }` |

**The reset frame** is the larger of `cut` and `scrub`. **The per-pass figure**
is the timeline's share `ms` for the cloud labels and for `scene over clouds`,
taken from `ir.passes` on the candidate. The split's own price comes from
`empty-split` against off. **CPU**, for the placement choice, is
`ir.profile(3000)` on each side: the `sensor` span's `meanMs` and the late
frames. **Earth's figures come in pairs**: the clouds against a frame with the
deck hidden, which is their own cost, and the deck's cost alone; the clouds
against today's frame would be the clouds' cost minus the deck's.

### 8.4 The sweep: fetches a second

The scenario is `overcast` (every ray crosses cloud), standing at 2 m, pitch
45, `cache: 'field'`. A sweep cell sets `fixedSteps` and `sweepReads`, which
select the sweep kernel (§3.14): **constant work by construction.** Every ray
takes exactly `fixedSteps` steps of 4 m from t₀, does not stop at t₁ (past it the
reads return zero density and still happen), has no early exit, reads no sun,
no air and no far field, and makes at every step `sweepReads` fetches of the
base noise at decorrelated offsets, summed so the compiler keeps each, plus one
fetch of `sweepExtra`'s type. A cell is accepted only after an untimed frame
with `stats: true` reports `mean = max = fixedSteps`; the timed reads run with
`stats` off, since its atomics cost.

The loop the steady trace runs cannot give this. It stops at t₁; its in-cloud
step is `0.3/σ` held to [4.6 m, 50 m], so `overcast`'s 990 m chord at 45° takes
about 188 steps where density is full and tens where eroded noise thins it,
and the step count varies with the reads; and every in-cloud step also reads
the sun's depth and two air tables, so `rays·steps·reads` would undercount the
fetches by about `(reads + 3.25)/reads`, 4.25 times at one read.

| Axis                | Values                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rays                | `traceScale` 0.5, 1, 2: 1080p gives 240 × 135, 480 × 270, 960 × 540                                                                                                 |
| Steps               | `fixedSteps` 32, 64, 128                                                                                                                                            |
| Base fetches a step | `sweepReads` 1, 2, 4, 6                                                                                                                                             |
| Format              | `noiseFormat` `'r8'` against `'rgba8'` (the same texels; RGBA8's other channels are three more octaves each fetch folds in, so the compiler cannot narrow the read) |

That is 72 cells at each size with `sweepExtra: 'none'`. For each cell: the
settle wait, the stats check, then the timeline read, taking `ms` of
`cloud trace`.

- **The fetch rate.** `fetches/s = (trace.width × trace.height × fixedSteps × sweepReads) / (ms × 10⁻³)`.
  A least-squares fit of `ms = α·rays + β·rays·steps + γ·rays·steps·reads` per
  format separates per-ray overhead (α), the per-step floor (β) and the base
  fetch's cost (γ, whose inverse is the base noise's fetch rate). One read type
  makes γ a rate: averaged over a 128³ R8 noise, a 64 × 8 profile and a 32³
  detail that sit in cache, plus clipmap reads, it would be none.
- **Each other read type**, at `traceScale` 1, `fixedSteps` 64,
  `sweepReads` 1: `sweepExtra` set to each of `clipmap`, `profile`, `detail`,
  `curl` and `level` (the next clipmap level), against `none`. Each type's
  marginal cost is `Δms/(rays·steps)`, reported separately.
- **R8 against RGBA8** is `Δms(rgba8 − r8)/(rays·steps·sweepReads)` at
  `sweepReads` 2 and 4, where the base fetch is the whole of the step.

Output: the table of cells, the fit with its residual, the five marginals and
the format's Δ. The fit is the figure §9's "texture-bound march" row gets.

### 8.5 Memory and cold compile

- **Memory.** In every steady run, `ir.clouds().bytes` gives the total and each
  resource, declared from dimensions, texel size and levels, and held to the
  GPU textures' own figures by `cloudSystem.gpu.test.ts`. The ADR quotes the
  landed winner set at both sizes.
- **Cold compile**, on the landed code (§11.3), so the figure counts the
  pipelines that ship and not every candidate's:
  - Three boots with `?clouds=1&timing=full` and three without, at each size,
    on port 9342. Before each boot the runner closes the rig (`--down`) and
    deletes `.data/drive/profile-9342`, its own rig's profile. `drive.mjs`
    keys the profile on the port and keeps it between runs, and `--fresh` only
    reboots the page (`drive.mjs:227–235, 529`); Chrome's GPU caches live in
    that directory and go with it.
  - **The OS's Metal shader cache is not cleared**: it lives outside the
    profile, in the user's cache directory, and clearing a system cache is
    outside this task. Every cold figure therefore says "fresh Chrome profile;
    the OS Metal cache may be warm".
  - Read `ir.timing.drain().filter((e) => e.track === 'Boot')` for the
    `warming the clouds` span and the whole `warm-up`, then the difference with
    and without the flag.
  - **The first lever-on frame**, in the same invocation as its boot: one
    `--js` step writes `engine.clouds = { ...engine.clouds, on: true, …winner }`,
    and the next samples `--sample 60 --sample-js "ir.status().frame"`. The
    figure is the largest `frameMs` of the first five samples against the median
    of the last thirty, beside that first frame's `sensor` span from the
    timeline. It must show no compile hitch, which `cloudWarm.gpu.test.ts` holds
    headlessly for render and compute pipelines alike.
  - The report's `pipelines` count, render and compute.

### 8.6 Error, and the measurement instruments

**The thin form, and the identity's residual, on the scene as built.**

- **Where:** the `sunset`, `fog` and `orbit` scenarios, and `horizon` at a
  2.4 km eye. That gives a near cloud, a lit gap and a far cloud in one frame.
- **How:** `composite: 'residual'`, which makes the composite inert and runs
  `cloud residual` after the frame. Each scenario runs twice in one boot:
  Enhanced off (`engine.requestSensorSettings({ ...engine.sensorSettings, mode: 'automatic' })`)
  and Enhanced on (`mode: 'enhanced'`). WP10 confirms that the mode is the field
  that selects Enhanced's processing, through the report's `processing`.
- **Read:** `ir.clouds().residual` after the settle wait: three histograms of
  relative error and the class-disagreement count.
- **Report:** for each, the fraction of cloud texels over 1%, 2% and 5%, the
  95th percentile, and the worst.
- **Display-referred view:** `scripts/clouds/diff.mjs` differences two
  `--shot` PNGs, `composite: 'identity'` against `'thin'`, taken in one
  invocation, with `magick compare -metric RMSE` and the fraction of pixels
  over 3% and 8% (the presets' per-pixel `SAME` values).
- **The Enhanced ring at the limb**, plan §5.6 gap (iii): the residual meter's
  sky-class texels within 2° of the limb under Enhanced, reported separately.

**The far field, the sun's depth and the composite's quadrature: headless GPU
measurement tests.** These are opt-in by `IR_CLOUD_MEASURE=1`
(`describe.skipIf(!process.env.IR_CLOUD_MEASURE)`). They write
`.data/clouds/<name>.json` and assert only that every figure is finite and
inside a sanity bound, because they are instruments, not gates. The two that
judge a choice need the real placeholder field, so they belong to WP12 and run
after integration, importing the real media, maps, clipmap and
`WEATHER_SCENARIOS`.

| File                                    | What it scores                                                                                                                                                                                                                                                                                                                                                       | Setup                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudFarCompare.gpu.test.ts` (WP12)    | For atlas and spheres against the fine march: **the radiance and transmittance error averaged over each far texel's footprint** (the fine march's rays binned by the far texel their handover point falls in, and the bins' means compared), which decides; the per-pixel radiance RMSE at the handover, recorded for phase 1's cross-fade; the depth moments' error | 256 × 144 rays. Four cases, each placed at the handover footprint: cirrus over cumulus, broken cumulus, an anvil, a grazing ray at sunset (sun 2°). The camera distance puts the case's content at `t_far` for `farFootprint` 400 m and 1,600 m. The fine march is forced over the whole ray (`farFootprint` → ∞); each far candidate is forced from t₀. The handover by an exhausted budget is scored too. A far texel 1,800 km from the eye bakes nonzero coverage |
| `cloudSunAccuracy.gpu.test.ts` (WP12)   | `T_cloud` RMS and worst error against the 256-step reference                                                                                                                                                                                                                                                                                                         | In-cloud samples of `fair-cumulus`, `two-decks`, `anvil`, `overcast` and `cirrus-over-cumulus`, at suns of 37.5° and 5°, cascades against grid, `lightTaps` 2 and 4                                                                                                                                                                                                                                                                                                  |
| `cloudCompositeError.gpu.test.ts` (WP9) | The identity and thin forms against a 512-sample joint march of air and cloud with a known surface S, plus the identity's quadrature residual against the surface's own 4-sample march and the shell's 12                                                                                                                                                            | One body, Earth's recipe, a slab cloud at three thicknesses and five view angles, Enhanced cleared 0 and 1. Analytic slabs, so it stays with its package                                                                                                                                                                                                                                                                                                             |

Per-pixel error at a fixed handover would decide on resolution, not
representation: the two candidates share one texel layout (258² a face and a
layer, 24 km on far-shore, 39 km on Earth), and at a 400 m handover both are
two orders coarser than the fine march beside them. The footprint average asks
which of the two represents what a far texel stands for.

**The transparent object** is a pass/fail GPU test, `cloudFront.gpu.test.ts`
(§5.12).

### 8.7 Decision rules, fixed before measuring

A difference counts only when it exceeds the protocol's resolution: twice the
spread of the pairs' deltas, and at least 0.05 ms. Each ADR may argue an
exception, but only with figures.

| Choice                                  | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Placement                               | **A wins** unless B's steady frame is cheaper than A's by more than 0.2 ms at Retina on two of the three scenarios (`horizon`, `inside`, `orbit`). **A also loses on the CPU:** if its `sensor` span's mean exceeds B's by more than 0.3 ms on any of the three at either size, or its late frames over the 3 s window exceed B's by more than 2 on `horizon` or `inside`. `ir.gpu` times submitted frames over a drained queue, so a GPU-bound ground frame hides A's second traversal there, on a main thread whose rAF already sits at 16.67 ms (p95 17.4). B's irreducible defect, opaque instruments under the clouds (§4.3), and its reach under three's surface are worth 0.2 ms. If B wins, ADR-0063 records the inks' fix as phase 1 work. If the empty split costs over 0.1 ms at Retina on a sea frame, C is reconsidered in phase 1 (§4.2)                                                                                 |
| Far field                               | **The candidate with the smaller worst-case footprint-averaged radiance error** over the four handover cases at `farFootprint` 400 m wins, unless its steady cost (`orbit` and `horizon`) exceeds the other's by more than 0.3 ms at either size, or its marginal memory is more than 2.5 times the other's. Then the other wins, unless its error is more than 1.5 times the first's, in which case the more accurate wins and the ADR records the cost. The clause reads 2.5 so that the spheres, exactly twice the atlas by texel size, are not decided by rounding; `levels` fails it under any accounting (§1.3)                                                                                                                                                                                                                                                                                                                  |
| Cache × sun's depth, jointly            | **Gates.** (a) A volume combination's image difference against the field combination with the same sun depth is under 3% radiance RMSE over cloud texels in `ground`, `horizon` and `inside` at both sizes. (b) A sun-depth candidate's `T_cloud` RMS error is ≤ 3% in all five scenarios at both suns at `lightTaps: 2`; if neither passes, the more accurate stays in and the shortfall is recorded. **Among the combinations that pass both**, the winner has the smallest steady Δ against off in at least two of `ground`, `horizon` and `inside` at both sizes, provided its `fly` frame (`ground`, `orbit`) is within 0.3 ms of the best passing combination's and its reset frame (the larger of `cut` and `scrub` on `horizon`) within 1 ms of the best's; otherwise the next by steady Δ. Differences under the resolution go to the combination with less memory. `(field, grid)` carries the volume's bake, which it needs |
| Thin form                               | Allowed in a regime only where its 95th-percentile error against the identity is under 1% and its worst under 5% in every measured frame of that regime, Enhanced off and on. Phase 0 names the regimes from the data (from orbit, for example). The identity is the default everywhere else                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `maxSteps`, `lightTaps`, `farFootprint` | Set to the smallest value whose image differs from the next larger value by under 1% radiance RMSE in `horizon` and `inside`, from the sweep's and the far comparison's data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The choices are coupled only through the volume: the grid and the cache share
it. That is why those two are one 2 × 2. The far field is measured with
`(field, cascades)` and decided on its own, and the placement on whatever the
other three are, since neither changes what the composite or the split costs.

### 8.8 Batches, commands, durations, the lock

```sh
pnpm build                       # the bundle the preview serves
pnpm preview &                   # 8787; the runner refuses if it does not answer
node scripts/clouds/measure.mjs --batch decisions --url http://localhost:8787/ --gpu-wait 900
node scripts/clouds/measure.mjs --batch sweep     --url http://localhost:8787/
IR_CLOUD_MEASURE=1 IR_GPU_WAIT=900 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudFarCompare cloudSunAccuracy cloudCompositeError
# decide (§8.7), delete the losers and set the defaults (§11.3), rebuild, then:
node scripts/clouds/measure.mjs --batch targets   --url http://localhost:8787/
node scripts/clouds/measure.mjs --batch memory    --url http://localhost:8787/
node scripts/clouds/measure.mjs --batch error     --url http://localhost:8787/
```

**The lock** follows `scripts/presets/capture.mjs`'s pattern:

1. `measure.mjs` calls `acquire('clouds:measure', { waitMs, keepChildren: true, hint })`
   (`scripts/gpuLock.mjs`) **once**, before the first Chrome launch.
2. It runs every `drive.mjs` child with `IR_GPU_LOCK_TOKEN` set from the lock's
   `env`: the measurement rig on `--port 9341`, the memory batch's cold boots
   on 9342, each closed with `--down` and its profile deleted before the next.
3. It closes the rig with `node scripts/drive.mjs --port 9341 --down` and
   releases.

A refusal at start is a stop: rule 68, so wait with `--gpu-wait`. The
measurement tests run as their own job under `IR_GPU_WAIT`. They never overlap
a rig, a suite or the plates (plan §12).

| Batch                   | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Runs                        | Minutes (estimate) |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------ |
| `decisions`             | Placement: `split`, `passes`, `empty-split` each against off, on `horizon`, `inside`, `orbit`, both sizes, 5 pairs, with `ir.profile(3000)` for `split` and `passes` (18 runs). Cache × sun depth: the four combinations against off, steady on `ground`, `horizon`, `inside` at 5 pairs (24); `fly` on `ground` and `orbit` at 3 pairs (16); `cut` and `scrub` on `horizon` at 3 pairs (16). Far field: atlas against spheres on `orbit` and `horizon` (4) | 78 A/B runs, about 14 boots | about 140          |
| `sweep`                 | 72 cells × 2 sizes, plus five read-type marginals and the format at each size                                                                                                                                                                                                                                                                                                                                                                               | 2 boots                     | about 15           |
| GPU measurement tests   | far compare, sun accuracy, composite error                                                                                                                                                                                                                                                                                                                                                                                                                  | 1 suite run                 | about 5            |
| `targets` (landed code) | far-shore `ground`, `horizon`, `inside`, `decks`, `scrub`, `orbit`, `pair-moon`, `pair-neighbor`; Earth `earth-ground`, `earth-orbit` with the deck priced. Steady, cut, scrub and fly where meaningful, both sizes, 3 pairs                                                                                                                                                                                                                                | about 60 A/B runs           | about 75           |
| `memory` (landed code)  | 6 cold boots × 2 sizes, each on a deleted profile, plus the bytes read from `targets`                                                                                                                                                                                                                                                                                                                                                                       | 12 boots                    | about 20           |
| `error` (landed code)   | `sunset`, `fog`, `orbit`, `horizon` at 2.4 km × Enhanced off and on × 2 sizes; plus the identity/thin screenshot pairs                                                                                                                                                                                                                                                                                                                                      | 16 runs                     | about 20           |

The total is about 4.5 hours of rig time. Every minute figure is an estimate
from the protocol's own arithmetic: `ir.gpu(120)` at 16–33 ms a frame, up to
240 frames of settle wait a side, and production boots at 20–40 s. The runner
prints the real durations.

### 8.9 Output

The runner writes `.data/clouds/<batch>-<ISO time>.json` with every row, its
`quiet` mark and the operating point. It prints Markdown tables the ADRs copy
as they are:

```
| Scenario | Size | Kind | Lever | Base ms | Candidate ms | Δ ms (spread) | scene over clouds | cloud trace | cloud history | cloud depth | bakes | passes/frame | bytes | quiet |
| Choice   | Candidate | Δ ms 1080p | Δ ms Retina | sensor ms Δ | late Δ | worst error | memory MB | rule outcome |
| Rays | Steps | Reads | Format | trace ms | fetches/s |        (+ the fit: α, β, γ, residual; the five marginals; R8/RGBA8)
| Scenario | Enhanced | thin >1% | thin p95 | thin worst | residual light p95 | residual total p95 | class disagreement | RMSE (display) |
```

---

## 9. Tests

Every new test is listed with what it pins, its suite and its package. GPU
files run under `pnpm test:gpu` (the lock; `IR_GPU_WAIT` to queue). A GPU file
whose subject needs `timestamp-query` uses
`describe.skipIf(!(await adapterOffers('timestamp-query')))`, as CI's
paravirtual adapter lacks it. **No phase-0 GPU test needs
`texture-formats-tier1`**: every storage texture is RGBA16F or RGBA8, and the
R8 and RG8 volumes are render attachments. The fallback named in §3.8 skips on
`adapterOffers('texture-formats-tier1')` if the premise spike takes it. GPU
tests over 20 s set their own `timeout`.

| File                                                                                                                  | Suite       | Package | Pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ----------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/game/src/render/cloudContracts.test.ts`                                                                         | Node        | C       | Every new `apps/game` module imports and its exports exist, constructing nothing on a device; it keeps knip's "unused file" quiet until each package's own tests land. WP11 deletes it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/game/src/render/cloudLevers.test.ts`                                                                            | Node        | C       | `isCloudLevers` refuses each malformed field, and `fixedSteps > 0` without `sweepReads ≥ 1` or the reverse; defaults are off; `cloudResetKey` changes exactly with the reset levers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cloudGeometry.gpu.test.ts`                                                                                           | GPU         | C       | §3.5b: crossings, altitude along a ray and at a point (0.25 m within [−1, 20] km, 10⁻⁶·(R + t) elsewhere), the sun's cosine, a level ray from an eye on a boundary giving (0, 0) and no NaN, `levelPlane` against the float64 projection to 2 cm at 100 km, `levelOffset` inverting it, `traceScreen`'s row 0 at the top                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cloudPremises.gpu.test.ts`                                                                                           | GPU         | C       | The premise spike (§11.1): three draws into a `RenderTarget3D` slice; a 2D-array MRT quad with `fragmentNode = mrt(…)`; `warmSensorPass` of both builds no pipeline at the first draw; a compute and a render issued from a mesh's `updateBefore` inside an open render, under a pass-B-like render and inside a split prototype, execute in order and leave the outer render's context and target intact; the encoder swap (a draw before, a compute during, a draw after, in that order on the GPU); `uniform(…, 'uvec2')` builds; a `cloudStorageTexture` written by compute and then sampled has one level and draws no mip pass; `computePipelinesBuilt()` counts a first dispatch                                                                                                                                                                                                                                                                                                |
| `packages/rendering/src/weatherScenario.test.ts`                                                                      | Node        | WP1     | Scenarios valid (≤ 3 layers, disjoint, base < top, coverage in [0, 1]); `genusProfile` continuous, 0 outside, peak 1; `wetWorld` true for far-shore V and Earth and false for Mars, Venus, a sulfuric generated world and a water world under an unauthored haze of thickness 10 (τ 1.2). The records are built from `@inertialref/universe`, layer 3: Sol's bodies from its solar system, and far-shore's system generated from the universe seed and its id. They are not built through `openSession`, which lives in devtools, a layer above rendering; blob existence a u32 comparison (a property: no float threshold)                                                                                                                                                                                                                                                                                                                                                            |
| `weatherShells.test.ts`                                                                                               | Node        | WP1     | Crossings against an exact float64 solution (fast-check: R 10⁵–10⁸ m, h −10⁴…4 × 10⁵, μ ∈ [−1, 1], μ = 0 from an eye on a boundary); the float32 emulation of §5.3 within 0.25 m where h ∈ [−1, 20] km and 10⁻⁶·(R + t) elsewhere; `altitudeAt` equal to `altitudeAlong` on points of a ray; `unionSpan` from an eye inside, below and above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `weatherClock.test.ts`                                                                                                | Node        | WP1     | Reductions exact to 1 ms at 3.2 × 10¹² s; `periodIndex` halves round-trip; `driftOffset` bounded by \|v\|·3600 and continuous inside a period                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `cubeSphere.test.ts`                                                                                                  | Node        | WP1     | Direction → face → direction to 10⁻¹²; texel solid-angle ratio across a face ≤ 1.42; gutter texels equal the neighbor face's interior directions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cloudFrames.test.ts`                                                                                                 | Node        | WP1     | One anchor for two eyes in one snap cell; a whole-texel move yields exactly the exposed strips; a toroidal rebuild after a move equals a fresh build; `previous` null rebuilds every level; `along` against float64 dot products; cascades scroll toroidally with texel centers fixed in body-fixed space, re-orient past 0.05°, and go stale on a jump                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `cloudBudget.test.ts`                                                                                                 | Node        | WP1     | Extents at 1080p, Retina, temporal Quality, supersample and portrait; the long-edge cap; `textureBytes` against hand counts for every resource in §3.19, at one level                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cloudOverlap.test.ts`                                                                                                | Node        | WP1     | The five properties of §5.7, fast-check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/game/src/render/cloudFrame.test.ts`                                                                             | Node        | WP1     | Served body: inside an air, then the largest by angular radius, then forced; heights against float64 with no cancellation; the sun equals TerrainPatches' formula, and under `scrub` turns 45° for 3 h on Earth; `scrub` and `warp` times; `fly`'s path and its fixed step; `cut` rebuilds and is immediate; the drift's hourly wrap is a jump; `frameSeconds`; jump, resize, key and motion resets; `null` when off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/ingest/src/mie.test.ts`, `mieTable.test.ts`, `mieTable.slow.test.ts`, `packages/rendering/src/mieTable.test.ts` | Node, slow  | WP2     | §6.6, Laven's rings and the table's glory included                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cloudSplit.gpu.test.ts`                                                                                              | GPU         | WP3     | **The split's order**: a quad drawn before the split writes depth, `cloud depth` inside the split reads it (this frame's, not the last), and a draw after the split lands on what was there (load ops); a compute inside `during` leaves the resumed half drawing into the scene target; the pass labels (`timestamp-query`): `scene, cloud depth, …, scene over clouds`, and with a full sea sheet `scene, scene after copy, …, scene over clouds`; the renderer's state restored after a throw inside `during`; the frame node inert outside a frame (a `compileAsync` of the composite runs no cloud work)                                                                                                                                                                                                                                                                                                                                                                          |
| `cloudOverPass.gpu.test.ts`                                                                                           | GPU         | WP3     | Pass B loads and does not clear; only OVER objects draw in it; lights on all layers rebuild no pipeline; a compute issued from the composite's `updateBefore` inside pass B executes before its draws; a camera that does not test layer 1 compiles nothing on a marked object, and one that does compiles it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `cloudDepth.gpu.test.ts`                                                                                              | GPU         | WP3     | A depth step (near in the top half, far in the bottom) reads back near on the copy's top rows through `traceScreen`/`screenTexel`; the copy is distance along the ray (the corners differ from view z by their cosine); far depth stores the clamp; warmed against the tied multisampled depth, no pipeline at the first draw                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/rendering/src/weatherNoise.test.ts`                                                                         | Node        | WP4     | The CPU noises tile at their periods; `pcg4d` lattice hashes are the reference's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cloudNoise.gpu.test.ts`                                                                                              | GPU         | WP4     | Baked base, detail and curl against `weatherNoise` at 1,000 points (1/255 + 10⁻⁵); tiling at the period; one mip level                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cloudMaps.gpu.test.ts`                                                                                               | GPU         | WP4     | Cube atlas texels against `scenarioCoverage` (1/255); gutter continuity across all 12 edges; four MRT targets written by one quad; warmed by `warmSensorPass` with no pipeline built on the first draw                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cloudClipmap.gpu.test.ts`                                                                                            | GPU         | WP4     | A toroidal strip update after a move equals a full rebuild; levels baked from the cube; lookups against the CPU projection, eye-relative, to 2 cm; the fade band reads two levels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `cloudDensity.gpu.test.ts`                                                                                            | GPU         | WP4     | `fieldMedium`, `synopticMedium` and `analyticMedium` against the CPU reference at sampled points; the synoptic medium nonzero at a point 1,800 km from the eye under a uniform scenario; `sweepMedium` makes `sweepReads` base fetches and one of `sweepExtra`'s (counted in the WGSL); **the `.level(0)` structure test**: a fragment material running `fieldMedium` in a `Loop` with `Break` compiles to WGSL with no bare `textureSample(` and with `textureSampleLevel` for every texture read, and a variant built in the test with one plain `.sample()` does contain `textureSample(`, so the assertion can fail                                                                                                                                                                                                                                                                                                                                                                |
| `cloudVolume.gpu.test.ts`                                                                                             | GPU         | WP5     | Bake against the injected field at texel centers (the √ encoding's bound); guard slices duplicate their level's edge; the dilated bound ≥ every trilinear read inside its brick; one cloudy texel at a brick's corner that no ray direction skips (1,000 directions through the neighboring bricks); `brickExit` lands on the brick's far face within 0.5 m; toroidal update equals rebuild                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cloudSunDepth.gpu.test.ts`                                                                                           | GPU         | WP5     | Cascades and grid on a uniform slab: τ = σ·thickness/μ_sun within 2%; the Beer form at the front and past the back; **a low sun (5°) through the anvil's union**: the front depth's error, in optical depth at σ_max, ≤ 0.05 with the pair, and a single half float built in the test exceeds it; toroidal scroll equals rebuild; re-orientation one cascade a frame; no frame over `SUN_DEPTH_FRAME_CAP`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `cloudLight.gpu.test.ts`                                                                                              | GPU         | WP5     | `sunThroughAt` equals `sunThrough` at the same point within 10⁻⁴; `airMediumAt` reproduces `marchAir`'s terms (a one-sample march); `CloudPhase` lookups equal `samplePhase` at 200 angles × 5 radii                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `materials.gpu.test.ts`, `atmosphereSky.gpu.test.ts`, `surfaceVisibility.gpu.test.ts` (existing)                      | GPU         | WP5     | Unchanged; the gate for `air.ts`, whose `marchAir` WP5 does not touch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cloudTrace.gpu.test.ts`                                                                                              | GPU         | WP6     | **First:** all nine kernels compile against the stand-ins, and the WGSL binds ≤ 16 sampled and ≤ 4 storage textures each. Injected slab: `T_c = e^(−σL)` to 10⁻⁴; **step-split invariance**: a layer's T and light unchanged as `maxSteps` and step sizes vary, which the plan asks for; the half-clear τ 20 case gives 0.5, with a per-step-mixed variant built in the test failing it; early exit; two slabs give knots at their entries and exits, written through `finiteOr`; outputs finite on a ray with no lit cloud and on a level ray from an eye on a boundary; **the immediate regime** writes every history pixel exactly once over its four dispatches and nothing outside the trace's extent (a guard texel in a test texture one texel wider stays untouched); `B` takes the sky beam on a sky texel and the cleared beam on a surface texel under Enhanced; the sweep kernel takes exactly `fixedSteps` steps (stats mean = max); jitter deterministic per frame index |
| `cloudFar.gpu.test.ts`                                                                                                | GPU         | WP7     | A uniform slab marched by each candidate equals the fine march to 10⁻³; the atlas bake against the CPU integration of fraction and τ; depth moments of one slab; one block a frame, one pass; `B` with the class's beam                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `cloudHistory.gpu.test.ts`                                                                                            | GPU         | WP8     | **NaN guard**: a test-only uniform poisons one trace texel, the history and the composite stay finite, and the texel recovers within 4 frames; resets on the picture key, resize and jump; a stationary scene converges to the trace mean within 1% in 32 frames; a turning body keeps a feature at its body-fixed place; the wind moves a feature by `wind·frameSeconds` under warp; the immediate kernel writes exactly phase k's pixels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cloudComposite.gpu.test.ts`                                                                                          | GPU         | WP9     | **Off changes nothing**: with no cloud (T_c = 1, L = 0) the frame equals the scene bitwise, after `setSceneExposure` at a gain other than 1; T_c = 0 gives the analytic cloud at that gain (applied once); `reactive` = opacity; `motion.a` = opacity; `motion.z` equals an opaque surface's at the same depth; `meterMask` kept; discards where nothing draws; **the class**: a sphere pixel seen from 400 km at the real 512 × 256 tessellation is surface, a limb pixel and a moon behind the limb are sky; **Φ weights the whole term**: a near opaque quad in front of a far slab reads back as the quad alone; under Enhanced the cleared T dims `L_c` only on surfaces and `B` keeps the physical T; the composite at a screen position reads the history texel `screenTexel` gives (a row-ramp history)                                                                                                                                                                        |
| `cloudCompositeAir.gpu.test.ts`                                                                                       | GPU         | WP9     | Each split march equals `marchAir` over the same segment, in uniform control flow, to 10⁻⁵; the structure test (no bare `textureSample(`) over the composite's material                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `cloudFront.gpu.test.ts`                                                                                              | GPU         | WP9     | §5.12: the transparent object between two layers, both lightings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cloudCompositeError.gpu.test.ts`                                                                                     | GPU, opt-in | WP9     | §8.6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/rendering/src/exposure.test.ts` (existing), `atmosphere.test.ts` (existing)                                 | Node        | WP10    | §7.3; the anchor imports the constant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scripts/clouds/measure.test.mjs`                                                                                     | Node        | WP10    | The runner's pure parts: the argv it builds per scenario, the fit of §8.4 on synthetic data, the pass budget from a frame's count, the quiet check on a sample process table, table formatting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cloudSystem.gpu.test.ts`                                                                                             | GPU         | WP11    | The run order: §4.2's labels for both regimes and both placements; every texture the resources list has one level, and each resource's declared bytes equal its GPU textures'; a far texel 1,800 km from the eye bakes nonzero coverage through the real synoptic medium; the whole chain with a depth step: the trace's top rows stop at the near depth; the structure test over every cloud fragment material, the real bakes included                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cloudWarm.gpu.test.ts`                                                                                               | GPU         | WP11    | After `system.warm()`, the first frame of each lever set in the decisions batch changes neither `pipelinesBuilt()` nor `computePipelinesBuilt()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cloudSensor.gpu.test.ts`                                                                                             | GPU         | WP11    | **Off by default** at the sensor: with `{ clouds }` and the levers off, labels, `info.calls` and pixels equal a sensor built without the option; with levers on, both placements produce §4.2's labels; `sensor.gpu.test.ts:237–278`'s call count holds when off; the overlays' warm-ups compile at boot with the marks applied                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/devtools/src/clouds.test.ts`                                                                                | Node        | WP11    | `cloudsSettled`: null off; pending while any cache is pending or `sinceReset < 16`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cloudFarCompare`, `cloudSunAccuracy` `.gpu.test.ts`                                                                  | GPU, opt-in | WP12    | §8.6, on the real field                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Every package's correctness tests drive its module with analytic media bound
through the stand-ins (§3.5). None reads LFS or a plate: CI's GPU job checks
out without LFS.

---

## 10. Docs

### 10.1 The ADRs

Re-list `docs/adr/` when writing. A sibling branch can take a number first.
0063 is free on this tree. Each title states the decision in house voice. Where
the decision depends on the measurement, both forms are given and the
measurement picks one.

| ADR      | Title (house voice)                                                                                                                                                                                                   | Records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0063** | If A: _The weather draws between a scene pass under the clouds and one over them, on compute passes the timeline names_. If B: _The weather draws in a split of the scene pass, on compute passes the timeline names_ | The placement, against the other and against C, with the empty split's figure and the CPU traversal's (`sensor` span and late frames). Compute for the trace and history, quads for the bakes, one storage-texture helper with no mip chain. The frame schedule (§4.2) and the frame node driving it from inside an open render under both placements. The composite's ΔL identity (§5.11), the class by the shell's own depth test, the class-matched blocked air, the share in front of a ridge, the air-reproduction rule by class, the measured residuals, Enhanced off and on, and the regimes the thin form is allowed in. The knots and `cloudFront`. The immediate regime in four phase dispatches. §9's frame rows as measured on the mini at both sizes (trace, history, composite and split, the depth copy, totals on the ground and from orbit, reset frames as the larger of cut and scrub, fly frames). The frame path's declared memory. Cold compile, on a fresh Chrome profile, the OS cache stated. What is declared: velocity under temporal FSR, the hull's missing air, the ring in front of a cloud. If A wins, the OVER-layer rule and that it applies only under the flag |
| **0064** | _The clouds march_ [the field \| a baked volume] _and the sun's depth is_ [scrolled cascades \| a grid summed through the volume], _and the far field marches_ [a layer atlas \| spheres at the layers' heights]      | The cache and sun-depth choice as one 2 × 2 and why (the grid needs the volume), the far-field choice, each against its alternatives: the far comparison's four cases by footprint-averaged error, the sun-accuracy table at five scenarios and two suns, the cache's cost and image difference, the fly and reset frames. `levels` decided by its memory, with the arithmetic (§1.3). The sun-depth refresh policy and its shared cap, and the cascade's front depth as a half-float pair. The maps' layout, packing, refresh and coverage sources (the cube for the far bakes, the analytic function for a second body). The noise bake (fragment slices, no tier-1 storage) and the premise spike's outcomes. §9's rows for maps, far, volume and sun depth. Memory. The sweep's fetch rate from one read type, each other type's marginal cost, and R8 against RGBA8. The losers, and the branch commit they were measured at                                                                                                                                                                                                                                                                  |
| **0065** | _A scene unit is the sun above the air, and the sensor's white is half a stop under it_                                                                                                                               | §7: the investigation's table, (a)–(c), the pinning tests, the recorded defects, the Enhanced rule for absolute emitters, and that no picture moved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **0066** | _The droplets' phase is Lorenz–Mie at one narrow width, generated offline into the rendering package_                                                                                                                 | §6: the series, the gamma at v = 0.01, the bands at the air's wavelengths, the angle warp, the file's form and size, why not HG–Draine for first order (the glory, after Jendersie and d'Eon §2), Laven's rings as white-light color and not band intensity, the two glory tests and their measured offsets, the small rows' extinction above 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

In the same change, per the documents rule and the ADR skill:

- one row each in `docs/adr/README.md`'s table;
- one entry each at the end of `scripts/docs/wings.mjs`'s "Decision Records":
  `['docs/adr/0063-<slug>.md', 'The weather's frame']`,
  `['…0064…', 'The clouds' caches']`, `['…0065…', 'The scene unit']`,
  `['…0066…', 'The droplets' phase']`. Without them `pnpm docs:build`, and so
  `pnpm check`, fails.
- If ADR-0063 makes an invariant (the OVER layer under A), the imperative also
  goes in `AGENTS.md`, `.claude/rules/rendering.md`, and a numbered rule in
  `docs/agents/invariants.md`, with the Cursor adapter's globs kept in step.

### 10.2 The plan loses its decided sections (rule 47)

`design/plans/the-weather.md` then reads as follows.

| Section                                                                                                                          | Change                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Where the numbers come from"                                                                                                    | It names the mini and cites ADR-0063 and ADR-0064 for every measured figure                                                                                                       |
| §4.8's resources table                                                                                                           | Becomes the measured sizes and packing, citing ADR-0064, plus the rows not built (probe, history beyond phase 0)                                                                  |
| §5.2's first bullet ("Phase 0 measures both")                                                                                    | The decided cache, citing ADR-0064                                                                                                                                                |
| §5.4's candidates and alternatives paragraph                                                                                     | The decided far field, citing ADR-0064; the cross-fade stays as phase 1's                                                                                                         |
| §5.6's placement paragraph ("So the two candidates are…") and the thin form's "used only where phase 0's measurement… allows it" | The decision and the allowed regimes, citing ADR-0063                                                                                                                             |
| §6.1's "Two candidates, measured in phase 0"                                                                                     | The decided sun depth, citing ADR-0064                                                                                                                                            |
| §8.3                                                                                                                             | Removed, citing ADR-0065                                                                                                                                                          |
| §9                                                                                                                               | The table's measured rows carry the mini's figures with ADR citations; the unbuilt rows stay targets with the phase that measures them; the "Phase 0 replaces each" sentence goes |
| §10's row 0                                                                                                                      | "Landed: ADR-0063–0066"                                                                                                                                                           |
| §12's "A split costs a tile store"                                                                                               | Replaced by the measured split, or removed                                                                                                                                        |
| §5.3 "The tables."                                                                                                               | Cites ADR-0066 for the droplets; ice and rain stay phase 1's                                                                                                                      |

### 10.3 `CONTEXT.md`

One entry, placed immediately before `## Known gaps` (line 13209 today):

`## The weather's frame is measured on the Mac mini, and its four choices are made (DD Nov 2026)`

It carries what landed, the decisions and the alternatives they beat (linking
the ADRs, not restating them), the figures with their conditions, and what was
tried and rejected. For instance: the fixed in-cloud step that took thousands
of steps through a grazing cirrus; the cube read a step, dropped for the
clipmap within the binding budget.

Where a phase-0 test caught a defect, an item goes under
`## Bugs the tests found`. Candidates are the encoder swap's ordering, a plain
`sample()` in a loop, a NaN in the history, a storage texture's mip chain, and
a warm-up compiling nothing on an object its camera's layers did not test.

### 10.4 Docs that change with the code

| File                                                                           | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/guides/harness.md`                                                       | The `ir.passes` label list (`:667–676`) gains §4.4's labels, and the note that a cloud frame's pass count sets how many frames a read can take. A "Measuring the weather" section covers `?clouds=1`, `engine.clouds` levers, `ir.clouds()` and its `settle`, `force`, the runner, the quiet check, the profile deletion and the measurement tests. The generated-data section (`:145–154`) gains the Mie generator's two commands. Settling is unchanged: clouds join `ir.settled()` in phase 1 |
| `docs/agents/driving.md`, `.claude/skills/drive/SKILL.md`, `scripts/drive.mjs` | Unchanged in phase 0: their `--settle` text changes with `ir.settled()`, in phase 1                                                                                                                                                                                                                                                                                                                                                                                                              |
| `design/plans/the-air.md`                                                      | §7's recorded conversion defect and the Enhanced emitter rule                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `docs/concepts/rendering.md`                                                   | Unchanged in phase 0: nothing ships on by default. Phase 1 writes the weather's concept section                                                                                                                                                                                                                                                                                                                                                                                                  |

---

## 11. Work packages

### 11.0 Rules for every package

1. **Base.** Branch from the base its wave names (§11.3), in a worktree. First
   run `pnpm install --frozen-lockfile --prefer-offline`, then read the
   `.claude/rules/*.md` files whose `paths:` match the package's files.
   SessionStart does neither for a worktree subagent.
2. **Own only the listed files.** Anything else is a request to the
   orchestrator. A file a package does not own is read-only to it, its base's
   included. No two packages of one wave own one file, and no file changes
   owner inside a wave.
3. **Build against the contracts; test with analytic media bound through the
   stand-ins (§3.5).** A package's tests may import what its base already holds
   (the contracts package, and wave 1's packages for wave 2), never a sibling's
   implementation in flight. Integration (WP11) is the first place the wave-2
   modules meet, and the instruments that need the real field come after it
   (WP12).
4. **GPU tests** run as `IR_GPU_WAIT=900 pnpm vitest run --config apps/game/vitest.gpu.config.ts <names>`.
   That takes the machine's lock and queues behind other worktrees (rule 68).
   No browser, no `drive.mjs`: browser measurement is serialized after
   integration, with no package in flight (§8.1).
5. **Commit each reversible step** in the house voice with an extended body
   (STYLE.md). The Stop hook's gate runs after every turn that touches a
   `.ts`/`.mjs`/`.json`. Prettier runs on tool edits. A file written by a script,
   the generated Mie table among them, gets `pnpm exec prettier -w <file>`.
6. **Report:** the done command's output, the files changed, any contract a
   package needed and did not have, and every figure stated as measured or not
   measured.

### 11.1 The contracts package (C, wave 0)

One agent, before everything, on the phase-0 branch. It compiles, typechecks
and passes `pnpm check --only gate`. The code blocks above were formatted by
prettier's defaults outside the repository; the package writes them in the
house style (single quotes, no semicolons), which the format hook applies on
write.

**Real, and C's to keep:**

| File                                                                          | Content                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/game/src/render/cloudLevers.ts`, `cloudLayers.ts`                       | §3.4 in full                                                                                                                                                                                                                                                                       |
| `apps/game/src/render/cloudNodes.ts`                                          | §3.5 and §3.7's types; `traceJitter`, `finiteOr`, `cloudStorageTexture`, `cloudStorage3DTexture`; `CLOUD_STAND_INS`, each binding its real module's textures (§3.7's inventory) as 1 × 1 targets of the real format and kind, and returning analytic media a test can parameterize |
| `apps/game/src/render/cloudUniforms.ts`                                       | §3.5 in full, `write(frame)` included: it is a mechanical copy of `CloudFrame`'s fields, compare-first                                                                                                                                                                             |
| `apps/game/src/render/cloudGeometry.ts`                                       | §3.5b in full: every GPU package forms its rays and heights with it, so a stub would leave each to reimplement it                                                                                                                                                                  |
| `packages/rendering/src/atmosphere.ts`                                        | `aerosolDepthOf`, and the recipe's own line calling it                                                                                                                                                                                                                             |
| `apps/game/src/render/air.ts`                                                 | §3.6's additive edits: exports, the optional level read, `sunThroughAt`, `crowdedSamples` exported, `createAirUniforms({ ownStandIns })`, `airMediumAt` as a stub returning zeros. `marchAir` and `airToward` untouched. WP5 then owns the file, for `airMediumAt`'s body alone    |
| `apps/game/src/render/warmup.ts`, `passTimeline.ts`, `gpuHarness.ts`          | §3.18                                                                                                                                                                                                                                                                              |
| `packages/rendering/src/index.ts`, `packages/devtools/src/index.ts`           | `export *` lines                                                                                                                                                                                                                                                                   |
| `apps/game/src/render/cloudContracts.test.ts`, `cloudLevers.test.ts`          | §9                                                                                                                                                                                                                                                                                 |
| `apps/game/src/render/cloudGeometry.gpu.test.ts`, `cloudPremises.gpu.test.ts` | §9; the second is the premise spike below                                                                                                                                                                                                                                          |

**Stubs, each handed to the package §2.2 names:** every other new file of §2.2.
`weatherScenario.ts` carries §3.1's constants and scenario table in full,
`shellUnion` and `wetWorld` real, and `scenarioCoverage → s.layers[layer]?.coverage ?? 0`,
`genusProfile → h01 in (0, 1) ? 1 : 0`. The other WP1 modules carry §3.2's types
and constants and throw `new Error('not yet: WP1')`, except `cloudExtents` and
`textureBytes`, which are real one-liners other packages size against.
`mieTable.ts` carries §3.12's `MieTable` type and a decoder of the stub table;
`mieDroplets.generated.ts` is a valid tiny table (8 angles × 2 radii × 3 bands,
isotropic `p = 1/(4π)`, bulk `[2, 1, 0]`, `gloryRed` `[0, 0]`), encoded as the
real one is. `cloudFrame.ts` carries §3.3's types, `cloudFrame → null`. Every
GPU module carries §3's classes and functions with neutral stubs: a resource
has `bytes 0`, `textures() → []`, `pending false`, `warm` resolving, `render`
doing nothing; a TSL function returns its neutral node through the stand-ins,
so a kernel compiled against a stub binds what the real one will;
`splitScenePass → false`; `createCloudSystem` returns an inert system whose
report is `available: true, on: false`. `packages/devtools/src/clouds.ts`
carries §3.17's types and `cloudsSettled → null`.

**The premise spike** (`cloudPremises.gpu.test.ts`, under the lock). Every
premise a format or a placement depends on is settled here, before anything
branches, and each outcome and its fallback go in the contracts commit's body
and, where a fallback changes a contract, into the contracts before wave 1:

| Premise                                                                                                                                                                                                                                    | If it fails                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `RenderTarget3D` slice takes a fragment draw, and `warmSensorPass` warms it                                                                                                                                                              | The noise and the volume bake by compute into `cloudStorage3DTexture`, which needs `texture-formats-tier1` for R8 and RG8 (tests skip without it) and RGBA8 without, at twice the memory |
| A 2D-array target takes one MRT quad with `fragmentNode = mrt(…)`, and `warmSensorPass` warms it                                                                                                                                           | The maps and the clipmap draw four single-target passes where they drew one (the pass budget of §4.4 recomputed)                                                                         |
| A compute and a render issued from a mesh's `updateBefore` inside an open render execute in the order issued and leave the outer render's context and target intact, both inside a pass-B-like render (A) and inside a split prototype (B) | The trace and the history become fragment passes, the trace's 72 B a texel split over three 24 B MRT passes, nested as the scene pass itself is                                          |
| The encoder swap: a draw before, a compute during and a draw after a split execute in that order                                                                                                                                           | B is not built; ADR-0063 records why, and A is measured against off alone                                                                                                                |
| `uniform(new Vector2(), 'uvec2')` builds                                                                                                                                                                                                   | Two floats under 2²⁴ carry the low halves, enough for phase 0's blobs                                                                                                                    |
| A `cloudStorageTexture` written by compute and then sampled has one level and draws no mip pass                                                                                                                                            | No fallback: the package stops and reports                                                                                                                                               |
| `computePipelinesBuilt()` counts a kernel's first dispatch                                                                                                                                                                                 | No fallback: the package stops and reports                                                                                                                                               |

**The WGSL check.** With `read` undefined, every existing caller of the air's
reads builds the node graph it builds today. C confirms it once, under the
lock: the WGSL of the shell, the sphere, the ground and the sea, generated on
`c2a50f1` and on the contracts commit by a scratch test outside the tree, hash
equal; the hashes go in the commit's body.

**Done:** `pnpm check --only gate && IR_GPU_WAIT=900 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudGeometry cloudPremises materials`,
and the WGSL hashes equal. **Size:** about 2,400 lines, the stubs most of them.

### 11.2 The packages

**WP1: the weather's arithmetic** (CPU only; wave 1)

- **Owns** (16): `packages/rendering/src/weatherScenario.ts`, `weatherShells.ts`,
  `weatherClock.ts`, `cubeSphere.ts`, `cloudFrames.ts`, `cloudBudget.ts`,
  `cloudOverlap.ts`, with their seven tests; `apps/game/src/render/cloudFrame.ts`
  and `cloudFrame.test.ts`.
- **Depends on:** C.
- **Provides:** every CPU function of §3.1–3.3, to §3.3's rules (the forced
  paths among them) and §5.2–5.4's arithmetic.
- **Done:** `pnpm check --only gate`. **Size:** about 1,700 lines, half of them tests.

**WP2: the Mie table** (CPU, offline; wave 1, merging when done)

- **Owns** (8): `apps/ingest/src/mie.ts`, `mieTable.ts`, `mie.test.ts`,
  `mieTable.test.ts`, `mieTable.slow.test.ts`; `packages/rendering/src/mieTable.ts`,
  `mieTable.test.ts`, and the generated `mieDroplets.generated.ts`.
- **Depends on:** C (the `MieTable` type).
- **Provides:** the real table (§6), the decoder, `samplePhase`,
  `phaseIntegral`, and each row's `gloryRed` from the series.
- **Done:**
  `node apps/ingest/src/mieTable.ts && pnpm exec prettier -w packages/rendering/src/mieDroplets.generated.ts && pnpm check --only gate && pnpm test:slow mieTable`.
  Record the generator's runtime in the file header. **Size:** about 1,000
  lines plus the 270 KB generated file.

**WP3: the placement mechanics** (GPU; wave 1)

- **Owns** (7): `cloudSplit.ts`, `cloudOverPass.ts`, `cloudFrameNode.ts`,
  `cloudDepth.ts`; GPU tests `cloudSplit`, `cloudOverPass`, `cloudDepth`.
- **Depends on:** C (the premise spike has already proven the swap and nested
  work, or named their fallbacks).
- **Provides:** `splitScenePass`, `CloudOverPassNode`, `CloudFrameNode` with
  its driver interface, `CloudDepth`. It runs first among the GPU packages
  because it decides whether B exists.
- **Done:** `pnpm check --only gate && IR_GPU_WAIT=900 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudSplit cloudOverPass cloudDepth`.
  **Size:** about 1,100 lines.

**WP10: the scene unit and the measurement tooling** (CPU; wave 1)

- **Owns** (8): `packages/rendering/src/exposure.ts`, `exposure.test.ts`,
  `atmosphere.test.ts` (the anchor's constant only); `design/plans/the-air.md`
  (the recorded defect); `scripts/clouds/measure.mjs`, `page.mjs`, `diff.mjs`,
  `measure.test.mjs`.
- **Depends on:** C (the lever and report types, as data); `scripts/gpuLock.mjs`;
  `scripts/drive.mjs`'s CLI.
- **Provides:** §7, and §8's runner with the quiet check, the profile deletion
  and the pass budget, ready for §11.3's measurement.
- **Done:** `pnpm check --only gate`, which includes `scripts/**/*.test.mjs`.
  The runner is exercised for real only after integration. **Size:** about
  1,200 lines.

**WP4: the field on the GPU** (wave 2)

- **Owns** (11): `packages/rendering/src/weatherNoise.ts` and its test;
  `cloudNoise.ts`, `cloudProfile.ts`, `cloudMaps.ts`, `cloudClipmap.ts`,
  `cloudDensity.ts`; GPU tests `cloudNoise`, `cloudMaps`, `cloudClipmap`,
  `cloudDensity`.
- **Depends on:** C, WP1 (level frames, the cube-sphere, scenario coverage).
- **Provides:** `CloudNoise`, `CloudProfile`, `CloudMaps` with
  `scenarioCoverageNode`, `CloudClipmap`, and the four media.
- **Done:** `pnpm check --only gate && IR_GPU_WAIT=900 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudNoise cloudMaps cloudClipmap cloudDensity`.
  **Size:** about 2,600 lines.

**WP5: the volume, the sun's depth and the light** (wave 2)

- **Owns** (9): `apps/game/src/render/air.ts` (`airMediumAt`'s body only);
  `cloudVolume.ts`, `cloudSunCascades.ts`, `cloudSunGrid.ts`,
  `cloudSunlight.ts`, `cloudPhase.ts`; GPU tests `cloudVolume`, `cloudSunDepth`,
  `cloudLight`.
- **Depends on:** C, WP1 (level frames and cascades); the stub Mie table until
  WP2 merges.
- **Provides:** `CloudVolume` (`medium`, `bound`, `brickExit`), both
  `CloudSunDepthNodes` under the shared cap, `cloudSunFn`, `CloudPhase`,
  `airMediumAt`.
- **Done:** `pnpm check --only gate && IR_GPU_WAIT=900 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudVolume cloudSunDepth cloudLight materials atmosphereSky surfaceVisibility`.
  **Size:** about 2,400 lines.

**WP6: the trace** (wave 2)

- **Owns** (4): `cloudMarch.ts`, `cloudKnots.ts`, `cloudTrace.ts`; GPU test
  `cloudTrace`.
- **Depends on:** C, WP1.
- **Provides:** `CloudTrace` (the eight kernels and the sweep kernel, the
  immediate regime's phase dispatches, stats), `cloudMarch`, `cloudSweepMarch`.
- **First test:** every kernel compiled against the stand-ins, its bindings
  counted in the WGSL.
- **Done:** `pnpm check --only gate && IR_GPU_WAIT=900 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudTrace`.
  **Size:** about 1,900 lines.

**WP7: the far field** (wave 2)

- **Owns** (4): `cloudFar.ts`, `cloudFarAtlas.ts`, `cloudFarSpheres.ts`; GPU
  test `cloudFar`.
- **Depends on:** C, WP1. It meets the trace only through `CloudFarFn`.
- **Provides:** `createFarField` for both kinds and the second body's atlas.
- **Done:** `pnpm check --only gate && IR_GPU_WAIT=900 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudFar`.
  **Size:** about 1,300 lines.

**WP8: the history** (wave 2)

- **Owns** (2): `cloudHistory.ts`; GPU test `cloudHistory`.
- **Depends on:** C, WP1.
- **Provides:** `CloudHistory`: four kernels, the reset, the report.
- **Done:** `pnpm check --only gate && IR_GPU_WAIT=900 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudHistory`.
  **Size:** about 900 lines.

**WP9: the composite** (wave 2)

- **Owns** (7): `cloudCompositeAir.ts`, `cloudComposite.ts` (the residual meter
  included), `cloudFront.ts`; GPU tests `cloudComposite`, `cloudCompositeAir`,
  `cloudFront`, `cloudCompositeError` (an instrument on analytic slabs).
- **Depends on:** C, WP1, WP3 (the frame node and the depth copy's contract).
- **Provides:** `CloudComposite`, `compositeAir`, `skyClass`, `cloudFront`.
- **Its tests build a minimal scene and sensor-like target themselves:** a
  `RenderTarget` of the scene layout, an `installSceneOrder` renderer from
  `openGpu`, and synthetic trace and history textures (`DataTexture`s,
  `StorageTexture`s written by a test kernel).
- **Done:** `pnpm check --only gate && IR_GPU_WAIT=900 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudComposite cloudCompositeAir cloudFront`.
  **Size:** about 1,800 lines.

**WP11: integration** (wave 3, after WP1–WP10 merge)

- **Owns** (23): `apps/game/src/render/cloudSystem.ts`; GPU tests
  `cloudSystem`, `cloudWarm`, `cloudSensor`; `render/sensor.ts`,
  `scene/Sensor.tsx`, `App.tsx`, `engine/GameEngine.ts`, `pages/paths.ts`;
  `scene/Bodies.tsx`, `CameraRig.tsx`, `ThrusterFx.tsx`, `SunFlare.tsx`,
  `WarpFx.tsx`, `EntryTrace.tsx`, `OrbitTraces.tsx`, `CinematicStage.tsx`;
  `packages/devtools/src/clouds.ts` and its test, `host.ts`, `harness.ts`,
  `harness.test.ts`; and `cloudContracts.test.ts`, which it deletes.
- **Authority over every cloud module for integration failures.** A warm miss,
  a binding over the limit or a seam that does not meet is WP11's to fix in the
  module where it lives, each fix its own commit naming the defect, with that
  module's own tests re-run beside the integration's. The owning package is
  done; nobody else is editing the file.
- **Work:** §4.1 and §3.17 wired; the system calling every module in §3.16's
  order with its budget; the chunk resolved in the renderer factory; the marks,
  the camera's mask and the lights' masks under the flag; the B orders under
  the lever; the deck's yield and `deck: 'hidden'`.
- **Done:** `pnpm check` (full) `&& IR_GPU_WAIT=900 pnpm test:gpu` (full).
  **Size:** about 1,600 lines.

**WP12: the measurement instruments** (wave 4, after WP11)

- **Owns** (2): `cloudFarCompare.gpu.test.ts`, `cloudSunAccuracy.gpu.test.ts`.
- **Depends on:** WP11: they import the real media, maps, clipmap,
  `WEATHER_SCENARIOS` and far fields, because the far-field and sun-depth
  choices must be scored on the field they will draw.
- **Done:** `pnpm check --only gate && IR_CLOUD_MEASURE=1 IR_GPU_WAIT=900 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudFarCompare cloudSunAccuracy`
  writes both JSON files with finite figures. **Size:** about 700 lines.

**Who touches which existing file.** Every existing file has one owner, and the
only handoff is `air.ts`, from C (additive edits) to WP5 (`airMediumAt`'s body):

- C: `air.ts` (then WP5), `atmosphere.ts`, `warmup.ts`, `passTimeline.ts`,
  `gpuHarness.ts` and the two `index.ts` files;
- WP10: `exposure*`, `atmosphere.test.ts`, `the-air.md`;
- WP11: every wiring file;
- the docs step: docs only.

### 11.3 The order of work

1. **Wave 0: C.** Its done command, the premise spike's outcomes and the WGSL
   hashes, in the contracts commit.
2. **Wave 1: WP1, WP2, WP3 and WP10**, in parallel worktrees from C. WP1 and
   WP3 merge first, then the gate; WP2 and WP10 merge when they are done, which
   may be during wave 2, since nothing in wave 2 needs them.
3. **Wave 2: WP4, WP5, WP6, WP7, WP8 and WP9**, in parallel worktrees from
   wave 1's merge (C + WP1 + WP3). They are disjoint by construction, so a
   conflict means a package broke its ownership. Merge in that order, then the
   gate.
4. **Wave 3: WP11.** The gate, then `IR_GPU_WAIT=900 pnpm test:gpu`.
5. **The full suite on the mini.** `pnpm check` (full, docs and bundle included)
   and `pnpm test:gpu`. Then `pnpm presets:compare --all`, which must report
   **0 moved** (the no-flag path), and `pnpm presets:ledger`, which must show no
   diff.
6. **Wave 4: WP12.**
7. **The choices' measurement**, one serialized job on the mini under one lock,
   with no implementation agent in flight: `pnpm build`, `pnpm preview`, then
   the batches `decisions` and `sweep` and the GPU measurement tests (§8.8).
8. **Decide and land.** Apply §8.7's rules to step 7's tables. One commit, the
   landing step's, deletes the losers (§1.6: code, levers, kernels, tests and
   warm entries) and sets the winners as `DEFAULT_CLOUD_LEVERS`, then the gate
   and `test:gpu`. The ADRs cite step 7's commit for every choice's figures,
   where the losers can be re-measured, and this one for what ships.
9. **The landed code's figures:** rebuild, then `targets`, `memory` (cold
   compile counts only the pipelines that ship) and `error`.
10. **Record.** `chore(clouds): phase 0's figures, measured on the Mac mini`,
    with the runner's summary tables in the body. The raw JSON stays in
    `.data/clouds/`, which is gitignored and so outside `format:check`.
11. **Docs (§10).** The ADRs, README rows, `wings.mjs`, `CONTEXT.md`, the plan's
    edits and the harness guide.
12. **Ship.** `pnpm check`, `pnpm test:gpu` and `presets:compare` (0 moved),
    then `/ship` opens the PR the stack's next phase branches from.

## 12. Risks and open questions

### 12.1 Needs the user

None of these stops wave 0. They are recorded so that a different preference
can redirect the work before it is spent.

1. **The far field's `levels` is decided on paper** (§1.3), by the memory
   clause the far-field rule fixes in advance: reaching the limb takes a sixth
   level, and its far levels alone are 2.8 times the atlas. The plan names it
   as an alternative to be chosen against. If it should be built and measured
   anyway, say so before wave 2: it adds three volume levels, a far-levels
   march and four trace kernels, and the memory clause would still exclude it.
2. **Cold compile is measured on a fresh Chrome profile with the OS's Metal
   cache possibly warm** (§8.5). Clearing that cache means deleting files under
   the user's own cache directory for Chrome's GPU helper, which this design
   does not do unasked. Say so if truly cold figures are wanted.
3. **The measurement holds the mini for about 4.5 hours** (§8.8), serialized,
   under the GPU lock, with no implementation agent running, so its CPU figures
   are not perturbed.
4. **The second clouded body's far march.** Phase 0 draws it in the composite:
   no sphere-pipeline change, and the limb overhang comes for free. Phase 1
   needs a sphere-material far march for WebGL anyway (plan §11, decision 3).
   ADR-0063 proposes keeping both or moving it. That is a phase 1 decision.
5. **The losers are deleted before landing (§1.6).** A user who wants them kept
   behind levers for re-measurement says so before step 8 of §11.3. The default
   is deletion.
6. **`?clouds=1` works in production builds,** as `producer=cpu` does. It is a
   diagnostic anyone can type, and it draws nothing until `engine.clouds.on`.

### 12.2 Risks, and what checks each

1. **The premises a format depends on** (a `RenderTarget3D` slice draw, a
   2D-array MRT quad, their warm-up, nested work inside an open render under
   both placements, the encoder swap, a `uvec2` uniform) are read from three's
   source, not run. The premise spike settles each before anything branches,
   and each has a named fallback (§11.1), so no package learns a format after
   another has built on it.
2. **The `velocity` row under temporal FSR.** The composite cannot blend into
   it. The upscaler plan's decided fix, FSR reading the masked `motion.rg` and
   the row removed, has not landed. Phase 0 measures temporal pictures with the
   composite's `velocity` written where it draws and discarded where it does
   not: a threshold edge, declared. **Phase 1 must not ship clouds under a
   temporal picture before that fix lands.**
3. **Binding limits.** Three requests no `requiredLimits`
   (`createRenderer.ts:180–193`), so the device has WebGPU's defaults: 16
   sampled textures a stage, counting every texture binding however it is
   read, and 4 storage textures. The trace binds 13 (15 with the volume) and
   writes 4, which leaves no room for a fifth output; the immediate regime is
   shaped by that (§5.14). WP6's first test counts the bindings in the WGSL.
   Raising limits would change both `createRenderer.ts` and `gpuHarness.ts`;
   that is a decision for the orchestrator if a package hits the ceiling.
4. **The split reaches below three's surface.** It uses the sea's internals plus
   the encoder swap, the code a three upgrade breaks first (plan §12).
   `cloudSplit.gpu.test.ts` pins its order, its labels and the renderer's state
   after a throw.
5. **Compute pipelines compile at their first dispatch.** `warmCompute` moves
   that to boot. While the choices are measured, nine trace kernels, four
   history kernels, the bound, the stats and the residual compile synchronously on the main thread at
   warm; after landing, one trace kernel. `computePipelinesBuilt()` counts
   them, and the cold-compile batch measures the landed set.
6. **The fine march's reach.** The plan's schedule covers about 13 km in 128
   out-of-cloud steps, so a horizon ray inside a 1–2.4 km layer (a chord of
   about 138 km) runs out of budget long before the footprint handover. Such a
   ray hands over at its budget and is not cut short. The far comparison scores
   that handover, and §8.7 sets `maxSteps` from data.
7. **The placeholder's light means nothing.** First order through the Mie
   table, a placeholder sky term and an uncalibrated σ are there for cost and
   structure. Phase 0's images carry no claim about how clouds look. The look
   council is phase 1's.
8. **The Mie references.** Bohren and Huffman's BHMIE values, Hale and Querry's
   index table and Wyman, Sloan and Shirley's CIE fit must be transcribed from
   their sources by WP2. This design quotes none of their digits, because it
   would be quoting from memory.
9. **The scenario stances.** Whether the basin `horizon` stance has the sea in
   view (and so the sea's split), the `rise` framing call for V a and V, and
   each stance's sun were not run in a browser. WP10 verifies each with
   `ir.light()`, `ir.passes()` and a still before the batch, and changes them
   only through the orchestrator.
10. **The preview's identity.** It names no tree. The runner ties the figures
    to the code by the commit, a clean status and `dist`'s time.
11. **The deck's yield lags one frame.** Bodies reads last frame's served
    address. When the served body changes, the deck and the volume overlap for
    one frame, under the lever only.
12. **The forced paths are measurement, not pictures.** Under `fly` the rays
    and the caches follow a synthetic eye the scene's camera does not, so the
    picture is wrong while the cost is the real one. Under `cut`, every frame is
    the first frame after a teleport, so it bounds a real cut's later frames
    from above. Under `scrub` the sun turns with the body but the body's
    orbital motion is left out (0.12° over 3 h on Earth).
13. **The quiet machine.** The lock covers GPU jobs only. The runner's quiet
    check and the rule that measurement runs with no package in flight cover
    the rest; a row taken under load is marked and re-run (§8.1).

### 12.3 Not verified for this design

- **No GPU work, browser or measurement was run.** Every figure in this document
  is computed from dimensions or taken from the plan and the maps: memory,
  sizes, pass counts, step reach, durations and the Mie runtime. The exceptions
  are the three CPU computations of §0.3, which were run.
- **The maps' inferences were not re-run:**
  - MRT byte costs from the WebGPU table;
  - the scene-unit consumers other than the galaxy's;
  - the Retina and 1080p gate heights;
  - the deck's drift sense.

  This design does not depend on any of them, except the scene-unit consumer
  list, which WP10 re-reads before editing.

- **What I re-read:** the three internals listed in §0.3, and for this
  revision the further rows there. Everything else about three is the maps'.
- **The far-shore system's bodies** come from one headless CPU probe in the
  scratchpad, outside the tree. The moon's address `b:4.0` is inferred from
  Luna's form.

---

## Critique log

Two adversarial reviews, by lens: **I** is invariants and pipeline (20
findings), **F** feasibility and measurement (18). Each finding was checked
against the code at `c2a50f1`, three r185's source, the plan, or a computation
run on the CPU (§0.3); the "Checked" column says which. Thirty-seven are
accepted, one in part; none is rejected outright.

| #    | Finding                                                                                                                                                 | Checked                                                                                                                  | Verdict                                | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I-1  | The composite's `src.rgb` carried `sceneRadianceGain` and `sensorRadiance` applied it again: the cloud and the identity's air at the gain's square      | `radiance.ts:95–112`; the shell's `colorNode`, `materials.ts:410–423`                                                    | Accepted                               | §3.16's `output` row and §5.1 drop the gain, which `sensorRadiance` applies once; `cloudComposite.gpu.test.ts` runs its bitwise and `T_c = 0` cases after `setSceneExposure` at a gain other than 1                                                                                                                                                                                                                                                                                                                                                                                                                            |
| I-2  | The immediate regime dispatched at the history's extent into textures sized at the trace's: out-of-bounds stores                                        | The design's §3.2, §3.14, §3.19                                                                                          | Accepted                               | The immediate regime is four phase dispatches at the trace's extent, each followed by a history kernel writing that phase's pixels (§0.2 item 12, §3.14, §3.15, §5.14, §4.2, §4.4). Neither reviewer fix was taken: textures at the history's extent cost 28.0 MB at 1080p and 17.5 MB at Retina, and one kernel writing the history and the knots needs five storage textures where the stage allows four. `CloudExtents.immediate` is gone; `cloudTrace.gpu.test.ts` holds "every history pixel once, nothing outside"                                                                                                       |
| I-3  | `StorageTexture` and `Storage3DTexture` allocate full mip chains, and three regenerates them with unnamed raw passes after each compute write           | `StorageTexture.js:62`, `Texture.js:257`, `Textures.js:295–296, 538–540`, `Bindings.js:407–421`, `Storage3DTexture.js`   | Accepted                               | `cloudStorageTexture` and `cloudStorage3DTexture` in `cloudNodes.ts` turn both flags off (§3.5, §3.7); resources list their `textures()` and declare bytes with levels; `cloudSystem.gpu.test.ts` asserts one level for every texture and declared bytes equal to the GPU textures'; the premise spike tests the helper                                                                                                                                                                                                                                                                                                        |
| I-4  | The sky/surface class used the shell's ground branch, so the inscribed sphere's pixels read as sky, speckled by the R16F depth                          | `materials.ts:344–375`; `Bodies.tsx:156–160, 258`                                                                        | Accepted                               | The class is the shell's own depth test against the outer wall, `F_out = closest + halfOuter`, at 2 × 10⁻³ relative, never the ground branch (§0.2 item 6, §5.11, §5.1); `cloudComposite.gpu.test.ts` adds a sphere pixel from 400 km at the real tessellation, a limb pixel and a moon behind the limb                                                                                                                                                                                                                                                                                                                        |
| I-5  | `B`'s beam was never specified and matches neither class's                                                                                              | `air.ts:737` (`airToward`), `:784–796` (`sunThrough`); `materials.ts:367–375` (no `clearBeam`)                           | Accepted                               | The trace classifies its texel by the same test (`skyClass`) and accumulates `B` with that class's beam (§5.11, §5.5, §3.5's `CloudFarFn`, §3.14's `cloudMarch`); the residual meter counts class disagreements (§3.16, §3.17). Found while fixing it: `B` was dimmed by the cleared `T'_a`, which subtracts more air than the scene drew; it now takes the physical `T_a` (§0.2 item 5, §3.16)                                                                                                                                                                                                                                |
| I-6  | The depth-moment fallback replaced `T_c` only, painting `L_c + B` onto ridges in front of distant cloud                                                 | The design's §5.11 and §3.16                                                                                             | Accepted                               | Φ weights the whole cloud term and `src.a` (§5.11, §3.16), with `L_a(0, min(t₁, D))`; `cloudComposite.gpu.test.ts` reads a near opaque quad in front of a far slab back as the quad alone                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| I-7  | The cascades' half-float front depth from one near plane rounds by ±0.5, ±2 and ±8 optical depths at the cascades' far edges                            | Recomputed: half-float steps of 15.6, 62.5 and 250 m at 19, 69 and 269 km                                                | Accepted, by a third fix               | The front depth is a pair of half floats (value and residual) in R and A, filterable, with validity a per-cascade uniform (§3.12). A depth from each texel's own union entry fails deep unions (23 km behind the anvil's entry is a 15.6 m step again), and `r32float` is unfilterable in core WebGPU. The bake's heights come from `altitudeAt` and `shellCrossingFrom` (§3.5b, §5.2); `cloudSunDepth.gpu.test.ts` adds the 5° anvil case, ≤ 0.05 τ, with a single half float shown failing it                                                                                                                                |
| I-8  | Empty-space skipping was not conservative: no dilation, and a fixed advance from wherever the sample sat                                                | The design's §3.11, §5.6                                                                                                 | Accepted                               | The bound covers each brick and a one-texel border (a 6³ footprint, across guard slices), and a zero advances to `brickExit` (§3.11, §5.6); `cloudVolume.gpu.test.ts` adds a cloudy corner texel no direction skips                                                                                                                                                                                                                                                                                                                                                                                                            |
| I-9  | `gpu.pipelinesBuilt()` counts render pipelines only, so `cloudWarm` could not see a kernel compiling at its first dispatch                              | `gpuHarness.ts:391–420`; `WebGPUPipelineUtils.js:417`                                                                    | Accepted                               | `computePipelinesBuilt()`, a separate counter (an existing sensor test asserts at most one render pipeline after warm, and the meter's kernel compiles in the sensor's frame), in C (§2.3, §3.18, §4.5); `cloudWarm` and `cloudSensor` assert both counters                                                                                                                                                                                                                                                                                                                                                                    |
| I-10 | Overlays moved to layer 1 with the camera's mask set per frame would compile nothing at boot                                                            | `Renderer.js:966–975, 3081–3087`; the overlays' warm-ups with R3F's camera; `CameraRig.tsx:206`                          | Accepted                               | Marks, the lights' masks and the camera's mask exist only under the flag, the camera's set in `<Canvas onCreated>` before any warm-up (§1.5, §2.3, §3.4, §4.3, §4.7); tests show a marked object compiles only against a camera testing layer 1, and the overlays compile at boot with the marks                                                                                                                                                                                                                                                                                                                               |
| I-11 | `motion.z` written as `1/d_reproj` in kilometers along the ray, where every other writer puts inverse view depth in render meters                       | `sensorMrt.ts:52–57`; `defocus.ts:101, 155`; `meter.ts:76–77`                                                            | Accepted                               | `motion.z = 1/(d_reproj·1000·compression·cos)` (§3.16), pinned against an opaque surface at the same depth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| I-12 | NaN sources outside the history's guard: `sign(0)`, `R₁/A₁` with nothing lit, unguarded knots                                                           | WGSL's `sign(0) = 0`; the design's §5.2, §5.7, §5.12                                                                     | Accepted                               | `select(−1, 1, b ≥ 0)` and `t_b = 0` where q = 0, in TSL and on the CPU (§5.2, §3.2, §3.5b); `r̄` guarded (§5.7); knots through `finiteOr` (§3.14, §5.12); tests for a level ray from an eye on a boundary and a ray with no lit cloud                                                                                                                                                                                                                                                                                                                                                                                          |
| I-13 | The composite's per-pixel class puts `marchAir`'s implicit-derivative reads in non-uniform control flow                                                 | `air.ts:266–349, 434–478` (`crowdedSamples` reads no texture)                                                            | Accepted, the reviewer's second option | The composite's marches are built from `airMediumAt({ level: true })` over the exported `crowdedSamples` and held to `marchAir` by `cloudCompositeAir.gpu.test.ts`; the structure test runs over every cloud fragment material (§3.6, §5.11, §9)                                                                                                                                                                                                                                                                                                                                                                               |
| I-14 | Nothing pinned the depth copy's row order against the trace's rays and the composite's reads                                                            | Temporal map §12.4; the design's §9                                                                                      | Accepted                               | `cloudDepth.gpu.test.ts` draws a depth step and reads it through `traceScreen`/`screenTexel`; the composite reads a row-ramp history; `cloudSystem.gpu.test.ts` stops the whole chain's top rows at the near depth (§5.1, §9)                                                                                                                                                                                                                                                                                                                                                                                                  |
| I-15 | The 5 cm altitude bound cannot pass over the stated domain                                                                                              | Re-ran the reviewer's emulation: 0.764 m, 0.088 m, 0.123 m                                                               | Accepted                               | §5.3's bound is 0.25 m where h ∈ [−1, 20] km and 10⁻⁶·(R + t) elsewhere, and its text gives the measured figures; the CPU and GPU tests hold that bound                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| I-16 | Level lookups took a lattice coordinate from a normalized absolute float32 direction, against rule 58                                                   | Rule 58; the design's §3.9                                                                                               | Accepted                               | Δu formed from the offset and float64 `(e·A, e·E, e·N)` terms (§3.9, §5.4), `along` on `LevelFrame` and the level uniforms, `eyeDirection` dropped, `levelOffset` the bake's eye-relative inverse (§3.5b); tests to 2 cm at 100 km                                                                                                                                                                                                                                                                                                                                                                                             |
| I-17 | `wetWorld` read an unauthored aerosol as 0 where the air draws `0.12·thickness`                                                                         | `atmosphere.ts:194, 466`; `system.ts:351–358`                                                                            | Accepted                               | `aerosolDepthOf(haze)` exported from `atmosphere.ts` in C and called by the recipe and by `wetWorld` (§0.2 item 10, §3.1, §2.3); a thickness-10 unauthored haze is not wet in `weatherScenario.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| I-18 | Phase 0 refactored `marchAir`, and nothing tested the claim that its WGSL is unchanged                                                                  | The design's §3.6, §11.2                                                                                                 | Accepted, both fixes                   | `marchAir` and `airToward` are not touched; `airMediumAt` stands beside them, held by `cloudLight.gpu.test.ts`; C hashes the shell's, sphere's, ground's and sea's WGSL on `c2a50f1` and on its commit (§3.6, §11.1)                                                                                                                                                                                                                                                                                                                                                                                                           |
| I-19 | The hourly drift wrap was not a jump, and the history's Δt was undefined                                                                                | The design's §5.4, §3.3, §3.5                                                                                            | Accepted                               | A change of `periodIndex(time, 3600)` is a jump, and `CloudFrame.frameSeconds = time − previous.time` moves the wind (§3.2, §3.3, §3.5, §5.4, §5.14), tested in `cloudFrame` and `cloudHistory`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| I-20 | `levels` ends at ±1,638 km, short of the limb, and is cheaper for drawing less                                                                          | Recomputed the limb's gnomonic distance: 1,830 km (far-shore), 2,290 km (Earth)                                          | Accepted                               | `levels` is decided on paper by the memory clause (F-9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| F-1  | Three seams had no signature: `traceRay` and the geometry, the `MieTable` type, the depth copy                                                          | The design's §2.2, §3, §11                                                                                               | Accepted                               | §3.5b gives the geometry's signatures, landed real in C; §3.12 the `MieTable` type; §3.16 `CloudDepth` (`cloudDepth.ts`) and `CloudFrameNode` (`cloudFrameNode.ts`), both WP3's                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| F-2  | The far bakes had no coverage past the clipmap's ±1,024 km, and the second body none at all                                                             | The design's §3.9, §3.10, §3.13                                                                                          | Accepted                               | `synopticMedium` (the cube, whole body) for the served body's far bakes and `analyticMedium` through `scenarioCoverageNode` for the second (§3.9, §3.10, §3.13); a far texel 1,800 km out bakes nonzero coverage in `cloudDensity`, `cloudFarCompare` and `cloudSystem`                                                                                                                                                                                                                                                                                                                                                        |
| F-3  | The immediate regime's memory                                                                                                                           | As I-2                                                                                                                   | Accepted                               | As I-2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| F-4  | The forced levers never ran a cut's rebuild, a scrub's turning sun, or an eye in motion; cascades rebuilt whole on re-anchor                            | The design's §3.3, §3.12; plan §6.1 ("scrolled as it moves")                                                             | Accepted                               | `force: 'cut'` and `'fly'` with `flySpeed` (§3.3, §3.4); `scrub` and `warp` turn the body-fixed sun by the body's spin; the cascades scroll toroidally and both sun-depth candidates rebuild under one cap, `SUN_DEPTH_FRAME_CAP` (§3.2, §3.12); the reset frame is the larger of `cut` and `scrub`, and the fly and reset frames enter the joint rule (§1.2, §8.3, §8.7)                                                                                                                                                                                                                                                      |
| F-5  | The sweep's work was not constant and its fetch count was wrong                                                                                         | The design's §5.5, §5.9, §8.4                                                                                            | Accepted                               | A sweep kernel and march at constant work (4 m steps, no stop, exit, sun, air or far march), `sweepMedium` with `sweepReads` base fetches and one `sweepExtra`, the `reads` lever gone; γ from one read type, each other type's marginal reported, R8 against RGBA8 at fixed reads, a stats check before each cell (§3.4, §3.10, §3.14, §5.5, §8.4)                                                                                                                                                                                                                                                                            |
| F-6  | Pass counts were undercounted, `ir.passes(40)` could overflow, `summarize` divides by frames asked for, and 30 frames is shorter than the atlas's cycle | `passTimeline.ts:141–146, 565–577`; `quadPass.ts:61–98`                                                                  | Accepted                               | §4.4 counts every kind; the runner takes `n = floor(2000/perFrame)` up to 40 and refuses `dropped > 0`; the wait is on the report's `settle`, capped at 240 frames; the far bake is one block pass a frame (§3.13, §3.17, §8.3)                                                                                                                                                                                                                                                                                                                                                                                                |
| F-7  | Cold boots reused per-port profiles, the OS Metal cache was unaccounted, and `ir.frameStats` does not exist                                             | `drive.mjs:227–235, 529`; `harness.ts:288–302`; `host.ts:40–44`                                                          | Accepted                               | The runner deletes its rig's profile before each cold boot; the OS cache is stated on every figure and left alone (§12.1 question 2); the first lever-on frame comes from `ir.status().frame` and the `sensor` span in the same invocation; cold compile runs on the landed code (§8.5, §11.3)                                                                                                                                                                                                                                                                                                                                 |
| F-8  | The far-field and sun-depth measurement tests could only use stand-ins, and the five scenarios were unnamed                                             | Rule 3 of the design's §11.0                                                                                             | Accepted                               | WP12 owns both after integration, on the real field (§8.6, §11.2); the five scenarios are named, at two suns (§5.9); `cloudCompositeError` stays with WP9                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| F-9  | `levels` was not the plan's candidate as built, the rule judged resolution rather than representation, and the memory clause turned on rounding         | Recomputed the limb distances and the volumes' bytes                                                                     | Accepted in part                       | (a) `levels` is decided on paper: it needs a sixth level, and 13.4 MB of far levels (2.8×) or 26.7 MB whole (5.6×) fails the memory clause either way (§1.3; §12.1 question 1). (b) The footprint-averaged error decides, the per-pixel error is recorded (§8.6, §8.7). Not adopted: scoring each candidate by the fine-march cost where its per-pixel error meets a common bound, since the two left share one texel layout, so a handover costs both the same, and a per-pixel bound at 24–39 km texels lies past the limb. (c) The clause is marginal bytes at 2.5×, so the spheres' exact 2.00× is not decided by rounding |
| F-10 | The choices were coupled through the volume and decided one at a time                                                                                   | The design's §3.19, §8.7                                                                                                 | Accepted                               | Cache and sun depth are one 2 × 2 with gates and a joint rule; the far field is measured on `(field, cascades)`; `(field, grid)` carries its volume bake (§1.3, §8.7, §8.8)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| F-11 | Format-changing premises were tested inside the fan-out, nested compute was treated as B-only, and the binding margin was thin                          | The design's §3.8, §12; WebGPU's limits count every texture binding                                                      | Accepted                               | The premise spike runs in C with a fallback for each (§11.1), nested work under both placements; stand-ins bind each module's real textures (§3.5, §3.7's inventory); WP6's first test counts bindings; the `textureLoad` claim is corrected. Counting them also showed binding both sun depths would put the volume kernels at 16 of 16, so a sun depth is its own kernel variant: eight trace kernels and a sweep kernel (§3.14)                                                                                                                                                                                             |
| F-12 | Two packages were too large, three leaned on another's unimplemented internals, and integration could not fix what it found                             | The design's §11                                                                                                         | Accepted                               | Waves: C; WP1, WP2, WP3, WP10; WP4–WP9; WP11; WP12. WP1 and the geometry land before the GPU fan-out; the old composite package is three (placement, history, composite) and the old trace package two (trace, far field); the system, `cloudWarm` and the integration tests are WP11's, `write()` C's; WP11 may fix any module for an integration failure (§11)                                                                                                                                                                                                                                                               |
| F-13 | The glory test compared band intensity with Laven's white-light rings and failed on a correct table; Q_ext's bound was too narrow                       | Re-ran the reviewer's port: 3.09°, 1.90°, 1.20°, 0.82° by band; 2.19° and 3.70° in white light at 10 µm; Q_ext 2.08–2.42 | Accepted                               | The series is held to Laven's quantity (white light, CIE 1931, red rings of `R/(R + G + B)`) at 24/r within 12% and 37/r within 6%; the table is held to the series' own red-band ring per row (`gloryRed`) within one angular texel; the first maximum after the first minimum; Q_ext within [1.9, 2.5] (§6.5, §6.6, §3.12, §1.2)                                                                                                                                                                                                                                                                                             |
| F-14 | The placement rule ignored A's main-thread cost                                                                                                         | The design's §4.3, §8.7; plan §9                                                                                         | Accepted                               | A CPU clause fixed now: the `sensor` span's mean +0.3 ms, or 2 more late frames on `horizon` or `inside`, loses A the choice (§8.7, §8.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| F-15 | Earth's A/B measured the clouds' cost minus the deck's                                                                                                  | The design's §4.3, §8.2                                                                                                  | Accepted                               | `deck: 'hidden'`, and Earth's figures in pairs: the clouds against the deck hidden, and the deck alone (§3.4, §4.3, §8.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| F-16 | "Quiet" was checked through the GPU lock alone                                                                                                          | `.claude/rules/timing.md`                                                                                                | Accepted                               | Load and process checks around every run, marked rows re-run, measurement with no package in flight (§8.1, §11.3, §12.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| F-17 | The dynamic import was not guaranteed to land before Sensor built its chain                                                                             | `Sensor.tsx:69–145`; `warmup.ts:527–540`                                                                                 | Accepted                               | The chunk is awaited inside the canvas's renderer factory, which R3F awaits before mounting children, and Sensor's effect depends on the factory (§3.17, §2.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| F-18 | `convolveDisk`, the `settled()` fold-in and the octaves were later phases' scope                                                                        | The design's §1.4, §3.17, §5.10                                                                                          | Accepted                               | The convolution and its test, and clouds in `ir.settled()` with its docs, move to phase 1 (`ir.clouds()` and the report's `settle` stay); higher orders are not drawn, because their cost depends on phase 1's choice between octaves and the slab table (§1.4, §5.7, §5.10, §10.4)                                                                                                                                                                                                                                                                                                                                            |

**Changes that followed from the findings rather than being one:** the
clipmap is baked from the cube, so one field feeds every distance (F-2); the
curl is read once a segment, keeping a step at the plan's four reads once the
`reads` lever went (F-5); the losers are deleted before the `targets`, `memory`
and `error` batches, so the shipped set's memory and cold compile are what is
measured (F-7, I-9); `cloudUniforms.write` is real in C (F-12).
