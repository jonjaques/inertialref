import {
  type ComputeNode,
  type RenderTarget,
  StorageBufferAttribute,
  type StorageBufferNode,
  type TextureNode,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  abs,
  dot,
  float,
  Fn,
  If,
  instanceIndex,
  max,
  select,
  storage,
  texture,
  uint,
  uvec2,
  vec2,
  vec3,
} from 'three/tsl'
import { getLogger } from '@inertialref/shared'
import type { CloudRadiance } from '@inertialref/devtools'
import { follow } from './cloudFront.ts'
import { screenTexel, traceScreen } from './cloudGeometry.ts'
import type { CloudHistoryTextures } from './cloudHistory.ts'
import { cloudStandInTexture } from './cloudNodes.ts'
import type { CloudUniforms } from './cloudUniforms.ts'
import { sceneRadianceGain } from './radiance.ts'

/*
 * The radiance capture: `cloud radiance`, a compute pass at the trace's
 * extent after a frame, which reads the scene target as the frame left it —
 * the clouds composited in — over the scene's radiance gain, and marks the
 * texels the history holds cloud at, then reads both back. §8.7's cache gate
 * and quality ladders difference two captures (`cloudRadianceDifference`),
 * which no figure the report carries could give: the residual meter compares
 * composite forms on one frame, not one frame against another.
 *
 * An instrument (rule 65): it writes nothing a frame reads, builds and
 * allocates nothing until the first capture is asked for, keeps one readback
 * in flight, and a failure answers null rather than reaching the frame.
 */

export const CLOUD_RADIANCE_LABEL = 'cloud radiance'

const log = getLogger('game.clouds')
const WORKGROUP = 64
/** A texel holds cloud where the history passes under this, or carries any light. */
const CLOUDLESS = 0.999
const LUMA = /*@__PURE__*/ vec3(0.2126, 0.7152, 0.0722)
/** Floats a texel: its luminance and its mark. */
const STRIDE = 2

interface Kernel {
  readonly node: ComputeNode
  readonly buffer: StorageBufferAttribute
  readonly capacity: number
}

