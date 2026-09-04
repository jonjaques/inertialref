import {
  type Camera,
  DepthTexture,
  HalfFloatType,
  NodeUpdateType,
  RenderPipeline,
  RenderTarget,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu'
import { pass, renderOutput, vec4 } from 'three/tsl'

/*
 * The sensor: the chain every presented frame goes through.
 *
 * `docs/design/art.md` says the canopy is a sensor, and this file is where the
 * scene stops being drawn straight onto the canvas and becomes an image the
 * instrument produces. The spine is one `RenderPipeline` around one scene pass
 * and the house tone curve, and nothing else yet — the exposure, the glare and
 * the rest of `design/plans/the-sensor.md` hang passes off it. What the spine
 * settles is ownership: the frame is the sensor's to draw, and the scene's
 * radiance is a texture the chain can read before the curve sees it, which is
 * what a histogram meter or a point-spread function needs and the renderer's
 * own output pass cannot give them.
 *
 * **At headroom 1 it is pixel-identical to the renderer drawing the scene
 * itself, by construction.** The renderer's own path draws the scene into an
 * internal half-float target and blits it through
 * `texture(target).renderOutput(toneMapping, outputColorSpace)` on a
 * full-screen triangle. `RenderPipeline` with `outputColorTransform` left on
 * builds exactly that node over the pass's texture, and the curve's exposure
 * is the same `toneMappingExposure` reference in both. The clear, the depth
 * format and the sample count all agree, which the pipeline cache key
 * cares about and the picture does not. The gate in
 * `sensor.gpu.test.ts` reads both paths back from a float target and holds
 * them equal; the browser diff is in the ADR.
 *
 * **MSAA lives on the pass target, and the renderer is built without it.**
 * `RenderPipeline.render` switches the renderer's tone mapping off while the
 * quad draws, and `Renderer.currentSamples` then falls back to the sample
 * count the renderer was constructed with — so a renderer built with
 * `antialias: true` would give the *canvas* a four-sample color buffer and a
 * resolve, every frame, for a triangle that has no edge inside the frame.
 * With the renderer at zero samples and the pass asking for four, the scene
 * is multisampled where it has edges and the canvas is written once.
 *
 * That moves one obligation onto the warm-up: a pipeline is keyed on the
 * sample count and formats of the target it draws into, so a compile against
 * the renderer's own framebuffer builds a zero-sample variant the chain never
 * uses. `warmTargetFor` hands `warmup.ts` a target of the pass's shape.
 */

/**
 * What the scene pass draws into, described once so a warm-up can build a
 * target of the same shape before the sensor exists.
 *
 * Half-float, the renderer's own output buffer type, so nothing above 1 is
 * lost before the curve; a `DepthTexture` at the class default, which the
 * backend allocates as `depth24plus` — the same format the renderer gives its
 * internal framebuffer — so the depth half of the pipeline key matches too.
 */
export interface SceneTargetShape {
  /** 4 or 0. WebGPU has no other count. */
  readonly samples: number
}

/** The per-renderer record of the shape, and the stand-in built to it. */
interface SceneTargetRecord {
  readonly shape: SceneTargetShape
  standIn: RenderTarget | null
}

/*
 * Keyed on the renderer object because that is what every caller holds: the
 * factory has the handle, the scene components have R3F's `gl`, and both are
 * the same object. A rebuild is a new renderer and therefore a new record.
 */
const targets = new WeakMap<object, SceneTargetRecord>()

/**
 * Say what the scene pass will draw into, before anything compiles.
 *
 * Called by `createRenderer` with the sample count the constructor was *not*
 * given — see the file comment — so the warm-up and the sensor build their
 * targets from one number.
 */
export function declareSceneTarget(
  renderer: object,
  shape: SceneTargetShape,
): void {
  targets.get(renderer)?.standIn?.dispose()
  targets.set(renderer, { shape, standIn: null })
}

/** The declared shape, or the renderer's own sample count when none was. */
export function sceneTargetShape(renderer: WebGPURenderer): SceneTargetShape {
  return targets.get(renderer)?.shape ?? { samples: renderer.samples }
}

/**
 * A target of the scene pass's shape, for a compile.
 *
 * A stand-in rather than the live pass target because the warm-up starts from
 * the effect that sees the renderer, and the sensor mounts inside the canvas
 * tree the same tick — which of the two runs first is React's business. The
 * pipeline key holds only the sample count and the formats, so any target of
 * the shape compiles the pipeline the pass will use, and four pixels is the
 * cheapest one that exists.
 */
export function warmTargetFor(renderer: WebGPURenderer): RenderTarget {
  const shape = sceneTargetShape(renderer)
  let record = targets.get(renderer)
  if (record === undefined) {
    record = { shape, standIn: null }
    targets.set(renderer, record)
  }
  record.standIn ??= sceneTarget(4, 4, shape)
  return record.standIn
}

function sceneTarget(
  width: number,
  height: number,
  shape: SceneTargetShape,
): RenderTarget {
  const depthTexture = new DepthTexture(width, height)
  depthTexture.isRenderTargetTexture = true
  const target = new RenderTarget(width, height, {
    type: HalfFloatType,
    samples: shape.samples,
    depthTexture,
  })
  return target
}

export interface Sensor {
  /**
   * Draw one frame: the scene through the chain, presented to `target`.
   *
   * `null` is the canvas, and it is the default because presenting is what the
   * chain is for. **Passing it explicitly is load-bearing in the app.** R3F
   * clears the render target to the canvas at the top of its own `gl.render`,
   * and a priority-1 subscriber takes that render away — so R3F never clears
   * it, and whatever last ran a compute readback or an offscreen bake (the GPU
   * tile producer, the atmosphere bake) has left its own target set. The output
   * quad would then draw the frame into that target instead of the canvas, and
   * the canvas stays black. A test that reads the frame back passes its own
   * target here instead.
   */
  render(target?: RenderTarget | null): void
  /** What the scene pass draws into — the radiance before the curve. */
  readonly sceneTarget: RenderTarget
  dispose(): void
}

/**
 * Build the chain for one scene and camera.
 *
 * The pass's target follows the renderer's size and pixel ratio on its own —
 * `PassNode.updateBefore` reads both every frame — so R3F's `dpr` is the one
 * producer of the buffer's size, for the chain as for the canvas.
 *
 * The output node writes alpha 1 rather than the pass's own. The pass target
 * clears to the renderer's opaque black, and every additive material here
 * already holds its alpha writes to zero, so the scene's alpha is 1 anyway —
 * but an alpha-0 pixel on the `rgba16float` canvas is the compositor artifact
 * `flare.ts` documents, and a constant is a guarantee where a scene's blend
 * state is a convention.
 */
export function createSensor(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
): Sensor {
  const shape = sceneTargetShape(renderer)
  const scenePass = pass(scene, camera, { samples: shape.samples })
  /*
   * The pass draws the scene once per *render call*, not once per three
   * frame.
   *
   * `PassNode` ships as `NodeUpdateType.FRAME`: its scene render is gated on
   * `nodeFrame.frameId`, and the only thing that advances that counter is the
   * `requestAnimationFrame` loop three starts for itself in `init()` — not a
   * call to `render()`. R3F drives this chain from its own loop, one call per
   * rAF, so in the page the two agree by coincidence; anywhere the chain is
   * asked for two frames in one task they do not. `measureGpuFrameMs` submits
   * forty `render()` calls back to back and would time one scene and
   * thirty-nine quads; a headless gate that draws a second frame through one
   * chain reads the first frame's pass back, because the harness stubs the
   * loop and the counter stays at one; and a throw inside the pass leaves the
   * frame marked as drawn, so nothing renders again until three's loop moves
   * on. Keyed on the render call, the pass runs exactly when `render()` does
   * — once per presented frame in the app, once per call everywhere else.
   */
  scenePass.updateBeforeType = NodeUpdateType.RENDER
  const post = new RenderPipeline(renderer)

  /*
   * The chain ends in its own `renderOutput`, and `outputColorTransform` is
   * off so that `RenderPipeline` does not add a second one.
   *
   * The default (`outputColorTransform = true`) wraps `outputNode` in a
   * `renderOutput` whose color space it reads back **at draw time** — and
   * `render()` sets `renderer.outputColorSpace` to the working (linear) space
   * for the duration of the quad draw, so the transform bakes _linear_ and the
   * sRGB OETF never runs. The frame reaches an 8-bit canvas as raw linear
   * light: a lit hull at 0.04 linear encodes to 0.04 instead of the 0.22 the
   * transfer function gives it, which reads as the whole picture nine stops
   * too dark in the shadows. Owning the `renderOutput` here fixes the color
   * space to the renderer's real one, taken once, before that swap.
   *
   * The response is chosen per mode anyway — Direct clips where Composite
   * rolls off — which is the plan's reason for this being explicit rather than
   * `RenderPipeline`'s to decide. `vec4(…, 1)` writes opaque alpha: the pass
   * clears to opaque black and every additive material holds its own alpha
   * writes to zero, but an alpha-0 pixel on the `rgba16float` canvas is the
   * compositor artifact `flare.ts` documents, so the constant is the guarantee.
   */
  post.outputColorTransform = false
  const sceneColor = vec4(scenePass.getTextureNode('output').rgb, 1)
  let builtToneMapping = renderer.toneMapping
  let builtColorSpace = renderer.outputColorSpace
  const buildOutput = (): void => {
    builtToneMapping = renderer.toneMapping
    builtColorSpace = renderer.outputColorSpace
    post.outputNode = renderOutput(
      sceneColor,
      builtToneMapping,
      builtColorSpace,
    )
    post.needsUpdate = true
  }
  buildOutput()

  return {
    sceneTarget: scenePass.renderTarget,
    render(target: RenderTarget | null = null) {
      // R3F sets `toneMapping` after the factory resolves and `commitToneCurve`
      // sets it back; a mode switch sets it again. The response is baked into
      // the output node, so a change is a rebuild, not a uniform write.
      if (
        renderer.toneMapping !== builtToneMapping ||
        renderer.outputColorSpace !== builtColorSpace
      )
        buildOutput()
      // Present here, not wherever the last offscreen pass left the target —
      // see the interface note. The pass's own `updateBefore` saves and
      // restores this around the scene render, so the quad draws to it.
      renderer.setRenderTarget(target)
      /*
       * `RenderPipeline.render` swaps the renderer to `NoToneMapping` and the
       * working color space while the quad draws and puts both back with two
       * assignments after it — no `finally`. The scene renders *inside* that
       * swap, through the pass, so a throw from anywhere in the scene leaves
       * the renderer holding the swapped values for good, and the check above
       * then reads them as a mode change and rebuilds the output with no curve
       * and no transfer. Every frame after that presents raw linear radiance
       * clamped to one: the pixel the curve puts at 59/255 on a lit hull
       * reaches the canvas at 15, on every scene, uniformly, and nothing in
       * the picture says why. Restoring here makes an exception cost the one
       * frame it was thrown in. `sensor.gpu.test.ts` throws one to hold it.
       */
      const toneMapping = renderer.toneMapping
      const outputColorSpace = renderer.outputColorSpace
      try {
        post.render()
      } finally {
        renderer.toneMapping = toneMapping
        renderer.outputColorSpace = outputColorSpace
      }
    },
    dispose() {
      post.dispose()
      scenePass.dispose()
    },
  }
}
