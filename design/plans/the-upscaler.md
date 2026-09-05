# The upscaler: the sensor draws small and reconstructs the display

[The sensor](the-sensor.md) owns the frame: one `RenderPipeline` around one
scene pass and the house curve, and everything a camera does to light hangs
off it. This page is the plan for the one thing that makes the scene pass
cheaper rather than the picture richer — rendering the scene at a fraction of
the display and reconstructing the display from it with
[`@pmndrs/upscaler`](https://github.com/pmndrs/upscaler), AMD's FidelityFX
Super Resolution brought to three's `WebGPURenderer` as WGSL compute passes.
It is optional, it is one row of the same picture record the anti-aliasing
lives in, and at its fullest it is a temporal reconstruction that anti-aliases
for free, a reactive mask for every blended surface in this scene, an exposure
the sensor's meter will condition, and a set of guides the motion-blur phase
of the sensor plan reads instead of re-deriving.

What this page is not: the sensor's exposure, glare and response are
[the sensor](the-sensor.md); the ground's own detail levers are
[terrain](terrain.md); and the depth buffer this needs is a change the render
coordinates record has been naming as complementary since
[ADR-0003](../../docs/adr/0003-render-coordinates.md).

| Landed                                                   | The record                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| three r185.1, without a patch, the harness yielding      | [ADR-0030](../../docs/adr/0030-three-r185.md), `render/gpuSetup.ts`, `render/schedulerYield.ts`         |
| The sensor spine the upscaler sits inside                | [ADR-0029](../../docs/adr/0029-the-sensor-spine.md), `render/sensor.ts`                                 |
| The anti-aliasing preference the picture record replaces | `render/output.ts` (`AaLevel`), `state/preferences.ts` (`RENDER_AA`), `hud/GraphicsPanel.tsx`           |
| The lens and the display-referred terrain predicate      | [ADR-0017](../../docs/adr/0017-the-lens.md), [ADR-0015](../../docs/adr/0015-terrain-level-of-detail.md) |
| The measurement rig every figure below is taken with     | `render/measure.ts`, `ir.gpu()`, the plate protocol in ADR-0029                                         |

Not built: the reversed-Z depth buffer, the picture record, the spatial path,
the temporal path, the reactive mask, the cut declaration, the URL knob, the
harness verb, the per-pass timings, the guides seam.

---

## Where the numbers come from

Every figure below is one of three things, and each is labeled. A
**measurement** is from this repository's rig — an Apple M-series at 1600×900,
DPR 1, in the occluded driven Chrome, one Chrome on the GPU at a time, the
world pinned by one save, the median of five after the first — which is the
rig [ADR-0029](../../docs/adr/0029-the-sensor-spine.md) measured the spine
with. A **published number** is the library's own, from its
[`PARITY.md`](https://github.com/pmndrs/upscaler/blob/main/PARITY.md), taken at
1920×1080 on Apple Metal with the source-style FSR 3.1.5 graphs as the
comparison. A **budget** is a claim this plan makes and the phase that lands it
replaces with a measurement.

The spine's own cost, measured, is the line everything here is added to:

| Operating point                            | Chain, ms |
| ------------------------------------------ | --------- |
| Earth from 14,400 km, planetarium          | 1.78      |
| Earth summit, converged (877 patches)      | 5.87      |
| Proxima Centauri d from orbit, planetarium | 0.49      |
| Proxima Centauri d summit, converged       | 4.43      |
| `tng-intro` at frame 800                   | 0.90      |

The library's production temporal path at ratio 2 costs **0.63 ms** of GPU
compute at 1920×1080 (published), of which the fused reconstruct pass is
0.035 ms, RCAS 0.068 ms and the shading-change detector 0.044 ms. Scaled by
pixels, that is a **budget** of 0.44 ms at the rig's 1600×900 and 1.8 ms at the
3200×1800 buffer a retina window draws — the upscaler's cost is per display
pixel and does not fall with the render resolution.

Five facts about the library, read from its source at 0.2.0 rather than its
README, shape the architecture and are stated here so nobody re-derives them:

- **It is raw WebGPU on three's device.** `Upscaler` reaches
  `renderer.backend.device` and `backend.get(texture).texture`, encodes its
  compute passes on its own command encoder, and submits between three's scene
  render and the output quad; queue order is the whole synchronization. Both
  internals are present in r185.1. There is no WebGL path and there will not
  be one, so on the fallback backend the option does not exist.
- **Depth is bound as `texture_depth_2d` and linearized with the camera's
  near and far** — the standard or reversed perspective formula, chosen by
  `renderer.reversedDepthBuffer`. A logarithmic depth value put through
  either formula is a number, not a distance. § 2 is about this.
- **Motion vectors are three's own `velocity` node** — the NDC delta between
  this frame's clip position and the previous frame's, from the object's
  previous `matrixWorld` and the camera's previous view and projection. The
  projection it must use is the _unjittered_ one, which the upscaler publishes
  as a stable `Matrix4` the node is pointed at once. The camera's previous
  matrices advance once per `nodeFrame.frameId`, which three's own animation
  frame advances and this repository's harness never does.
- **The jitter is `camera.setViewOffset`** over the render size, a Halton(2,3)
  sequence of `round(8·ratio²)` phases: 8 at native, 18 at Quality, 23 at
  Balanced, 32 at Performance, 72 at Ultra Performance. `beginFrame` applies
  it and `endFrame` clears it, and every consumer of the camera between the
  two sees a projection half a render pixel off.
- **The disocclusion tolerance is relative, not absolute.** The depth-clip
  vote accepts a reprojected tap within
  `1.37e-5 · |renderSize/2| · max(depth, previousDepth)` view units, widened
  by the 3×3 ring's own relief — about 0.84 % of the depth at the Quality
  render size. Units cancel; what matters is that the linearized depth is a
  distance.

---

## 1. Principles

**The upscaler sits between the scene pass and the response.** Its input is
linear radiance at render resolution and its output is linear radiance at
display resolution; it never applies a curve, a transfer or a clamp. It goes
where the sensor plan already puts every pass — after the scene and before
`renderOutput` — and the curve, the extended range, the alpha-1 guarantee and
the restore-in-`finally` are untouched by it. The library's node would apply
three's tone mapping if it were the output node; here it never is.

**One picture record, not two switches.** Anti-aliasing and upscaling are one
closed set of legal combinations: the temporal path _is_ an anti-aliaser and
refuses a multisampled input; the spatial path composes with MSAA; a
supersampled buffer and a reduced render resolution are opposite requests. A
record with a guard that rejects the illegal pair is the shape
`render/quality.ts` already gives the surface — "a partial record is the
failure mode a per-field guard cannot see".

**The frame stays the sensor's.** The library's `UpscalerNode` is keyed on
three's frame counter, reads the wall clock for its delta, and takes the scene
camera for its depth constants. Each of those is a decision this repository has
already made the other way — the pass is keyed on the render call
([ADR-0029](../../docs/adr/0029-the-sensor-spine.md)), the picture is a
function of the tick, and the camera's depth convention is the renderer's. So
the _kernel_ is the library's `Upscaler` and the _node_ is ours, forty lines
modeled on theirs, in `render/upscale.ts`.

**A cut is declared, not detected.** History is reset when the engine says the
eye jumped — a teleport, a load, a shot boundary, a look, a preset — through
one call. Where a jump goes undeclared the depth clip rejects history at every
silhouette on its own, so a missed declaration costs one frame of ghosting
rather than a wrong picture, and the list can grow without ever having to be
complete.

**Display-referred stays display-referred.** The terrain predicate counts
display pixels per cell and the lens's `pixelAngle` is per display pixel;
neither learns the render resolution. The upscaler reconstructs to the display,
so the detail a viewer can resolve is the display's, and the patch count does
not fall with the render size. Whether it _should_ is a lever with a measured
cost, in § 6, not a default.

**Measured at two points, one outside Sol.** Every figure a phase records is
taken at the Earth summit and at the Proxima Centauri d summit at least, at
DPR 1 and at DPR 2, and names the point, the ratio and the buffer size in the
sentence.

---

## 2. Depth: reversed-Z replaces the logarithmic buffer

The renderer is built with `logarithmicDepthBuffer: true`, which is what makes
a near plane at 5 cm and a far plane at 10¹⁰ m share one buffer: every
material writes `frag_depth` as `log(w/near)/log(far/near)`. The upscaler
cannot read that. Its dilate pass picks the nearest of nine depths and
linearizes the winner with the perspective formula, and its depth clip
compares that distance against last frame's; a log value through
`far·near/(far − d·(far − near))` is monotone but wrong by orders of
magnitude, so the tolerance above is measured against the wrong distance and
disocclusion fires everywhere or nowhere.

A standard depth buffer would linearize correctly and is unusable for a
different reason: with these planes `d ≈ 1 − near/z`, and float32 has one
step of 6·10⁻⁸ next to one, so every surface past about 10⁶ m — the whole
planetarium — quantizes to the same value or its neighbor. That is the
precision argument the log buffer was chosen for, restated as the upscaler's
problem.

**Reversed-Z with a float depth is the convention the upscaler wants, and it
is the one three r185 offers.** `reversedDepthBuffer: true` on the renderer
maps the near plane to 1 and infinity to 0, so the stored value is `near/z` to
float32's relative precision at every distance, and the upscaler's reversed
formula returns `z` exactly. The pass's `DepthTexture` goes to `FloatType` —
`depth32float` — because a 24-bit fixed buffer gives reversed-Z none of that.
Nothing here reads depth today besides the sensor's own target (`rg` finds no
`depthNode`, no `viewportDepth`, no consumer of the pass's depth texture), so
the change is the renderer flag, the target's type, and the removal of the
fragment-depth write from every material's program.

Two consequences beyond the upscaler, both to be measured rather than assumed:

- The log buffer's `frag_depth` write disables early depth testing on every
  material. Reversed-Z removes the write. On the fragment-bound operating
  points — three stacked full-screen shells at the Earth summit — that is a
  saving the phase measures with `ir.gpu()` and records, and it may be the
  larger effect of the whole plan.
- The WebGL 2 fallback needs `EXT_clip_control` for reversed depth; where it
  is absent three keeps the standard buffer. The fallback keeps the logarithmic
  buffer instead, chosen per backend in `createRenderer`, because the fallback
  is where the upscaler does not exist anyway.

If reversed-Z shows a regression the phase cannot close — a seam, a z-fight at
Bennu's 500 m, the sea sheet through the seabed — the fallback is a
relinearization pass: one full-screen draw at render resolution writing
reversed depth from the log value through `material.depthNode` into a
`depth32float` target the upscaler reads. Budget 0.05 ms at the Quality render
size. It is the fallback and not the plan because it keeps the fragment-depth
write and its cost on every material.

---

## 3. The chain with the upscaler in it

```
scene ─▶ pass(scene, camera)          render res · MRT: output · velocity · reactive
      │                                samples 0 on the temporal path, 4 with MSAA
      ├─ depth                         depth32float, reversed (§ 2)
      ▼
   upscale(color, depth, velocity)     render/upscale.ts: our node, the library's kernel
      │                                display res · linear · rgba16float
      ▼
   … the sensor's later passes …       glare, the sensor, the response — unchanged
      ▼
   renderOutput(vec4(rgb, 1))          the curve and the encode, alpha 1
```

**The pass renders small.** `scenePass.setResolutionScale(1/ratio)` — the
pass keeps its own size from the drawing buffer and scales it, so R3F's `dpr`
stays the one producer of the buffer's size and the upscaler's display size is
read from the same place. The target's shape — sample count, attachment
formats, depth type — is declared once through `declareSceneTarget`, which
grows from a sample count to a layout, and `warmTargetFor` builds the stand-in
to the same layout, because a pipeline is keyed on every attachment it draws
into and a warm-up against the wrong shape compiles a variant nothing draws
with. The `velocity` attachment is what adds a variant: it puts the previous
model matrix into every material's vertex stage.

**Our node, the library's kernel.** `render/upscale.ts` exports
`createUpscale(renderer, inputs, options)`, a `TempNode` whose `setup`
registers the color, depth, velocity and reactive nodes as graph dependencies
— exactly as the library's node and three's own `FSR1Node` do, so three renders
them in dependency order inside the pipeline — and whose `updateBefore` calls
`Upscaler.dispatch`. It differs from the library's node in four lines:
`updateBeforeType = NodeUpdateType.RENDER`, for the reason the pass is; the
delta is the one the sensor's `render(delta)` is handed, clamped to 0.1 s as
the library clamps its own, because it feeds nothing canonical — exposure
adaptation and lock aging — and history converges per presented frame; the
camera handed to `dispatch` is the scene camera, whose near, far and
`reversedDepthBuffer` are now the right constants; and `resetHistory` is a
method the sensor calls from the cut declaration in § 5. The output is
`passTexture(node, upscaler.outputTexture)`, a stable node whose value is
re-pointed on a reconfigure, so the sensor's graph is built once.

**The jitter is applied in `sensor.render`,** `beginFrame(camera)` before
`post.render()` and `endFrame(camera)` in the `finally` beside the tone-mapping
restore. Not through the pipeline's `onBeforeRenderPipeline` hook the library
uses: the sensor already owns the render call and the restore, and a jitter
undone in the same `finally` cannot outlive a frame that throws. `CameraRig`
writes `fov` and `aspect` at priority 0 and calls `updateProjectionMatrix`
only when they change, so nothing between the offset and its clearing
rewrites the projection — and every priority-0 consumer of the camera, the
labels, the flare's occlusion, the track overlay, reads it before the sensor
runs and never sees the offset. The `velocity` node is pointed at
`upscaler.unjitteredProjectionMatrix` when the chain is built; it is the
module singleton from `three/tsl`, so a rebuilt chain points it again.

**The output is linear and the alpha is 1.** The upscaler writes
`rgba16float` in the caller's domain; the sensor's `renderOutput` takes
`vec4(upscaled.rgb, 1)` and the curve, the extended range and the encode run
as they do today. r185's `renderOutput` unpremultiplies before the curve and
premultiplies after, which is a second reason the constant alpha is a
guarantee and not a convention.

**Resize and reconfigure.** The node compares the drawing buffer and the
pass's texture size each render and calls `configure` when either moved,
which reallocates the working set and resets history; a resize is a cut. The
working set at the retina buffer is not small and is a **budget** from the
library's allocation list: five display-resolution `rgba16float` textures —
the output, two history, two locks — at 3200×1800 are 230 MB, and the
render-resolution set at Quality — two depths, the motion, the masks, the
reactive mask, two luma histories, the shading signal — about 85 MB; at
1600×900 the same set is about 80 MB. Phase 4 reads the device's own figure
back through the perf panel rather than trusting this arithmetic.

**Boot.** `Upscaler.init()` creates nine compute pipelines synchronously with
`createComputePipeline`. That is a main-thread stall at the first sensor build
of an unknown size — the library has no async form — and the phase measures
it, registers it as one unit of the warm-up census (`compiling the upscaler`)
so the boot cover counts it, and files the async form upstream if it is more
than a frame.

---

## 4. The picture record

`render.aa` is three detents, `off`, `2x` and `4x`, and it is replaced by one
record with the same owner and the same panel:

```ts
interface Picture {
  /** How edges are resolved. `temporal` is the upscaler's own anti-aliasing. */
  readonly aa: 'off' | 'msaa' | 'supersample' | 'temporal'
  /** The render resolution as a fraction of the display, by AMD's names. */
  readonly scale: 'native' | 'quality' | 'balanced' | 'performance' | 'ultra'
  /** RCAS after the upscale. `standard` is the library's 0.8. */
  readonly sharpness: 'off' | 'standard' | 'crisp'
}
```

What each combination runs, and the guard that refuses the rest:

| `aa`          | `scale`   | The pass                      | The upscaler                                       |
| ------------- | --------- | ----------------------------- | -------------------------------------------------- |
| `off`         | `native`  | 0 samples, display size       | none                                               |
| `msaa`        | `native`  | 4 samples, display size       | none — today's `2x`                                |
| `supersample` | `native`  | 4 samples, 2× display         | none — today's `4x`                                |
| `off`, `msaa` | any other | 0 or 4 samples, display/ratio | **spatial**: EASU, then RCAS                       |
| `temporal`    | `native`  | 0 samples, display size       | **temporal** at ratio 1 — AMD's "Native AA", a TAA |
| `temporal`    | any other | 0 samples, display/ratio      | **temporal**: reconstruct, accumulate, RCAS        |
| `supersample` | any other | refused by the guard          | a bigger buffer and a smaller one is not a setting |

Ratios by AMD's table: Quality 1.5, Balanced 1.7, Performance 2.0, Ultra
Performance 3.0 — per axis, so Quality renders 44 % of the pixels and
Performance 25 %.

- **Migration.** `render.aa` is read once through `readObsolete`, the way
  `camera.fov` became the lens: `off` → `{ aa: 'off' }`, `2x` → `msaa`,
  `4x` → `supersample`, each with `scale: 'native'` and
  `sharpness: 'standard'`. Nobody who chose a level loses it.
- **What rebuilds.** Today the MSAA boundary is in the canvas key and a change
  remounts the renderer, because the pass is built once per renderer.
  [ADR-0029](../../docs/adr/0029-the-sensor-spine.md) notes the renderer no
  longer carries the sample count and the sensor could be rebuilt in place;
  this is where that happens. `scene/Sensor.tsx` keys its effect on the
  record, disposes the chain and builds another, the warm stand-in is
  re-declared to the new layout, and the canvas key loses its `msaa` segment.
  The cost of a change is the pipeline variants the next frame compiles for
  the new target shape, which the notice names — `rebuilding the sensor` —
  where today it names a renderer rebuild.
- **The engine's knob** stays one field: `engine.supersample` is 2 for
  `supersample` and 1 otherwise, so the terrain predicate divides the
  drawing-buffer inflation back out exactly as it does now and never sees the
  render scale.
- **Capability.** On the WebGL backend `temporal` and every non-native scale
  are drawn disabled with the reason on the row — `needs WebGPU` — the way the
  output row says `auto → standard`; the guard still accepts them, because a
  preference is a wish and the backend is a fact, and the resolver in
  `render/output.ts` gets a sibling, `resolvePicture(preference, backend)`,
  that is what the sensor reads.
- **The panel.** Three `OptionGroup` rows under one `Picture` section in
  `GraphicsPanel`, drawn from the definitions as every row there is. The
  detail line under `scale` prints the render size it resolves to at this
  window — `1067×600 of 1600×900` — because a fraction is a claim and a pixel
  count is a fact. `hud.test.ts`'s radio-group census grows by two.
- **The URL knob.** `QUERY.picture` — `?picture=temporal:quality`,
  `?picture=native` — overrides the stored record for the page's life without
  writing it, read where `?presentation=` is. The driver puts it on a URL the
  way it puts the presentation flag; the plate rig needs it because a plate is
  defined at a picture and a stored preference is somebody's.

---

## 5. The temporal path: velocity, cuts, the reactive mask, the exposure

**Velocity across the rebase.** The render origin is a snapped grid point that
jumps ([ADR-0003](../../docs/adr/0003-render-coordinates.md)); at a rebase
every object's `matrixWorld` and the camera move by the same vector, and the
velocity node's `previous view × previous model` product is the same view-space
position before and after, so a body at rest has zero velocity across a rebase
by construction. That is the property the sensor plan's motion-blur phase
already wants tested, and it lands here: `upscale.gpu.test.ts` reads the
velocity attachment back across a forced rebase and holds it to zero at every
texel. Vertex displacement is the one thing the node cannot see:
`positionPrevious` is the geometry's own attribute, so the terrain's morph, the
sea's waves and the plume carry the velocity of their rigid transform and not
of their displacement. The morph moves sub-pixel per frame at every distance
it runs at; the waves are the reason the sea is on the reactive list.

**Cuts.** `GameEngine.declareCut()` increments a presentation counter,
`pictureEpoch`; the sensor compares it once per render and calls
`resetHistory` when it moved. It is called from the harness verbs that move
the eye discontinuously — `orbit`, `land`, `look`, `rise`, `preset`, `visit`,
`goTo`, `shot` — from `load`, from `play` and `seekCutscene`, from the
director at every shot boundary, from a mode's presentation stance on mount,
and from the canvas epoch. An observatory transition is eased and is not a
cut; a lens change is a real motion and is not a cut. `pictureEpoch` is not
canonical and is not in the state hash: it counts frames, not seconds, and
nothing downstream of it is simulation.

**The reactive mask is an MRT attachment the blended materials write.** The
temporal path ghosts on anything that has no watertight depth and no motion of
its own, and this scene is full of it. Rather than the library's auto-mask —
which renders the scene a second time with the transparents hidden, the cost
this plan exists to remove — each material that blends sets `material.mrtNode`
to `mrt({ reactive: <coverage> })`, which three merges into the pass's MRT per
material, and the pass declares `reactive: float(0)` for everything else.
The census, from the materials that set `transparent` or hold their depth
writes, and what each writes:

| Surface                       | Where                                       | Reactive    | Why                                                                          |
| ----------------------------- | ------------------------------------------- | ----------- | ---------------------------------------------------------------------------- |
| Atmosphere shell, cloud shell | `render/planet.ts`                          | its alpha   | no depth write; the limb is where it is thin and it moves with the body      |
| Star disk and glow            | `render/materials.ts`                       | 1           | additive, no depth                                                           |
| Starfield sprites             | `render/materials.ts`                       | 0           | a shell at the far plane moving with the camera: the rigid velocity is right |
| Lens flare quads              | `render/flare.ts`                           | 1           | camera-space, additive in color; no history is right for them                |
| Plumes, warp effects          | `render/plumes.ts`, `render/warpEffects.ts` | 1           | additive, animated                                                           |
| Orbit traces                  | `scene/OrbitTraces.tsx`                     | 1           | lines, no depth write                                                        |
| The sea sheet                 | `render/water.ts`                           | 0.3         | writes depth; its waves are displacement the velocity cannot see             |
| The rings                     | `render/proceduralRings.ts`                 | to classify | phase 4 reads the material and decides                                       |

The additive materials' blend state applies to every attachment, so a 1 adds
to the mask and saturates; an alpha-blended material's coverage blends by its
own alpha. `DebugView.Reactivity` is how the phase checks the mask says what
this table says.

**Exposure.** The library conditions accumulation in an invertible tonemap
space so fireflies cannot dominate the history, and it meters its own
pre-exposure by default. That stays on until the sensor's phase 1 lands;
then `exposureTexture` is the meter's 1×1 and `preExposureTexture` is the
pre-exposure the materials bake, so the history is conditioned by the number
the curve uses and a stepped exposure does not read as a full-screen shading
change. The sensor plan's § 4 gains the sentence.

**RCAS.** `standard` is the library's 0.8; `crisp` is 1.0; `off` is 0, where
the spatial path blits EASU alone and the temporal path skips the sharpen. A
detent rather than a slider, because a slider is a second picture.

**What the harness can and cannot prove.** The camera's previous matrices in
the velocity node advance per `nodeFrame.frameId`, which the harness holds at
one; so a headless test of camera motion reads zero velocity and a test of
object motion reads the right one. The GPU gate moves the mesh, and the
browser proves the camera. The temporal plate is a function of the history:
after `ir.pause()` the jitter keeps cycling and the output converges over
`phaseCount` frames, so a plate is taken after that many and compared at one
phase — `ir.picture().phase` — and two boots of one build define the noise
floor, the way ADR-0029 took the cutscene's. The spatial plate has no history
and is exact.

---

## 6. What the picture costs, and what it buys

The budget, before phase 3 measures it — the spine's line plus the library's
published cost scaled by pixels, against the scene at 44 % and 25 % of the
pixels on the fragment-bound points:

| Operating point, 1600×900, DPR 1 | Native, measured | Quality, budget | Performance, budget |
| -------------------------------- | ---------------- | --------------- | ------------------- |
| Earth summit, converged          | 5.87 ms          | 3.0 ms          | 1.9 ms              |
| Proxima Centauri d summit        | 4.43 ms          | 2.4 ms          | 1.6 ms              |
| Earth from 14,400 km             | 1.78 ms          | 1.2 ms          | 0.9 ms              |

The budget assumes the scene scales with its pixels, which the atmosphere's
shells and the ground do and the terrain's vertex work does not; it is why the
figure is a budget. At DPR 2 the upscaler's own line is four times larger and
so is the saving, and the handheld — where `dprCeiling` already trades pixels
for frames — is the case the option exists for. The three lines
[technical](../../docs/design/technical.md#frame-budget--166-ms) gives the
GPU add up to 8 ms; the summit at Quality fits under them where native does
not.

**The terrain lever, declined as a default.** Scaling `cellPixels` by the ratio
would cut the patch count with the render size — at Quality, about half the
patches at the summit — and it is a real saving on the CPU and the pool as
well as the GPU. It is not the default because the display is the same display
and the reconstruction is meant to reach it; a viewer who chose Quality did
not choose coarser ground. It is a lever in the surface record if the summit
figure says the patches are the frame, and the plate at Quality with and
without it is what decides.

---

## 7. Declined, with the reason

- **`upscaleScene`, the library's one-line integration.** It owns the pass. The
  sensor already owns one with MSAA for the spatial path, the render-call key,
  the warm stand-in and the restore, and the library's pass is none of those.
- **`UpscalerNode` as shipped.** Frame-keyed, so the harness's second frame
  reads the first; a wall-clock delta, which is the rule the timing module
  exists to keep out of the frame; and the render-pipeline hook for the
  jitter, where the sensor's own `finally` is the safer place. Forty lines of
  our own, tested here.
- **The auto-generated reactive mask.** A second draw of the whole scene with
  the transparents hidden, every frame. The MRT attachment is one channel on
  the draw already made.
- **MSAA on the temporal path.** The library refuses a multisampled input, and
  the temporal path is the anti-aliaser.
- **A sharpness slider.** The sensor plan's rule: a strength slider on an
  effect is a second instrument. Three detents.
- **The bilinear path as a preference.** It is the library's baseline for
  comparison and the rig's, reachable through `?picture=bilinear:quality`,
  never through the panel.
- **Dynamic resolution.** A ratio that moves with the frame time resets the
  jitter sequence and the history at every step, and the picture would breathe
  with the load. A ratio is chosen, not solved.
- **Frame generation.** Not in the library, and not possible from a page:
  it needs swapchain-level pacing the browser does not expose.
- **The WebGL fallback.** The library is WebGPU-only by design. The record's
  non-native rows do not exist there and the panel says so.

---

## 8. Phases

Each phase lands on its own, is gated by a measurement, and ends with the
decision it settled written into an ADR and the section above it deleted.

**Phase 0 — three r185.1** has landed:
[ADR-0030](../../docs/adr/0030-three-r185.md) records what it took, what it
measured and what the review of it corrected.

**Phase 1 — reversed-Z.** `reversedDepthBuffer: true` on the WebGPU backend,
the pass's `DepthTexture` at `FloatType`, `declareSceneTarget` carrying the
depth type, the logarithmic buffer kept for the WebGL backend alone. Gate: the
plate gate at the five points; a z-fight sweep at Bennu from 500 m, at the
Earth summit and at the shoreline; the sea over the seabed; `ir.gpu()` at the
two summits with the fragment-depth write gone, recorded here; and a spike
in `.scratch/` mounting the library's `DebugView.Disocclusion` over the pass
to see the mask fire at the hull over terrain and at Phobos crossing Mars in
the planetarium at 64× warp. The ADR is _the depth buffer_.

**Phase 2 — the picture record.** `Picture`, its guard, `resolvePicture`, the
migration from `render.aa`, the three rows, the sensor rebuilt in place from
an effect keyed on the record, the canvas key without its `msaa` segment,
`QUERY.picture`, `ir.picture()`. Gate: `picture.test.ts` holds the guard, the
migration and the table above; `hud.test.ts` counts eight groups; the plates
at `off`, `msaa` and `supersample` are pixel-identical to today's three; an
anti-aliasing change logs no `renderer ready`.

**Phase 3 — the spatial path.** `render/upscale.ts` around `Upscaler` on the
spatial path, the pass at `setResolutionScale`, the stand-in to the pass's
layout, the census unit for the compute pipelines. Gate: `upscale.gpu.test.ts`
holds a constant field to itself at display size, RCAS at `off` to EASU alone,
and the first chain frame to zero new pipelines; the cost table in § 6
replaced by measurements at DPR 1 and DPR 2; EASU's plate against the native
plate at the summit recorded as an RMSE and looked at.

**Phase 4 — the temporal path.** The velocity and reactive attachments, the
jitter in `sensor.render`, the unjittered projection on the velocity node,
`declareCut` and its callers, the reactive table, `temporal` at every scale
including native, the debug views on `ir.picture`. Gate: the rebase property
on the GPU; convergence — after `phaseCount` frames at pause the temporal
plate against the native plate at the summit, the bound measured, not derived,
and two boots of one build as the floor; the ghost test — Phobos crossing Mars
and the hull over terrain with `AccumulationAge` showing a trail and no smear
past the silhouette; the flare and the plumes under `Reactivity` white; the
cost table again, and the device's memory figure.

**Phase 5 — the seams and the record.** `trackTimestamp` on the renderer under
`?timing=full` so `upscaler.gpuTimings` reaches the perf panel per pass;
`exposureTexture` and `preExposureTexture` when the sensor's phase 1 has
landed; `temporalGuides` published for the motion-blur phase to read the
dilated motion instead of its own tile pass; the ADR, _the upscaler_, with the
tables from § 6 as measurements.

---

## 9. The order it is worth taking

1. **Phase 1**, alone and first. It is a renderer change with its own plate
   gate, it is probably a saving on its own, and nothing temporal is honest
   without it.
2. **Phase 2**, which is independent of phase 1 and can land beside it. It
   retires a renderer remount and is worth having with no upscaler at all.
3. **Phase 3**, the spatial path — half the value, no history, exact plates,
   and the whole of the plumbing the temporal path then inherits.
4. **Phase 4.** The reactive table is the part that takes iteration; the
   debug views are what make it iteration rather than guesswork.
5. **Phase 5**, when the sensor's exposure exists to couple to.

---

## Caveats that shape these numbers

- **Every millisecond in § 6 is a budget until its phase measures it**, and
  the two inputs it is built from were taken on different machines at
  different sizes: the spine's line on the rig at 1600×900, the library's on
  the author's at 1920×1080. The library's number is compute alone and
  excludes the texture reads three's output quad then does.
- **The rig is 1600×900 at DPR 1 and the win is at DPR 2.** Terrain selection
  is display-referred, so the retina buffer asks for four times the patches
  and is a different frame; every phase measures both and says which.
- **The temporal plate is not exact and the protocol says how inexact.** A
  plate is a function of the history; the number a phase records is the
  difference between two boots of one build at one jitter phase, and a change
  is judged against that.
- **The library's internals are internals.** `backend.device` and
  `backend.get(texture).texture` are verified at r184 by the author and at
  r185.1 here; a three upgrade re-verifies both before anything else, and the
  accessors throw rather than limp.
- **`Upscaler.init()` is synchronous** and its cost at boot is unmeasured
  until phase 3.

---

## Not in this plan, deliberately

- The exposure meter, the glare, the response: [the sensor](the-sensor.md).
- The ground's detail levers and the patch budget: [terrain](terrain.md);
  the one lever this plan names is § 6's and it is declined as a default.
- Frame generation, dynamic resolution, a WebGL upscaler: § 7.
- Any consumer of the temporal guides beyond naming the seam.

---

## Reproducing

```bash
# the library, read rather than remembered: the API, the parity notes, the demos
git clone --depth 1 https://github.com/pmndrs/upscaler <scratch>/upscaler
#   src/Upscaler.ts, src/UpscalerNode.ts, PARITY.md, examples/{05,07,11}-*/main.ts
open https://pmndrs.github.io/upscaler/

# the spine's cost at an operating point, which every figure here is added to;
# the world pinned by a save loaded after the look — ADR-0029 has the protocol
node scripts/drive.mjs --url 'http://localhost:5173/?timing=full' \
  --js "await ir.gpu(60)" --down

# a plate at a picture, once phase 2 has landed
node scripts/drive.mjs --url 'http://localhost:5173/planetarium?picture=temporal:quality' \
  --js "ir.preset('earthrise')" --wait 12000 --js "ir.pause()" --wait 400 \
  --js "ir.picture()" --shot quality.png --max-px 0 --down

# the kernels on the real GPU: the spatial identity, the rebase property, convergence
pnpm vitest run --config apps/game/vitest.gpu.config.ts upscale.gpu
```

---

## Related

- [ADR-0029](../../docs/adr/0029-the-sensor-spine.md) — the chain this sits
  inside, and the rig every figure is measured with
- [ADR-0003](../../docs/adr/0003-render-coordinates.md) — the rebase the
  velocity has to be zero across, and the reversed-Z note
- [ADR-0015](../../docs/adr/0015-terrain-level-of-detail.md),
  [ADR-0017](../../docs/adr/0017-the-lens.md) — why selection and the pixel
  angle stay display-referred
- [the sensor](the-sensor.md) — the exposure this couples to and the
  motion-blur phase that reads the guides
- [perf](perf.md) — the frame this is measured against
- [art](../../docs/design/art.md#also-required) — the row that has been
  asking for reversed-Z
- [technical](../../docs/design/technical.md#frame-budget--166-ms) — the
  three GPU lines
- [`@pmndrs/upscaler`](https://github.com/pmndrs/upscaler) — the library;
  `PARITY.md` for what it measures against FSR 3.1.5, `TEMPORAL-GUIDES-SPEC.md`
  for the guides contract, the [demos](https://pmndrs.github.io/upscaler/)
  for what each path looks like