export class CloudRadianceMeter {
  readonly #uniforms: CloudUniforms
  readonly #history: () => CloudHistoryTextures
  /** The scene target's resolved output, on a stand-in of its format until the first capture. */
  readonly #scene = texture(cloudStandInTexture('2d', 'rgba16f'))
  /** The history's newest light, which flips parity every converging frame. */
  #light: TextureNode | null = null
  #kernel: Kernel | null = null
  #asked: {
    readonly promise: Promise<CloudRadiance | null>
    readonly settle: (capture: CloudRadiance | null) => void
  } | null = null
  #reading = false
  #failed = false
  #disposed = false

  constructor(uniforms: CloudUniforms, history: () => CloudHistoryTextures) {
    this.#uniforms = uniforms
    this.#history = history
  }

  /**
   * The next frame's capture: one promise for every caller until it lands,
   * so two asks between frames read one frame, and null when there is no
   * frame to read.
   */
  request(): Promise<CloudRadiance | null> {
    if (this.#disposed) return Promise.resolve(null)
    if (this.#asked !== null) return this.#asked.promise
    let settle: (capture: CloudRadiance | null) => void = () => {}
    const promise = new Promise<CloudRadiance | null>((done) => {
      settle = done
    })
    this.#asked = { promise, settle }
    return promise
  }

  /**
   * After a frame: the capture if one is asked for and none is in flight.
   * `drawn` is false on a frame that drew no clouds, which answers null.
   */
  measure(
    renderer: WebGPURenderer,
    sceneTarget: RenderTarget,
    drawn: boolean,
  ): void {
    const asked = this.#asked
    if (asked === null || this.#reading) return
    if (!drawn || this.#disposed) {
      this.#answer(null)
      return
    }
    const { x: width, y: height } = this.#uniforms.trace.size.value
    const texels = width * height
    try {
      const kernel = this.#kernelFor(texels)
      follow(this.#scene, sceneTarget.texture)
      const history = this.#history()
      this.#light ??= texture(history.light)
      follow(this.#light, history.light)
      kernel.node.count = Math.ceil(texels / WORKGROUP) * WORKGROUP
      renderer.compute(kernel.node)
      this.#reading = true
      // The flag clears before the answer goes out: an await on the answer
      // resumes ahead of a `finally`, and a caller asking again from there
      // would find a readback still in flight and wait on a frame it drew.
      void renderer.getArrayBufferAsync(kernel.buffer).then(
        (buffer) => {
          this.#reading = false
          const values = new Float32Array(buffer, 0, texels * STRIDE)
          const luminance = new Float32Array(texels)
          const cloud = new Uint8Array(texels)
          for (let i = 0; i < texels; i += 1) {
            luminance[i] = values[STRIDE * i]!
            cloud[i] = values[STRIDE * i + 1]! > 0.5 ? 1 : 0
          }
          this.#answer(
            this.#disposed ? null : { width, height, luminance, cloud },
          )
        },
        () => {
          // A device being replaced reads nothing back: no capture.
          this.#reading = false
          this.#answer(null)
        },
      )
    } catch (cause) {
      if (!this.#failed)
        log.warn('a radiance capture failed; the frame is untouched', {
          cause: String(cause),
        })
      this.#failed = true
      this.#answer(null)
    }
  }

  dispose(): void {
    this.#disposed = true
    this.#answer(null)
    this.#kernel?.node.dispose()
    this.#kernel?.buffer.dispose()
    this.#kernel = null
  }

  #answer(capture: CloudRadiance | null): void {
    const asked = this.#asked
    this.#asked = null
    asked?.settle(capture)
  }

  /**
   * The kernel and its buffer, sized to the first capture's extent and
   * rebuilt only for a larger one: a storage buffer cannot grow under the
   * program that binds it, and a capture past a resize is rare.
   */
  #kernelFor(texels: number): Kernel {
    const held = this.#kernel
    if (held !== null && held.capacity >= texels) return held
    held?.node.dispose()
    held?.buffer.dispose()
    const buffer = new StorageBufferAttribute(
      new Float32Array(texels * STRIDE),
      1,
    )
    const history = this.#history()
    this.#light ??= texture(history.light)
    const node = radianceKernel(
      this.#uniforms,
      this.#scene,
      this.#light,
      storage(buffer, 'float', texels * STRIDE),
      texels,
    )
    this.#kernel = { node, buffer, capacity: texels }
    return this.#kernel
  }
}

function radianceKernel(
  uniforms: CloudUniforms,
  scene: TextureNode,
  light: TextureNode,
  into: StorageBufferNode<'float'>,
  capacity: number,
): ComputeNode {
  const { trace } = uniforms
  return Fn(() => {
    const width = uint(trace.size.x)
    const height = uint(trace.size.y)
    If(
      instanceIndex
        .lessThan(width.mul(height))
        .and(instanceIndex.lessThan(uint(capacity))),
      () => {
        const pixel = uvec2(instanceIndex.mod(width), instanceIndex.div(width))
        const screen = traceScreen(pixel, vec2(0), trace.size)
        const drawn = scene
          .load(screenTexel(screen, trace.render))
          .rgb.div(sceneRadianceGain)
        const cloud = light.load(screenTexel(screen, trace.history))
        const held = cloud.w
          .lessThan(CLOUDLESS)
          .or(max(max(abs(cloud.x), abs(cloud.y)), abs(cloud.z)).greaterThan(0))
        const at = instanceIndex.mul(uint(STRIDE))
        into.element(at).assign(dot(drawn, LUMA))
        into.element(at.add(uint(1))).assign(select(held, float(1), float(0)))
      },
    )
  })()
    .compute(WORKGROUP)
    .setName(CLOUD_RADIANCE_LABEL)
}
