import { invariant } from '@inertialref/shared'
import {
  type Camera,
  type Layers,
  type Node,
  type PassNode,
  type Scene,
  Vector2,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  type CloudRadiance,
  type CloudRenderReport,
  cloudReportIdle,
  cloudsSettled,
} from '@inertialref/devtools'
import type { Extent } from '@inertialref/rendering'
import { type CloudField, createCloudField } from './cloudField.ts'
import { CloudComposite } from './cloudComposite.ts'
import { CloudDepth } from './cloudDepth.ts'
import {
  type CloudFrame,
  cloudFrame,
  type CloudFrameInputs,
} from './cloudFrame.ts'
import { type CloudFrameDriver, CloudFrameNode } from './cloudFrameNode.ts'
import { CloudHistory } from './cloudHistory.ts'
import { UNDER_CLOUDS_LAYERS } from './cloudLayers.ts'
import type { CloudLevers, CloudPlacement } from './cloudLevers.ts'
import type { CloudBudget, CloudResource } from './cloudNodes.ts'
import { CloudOverPassNode } from './cloudOverPass.ts'
import { CLOUD_PROFILE_HEIGHTS, CLOUD_PROFILE_ROWS } from './cloudProfile.ts'
import { CloudRadianceMeter } from './cloudRadiance.ts'
import { SUN_DEPTH_FRAME_CAP } from './cloudSunCascades.ts'
import { CloudTrace } from './cloudTrace.ts'
import type { SceneLayout } from './sceneLayout.ts'

/*
 * The cloud system: owns every cloud resource, builds the frame's state
 * inside `sensor.render()`, runs the frame's passes in §4.2's order through
 * the composite's frame node, and reports. Built only under `?clouds=1`, and
 * only on WebGPU; with its levers off it draws nothing and adds no pass.
 *
 * It orchestrates and holds no shader code. The field and every node set
 * that reads it are built once, by `createCloudField`, and handed to every
 * module that reads them; `cloudField.ts` says why they must be shared.
 */

export interface CloudSystemDeps {
  readonly renderer: WebGPURenderer
  readonly scene: Scene
  readonly camera: Camera
  readonly layout: SceneLayout
  readonly scenePass: PassNode
}

/** What the sensor knows of a frame that the engine does not. */
export interface CloudSensorState {
  readonly processing: 'enhanced' | 'photographic' | string
  /** This render call's seconds. */
  readonly delta: number
}

/**
 * A frame's inputs as the engine supplies them (`scene/Sensor.tsx`). The
 * processing, the extents and the call's seconds are the sensor's, known
 * only inside `render()`, and the system adds them.
 */
export type CloudEngineInputs = Omit<
  CloudFrameInputs,
  'enhanced' | 'css' | 'render' | 'delta'
>

export interface CloudSystem {
  /** Placement A's pass in the sensor's dependency sum: vec4(0) in the post program. */
  readonly overPass: Node<'vec4'>
  beginFrame(inputs: CloudEngineInputs | null, sensor: CloudSensorState): void
  endFrame(): void
  /** After `post.render`: the residual meter under composite 'residual', and a radiance capture asked for. */
  afterFrame(renderer: WebGPURenderer): void
  /**
   * The next frame's radiance at the trace's texels, read back after it,
   * with the texels the history holds cloud at: null on a frame that draws
   * no clouds (`cloudRadiance.ts`).
   */
  captureRadiance(): Promise<CloudRadiance | null>
  resetHistory(): void
  /** Every pipeline any lever set draws with, and the noise baked; `progress` four times. */
  warm(progress?: () => void): Promise<void>
  readonly report: CloudRenderReport
  /** Every resource the system holds, in the frame's order: the census's subject. */
  readonly resources: readonly CloudResource[]
  /** The field the frame draws and every node set that reads it: the instruments' subject. */
  readonly field: CloudField
  dispose(): void
}

export type CloudSystemFactory = (deps: CloudSystemDeps) => CloudSystem

/** Slices the volume bakes a frame past level 0's own rebuild (§3.11). */
const VOLUME_SLICES = 8
/** The profile table, RGBA8: not a resource of its own, 2 KB the report counts. */
const PROFILE_BYTES = CLOUD_PROFILE_HEIGHTS * CLOUD_PROFILE_ROWS * 4

/* ------------------------------------------------------------------------- */
/* The pipeline census                                                        */
/* ------------------------------------------------------------------------- */

interface PipelineCensus {
  render: number
  compute: number
}

const CENSUSES = new WeakMap<object, PipelineCensus>()
/** Three labels a pipeline by its material's or kernel's name, and every cloud one is `cloud …`. */
const CLOUD_PIPELINE = /_cloud /
const BUILDERS = [
  ['createRenderPipeline', 'render'],
  ['createRenderPipelineAsync', 'render'],
  ['createComputePipeline', 'compute'],
  ['createComputePipelineAsync', 'compute'],
] as const

