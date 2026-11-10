import {
  AddEquation,
  type Camera,
  type ComputeNode,
  CustomBlending,
  Mesh,
  MeshBasicNodeMaterial,
  type MRTNode,
  type Node,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  type RenderTarget,
  type Scene,
  StorageBufferAttribute,
  type Texture,
  type TextureNode,
  type WebGPURenderer,
  ZeroFactor,
} from 'three/webgpu'
import {
  abs,
  acos,
  asin,
  atomicAdd,
  atomicStore,
  cameraProjectionMatrixInverse,
  cameraWorldMatrix,
  clamp,
  cross,
  Discard,
  dot,
  exp,
  float,
  floor,
  Fn,
  If,
  instanceIndex,
  ivec2,
  length,
  log2,
  max,
  min,
  mix,
  mrt,
  nodeObject,
  normalize,
  output,
  positionGeometry,
  property,
  screenCoordinate,
  screenUV,
  select,
  sqrt,
  storage,
  texture,
  uint,
  uniform,
  uvec2,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { ATMOSPHERE_GAIN } from '@inertialref/rendering'
import {
  CLOUD_HISTOGRAM_BINS,
  CLOUD_HISTOGRAM_BINS_A_DECADE,
  CLOUD_HISTOGRAM_FLOOR_DECADE,
  type CloudHistogram,
  type CloudRenderReport,
} from '@inertialref/devtools'
import {
  airMediumAt,
  type AirUniforms,
  airToward,
  LIMB_SAMPLES,
  limbReachOf,
  marchAir,
  marchLimb,
  ORBIT_AIRLIGHT,
} from './air.ts'
import {
  airEye,
  type AirMediumFn,
  airSegment,
  type CompositeAir,
  compositeAir,
  depthUnits,
  outerSpan,
  SKY_SEGMENT_SAMPLES,
  skyClass,
  SURFACE_SEGMENT_SAMPLES,
} from './cloudCompositeAir.ts'
import { follow, TextureFollower } from './cloudFront.ts'
import {
  cloudRay,
  screenTexel,
  traceScreen,
  viewDirection,
} from './cloudGeometry.ts'
import type { CloudHistoryTextures } from './cloudHistory.ts'
import { OVER_CLOUDS_LAYER } from './cloudLayers.ts'
import type { CloudCompositeMode } from './cloudLevers.ts'
import {
  type CloudFarFn,
  type CloudPhaseNodes,
  cloudStandInTexture,
} from './cloudNodes.ts'
import type {
  CloudBodyUniforms,
  CloudCameraUniforms,
  CloudUniforms,
} from './cloudUniforms.ts'
import { sceneRadianceGain, sensorRadiance } from './radiance.ts'
import { sceneFarDepth } from './sceneDepth.ts'
import type { SceneLayout } from './sceneLayout.ts'
import { warmCompile, warmCompute, warmRenderer } from './warmup.ts'

/*
 * The composite: a full-screen scene object that lays the history over the
 * scene by §5.11's identity, premultiplied,
 *
 *     out = T_c·scene + (1 − T_c)·L_a(0, t₁) + T'_a(0, t₀)·L_c + T_a(0, t₀)·B,
 *
 * writing the radiance, `reactive`, `motion` and `meterMask`. It is the first
 * opaque of pass B, the scene pass over the clouds, and its material holds
 * the frame node, so the frame's cloud work runs at its draw.
 *
 * **Nothing here carries the scene's gain.** `sensorRadiance` multiplies the
 * output by `sceneRadianceGain` once, as it does the shell's
 * `inscatter·sunColor·ATMOSPHERE_GAIN`; a value that carried it too would draw
 * the cloud and the identity's air at the gain's square wherever the gain is
 * not 1 — dusk, night, the `sunset` scenario.
 *
 * **Where there is no cloud nothing changes, bit for bit.** T_c = 1 and
 * L_c = B = 0 make the source exactly zero whatever the air's quadrature, and
 * a source under a half float's reach is discarded rather than blended, which
 * leaves `velocity` — a row with no blend, which any write replaces — the
 * surface's.
 *
 * **The ray is the scene's own pixel's**, rebuilt from the jittered camera's
 * projection and turned into body-fixed axes, so the class and the depth
 * agree with what the scene drew there. The history is read at the texel
 * `screenTexel` gives the pixel, or the neighbor of the bilinear footprint
 * whose ray ended where this pixel's does; where none did, the scene stands
 * in front of part of the cloud's depth, and the whole cloud term is weighted
 * by the share in front of it (Φ, from the depth moments). Weighting only
 * T_c would leave L_c and B whole on a ridge in front of distant cloud.
 *
 * The history's depths are the trace's: true kilometers along the ray. The
 * depth copy's are render kilometers, true ones times `compression`.
 */

export interface CloudCompositeDeps {
  readonly uniforms: CloudUniforms
  readonly history: () => CloudHistoryTextures
  /** R16F km, render resolution. */
  readonly depth: () => Texture
  /** The second body's: atlas. */
  readonly far: CloudFarFn
  /** The droplets' table, which the second body's far march reads through `far`. */
  readonly phase: CloudPhaseNodes
  /** `CloudFrameNode`: in the graph, so its `updateBefore` runs here. */
  readonly frameNode: Node
  /**
   * The air's per-sample terms, `airMediumAt` when absent: a parameter so a
   * test can stand them in where the real body is not yet written.
   */
  readonly airMedium?: AirMediumFn
}

/** The composite draws first among the over-cloud opaques. */
const ORDER = -1e6

/*
 * A history texel's ray ended where this pixel's does when the two ends agree
 * to 2% and 2 m. The trace reads the depth copy at a jittered point inside
 * its history pixel, two to four render pixels from this one, and the copy
 * steps by 2⁻¹⁰ of its value: a continuous surface stays well inside 2%
 * except at grazing incidence, where a miss costs nothing — the moments' share
 * is 1 wherever the cloud lies wholly in front of the scene.
 */
const MATCH = 0.02
const MATCH_FLOOR_KM = 0.002
/** km: the moments' deviation is never taken under a meter. */
const DEVIATION_FLOOR_KM = 0.001
/*
 * The normal CDF as 0.5·(1 + tanh(1.2·x)), within 0.02 of it everywhere,
 * written as the logistic 1/(1 + e^(−2.4·x)) it equals. Not `tanh`: on the
 * Metal device the GPU suite runs on, `tanh` returns NaN from an argument of
 * 45 up (measured; 1 + 2⁻²³ at 44), and the moments' argument is meters of
 * depth over a deviation floored at one, so a cloud 38 m in front of the
 * scene had a NaN share, which defeats the discard and blends NaN into
 * `motion`. The exponent is held to ±80, past which the share is 0 or 1 in
 * float32 anyway.
 */
const NORMAL_SLOPE = 2.4
const NORMAL_REACH = 80
/*
 * Under these a fragment adds nothing a half float holds: an opacity under
 * 2⁻⁹, and light under the smallest normal half float once the gain is on.
 */
const CLEAR_OPACITY = 1 / 512
const DARK = 2 ** -14
/** View depth floor, render meters: `sensorMrt`'s own for every other writer. */
const NEAREST = 1e-4

/**
 * The composite's own source, motion and velocity, assigned where the rest is
 * formed and read by its output and its MRT.
 */
const cloudSource = property('vec4', 'CloudSource')
const cloudMotion = property('vec4', 'CloudMotion')
const cloudVelocity = property('vec2', 'CloudVelocity')

const largest = (v: Node<'vec3'>): Node<'float'> => max(max(v.x, v.y), v.z)
const normalShare = (x: Node<'float'>): Node<'float'> =>
  float(1).div(
    exp(clamp(x.mul(-NORMAL_SLOPE), -NORMAL_REACH, NORMAL_REACH)).add(1),
  )

/** An eye-relative body-fixed point in a camera's normalized device coordinates. */
function project(
  point: Node<'vec3'>,
  right: Node<'vec3'>,
  up: Node<'vec3'>,
  forward: Node<'vec3'>,
  plane: Node<'vec2'>,
): Node<'vec2'> {
  const depth = max(dot(point, forward), 1e-6)
  return vec2(
    dot(point, right).div(depth.mul(plane.x)),
    dot(point, up).div(depth.mul(plane.y)),
  )
}

/**
 * The motion of a cloud point `distance` true meters along `direction`, in
 * the scene's velocity convention — unjittered NDC now minus then — formed as
 * the history reprojects it: the eye's translation, then the drift. Zero for
 * a point behind the previous camera, which the history rejects anyway.
 */
function motionOf(
  camera: CloudCameraUniforms,
  direction: Node<'vec3'>,
  distance: Node<'float'>,
  drift: Node<'vec3'>,
): Node<'vec2'> {
  const now = direction.mul(distance)
  const before = now.add(camera.translation).sub(drift)
  const moved = project(
    now,
    camera.right,
    camera.up,
    camera.forward,
    camera.plane,
  ).sub(
    project(
      before,
      camera.previousRight,
      camera.previousUp,
      camera.previousForward,
      camera.previousPlane,
    ),
  )
  return select(
    dot(before, camera.previousForward).greaterThan(0),
    moved,
    vec2(0),
  )
}

/** The texture nodes a program reads the history and the depth copy through, kept on the current objects. */
interface Sources {
  readonly light: TextureNode
  readonly air: TextureNode
  readonly moments: TextureNode
  readonly depth: TextureNode
  follow(): void
}

function sources(deps: CloudCompositeDeps): Sources {
  const history = deps.history()
  const nodes = {
    light: texture(history.light),
    air: texture(history.air),
    moments: texture(history.depth),
    depth: texture(deps.depth()),
  }
  return {
    ...nodes,
    follow() {
      const now = deps.history()
      follow(nodes.light, now.light)
      follow(nodes.air, now.air)
      follow(nodes.moments, now.depth)
      follow(nodes.depth, deps.depth())
    },
  }
}

/**
 * The history texel for a pixel whose ray ends `endKm` true kilometers out:
 * the one `screenTexel` gives, or the neighbor of the bilinear footprint
 * whose ray ended nearest where this one does, the first on a tie, and
 * whether its end agrees with this pixel's.
 */
function historyTexel(
  moments: TextureNode,
  screen: Node<'vec2'>,
  extent: Node<'vec2'>,
  endKm: Node<'float'>,
): { readonly texel: Node<'ivec2'>; readonly matched: Node<'bool'> } {
  const tolerance = endKm.mul(MATCH).add(MATCH_FLOOR_KM)
  const nearest = screenTexel(screen, extent)
  const best = ivec2(nearest).toVar()
  const miss = abs(moments.load(nearest).x.sub(endKm)).toVar()
  If(miss.greaterThan(tolerance), () => {
    const at = vec2(
      screen.x.add(1).mul(0.5).mul(extent.x),
      float(1).sub(screen.y).mul(0.5).mul(extent.y),
    )
    // Clamped in float and converted once, as `screenTexel` does.
    const low = floor(at.sub(0.5))
    const highest = extent.sub(1)
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const texel = ivec2(clamp(low.add(vec2(dx, dy)), vec2(0), highest))
      const off = abs(moments.load(texel).x.sub(endKm))
      If(off.lessThan(miss), () => {
        best.assign(texel)
        miss.assign(off)
      })
    }
  })
  return { texel: best, matched: miss.lessThanEqual(tolerance) }
}

