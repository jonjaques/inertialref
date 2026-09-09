import {
  ColorManagement,
  HalfFloatType,
  LinearFilter,
  NodeMaterial,
  NoToneMapping,
  QuadMesh,
  RenderTarget,
  RGFormat,
  type Node,
  type WebGPURenderer,
} from 'three/webgpu'
import { float, texture, uv, vec3, vec4 } from 'three/tsl'
import { GALAXY_RADIUS_PARSECS } from '@inertialref/universe'
import { galaxyStructureAt, galaxyWarpHeight } from './galaxyKernel.ts'
import { warmSensorPass } from './warmup.ts'

/** The arm field is independent of observer, dust seed, exposure and output. */
export class GalaxyStructureTable {
  readonly #target: RenderTarget
  readonly #material = new NodeMaterial()
  readonly #quad = new QuadMesh(this.#material)
  readonly #map
  #ready = false
  #disposed = false
  #warm: Promise<void> | null = null

  readonly size: number

  constructor(size = 2048) {
    this.size = size
    this.#target = new RenderTarget(size, size, {
      type: HalfFloatType,
      format: RGFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    })
    this.#target.texture.name = 'Galaxy stellar and dust arms'
    this.#map = texture(this.#target.texture, uv())
    const plane = uv().mul(2).sub(1).mul(GALAXY_RADIUS_PARSECS)
    this.#material.fragmentNode = vec4(
      galaxyStructureAt(vec3(plane.x, 0, plane.y)).xy,
      0,
      1,
    )
    this.#material.name = 'Galaxy arm table'
  }

  sample(position: Node<'vec3'>): Node<'vec3'> {
    return vec3(
      this.#map
        .sample(position.xz.div(2 * GALAXY_RADIUS_PARSECS).add(0.5))
        .level(float(0)).rg,
      galaxyWarpHeight(position),
    )
  }

  get ready(): boolean {
    return this.#ready && !this.#disposed
  }
  get bytes(): number {
    return this.#disposed ? 0 : this.size * this.size * 4
  }

  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#warm ??= warmSensorPass(renderer, this.#quad, [
      { target: this.#target, material: this.#material },
    ]).then(() => {
      if (this.#disposed) return
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
        this.#ready = true
      } finally {
        renderer.setRenderTarget(previous)
        renderer.setMRT(mrt)
        renderer.toneMapping = tone
        renderer.outputColorSpace = color
        renderer.autoClear = clear
      }
    })
    return this.#warm
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#target.dispose()
    this.#material.dispose()
  }
}

const sharedTables = new WeakMap<
  WebGPURenderer,
  { table: GalaxyStructureTable; users: number }
>()

/** A renderer's star transport and diffuse field share one immutable arm table. */
export function acquireGalaxyStructure(renderer: WebGPURenderer): {
  readonly table: GalaxyStructureTable
  release(): void
} {
  let held = sharedTables.get(renderer)
  if (held === undefined) {
    held = { table: new GalaxyStructureTable(), users: 0 }
    sharedTables.set(renderer, held)
  }
  held.users++
  const lease = held
  let released = false
  return {
    table: lease.table,
    release() {
      if (released) return
      released = true
      if (--lease.users === 0) {
        lease.table.dispose()
        sharedTables.delete(renderer)
      }
    },
  }
}
