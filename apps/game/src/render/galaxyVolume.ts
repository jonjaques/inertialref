import {
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NodeMaterial,
  NodeUpdateType,
  NoToneMapping,
  ColorManagement,
  PlaneGeometry,
  QuadMesh,
  RenderTarget,
  TempNode,
  Vector2,
  Vector3,
  type Node,
  type NodeFrame,
  type PassNode,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  float,
  nodeObject,
  passTexture,
  positionGeometry,
  uniform,
  uv,
  vec4,
} from 'three/tsl'
import { getTimer, PARSEC } from '@inertialref/shared'
import { Quaternion as Q, UV } from '@inertialref/spatial'
import {
  GALAXY_LUMINOUS_EFFICACY,
  SURFACE_LUMINANCE,
  verticalFov,
  type Lens,
} from '@inertialref/rendering'
import {
  GALAXY_FIELD_VERSIONS,
  GALAXY_DUST_SETTLED_STEP_PARSECS,
  type GalaxyField,
} from '@inertialref/universe'
import type { GalaxyRenderReport, ObserverPose } from '@inertialref/devtools'
import { timingDetailed } from '../engine/browserTiming.ts'
import { RENDER_PHASE } from '../engine/frameTiming.ts'
import {
  createGalaxyKernel,
  GALAXY_KERNEL_VERSION,
  GALAXY_MAX_STEP_PARSECS,
  GALAXY_MAX_STEPS,
} from './galaxyKernel.ts'
import { sensorRadiance } from './radiance.ts'
import { warmSensorPass } from './warmup.ts'

export const GALAXY_RESOLUTION_DIVISOR = 4
export const GALAXY_SETTLE_SUBMISSIONS = 8
/** Sub-parsec drift must not hold an otherwise stationary instrument at travel quality. */
export const GALAXY_SAMPLING_MOTION_PARSECS = 0.01
const SAMPLING_ANGLE = 1e-4
/** A half-float texel holds thousands of nW m^-2 sr^-1, preserving both halo and bulge. */
const RADIANCE_UNIT = 1000

/** Each draw is an entry on the Render track, so a trace says when the volume drew and at what quality. */
const timer = getTimer('game.render')

/**
 * A deterministic volume draw whenever the view changes, held in its own
 * target until it changes again; no history, no reprojection, no borrowed
 * targets. Two draws per change of view: the observer profile at once, and
 * the settled one after `GALAXY_SETTLE_SUBMISSIONS` unchanged submissions.
 */
