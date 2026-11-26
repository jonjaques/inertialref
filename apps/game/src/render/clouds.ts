import { getLogger, invariant } from '@inertialref/shared'
import type { RenderBody } from '@inertialref/rendering'
import type { Body } from '@inertialref/universe'
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
  Node,
  type NodeFrame,
  NodeUpdateType,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  Scene,
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
import type { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
// John Fewell ports Shota Matsuda's cloud renderer to WebGPU: https://github.com/johnfewell/three-clouds-webgpu
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
import {
  OVER_CLOUDS_LAYER,
  overClouds,
  UNDER_CLOUDS_LAYERS,
} from './cloudLayers.ts'
import { CloudOverPassNode } from './cloudOverPass.ts'
import type {
  CloudChainFactory,
  CloudChainSystem,
  CloudFrontHandle,
  CloudSystemDeps,
} from './cloudSystem.ts'
import { sensorRadiance } from './radiance.ts'
import { sceneFarDepth } from './sceneDepth.ts'
import { createCloudsAtmosphere } from './cloudsAtmosphere.ts'
import { CloudsDepth } from './cloudsDepth.ts'
import {
  CLOUDS_ANCHOR_REACH,
  type CloudsAnchor,
  cloudsAnchor,
  cloudsPlacement,
  cloudsBody,
  cloudsSun,
} from './cloudsFrame.ts'
import {
  createCloudsSettings,
  type CloudsHandle,
  type CloudsSettings,
} from './cloudsTunables.ts'
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
 *   Earth frame through one matrix (`cloudsFrame.ts`).
 * - **The depth.** The port stops its march at the scene by sampling a depth
 *   texture, and ours is multisampled, so it reads a one-sample copy
 *   (`cloudsDepth.ts`).
 * - **The composite.** The port's resolved image is premultiplied light and
 *   opacity. It is drawn where the native composite is drawn: the first
 *   opaque of the scene pass over the clouds, or alone over the scene
 *   target's resolved rows (`cloudOverPass.ts`, ADR-0063), with the native
 *   composite's blend. So the planet, the ground and the sea are ours, and
 *   an object marked over the clouds draws over these too.
 * - **The levers.** `engine.clouds.on`, `served`, `over` and `jitterFrame`
 *   are read; every preset and tunable of the port is `engine.cloudTunables`'s
 *   (`cloudsTunables.ts`).
 *
 * What it does not do is each a fork point and is listed where the spike
 * reports: the air between the eye and a cloud is takram's Earth's and not
 * ours, the weather is the port's tiled map, no cloud casts a shadow on our
 * ground, a cloud carries no motion vector, and nothing reads the cloud in
 * front of a transparent object.
 */

const log = getLogger('game.clouds.adapter')

/** Frames after a reset the port's histories are given before a capture. */
const SETTLE_FRAMES = 128

/** The composite draws first among the over-cloud opaques, as the native one does. */
const ORDER = -1e6

/** The air's lookup tables the port's light reads: four computes, each announced. */
const ATMOSPHERE_TABLES = 4

/** Rec. 709 luminance weights, the atmosphere's own. */
const LUMINANCE = new Vector3(0.2126, 0.7152, 0.0722)

interface CloudsAssets {
  readonly textures: BakedCloudTextures
  /** `cloudsServed`: whether a body is drawn with clouds unasked. */
  readonly wet: (body: Body) => boolean
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
class CloudsOverNode extends Node<'vec4'> {
  static get type(): string {
    return 'CloudsOverNode'
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

type ContextNode = WebGPURenderer['contextNode']

/**
 * What each renderer's context node was before the first of ours, and ours
 * on it since, oldest first.
 */
const INSTALLED = new WeakMap<
  WebGPURenderer,
  { readonly under: ContextNode; readonly ours: ContextNode[] }
>()

/**
 * Puts `providers` on the renderer's context node, where the port's nodes
 * and the atmosphere's find them, and answers what takes them off.
 *
 * A chain is built beside the one still drawing and either may be disposed
 * first (`chainHandover.ts`), so the node found here is often another
 * system's. Kept as this one's "previous", every system would hold the one
 * before it, with its pass and its targets, for as long as it lived, and the
 * last one disposed would hand the renderer the providers of a disposed
 * context. So what was there before any of ours is held once, a node is
 * made from the values of the one installed and not from the node, and
 * taking one off leaves the newest of the rest.
 */
function installProviders(
  renderer: WebGPURenderer,
  providers: Readonly<Record<string, unknown>>,
): () => void {
  const held = INSTALLED.get(renderer) ?? {
    under: renderer.contextNode,
    ours: [],
  }
  INSTALLED.set(renderer, held)
  const node = tslContext({
    ...(renderer.contextNode.value as Record<string, unknown>),
    ...providers,
  })
  held.ours.push(node)
  renderer.contextNode = node
  return () => {
    const at = held.ours.indexOf(node)
    if (at < 0) return
    held.ours.splice(at, 1)
    if (renderer.contextNode === node)
      renderer.contextNode = held.ours.at(-1) ?? held.under
    if (held.ours.length === 0) INSTALLED.delete(renderer)
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
  assets: CloudsAssets,
  settings: CloudsSettings,
): CloudChainSystem {
  const { renderer, scene, camera, layout, scenePass } = deps
  const front = deps.front ?? createFront()
  const sceneMrt = scenePass.getMRT()
  invariant(sceneMrt !== null, 'the clouds need the scene pass’s MRT')
  assertWebGPUSupported(renderer)

  const atmosphere = createCloudsAtmosphere()
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

  const depth = new CloudsDepth(layout)
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
  // How often the port's pass runs, against the frames this system draws.
  let marches = 0
  const march = pass.updateBefore.bind(pass)
  pass.updateBefore = (frame) => {
    marches += 1
    return march(frame)
  }

  // The port's nodes find their context and the air through the renderer.
  const removeProviders = installProviders(renderer, {
    getClouds: () => context,
    getAtmosphere: () => atmosphere,
  })

  /** Scene units for the port's luminance, times the key star's light. */
  const gain = uniform(new Vector3(1, 1, 1))
  const unit = sceneUnitsPerLuminance(atmosphere)
  // The port's own composite over nothing is its layer, premultiplied.
  const layer = pass.composite(vec4(0))
  /*
   * Once per render call, as the pass above and for its reason. The
   * composite's `updateBefore` is what sees a setting move the graph's
   * version and marks this material to be built again, and the pass builds
   * its own graph only inside that build. Left once per three frame, a
   * write `flush` lands during a run of back-to-back frames waits for
   * three's own loop to turn: every frame of the run after it draws the
   * graph the last setting built, under the new one's uniforms, and times
   * neither.
   */
  layer.updateBeforeType = NodeUpdateType.RENDER
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
  material.name = 'clouds composite'
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
  mesh.layers.set(OVER_CLOUDS_LAYER)
  mesh.renderOrder = ORDER
  mesh.name = 'clouds composite'
  mesh.visible = false
  mesh.frustumCulled = false
  const alone = new Mesh(geometry, material)
  alone.layers.enableAll()
  alone.name = 'clouds composite'
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
  const overPass = new CloudsOverNode((frame) => {
    if (!drawing || frame.renderer === null) return
    depth.render(frame.renderer as WebGPURenderer)
    inner.updateBefore(frame)
  })

  let served: RenderBody | null = null
  let anchor: CloudsAnchor | null = null
  let levers: CloudRenderReport['levers'] | null = null
  let layered = false
  let frames = 0
  let resets = 0
  let sinceReset = 0
  let inspected = false
  let disposed = false
  let last: Record<string, unknown> = {}
  const matrix = new Matrix4()
  const css = new Vector2()

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
      // No hash: `cloudLeversHash` reaches the procedural hash, and a chunk
      // that shares it with the page splits it out for every visit to load.
      leversHash: null,
      served: served?.address ?? null,
      // The port draws its own weather map on the served body.
      appliedWeather: null,
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
      // The levers the page holds, drawn with or not: what the report says.
      levers = inputs === null ? null : { ...inputs.levers }
      const body =
        inputs === null || !inputs.levers.on
          ? null
          : cloudsBody(
              inputs.scene.bodies,
              inputs.camera.position,
              (candidate) => {
                const record = inputs.record(candidate.address)
                return record !== null && assets.wet(record)
              },
              inputs.levers.served,
            )
      if (inputs === null || body === null) {
        served = null
        anchor = null
        return
      }
      const eye = inputs.camera.position
      served = body
      renderer.getSize(css)

      // The first frame on holds no anchor either: one reset, counted once.
      if (anchor === null || anchor.address !== body.address) {
        anchor = cloudsAnchor(body, eye)
        reset()
      }
      const sun = cloudsSun(body, inputs.scene)
      let placed = cloudsPlacement(body, anchor, eye, sun)
      if (placed.drift > CLOUDS_ANCHOR_REACH) {
        anchor = cloudsAnchor(body, eye)
        placed = cloudsPlacement(body, anchor, eye, sun)
        reset()
      }
      // The placement is row-major and `fromArray` reads columns.
      matrix.fromArray(placed.worldToEcef).transpose()
      context.worldToECEFMatrix.copy(matrix)
      atmosphere.matrixWorldToECEF.value.copy(matrix)
      context.sunDirection.set(placed.sun.x, placed.sun.y, placed.sun.z)
      atmosphere.sunDirectionECEF.value.copy(context.sunDirection)
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
        frames,
        marches,
        graphVersion: context.graphVersion,
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
    afterFrame() {
      // After a frame this system's pass drew, and only then, and into its
      // own context: `cloudsTunables.ts`.
      if (drawing) settings.flush(context)
    },
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
      removeProviders()
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
export interface Clouds {
  readonly factory: CloudChainFactory
  readonly handle: CloudsHandle
}

/** The page's one load, or null before it is asked for and after it fails. */
let page: Promise<Clouds> | null = null

/**
 * Loads the port's four baked textures and answers the factory the sensor's
 * chain builds its cloud system with. One per page: the textures and the
 * settings outlive every chain, and every canvas. `App` builds the canvas,
 * and with it the renderer, again when the display's range changes, and its
 * factory asks here each time; a second load would be a second set of
 * settings, and `engine.cloudTunables` would forget the preset and every tunable
 * the page had written.
 *
 * `wet` is `cloudsServed`, handed in and not imported: this chunk sharing
 * the weather's modules with the page re-partitions them, and the page then
 * loads one chunk more on every visit (`check-site-chunks.mjs`).
 */
export function loadClouds(
  wet: (body: Body) => boolean,
  preset: string | null = null,
): Promise<Clouds> {
  page ??= load(wet, preset).catch((cause: unknown) => {
    // A load that failed is nobody's to keep: the next canvas asks again.
    page = null
    throw cause
  })
  return page
}

async function load(
  wet: (body: Body) => boolean,
  preset: string | null,
): Promise<Clouds> {
  const textures = await loadBakedCloudTextures({
    localWeather: localWeatherUrl,
    shape: shapeUrl,
    shapeDetail: shapeDetailUrl,
    turbulence: turbulenceUrl,
  })
  const settings = createCloudsSettings(preset)
  const assets: CloudsAssets = { textures, wet }
  return {
    factory: Object.assign(
      (deps: CloudSystemDeps) => build(deps, assets, settings),
      { createFront, appliesWeather: false },
    ),
    handle: settings,
  }
}
