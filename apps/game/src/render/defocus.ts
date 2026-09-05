import { warmSensorPass, type WarmPass } from './warmup.ts'
import { GLASS_PRESETS, type Glass } from '@inertialref/rendering'
import {
  HalfFloatType,
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
  max,
  mix,
  passTexture,
  texture,
  uniform,
  uv,
  vec2,
  vec4,
} from 'three/tsl'

/** A deterministic equal-area iris sample; the outer ring describes the blades. */
export function irisPattern(
  glass: Glass,
): readonly (readonly [number, number])[] {
  return Array.from({ length: 48 }, (_, i) => {
    const angle = i * Math.PI * (3 - Math.sqrt(5)) + glass.bladeAngle
    const sector = (2 * Math.PI) / glass.blades
    const polygon =
      Math.cos(Math.PI / glass.blades) /
      Math.cos(
        ((((angle - glass.bladeAngle) % sector) + sector) % sector) -
          sector / 2,
      )
    const radius = Math.sqrt((i + 0.5) / 48) * polygon
    return [Math.cos(angle) * radius, Math.sin(angle) * radius] as const
  })
}

/** Half-resolution near/far layers, with foreground coverage gathered outward. */
export class DefocusNode extends TempNode<'vec4'> {
  static get type() {
    return 'DefocusNode'
  }
  readonly parameters = uniform(new Vector2(0, 0))
  readonly maximum = uniform(0)
  readonly enabled = uniform(0)
  readonly openness = uniform(0)
  readonly pixelStep = uniform(new Vector2(1, 1))
  readonly #stages: readonly WarmPass[] = Array.from({ length: 4 }, () => ({
    target: new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false }),
    material: new NodeMaterial(),
  }))
  #disposed = false
  readonly #quad = new QuadMesh()
  readonly #size = new Vector2()
  readonly outputTexture = passTexture(
    this as unknown as PassNode,
    this.#stages[3]!.target.texture,
  )
  readonly inputNode: TextureNode
  readonly motionNode: TextureNode
  passes = 0

  constructor(input: TextureNode, motion: TextureNode) {
    super('vec4')
    this.inputNode = input
    this.motionNode = motion
    this.updateBeforeType = NodeUpdateType.RENDER
  }

  override setup(builder: NodeBuilder): Node {
    const context = (
      builder as NodeBuilder & { getSharedContext(): typeof builder.context }
    ).getSharedContext()
    const circle = this.parameters.x
      .mul(this.parameters.y.sub(this.motionNode.sample(uv()).z))
      .clamp(-40, 40)
    // Bounded at the half-float maximum for the reason `psf.ts` gives: the
    // gather multiplies by a coverage that can be zero, and Inf × 0 is NaN.
    this.#stages[0]!.material.fragmentNode = vec4(
      this.inputNode.sample(uv()).rgb.min(65_504),
      circle,
    ).context(context)
    const source = texture(this.#stages[0]!.target.texture)
    const pattern = irisPattern(GLASS_PRESETS.flight)
    for (const near of [false, true]) {
      const gather = Fn(() => {
        const center = source.sample(uv())
        const radius = near ? this.maximum.mul(0.5) : center.a.max(0).mul(0.5)
        const sum = vec4(0).toVar()
        for (const [index, [x, y]] of pattern.entries()) {
          const circularRadius = Math.sqrt((index + 0.5) / pattern.length)
          const length = Math.hypot(x, y)
          const offset = mix(
            vec2(x, y),
            vec2((x / length) * circularRadius, (y / length) * circularRadius),
            this.openness,
          )
          const sample = source.sample(
            uv().add(offset.mul(radius).mul(this.pixelStep)),
          )
          const reach = near ? sample.a.negate() : sample.a
          // Circle coverage is premultiplied into the color. A sharp near
          // surface contributes nothing to the soft far layer behind it.
          const coverage = reach
            .mul(0.5)
            .sub(radius.mul(offset.length()))
            .add(1)
            .clamp()
            .mul(reach.sub(0.5).clamp())
          sum.addAssign(vec4(sample.rgb.mul(coverage), coverage))
        }
        return sum.div(pattern.length)
      })()
      this.#stages[near ? 2 : 1]!.material.fragmentNode =
        gather.context(context)
    }
    const near = texture(this.#stages[2]!.target.texture)
    const far = texture(this.#stages[1]!.target.texture)
    const sharp = texture(this.inputNode.value)
    const coc = this.parameters.x.mul(
      this.parameters.y.sub(texture(this.motionNode.value).z),
    )
    const farMix = coc.sub(0.5).clamp().mul(far.a.mul(48).clamp())
    const nearMix = coc.negate().sub(0.5).clamp()
    const base = mix(
      sharp.rgb.min(65_504),
      far.rgb.div(max(far.a, float(1e-6))),
      farMix,
    )
    // A wider circle elsewhere in frame reduces the gather's coverage, not
    // this surface's radiance. Normalize inside it; use coverage at its edge.
    const nearOpacity = max(near.a, nearMix).mul(
      near.a.greaterThan(0).select(1, 0),
    )
    const color = mix(base, near.rgb.div(max(near.a, float(1e-6))), nearOpacity)
    this.#stages[3]!.material.fragmentNode = vec4(color, 1).context(context)
    this.#stages.forEach(({ material }, i) => {
      material.name = `Sensor Defocus ${i}`
    })
    // Keeping the bypass in the graph avoids any pipeline rebuild as focus
    // changes. A measured sharp frame submits no defocus draws at all.
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
    this.outputTexture.value =
      this.enabled.value < 0.5
        ? this.inputNode.value
        : this.#stages[3]!.target.texture
    if (renderer === null || this.enabled.value < 0.5) return
    const previous = renderer.getRenderTarget()
    const size = renderer.getDrawingBufferSize(this.#size)
    this.pixelStep.value.set(1 / size.x, 1 / size.y)
    try {
      for (let i = 0; i < 4; i += 1) {
        const target = this.#stages[i]!.target
        target.setSize(
          i === 3 ? size.x : Math.max(1, Math.ceil(size.x / 2)),
          i === 3 ? size.y : Math.max(1, Math.ceil(size.y / 2)),
        )
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
