# Map: the render pipeline — scene pass, sensor, upscaler, quad passes, warm-up, sea split

Scope: the frame from the scene graph to the canvas, mapped for inserting the
weather plan's three cloud passes (a quarter-resolution trace, a
half-resolution history, a render-resolution composite) "after everything a
cloud can stand in front of — the ground, the sea, the sphere, the shell, the
sun's disk — and before the overlays", with world transparency after the
composite (`design/plans/the-weather.md` §3 last bullet, §5.5, §5.6, §9, §12).

Conventions:

- Repo paths are relative to `apps/game/src/` unless they start with
  `apps/`, `packages/`, `docs/` or `design/`.
- `three/…` paths are relative to `apps/game/node_modules/three/src/`
  (three **0.185.1**, `node_modules/.pnpm/three@0.185.1`; `@types/three`
  ~0.185.4). The upscaler is `@pmndrs/upscaler` **0.5.0**.
- **Inference:** marks anything not read directly in code. Everything else
  was read at the cited line.
- Read-only survey; nothing was run on the GPU.
- The surveyed tree carried a temporal `velocity` row. It is gone:
  reconstruction reads the optics' masked `motion.rg`, and temporal pictures
  add `reactive` alone (`docs/adr/0044-the-sensor-reconstructs-the-display.md`). Where this map weighs `velocity`'s fate, the
  answer is the arm that drops it.

---

## 0. The ten facts an implementer needs first