/**
 * The cloud pipelines a device has built, counted at the device by the
 * label three gives each, so the other producers a boot compiles beside the
 * clouds' warm-up never count. One wrapper a device, which outlives every
 * system built on it; the system reports what was built since its own
 * construction. A device three does not expose counts nothing (rule 65).
 */
function censusOf(renderer: WebGPURenderer): PipelineCensus {
  const device = (renderer.backend as { device?: object | null }).device
  if (device === undefined || device === null) return { render: 0, compute: 0 }
  const held = CENSUSES.get(device)
  if (held !== undefined) return held
  const census: PipelineCensus = { render: 0, compute: 0 }
  const builders = device as Record<
    string,
    ((descriptor: { readonly label?: string }) => unknown) | undefined
  >
  for (const [method, kind] of BUILDERS) {
    const build = builders[method]?.bind(device)
    if (build === undefined) continue
    builders[method] = (descriptor) => {
      if (CLOUD_PIPELINE.test(descriptor?.label ?? '')) census[kind] += 1
      return build(descriptor)
    }
  }
  CENSUSES.set(device, census)
  return census
}

/* ------------------------------------------------------------------------- */
/* The system                                                                 */
/* ------------------------------------------------------------------------- */

const pair = ({ width, height }: Extent): readonly [number, number] => [
  width,
  height,
]

/**
 * The scene pass's own size this frame, before its `updateBefore` sets it:
 * the drawing buffer at the pass's resolution scale, floored, as
 * `PassNode.setSize` takes it. The depth copy and the trace map texels
 * through this extent, so a frame read off the target's last size would be
 * a resize late.
 */
function extentsOf(
  renderer: WebGPURenderer,
  scenePass: PassNode,
  css: Vector2,
  buffer: Vector2,
): { readonly css: Extent; readonly render: Extent } {
  renderer.getSize(css)
  renderer.getDrawingBufferSize(buffer)
  const scale = scenePass.getResolutionScale()
  return {
    css: { width: css.x, height: css.y },
    render: {
      width: Math.floor(buffer.x * scale),
      height: Math.floor(buffer.y * scale),
    },
  }
}

