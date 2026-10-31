import {
  createUpscale,
  type PictureDebug,
  type UpscaleDiagnostics,
} from './upscale.ts'
import { pictureRatio, pictureSharpness, pictureUpscales } from './picture.ts'
import {
  attachment,
  attachmentBytes,
  attachmentFormat,
  attachmentType,
  sceneBackend,
  sceneLayout,
  type SceneLayout,
} from './sceneLayout.ts'
import { PsfNode } from './psf.ts'
import type { RenderOrigin } from '@inertialref/spatial'
import { sensorMrt } from './sensorMrt.ts'
import { DefocusNode } from './defocus.ts'
import { MotionNode } from './motion.ts'
import { sensorSignature } from './signature.ts'
import { DISPLAY_P3 } from './gamut.ts'
import { invariant } from '@inertialref/shared'
import {
  type Camera,
  type Node,
  NodeUpdateType,
  RenderPipeline,
  RenderTarget,
  type Scene,
  type WebGPURenderer,
  Vector2,
} from 'three/webgpu'
import { nodeObject, pass, renderOutput, texture, vec4 } from 'three/tsl'
import {
  defocusParameters,
  ExposureMeter,
  GLASS_PRESETS,
  LOOK_SHOULDERS,
  shutterFraction,
  type Exposure,
  type Lens,
  type SensorSettings,
} from '@inertialref/rendering'
import { createHistogramMeter } from './meter.ts'
import { setSceneExposure } from './radiance.ts'
import { toneCurveFor } from './tonemap.ts'
import { warmPipeline } from './warmup.ts'
import { SensorHistory } from './sensorHistory.ts'
import { ENHANCED_SKY_GAIN, ENHANCED_SKY_CEILING } from './enhancedSky.ts'
import { namePass } from './passTimeline.ts'

/* The sensor owns the only scene draw, then applies lens-side optics,
 * detector response and the canvas encode. MSAA belongs to the scene target;
 * the output triangle has no interior edge that needs multisampling.
 *
 * Every compile uses the pass's layout (`render/sceneLayout.ts`): pre-exposed
 * radiance, velocity.xy / reciprocal view-space meters, and a meter-only
 * instrument mask. The mask does not alter the presented image.
 * Internal optical quads read plain textures; the final dependency graph
 * schedules each pass exactly once per render call. ADR-0031.
 */

export interface SensorDiagnostics {
  readonly picture: UpscaleDiagnostics
  readonly automaticAvailable: boolean
  readonly enhancedSkyGain: number
  readonly enhancedSkyCeiling: number
  readonly meterMaskBytes: number
  readonly maximumCircle: number
  readonly defocusPasses: number
  readonly motionPasses: number
  readonly shutterFraction: number
}

export interface Sensor {
  warm(target?: RenderTarget | null): Promise<void>
  /** Compile the upscaler's pipelines; settles once a dispatch can run. */
  warmUpscale(): Promise<void>
  readonly exposure: Exposure | null
  readonly diagnostics: SensorDiagnostics
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
  render(target?: RenderTarget | null, delta?: number): void
  /** What the scene pass draws into — the radiance before the curve. */
  readonly sceneTarget: RenderTarget
  dispose(): void
}

