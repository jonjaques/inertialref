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
  vec3,
} from 'three/tsl'
import { getTimer, invariant, PARSEC } from '@inertialref/shared'
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
  type ResolvedPopulationSelection,
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
import { composeSky } from './enhancedSky.ts'
import { warmSensorPass } from './warmup.ts'
import { GalaxySkyCache, GALAXY_RADIANCE_UNIT } from './galaxySkyCache.ts'
import type { GalaxySkyStore } from './galaxySkyArchive.ts'
import type { GalaxyCacheOptions } from './galaxyCache.ts'
import { GalaxyStructureTable } from './galaxyStructure.ts'
import {
  GalaxyTemporalVolume,
  type GalaxyTemporalOptions,
} from './galaxyTemporal.ts'

export const GALAXY_RESOLUTION_DIVISOR = 4
export const GALAXY_SETTLE_SUBMISSIONS = 8
/** Sub-parsec drift must not hold an otherwise stationary instrument at travel quality. */
export const GALAXY_SAMPLING_MOTION_PARSECS = 0.01
const SAMPLING_ANGLE = 1e-4
/** A half-float texel holds thousands of nW m^-2 sr^-1, preserving both halo and bulge. */
const RADIANCE_UNIT = GALAXY_RADIANCE_UNIT
/** A cold or translated camera cannot submit an unbounded viewport march. */
const COLD_LONG_EDGE = 64

export interface GalaxyVolumeOptions {
  /** Diagnostic plates may request the live volume by omitting this. */
  readonly cache?: GalaxyCacheOptions
  readonly archive?: GalaxySkyStore
  readonly temporal?: GalaxyTemporalOptions
  readonly resolutionDivisor?: 2 | 4
  /** Bound physical history and live rays without resizing the scene or stars. */
  readonly maxLongEdge?: number
  readonly structure?: boolean | GalaxyStructureTable
}

/** Each draw is an entry on the Render track, so a trace says when the volume drew and at what quality. */
const timer = getTimer('game.render')

