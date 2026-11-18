import { invariant } from '@inertialref/shared'
import {
  DepthTexture,
  FloatType,
  NearestFilter,
  NodeMaterial,
  QuadMesh,
  RedFormat,
  RenderTarget,
  type TextureNode,
  type WebGPURenderer,
} from 'three/webgpu'
import { ivec2, screenCoordinate, texture, vec4 } from 'three/tsl'
import { runQuadPasses } from './quadPass.ts'
import type { SceneLayout } from './sceneLayout.ts'

/*
 * The scene's depth as the takram port can read it: the raw depth value,
 * sample 0 of each pixel, in a one-sample R32F texture at the scene pass's
 * size.
 *
 * The port samples its `sceneDepth` node by uv and decodes it with the scene
 * camera (`depthToViewZ`), which is what a one-sample depth texture allows.
 * The default picture draws the scene at four samples, and a multisampled
 * depth can only be loaded by texel and sample, so the port's node cannot be
 * the scene target's own depth. This copy keeps the value and the encoding,
 * reversed and unlinearized, so the port's own decode is the one that runs.
 *
 * R32F and not a half float: a reversed depth is near over distance, and a
 * half float's subnormals step by 6e-8, which is 12% of the value at 100 km
 * from a 5 cm near plane. Nearest, because an R32F texture is not filterable
 * without a device feature and three then reads it by texel.
 *
 * The source is read as `cloudDepth.ts` reads it and for its reasons: the
 * binding is declared by the sample count of the target the depth belongs
 * to, so the node holds a placeholder until `tie` hands it the scene's.
 */

/** The pass's name on the timeline. */
export const CLOUDS_DEPTH_LABEL = 'clouds depth'

export class CloudsDepth {
  /** What `clouds({ sceneDepth })` takes. */
  readonly node: TextureNode

  readonly #target = new RenderTarget(1, 1, {
    type: FloatType,
    format: RedFormat,
    depthBuffer: false,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    generateMipmaps: false,
  })
  readonly #samples: number
  readonly #source: TextureNode = texture(new DepthTexture(1, 1))
  readonly #material = new NodeMaterial()
  readonly #quad = new QuadMesh(this.#material)
  #tied: RenderTarget | null = null
  #disposed = false

  constructor(layout: SceneLayout) {
    this.#target.texture.name = CLOUDS_DEPTH_LABEL
    this.#samples = Math.max(1, layout.samples)
    this.#material.fragmentNode = vec4(
      this.#source.load(ivec2(screenCoordinate)).x,
      0,
      0,
      1,
    )
    this.#material.name = CLOUDS_DEPTH_LABEL
    this.node = texture(this.#target.texture)
  }

  /** Ties the copy's source to the scene target's depth, multisampled or not. */
  tie(sceneTarget: RenderTarget): void {
    const depth = sceneTarget.depthTexture
    invariant(depth !== null, 'the depth copy needs a scene target with depth')
    invariant(
      Math.max(1, sceneTarget.samples) === this.#samples,
      'the scene target was made for another layout than the depth copy',
    )
    this.#source.value = depth
    this.#tied = sceneTarget
  }

  /** Bytes the copy holds on the device: four a texel. */
  get bytes(): number {
    return this.#disposed ? 0 : this.#target.width * this.#target.height * 4
  }

  /** `clouds depth`, at the tied target's size this frame; nothing before a tie. */
  render(renderer: WebGPURenderer): void {
    const source = this.#tied
    if (this.#disposed || source === null) return
    const { width, height } = source
    if (this.#target.width !== width || this.#target.height !== height)
      this.#target.setSize(width, height)
    runQuadPasses(renderer, this.#quad, { linear: true }, (draw) => {
      draw(CLOUDS_DEPTH_LABEL, this.#target, this.#material)
    })
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#target.dispose()
    this.#material.dispose()
  }
}