export interface SensorFrame {
  readonly pictureEpoch?: number
  readonly pictureDebug?: PictureDebug
  readonly lens: Lens
  readonly settings: SensorSettings
  readonly time: number
  readonly adaptationTime?: number
  /** Identifies cuts and a held photographic-time scrub independently of adaptation. */
  readonly historyKey?: string
  readonly renderOrigin?: RenderOrigin | null
  readonly stagingLook?: boolean
  readonly pinned: number | null
  /**
   * How far down its air the eye stands — 1 on the ground, 0 at the air's
   * top and in space (`observerAir`). Enhanced meters by its share of it.
   */
  readonly depth?: number
  readonly headroom: number
  /** The display gamma, `ToneCurveControls.gamma`; 1 when absent. */
  readonly gamma?: number
  readonly motionBlur?: boolean
  readonly noiseTick?: number
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
  layout: SceneLayout,
  frame?: () => SensorFrame,
  diagnostic?: 'bilinear',
): Sensor {
  const exposure = new ExposureMeter()
  const history = new SensorHistory()
  const automaticAvailable = 'isWebGPUBackend' in renderer.backend
  let requestedMode: SensorSettings['mode'] | undefined
  // Resolved once, by the layout: what the pass draws into and what it is
  // reconstructed from are one picture by construction.
  const picture = layout.picture
  // A layout is made for a backend's depth convention; one made for another
  // renderer would draw depth the pass does not hold.
  invariant(
    layout === sceneLayout(picture, sceneBackend(renderer)),
    'the scene layout was made for another backend',
  )
  const temporal = attachment(layout, 'velocity') !== null
  const scenePass = pass(scene, camera, { samples: layout.samples })
  namePass(scenePass.renderTarget, 'scene')
  scenePass.renderTarget.depthTexture!.type =
    layout.depthType ?? scenePass.renderTarget.depthTexture!.type
  scenePass.setResolutionScale(1 / pictureRatio(picture))
  scenePass.setMRT(sensorMrt(layout))
  for (const row of layout.attachments) {
    const texture = scenePass.getTextureNode(row.name).value
    texture.format = attachmentFormat(row)
    texture.type = attachmentType(row)
  }
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
  const upscale =
    automaticAvailable && pictureUpscales(picture)
      ? createUpscale(
          renderer,
          {
            color: scenePass.getTextureNode('output'),
            depth: scenePass.getTextureNode('depth'),
            velocity: temporal ? scenePass.getTextureNode('velocity') : null,
            reactive: temporal ? scenePass.getTextureNode('reactive') : null,
          },
          camera,
          {
            path: diagnostic ?? (temporal ? 'temporal' : 'spatial'),
            ratio: pictureRatio(picture),
            sharpness: pictureSharpness(picture),
          },
        )
      : null
  const motionTexture = scenePass.getTextureNode('motion')
  const mask = attachment(layout, 'meterMask')
  const maskBytes = mask === null ? 0 : attachmentBytes(mask)
  const meter =
    frame === undefined || !automaticAvailable
      ? null
      : createHistogramMeter(
          scenePass.renderTarget.texture,
          motionTexture.value,
          scenePass.getTextureNode('meterMask').value,
        )
  const post = new RenderPipeline(renderer)

  // Pin the encode before RenderPipeline temporarily swaps the renderer to
  // linear output. The scene alpha is not the canvas alpha: present opaque.
  post.outputColorTransform = false
  const radiance = texture(
    upscale?.outputTexture.value ?? scenePass.renderTarget.texture,
  )
  const defocus =
    frame === undefined
      ? null
      : new DefocusNode(radiance, texture(motionTexture.value))
  const motion =
    defocus === null
      ? null
      : new MotionNode(defocus.outputTexture, texture(motionTexture.value))
  const psf =
    frame === undefined
      ? null
      : new PsfNode(motion?.outputTexture ?? defocus?.outputTexture ?? radiance)
  const signature =
    psf === null ? null : sensorSignature(texture(psf.outputTexture.value))
  const sceneColor =
    signature?.linear ??
    vec4((upscale?.outputTexture ?? scenePass.getTextureNode('output')).rgb, 1)
  const size = new Vector2()
  // The report reads the drawing buffer too, and it is read between frames.
  // `size` is the submitted frame's viewport — the key the defocus circle and
  // the signature were measured at — so a getter must not move it.
  const reportSize = new Vector2()
  let previousTime: number | null = null
  let previousGeneration = 0
  let previousPictureKey: string | null = null
  const keyFor = (state: SensorFrame): string =>
    [
      state.settings.mode,
      state.pinned,
      state.historyKey ?? '',
      state.lens.fStop,
      state.lens.shutter,
      state.lens.iso,
      state.lens.focalLength,
      state.lens.zoom,
      state.lens.gauge,
    ].join(':')
  const cameraFor = (state: SensorFrame) => ({
    position: camera.position,
    orientation: camera.quaternion,
    origin: state.renderOrigin,
  })
  let previousFocus = ''
  let maximumCircle = 40
  let builtToneMapping = renderer.toneMapping
  let builtColorSpace = renderer.outputColorSpace
  const buildOutput = (): void => {
    builtToneMapping = renderer.toneMapping
    builtColorSpace = renderer.outputColorSpace
    const encoded = renderOutput(sceneColor, builtToneMapping, builtColorSpace)
    if (signature === null || psf === null) post.outputNode = encoded
    else {
      // Dependencies are enumerated here, once per presented frame. Internal
      // quads read plain textures, so their draws cannot resubmit the scene or
      // an earlier optical pass. Even a bypass updates its downstream texture.
      // Each term is bounded before the zero: the scene target can hold +Inf
      // where two clamped draws blend, and Inf × 0 is NaN in the canvas.
      let dependencies: Node<'vec4'> = vec4(
        scenePass.getTextureNode().rgb.min(65_504).mul(0),
        0,
      )
      if (upscale !== null)
        dependencies = dependencies.add(nodeObject(upscale).min(65_504).mul(0))
      if (defocus !== null)
        dependencies = dependencies.add(nodeObject(defocus).min(65_504).mul(0))
      if (motion !== null)
        dependencies = dependencies.add(nodeObject(motion).min(65_504).mul(0))
      dependencies = dependencies.add(nodeObject(psf).min(65_504).mul(0))
      post.outputNode = dependencies.add(signature.encode(encoded))
    }
    post.needsUpdate = true
  }
  buildOutput()

  return {
    warmUpscale: async () => {
      await upscale?.ready()
    },
    warm: async (target = null) => {
      // A failed upscaler compile is its own boot step's failure, already
      // reported. The post and optical pipelines are still worth warming.
      await upscale?.ready().catch(() => {})
      if (upscale !== null) radiance.value = upscale.outputTexture.value
      await warmPipeline(post, target)
      for (const optical of [defocus, motion, psf]) {
        await optical?.warm(renderer)
      }
    },
    get exposure() {
      return exposure.reading === null
        ? null
        : {
            ...exposure.reading,
            automaticAvailable,
            ...(requestedMode === undefined ? {} : { requestedMode }),
          }
    },
    get diagnostics() {
      renderer.getDrawingBufferSize(reportSize)
      return {
        picture: upscale?.diagnostics ?? {
          path: 'native',
          renderWidth: scenePass.renderTarget.width,
          renderHeight: scenePass.renderTarget.height,
          displayWidth: reportSize.x,
          displayHeight: reportSize.y,
          phase: 0,
          phaseCount: 1,
          frames: 0,
          resets: 0,
          workingTextureBytes: 0,
          initMs: 0,
          gpuTimings: {},
          debug: 'none',
        },
        automaticAvailable,
        enhancedSkyGain:
          exposure.reading?.processing === 'enhanced' ? ENHANCED_SKY_GAIN : 1,
        enhancedSkyCeiling: ENHANCED_SKY_CEILING,
        // Each sample and the resolve: the multisampled mask is resolved for
        // the meter, so a four-sample layout holds the mask five times.
        meterMaskBytes:
          scenePass.renderTarget.width *
          scenePass.renderTarget.height *
          (layout.samples + 1) *
          maskBytes,
        maximumCircle,
        defocusPasses: defocus?.passes ?? 0,
        motionPasses: motion?.passes ?? 0,
        shutterFraction: motion?.fraction.value ?? 0,
      }
    },
    sceneTarget: scenePass.renderTarget,
    render(target: RenderTarget | null = null, delta = 1 / 60) {
      const state = frame?.()
      let generation = 0
      if (state !== undefined) {
        requestedMode = state.settings.mode
        const settings =
          !automaticAvailable && state.settings.mode === 'automatic'
            ? { ...state.settings, mode: 'manual' as const }
            : state.settings
        generation = history.advance(
          keyFor(state),
          state.adaptationTime ?? state.time,
          cameraFor(state),
        )
        if (generation !== previousGeneration) exposure.reset()
        previousGeneration = generation
        const reading = exposure.update(
          state.lens,
          settings,
          state.adaptationTime ?? state.time,
          state.pinned,
          state.depth ?? 0,
        )
        setSceneExposure(
          renderer,
          reading.pre,
          reading.total,
          reading.processing,
        )
        renderer.getDrawingBufferSize(size)
        renderer.toneMappingExposure = signature === null ? reading.residual : 1
        const glass =
          state.pinned === null ? GLASS_PRESETS.flight : GLASS_PRESETS.cinematic
        signature?.update(
          state.lens,
          glass,
          settings,
          size.x,
          size.y,
          state.noiseTick ?? Math.floor(state.time * 60),
          reading.residual,
          state.headroom <= 1,
          renderer.outputColorSpace === DISPLAY_P3,
          reading.processing === 'photographic',
        )
        if (psf !== null) psf.scatter.value = glass.scatter
        const parameters = defocusParameters(state.lens, {
          width: size.x,
          height: size.y,
        })
        const focusKey = parameters.join(':')
        if (focusKey !== previousFocus) {
          maximumCircle = 40
          previousFocus = focusKey
        }
        if (defocus !== null) {
          defocus.parameters.value.set(...parameters)
          defocus.maximum.value = maximumCircle
          defocus.enabled.value = maximumCircle > 0.5 ? 1 : 0
          defocus.openness.value = Math.max(
            0,
            Math.min(1, (2.8 - state.lens.fStop) / 1.4),
          )
        }
        if (meter !== null) meter.defocus.value.set(...parameters)
        if (motion !== null)
          motion.fraction.value = shutterFraction(
            state.lens.shutter,
            previousTime === null || history.motionReset
              ? 0
              : state.time - previousTime,
            state.motionBlur ?? false,
          )
        previousTime = state.time
        const tone = toneCurveFor(renderer)
        if (tone !== undefined) {
          tone.natural.value = state.stagingLook === true ? 1 : 0
          tone.direct.value = 0
          tone.wide.value = renderer.outputColorSpace === DISPLAY_P3 ? 1 : 0
          tone.headroom.value = Math.min(state.headroom, state.settings.peak)
          tone.shoulder.value = LOOK_SHOULDERS[reading.look]
          tone.gamma.value = state.gamma ?? 1
        }
      }
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
       * working color space, and switches `xr` off, while the quad draws, and
       * puts all three back with plain assignments after it — no `finally`.
       * The scene renders *inside* that swap, through the pass, so a throw
       * from anywhere in the scene leaves the renderer holding the swapped
       * values for good, and the check above then reads them as a mode change
       * and rebuilds the output with no curve and no transfer. Every frame
       * after that presents raw linear radiance clamped to one: the pixel the
       * curve puts at 59/255 on a lit hull reaches the canvas at 15, on every
       * scene, uniformly, and nothing in the picture says why. Restoring here
       * makes an exception cost the one frame it was thrown in.
       * `sensor.gpu.test.ts` throws one to hold it. XR is never on here; it is
       * restored because the swap is three's to enumerate, not this file's.
       */
      const toneMapping = renderer.toneMapping
      const outputColorSpace = renderer.outputColorSpace
      const xrEnabled = renderer.xr.enabled
      const mrt = renderer.getMRT()
      const autoClear = renderer.autoClear
      const transparent = renderer.transparent
      const opaque = renderer.opaque
      const contextNode = renderer.contextNode
      const layers = camera.layers.mask
      const overrideMaterial = scene.overrideMaterial
      const sceneName = scene.name
      try {
        const reading = exposure.reading
        const pictureKey = [
          state?.pictureEpoch ?? 0,
          state?.settings.mode ?? '',
          state?.stagingLook ?? false,
          reading?.processing ?? '',
          state?.historyKey ?? '',
          state?.pinned ?? '',
        ].join(':')
        if (pictureKey !== previousPictureKey) {
          upscale?.resetHistory()
          previousPictureKey = pictureKey
        }
        // Enhanced is already a composed visibility domain. Its sky has a
        // separate gain, so no scalar physical pre-exposure describes it.
        // Photographic radiance has one pre-exposure, tracked by FSR to keep
        // history in the current frame's storage domain as exposure adapts.
        upscale?.beginFrame(
          delta,
          reading?.processing === 'photographic' ? reading.pre : 1,
          reading?.processing === 'photographic' ? reading.residual : 1,
          state?.pictureDebug ?? 'none',
        )
        if (upscale !== null) radiance.value = upscale.outputTexture.value
        post.render()
        if (state !== undefined) {
          const pre = exposure.reading!.pre
          // The key this frame was submitted under. The readback lands frames
          // later, and `size` has moved on by then: a circle measured at the
          // old viewport is half the pixel value at the new one.
          const submitted = previousFocus
          meter?.sample(
            renderer,
            scenePass.renderTarget.width,
            scenePass.renderTarget.height,
            (bins, circle) => {
              const current = frame?.()
              const accepted =
                current !== undefined &&
                history.accepts(
                  generation,
                  keyFor(current),
                  current.adaptationTime ?? current.time,
                  cameraFor(current),
                )
              if (
                accepted &&
                current.settings.mode !== 'manual' &&
                current.pinned === null &&
                current.settings.rate !== 0
              )
                exposure.measure(bins, pre, current.lens, current.settings)
              // Circle extent belongs to the lens and viewport, independently
              // of an exposure key changed by photographic-time scrubbing.
              if (submitted === previousFocus) maximumCircle = circle
            },
          )
        }
      } finally {
        upscale?.endFrame()
        setSceneExposure(renderer, null)
        renderer.toneMapping = toneMapping
        renderer.outputColorSpace = outputColorSpace
        renderer.xr.enabled = xrEnabled
        renderer.setMRT(mrt)
        renderer.setRenderTarget(target)
        renderer.autoClear = autoClear
        renderer.transparent = transparent
        renderer.opaque = opaque
        renderer.contextNode = contextNode
        camera.layers.mask = layers
        scene.overrideMaterial = overrideMaterial
        scene.name = sceneName
      }
    },
    dispose() {
      history.retire()
      post.dispose()
      scenePass.dispose()
      meter?.dispose()
      psf?.dispose()
      defocus?.dispose()
      motion?.dispose()
      upscale?.dispose()
    },
  }
}