/**
 * Physical radiance projected into an owned viewport target. Ordinary flight
 * samples a progressive cube cache; a cold or translated view uses a bounded
 * live march until a complete cube is valid. Diagnostic plates can request
 * the live path at quarter resolution. An unchanged projection holds its
 * target, independent of exposure, response and output gamut.
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
  readonly #cachedMaterial = new NodeMaterial()
  readonly #cache: GalaxySkyCache | null
  readonly #structure: GalaxyStructureTable | null
  readonly #ownsStructure: boolean
  readonly #temporal: GalaxyTemporalVolume | null
  readonly #resolutionDivisor: number
  readonly #maxLongEdge: number
  readonly #temporalMaterial = new NodeMaterial()
  #samplingDraws = 0
  #liveDraws = 0
  #usedCache = false
  #cacheRevision = 0
  readonly #size = new Vector2()
  readonly #origin = uniform(new Vector3())
  readonly #right = uniform(new Vector3(1, 0, 0))
  readonly #up = uniform(new Vector3(0, 1, 0))
  readonly #forward = uniform(new Vector3(0, 0, -1))
  readonly #plane = uniform(new Vector2(1, 1))
  readonly #sampling = uniform(1, 'uint')
  /** The angle one target texel subtends, so the kernel filters dust to what the texel can show. */
  readonly #pixelAngle = uniform(0)
  readonly #kernel: ReturnType<typeof createGalaxyKernel>
  readonly outputTexture = passTexture(
    this as unknown as PassNode,
    this.#target.texture,
  )
  #pose: ObserverPose | null = null
  #lens: Lens | null = null
  #field: GalaxyField
  #resolved: ResolvedPopulationSelection | undefined
  #physicalVersion = {}
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

  constructor(field: GalaxyField, options: GalaxyVolumeOptions = {}) {
    super('vec4')
    this.#resolutionDivisor =
      options.resolutionDivisor ?? GALAXY_RESOLUTION_DIVISOR
    invariant(
      options.maxLongEdge === undefined ||
        (Number.isSafeInteger(options.maxLongEdge) && options.maxLongEdge > 0),
      'Galaxy target maximum edge must be a positive integer',
    )
    this.#maxLongEdge = options.maxLongEdge ?? Infinity
    this.#field = field
    this.#ownsStructure = options.structure === true
    this.#structure =
      options.structure instanceof GalaxyStructureTable
        ? options.structure
        : options.structure
          ? new GalaxyStructureTable()
          : null
    const kernelOptions =
      this.#structure === null
        ? {}
        : { structure: (p: Node<'vec3'>) => this.#structure!.sample(p) }
    this.#kernel = createGalaxyKernel(field, {
      ...kernelOptions,
      radianceDepth: options.temporal !== undefined,
    })
    this.#temporal =
      options.temporal === undefined
        ? null
        : new GalaxyTemporalVolume((origin, direction, angle) => {
            const value = this.#kernel.integrate(
              origin,
              direction,
              100000,
              this.#sampling,
              GALAXY_MAX_STEP_PARSECS,
              angle,
            )
            return vec4(value.rgb.div(RADIANCE_UNIT), value.a)
          }, options.temporal)
    this.#temporalMaterial.fragmentNode = this.#temporal?.sample() ?? vec4(0)
    this.#temporalMaterial.name = 'Galaxy temporal sampling'
    this.#cache =
      options.cache === undefined
        ? null
        : new GalaxySkyCache(
            field,
            options.cache,
            kernelOptions,
            options.archive,
          )
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
        .integrate(
          this.#origin,
          direction,
          100000,
          this.#sampling,
          GALAXY_MAX_STEP_PARSECS,
          this.#pixelAngle,
        )
        .rgb.div(RADIANCE_UNIT),
      1,
    )
    this.#material.name = 'Galaxy integral'
    this.#cachedMaterial.fragmentNode =
      this.#cache?.sample(direction) ?? vec4(0)
    this.#cachedMaterial.name = 'Galaxy cache sampling'
  }

  override setup(): Node {
    return this.outputTexture
  }

  configure(
    pose: ObserverPose | null,
    lens: Lens,
    field = this.#field,
    resolved?: ResolvedPopulationSelection,
  ): void {
    if (field !== this.#field || resolved !== this.#resolved) {
      this.#resolved = resolved
      this.#physicalVersion = {}
      this.#kernel.setResolved(resolved)
      this.#stableSubmissions = 0
      this.#dirty = true
    }
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
    // A cube spends most of its rays on empty space from outside the disk.
    // The temporal viewport retains those views at the requested pixel density.
    const cubePosition =
      pose !== null &&
      (this.#temporal === null ||
        (Math.abs(UV.approxMeters(pose.position).y / PARSEC) < 1000 &&
          Math.hypot(
            UV.approxMeters(pose.position).x / PARSEC,
            UV.approxMeters(pose.position).z / PARSEC,
          ) < 30000))
        ? pose.position
        : null
    this.#cache?.configure(cubePosition, field, resolved)
    this.#temporal?.configure(pose, lens, this.#physicalVersion)
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
        : this.#target.width * this.#target.height * 8 +
          (this.#cache?.diagnostics.bytes ?? 0) +
          (this.#structure?.bytes ?? 0) +
          (this.#temporal?.report.bytes ?? 0),
      ...(this.#temporal === null ? {} : { temporal: this.#temporal.report }),
      ...(this.#cache === null
        ? {}
        : {
            cache: {
              ...this.#cache.diagnostics,
              samplingDraws: this.#samplingDraws,
              liveDraws: this.#liveDraws,
              using: this.#usedCache,
            },
          }),
      resolutionDivisor: this.#resolutionDivisor,
      maxStepParsecs: GALAXY_MAX_STEP_PARSECS,
      dustStepParsecs:
        this.#sampling.value === 2 ? GALAXY_DUST_SETTLED_STEP_PARSECS : null,
      settled: this.#sampling.value === 2,
      maxSteps: GALAXY_MAX_STEPS,
      submissions: this.#submissions,
      draws: this.#draws,
      held: this.#held,
      pixelAngle: this.#pixelAngle.value,
      emissionOnly: this.#field.dustScale === 0,
      dustScale: this.#field.dustScale,
      dustNormalization: this.#field.dustNormalization,
      resolvedStarExtinction: false,
      originParsecs: this.#origin.value.toArray(),
    }
  }

  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#resizeTarget(
      renderer.getDrawingBufferSize(this.#size),
      this.#cache?.available ?? false,
    )
    this.#warm ??= Promise.all([
      warmSensorPass(renderer, this.#quad, [
        { target: this.#target, material: this.#material },
        ...(this.#cache === null
          ? []
          : [{ target: this.#target, material: this.#cachedMaterial }]),
        ...(this.#temporal === null
          ? []
          : [{ target: this.#target, material: this.#temporalMaterial }]),
      ]),
      this.#cache?.warm(renderer),
      this.#structure?.warm(renderer),
      this.#temporal?.warm(renderer),
    ]).then(() => {
      if (!this.#disposed) this.#ready = true
    })
    return this.#warm
  }

  /** Warming, cache transitions and viewport resizes share one pixel budget. */
  #resizeTarget(size: Vector2, cached: boolean): void {
    const maximum =
      this.#cache !== null && !cached && this.#temporal === null
        ? Math.min(this.#maxLongEdge, COLD_LONG_EDGE)
        : this.#maxLongEdge
    const divisor = Math.max(
      this.#resolutionDivisor,
      Math.max(size.x, size.y) / maximum,
    )
    // Clamp after ceil as well: floating division must not grow the longest
    // edge one texel beyond its budget. The other edge keeps the same scale.
    const width = Math.max(1, Math.min(maximum, Math.ceil(size.x / divisor)))
    const height = Math.max(1, Math.min(maximum, Math.ceil(size.y / divisor)))
    if (width !== this.#target.width || height !== this.#target.height) {
      this.#target.setSize(width, height)
      this.#dirty = true
    }
  }

  override updateBefore({ renderer }: NodeFrame): undefined {
    if (renderer === null || !this.active || !this.ready) return
    this.#submissions++
    this.#stableSubmissions++
    const size = renderer.getDrawingBufferSize(this.#size)
    if (
      this.#cache !== null &&
      (this.#temporal === null ||
        this.#stableSubmissions > GALAXY_SETTLE_SUBMISSIONS)
    ) {
      const before = this.#cache.diagnostics.tiles
      this.#cache.advance(renderer)
      this.#draws += this.#cache.diagnostics.tiles - before
    }
    const cached = this.#cache?.available ?? false
    const revision = this.#cache?.revision ?? 0
    if (cached !== this.#usedCache || revision !== this.#cacheRevision)
      this.#dirty = true
    this.#cacheRevision = revision
    this.#usedCache = cached
    this.#resizeTarget(size, cached)
    const { width, height } = this.#target
    const sampling =
      cached || this.#stableSubmissions > GALAXY_SETTLE_SUBMISSIONS ? 2 : 1
    /*
     * The same pose, field and size draw the same texels, so a target drawn
     * at them already holds the frame, and drawing it again buys nothing at
     * the whole volume's price — every frame, for as long as the instrument
     * holds still. Measured headlessly on an Apple M5 at a 480×270 target:
     * 113–357 ms a draw across the face-on, edge-on and two interior points,
     * which at a stationary edge-on view is a GPU saturated at four frames a
     * second by a picture that is not changing.
     */
    const refining =
      !cached &&
      this.#temporal !== null &&
      this.#stableSubmissions <=
        GALAXY_SETTLE_SUBMISSIONS + this.#temporal.stride ** 2
    if (
      !this.#dirty &&
      !refining &&
      (sampling === 1 || this.#drawnSampling === 2)
    ) {
      this.#held = true
      return
    }
    this.#sampling.value = sampling
    const half = Math.tan(this.#fov / 2)
    this.#plane.value.set((half * size.x) / Math.max(1, size.y), half)
    this.#pixelAngle.value = cached
      ? this.#cache!.pixelAngle
      : this.#fov / height
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
      if (!cached && this.#temporal !== null) {
        this.#temporal.render(renderer as WebGPURenderer, width, height)
        this.#draws += 2
      }
      renderer.setRenderTarget(this.#target)
      this.#quad.material = cached
        ? this.#cachedMaterial
        : this.#temporal === null
          ? this.#material
          : this.#temporalMaterial
      this.#quad.render(renderer)
      if (cached) this.#samplingDraws++
      else this.#liveDraws++
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
    this.#cachedMaterial.dispose()
    this.#cache?.dispose()
    this.#temporal?.dispose()
    if (this.#ownsStructure) this.#structure?.dispose()
    this.#temporalMaterial.dispose()
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
  const rgb = nodeObject(volume).rgb
  const luminance = rgb.dot(vec3(0.2126, 0.7152, 0.0722))
  material.colorNode = composeSky(
    rgb
      .mul(rgb.g.div(luminance.max(1e-30)))
      .mul(
        (RADIANCE_UNIT * 1e-9 * GALAXY_LUMINOUS_EFFICACY) / SURFACE_LUMINANCE,
      ),
  )
  const mesh = new Mesh(new PlaneGeometry(2, 2), material)
  mesh.name = 'Galaxy backdrop'
  mesh.frustumCulled = false
  mesh.renderOrder = -1000
  mesh.visible = false
  return mesh
}
