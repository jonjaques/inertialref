import {
  ColorManagement,
  CubeRenderTarget,
  HalfFloatType,
  LinearFilter,
  NodeMaterial,
  NoToneMapping,
  QuadMesh,
  Vector3,
  WebGPUCoordinateSystem,
  type Node,
  type Renderer,
  type WebGPURenderer,
} from 'three/webgpu'
import { cubeTexture, uniform, uv, vec3, vec4 } from 'three/tsl'
import { PARSEC } from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import type { GalaxyField } from '@inertialref/universe'
import {
  createGalaxyKernel,
  GALAXY_MAX_STEP_PARSECS,
  type GalaxyKernelOptions,
} from './galaxyKernel.ts'
import {
  GALAXY_CACHE_RADIUS_PARSECS,
  GALAXY_CACHE_SLOTS,
  GalaxyCacheSchedule,
  type GalaxyCacheOptions,
} from './galaxyCache.ts'
import { trackAtMount, warmSensorPass, type WarmTicket } from './warmup.ts'

/** Linear RGB, nW m^-2 sr^-1 per stored unit. Green retains Johnson V radiance. */
export const GALAXY_RADIANCE_UNIT = 1000

/** The native cube face axes; texture V increases down a WebGPU attachment. */
const FACES = [
  [
    [1, 0, 0],
    [0, 0, -1],
    [0, -1, 0],
  ],
  [
    [-1, 0, 0],
    [0, 0, 1],
    [0, -1, 0],
  ],
  [
    [0, 1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ],
  [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, -1],
  ],
  [
    [0, 0, 1],
    [1, 0, 0],
    [0, -1, 0],
  ],
  [
    [0, 0, -1],
    [-1, 0, 0],
    [0, -1, 0],
  ],
] as const

/**
 * One bounded tile per request. All targets belong to this renderer and keep
 * their allocation through a canceled bake. Sampling only sees a completed
 * cube, and replacing the renderer retires every target and pending request.
 */
export class GalaxySkyCache {
  readonly schedule: GalaxyCacheSchedule
  readonly #targets: CubeRenderTarget[]
  readonly #material = new NodeMaterial()
  readonly #quad = new QuadMesh(this.#material)
  readonly #origin = uniform(new Vector3())
  readonly #forward = uniform(new Vector3(1, 0, 0))
  readonly #right = uniform(new Vector3(0, 0, -1))
  readonly #down = uniform(new Vector3(0, -1, 0))
  readonly #flip = uniform(1)
  readonly #map
  readonly #kernel: ReturnType<typeof createGalaxyKernel>
  readonly #pixelAngle = uniform(1)
  readonly #tilesPerSubmission: number
  #field: GalaxyField
  #disposed = false
  #ready = false
  #warm: Promise<void> | null = null
  #tracked = false
  #ticket: WarmTicket | null = null