/** What the composite's fragment writes, before the gain. */
interface Composite {
  readonly color: Node<'vec4'>
  readonly mrt: MRTNode
}

/**
 * The fragment: the served body's history by the identity or the thin form,
 * the second body's far march over it by the thin form, and the discard where
 * neither adds anything.
 */
function compositeGraph(
  deps: CloudCompositeDeps,
  textures: Sources,
  modes: { readonly thin: Node<'float'>; readonly drawn: Node<'float'> },
  medium: AirMediumFn,
): Composite {
  const { uniforms } = deps
  const { served, second, camera } = uniforms
  const follower = new TextureFollower(deps.frameNode as Node<'float'>, () => {
    textures.follow()
  })
  const color = Fn(() => {
    const light = vec3(0).toVar()
    const opacity = float(0).toVar()
    const servedOpacity = float(0).toVar()
    const distance = float(0).toVar()
    const drift = vec3(0).toVar()
    // The pixel's center, y up, as `traceScreen` puts a texel's.
    const screen = vec2(
      screenUV.x.mul(2).sub(1),
      float(1).sub(screenUV.y.mul(2)),
    )
    const unprojected = cameraProjectionMatrixInverse.mul(vec4(screen, 0.5, 1))
    const view = normalize(unprojected.xyz.div(unprojected.w))
    const world = cameraWorldMatrix.mul(vec4(view, 0)).xyz
    const depthKm = textures.depth.load(ivec2(screenCoordinate)).x
    const direction = normalize(served.toBodyFixed.mul(world))

    If(modes.drawn.greaterThan(0.5), () => {
      const ray = cloudRay(
        direction,
        served,
        depthKm.mul(1000).div(served.compression),
      )
      If(served.active.greaterThan(0.5).and(ray.hit), () => {
        const endKm = ray.end.mul(1e-3)
        const { texel, matched } = historyTexel(
          textures.moments,
          screen,
          uniforms.trace.history,
          endKm,
        )
        const cloud = textures.light.load(texel)
        const blocked = textures.air.load(texel)
        const moments = textures.moments.load(texel)
        const reproject = blocked.w
        const share = select(
          matched,
          float(1),
          normalShare(
            depthKm
              .div(served.compression)
              .sub(reproject)
              .div(max(moments.z, DEVIATION_FLOOR_KM)),
          ),
        )
        const thin = modes.thin.greaterThan(0.5)
        const radius = served.datumRadius
        const meters = reproject.mul(1000)
        const air = compositeAir(
          served.air,
          airEye(served),
          direction,
          ray.start.div(radius),
          select(thin, clamp(meters, ray.start, ray.end), ray.end).div(radius),
          depthKm,
          served.sun,
          served.cleared,
          depthUnits(served),
          medium,
        )
        const transmittance = cloud.w
        const opaque = float(1).sub(transmittance)
        const term = air.toEnd
          .mul(opaque)
          .add(air.seen.mul(cloud.xyz))
          .add(
            select(thin, vec3(0), air.toStart.transmittance.mul(blocked.xyz)),
          )
        light.assign(term.mul(served.dayColor).mul(ATMOSPHERE_GAIN).mul(share))
        opacity.assign(opaque.mul(share))
        servedOpacity.assign(opacity)
        distance.assign(meters)
        drift.assign(uniforms.trace.wind.mul(uniforms.trace.frameSeconds))
      })
      If(second.active.greaterThan(0.5), () => {
        const toSecond = normalize(second.toBodyFixed.mul(world))
        const ray = cloudRay(
          toSecond,
          second,
          depthKm.mul(1000).div(second.compression),
        )
        If(ray.hit, () => {
          const radius = second.datumRadius
          const units = depthUnits(second)
          const eye = airEye(second)
          const sky = skyClass(second.air, eye, toSecond, depthKm, units)
          const far = deps.far(ray, ray.start, second, sky)
          const reached = clamp(far.depthMean, ray.start, ray.end)
          const air = compositeAir(
            second.air,
            eye,
            toSecond,
            ray.start.div(radius),
            reached.div(radius),
            depthKm,
            second.sun,
            second.cleared,
            units,
            medium,
          )
          // The thin form: no blocked air, the air to the cloud's mean depth.
          const opaque = float(1).sub(far.transmittance)
          const own = air.toEnd
            .mul(opaque)
            .add(air.seen.mul(far.light))
            .mul(second.dayColor)
            .mul(ATMOSPHERE_GAIN)
          // Behind the served body's cloud, which is the nearer.
          const through = float(1).sub(opacity)
          light.addAssign(own.mul(through))
          opacity.addAssign(opaque.mul(through))
          // The second's cloud carries the velocity only where it is all the
          // pixel holds, and moves with the eye alone: its drift and its
          // body's own motion are not modeled, and its distance is taken
          // into the served body's true meters.
          If(servedOpacity.lessThan(CLEAR_OPACITY), () => {
            distance.assign(
              reached.mul(second.compression).div(served.compression),
            )
            drift.assign(vec3(0))
          })
        })
      })
    })

    const velocity = motionOf(camera, direction, distance, drift)
    // `motion` is `over`-blended by its source alpha: the served cloud's
    // opacity, so where the second body's cloud alone draws the surface keeps
    // its own, which the far cloud rides on.
    const viewDepth = distance.mul(served.compression).mul(view.z.negate())
    cloudMotion.assign(
      vec4(velocity, max(viewDepth, NEAREST).reciprocal(), servedOpacity),
    )
    cloudVelocity.assign(velocity)
    If(
      modes.drawn
        .lessThan(0.5)
        .or(
          opacity
            .lessThan(CLEAR_OPACITY)
            .and(largest(abs(light)).mul(sceneRadianceGain).lessThan(DARK)),
        ),
      () => {
        Discard()
      },
    )
    cloudSource.assign(vec4(light, opacity.add(nodeObject(follower))))
    return cloudSource
  })()
  return {
    color,
    mrt: mrt({
      motion: cloudMotion,
      velocity: vec4(cloudVelocity, 0, 1),
    }),
  }
}

