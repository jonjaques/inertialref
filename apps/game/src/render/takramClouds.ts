import { getLogger, invariant } from '@inertialref/shared'
import { cloudsServed, type RenderBody } from '@inertialref/rendering'
import {
  type CloudRenderReport,
  cloudReportIdle,
  cloudsSettled,
} from '@inertialref/devtools'
import {
  AddEquation,
  Color,
  CustomBlending,
  type Layers,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type NodeFrame,
  NodeUpdateType,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  Scene,
  TempNode,
  Vector2,
  Vector3,
  type WebGPURenderer,
  ZeroFactor,
} from 'three/webgpu'
import {
  context as tslContext,
  Fn,
  mrt,
  output,
  positionGeometry,
  uniform,
  vec4,
} from 'three/tsl'
import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import {
  assertWebGPUSupported,
  type BakedCloudTextures,
  clouds,
  inspectCloudsSetup,
  loadBakedCloudTextures,
} from 'three-clouds-webgpu'
import localWeatherUrl from 'three-clouds-webgpu/assets/local_weather.png?url'
import shapeDetailUrl from 'three-clouds-webgpu/assets/shape_detail.bin?url'
import shapeUrl from 'three-clouds-webgpu/assets/shape.bin?url'
import turbulenceUrl from 'three-clouds-webgpu/assets/turbulence.png?url'
import { overClouds, UNDER_CLOUDS_LAYERS } from './cloudLayers.ts'
import { cloudLeversHash } from './cloudLevers.ts'
import { CloudOverPassNode } from './cloudOverPass.ts'
import type {
  CloudChainFactory,
  CloudChainSystem,
  CloudFrontHandle,
  CloudSystemDeps,
} from './cloudSystem.ts'
import { sensorRadiance } from './radiance.ts'
import { sceneFarDepth } from './sceneDepth.ts'
import { TakramDepth } from './takramDepth.ts'
import {
  TAKRAM_ANCHOR_REACH,
  type TakramAnchor,
  takramAnchor,
  takramPlacement,
  takramServed,
  takramSun,
} from './takramFrame.ts'
import {
  createTakramSettings,
  type TakramHandle,
  type TakramSettings,
} from './takramTunables.ts'
import { warmCompile, warmRenderer } from './warmup.ts'

/*
 * `?clouds=takram`: takram's volumetric clouds, through the unofficial
 * WebGPU port `three-clouds-webgpu` as it ships, in the place the native
 * cloud system stands.
 *
 * The port is used whole and unmodified. Its pass marches the clouds, lights
 * them from takram's own atmosphere and resolves them into its own targets;
 * this module is the adapter round it, and holds no cloud shader of its own:
 *
 * - **The frame.** Our eye's height, heading and sun go into the port's
 *   Earth frame through one matrix (`takramFrame.ts`).
 * - **The depth.** The port stops its march at the scene by sampling a depth
 *   texture, and ours is multisampled, so it reads a one-sample copy
 *   (`takramDepth.ts`).
 * - **The composite.** The port's resolved image is premultiplied light and
 *   opacity. It is drawn where the native composite is drawn: the first
 *   opaque of the scene pass over the clouds, or alone over the scene
 *   target's resolved rows (`cloudOverPass.ts`, ADR-0063), with the native
 *   composite's blend. So the planet, the ground and the sea are ours, and
 *   an object marked over the clouds draws over these too.
 * - **The levers.** `engine.clouds.on`, `served`, `over` and `jitterFrame`
 *   are read; every preset and tunable of the port is `engine.takram`'s
 *   (`takramTunables.ts`).
 *
 * What it does not do is each a fork point and is listed where the spike
 * reports: the air between the eye and a cloud is takram's Earth's and not
 * ours, the weather is the port's tiled map, no cloud casts a shadow on our
 * ground, a cloud carries no motion vector, and nothing reads the cloud in
 * front of a transparent object.
 */

const log = getLogger('game.clouds.takram')

/** Frames after a reset the port's histories are given before a capture. */
const SETTLE_FRAMES = 128

/** The composite draws first among the over-cloud opaques, as the native one does. */
const ORDER = -1e6

/** The air's lookup tables the port's light reads: four computes, each announced. */
const ATMOSPHERE_TABLES = 4

/** Rec. 709 luminance weights, the atmosphere's own. */
const LUMINANCE = new Vector3(0.2126, 0.7152, 0.0722)

interface TakramAssets {
  readonly textures: BakedCloudTextures
}

interface TableEvents {
  addEventListener(type: 'update', listener: () => void): void
  removeEventListener(type: 'update', listener: () => void): void
}

