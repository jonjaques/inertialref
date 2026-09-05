import { psfWeights } from '@inertialref/rendering'
import {
  HalfFloatType,
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  RenderTarget,
  TempNode,
  Vector2,
  type Node,
  type PassNode,
  type NodeBuilder,
  type NodeFrame,
  type TextureNode,
} from 'three/webgpu'
import { passTexture, texture, uniform, uv, vec2, vec4 } from 'three/tsl'

const LEVELS = 6
const PASSES = LEVELS * 2
const TAPS = [
  [0, 0, 0.125],
  [-2, -2, 0.03125],
  [2, -2, 0.03125],
  [-2, 2, 0.03125],
  [2, 2, 0.03125],
  [-2, 0, 0.0625],
  [2, 0, 0.0625],
  [0, -2, 0.0625],
  [0, 2, 0.0625],
  [-1, -1, 0.125],
  [1, -1, 0.125],
  [-1, 1, 0.125],
  [1, 1, 0.125],
] as const

/** Threshold-free veiling glare: every octave receives an equal share of scattered energy. */
export class PsfNode extends TempNode<'vec4'> {
  static get type() {
    return 'PsfNode'
  }
  readonly scatter = uniform(0.015)
  readonly targets = Array.from(
    { length: PASSES - 1 },
    () => new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false }),
  )
  readonly result = new RenderTarget(1, 1, {
    type: HalfFloatType,
    depthBuffer: false,
  })
  readonly materials = Array.from({ length: PASSES }, () => new NodeMaterial())
  readonly steps = Array.from({ length: LEVELS }, () =>
    uniform(new Vector2(1, 1)),
  )
  readonly upSteps = Array.from({ length: LEVELS }, () =>
    uniform(new Vector2(1, 1)),
  )
  readonly quad = new QuadMesh()
  readonly size = new Vector2()
  readonly outputTexture = passTexture(
    this as unknown as PassNode,
    this.result.texture,
  )
  readonly inputNode: TextureNode
  readonly sourceNode: TextureNode
  readonly directNode: TextureNode

  constructor(input: TextureNode) {
    super('vec4')
    this.sourceNode = input
    this.inputNode = texture(input.value)
    this.directNode = texture(input.value)
    this.updateBeforeType = NodeUpdateType.RENDER
    this.targets.forEach((target, i) => {
      target.texture.name = `Sensor PSF ${i}`
    })
  }

  override setup(builder: NodeBuilder): Node {
    const context = (
      builder as NodeBuilder & { getSharedContext(): typeof builder.context }
    ).getSharedContext()
    for (let i = 0; i < LEVELS; i += 1) {
      const source =
        i === 0 ? this.inputNode : texture(this.targets[i - 1]!.texture)
      let filtered: Node<'vec4'> = vec4(0)
      for (const [x, y, weight] of TAPS) {
        const tap = source.sample(uv().add(this.steps[i]!.mul(vec2(x, y))))
        // Each draw is clamped to the half-float maximum, but the blend is
        // not: a clamped disk under a clamped sprite rounds to +Inf in the
        // target, and six octaves of positive weights turn that one texel
        // into a frame-sized non-finite halo. Bound the first read instead.
        filtered = filtered.add((i === 0 ? tap.min(65_504) : tap).mul(weight))
      }
      this.materials[i]!.fragmentNode = filtered.context(context)
      this.materials[i]!.name = `Sensor PSF Down ${i}`
    }
    // The scene dependency belongs to the first reduction. Reading its plain
    // texture here avoids asking PassNode for a second scene in this render.
    const direct = this.directNode.rgb.min(65_504).mul(this.scatter.oneMinus())
    const weights = psfWeights(LEVELS)
    const tent = (source: TextureNode, step: Node<'vec2'>): Node<'vec4'> => {
      let sum: Node<'vec4'> = vec4(0)
      for (let y = -1; y <= 1; y += 1)
        for (let x = -1; x <= 1; x += 1)
          sum = sum.add(
            source
              .sample(uv().add(vec2(x, y).mul(step)))
              .mul(((x === 0 ? 2 : 1) * (y === 0 ? 2 : 1)) / 16),
          )
      return sum
    }
    for (let i = LEVELS - 2; i >= 0; i -= 1) {
      const index = LEVELS + LEVELS - 2 - i
      const coarser = texture(
        this.targets[index === LEVELS ? LEVELS - 1 : index - 1]!.texture,
      )
      const weight = index === LEVELS ? weights[LEVELS - 1]! : 1
      this.materials[index]!.fragmentNode = texture(this.targets[i]!.texture)
        .mul(weights[i]!)
        .add(tent(coarser, this.upSteps[LEVELS - 2 - i]!).mul(weight))
        .context(context)
      this.materials[index]!.name = `Sensor PSF Up ${i}`
    }
    const halo = tent(
      texture(this.targets[PASSES - 2]!.texture),
      this.upSteps[LEVELS - 1]!,
    )
    const composite = this.materials[PASSES - 1]!
    composite.fragmentNode = vec4(
      direct.add(halo.rgb.mul(this.scatter)),
      1,
    ).context(context)
    composite.name = 'Sensor PSF Resolve'
    return this.outputTexture
  }

  override updateBefore({ renderer }: NodeFrame): undefined {
    if (renderer === null) return
    this.inputNode.value = this.sourceNode.value
    const previous = renderer.getRenderTarget()
    const autoClear = renderer.autoClear
    const size = renderer.getDrawingBufferSize(this.size)
    let width = size.x
    let height = size.y
    this.result.setSize(width, height)
    renderer.autoClear = true
    try {
      for (let i = 0; i < LEVELS; i += 1) {
        this.steps[i]!.value.set(1 / width, 1 / height)
        width = Math.max(1, Math.floor(width / 2))
        height = Math.max(1, Math.floor(height / 2))
        const target = this.targets[i]!
        target.setSize(width, height)
        renderer.setRenderTarget(target)
        this.quad.material = this.materials[i]!
        this.quad.render(renderer)
      }
      for (let i = LEVELS - 2; i >= 0; i -= 1) {
        const index = LEVELS + LEVELS - 2 - i
        const coarse = this.targets[index === LEVELS ? LEVELS - 1 : index - 1]!
        this.upSteps[LEVELS - 2 - i]!.value.set(
          1 / coarse.width,
          1 / coarse.height,
        )
        const target = this.targets[index]!
        target.setSize(this.targets[i]!.width, this.targets[i]!.height)
        renderer.setRenderTarget(target)
        this.quad.material = this.materials[index]!
        this.quad.render(renderer)
      }
      renderer.setRenderTarget(this.result)
      this.upSteps[LEVELS - 1]!.value.set(
        1 / this.targets[0]!.width,
        1 / this.targets[0]!.height,
      )
      this.directNode.value = this.inputNode.value
      this.quad.material = this.materials[PASSES - 1]!
      this.quad.render(renderer)
    } finally {
      renderer.autoClear = autoClear
      renderer.setRenderTarget(previous)
    }
  }

  override dispose(): void {
    for (const target of this.targets) target.dispose()
    this.result.dispose()
    for (const material of this.materials) material.dispose()
    super.dispose()
  }
}