/*
 * Premultiplied compositing over the scene: the source is radiance, not
 * radiance over alpha, so the blend adds it whole and lets alpha extinguish
 * what is behind — (One, OneMinusSrcAlpha), the shell's. The alpha writes are
 * (Zero, One), the shell's and the starfield's: an additive pass stamping
 * alpha into the extended-range canvas is the compositor artifact `flare.ts`
 * documents. A custom blend also keeps the opaque list's material from having
 * its alpha forced to one (`NodeBuilder.isOpaque` asks for normal blending).
 */
function compositeMaterial(): MeshBasicNodeMaterial {
  const material = sensorRadiance(
    new MeshBasicNodeMaterial(),
    false,
    false,
    'alpha',
  )
  /*
   * The source goes back into `output` unclamped, ahead of the sensor's own
   * output, which then applies the gain once and takes the opacity for
   * `reactive` as it does for every material. Three clamps a color node's
   * output at zero ("force unsigned floats", `NodeMaterial.setup`), and the
   * identity's light is negative where the composite's air and the trace's
   * blocked air disagree in quadrature: clamped, every such pixel is biased
   * bright, and by an error the residual meter cannot see.
   */
  const radiance = material.outputNode!
  material.outputNode = Fn(() => {
    output.assign(cloudSource)
    return radiance
  })()
  material.name = 'cloud composite'
  material.depthTest = false
  material.depthWrite = false
  material.fog = false
  material.blending = CustomBlending
  material.blendEquation = AddEquation
  material.blendSrc = OneFactor
  material.blendDst = OneMinusSrcAlphaFactor
  material.blendEquationAlpha = AddEquation
  material.blendSrcAlpha = ZeroFactor
  material.blendDstAlpha = OneFactor
  // The plane in clip space, at the far depth the backdrop takes: a full-screen
  // object needs no camera, and with no depth test the depth is never read.
  material.vertexNode = vec4(positionGeometry.xy, sceneFarDepth, 1)
  return material
}

