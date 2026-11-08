import { invariant } from '@inertialref/shared'
import {
  DepthTexture,
  HalfFloatType,
  NodeMaterial,
  QuadMesh,
  RedFormat,
  RenderTarget,
  type Texture,
  type TextureNode,
  Vector2,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  float,
  ivec2,
  min,
  perspectiveDepthToViewZ,
  screenCoordinate,
  sqrt,
  texture,
  uniform,
  uvec2,
  vec2,
  vec4,
} from 'three/tsl'
import { traceScreen } from './cloudGeometry.ts'
import type { CloudResource } from './cloudNodes.ts'
import type { CloudUniforms } from './cloudUniforms.ts'
import { runQuadPasses } from './quadPass.ts'
import type { SceneLayout } from './sceneLayout.ts'
import { warmByDrawing } from './warmup.ts'

/*
 * The scene's distance for the clouds: view distance along each pixel's ray
 * in render meters ÷ 1000, R16F at render resolution, clamped at 60,000 km so
 * far depth reads as sky, drawn as `cloud depth` inside the frame node's run.
 * It reads this frame's depth, which both placements have put on the queue by
 * then: the split's first half, or pass A.
 *
 * **The source is the scene target's own depth, not a copy of it.** It is
 * read with `textureLoad` at sample 0, which a multisampled depth allows and
 * which keeps the copy texel for texel with the frame. Three declares the
 * binding by the sample count of the target the depth texture belongs to,
 * and a value swap does not rebuild the program, so the node waits on a
 * placeholder until `tie` hands it the scene's depth, and nothing compiles or
 * draws the copy before that: the program a warm-up builds is the frame's.
 *
 * **Rows run as the trace's do.** The texel is the fragment's own pixel,
 * row 0 at the top as WebGPU's framebuffer has it, and its image point is
 * `traceScreen`'s, so the copy and every reader of it agree on which way is
 * up without a quad's `v` in between.
 *
 * **The distance is along the ray.** Depth gives view z, and a pixel's ray is
 * `sec θ = √(1 + (x·plane.x)² + (y·plane.y)²)` longer: 15% at the edge of a
 * square 60° frame and 29% at its corners, against a trace that compares the
 * copy with distances along its rays. `plane` is the unjittered camera's; a
 * temporal jitter of under half a pixel moves the secant by at most a part in
 * 2W, under R16F's step once the render is a thousand pixels wide.
 *
 * **Precision.** R16F steps by 2⁻¹¹ to 2⁻¹⁰ of the value, and on the Metal
 * device the GPU suite runs on the store truncates rather than rounding: every
 * texel of a facing plane in `cloudDepth.gpu.test.ts` lands short, by up to
 * 0.99 of a step. So the copy can read a step near and never far, and every
 * comparison against it carries a relative tolerance of at least 2 × 10⁻³
 * (§5.11), twice the worst step. The 60,000 km clamp is exact.
 */

/** The pass's name on the timeline. */
export const CLOUD_DEPTH_LABEL = 'cloud depth'

/** km: past this the copy stores the clamp, and a reader takes it for sky. */
export const CLOUD_DEPTH_CLAMP_KM = 60_000

/** Bytes a texel of the copy holds: one half float. */
const TEXEL_BYTES = 2

const samplesOf = (samples: number): number => Math.max(1, samples)

export class CloudDepth implements CloudResource {
  readonly name = 'depth'
  readonly pending = false

  readonly #target = new RenderTarget(1, 1, {
    type: HalfFloatType,
    format: RedFormat,
    depthBuffer: false,
  })
  readonly #samples: number
  readonly #source: TextureNode = texture(new DepthTexture(1, 1))
  readonly #extent = uniform(new Vector2(1, 1))
  readonly #material = new NodeMaterial()
  readonly #quad = new QuadMesh(this.#material)
  #tied: RenderTarget | null = null
  /** Whether the target exists on the GPU: a warm-up or a draw has bound it. */
  #allocated = false
  #warm: Promise<void> | null = null
  #disposed = false

  constructor(uniforms: CloudUniforms, layout: SceneLayout) {
    this.#target.texture.name = 'cloud depth'
    this.#samples = samplesOf(layout.samples)
    const pixel = ivec2(screenCoordinate)
    const viewZ = perspectiveDepthToViewZ(
      this.#source.load(pixel).x,
      uniforms.camera.near,
      uniforms.camera.far,
    )
    const screen = traceScreen(uvec2(pixel), vec2(0), this.#extent)
    const plane = uniforms.camera.plane
    const secant = sqrt(
      float(1)
        .add(screen.x.mul(plane.x).pow2())
        .add(screen.y.mul(plane.y).pow2()),
    )
    const kilometers = viewZ.negate().mul(secant).mul(1e-3)
    this.#material.fragmentNode = vec4(
      min(kilometers, CLOUD_DEPTH_CLAMP_KM),
      0,
      0,
      1,
    )
    this.#material.name = 'cloud depth'
  }

  /**
   * View distance (along the ray) in render meters ÷ 1000, R16F, render
   * resolution, clamped at 60,000 km; far depth stores the clamp. Row 0 is
   * the top of the image.
   */
  get texture(): Texture {
    return this.#target.texture
  }

  /**
   * Ties the copy's source to the scene target's (multisampled) depth, as
   * `SeaFrameNode.#tie` does, so the binding layout matches the frame's.
   */
  tie(sceneTarget: RenderTarget): void {
    const depth = sceneTarget.depthTexture
    invariant(depth !== null, 'the depth copy needs a scene target with depth')
    // A program a warm-up built for one sample count declares a binding a
    // depth of another cannot fill, and a tie does not rebuild it.
    invariant(
      samplesOf(sceneTarget.samples) === this.#samples,
      'the scene target was made for another layout than the depth copy',
    )
    this.#source.value = depth
    this.#tied = sceneTarget
  }

  /** Nothing until the target exists on the GPU: 1 × 1 after a warm-up, the render's size after a draw. */
  get bytes(): number {
    if (this.#disposed || !this.#allocated) return 0
    return this.#target.width * this.#target.height * TEXEL_BYTES
  }

  textures(): readonly Texture[] {
    return this.#disposed || !this.#allocated ? [] : [this.#target.texture]
  }

  /**
   * Compiles against the tied depth by drawing once (an R16F target, which
   * `warmByDrawing` says why); nothing before a tie, which is what the
   * program binds. The scene target goes on the device first: one nothing
   * has drawn into holds no depth at its sample count to bind.
   */
  warm(renderer: WebGPURenderer): Promise<void> {
    const tied = this.#tied
    if (this.#disposed || tied === null) return Promise.resolve()
    if (this.#warm === null) {
      this.#allocated = true
      renderer.initRenderTarget(tied)
      warmByDrawing(renderer, this.#quad, CLOUD_DEPTH_LABEL, [
        { target: this.#target, material: this.#material },
      ])
      this.#warm = Promise.resolve()
    }
    return this.#warm
  }

  /** `cloud depth`, at the tied target's size this frame; nothing before a tie. */
  render(renderer: WebGPURenderer): void {
    const source = this.#tied
    if (this.#disposed || source === null) return
    const { width, height } = source
    if (this.#target.width !== width || this.#target.height !== height)
      this.#target.setSize(width, height)
    this.#extent.value.set(width, height)
    this.#allocated = true
    runQuadPasses(renderer, this.#quad, { linear: true }, (draw) => {
      draw(CLOUD_DEPTH_LABEL, this.#target, this.#material)
    })
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#target.dispose()
    this.#material.dispose()
  }
}