/**
 * The port's luminance for one scene unit.
 *
 * The port's light is the atmosphere's relative luminance: spectral radiance
 * times `sunRadianceToLuminance`, scaled so the sun's own color has unit
 * luminance. An albedo-one surface under that sun above the air is its
 * illuminance over π, and that surface is one scene unit (ADR-0065).
 */
function sceneUnitsPerLuminance(atmosphere: AtmosphereContext): number {
  const { solarIrradiance, sunRadianceToLuminance, luminanceScale } =
    atmosphere.parameters
  const illuminance = solarIrradiance
    .clone()
    .multiply(sunRadianceToLuminance)
    .multiplyScalar(luminanceScale)
    .dot(LUMINANCE)
  return Math.PI / illuminance
}

/*
 * The native composite's blend (`compositeOver`, `cloudComposite.ts`),
 * written again because that module is the native system's and this chunk
 * loads none of it: premultiplied over, (One, OneMinusSrcAlpha), and alpha
 * left as the scene wrote it.
 */
function compositeOver(material: MeshBasicNodeMaterial): void {
  material.blending = CustomBlending
  material.blendEquation = AddEquation
  material.blendSrc = OneFactor
  material.blendDst = OneMinusSrcAlphaFactor
  material.blendEquationAlpha = AddEquation
  material.blendSrcAlpha = ZeroFactor
  material.blendDstAlpha = OneFactor
}

/**
 * The frame's term in the sensor's dependency sum: the depth copy, then the
 * composite's form. `vec4(0)` in the post program, there for its order.
 */
class TakramOverNode extends TempNode<'vec4'> {
  static get type(): string {
    return 'TakramOverNode'
  }

  readonly #run: (frame: NodeFrame) => void

  constructor(run: (frame: NodeFrame) => void) {
    super('vec4')
    this.#run = run
    this.updateBeforeType = NodeUpdateType.RENDER
  }

  override setup(): Node {
    return vec4(0)
  }

  override updateBefore(frame: NodeFrame): undefined {
    this.#run(frame)
    return undefined
  }
}

/** A front handle that never follows a trace: the port has none to read. */
function createFront(): CloudFrontHandle {
  return {
    textures: () => null,
    screen: {
      traceSize: uniform(new Vector2(1, 1)),
      dayColor: uniform(new Color(1, 1, 1)),
    },
    follow() {},
  }
}