export class CloudComposite {
  /** Opaque list, OVER layer, `renderOrder` −1e6. */
  readonly mesh: Mesh
  readonly #deps: CloudCompositeDeps
  readonly #geometry = new PlaneGeometry(2, 2)
  readonly #material = compositeMaterial()
  readonly #thin = uniform(0)
  readonly #drawn = uniform(1)
  #mode: CloudCompositeMode = 'identity'
  #built = false
  #meter: ResidualMeter | null = null
  #disposed = false

  /*
   * Construction reaches nothing in `deps`: the mesh, its list, layer and
   * order are what the system arranges before a frame, and the graph —
   * which reads every dependency — is built at the first `warm` or `show`.
   */
  constructor(deps: CloudCompositeDeps) {
    this.#deps = deps
    this.mesh = new Mesh(this.#geometry, this.#material)
    this.mesh.layers.set(OVER_CLOUDS_LAYER)
    this.mesh.renderOrder = ORDER
    this.mesh.name = 'cloud composite'
    this.mesh.visible = false
    this.mesh.frustumCulled = false
  }

  /** The residual meter's histograms, under composite 'residual', read back a frame or so late. */
  get residual(): CloudRenderReport['residual'] {
    return this.#meter?.report ?? null
  }

  /** A uniform: identity, thin, or inert under 'residual', so the meter reads the scene as built. */
  setMode(mode: CloudCompositeMode): void {
    this.#mode = mode
    this.#thin.value = mode === 'thin' ? 1 : 0
    this.#drawn.value = mode === 'residual' ? 0 : 1
  }

  /**
   * Draws nothing until the next `setMode`, which every frame the clouds
   * draw begins with: the frame's cloud work threw, and the history holds a
   * stale or partial frame. A uniform rather than `show(false)`, because the
   * throw is caught inside this mesh's own draw, after three has chosen to
   * draw it and before it binds the uniforms.
   */
  inert(): void {
    this.#drawn.value = 0
  }

  /** The mesh drawn this frame or not; the graph is built at the first show. */
  show(on: boolean): void {
    if (on) this.#build()
    this.mesh.visible = on
  }

  /** The residual meter: after the frame, under composite 'residual'. */
  measureResidual(renderer: WebGPURenderer, sceneTarget: RenderTarget): void {
    if (this.#disposed || this.#mode !== 'residual') return
    this.#build()
    this.#meter?.measure(renderer, sceneTarget)
  }

  /** The residual readback in flight, settled when `residual` holds it; settled at once with none. */
  residualRead(): Promise<void> {
    return this.#meter?.reading ?? Promise.resolve()
  }

  /** The mesh against the scene pass's layout, and the residual meter's kernels. */
  async warm(
    renderer: WebGPURenderer,
    layout: SceneLayout,
    camera: Camera,
    scene: Scene,
  ): Promise<void> {
    if (this.#disposed) return
    this.#build()
    const warm = warmRenderer(renderer, layout)
    await warmCompile(warm, { object: this.mesh, camera, scene })
    if (this.#meter !== null) await warmCompute(renderer, this.#meter.kernels)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#geometry.dispose()
    this.#material.dispose()
    this.#meter?.dispose()
  }

  #build(): void {
    if (this.#built || this.#disposed) return
    this.#built = true
    const deps = this.#deps
    const medium = deps.airMedium ?? airMediumAt
    const graph = compositeGraph(
      deps,
      sources(deps),
      { thin: this.#thin, drawn: this.#drawn },
      medium,
    )
    this.#material.colorNode = graph.color
    this.#material.mrtNode = graph.mrt
    this.#material.needsUpdate = true
    this.#meter = new ResidualMeter(deps, medium)
  }
}

/* ------------------------------------------------------------------------- */
/* The residual meter                                                         */
/* ------------------------------------------------------------------------- */

const RESIDUAL_LABEL = 'cloud residual'
/** The report's bins, which the runner reads back by the same definition. */
const BINS = CLOUD_HISTOGRAM_BINS
/**
 * Four histograms — thin, light, total and the limb's — then the cloud
 * texels counted, the limb's own, and the class disagreements.
 */
const SAMPLES = 4 * BINS
const LIMB_TEXELS = SAMPLES + 1
const DISAGREEMENTS = SAMPLES + 2
const SLOTS = SAMPLES + 3
/** Radians from the limb inside which a sky texel is the limb's (§8.6). */
const LIMB_BAND = (2 * Math.PI) / 180
/** A texel holds cloud where it extinguishes a thousandth or adds any light. */
const CLOUDLESS = 1 - 1e-3
/** Scene units: the relative errors' denominator is never under this. */
const FAINTEST = 1e-6
const WORKGROUP = 64
/** The shell's twelve crowded samples: two of the composite's sky segments. */
const SHELL_SAMPLES = 2 * SKY_SEGMENT_SAMPLES
/** The corners of a trace texel's footprint, as `traceScreen` offsets them from its center. */
const CORNERS = [
  [-0.49, -0.49],
  [0.49, -0.49],
  [-0.49, 0.49],
  [0.49, 0.49],
] as const
const LUMA = /*@__PURE__*/ vec3(0.2126, 0.7152, 0.0722)

const luma = (v: Node<'vec3'>): Node<'float'> => dot(v, LUMA)

/**
 * The residual meter: `cloud residual`, a compute pass at trace resolution
 * after a frame drawn with the composite inert, so the scene target holds the
 * scene as built. A cloud texel reads that scene ÷ the gain, the depth copy,
 * the history and the served body's air, and puts three relative errors in
 * three histograms, each against the identity's own output there, and a
 * fourth for the limb:
 *
 * - `thin`: the identity against the thin form;
 * - `light`: the identity's light residual, T_c·{L_scene(0, end) −
 *   L_a(0, t₁) − T_a(0, t₁)·L_a(t₁, end)}, the scene's own march against the
 *   composite's segments and the class's march past them;
 * - `total`: that plus its transmittance residual × S, T_c·{T_scene −
 *   T_a(0, t₁)·T_a(t₁, end)}·S with S = (scene − L_scene)/T_scene, where a
 *   surface's T is the cleared one segment by segment under Enhanced, which
 *   does not compose;
 * - `limb`: at a sky texel within 2° of the limb, the light of the ring
 *   Enhanced draws there times the cloud's opacity, the share of a ring in
 *   front of the cloud the identity dims, which no other histogram can see:
 *   the meter's own air for a sky texel is the shell's physics alone.
 *
 * It counts the cloud texels whose footprint's corners do not all share the
 * class of its center — the texels the trace and the composite can decide
 * differently, the limb chiefly — and reads all of it back asynchronously, a
 * read at a time, as the exposure meter does.
 */
class ResidualMeter {
  readonly kernels: readonly ComputeNode[]
  report: CloudRenderReport['residual'] = null
  reading: Promise<void> | null = null
  readonly #deps: CloudCompositeDeps
  readonly #buffer = new StorageBufferAttribute(new Uint32Array(SLOTS), 1)
  /** The scene target's resolved output, on a stand-in of its format until the first measurement. */
  readonly #scene = texture(cloudStandInTexture('2d', 'rgba16f'))
  readonly #sources: Sources
  readonly #clear: ComputeNode
  readonly #measure: ComputeNode
  #disposed = false

  constructor(deps: CloudCompositeDeps, medium: AirMediumFn) {
    this.#deps = deps
    this.#sources = sources(deps)
    const counts = storage(this.#buffer, 'uint', SLOTS).toAtomic()
    this.#clear = Fn(() => {
      If(instanceIndex.lessThan(uint(SLOTS)), () => {
        atomicStore(counts.element(instanceIndex), uint(0))
      })
    })().compute(SLOTS)
    this.#measure = residualKernel(
      deps,
      this.#sources,
      this.#scene,
      (slot) => {
        atomicAdd(counts.element(slot), uint(1))
      },
      medium,
    )
    // One label for both: the timeline's row is the meter's.
    this.#clear.setName(RESIDUAL_LABEL)
    this.#measure.setName(RESIDUAL_LABEL)
    this.kernels = [this.#clear, this.#measure]
  }

  measure(renderer: WebGPURenderer, sceneTarget: RenderTarget): void {
    if (this.#disposed || this.reading !== null) return
    follow(this.#scene, sceneTarget.texture)
    this.#sources.follow()
    const { x: width, y: height } = this.#deps.uniforms.trace.size.value
    this.#measure.count = Math.ceil((width * height) / WORKGROUP) * WORKGROUP
    renderer.compute(this.#clear)
    renderer.compute(this.#measure)
    this.reading = renderer
      .getArrayBufferAsync(this.#buffer)
      .then((buffer) => {
        if (!this.#disposed) this.report = readout(new Uint32Array(buffer))
      })
      .catch(() => {
        // A device being replaced has no meter; the next system owns a fresh one.
      })
      .finally(() => {
        this.reading = null
      })
  }

  dispose(): void {
    this.#disposed = true
    for (const kernel of this.kernels) kernel.dispose()
    this.#buffer.dispose()
  }
}

/**
 * The bin of a relative error, from 10⁻⁴ (and under) to 1 (and over):
 * `cloudHistogramBin`'s, on the GPU.
 */
export function residualBin(error: Node<'float'>): Node<'uint'> {
  const decade = log2(max(error, 1e-30)).div(Math.log2(10))
  const index = clamp(
    floor(
      decade
        .sub(CLOUD_HISTOGRAM_FLOOR_DECADE)
        .mul(CLOUD_HISTOGRAM_BINS_A_DECADE),
    ),
    0,
    BINS - 1,
  )
  return uint(index)
}

/** The slot of a relative error in histogram `k`. */
const binOf = (k: number, error: Node<'float'>): Node<'uint'> =>
  residualBin(error).add(uint(k * BINS))

/**
 * Whether a ray from an eye at `eye` (sea-level units about the center,
 * its own up) lies within the band of the limb: its angle from the nadir
 * against the datum's tangent cone, asin(1/r).
 */
function nearLimb(eye: Node<'vec3'>, direction: Node<'vec3'>): Node<'bool'> {
  const r = max(length(eye), 1)
  const nadir = acos(clamp(dot(direction, eye).div(r).negate(), -1, 1))
  return abs(nadir.sub(asin(float(1).div(r)))).lessThan(LIMB_BAND)
}

/**
 * The ring Enhanced draws along a ray, as the shell marches it: the lifted
 * gas from where the ray enters its reach to where it leaves it, or to the
 * ground the ray meets ahead (`materials.ts`). Zero wherever Enhanced is off
 * or the eye has no lift.
 */
function limbRing(
  air: AirUniforms,
  eye: Node<'vec3'>,
  direction: Node<'vec3'>,
  sun: Node<'vec3'>,
): Node<'vec3'> {
  const toCenter = eye.negate()
  const closest = dot(toCenter, direction)
  const impactSquared = max(length(cross(direction, toCenter)).pow(2), 0)
  const reach = limbReachOf(air)
  const halfReach = sqrt(max(reach.mul(reach).sub(impactSquared), 0))
  const halfInner = sqrt(max(float(1).sub(impactSquared), 0))
  const near = max(closest.sub(halfReach), 0)
  const meetsGround = impactSquared.lessThan(1).and(closest.greaterThan(0))
  const far = select(
    meetsGround,
    max(closest.sub(halfInner), near),
    closest.add(halfReach),
  )
  return marchLimb(air, eye, direction, near, far, sun, LIMB_SAMPLES)
}

/**
 * The air the scene drew at a pixel of the identity's class over its own
 * segment from the eye — the shell's twelve samples to its far wall,
 * extinguishing by their gray mean, or `airToward`'s four to the surface,
 * cleared under Enhanced — and the class's march from the span's end on to
 * where the scene's stopped: the light past it, and the composite's chain of
 * transmittances to there, cleared a segment at a time on a surface.
 */
function sceneAir(
  body: CloudBodyUniforms,
  eye: Node<'vec3'>,
  direction: Node<'vec3'>,
  identity: CompositeAir,
  ends: Node<'float'>,
  surface: Node<'float'>,
  medium: AirMediumFn,
): {
  readonly light: Node<'vec3'>
  readonly through: Node<'vec3'>
  readonly past: Node<'vec3'>
  readonly chain: Node<'vec3'>
} {
  const air = body.air
  const { near, wall } = outerSpan(air, eye, direction)
  const light = vec3(0).toVar()
  const through = vec3(1).toVar()
  const past = vec3(0).toVar()
  const chain = vec3(1).toVar()
  If(identity.sky, () => {
    const shell = marchAir(
      air,
      eye,
      direction,
      near,
      wall,
      body.sun,
      SHELL_SAMPLES,
    )
    const beyond = airSegment(
      air,
      eye,
      direction,
      ends,
      wall,
      body.sun,
      SKY_SEGMENT_SAMPLES,
      null,
      medium,
    )
    light.assign(shell.inscatter)
    through.assign(vec3(shell.transmittance.dot(vec3(1 / 3))))
    past.assign(beyond.inscatter)
    chain.assign(identity.throughEnd.mul(beyond.transmittance))
  }).Else(() => {
    const toward = airToward(
      air,
      eye,
      eye.add(direction.mul(surface)),
      body.sun,
    )
    const beyond = airSegment(
      air,
      eye,
      direction,
      ends,
      surface,
      body.sun,
      SURFACE_SEGMENT_SAMPLES,
      body.cleared.mul(ORBIT_AIRLIGHT),
      medium,
    )
    const cleared = (t: Node<'vec3'>) => mix(t, vec3(1), body.cleared)
    light.assign(toward.inscatter)
    through.assign(toward.transmittance)
    past.assign(beyond.inscatter)
    chain.assign(
      cleared(identity.throughEnd).mul(cleared(beyond.transmittance)),
    )
  })
  return { light, through, past, chain }
}

/** The measurement over every trace texel; `tally` adds one to a slot. */
function residualKernel(
  deps: CloudCompositeDeps,
  textures: Sources,
  scene: TextureNode,
  tally: (slot: Node<'uint'>) => void,
  medium: AirMediumFn,
): ComputeNode {
  const { served, camera, trace } = deps.uniforms
  return Fn(() => {
    const width = uint(trace.size.x)
    const height = uint(trace.size.y)
    If(instanceIndex.lessThan(width.mul(height)), () => {
      const pixel = uvec2(instanceIndex.mod(width), instanceIndex.div(width))
      const screen = traceScreen(pixel, vec2(0), trace.size)
      const at = screenTexel(screen, trace.render)
      const texel = screenTexel(screen, trace.history)
      const direction = viewDirection(camera, screen)
      const depthKm = textures.depth.load(at).x
      const cloud = textures.light.load(texel)
      const blocked = textures.air.load(texel)
      const ray = cloudRay(
        direction,
        served,
        depthKm.mul(1000).div(served.compression),
      )
      const cloudy = cloud.w
        .lessThan(CLOUDLESS)
        .or(largest(abs(cloud.xyz)).greaterThan(0))
        .or(largest(abs(blocked.xyz)).greaterThan(0))
      If(cloudy.and(ray.hit).and(served.active.greaterThan(0.5)), () => {
        tally(uint(SAMPLES))
        const radius = served.datumRadius
        const units = depthUnits(served)
        const eye = airEye(served)
        const start = ray.start.div(radius)
        const end = ray.end.div(radius)
        const reached = clamp(blocked.w.mul(1000).div(radius), start, end)
        const air = (to: Node<'float'>) =>
          compositeAir(
            served.air,
            eye,
            direction,
            start,
            to,
            depthKm,
            served.sun,
            served.cleared,
            units,
            medium,
          )
        const identity = air(end)
        const thin = air(reached)
        const k = served.dayColor.mul(ATMOSPHERE_GAIN)
        const drawn = scene.load(at).rgb.div(sceneRadianceGain)
        const transmittance = cloud.w
        const opaque = float(1).sub(transmittance)
        const kept = drawn.mul(transmittance)
        const fromThin = kept.add(
          thin.toEnd.mul(opaque).add(thin.seen.mul(cloud.xyz)).mul(k),
        )
        const fromIdentity = kept.add(
          identity.toEnd
            .mul(opaque)
            .add(identity.seen.mul(cloud.xyz))
            .add(identity.toStart.transmittance.mul(blocked.xyz))
            .mul(k),
        )
        const reference = max(luma(fromIdentity), FAINTEST)
        tally(binOf(0, abs(luma(fromIdentity.sub(fromThin))).div(reference)))

        const surface = depthKm.mul(units)
        const own = sceneAir(
          served,
          eye,
          direction,
          identity,
          min(end, surface),
          surface,
          medium,
        )
        const lightResidual = own.light
          .sub(identity.toEnd)
          .sub(identity.throughEnd.mul(own.past))
          .mul(k)
          .mul(transmittance)
        const behind = drawn
          .sub(own.light.mul(k))
          .div(max(own.through, vec3(1e-4)))
        const throughResidual = own.through
          .sub(own.chain)
          .mul(behind)
          .mul(transmittance)
        tally(binOf(1, abs(luma(lightResidual)).div(reference)))
        tally(
          binOf(
            2,
            abs(luma(lightResidual.add(throughResidual))).div(reference),
          ),
        )

        // §5.11 (iii): the ring Enhanced draws at a sky pixel is in front of
        // the cloud, and the identity dims it by T_c with the rest of the
        // scene; the shell's own march of it says how much light that is.
        If(identity.sky.and(nearLimb(eye, direction)), () => {
          tally(uint(LIMB_TEXELS))
          const ring = limbRing(served.air, eye, direction, served.sun)
          tally(binOf(3, abs(luma(ring.mul(k).mul(opaque))).div(reference)))
        })

        // The class at the footprint's corners against its center's: the
        // corners that are sky, against all four or none.
        const skyCorners = CORNERS.map(([jx, jy]) => {
          const corner = traceScreen(pixel, vec2(jx, jy), trace.size)
          const sky = skyClass(
            served.air,
            eye,
            viewDirection(camera, corner),
            textures.depth.load(screenTexel(corner, trace.render)).x,
            units,
          )
          return select(sky, float(1), float(0))
        }).reduce((sum, one) => sum.add(one))
        const agreed = select(identity.sky, float(CORNERS.length), float(0))
        If(skyCorners.notEqual(agreed), () => {
          tally(uint(DISAGREEMENTS))
        })
      })
    })
  })().compute(WORKGROUP)
}

function histogram(
  counts: Uint32Array,
  k: number,
  samples = SAMPLES,
): CloudHistogram {
  return {
    bins: Array.from(counts.subarray(k * BINS, (k + 1) * BINS)),
    samples: counts[samples] ?? 0,
  }
}

function readout(
  counts: Uint32Array,
): NonNullable<CloudRenderReport['residual']> {
  return {
    thin: histogram(counts, 0),
    light: histogram(counts, 1),
    total: histogram(counts, 2),
    limb: histogram(counts, 3, LIMB_TEXELS),
    classDisagreement: counts[DISAGREEMENTS] ?? 0,
  }
}
