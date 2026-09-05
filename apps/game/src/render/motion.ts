import { warmSensorPass, type WarmPass } from './warmup.ts'
import {
  HalfFloatType,
  NearestFilter,
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  RenderTarget,
  TempNode,
  Vector2,
  type WebGPURenderer,
  type Node,
  type NodeBuilder,
  type NodeFrame,
  type PassNode,
  type TextureNode,
} from 'three/webgpu'
import {
  float,
  Fn,
  If,
  int,
  ivec2,
  Loop,
  passTexture,
  texture,
  textureLoad,
  uniform,
  uv,
  vec2,
  vec4,
} from 'three/tsl'

const TILE = 20

/** Tile-max / neighbor-max motion, bounded by one tile and ordered by depth. */
export class MotionNode extends TempNode<'vec4'> {
  static get type() {
    return 'MotionNode'
  }
  readonly fraction = uniform(0)
  readonly dimensions = uniform(new Vector2(1, 1))
  readonly tileStep = uniform(new Vector2(1, 1))
  readonly #stages: readonly WarmPass[] = Array.from({ length: 3 }, () => ({
    target: new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false }),
    material: new NodeMaterial(),
  }))
  #disposed = false
  readonly #quad = new QuadMesh()
  readonly #size = new Vector2()
  readonly outputTexture = passTexture(
    this as unknown as PassNode,
    this.#stages[2]!.target.texture,
  )
  readonly sourceNode: TextureNode
  readonly inputNode: TextureNode
  readonly motionNode: TextureNode
  passes = 0

  constructor(input: TextureNode, motion: TextureNode) {
    super('vec4')
    this.sourceNode = input
    this.inputNode = texture(input.value)
    this.motionNode = texture(motion.value)
    this.updateBeforeType = NodeUpdateType.RENDER
    // A tile maximum is a per-tile fact. Fetched linearly between two tile
    // centres whose velocities oppose, it averages toward zero and the blur
    // cuts off in a band along the tile edge that moves with the tiling.
    for (const { target } of this.#stages.slice(0, 2)) {
      target.texture.minFilter = NearestFilter
      target.texture.magFilter = NearestFilter
    }
  }

  override setup(builder: NodeBuilder): Node {
    const context = (
      builder as NodeBuilder & { getSharedContext(): typeof builder.context }
    ).getSharedContext()
    const pixelVelocity = (v: Node<'vec2'>) => {
      const pixels = v
        .mul(this.dimensions)
        .mul(vec2(0.5, -0.5))
        .mul(this.fraction)
      return pixels.mul(float(TILE).div(pixels.length().max(TILE)))
    }
    this.#stages[0]!.material.fragmentNode = Fn(() => {
      const start = ivec2(uv().div(this.tileStep).floor()).mul(int(TILE))
      const strongest = vec4(0).toVar()
      Loop(TILE * TILE, ({ i }) => {
        const p = start.add(ivec2(i.mod(TILE), i.div(TILE)))
        If(
          p.x
            .lessThan(int(this.dimensions.x))
            .and(p.y.lessThan(int(this.dimensions.y))),
          () => {
            const data = textureLoad(this.motionNode, p)
            const v = pixelVelocity(data.xy)
            If(v.dot(v).greaterThan(strongest.xy.dot(strongest.xy)), () => {
              strongest.assign(vec4(v, data.z, 1))
            })
          },
        )
      })
      return strongest
    })().context(context)
    const tiles = texture(this.#stages[0]!.target.texture)
    this.#stages[1]!.material.fragmentNode = Fn(() => {
      const strongest = vec4(0).toVar()
      for (let y = -1; y <= 1; y += 1)
        for (let x = -1; x <= 1; x += 1) {
          const data = tiles.sample(uv().add(vec2(x, y).mul(this.tileStep)))
          If(
            data.xy.dot(data.xy).greaterThan(strongest.xy.dot(strongest.xy)),
            () => {
              strongest.assign(data)
            },
          )
        }
      return strongest
    })().context(context)
    const neighbors = texture(this.#stages[1]!.target.texture)
    this.#stages[2]!.material.fragmentNode = Fn(() => {
      const center = this.motionNode.sample(uv())
      const velocity = neighbors.sample(uv()).xy
      // Bounded at the half-float maximum for the reason `psf.ts` gives.
      const color = vec4(this.inputNode.sample(uv()).rgb.min(65_504), 1).toVar()
      const centerReach = pixelVelocity(center.xy).length()
      for (let i = 0; i < 12; i += 1) {
        const t = (i + 0.5) / 12 - 0.5
        const sampleUv = uv().add(velocity.mul(t).div(this.dimensions))
        const data = this.motionNode.sample(sampleUv)
        const distance = velocity.length().mul(Math.abs(t))
        const reach = data.z
          .greaterThanEqual(center.z.mul(0.99))
          .select(pixelVelocity(data.xy).length(), centerReach)
        const weight = reach.mul(0.5).sub(distance).add(1).clamp()
        color.addAssign(
          vec4(
            this.inputNode.sample(sampleUv).rgb.min(65_504).mul(weight),
            weight,
          ),
        )
      }
      return vec4(color.rgb.div(color.a), 1)
    })().context(context)
    this.#stages.forEach(({ material }, i) => {
      material.name = `Sensor Motion ${i}`
    })
    return this.outputTexture
  }

  warm(renderer: WebGPURenderer): Promise<void> {
    return this.#disposed
      ? Promise.resolve()
      : warmSensorPass(renderer, this.#quad, this.#stages)
  }

  override updateBefore({ renderer }: NodeFrame): undefined {
    if (this.#disposed) return
    this.passes = 0
    this.inputNode.value = this.sourceNode.value
    this.outputTexture.value =
      this.fraction.value > 0
        ? this.#stages[2]!.target.texture
        : this.sourceNode.value
    if (renderer === null || this.fraction.value <= 0) return
    const previous = renderer.getRenderTarget()
    const size = renderer.getDrawingBufferSize(this.#size)
    this.dimensions.value.copy(size)
    const width = Math.ceil(size.x / TILE)
    const height = Math.ceil(size.y / TILE)
    this.tileStep.value.set(1 / width, 1 / height)
    try {
      for (let i = 0; i < 3; i += 1) {
        const target = this.#stages[i]!.target
        target.setSize(i === 2 ? size.x : width, i === 2 ? size.y : height)
        renderer.setRenderTarget(target)
        this.#quad.material = this.#stages[i]!.material
        this.#quad.render(renderer)
        this.passes += 1
      }
    } finally {
      renderer.setRenderTarget(previous)
    }
  }

  override dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const { target, material } of this.#stages) {
      target.dispose()
      material.dispose()
    }
    super.dispose()
  }
}