function build(
  deps: CloudSystemDeps,
  assets: TakramAssets,
  settings: TakramSettings,
): CloudChainSystem {
  const { renderer, scene, camera, layout, scenePass } = deps
  const front = deps.front ?? createFront()
  const sceneMrt = scenePass.getMRT()
  invariant(sceneMrt !== null, 'the takram clouds need the scene pass’s MRT')
  assertWebGPUSupported(renderer)

  const atmosphere = new AtmosphereContext()
  atmosphere.camera = camera
  // The port's own recipe: the lookup, not the raymarch, between eye and cloud.
  atmosphere.raymarchScattering = false
  let tables = 0
  const tabled = (): void => {
    tables += 1
  }
  // The node announces each table it computes; its types name `dispose` alone.
  const tablesOf = atmosphere.lutNode as unknown as TableEvents
  tablesOf.addEventListener('update', tabled)

  const depth = new TakramDepth(layout)
  depth.tie(scenePass.renderTarget)
  const pass = clouds({ sceneDepth: depth.node })
  pass.camera = camera
  /*
   * Once per render call, as the scene pass is here (`sensor.ts`): the port
   * ships it once per three frame, a counter only three's own animation
   * loop advances, so a rig that submits frames back to back would march
   * once and composite forty times, and time the quad.
   */
  pass.updateBeforeType = NodeUpdateType.RENDER
  const context = pass.cloudsContext
  Object.assign(context, assets.textures)

  // The port's nodes find their context and the air through the renderer.
  const previous = renderer.contextNode
  const providers = tslContext({
    ...(previous.value as Record<string, unknown>),
    getClouds: () => context,
    getAtmosphere: () => atmosphere,
  })
  renderer.contextNode = providers

  /** Scene units for the port's luminance, times the key star's light. */
  const gain = uniform(new Vector3(1, 1, 1))
  const unit = sceneUnitsPerLuminance(atmosphere)
  // The port's own composite over nothing is its layer, premultiplied.
  const layer = pass.composite(vec4(0))
  const material = sensorRadiance(
    new MeshBasicNodeMaterial(),
    false,
    false,
    'alpha',
  )
  const radiance = material.outputNode!
  material.outputNode = Fn(() => {
    // The port's composite extends an untyped node, as its own docs say.
    const cloud = vec4(layer as unknown as Node<'vec4'>)
    output.assign(vec4(cloud.rgb.mul(gain), cloud.a))
    return radiance
  })()
  // Alpha zero under the row's `over` blend: the scene keeps its own motion
  // and depth behind a cloud.
  material.mrtNode = mrt({ motion: vec4(0) })
  material.name = 'takram composite'
  material.depthTest = false
  material.depthWrite = false
  material.fog = false
  compositeOver(material)
  material.vertexNode = vec4(positionGeometry.xy, sceneFarDepth, 1)

  const geometry = new PlaneGeometry(2, 2)
  /*
   * The port's composite samples its layer at the mesh's own uv, and is
   * written for three's `QuadMesh`, whose v is 0 at the top of the screen. A
   * plane's is 1 there, and drew the sky's clouds on the ground.
   */
  const uvs = geometry.getAttribute('uv')
  for (let k = 0; k < uvs.count; k += 1) uvs.setY(k, 1 - uvs.getY(k))
  const mesh = new Mesh(geometry, material)
  mesh.layers.set(1)
  mesh.renderOrder = ORDER
  mesh.name = 'takram composite'
  mesh.visible = false
  mesh.frustumCulled = false
  const alone = new Mesh(geometry, material)
  alone.layers.enableAll()
  alone.name = 'takram composite'
  alone.frustumCulled = false
  const over = new Scene()
  over.add(alone)
  scene.add(mesh)

  const inner = new CloudOverPassNode(
    scene,
    camera,
    scenePass.renderTarget,
    sceneMrt,
    { over },
  )
  let drawing = false
  const overPass = new TakramOverNode((frame) => {
    if (!drawing || frame.renderer === null) return
    depth.render(frame.renderer as WebGPURenderer)
    inner.updateBefore(frame)
  })

  let served: RenderBody | null = null
  let anchor: TakramAnchor | null = null
  let levers: CloudRenderReport['levers'] | null = null
  let leversHash: string | null = null
  let layered = false
  let frames = 0
  let resets = 0
  let sinceReset = 0
  let inspected = false
  let disposed = false
  let last: Record<string, unknown> = {}
  const matrix = new Matrix4()
  const css = new Vector2()
  const buffer = new Vector2()

  const reset = (): void => {
    pass.resetHistory()
    resets += 1
    sinceReset = 0
  }

  settings.attach(context, () => last)

  const reportOf = (): CloudRenderReport => {
    if (disposed) return cloudReportIdle()
    const on = served !== null
    const layerTarget = pass.layerRT
    const rest: Omit<CloudRenderReport, 'settle'> = {
      ...cloudReportIdle(),
      on,
      levers: { ...(levers ?? {}) },
      leversHash,
      served: served?.address ?? null,
      regime: on ? 'converging' : 'off',
      extents: {
        render: [scenePass.renderTarget.width, scenePass.renderTarget.height],
        css: [css.x, css.y],
        // The port's march target, and what it resolves into.
        trace: [layerTarget.width, layerTarget.height],
        history: [pass.historyRT?.width ?? 0, pass.historyRT?.height ?? 0],
      },
      frames,
      resets,
      sinceReset,
      pending: {
        // The air's tables, which the port's light reads: dark until all four.
        maps: on && tables < ATMOSPHERE_TABLES,
        clipmap: false,
        volume: false,
        sunDepth: false,
        far: false,
        history: on && sinceReset < SETTLE_FRAMES,
      },
      bytes: { depth: depth.bytes, total: depth.bytes },
    }
    return { ...rest, settle: cloudsSettled(rest) }
  }

  return {
    overPass,
    beginFrame(inputs, sensor) {
      if (disposed) return
      const eye = inputs?.camera.position ?? null
      const body =
        inputs === null || eye === null || !inputs.levers.on
          ? null
          : takramServed(
              inputs.scene.bodies,
              eye,
              (candidate) => {
                const record = inputs.record(candidate.address)
                return record !== null && cloudsServed(record)
              },
              inputs.levers.served,
            )
      if (inputs === null || eye === null || body === null) {
        served = null
        anchor = null
        return
      }
      if (served === null) reset()
      served = body
      levers = { ...inputs.levers }
      leversHash = cloudLeversHash(inputs.levers)
      renderer.getSize(css)
      renderer.getDrawingBufferSize(buffer)

      if (anchor === null || anchor.address !== body.address) {
        anchor = takramAnchor(body, eye)
        reset()
      }
      const sun = takramSun(body, inputs.scene)
      let placed = takramPlacement(body, anchor, eye, sun)
      if (placed.drift > TAKRAM_ANCHOR_REACH) {
        anchor = takramAnchor(body, eye)
        placed = takramPlacement(body, anchor, eye, sun)
        reset()
      }
      // The placement is row-major and `fromArray` reads columns.
      matrix.fromArray(placed.worldToEcef).transpose()
      context.worldToECEFMatrix.copy(matrix)
      atmosphere.matrixWorldToECEF.value.copy(matrix)
      if (placed.sun !== null) {
        context.sunDirection.set(placed.sun.x, placed.sun.y, placed.sun.z)
        atmosphere.sunDirectionECEF.value.copy(context.sunDirection)
      }
      context.time = inputs.renderTime % 86_400
      context.frame = inputs.levers.jitterFrame ?? frames
      frames += 1
      sinceReset += 1

      const key = inputs.scene.stars[0]
      const light = inputs.visibility ? 1 : body.sunlight
      gain.value.set(
        (key?.color.r ?? 1) * light * unit,
        (key?.color.g ?? 1) * light * unit,
        (key?.color.b ?? 1) * light * unit,
      )

      // The composite's form, a frame at a time, as the native system picks it.
      const form = inputs.levers.over
      const marked = form === 'passes' ? 'depth' : overClouds(scene)
      const chained = form === 'chain' && marked === 'nothing'
      inner.form = chained ? 'chain' : form === 'lean' ? 'lean' : 'passes'
      inner.depthReadOnly = marked !== 'depth'
      if (!chained) {
        mesh.visible = true
        scenePass.setLayers(UNDER_CLOUDS_LAYERS)
        layered = true
      }
      drawing = true

      last = {
        served: body.address,
        altitude: placed.altitude,
        drift: placed.drift,
        eye: placed.eye,
        sun: placed.sun,
        bodyRadius: body.trueRadius,
        compression: body.placement.compression,
        gain: gain.value.toArray(),
        processing: sensor.processing,
        tables,
      }
      if (!inspected) {
        inspected = true
        const { diagnostics, readiness } = inspectCloudsSetup({
          renderer,
          pass,
          atmosphere,
          depthMode: 'scene',
        })
        log.info('the port’s setup', { readiness, diagnostics })
      }
    },
    endFrame() {
      drawing = false
      mesh.visible = false
      inner.form = null
      if (layered) {
        // r185 takes null back to the camera's own mask; its types do not.
        scenePass.setLayers(null as unknown as Layers)
        layered = false
      }
    },
    afterFrame() {},
    // The port holds no radiance at a trace's texels to read back.
    captureRadiance: () => Promise.resolve(null),
    resetHistory() {
      reset()
    },
    async warm(progress = () => {}) {
      if (disposed) return
      // The composite's program holds the port's whole graph, so compiling
      // it is what builds the port's. Its own pipelines, the march's and the
      // shadow's, have no compile-ahead and build on the first frame drawn.
      await warmCompile(warmRenderer(renderer, layout), {
        object: mesh,
        camera,
        scene,
      })
      progress()
      await inner.warm(renderer)
      progress()
      progress()
      progress()
    },
    get served() {
      return served?.address ?? null
    },
    get report() {
      return reportOf()
    },
    front,
    dispose() {
      if (disposed) return
      disposed = true
      settings.detach(context)
      tablesOf.removeEventListener('update', tabled)
      scene.remove(mesh)
      if (renderer.contextNode === providers) renderer.contextNode = previous
      inner.dispose()
      layer.dispose()
      pass.dispose()
      // The baked textures are the page's, and outlive this chain.
      context.localWeatherTexture = null
      context.shapeTexture = null
      context.shapeDetailTexture = null
      context.turbulenceTexture = null
      context.dispose()
      atmosphere.dispose()
      depth.dispose()
      geometry.dispose()
      material.dispose()
    },
  }
}

/** What `App` takes from this chunk: the chain's factory and the page's handle. */
export interface TakramClouds {
  readonly factory: CloudChainFactory
  readonly handle: TakramHandle
}

/**
 * Loads the port's four baked textures and answers the factory the sensor's
 * chain builds its cloud system with. One per page: the textures and the
 * settings outlive every chain.
 */
export async function loadTakramClouds(): Promise<TakramClouds> {
  const textures = await loadBakedCloudTextures({
    localWeather: localWeatherUrl,
    shape: shapeUrl,
    shapeDetail: shapeDetailUrl,
    turbulence: turbulenceUrl,
  })
  const settings = createTakramSettings()
  const assets: TakramAssets = { textures }
  return {
    factory: Object.assign(
      (deps: CloudSystemDeps) => build(deps, assets, settings),
      { createFront },
    ),
    handle: settings,
  }
}