1. **The scene is one `PassNode`** (`pass(scene, camera, { samples })`,
   `render/sensor.ts:161`) inside one `RenderPipeline` (`sensor.ts:220`). Its
   `updateBefore` calls `renderer.render(scene, camera)` once per render call
   (`updateBeforeType = RENDER`, `sensor.ts:190`; three's default is FRAME).
2. **Every `renderer.render()` and `renderer.compute()` gets its own
   `GPUCommandEncoder` and submits it at its own end**
   (`three/renderers/webgpu/WebGPUBackend.js:940` create, `:1278` submit;
   compute `:1566-1586`, `:1711`; `utils/WebGPUUtils.js:294-302` is an
   immediate `device.queue.submit`). A render _nested_ inside the scene pass —
   anything a node's `updateBefore` draws while the scene is drawing —
   therefore **executes on the GPU before the scene pass**, because the scene
   pass's encoder is submitted only when the scene render finishes. That is
   how the galaxy backdrop's passes work today, and it is why a cloud trace
   triggered from inside the scene pass would read last frame's depth.
3. **The only thing that ends and resumes the scene pass on its own encoder
   is `copyFramebufferToTexture`** (`WebGPUBackend.js:2736-2856`), which the
   sea's `SeaFrameNode` drives (`render/seaReflection.ts:173-255`). That is
   "the split". three exposes no other in-pass hook.
4. **The node schedule is the sensor's explicit dependency enumeration**
   (`sensor.ts:285-296`): post-order gives `[scenePass, upscale, defocus,
motion, psf]`. Internal optical quads read _plain_ `texture(x.value)`
   nodes, never `PassTextureNode`s, so their own draws cannot pull the scene
   pass in again (`sensor.ts:60-61`, `:280-282`). A new stage must be placed
   in that enumeration, and its quad materials must read plain textures.
5. **MRT layout is a table** (`render/sceneLayout.ts:92-153`): `output`
   rgba16f (material blend), `motion` rgba16f (`over`), `meterMask` r8
   (`max`); temporal pictures add `velocity` rg16f (**no blend**) and
   `reactive` rgba8 (`union`). By the WebGPU byte-cost table that is 17 B and
   30 B a sample against the default 32-byte
   `maxColorAttachmentBytesPerSample`; `createRenderer.ts:180-193` requests no
   `requiredLimits`. (Computed, not measured on device.)
6. **Per-attachment blend comes from the pass's MRT, never from the material**
   (`three/renderers/webgpu/utils/WebGPUPipelineUtils.js:140-160`); the
   material's own blend applies to `output` only. A full-screen composite
   drawn into the scene target replaces `velocity` everywhere it draws.
   Reconstruction reads the masked `motion.rg` instead, and no layout carries
   `velocity` (`docs/adr/0044-the-sensor-reconstructs-the-display.md` § Decision).
7. **Under MSAA (the default picture) the scene depth is itself
   4-sample** (no resolve), color attachments are MSAA with single-sample
   resolve targets, and every attachment is stored at pass end
   (`WebGPUBackend.js:674-688`, `:763-764`, `:878`, `:916`). A shader reading
   the depth gets `texture_depth_multisampled_2d` and `textureLoad(…, 0u)` =
   sample 0 (`WGSLNodeBuilder.js:726-756`, `:804-811`).
8. **A pass cannot sample the depth texture it has attached.** The sea copies
   depth in its split for exactly that reason. A composite drawn as a scene
   object (in either candidate) needs a depth it can read: a copy, or a
   single-sample depth produced by a pass between.
9. **Reversed depth reverses three's whole draw list** (`three/renderers/
common/RenderList.js:389-403`); `render/sceneOrder.ts:10-24` pre-negates
   `groupOrder`, `renderOrder` and `id` so authored order survives on both
   backends. Opaque always draws before transparent
   (`three/renderers/common/Renderer.js:1754-1755`), whatever `renderOrder`
   says.
10. **Compile-ahead silently skips** an invisible object (handled by
    `warmCompile`), a frustum-culled one (`warmup.gpu.test.ts:175-207`), and —
    for a split by layers — an object on a layer the camera does not test
    (`Renderer.js:966` → `:3084`). A pipeline not yet built draws nothing,
    quietly (`Renderer.js:3725-3727`).

---

## 1. The frame, in order

### 1.1 R3F's frame (CPU)

Every callback goes through `useTimedFrame(name, cb, priority)`
(`scene/useTimedFrame.ts:9-25`; skipped while `framesHeld()`).

| Priority | Callback                                                                                                                                        | File:line                                                             | What it does to the GPU                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| −1       | `EngineTick`                                                                                                                                    | `scene/EngineTick.tsx`                                                | steps/samples the world                                                                                                                                |
| −0.5     | `cameraRig`                                                                                                                                     | `scene/CameraRig.tsx:206` (`updateCamera` 60-204)                     | `camera.fov/aspect` + `updateProjectionMatrix` (124-135), pose (143-152), the one star's point light at `stars[0]` (156-167), fill direction (188-203) |
| −0.25    | `orbitalBake`                                                                                                                                   | `scene/Bodies.tsx:312`                                                | offscreen bake renders (own encoders)                                                                                                                  |
| 0        | `bodies`, `waterPatches`, terrain, rocks, traces, flare, structures, stations, ship, astronaut, thrusters, cinematic, warp, starfield, `galaxy` | `scene/SceneView.tsx:84-101` (mount order is not load-bearing, 47-52) | uniform writes and placement; some run compute/offscreen work                                                                                          |
| 1        | `sensor`                                                                                                                                        | `scene/Sensor.tsx:147-156`                                            | `chain.render(undefined, delta)` — takes the frame from R3F                                                                                            |

Lights (`CameraRig.tsx:208-218`): `ambientLight`, one `pointLight`
(`decay 0`, the brightest star, 156-167), one `directionalLight` fill. All on
layer 0. **three's camera `Layers` are unused anywhere in the app**; the only
touch is the sensor's save/restore (`sensor.ts:480`, `:554`).
(`GameEngine.setLayers`, `engine/GameEngine.ts:791`, is a presentation
stance for labels and orbits, unrelated.)

### 1.2 Inside `sensor.render(target = null, delta)` (`render/sensor.ts:361-558`)

1. `frame()` state (`scene/Sensor.tsx:92-117`): lens, `pictureEpoch` (94),
   settings, `time = snapshot.renderTime` (97), `adaptationTime`,
   `renderOrigin`, `historyKey` (100-107), pinned, depth, staging, headroom,
   gamma, motion blur, noise tick.
2. Exposure: `history.advance` (370-374) → meter generation; WebGL forces
   Manual (366-369, `automaticAvailable` = WebGPU backend, 149);
   `exposure.update` (377-383); **`setSceneExposure(renderer, pre, total,
processing)`** (384-389) — this is what `sceneRadianceGain`
   (`render/radiance.ts:29-31`) reads for the rest of the frame.
3. Optics uniforms: drawing buffer `size` (390), signature (394-405), PSF
   scatter (406), defocus (407-425), shutter fraction (426-433), tone curve
   (435-443).
4. Output rebuilt only if tone mapping or color space moved (448-452).
5. `renderer.setRenderTarget(target)` (456) — `null` is the canvas; load-bearing
   (interface note 84-94).
6. Save renderer state (472-482): tone mapping, color space, xr, MRT,
   autoClear, `renderer.transparent/opaque`, `contextNode`, `camera.layers.mask`,
   `scene.overrideMaterial`, `scene.name` — everything `PassNode` and
   `RenderPipeline` swap.
7. **History key** (485-496): `pictureEpoch : mode : stagingLook : processing
: historyKey : pinned`; a change calls `upscale.resetHistory()`. The cloud
   history's reset belongs here (plan §5.5 "`pictureEpoch` resets the
   history").
8. `upscale.beginFrame(delta, pre, residual, debug)` (501-506) — **jitters the
   camera** (`render/upscale.ts:386-396`, `kernel.beginFrame(camera)` sets a
   view offset and the aspect is restored).
9. **`post.render()`** (508) — everything in §1.3.
10. Meter: `meter.sample(...)` (515-540) → `renderer.compute(clear)`,
    `renderer.compute(count)` (`render/meter.ts:100-102`) over the
    render-resolution, resolved scene color, then an async readback.
11. `finally` (542-557): `upscale.endFrame()` (unjitter), `setSceneExposure(
renderer, null)`, restore all of step 6.

### 1.3 Inside `post.render()`: the node schedule

`RenderPipeline.render` (`three/renderers/common/RenderPipeline.js`) swaps
to `NoToneMapping` + working color space + `xr.enabled = false`, then
`quadMesh.render(renderer)` → `Renderer._renderScene(quad)`
(`Renderer.js:1519-1794`) → `backend.beginRender` for the **canvas** pass
(encoder E_post created, `:1741`) → the quad's render object →
`_renderObjectDirect` (`:3690-3733`) → `_nodes.updateBefore(renderObject)`
(`:3712`) runs the graph's `updateBeforeNodes` in order. That order is
post-order (children first) of `sequentialNodes`
(`three/nodes/core/NodeBuilder.js:866-913`), so the sensor's add-chain
(`sensor.ts:285-296`)

```ts
let dependencies = vec4(scenePass.getTextureNode().rgb.min(65_504).mul(0), 0)
if (upscale !== null)
  dependencies = dependencies.add(nodeObject(upscale).min(65_504).mul(0))
if (defocus !== null)
  dependencies = dependencies.add(nodeObject(defocus).min(65_504).mul(0))
if (motion !== null)
  dependencies = dependencies.add(nodeObject(motion).min(65_504).mul(0))
dependencies = dependencies.add(nodeObject(psf).min(65_504).mul(0))
post.outputNode = dependencies.add(signature.encode(encoded))
```

schedules, per render call:

| #   | Node `updateBefore`                     | File:line                                 | Encodes                                                                                         | Timeline label                                          |
| --- | --------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | scene `PassNode`                        | `three/nodes/display/PassNode.js:780-876` | `renderer.render(scene, camera)` into the MRT scene target; nested node work inside it (galaxy) | `scene`, `scene after copy`                             |
| 2   | `UpscaleNode` (if the picture upscales) | `render/upscale.ts:427-452`               | FSR compute, outside three                                                                      | under `owned` (`upscaler`)                              |
| 3   | `DefocusNode` (if `enabled`)            | `render/defocus.ts:194-224`               | 4 quads                                                                                         | `defocus 0`–`3`                                         |
| 4   | `MotionNode` (if fraction > 0)          | `render/motion.ts:164-186`                | 3 quads                                                                                         | `motion tile max`, `motion neighbor max`, `motion blur` |
| 5   | `PsfNode`                               | `render/psf.ts:160-198`                   | 12 quads                                                                                        | `psf down 0`–`5`, `psf up 0`–`4`, `psf resolve`         |
| —   | post quad itself                        | E_post                                    | signature + `renderOutput` to the canvas                                                        | `canvas`                                                |

Without `frame` (headless tests) there are no optics: scene + (upscale) +
post, which is what `sensor.gpu.test.ts:237-278` counts (two renders a frame).

### 1.4 GPU queue order for one presented frame (WebGPU, default picture)

Encoding order and execution order differ. Execution order is submission
order:

1. Priority ≤ 0 callbacks' own submissions (bakes, producer compute, …).
2. Work nested inside the scene render, each submitted at its own end — e.g.
   the galaxy backdrop's `GalaxyVolumeNode.updateBefore`
   (`render/galaxyVolume.ts:418-516`) runs `galaxy rays`, `galaxy history`,
   `galaxy volume` through `runQuadPasses` **while the scene pass is open**,
   and they execute before it.
3. **E_scene**: the scene pass, `scene` then (full sea in view) `scene after
copy` — submitted at `WebGPUBackend.js:1278`.
4. FSR compute; defocus, motion, PSF quads (each its own submit).
5. E_post: `canvas` (created first, submitted last).
6. Meter compute `clear`, `count` (unnamed → label `compute`).

**Inference** worth stating once: `PassTimeline` lists passes "in the order
the first frame encoded them" (`render/passTimeline.ts:505-506`), which is
`beginRender` order — `canvas` is begun before the scene — not execution order.

---

## 2. The scene pass

### 2.1 Construction (`render/sensor.ts:139-190`)

```ts
export function createSensor(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  layout: SceneLayout,
  frame?: () => SensorFrame,
  diagnostic?: 'bilinear',
): Sensor
```

- `invariant(layout === sceneLayout(picture, sceneBackend(renderer)))` (156-159).
- `scenePass = pass(scene, camera, { samples: layout.samples })` (161);
  `namePass(scenePass.renderTarget, 'scene')` (162).
- Depth type `FloatType` under reversed depth (163-164; three also forces it,
  `PassNode.js:770-774`).
- `setResolutionScale(1 / pictureRatio(picture))` (165): the target is
  `floor(drawingBuffer × scale)` per axis (`PassNode.js:884-892`;
  `render/picture.ts:111-112` `renderSize` is the same expression).
- `setMRT(sensorMrt(layout))` (166); every row's texture gets its format/type
  (167-171) — `getTextureNode(name)` creates the attachment by cloning
  `output` (`PassNode.js:568-593`).
- `updateBeforeType = NodeUpdateType.RENDER` (190; reasoning 172-189,
  ADR-0029).
- Texture handles used downstream: `getTextureNode('output'|'depth'|
'velocity'|'reactive')` → upscaler inputs (196-199);
  `getTextureNode('motion')` (209) → defocus/motion/meter;
  `renderTarget.texture` and `getTextureNode('meterMask').value` → meter
  (216-218); `renderTarget.texture` → `radiance` when not upscaling (225-227).

### 2.2 What `PassNode.updateBefore` does (`PassNode.js:780-876`)

`setSize(drawingBuffer)` (805) → save target/MRT/autoClear/transparent/
opaque/layers/contextNode/overrideMaterial → `camera.layers.mask =
this._layers.mask` if `setLayers` was called (819-823; `setLayers` 518) →
`setRenderTarget(renderTarget)`, `setMRT(_mrt)`, **`autoClear = true`
unconditionally** (837-839), `renderer.transparent/opaque = this.transparent/
this.opaque` (840-841, both default `true`, 282/290) → `renderer.render(scene,
camera)` (862) → restore (865-874). Near/far uniforms `_cameraNear/_cameraFar`
are refreshed from the scene camera here (816-817) and back
`getViewZNode`/`getLinearDepthNode` (695-736).

Consequence: a _second_ `PassNode` on the same target would clear it. A
second scene pass that loads instead must be a custom node calling
`renderer.render` itself.

### 2.3 The layout (`render/sceneLayout.ts`)

`sceneLayout(picture, backend): SceneLayout` (127-153), interned per
(resolved picture, reversed depth) (112, 134-151). `SceneLayout = { picture,
samples: 0 | 4, depthType, attachments }` (57-70). Rows (92-105):

| Row         | Channels / storage → GPU format | Blend                                         | In layout       |
| ----------- | ------------------------------- | --------------------------------------------- | --------------- |
| `output`    | 4 half → `rgba16float`          | `material`                                    | always, index 0 |
| `motion`    | 4 half → `rgba16float`          | `over` (SrcAlpha, 1−SrcAlpha; alpha Zero/One) | always          |
| `meterMask` | 1 byte → `r8unorm`              | `max`                                         | always          |
| `velocity`  | 2 half → `rg16float`            | `none` (replace)                              | temporal only   |
| `reactive`  | 4 byte → `rgba8unorm`           | `union` (One, 1−SrcAlpha)                     | temporal only   |

Pictures (`render/picture.ts`): `aa: off | msaa | supersample | temporal`,
`scale: native | quality | balanced | performance | ultra` (ratios 1, 1.5,
1.7, 2, 3; 41-47), `sharpness`. Default `msaa/native/standard` (35-39).
`pictureSamples` = 4 for msaa and supersample, else 0 (83-84);
supersample doubles the DPR (85-86, native only, 61); `pictureUpscales`
= temporal or non-native (96-97). `?picture=bilinear:<scale>` is a
diagnostic path (`parsePictureQuery` 132-144; `UpscaleNode` path
`'bilinear'`). WebGL resolves temporal → msaa and any scale → native
(`resolvePicture` 66-80), so WebGL never has `velocity`/`reactive` and never
upscales.

| Picture                | Samples  | Rows                      | Reconstruction         |
| ---------------------- | -------- | ------------------------- | ---------------------- |
| msaa/native (default)  | 4        | output, motion, meterMask | none                   |
| supersample/native     | 4, DPR×2 | same                      | none                   |
| off/native             | 0        | same                      | none                   |
| msaa or off at a scale | 4 or 0   | same                      | spatial FSR            |
| temporal/any           | 0        | + velocity, reactive      | temporal FSR, jittered |

`upscale.gpu.test.ts:398-400` pins the attachment count: 5 temporal, 3
otherwise.

### 2.4 The MRT byte budget (computed)

From WebGPU's render-target byte cost / alignment (rgba16float 8/2, r8unorm
1/1, rg16float 4/2, rgba8unorm 8/1 — the spec table, quoted from memory, not
measured):

- default/off/supersample: 8 + 8 + 1 = **17 B**.
- temporal: 8 + 8 + 1 → align 2 → 18 + 4 = 22 + 8 = **30 B**.
- temporal with `velocity` widened to rgba16f for a blend: 18 + 8 = 26 + 8 =
  **34 B > 32** — refused unless `requiredLimits.maxColorAttachmentBytesPerSample`
  is raised in **both** renderer constructions: `render/createRenderer.ts:180`
  and the GPU harness, `render/gpuHarness.ts:364-368`.
- temporal after the upscaler plan's decided change (drop `velocity`):
  **25 B**.
- `scripts/gpuAdapter.mjs:35-42` already reports the adapter's
  `maxColorAttachmentBytesPerSample` (it creates adapters; run it only
  under the GPU lock).
- The same 32-byte limit binds any MRT the cloud trace writes into its own
  target. **Inference:** four depth knots of (depth, T, L.rgb) at half float
  is 40 B, so either two targets, a storage-texture compute pass, or a raised
  limit.

### 2.5 What each row receives (`render/sensorMrt.ts`)

`sensorMrt(layout)` (97-108) builds `mrt({...})` from `WRITES` (46-61) and
sets the row blends (76-94):

```ts
output:    () => output,
motion:    () => vec4(velocity.xy, positionView.z.negate().max(1e-4).reciprocal(), 1)
                   .mul(motionOverlay.oneMinus()),
meterMask: () => vec4(meterOverlay, 0, 0, 1),
velocity:  () => vec4(velocity.xy, 0, 1),
reactive:  () => vec4(reactiveCoverage, 0, 0, output.a),
```

`motionOverlay`, `meterOverlay`, `reactiveCoverage` are shader `property`s
(38-40), zero unless written. The one writer is `sensorRadiance(material,
overlay = false, instrument = false, reactive = overlay || instrument ? 1 :
0)` (`render/radiance.ts:95-112`), which also pre-exposes:
`vec4(output.rgb.mul(sceneRadianceGain).min(65_504), output.a)`. Every scene
material goes through it (inventory in §3.3).

How the blend reaches the pipeline: three takes each attachment's blend from
`renderObject.context.mrt.getBlendMode(texture.name)`; `MaterialBlending` maps
to the material's own (`WebGPUPipelineUtils.js:140-160`). In compatibility
mode, and on WebGL, the material's blend applies to every attachment (same
lines; `sensorMrt.ts:48-51`). A material's own `mrtNode` is merged into the
outputs (`three/materials/nodes/NodeMaterial.js:559-583`) but never changes
the blend states. `MRTNode.setup` drops outputs whose name the bound target
lacks (`three/nodes/core/MRTNode.js:161-185`) and types each output from the
target's format (`builder.getOutputType(index)`), which is why a blend that
reads source alpha needs a 4-channel row (`sceneLayout.ts:80-91`; Dawn's
refusal quoted in `docs/adr/0044-the-sensor-reconstructs-the-display.md` § Alternatives considered;
`sceneLayout.test.ts:41`).

Material blend is applied only when `blending !== NoBlending && (blending
!== NormalBlending || transparent)` (`WebGPUPipelineUtils.js:104-106`): a
`CustomBlending` material in the **opaque** list still blends; a
`NormalBlending` one with `transparent: false` does not.

### 2.6 MSAA mechanics (`WebGPUBackend.js`)

- Color: view = `msaaTexture`, `resolveTarget` = the single-sample texture
  (674-688). `storeOp` is always `store` (763-764, 878); depth `depthStoreOp
store` (916).
- Depth: the target's `DepthTexture` is created multisampled; it has no
  resolve. Its sample count is read from `texture.renderTarget.samples`
  (`utils/WebGPUUtils.js:104-131`; `RenderTarget.depthTexture` setter ties
  it, `three/core/RenderTarget.js:265-270`). A depth texture with no
  `renderTarget` takes the _currently bound_ target's count — the trap
  `SeaFrameNode.#tie` exists for (`seaReflection.ts:151-171`).
- Reading a multisampled or float depth in TSL: unfilterable →
  `generateTextureLod(…, '0')` → `textureLoad(t, coord, u32(0))`, which on a
  multisampled texture is sample index 0 (`WGSLNodeBuilder.js:726-756`,
  `:804-840`; types `:2089-2115`).
- Downstream readers after the pass see the **resolved** color attachments
  (meter, defocus/motion read `motion`, FSR reads `output`), and the 4-sample
  depth.

### 2.7 Render contexts are keyed on shape, not target

`RenderContexts.get(renderTarget, mrt, callDepth)`
(`three/renderers/common/RenderContexts.js:41`) keys on `count:format:type:
samples:depth:stencil` + `mrt.id` + call depth. The warm-up stand-in, the
live scene target, and any second render into the scene target at the same
call depth with the same MRT object share one `RenderContext` and its
backend record (descriptor, encoder, current pass) — fine sequentially, and
the reason a stand-in disposed mid-queue broke compiles
(`render/sceneTarget.ts:15-31`).

---

## 3. The scene graph and the draw order

### 3.1 Components (`scene/SceneView.tsx:82-111`)

`EngineTick, CameraRig, Starfield, GalaxyVolume, Bodies, TerrainPatches,
WaterPatches, ScatterRocks, OrbitTraces, EntryTrace, SunFlare,
SurfaceStructures, Stations, ShipModel, AstronautModel, ThrusterFx,
CinematicStage, WarpFx, Sensor` (last, priority 1). One terrain and one water
material for the session (78-81).

### 3.2 Sort rules

- `_projectObject` (`Renderer.js:3080-3233`): an invisible object returns
  (3082); `object.layers.test(camera.layers)` gates the object itself (3084);
  a **Group** that passes sets `groupOrder = group.renderOrder` for its
  subtree (3088-3090); children are walked even when the parent failed the
  layer test (3228-3233), but then keep the outer `groupOrder`. Lights are
  pushed only if they pass the layer test.
- Lists: opaque, transparent, transparentDoublePass (`RenderList.js:301-322`).
  Drawn opaque first, then transparent (`Renderer.js:1754-1755`).
- `RenderList.sort(opaqueSort, transparentSort, reversedDepth)` sorts, then
  **reverses all three lists** when `camera.reversedDepth`
  (`RenderList.js:389-403`). The camera is marked reversed by
  `_updateCamera` (`Renderer.js:3440-3475`).
- `installSceneOrder(renderer)` (`render/sceneOrder.ts:10-24`, installed at
  `createRenderer.ts:226`, and in the GPU harness `gpuHarness.ts:371`):

  ```ts
  ;((a.groupOrder ?? 0) - (b.groupOrder ?? 0)) * order ||
    ((a.renderOrder ?? 0) - (b.renderOrder ?? 0)) * order ||
    (transparent ? (b.z ?? 0) - (a.z ?? 0) : (a.z ?? 0) - (b.z ?? 0)) ||
    ((a.id ?? 0) - (b.id ?? 0)) * order // order = reversedDepthBuffer ? -1 : 1
  ```

  Net, on both backends: `groupOrder` ascending → `renderOrder` ascending →
  opaque front-to-back / transparent back-to-front (z is clip-space z
  without the divide; it reverses meaning under reversed depth, so it is not
  negated) → id ascending. CONTEXT.md:10333-10340 records the galaxy backdrop
  drawing over the scene before this.

### 3.3 Inventory, classified by the plan's split

"List" is which render list the object lands in. `ro` = renderOrder,
`go` = groupOrder (nearest Group's renderOrder; R3F `<group>`s are 0).

| Object                                                               | Where                                                                                                                        | List                                                                          | go / ro     | Depth                                                    | Blend / MRT            | Cloud side (plan §5.6)                                                                              |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------- | -------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| Galaxy backdrop (full-screen plane, its node runs the galaxy passes) | `render/galaxyVolume.ts:533-557`, `scene/GalaxyVolume.tsx:50-53`                                                             | opaque                                                                        | 0 / −1000   | far (`sceneFarDepth`), write off                         | overlay=true           | under                                                                                               |
| Star field sprites                                                   | `scene/Starfield.tsx:47-52`, `render/materials.ts:541-625`                                                                   | transparent, additive                                                         | 0 / −2      | write off                                                | —                      | under                                                                                               |
| Body sphere / star disk                                              | `scene/Bodies.tsx:331-346, 462`; `render/bodyUniforms.ts:565` (`surface ? −1 : 0`); star `materials.ts:134-171` (reactive 1) | opaque                                                                        | 0 / −1 or 0 | write                                                    | —                      | under ("sphere", "sun's disk")                                                                      |
| Atmosphere shell                                                     | `Bodies.tsx:340-346`; `materials.ts:417-442`                                                                                 | transparent, BackSide, One/1−SrcAlpha                                         | 0 / 0       | write off                                                | reactive = alpha       | under ("shell")                                                                                     |
| Terrain patches, rocks                                               | `scene/TerrainPatches.tsx`, `scene/ScatterRocks.tsx`; `render/terrain.ts:497`                                                | opaque                                                                        | 0 / 0       | write                                                    | —                      | under ("ground")                                                                                    |
| Sea sheets                                                           | `scene/WaterPatches.tsx:136-158`; `render/water.ts:330-337`                                                                  | **transparent**, `depthWrite: true`                                           | 0 / 0       | write                                                    | reactive 0.3           | under ("sea"); full sea splits the pass (§4)                                                        |
| Hull, stations, structures, astronaut                                | `ShipModel.tsx`, `Stations.tsx`, `SurfaceStructures.tsx`, `AstronautModel.tsx`; `render/shipMaterial.ts:27-57`               | opaque (lit, standard); glass parts transparent                               | 0 / 0       | write                                                    | glass reactive = alpha | under (plan: a hull in cloud is veiled by its own depth of cloud)                                   |
| Cinematic staged sky                                                 | `render/cinematicStage.ts:66-71, 115-120`                                                                                    | transparent, BackSide, opacity 1                                              | 0 / 8       | **test at far** (`depthNode = sceneFarDepth`), write off | overlay                | must be under: it overwrites every far-depth pixel, which includes a composite that writes no depth |
| Earth's cloud deck (retires phase 3)                                 | `Bodies.tsx:349-355, 531-551`; `render/planet.ts:713-789`                                                                    | transparent                                                                   | 0 / 1       | write off                                                | reactive = alpha       | must not draw for a traced body                                                                     |
| Rings                                                                | `Bodies.tsx:357-363`; `planet.ts:834-956` (DoubleSide)                                                                       | transparent                                                                   | 0 / 2       | write off                                                | reactive = alpha       | over (world transparency)                                                                           |
| Entry-trace inks (`fall`, `ring`, `outline`, `hold`, `figure`)       | `scene/EntryTrace.tsx:47-54`; `render/entryTrace.ts:10-29`                                                                   | **opaque list** (`transparent` false; `NormalBlending` therefore not applied) | 0 / 1, 3–6  | test on/off per ink, write off, `expandedLineDepth`      | overlay + instrument   | over (plan lists entry traces as world transparency)                                                |
| Entry-trace `through`                                                | `entryTrace.ts:31-37`                                                                                                        | transparent                                                                   | 0 / 2       | test off                                                 | overlay + instrument   | over                                                                                                |
| Orbit traces                                                         | `scene/OrbitTraces.tsx:133-135`; `render/orbitTrace.ts:28-40`                                                                | transparent                                                                   | 0 / 0       | test off                                                 | overlay + instrument   | over (instrument)                                                                                   |
| Thruster plumes                                                      | `render/plumes.ts:202-211, 461, 499, 544, 550`                                                                               | transparent, additive                                                         | 10 / 9–10   | test on, write off                                       | overlay                | over (world transparency)                                                                           |
| Lens flare                                                           | `render/flare.ts:268-296, 361-383`                                                                                           | transparent, additive                                                         | 10 / 10     | test off                                                 | overlay                | over (reads nothing)                                                                                |
| Warp effects                                                         | `render/warpEffects.ts:260-292`                                                                                              | transparent, additive                                                         | 11 / 11     | test off                                                 | overlay                | over                                                                                                |
| Entry sheath, pad dust                                               | `render/cinematicStage.ts:183, 220`                                                                                          | transparent                                                                   | 0 / 11, 12  | —                                                        | overlay                | over                                                                                                |

---

## 4. The sea's mid-pass copy (`render/seaReflection.ts`, ADR-0052)

When the full sea is selected (`surfaceQuality.sea === 'full'`, the default,
`render/quality.ts:42-47, 109-121`; `WaterPatches.tsx:83-84, 145`), the sheet
material holds one `SeaFrameNode` (`water.ts:505-506`), a
`ViewportTextureNode` subclass (`seaReflection.ts:124-256`) with
`updateBeforeType = RENDER` (inherited, `three/nodes/display/
ViewportTextureNode.js:89`). The sequence, at the **first** sea sheet's draw
in the transparent phase of the scene render:

1. `_renderObjectDirect` → `_nodes.updateBefore` (`Renderer.js:3712`) →
   `SeaFrameNode.updateBefore(frame)` (173). A clone (`referenceNode`) copies
   nothing (174).
2. WebGPU with a depth copy: tie the copy's sample count to the bound target
   (203), resize/retype the copy texture to the scene depth (204-216),
   `initTexture` (217).
3. Reach three's internals (218-223): `renderer._currentRenderContext`,
   `backend.get(context).encoder`, `backend.get(source).texture`,
   `backend.get(depth).texture`; bail to a color-only copy if any is missing
   or formats/sample counts differ (224-233).
4. **Hold `encoder.beginRenderPass` for one call** (240-248) so it first
   encodes `copyTextureToTexture(sceneDepth → copy, whole)`.
5. `copyColor()` = `ViewportTextureNode.prototype.updateBefore` (175-180) →
   `renderer.copyFramebufferToTexture(framebufferTexture)`
   (`ViewportTextureNode.js:198`; `Renderer.js:2970-3027`) →
   `WebGPUBackend.copyFramebufferToTexture` (2736-2856):
   `currentPass.end()` (2782, MSAA resolves) → copy resolved `textures[0]`
   (`output`) to the framebuffer texture (2803) → set every color
   attachment's and the depth's `loadOp = load` (2826-2833) →
   `encoder.beginRenderPass(descriptor)` (2835; the held call runs the depth
   copy first) → restore viewport/scissor (2838-2848).
6. Restore `beginRenderPass` (`finally`, 251-253).

What the copy holds: everything drawn before the first sheet — all opaques,
and the transparent draws sorted ahead of it (star field −2; shells at ro 0
farther by z). It does **not** hold the sea's own depth: the sheet writes
depth after the copy (`water.ts:337`). WebGL: color copy only; the land
search compiles to `vec4(0)` (`seaReflection.ts:319-320`).

Timeline: the hook on `copyFramebufferToTexture` (`passTimeline.ts:304-320`)
gives the resumed pass a fresh timestamp pair labeled
`${label} after copy`. A second split resumes from `scene after copy` and
would read `scene after copy after copy` (inference from 313-315).

Cost (ADR-0052:15-22, 107-115, at 1920×1200 DPR 2): the depth copy 1.9 ms
at 3 m; `plain` over `full` was 1.6 ms at 2 km once the split went. Tests:
`water.gpu.test.ts:186-219` (`['scene', 'scene after copy']` vs `['scene']`),
`passTimeline.gpu.test.ts:77-106`.

ADR-0052:100-105 already names the constraint the weather plan meets: a pass
"encoded between the end of the scene pass and its resumption outside three's
node system".

---

## 5. Reconstruction (`render/upscale.ts`)

- `UpscaleNode extends TempNode<'vec4'>` (129), `updateBeforeType = RENDER`
  (180). Inputs (72-77): `color`, `depth` (always), `velocity`, `reactive`
  (temporal), all `PassMultipleTextureNode`s of the scene pass
  (`sensor.ts:196-199`) — held as node properties in `setup` (411-425) so
  the pass orders before it; dispatch uses their `.value` (436-450).
- Sizes: display = drawing buffer; render = `renderSize(display, ratio)`
  (273-283) — the scene target's own size by construction.
- Temporal: `velocity.setProjectionMatrix(kernel.unjitteredProjectionMatrix)`
  (197-198) — a **global** override on three's `velocity` node singleton for
  every material while the temporal chain lives (undone in `dispose`, 491).
  Jitter is applied in `beginFrame` (386-396) and cleared in `endFrame`
  (401-403) from the sensor's `finally`. The unjittered matrix is private
  (`#kernel`); no accessor exists.
- Reactive: red = rejection coverage, alpha = material opacity (ADR-0044:80-90;
  the deck writes its alpha there today, `planet.ts:753-758`).
- History reset: `resetHistory()` (405-409) from the sensor's history key
  (`sensor.ts:493-496`); a resize reconfigures (277-345).
- Timing: the package's own timer lent to the timeline as a `PassSource`
  (231-270; reported under `owned`).
- Note for clouds: three's `velocity` keeps its _camera_ history keyed on
  `frameId` (`three/nodes/accessors/VelocityNode.js:105-141`), which only
  three's own rAF loop advances; a cloud history that reprojects must keep its
  own previous camera per render call (as `GalaxyTemporalVolume` does,
  `galaxyTemporal.ts:291-299`).

---

## 6. Optics, output and meter

- Radiance into optics: `texture(upscale.outputTexture.value ??
scenePass.renderTarget.texture)` (`sensor.ts:225-227`) — a plain texture
  node; `radiance.value` re-pointed each frame (507).
- `DefocusNode(radiance, texture(motion))` (228-231): near/far half-res
  gathers. `MotionNode(defocus.outputTexture, texture(motion))` (232-235).
  `PsfNode(...)` (236-239). `sensorSignature(texture(psf.outputTexture.value))`
  (240-241): noise/white balance, evaluated in the post quad.
- Output: `renderOutput(sceneColor, toneMapping, colorSpace)` with
  `post.outputColorTransform = false` (224, 277), alpha forced 1.
- Meter: reads the resolved `output` at render resolution plus `motion.z`
  and `meterMask` (`meter.ts:31-127`), after `post.render()` — so it sees
  whatever the scene target holds at the end of the frame, clouds included.

---

## 7. Quad passes and the pass timeline

### 7.1 `runQuadPasses` (`render/quadPass.ts:61-98`)

```ts
export function runQuadPasses(
  renderer: Renderer,
  quad: QuadMesh,
  state: QuadPassState,
  passes: (draw: QuadDraw) => void,
): void
type QuadDraw = (
  label: string,
  target: RenderTarget,
  material: Material,
  face?: number,
) => void
interface QuadPassState {
  linear?: boolean
  autoClear?: boolean
  scissor?: boolean
}
```

Saves target/face/mip, MRT, tone mapping, color space, autoClear, scissor;
`linear: true` sets MRT `null`, `NoToneMapping`, working color space (82-86);
`draw` calls `namePass(into, label)` then `setRenderTarget` and
`quad.render(renderer)` (75-80); restores in `finally` (90-97; ADR-0029's
defect). Each draw is its own `renderer.render(quad)` → its own encoder and
submit. Setting an MRT inside `passes` after `linear` is allowed (restored by
the `finally`).

`QuadMesh` renders with one module-level `OrthographicCamera(-1, 1, 1, -1, 0,
1)` (`three/renderers/common/QuadMesh.js:7, 104-106`): **every camera node in
a quad material — `cameraProjectionMatrix`, `cameraNear/Far`,
`cameraPosition`, `positionView` — describes that camera** (plan §12). The
galaxy's history passes its own basis (`galaxyTemporal.ts:51-66, 87-93`).

### 7.2 Naming (`render/passTimeline.ts`)

- `namePass(target, label)` (160-162): a `WeakMap` from target object to
  label. A label is an aggregation key; keep it constant.
- Render label (171-181): `canvas` for no target; the named label; else
  `` `${texture.name} ${w}×${h}${samples > 1 ? ` ×${samples}` : ''}` ``.
  `quadPass.gpu.test.ts:183-187` fails any label with that size suffix — a
  pass drawn outside the runner.
- Compute label (183-189): the compute nodes' `.name` (`ComputeNode.setName`,
  `three/nodes/gpgpu/ComputeNode.js:128`), else `compute`.
- Hooks (245-327) on `beginRender`, `beginCompute`, `initTimestampQuery`,
  `copyFramebufferToTexture`; armed only during `measure` (356-444).
- Passes encoded outside three (raw WebGPU) get no timestamps; their time
  shows as a `gap`. The `PassSource` interface (110-114; `attach` 343-347) is
  how the upscaler reports its own under `owned`.
- `ir.passes(frames)` → `harness.passes` (`packages/devtools/src/harness.ts:
1685-1687`) → `GameEngine.measurePasses` (`engine/GameEngine.ts:433-441`) →
  `timeline.measure(present, frames)`; `present` is the sensor chain's
  `render` (`scene/Sensor.tsx:55-62`). Installed at `createRenderer.ts:227`
  only on a device with `timestamp-query`.
- Labels the harness guide promises: `docs/guides/harness.md:667-676` (update
  it when cloud passes land).

### 7.3 The temporal template (`render/galaxyTemporal.ts`)

`GalaxyTemporalVolume` (42-312): rays at `ceil(size / stride)`, history A/B
ping-pong (43-44, 284-288), half-float linear targets (30-39), explicit
camera basis + previous basis uniforms (51-66, 296-299), validity/parallax/
depth tests and a 4-neighbor clamp (106-175), `warm` through
`warmSensorPass` (205-214), passes `galaxy rays` / `galaxy history` (283-286).
It is drawn from _inside_ the scene pass, through the backdrop's node
(`galaxyVolume.ts:471-496`), which is legal only because it reads no scene
output.

---

## 8. Compile-ahead (rule 61, `render/warmup.ts`)

| Function                                             | Lines            | Use                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warmRenderer(gl, layout): WarmRenderer`             | 170-192          | binds the 4×4 stand-in of the layout (`warmTargetFor`, `sceneTarget.ts:65-81`), sets `sensorMrt(layout)`, issues **one `compileAsync` per renderable** (`traverseVisible`) inside the synchronous half, then unbinds |
| `warmCompile(renderer, { object, camera, scene })`   | 221-234          | the visibility toggle; swallows rejection                                                                                                                                                                            |
| `warmSensorPass(renderer, quad, passes: WarmPass[])` | 578-615          | quad materials against each pass's own target, MRT `null`, no tone mapping, working color space, LIFO unbind                                                                                                         |
| `warmPipeline(pipeline, output)`                     | 543-569          | the `RenderPipeline`'s own quad                                                                                                                                                                                      |
| `warmAtMount(producer)` / `register`                 | 527-540, 378-382 | the boot census; idempotent by label                                                                                                                                                                                 |
| `trackAtMount(label, units)`                         | 631-634          | frame-driven producers                                                                                                                                                                                               |

Current producers in this area: `scene/Sensor.tsx:124-141` registers
`compiling the upscaler` and `warming the sensor` (→ `sensor.warm()`,
`sensor.ts:306-315`: upscaler ready, `warmPipeline(post)`, then
`defocus/motion/psf.warm(renderer)`). Scene components warm their own meshes
with `warmCompile(warmRenderer(gl, engine.sceneLayout(gl)), …)`
(`engine/GameEngine.ts:635-637`; list of call sites: WaterPatches,
TerrainPatches, SunFlare, GalaxyVolume, …).

Silent misses (each compiles nothing and resolves anyway):

- invisible object — `warmCompile` toggles it (221-234);
- frustum-culled object — `compileAsync` culls like a render
  (`warmup.gpu.test.ts:175-207`); a full-screen mesh needs `frustumCulled =
false`;
- an object on a camera layer the live camera does not test
  (`Renderer.js:966`, `:3084`) — new risk if the split uses layers;
- a light set different from the frame's: lights enter every material's
  dynamic cache key (`three/renderers/common/RenderObject.js:912-935`;
  `three/renderers/common/nodes/NodeManager.js:590-615`) and lights are
  gated by the layer test
  (`Renderer.js:973`), so **inference**: a pass that renders with a
  different layer mask sees a different light set, and objects warmed under
  the default mask rebuild on first draw unless the lights are on every
  layer;
- a second mesh of a group handed over whole (fixed by one call per
  renderable; `sensor.gpu.test.ts:318-386`).

A draw whose pipeline is still building is skipped without error
(`Renderer.js:3725-3727`; `warmup.gpu.test.ts:119`).

---

## 9. Backends, capability and declared fallbacks

- `probeOutputCapability()` (`render/capability.ts:28-78`) — WebGPU present,
  the media query, and the `rgba16float` + `extended` configure probe
  (88-106); its device is destroyed (76).
- `resolveOutputMode` (`render/output.ts:68-78`), headroom (91-95), DPR
  ceiling 2 / 1.5 (128-132).
- `new WebGPURenderer({ antialias: false, reversedDepthBuffer: true,
trackTimestamp: false, powerPreference: 'high-performance', outputType:
HalfFloatType when extended })` (`createRenderer.ts:180-193`). **No
  `requiredLimits`, no `requiredFeatures`** beyond three's default (three
  requests every supported feature, `WebGPUBackend.js:242-243`).
- WebGL fallback chosen inside `init`: `_getFallback` is wrapped to set
  `reversedDepthBuffer = false`, `logarithmicDepthBuffer = true` before the
  WebGL backend initializes (195-211); `EXT_color_buffer_float` required
  (231-240). On WebGL: no extended output, no FSR, no meter (Automatic
  declared Manual: `sensor.ts:149, 213-219, 366-369`; `exposure` reports
  `automaticAvailable` and `requestedMode`, 316-324), no pass timeline, the
  sea's depth copy and land search off, per-attachment blends collapse to the
  material's.
- Depth decode differs: `perspectiveDepthToViewZ` branches on
  `reversedDepthBuffer` at build (`three/nodes/display/ViewportDepthNode.js:
227-236`); the WebGL log buffer needs `logarithmicDepthToViewZ` (296-303).
  `PassNode.getViewZNode` always uses the perspective form (704).
  `render/sceneDepth.ts` holds the house conventions: `sceneFarDepth` = 0
  reversed / 1 logarithmic (12-14), `expandedLineDepth` (17-26).
- Surface levers (`render/quality.ts`): `terrain`, `ground`, `sea`, `rocks`.
  The sea's `frame` lever selects a **material**, not a uniform, because
  reading the frame is a binding and a split (109-121; `water.ts:104-110,
704-711`). A cloud lever that removes a pass or a split follows the same
  rule.
- Plan §11 decision 3: WebGL draws the far march alone, "declared as it
  declares Manual in place of Automatic" — the precedent is
  `automaticAvailable` in `SensorDiagnostics` (`sensor.ts:64-74, 343`).

---

## 10. Reversed depth and a composite drawn as a scene object

1. **Order.** With `installSceneOrder`, `renderOrder` and `groupOrder` mean
   what they say on both backends. A test renderer without it reverses them
   under reversed depth (`gpuHarness.ts:371` installs it; any ad-hoc
   renderer must too).
2. **List.** The sea is transparent (`water.ts:336`). A composite meant to
   follow it in the _same_ render must be transparent with a higher
   `(groupOrder, renderOrder)` than the shell and the sea (both 0/0) and a
   lower one than rings (0/2), and it then precedes every `go ≥ 1` group
   (plumes, flare, warp). It cannot precede the opaque entry-trace inks
   (0/1, 3–6) or any other opaque overlay: opaque draws first
   (`Renderer.js:1754-1755`). Making the inks transparent switches on
   `Line2NodeMaterial`'s viewport read (`three/materials/nodes/
Line2NodeMaterial.js:512-514`, `viewportOpaqueMipTexture`) — a further
   split (`entryTrace.ts:25-27` says why they are not transparent). Orbit
   traces (transparent 0/0) would sort among the shell and sea by z. The
   cinematic sky (0/8, far-depth test) would overwrite the composite.
3. **Depth.** A full-screen composite is drawn like the backdrop
   (`galaxyVolume.ts:538-540, 553`): `vertexNode = vec4(positionGeometry.xy,
z, 1)`, `frustumCulled = false`, and `depthTest = false`, `depthWrite =
false` — at `sceneFarDepth` with the test on, reversed `GreaterEqual`
   passes only where nothing was drawn. It must not write depth over the
   scene's (the sea, plumes and rings test against it).
4. **Reading depth inside it.** It cannot sample the depth attachment of the
   pass it is drawn in. It needs a copy or a single-sample depth made between
   (see §11).
5. **Camera nodes inside a scene-object composite are the scene camera's**
   (jittered under temporal FSR, consistent with the geometry it covers) —
   the advantage over a quad, whose camera nodes are the ortho quad's.
6. **Blend.** The plan's composite `out = T_c·scene + L_a(0,t₀) +
T_a(0,t₀)·L_j − T_c·L_a(0,t₁)` maps onto the shell's premultiplied blend
   (`materials.ts:436-442`: One / One−SrcAlpha, alpha Zero/One) with `src.rgb
= L_a(0,t₀) + T_a(0,t₀)·L_j − T_c·L_a(0,t₁)` and `src.a = 1 − T_c`, so the
   composite never reads the scene color. **Inference:** only for a gray
   `T_c`; a colored transmittance (Mars dust, phase 6) needs the color read
   or dual-source blending, and `src.rgb` can be negative by design, which no
   blend clamps before FSR or the meter.
7. **MRT rows it writes.** `motion` (`over`): its velocity, `1/d_cloud`,
   alpha = opacity. `reactive` (`union`): `(opacity, 0, 0, opacity)`.
   `meterMask` (`max`): 0. `velocity` (`none`): **replaced** wherever it
   draws — blocked until the upscaler plan's removal lands or the row is
   widened (§2.4). Supplied through a material `mrtNode`, or new shader
   properties like `reactiveCoverage` — `sensorMrt.ts:31-37` explains why
   the flare cannot use a material `mrtNode`; the composite only ever draws
   into the scene target, so it can. It must not use the TSL `velocity` node
   (a full-screen triangle has no object motion).
8. **Exposure.** Through `sensorRadiance`, so `sceneRadianceGain` applies
   (`radiance.ts:95-112`); the trace and history are best kept in physical
   units under `linear: true`, as the galaxy's are (inference).

---

## 11. Inserting the three cloud passes

### 11.1 What any form must provide

- **The trace must read this frame's depth with the sea in it** (the sea
  writes the depth the trace stops at, plan §5.6; `water.ts:337`). So it must
  execute after every under-cloud draw and before the composite — on the GPU
  timeline, not just in call order (fact 2, §0).
- **The composite needs the full-resolution scene depth** for the
  nearest-depth upsample (plan §5.6), and cannot read the attachment it draws
  over: one depth copy, or a render-resolution single-sample depth written by
  a pass between. The sea's whole-texture 4-sample depth copy cost 1.9 ms at
  3840×2400 (ADR-0052:111-112); **inference:** a quad that loads sample 0 into
  `r32float` moves a quarter of those bytes.
- **No camera nodes in quad materials**; pass scene-camera matrices, near/far
  and their previous values as uniforms, captured per render call. Under
  temporal FSR the camera is jittered between `upscale.beginFrame` and
  `endFrame` (`sensor.ts:501-506, 543`); the unjittered matrix needs an
  accessor on `UpscaleNode`.
- **Quad materials read plain textures** — `texture(scenePass.renderTarget.
depthTexture)`, never `scenePass.getTextureNode('depth')` or
  `getViewZNode()`: a `PassTextureNode` puts the scene `PassNode` in the
  quad's graph (`PassNode.js:60-67`), and a RENDER-type pass re-runs for
  each render that includes it — the scene drawn again per quad. Decode with
  `perspectiveDepthToViewZ(texture(depth).x, nearUniform, farUniform)`.
- **History reset** on the sensor's history key (`sensor.ts:485-496`), on
  resize, and on the plan's immediate regime; `ir.settled()`
  (`packages/devtools/src/harness.ts:711-743`) needs a `clouds` readout,
  through the render host (`engine/GameEngine.ts:1019-1064`, beside
  `galaxyRender`).
- **Rows**: reactive/motion exist; velocity is the blocker (§2.4, §10.7).
- **WebGL**: no trace, history or composite; the far march in the sphere
  material, declared in diagnostics.
- **Readouts** obey rule 65: their own vectors, `?.` on privates, never
  throw.

### 11.2 Candidate A — two scene passes (public API only)

Shape: pass A = everything under; cloud passes; pass B = composite first,
then world transparency and overlays, loading what A stored.

What the code needs:

1. **A split of the scene by camera layers** — the only per-render subset
   three offers besides opaque/transparent (`PassNode.setLayers`, 518;
   `renderer.opaque/transparent` cannot split the transparent list by
   order). Every over-cloud **mesh** and every **Group carrying a
   renderOrder** (flare 10, plumes 10, warp 11) must be put on the new layer
   — layers are per object and not inherited (`Renderer.js:3084, 3228-3233`),
   and a Group that fails the test does not set `groupOrder` for its
   children. Lights on every layer (§8). The camera's own mask must include
   both layers so `warmCompile` with the live camera still compiles both sets
   (§8); pass A narrows it with `scenePass.setLayers(under)`.
2. **Pass B as a custom node**, not a second `PassNode` (that would clear,
   `PassNode.js:839`): a `TempNode` with `updateBeforeType = RENDER` whose
   `updateBefore` saves state, `setRenderTarget(scenePass.renderTarget)`,
   `setMRT(scenePass.getMRT())` (same MRT object → same render context, §2.7),
   `autoClear = false` (→ load ops, `three/renderers/common/Background.js:
185-217`), `camera.layers.mask = over`, `renderer.render(scene, camera)`,
   restores (the sensor's `finally` already restores layers, 554).
3. **Re-point everything downstream of the scene at pass B**: upscaler inputs
   (`sensor.ts:196-199`), `motionTexture` (209), meter textures (216-218),
   `radiance` (225-227), `sceneColor` (242-244) and the head of the
   dependency chain (285-288) must read texture nodes owned by pass B (e.g.
   `passTexture(passB, scenePass.getTexture(name))`), or the post-order may
   run FSR and the optics before pass B.
4. **The cloud passes** as `TempNode`s in the chain between `scenePass` and
   pass B (§11.6), or — equally valid in this form — pulled by the
   composite's own material inside pass B, galaxy-backdrop style: anything
   nested inside pass B executes after pass A (already submitted) and before
   pass B. **Inference** from fact 2.
5. **The composite**: a full-screen mesh on the over layer, in pass B's
   **opaque** list with `CustomBlending` (still applied, §2.5) and the lowest
   `(groupOrder, renderOrder)` of the layer, so it precedes the opaque
   entry-trace inks as well as every transparent overlay.
6. **Timeline**: pass B draws into the target named `scene`, so it would
   aggregate into `scene` (count 2). Rename around the call
   (`namePass(target, 'scene over clouds')` then back) or extend
   `passTimeline.ts`. The quads are named by `runQuadPasses`.
7. **Skip pass B** when no body is traced (WebGL, space, clouds off) by
   letting pass A draw both layers; that keeps today's pass count where
   there is nothing to composite.
8. **Tests that move**: `sensor.gpu.test.ts:271` (`info.calls` = 2 a frame),
   the timeline label lists (`water.gpu.test.ts:195`,
   `passTimeline.gpu.test.ts:93-96`), the harness guide's label list.

Risk: none below three's public surface; costs one more store/resolve/reload
of every sample of every attachment per frame (§11.5); every overlay
component gains a layer assignment.

### 11.3 Candidate B — a hand-rolled split after the sea

Shape: one scene render; at the composite's draw a node ends the scene pass,
encodes the cloud passes on **the scene's own encoder**, resumes, and the
composite draws in the resumed pass.

What the code needs:

1. **A `SeaFrameNode`-like node on the composite material** whose
   `updateBefore` drives `renderer.copyFramebufferToTexture` (a 1×1
   rectangle into a 1×1 `FramebufferTexture` is enough to make three end and
   resume, `Renderer.js:2970-2994`) and holds `encoder.beginRenderPass` for
   one call (`seaReflection.ts:240-253`) to encode the cloud passes before
   the resume. Calling the original `begin.call(encoder, …)` for the cloud
   passes' own descriptors, never the held wrapper.
2. **The cloud passes as raw WebGPU** — hand-written WGSL, raw
   `createRenderPipeline`/`createComputePipeline`, bind groups over
   `backend.get(texture).texture`, uniforms by `queue.writeBuffer` — because
   `renderer.render`/`compute` create and submit their own encoders
   (fact 2). **This contradicts plan §3's last bullet** ("every pass is drawn
   through `runQuadPasses`") and gives up TSL for those passes. Reusing
   three-built pipelines on a foreign encoder means driving
   `Renderer._bindings`/pipelines by hand (deeper than SeaFrameNode, which
   holds one call; inference).
3. **Ordering in one list**: composite transparent at a fractional
   `renderOrder` in (0, 1) — after the shell and the sea, before the deck (1)
   and rings (2); then:
   - entry-trace inks (opaque) cannot follow it (§10.2);
   - orbit traces (transparent 0/0) must move above it;
   - the cinematic sky (8) must move below it.
4. **Depth for the composite**: the resumed pass has depth attached again,
   so the raw passes must also write a readable depth (or copy it, as the
   sea does).
5. **Compile-ahead**: raw pipelines are invisible to `warmCompile`; they need
   their own async creation registered through `warmAtMount` (rule 61 is
   about the recipe for three objects; the census still applies).
6. **Timeline**: the resumed pass is named for free by the copy hook (a
   second split reads `… after copy after copy`); the raw passes are a gap
   unless the timeline grows an API to hand them slots (like `PassSource`).
7. **WebGL**: no encoder; the node does nothing (the far march is WebGL's
   path anyway).

Risk: plan §12 — "reaches below [PassNode's] public surface, which is the code
a three upgrade breaks first"; ADR-0052:116-120 already pins the same
internals for the sea (`_currentRenderContext`, `backend.get(ctx).encoder`,
`beginRenderPass`).

### 11.4 A form the code also allows (inference, not in the plan)

When the full sea is in view the pass is already split once. The cloud passes
could be encoded inside **that** split (in `SeaFrameNode`'s held
`beginRenderPass`, after its depth copy), reading the copied depth, with the
composite drawn later in the same resumed pass and reading the copy for its
upsample. Zero added splits on sea frames; but the depth is the seabed's, not
the sea surface's (exact for any cloud above the water, wrong for fog lying on
it), it exists only on sea frames with `sea: full`, and it carries all of
§11.3's raw-WebGPU costs.

### 11.5 What a split costs here (known vs not)

- Known: three always stores every attachment (`WebGPUBackend.js:763-764,
878, 916`); the resume loads all of them (`2826-2833`); MSAA resolves at
  each end. At the default picture that is 8 + 8 + 1 bytes × 4 samples of
  color plus 4 × 4 of depth per pixel loaded again per split (computed).
- Inference: candidate A and candidate B each add exactly one such split
  (pass A's end + pass B's load, versus end + resume), so their tile traffic
  is the same; they differ in code risk and in what can be named, warmed and
  written in TSL. Phase 0 measures it (plan §5.6, §9 "the split's tile store
  unknown").

### 11.6 Recipe: a new full-screen pass that `ir.passes` names and the warm-up compiles

Copy `DefocusNode` (`render/defocus.ts`), `MotionNode` (`render/motion.ts`)
or `GalaxyTemporalVolume` (`render/galaxyTemporal.ts`):

```ts
const LABELS = ['cloud depth', 'cloud trace', 'cloud history'] as const   // constants: aggregation keys

export class CloudTraceNode extends TempNode<'vec4'> {
  static get type() { return 'CloudTraceNode' }
  readonly #stages: readonly WarmPass[] = /* { target: new RenderTarget(1, 1,
     { type: HalfFloatType, depthBuffer: false }), material: new NodeMaterial() } … */
  readonly #quad = new QuadMesh()
  readonly outputTexture = passTexture(this as unknown as PassNode, this.#stages[2]!.target.texture)
  constructor(depth: DepthTexture /* scenePass.renderTarget.depthTexture */) {
    super('vec4'); this.updateBeforeType = NodeUpdateType.RENDER
  }
  override setup(builder: NodeBuilder) {
    const context = (builder as NodeBuilder & { getSharedContext(): typeof builder.context }).getSharedContext()
    // fragmentNodes from plain texture(...) reads and explicit camera uniforms, .context(context)
    return this.outputTexture
  }
  warm(renderer: WebGPURenderer) { return warmSensorPass(renderer, this.#quad, this.#stages) }
  override updateBefore({ renderer }: NodeFrame): undefined {
    if (renderer === null) return
    // size targets from renderer.getDrawingBufferSize / getPixelRatio, write uniforms
    runQuadPasses(renderer, this.#quad, { linear: true, autoClear: true }, (draw) => {
      draw(LABELS[0], this.#stages[0]!.target, this.#stages[0]!.material)
      // …
    })
  }
}
```

Wire-up in `render/sensor.ts`: construct after `scenePass` (161-190); add
`nodeObject(clouds).min(65_504).mul(0)` to the chain **after the scene term
and before the upscaler** (285-290) — or, in candidate A, before pass B;
`await clouds?.warm(renderer)` in `warm()` (306-315); `clouds?.resetHistory()`
beside the upscaler's (494); `clouds?.dispose()` (559-569); a report in
`diagnostics` (325-359). Its targets stay single-sample and depthless; the
depth texture it reads keeps `renderTarget` tied (§2.6), so the binding layout
at warm time matches the frame. Test the names as `quadPass.gpu.test.ts:
121-196` does and the warm-up with `gpu.pipelinesBuilt()`
(`warmup.gpu.test.ts:296-326`, `upscale.gpu.test.ts:313-340`). A compute
pass instead: `renderer.compute(node)` with `node.setName('cloud trace')` for
its timeline label. three r185 has no compute compile-ahead: `computeAsync`
only awaits `init` and dispatches (`Renderer.js:2830-2836`), so a compute
pass's pipeline is built at its first dispatch, and the census entry has to
be a warm-up dispatch (inference about the remedy).

---

## 12. Hook points

| File:line                                                                                                                         | What the weather work does there                                                               |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `render/sensor.ts:161-171`                                                                                                        | scene pass: `setLayers` (A), depth texture the trace reads                                     |
| `render/sensor.ts:191-219`                                                                                                        | re-point upscaler, motion and meter inputs at the final scene texture nodes (A)                |
| `render/sensor.ts:274-299`                                                                                                        | the dependency enumeration: insert cloud nodes (and pass B) between the scene and the upscaler |
| `render/sensor.ts:306-315`                                                                                                        | `warm()`: the cloud passes' `warmSensorPass`                                                   |
| `render/sensor.ts:485-496`                                                                                                        | history key → cloud history reset                                                              |
| `render/sensor.ts:501-508`                                                                                                        | jittered camera from here to `endFrame`; capture camera uniforms inside the nodes              |
| `render/sensor.ts:325-359, 559-569`                                                                                               | diagnostics, dispose                                                                           |
| `render/upscale.ts:197-198, 386-403`                                                                                              | unjittered projection (needs an accessor); jitter window                                       |
| `render/sceneLayout.ts:92-105`                                                                                                    | rows: velocity's fate; any new row is counted against 32 B                                     |
| `render/sensorMrt.ts:38-61, 76-108`                                                                                               | composite's motion/reactive outputs, new properties                                            |
| `render/radiance.ts:95-112`                                                                                                       | composite's pre-exposure and reactive coverage                                                 |
| `render/sceneOrder.ts:10-24`                                                                                                      | composite order (no change; must stay installed)                                               |
| `render/sceneDepth.ts:12-26`                                                                                                      | far depth and depth conventions for a full-screen mesh                                         |
| `render/seaReflection.ts:173-255`                                                                                                 | the split mechanism (B, §11.4)                                                                 |
| `render/passTimeline.ts:160-181, 304-320, 110-114`                                                                                | pass naming, the resumed-pass label, owned sources                                             |
| `render/quadPass.ts:61-98`                                                                                                        | every cloud quad                                                                               |
| `render/warmup.ts:170-234, 527-540, 578-615`                                                                                      | warm the composite mesh and the quads; register in the census                                  |
| `render/createRenderer.ts:180-211`                                                                                                | `requiredLimits` if any MRT exceeds 32 B; WebGL fallback branch                                |
| `render/gpuHarness.ts:364-371`                                                                                                    | the same limits for GPU tests                                                                  |
| `render/quality.ts:109-121`                                                                                                       | precedent for a structural cloud lever                                                         |
| `render/water.ts:330-337`                                                                                                         | the sea writes the depth the trace stops at; §6.5's reflected clouds land in this material     |
| `scene/Sensor.tsx:84-119, 124-141`                                                                                                | per-frame state; warm-up registration                                                          |
| `scene/SceneView.tsx:82-111`                                                                                                      | mount a clouds component (priority 0, before the sensor)                                       |
| `scene/GalaxyVolume.tsx:30-137`                                                                                                   | template for a component owning a node + full-screen mesh                                      |
| `scene/Bodies.tsx:349-355, 531-551`                                                                                               | hide the deck for the traced body                                                              |
| every over-cloud component (`SunFlare`, `ThrusterFx`, `WarpFx`, `OrbitTraces`, `EntryTrace`, `CinematicStage`, rings in `Bodies`) | layer assignment (A) or order changes (B)                                                      |
| `engine/GameEngine.ts:706-711, 1019-1064, 433-441`                                                                                | `pictureEpoch`, render host readouts, `measurePasses`                                          |
| `packages/devtools/src/harness.ts:711-743`                                                                                        | `settled()` gains a clouds readout                                                             |
| `docs/guides/harness.md:667-676`                                                                                                  | the `ir.passes` label list                                                                     |

---

## 13. Gotchas and invariants

- **Nested work runs early** (fact 2). Anything triggered from a scene
  object's node during a render executes before that render on the GPU.
- **A `PassTextureNode` in a quad material re-runs the scene pass** for that
  quad's render (`PassNode.js:60-67`; `updateBeforeType = RENDER`). Plain
  textures only (`sensor.ts:60-61, 280-282`).
- **There is no `velocity` row**: reconstruction reads `motion.rg`, which a
  full-screen composite writes by its opacity (`sceneLayout.ts:78-94`,
  `docs/adr/0044-the-sensor-reconstructs-the-display.md`).
- **32 B MRT**: temporal is at 30 B (§2.4); `requiredLimits` must change in
  two places.
- **Blend states belong to the pass MRT** (`WebGPUPipelineUtils.js:140-160`);
  WebGL and compat mode use the material's blend on every attachment.
- **Opaque before transparent**, whatever `renderOrder` says; the entry-trace
  inks are opaque and become a viewport read if made transparent.
- **The cinematic sky overwrites far-depth pixels** (`cinematicStage.ts:
66-71`): keep it under the clouds.
- **Layers are per object**; a Group must pass the layer test to set
  `groupOrder` (`Renderer.js:3084-3092, 3228-3233`); lights are layer-gated
  and enter every material's cache key (§8).
- **Silent compile misses**: invisible, frustum-culled, wrong layer, wrong
  light set, pipeline not ready.
- **MSAA depth is 4-sample, sample 0 when loaded**; tie any depth copy's
  sample count to its target (`seaReflection.ts:151-171`).
- **Quad camera nodes are the ortho quad's** (`QuadMesh.js:7`).
- **`PassNode.getViewZNode` is perspective-only**; WebGL's depth is
  logarithmic (`ViewportDepthNode.js:227-236, 296-303`).
- **Jitter** lives on the scene camera from `beginFrame` to `endFrame`;
  `velocity` is globally unjittered while temporal (`upscale.ts:197-198`).
- **three's velocity camera history is keyed on `frameId`**
  (`VelocityNode.js:105-141`), which forty `render()` calls in one task do
  not advance (`sensor.ts:172-189`); keep the cloud history's own previous
  pose per render call.
- **Restore everything** a stage sets, in `finally` (ADR-0029; `quadPass.ts`;
  `sensor.ts:542-557`). A thrown frame must cost one frame.
- **Pre-exposure**: radiance in the scene target is ×`sceneRadianceGain`; the
  sea divides it back out of what it reads (ADR-0052:59-62); so must any
  pass that reads the frame.
- **NaN**: bound terms before multiplying by zero (`sensor.ts:283-284`); a
  NaN in a history persists (plan §5.5).
- Rules that bind this area (`AGENTS.md`, `docs/agents/invariants.md`):
  **52** (no two planetary radii subtracted in a shader, no screen-space
  derivative of a planetary position — the trace's shell entry from CPU
  heights, plan §3), **58** (lattice coordinates in a tile-local frame, no
  float lattice decisions — the noise lattices), **59** (one cloud shadow,
  ground and sphere alike), **60** (`three/webgpu` and `three/tsl` only),
  **61** (compile-ahead through `render/warmup.ts`, idempotent by label),
  **65** (a readout neither changes the frame nor stops it), **68** (GPU
  work holds the machine's GPU lock — the phase 0 rig, `pnpm test:gpu` and
  plates never together), **38**/rendering rule (a frame uses the
  snapshot's presentation instant, `snapshot.renderTime` or the held
  instant), **15**/**17** (nothing regenerable is stored; the weather is
  presentation, ADR-0044:140-141 for history state).

---

## 14. Tests that pin this area

| Test                                   | Pins                                                                                                       | Moves with clouds?                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `sensor.gpu.test.ts:110-171`           | chain = renderer's own frame at headroom 1                                                                 | no                                           |
| `sensor.gpu.test.ts:173-235`           | renderer restored after a throw                                                                            | extend to the new nodes                      |
| `sensor.gpu.test.ts:237-278`           | `info.calls` = 2 per frame, pass is the frame's own                                                        | **yes** (A adds a render; quads add renders) |
| `sensor.gpu.test.ts:318-386`           | warm-up compiles the pass's pipelines                                                                      | extend to pass B / composite                 |
| `upscale.gpu.test.ts:313-340`          | full temporal layout warmed, zero pipelines on first frame                                                 | extend                                       |
| `upscale.gpu.test.ts:342-361`          | reactive coverage written                                                                                  | composite's opacity                          |
| `upscale.gpu.test.ts:363-405`          | optical chain in one exposure domain; **5/3 attachments**                                                  | yes if rows change                           |
| `upscale.gpu.test.ts:407-440`          | history restarts on cuts and domain changes                                                                | mirror for clouds                            |
| `upscale.gpu.test.ts:442-491`          | rigid velocity zero across a rebase                                                                        | composite velocity                           |
| `upscale.gpu.test.ts:493-526`          | reversed depth separable at 1e8 m without `frag_depth`                                                     | no                                           |
| `sceneLayout.test.ts:40-116`           | 4 channels for alpha-reading blends; material blend on `output` only; temporal rows; interning; meter byte | yes if rows change                           |
| `water.gpu.test.ts:186-219`            | full sea = one split, plain = none                                                                         | yes (labels)                                 |
| `passTimeline.gpu.test.ts:77-128`      | both sides of a copy timed; nothing timed after                                                            | B: a second copy                             |
| `passTimeline.test.ts`                 | `summarize` arithmetic                                                                                     | no                                           |
| `quadPass.gpu.test.ts:60-118, 121-260` | runner restores state; every optical and galaxy pass found by name, no size-suffixed labels                | add cloud labels                             |
| `warmup.gpu.test.ts:86-229, 296-353`   | warm recipe, cull, depthless sensor passes, stand-in lifetime                                              | add the composite (cull, layer)              |
| `warmup.test.ts:57-350`                | census, idempotence                                                                                        | no                                           |
| `radianceReactivity.gpu.test.ts:84`    | union reactive blend                                                                                       | composite over opaque/translucent            |
| `sensorMotion.gpu.test.ts:37`          | optical motion bypass at a rebase                                                                          | composite motion                             |
| `cloudEntry.gpu.test.ts:14-53`         | the deck clears on descent                                                                                 | retires with the deck (phase 3)              |
| `picture.test.ts:146-257`              | render grid = the pass's own extent                                                                        | trace/history extents                        |
| `createRenderer.test.ts:89-231`        | renderer build, fallback                                                                                   | `requiredLimits`                             |

---

## 15. Open questions

1. Is the adapter's `maxColorAttachmentBytesPerSample` on the M5 in Chrome 152
   ≥ 34 (only matters if `velocity` stays and widens)? `scripts/gpuAdapter.mjs`
   reports it under Dawn; Chrome's value is not recorded anywhere in the tree.
2. Does the upscaler plan's `velocity` removal land before phase 0? The
   composite's velocity write depends on it.
3. Which side of the clouds do the entry-trace inks and the orbit traces
   belong on — instruments drawn over clouds, or world transparency veiled by
   them? The plan names "entry traces" as world transparency; the code makes
   them instruments.
4. Does a pass B rendered with a narrower layer mask rebuild the over-layer
   objects' programs because the light set differs (§8)? Measurable with
   `gpu.pipelinesBuilt()`.
5. Should the trace's extent follow the render target (FSR ratio) or the CSS
   size (plan §5.5's Retina rule), and how does it combine with the
   supersample picture (4 samples at DPR × 2)?
6. Where does the composite's depth come from — a whole 4-sample copy, a
   sample-0 resolve, or a nearest-of-four resolve — and what does phase 0's
   hull-in-cloud case need?
7. A colored cloud transmittance (dust) cannot ride a single-alpha blend
   (§10.6): does phase 6 need the color read, and therefore a different
   composite form?
