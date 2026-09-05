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
import { PARSEC } from '@inertialref/shared'
import { Quaternion as Q, UV } from '@inertialref/spatial'
import {
  GALAXY_LUMINOUS_EFFICACY,
  SURFACE_LUMINANCE,
  verticalFov,
  type Lens,
} from '@inertialref/rendering'
import { GALAXY_FIELD_VERSIONS, type GalaxyField } from '@inertialref/universe'
import type { GalaxyRenderReport, ObserverPose } from '@inertialref/devtools'
import {
  createGalaxyKernel,
  GALAXY_KERNEL_VERSION,
  GALAXY_MAX_STEPS,
} from './galaxyKernel.ts'
import { sensorRadiance } from './radiance.ts'
import { warmSensorPass } from './warmup.ts'

export const GALAXY_RESOLUTION_DIVISOR = 4
/** A half-float texel holds thousands of nW m^-2 sr^-1, preserving both halo and bulge. */
const RADIANCE_UNIT = 1000

/** One deterministic volume draw per scene submission; no history or borrowed targets. */
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
  readonly #kernel: ReturnType<typeof createGalaxyKernel>
  readonly outputTexture = passTexture(
    this as unknown as PassNode,
    this.#target.texture,
  )
  #field: GalaxyField
  #disposed = false
  #active = false
  #fov = 1
  #submissions = 0
  #warm: Promise<void> | null = null
  #ready = false

  constructor(field: GalaxyField) {
    super('vec4')
    this.#field = field
    this.#kernel = createGalaxyKernel(field)
    this.updateBeforeType = NodeUpdateType.RENDER
    this.#target.texture.name = 'Galaxy radiance'
    this.#target.texture.minFilter = LinearFilter
    this.#target.texture.magFilter = LinearFilter
    const screen = uv().mul(2).sub(1)
    const direction = this.#forward
      .add(this.#right.mul(screen.x.mul(this.#plane.x)))
      .sub(this.#up.mul(screen.y.mul(this.#plane.y)))
    this.#material.fragmentNode = vec4(
      this.#kernel.integrate(this.#origin, direction).rgb.div(RADIANCE_UNIT),
      1,
    )
    this.#material.name = 'Galaxy integral'
  }

  override setup(): Node {
    return this.outputTexture
  }

  configure(pose: ObserverPose | null, lens: Lens, field = this.#field): void {
    this.#active = pose !== null && !this.#disposed
    if (field !== this.#field) {
      this.#field = field
      this.#kernel.setField(field)
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
      maxStepParsecs: 100,
      maxSteps: GALAXY_MAX_STEPS,
      submissions: this.#submissions,
      emissionOnly: true,
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
    const size = renderer.getDrawingBufferSize(this.#size)
    const width = Math.max(1, Math.ceil(size.x / GALAXY_RESOLUTION_DIVISOR))
    const height = Math.max(1, Math.ceil(size.y / GALAXY_RESOLUTION_DIVISOR))
    this.#target.setSize(width, height)
    const half = Math.tan(this.#fov / 2)
    this.#plane.value.set((half * size.x) / Math.max(1, size.y), half)
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
      this.#submissions++
    } finally {
      renderer.setRenderTarget(previous)
      renderer.setMRT(mrt)
      renderer.toneMapping = tone
      renderer.outputColorSpace = color
      renderer.autoClear = clear
    }
  }

  override dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#target.dispose()
    this.#material.dispose()
    super.dispose()
  }
}

/** Fixed outside views treat scene geometry as foreground, with full-resolution MSAA depth. */
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