export class GalaxyVolumeNode extends TempNode<'vec4'> {
  static get type() {
    return 'GalaxyVolumeNode'
  }
  readonly #target = new RenderTarget(1, 1, {
    type: HalfFloatType,
    depthBuffer: false,
  })
  readonly #material = new NodeMaterial()
  readonly #quad = new QuadMesh(this.#material)
  readonly #size = new Vector2()
  readonly #origin = uniform(new Vector3())
  readonly #right = uniform(new Vector3(1, 0, 0))
  readonly #up = uniform(new Vector3(0, 1, 0))
  readonly #forward = uniform(new Vector3(0, 0, -1))
  readonly #plane = uniform(new Vector2(1, 1))
  readonly #sampling = uniform(1, 'uint')
  readonly #kernel: ReturnType<typeof createGalaxyKernel>
  readonly outputTexture = passTexture(
    this as unknown as PassNode,
    this.#target.texture,
  )
  #pose: ObserverPose | null = null
  #lens: Lens | null = null
  #field: GalaxyField
  #disposed = false
  #active = false
  #fov = 1
  #submissions = 0
  #draws = 0
  /** The target does not hold this view, field and size. */
  #dirty = true
  #held = false
  /** The sampling the target was last drawn with; 0 before the first draw. */
  #drawnSampling = 0
  #warm: Promise<void> | null = null
  #ready = false
  #stableSubmissions = 0
  #samplingPose: ObserverPose | null = null
  #samplingFov = 0

  constructor(field: GalaxyField) {
    super('vec4')
    this.#field = field
    this.#kernel = createGalaxyKernel(field)
    this.updateBeforeType = NodeUpdateType.RENDER
    this.#target.texture.name = 'Galaxy radiance'
    this.#target.texture.minFilter = LinearFilter
    this.#target.texture.magFilter = LinearFilter
    // `uv()` is the drawing quad's own attribute and it is *not* the axis the
    // backdrop reads the result back on. A `QuadMesh` carries v = 0 at the top
    // of its attachment, so writing at v puts the ray for `screen.y` in the
    // texel a sampler reaches at 1 − v — and `createGalaxyBackdrop` samples a
    // `PlaneGeometry`, whose v runs the other way. The two conventions cancel
    // only with `up` added here: subtracted, the composed frame is the whole
    // volume mirrored about the horizon, which two near-symmetric fixed views
    // hide. `galaxyOrientation.gpu.test.ts` holds the composed rows to the CPU ray.
    const screen = uv().mul(2).sub(1)
    const direction = this.#forward
      .add(this.#right.mul(screen.x.mul(this.#plane.x)))
      .add(this.#up.mul(screen.y.mul(this.#plane.y)))
    this.#material.fragmentNode = vec4(
      this.#kernel
        .integrate(this.#origin, direction, 100000, this.#sampling)
        .rgb.div(RADIANCE_UNIT),
      1,
    )
    this.#material.name = 'Galaxy integral'
  }

  override setup(): Node {
    return this.outputTexture
  }

  configure(pose: ObserverPose | null, lens: Lens, field = this.#field): void {
    const previous = this.#samplingPose
    if (
      pose === null ||
      previous === null ||
      field !== this.#field ||
      UV.distance(pose.position, previous.position) >
        GALAXY_SAMPLING_MOTION_PARSECS * PARSEC ||
      Math.abs(
        pose.orientation.x * previous.orientation.x +
          pose.orientation.y * previous.orientation.y +
          pose.orientation.z * previous.orientation.z +
          pose.orientation.w * previous.orientation.w,
      ) < Math.cos(SAMPLING_ANGLE / 2) ||
      Math.abs(verticalFov(lens) - this.#samplingFov) > SAMPLING_ANGLE
    ) {
      this.#stableSubmissions = 0
      this.#sampling.value = 1
      this.#dirty = true
      this.#samplingPose =
        pose === null
          ? null
          : {
              position: { ...pose.position },
              orientation: { ...pose.orientation },
            }
      this.#samplingFov = verticalFov(lens)
    }
    this.#pose = pose
    this.#lens = lens
    this.#active = pose !== null && !this.#disposed
    if (field !== this.#field) {
      this.#field = field
      this.#kernel.setField(field)
      this.#dirty = true
    }
    if (pose === null) return
    const p = UV.approxMeters(pose.position)
    this.#origin.value.set(p.x / PARSEC, p.y / PARSEC, p.z / PARSEC)
    const basis = Q.basis(pose.orientation)
    this.#right.value.set(basis.right.x, basis.right.y, basis.right.z)
    this.#up.value.set(basis.up.x, basis.up.y, basis.up.z)
    this.#forward.value.set(basis.forward.x, basis.forward.y, basis.forward.z)
    this.#fov = verticalFov(lens)
  }

  get active(): boolean {
    return this.#active && !this.#disposed
  }
  get ready(): boolean {
    return this.#ready && !this.#disposed
  }
  get diagnostics(): GalaxyRenderReport {
    return {
      coordinateFrame: 'galactocentric',
      orientation: this.#pose?.orientation ?? null,
      lens: this.#lens,
      sampling: this.#sampling.value === 2 ? 'settled' : 'observer',
      exposure: null,
      instrument: false,
      journey: null,
      survey: null,
      active: this.active,
      ready: this.ready,
      fieldVersions: GALAXY_FIELD_VERSIONS,
      kernelVersion: GALAXY_KERNEL_VERSION,
      normalization: this.#field.normalization,
      width: this.#target.width,
      height: this.#target.height,
      targetBytes: this.#disposed
        ? 0
        : this.#target.width * this.#target.height * 8,
      resolutionDivisor: GALAXY_RESOLUTION_DIVISOR,
      maxStepParsecs: GALAXY_MAX_STEP_PARSECS,
      dustStepParsecs:
        this.#sampling.value === 2 ? GALAXY_DUST_SETTLED_STEP_PARSECS : null,
      settled: this.#sampling.value === 2,
      maxSteps: GALAXY_MAX_STEPS,
      submissions: this.#submissions,
      draws: this.#draws,
      held: this.#held,
      emissionOnly: this.#field.dustScale === 0,
      dustScale: this.#field.dustScale,
      dustNormalization: this.#field.dustNormalization,
      resolvedStarExtinction: false,
      originParsecs: this.#origin.value.toArray(),
    }
  }

  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    const size = renderer.getDrawingBufferSize(this.#size)
    this.#target.setSize(
      Math.max(1, Math.ceil(size.x / GALAXY_RESOLUTION_DIVISOR)),
      Math.max(1, Math.ceil(size.y / GALAXY_RESOLUTION_DIVISOR)),
    )
    this.#warm ??= warmSensorPass(renderer, this.#quad, [
      { target: this.#target, material: this.#material },
    ]).then(() => {
      if (!this.#disposed) this.#ready = true
    })
    return this.#warm
  }

  override updateBefore({ renderer }: NodeFrame): undefined {
    if (renderer === null || !this.active || !this.ready) return
    this.#submissions++
    this.#stableSubmissions++
    const size = renderer.getDrawingBufferSize(this.#size)
    const width = Math.max(1, Math.ceil(size.x / GALAXY_RESOLUTION_DIVISOR))
    const height = Math.max(1, Math.ceil(size.y / GALAXY_RESOLUTION_DIVISOR))
    if (width !== this.#target.width || height !== this.#target.height) {
      // `setSize` replaces the texture, and whatever it held goes with it.
      this.#target.setSize(width, height)
      this.#dirty = true
    }
    const sampling = this.#stableSubmissions > GALAXY_SETTLE_SUBMISSIONS ? 2 : 1
    /*
     * The same pose, field and size draw the same texels, so a target drawn
     * at them already holds the frame, and drawing it again buys nothing at
     * the whole volume's price — every frame, for as long as the instrument
     * holds still. Measured headlessly on an Apple M5 at a 480×270 target:
     * 113–357 ms a draw across the face-on, edge-on and two interior points,
     * which at a stationary edge-on view is a GPU saturated at four frames a
     * second by a picture that is not changing.
     */
    if (!this.#dirty && (sampling === 1 || this.#drawnSampling === 2)) {
      this.#held = true
      return
    }
    this.#sampling.value = sampling
    const half = Math.tan(this.#fov / 2)
    this.#plane.value.set((half * size.x) / Math.max(1, size.y), half)
    const started = timer.on ? performance.now() : 0
    const previous = renderer.getRenderTarget(),
      mrt = renderer.getMRT()
    const tone = renderer.toneMapping,
      color = renderer.outputColorSpace,
      clear = renderer.autoClear
    try {
      renderer.setMRT(null)
      renderer.toneMapping = NoToneMapping
      renderer.outputColorSpace = ColorManagement.workingColorSpace
      renderer.autoClear = true
      renderer.setRenderTarget(this.#target)
      this.#quad.render(renderer)
      this.#draws++
      this.#drawnSampling = sampling
      this.#dirty = false
      this.#held = false
    } finally {
      renderer.setRenderTarget(previous)
      renderer.setMRT(mrt)
      renderer.toneMapping = tone
      renderer.outputColorSpace = color
      renderer.autoClear = clear
    }
    // The submission's own time, not the GPU's: the draw runs after this
    // returns. What the entry carries is that a draw happened, and at what
    // quality — which is the question the trace could not answer before.
    if (timer.on)
      timer.measure(
        'galaxy.draw',
        started,
        performance.now(),
        timingDetailed()
          ? {
              ...RENDER_PHASE,
              properties: [
                ['sampling', sampling === 2 ? 'settled' : 'observer'],
                ['target', `${width}×${height}`],
                ['draw', String(this.#draws)],
              ],
            }
          : RENDER_PHASE,
      )
  }

  override dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#target.dispose()
    this.#material.dispose()
    super.dispose()
  }
}

/** Scene geometry masks the background integral at full-resolution MSAA depth. */
export function createGalaxyBackdrop(
  volume: GalaxyVolumeNode,
): Mesh<PlaneGeometry, MeshBasicNodeMaterial> {
  const material = sensorRadiance(new MeshBasicNodeMaterial(), true)
  material.name = 'Galaxy backdrop'
  material.vertexNode = vec4(positionGeometry.xy, 1, 1)
  material.depthNode = float(1)
  material.depthWrite = false
  material.fog = false
  material.colorNode = nodeObject(volume).rgb.mul(
    (RADIANCE_UNIT * 1e-9 * GALAXY_LUMINOUS_EFFICACY) / SURFACE_LUMINANCE,
  )
  const mesh = new Mesh(new PlaneGeometry(2, 2), material)
  mesh.name = 'Galaxy backdrop'
  mesh.frustumCulled = false
  mesh.renderOrder = -1000
  mesh.visible = false
  return mesh
}
