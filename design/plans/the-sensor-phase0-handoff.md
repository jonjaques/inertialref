# The sensor, phase 0 — handoff

Branch `feat/the-sensor-pre-exposure`, cut from `1a32b38`. This is the spine of
[`the-sensor.md`](the-sensor.md) § 11 phase 0: `PostProcessing` with the scene
pass and the house curve, `Sensor.tsx` at priority 1, the warm-up taught the
chain's target, and `ir.gpu()` for the cost figure. It is **headless-complete
and green, and not yet presenting correctly in the browser** — the chain is
mounted only behind `?sensor=1`, so the app renders through R3F for everyone
else and nothing here is on the default path.

## What is done and green

- **`render/sensor.ts`** — `createSensor(renderer, scene, camera)` builds one
  `PostProcessing` around `pass(scene, camera)`, ends in its own `renderOutput`
  with `outputColorTransform = false`, writes opaque alpha, and presents to a
  target the caller names (`null` = canvas). `declareSceneTarget` /
  `sceneTargetShape` / `warmTargetFor` carry the pass's MSAA-and-format shape to
  the warm-up.
- **`scene/Sensor.tsx`** — the priority-1 `useTimedFrame` that takes the frame
  from R3F, built in an effect (StrictMode-safe), gated by `SENSOR_CHAIN`
  (`?sensor=1`). Sets `engine.present` so the measurement rig submits through the
  same chain.
- **`render/sensor.gpu.test.ts`** — three GPU gates, all green
  (`pnpm vitest run --config apps/game/vitest.gpu.config.ts sensor.gpu`, ~0.4 s):
  the chain is pixel-identical to the renderer's own tonemapped output at
  headroom 1 (worst < 1e-5 into a float target); a `vec4(8,4,2)` survives to the
  output unclamped and encodes 2.0 → 1.353 through the sRGB transfer; the
  warm-up seam builds the scene's pipelines so the frame adds at most the output
  quad.
- **The warm-up learns the chain (`render/warmup.ts`).** `warmRenderer` now binds
  a target of the pass's shape around `compileAsync`, so every `warmCompile`
  caller (all of them already route through it) builds pipelines for the pass
  target rather than the renderer's own framebuffer. This is a no-op with the
  chain off — the two target shapes are identical (4-sample HalfFloat,
  depth24plus) so the pipelines are shared.
- **`ir.gpu(frames?)`** — the perf dock's "measure GPU" as a harness verb, so the
  driver takes the drained-queue figure without a click. `measure.ts` now takes a
  `draw()` thunk (the chain, or `renderer.render`), and `GameEngine.measureGpu`
  supplies it; `render/measure.ts` says why the old scene/camera signature was a
  figure about a path nothing presents.

`pnpm graph`, `pnpm lint`, `pnpm typecheck` and the sensor GPU gate are green.
The full `pnpm test` was running at handoff.

## The open problem — canvas presentation

The chain renders **correctly**. Proven two ways: the headless gate holds it to
the renderer's own output within 1e-5, and in the live page on one paused frame,
`setOutputRenderTarget(float)` + `gl.render` versus the chain into a float target
differ by **exactly 0** across 508k lit pixels. A chain readback into an 8-bit
target reads 238 at a highlight where the baseline PNG also reads 238.

But a **screenshot of the chain presenting to the canvas** is off: midtones
crush and highlights clip. On the paused cutscene frame 800, a lit hull pixel is
`srgb(59,56,54)` in the shipped render and `srgb(15,14,14)` through the chain —
and 59 → 15 is exactly the sRGB→linear transfer. The whole frame reads one
transfer-function too dark in the midtones, uniformly, on every scene (Earth,
the summit, the cutscene), at `standard`/headroom-1 (rgba8 canvas). Same HDR mode
both runs — verified `standard hr1` for `?sensor=1` and the plain URL.

So the discrepancy is **only** in presenting the final quad to the canvas, not in
the render. Ruled out, each measured, not argued:

- **Not the output node.** `vec4(pass.rgb,1)`, `getTextureNode('output')`, and
  `outputColorTransform=false` + explicit `renderOutput` all give the identical
  screenshot.
- **Not double tone.** The pass output is linear HDR (max 16942 on that frame);
  the curve runs once, at the quad.
- **Not MSAA.** The first attempt was 0-sample and equally dark; the pass and the
  renderer's own framebuffer are both 4-sample.
- **Not the pass texture's color space.** It is `NoColorSpace` (no read
  conversion); renderer output is `srgb`, working is `srgb-linear`,
  `ColorManagement.enabled` is true — the same values R3F's own blit reads.
- **Not the render target type.** An 8-bit and a float offscreen target read the
  same value at the same pixel.

The one thing that changed the picture from black to rendered was making the
chain present to `null` explicitly (`render(target = null)` calls
`renderer.setRenderTarget(target)` first): at priority 1 R3F never clears the
render target, so a compute readback or a bake leaves its own target set and the
quad drew into that. That is in and correct.

### The next thing to try

The gap is between three's own canvas-output path (`Renderer._renderOutput`,
`Nodes.getOutputNode`, which uses `renderer.currentColorSpace` at draw time) and
`PostProcessing`'s quad presenting to the same canvas. Both should encode sRGB
into the rgba8 swap chain identically; one of them is not. Concretely:

1. **Read the canvas, not a screenshot.** `Page.captureScreenshot` is the only
   canvas reader the rig has, and it may be applying its own transform to the
   chain's swap-chain frame. Confirm the defect on the real display, or with a
   Firefox trace of the `?sensor=1` page (`scripts/traceFrames.mjs`), before
   spending more on the node graph — this could be a capture artifact over a
   correct frame.
2. If the canvas is genuinely wrong, compare the WGSL of `PostProcessing`'s quad
   against `Renderer._renderOutput`'s quad for this renderer (custom
   `CustomToneMapping`, `logarithmicDepthBuffer`, standard rgba8 canvas). The
   suspect is which color space each bakes for the canvas write.
3. Fallback worth pricing: let the renderer's own output path present (feed the
   chain's result back through `renderer.render` of the composited node) so the
   canvas encode is byte-for-byte today's, rather than `PostProcessing` writing
   the swap chain itself.

## Measurements taken (baseline, no chain, 1600×900 DPR 1, standard, M-series)

Drained-queue ms/frame via the same loop `measureGpuFrameMs` runs:

| Operating point                   | GPU ms/frame |
| --------------------------------- | ------------ |
| Flight start (home, gibbous)      | 2.78         |
| Planetarium, Earth from 14,400 km | 3.36         |
| Earth summit, converged           | 6.24         |

These are the **without-chain** figures the phase-0 budget compares against; the
chain's added cost is not measurable until it presents, and is the phase-0 gate's
last number.

## Reproduce

```bash
# headless gates (green)
pnpm vitest run --config apps/game/vitest.gpu.config.ts sensor.gpu

# the chain in the browser, behind the flag
node scripts/drive.mjs --url 'http://localhost:5173/planetarium?sensor=1' \
  --js "ir.look('g:milky-way/s:SOL/b:2')" --wait 6000 --js "ir.chrome(false)" \
  --shot chain.png --max-px 0
# compare against the same URL without ?sensor=1 — the midtone-crush is the defect
```