  constructor(
    field: GalaxyField,
    options: GalaxyCacheOptions = {},
    kernelOptions: GalaxyKernelOptions = {},
  ) {
    this.schedule = new GalaxyCacheSchedule({
      ...options,
      initialFaceSize:
        options.initialFaceSize ?? Math.min(32, options.faceSize ?? 128),
    })
    this.#tilesPerSubmission = Math.max(
      1,
      Math.min(8, Math.floor(options.tilesPerSubmission ?? 1)),
    )
    this.#field = field
    this.#kernel = createGalaxyKernel(field, kernelOptions)
    this.#pixelAngle.value = Math.PI / 2 / this.schedule.faceSize
    this.#targets = Array.from({ length: GALAXY_CACHE_SLOTS }, (_, slot) =>
      skyTarget(this.schedule.initialFaceSize, slot),
    )
    this.#map = cubeTexture(this.#targets[0]!.texture)
    const screen = uv().mul(2).sub(1)
    const direction = this.#forward
      .add(this.#right.mul(screen.x))
      .add(this.#down.mul(screen.y))
    this.#material.fragmentNode = vec4(
      this.#kernel
        .integrate(
          this.#origin,
          direction,
          100000,
          'settled',
          GALAXY_MAX_STEP_PARSECS,
          this.#pixelAngle,
        )
        .rgb.div(GALAXY_RADIANCE_UNIT),
      1,
    )
    this.#material.name = 'Galaxy cache tile'
  }

  /** Physical galactocentric direction, independent of the current camera. */
  sample(direction: Node<'vec3'>): Node<'vec4'> {
    // Three's cube node flips X for its CubeCamera convention on WebGPU.
    // These faces use native cube coordinates, so cancel that extra flip.
    return this.#map.sample(vec3(direction.x.mul(this.#flip), direction.yz))
  }

  configure(position: UniverseVector | null, field: GalaxyField): void {
    if (this.#disposed) return
    if (this.#field !== field) {
      this.#field = field
      this.#kernel.setField(field)
    }
    const cancellations =
      this.#ticket === null ? null : this.schedule.report.cancellations
    this.schedule.configure(position, field)
    if (
      cancellations !== null &&
      this.schedule.report.cancellations !== cancellations
    )
      this.#finishTicket()
    this.#select()
  }

  #select(): void {
    const selected = this.schedule.selected
    if (selected !== null)
      this.#map.value = this.#targets[selected.slot]!.texture
  }

  get pixelAngle(): number {
    return (
      Math.PI / 2 / (this.schedule.selected?.faceSize ?? this.schedule.faceSize)
    )
  }

  get revision(): number {
    return this.schedule.selected?.generation ?? 0
  }

  get available(): boolean {
    return this.#ready && !this.#disposed && this.schedule.selected !== null
  }

  get diagnostics() {
    return {
      ...this.schedule.report,
      radiusParsecs: GALAXY_CACHE_RADIUS_PARSECS,
      bytes: this.#disposed
        ? 0
        : this.#targets.reduce(
            (sum, target) => sum + 6 * target.width * target.height * 8,
            0,
          ),
      units: 'RGB nW m^-2 sr^-1 / 1000' as const,
    }
  }

  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#flip.value =
      renderer.coordinateSystem === WebGPUCoordinateSystem ? -1 : 1
    this.#warm ??= warmSensorPass(renderer, this.#quad, [
      { target: this.#targets[0]!, material: this.#material },
    ]).then(() => {
      if (!this.#disposed) this.#ready = true
    })
    return this.#warm
  }

  /** Each submission has a fixed dispatch ceiling, independent of unfinished work. */
  advance(renderer: Renderer): boolean {
    let drawn = false
    for (let i = 0; i < this.#tilesPerSubmission; i++) {
      if (!this.#advanceTile(renderer)) break
      drawn = true
    }
    return drawn
  }

  #advanceTile(renderer: Renderer): boolean {
    if (!this.#ready || this.#disposed) return false
    const tile = this.schedule.next()
    if (tile === null) return false
    if (!this.#tracked) {
      this.#tracked = true
      this.#ticket = trackAtMount(
        'baking the nearby sky',
        this.schedule.totalTiles,
      )
    }
    const p = UV.approxMeters(tile.position)
    this.#origin.value.set(p.x / PARSEC, p.y / PARSEC, p.z / PARSEC)
    const [forward, right, down] = FACES[tile.face]!
    this.#forward.value.set(forward[0], forward[1], forward[2])
    this.#right.value.set(right[0], right[1], right[2])
    this.#down.value.set(down[0], down[1], down[2])
    let target = this.#targets[tile.slot]!
    if (target.width !== tile.faceSize) {
      // CubeRenderTarget inherits a resize that updates image.width, while
      // its six images keep their old extent. Replace this free slot instead.
      const previous = target
      target = skyTarget(tile.faceSize, tile.slot)
      this.#targets[tile.slot] = target
      if (this.#map.value === previous.texture) this.#map.value = target.texture
      previous.dispose()
    }
    this.#pixelAngle.value = Math.PI / 2 / tile.faceSize
    const previous = renderer.getRenderTarget()
    const face = renderer.getActiveCubeFace()
    const mip = renderer.getActiveMipmapLevel()
    const mrt = renderer.getMRT()
    const tone = renderer.toneMapping
    const color = renderer.outputColorSpace
    const clear = renderer.autoClear
    const scissorTest = renderer.getScissorTest()
    target.scissor.set(tile.x, tile.y, tile.width, tile.height)
    target.scissorTest = true
    try {
      renderer.setMRT(null)
      renderer.toneMapping = NoToneMapping
      renderer.outputColorSpace = ColorManagement.workingColorSpace
      // Each tile replaces every texel it covers. Clearing the attachment
      // would erase all preceding tiles, since GPU load clears ignore scissor.
      renderer.autoClear = false
      // r185 reads the scissor rectangle from the target, but its enable
      // flag from the renderer. Setting only target.scissorTest draws a full
      // face for every tile; the coverage test observes that outside texel.
      renderer.setScissorTest(true)
      renderer.setRenderTarget(target, tile.face)
      this.#quad.render(renderer)
      this.schedule.complete(tile)
      this.#ticket?.done()
      this.#select()
      if (this.available && !this.schedule.report.pending) this.#finishTicket()
    } finally {
      target.scissorTest = false
      renderer.setRenderTarget(previous, face, mip)
      renderer.setMRT(mrt)
      renderer.toneMapping = tone
      renderer.outputColorSpace = color
      renderer.autoClear = clear
      renderer.setScissorTest(scissorTest)
    }
    return true
  }

  #finishTicket(): void {
    this.#ticket?.finish()
    this.#ticket = null
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#finishTicket()
    this.schedule.dispose()
    for (const target of this.#targets) target.dispose()
    this.#material.dispose()
  }
}

function skyTarget(size: number, slot: number): CubeRenderTarget {
  const target = new CubeRenderTarget(size, {
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
  })
  target.texture.name = `Galaxy physical sky ${slot}`
  return target
}