export function createCloudSystem(deps: CloudSystemDeps): CloudSystem {
  const { renderer, scene, camera, layout, scenePass } = deps
  const mrt = scenePass.getMRT()
  invariant(mrt !== null, 'the cloud system needs the scene pass’s MRT')
  const census = censusOf(renderer)
  const baseline = { ...census }

  const field = createCloudField()
  const { uniforms } = field
  const depth = new CloudDepth(uniforms, layout)
  depth.tie(scenePass.renderTarget)
  const trace = new CloudTrace({
    uniforms,
    media: {
      field: field.medium,
      volume: field.volume.medium,
      bound: (sample, body) => field.volume.bound(sample, body),
      brickExit: (sample, ray, body) =>
        field.volume.brickExit(sample, ray, body),
      sweep: field.sweep,
    },
    sun: field.sun,
    phase: field.phase,
    far: { atlas: field.farAtlas.far, spheres: field.farSpheres.far },
    depth: () => depth.texture,
  })
  const history = new CloudHistory(uniforms, () => trace.outputs)
  const radiance = new CloudRadianceMeter(uniforms, () => history.outputs)
  /** What the system holds past the field's bakes: the field disposes its own. */
  const own = [depth, trace, history] as const
  const resources: readonly CloudResource[] = [...field.bakes, ...own]

  let frame: CloudFrame | null = null
  let levers: CloudLevers | null = null
  let inFrame = false
  let layered = false
  let frames = 0
  let disposed = false
  const css = new Vector2()
  const buffer = new Vector2()

  const budgetOf = (built: CloudFrame): CloudBudget => ({
    slices: VOLUME_SLICES,
    tiles: 1,
    jump: built.jump,
    sunTexelSteps: SUN_DEPTH_FRAME_CAP,
  })

  /** §3.16's order: every bake and cache, the depth copy, then the trace and the history. */
  const run = (target: WebGPURenderer): void => {
    const built = frame
    if (built === null) return
    const budget = budgetOf(built)
    field.render(target, built, budget)
    depth.render(target)
    if (built.regime === 'immediate')
      for (let k = 0; k < 4; k += 1) {
        trace.dispatchPhase(target, built, k)
        history.renderImmediate(target, built, k)
      }
    else {
      trace.render(target, built, budget)
      history.render(target, built, budget)
    }
  }

  const driver: CloudFrameDriver = {
    get inFrame() {
      return inFrame && frame !== null
    },
    get placement(): CloudPlacement {
      return frame?.levers.placement ?? 'split'
    },
    run,
  }
  const frameNode = new CloudFrameNode(driver)
  const composite = new CloudComposite({
    uniforms,
    history: () => history.outputs,
    depth: () => depth.texture,
    far: field.farSecond.far,
    phase: field.phase,
    frameNode,
  })
  const overPass = new CloudOverPassNode(
    scene,
    camera,
    scenePass.renderTarget,
    mrt,
  )
  scene.add(composite.passes, composite.split)

  const farPending = (): boolean =>
    (levers?.far === 'spheres' ? field.farSpheres : field.farAtlas).pending ||
    field.farSecond.pending

  const reportOf = (): CloudRenderReport => {
    if (disposed) return cloudReportIdle()
    const shown = frame
    const bytes: Record<string, number> = { profile: PROFILE_BYTES }
    for (const resource of resources) bytes[resource.name] = resource.bytes
    const total = Object.values(bytes).reduce((sum, n) => sum + n, 0)
    const { resets, sinceReset } = history.report
    const rest: Omit<CloudRenderReport, 'settle'> = {
      available: true,
      reason: null,
      on: shown !== null,
      levers: { ...(levers ?? {}) },
      served: shown?.served.address ?? null,
      second: shown?.second?.address ?? null,
      regime: shown?.regime ?? 'off',
      reset: shown?.reset ?? 'none',
      extents:
        shown === null
          ? cloudReportIdle().extents
          : {
              render: pair(shown.extents.render),
              css: pair(shown.extents.css),
              trace: pair(shown.extents.trace),
              history: pair(shown.extents.history),
            },
      frames,
      resets,
      sinceReset,
      pending: {
        maps: field.maps.pending,
        clipmap: field.clipmap.pending,
        volume: field.volume.pending,
        sunDepth: (levers?.sunDepth === 'grid' ? field.grid : field.cascades)
          .pending,
        far: farPending(),
        history: history.pending,
      },
      bytes: { ...bytes, total },
      pipelines: {
        render: census.render - baseline.render,
        compute: census.compute - baseline.compute,
      },
      steps: trace.steps,
      residual: composite.residual,
    }
    return { ...rest, settle: cloudsSettled(rest) }
  }

  return {
    overPass,
    beginFrame(inputs, sensor) {
      if (disposed) return
      levers = inputs?.levers ?? null
      const previous = frame
      const extents = extentsOf(renderer, scenePass, css, buffer)
      // Off is a fresh start: the next frame on is a first frame, which
      // rebuilds every cache from nothing rather than from a stale frame.
      frame =
        inputs === null
          ? null
          : cloudFrame(
              {
                ...inputs,
                ...extents,
                enhanced: sensor.processing === 'enhanced',
                delta: sensor.delta,
              },
              previous,
            )
      if (frame === null) return
      frames += 1
      field.write(frame)
      const view = camera as Camera & { near?: number; far?: number }
      uniforms.camera.near.value = view.near ?? uniforms.camera.near.value
      uniforms.camera.far.value = view.far ?? uniforms.camera.far.value
      composite.setMode(frame.levers.composite)
      composite.show(frame.levers.placement)
      if (frame.levers.placement === 'passes') {
        scenePass.setLayers(UNDER_CLOUDS_LAYERS)
        overPass.active = true
        layered = true
      }
      inFrame = true
    },
    endFrame() {
      inFrame = false
      composite.show(null)
      if (layered) {
        // r185 takes null back to the camera's own mask; its types do not.
        scenePass.setLayers(null as unknown as Layers)
        overPass.active = false
        layered = false
      }
    },
    afterFrame(target) {
      if (frame?.levers.composite === 'residual')
        composite.measureResidual(target, scenePass.renderTarget)
      radiance.measure(target, scenePass.renderTarget, frame !== null)
    },
    captureRadiance() {
      return radiance.request()
    },
    resetHistory() {
      history.reset()
    },
    async warm(progress = () => {}) {
      if (disposed) return
      // The noise's warm-up bakes it, so the first frame reads baked noise.
      // A warm-up is idempotent, so the bakes' pass after the first three
      // compiles only the rest, in the frame's order.
      for (const bake of [field.noise, field.maps, field.clipmap])
        await bake.warm(renderer)
      progress()
      for (const bake of field.bakes) await bake.warm(renderer)
      await depth.warm(renderer)
      progress()
      await trace.warm(renderer)
      await history.warm(renderer)
      progress()
      await composite.warm(renderer, layout, camera, scene)
      progress()
    },
    get report() {
      return reportOf()
    },
    resources,
    field,
    dispose() {
      if (disposed) return
      disposed = true
      scene.remove(composite.passes, composite.split)
      composite.dispose()
      radiance.dispose()
      field.dispose()
      for (const resource of own) resource.dispose()
      frame = null
    },
  }
}
