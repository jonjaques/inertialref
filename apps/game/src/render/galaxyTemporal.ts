import {
  ColorManagement,
  HalfFloatType,
  LinearFilter,
  NodeMaterial,
  NoToneMapping,
  QuadMesh,
  RenderTarget,
  Vector2,
  Vector3,
  type Node,
  type WebGPURenderer,
} from 'three/webgpu'
import { Fn, float, texture, uniform, uv, vec2, vec4 } from 'three/tsl'
import { invariant, PARSEC } from '@inertialref/shared'
import { Quaternion as Q, UV } from '@inertialref/spatial'
import { verticalFov, type Lens } from '@inertialref/rendering'
import type { ObserverPose } from '@inertialref/devtools'
import { warmSensorPass } from './warmup.ts'

export interface GalaxyTemporalOptions {
  readonly stride?: number
}
/** Physical RGB and its emission-weighted distance; foreground depth stays in the scene. */
export type GalaxyTemporalRay = (
  origin: Node<'vec3'>,
  direction: Node<'vec3'>,
  pixelAngle: Node<'float'>,
) => Node<'vec4'>

function target(name: string): RenderTarget {
  const value = new RenderTarget(1, 1, {
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
  })
  value.texture.name = name
  return value
}

/** Interleaved physical rays reproject into an owned reduced-resolution history. */
export class GalaxyTemporalVolume {
  readonly #rays = target('Galaxy current rays')
  readonly #history = [target('Galaxy history A'), target('Galaxy history B')]
  readonly #rayMaterial = new NodeMaterial()
  readonly #resolveMaterial = new NodeMaterial()
  readonly #quad = new QuadMesh(this.#rayMaterial)
  readonly #currentMap = texture(this.#rays.texture, uv())
  readonly #previousMap = texture(this.#history[0]!.texture, uv())
  readonly #outputMap = texture(this.#history[1]!.texture, uv())
  readonly #origin = uniform(new Vector3())
  readonly #right = uniform(new Vector3(1, 0, 0))
  readonly #up = uniform(new Vector3(0, 1, 0))
  readonly #forward = uniform(new Vector3(0, 0, -1))
  readonly #plane = uniform(new Vector2(1, 1))
  readonly #previousRight = uniform(new Vector3(1, 0, 0))
  readonly #previousUp = uniform(new Vector3(0, 1, 0))
  readonly #previousForward = uniform(new Vector3(0, 0, -1))
  readonly #previousPlane = uniform(new Vector2(1, 1))
  readonly #translation = uniform(new Vector3())
  readonly #size = uniform(new Vector2(1, 1))
  readonly #raySize = uniform(new Vector2(1, 1))
  readonly #phase = uniform(new Vector2())
  readonly #angle = uniform(1)
  readonly #valid = uniform(0)
  readonly #stationary = uniform(0)
  readonly stride: number
  #pose: ObserverPose | null = null
  #lens: Lens | null = null
  #version: unknown = null
  #drawnPose: ObserverPose | null = null
  #drawnVersion: unknown = null
  #warm: Promise<void> | null = null
  #ready = false
  #disposed = false
  #slot = 0
  #refreshed = 0
  #resets = 0
  #phaseIndex = 0

  constructor(ray: GalaxyTemporalRay, options: GalaxyTemporalOptions = {}) {
    this.stride = options.stride ?? 4
    invariant(
      [1, 2, 4, 8].includes(this.stride),
      'Galaxy temporal stride must be 1, 2, 4 or 8',
    )
    const direction = (coord: Node<'vec2'>) => {
      const screen = coord.mul(2).sub(1)
      return this.#forward
        .add(this.#right.mul(screen.x.mul(this.#plane.x)))
        .add(this.#up.mul(screen.y.mul(this.#plane.y)))
        .normalize()
    }
    const rayPixel = uv()
      .mul(this.#raySize)
      .floor()
      .mul(this.stride)
      .add(this.#phase)
      .add(0.5)
    this.#rayMaterial.fragmentNode = ray(
      this.#origin,
      direction(rayPixel.div(this.#size)),
      this.#angle,
    )
    this.#rayMaterial.name = 'Galaxy interleaved rays'
    this.#resolveMaterial.fragmentNode = Fn(() => {
      const pixel = uv().mul(this.#size).floor().toVar()
      const coord = pixel.add(0.5).div(this.#size).toVar()
      const currentUv = pixel
        .sub(this.#phase)
        .add(this.stride * 0.5)
        .div(this.#raySize.mul(this.stride))
        .toVar()
      const current = this.#currentMap.sample(currentUv).level(float(0)).toVar()
      const d = direction(coord).toVar()
      const previousRay = d.mul(current.a).add(this.#translation).toVar()
      const z = previousRay.dot(this.#previousForward).toVar()
      const previousUv = vec2(
        previousRay.dot(this.#previousRight),
        previousRay.dot(this.#previousUp),
      )
        .div(z.max(1e-6))
        .div(this.#previousPlane)
        .mul(0.5)
        .add(0.5)
        .toVar()
      const history = this.#previousMap
        .sample(previousUv)
        .level(float(0))
        .toVar()
      const inside = previousUv.x
        .greaterThanEqual(0)
        .and(previousUv.y.greaterThanEqual(0))
        .and(previousUv.x.lessThanEqual(1))
        .and(previousUv.y.lessThanEqual(1))
        .and(z.greaterThan(0))
      // A volume spans depths. Reject large parallax instead of treating its mean as a surface.
      const parallax = this.#translation.length().div(current.a.max(1))
      const valid = inside
        .and(this.#valid.greaterThan(0))
        .and(parallax.lessThan(0.05))
        .and(
          history.a
            .sub(previousRay.length())
            .abs()
            .lessThan(current.a.max(1).mul(0.2)),
        )
      const ownPhase = pixel.x
        .mod(this.stride)
        .equal(this.#phase.x)
        .and(pixel.y.mod(this.stride).equal(this.#phase.y))
      const lower = current.rgb.toVar(),
        upper = current.rgb.toVar()
      for (const offset of [vec2(-1, 0), vec2(1, 0), vec2(0, -1), vec2(0, 1)]) {
        const neighbor = this.#currentMap
          .sample(currentUv.add(offset.div(this.#raySize)))
          .level(float(0)).rgb
        lower.assign(lower.min(neighbor))
        upper.assign(upper.max(neighbor))
      }
      const kept = this.#stationary
        .greaterThan(0)
        .select(history, vec4(history.rgb.clamp(lower, upper), current.a))
      return ownPhase.or(valid.not()).select(current, kept)
    })()
    this.#resolveMaterial.name = 'Galaxy physical history resolve'
  }

  configure(pose: ObserverPose | null, lens: Lens, version: unknown): void {
    this.#pose = pose
    this.#lens = lens
    this.#version = version
    if (pose === null) this.#drawnPose = null
  }
  sample(): Node<'vec4'> {
    return this.#outputMap
  }
  get report() {
    return {
      stride: this.stride,
      refreshed: this.#refreshed,
      resets: this.#resets,
      phase: this.#phaseIndex,
      width: this.#history[0]!.width,
      height: this.#history[0]!.height,
      rayWidth: this.#rays.width,
      rayHeight: this.#rays.height,
      bytes: this.#disposed
        ? 0
        : 8 *
          (this.#rays.width * this.#rays.height +
            2 * this.#history[0]!.width * this.#history[0]!.height),
    }
  }
  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#warm ??= warmSensorPass(renderer, this.#quad, [
      { target: this.#rays, material: this.#rayMaterial },
      { target: this.#history[0]!, material: this.#resolveMaterial },
    ]).then(() => {
      if (!this.#disposed) this.#ready = true
    })
    return this.#warm
  }
  render(renderer: WebGPURenderer, width: number, height: number): boolean {
    const pose = this.#pose,
      lens = this.#lens
    if (!this.#ready || this.#disposed || pose === null || lens === null)
      return false
    const previous = this.#drawnPose
    const resized =
      width !== this.#history[0]!.width || height !== this.#history[0]!.height
    const dot =
      previous === null
        ? 0
        : Math.abs(
            pose.orientation.x * previous.orientation.x +
              pose.orientation.y * previous.orientation.y +
              pose.orientation.z * previous.orientation.z +
              pose.orientation.w * previous.orientation.w,
          )
    const valid =
      !resized &&
      previous !== null &&
      this.#drawnVersion === this.#version &&
      dot > Math.cos(Math.PI / 8)
    if (!valid) {
      this.#resets++
      this.#phaseIndex = 0
    }
    this.#stationary.value =
      valid &&
      previous !== null &&
      UV.distance(pose.position, previous.position) < PARSEC * 1e-6 &&
      dot > 1 - 1e-12 &&
      Math.abs(Math.tan(verticalFov(lens) / 2) - this.#previousPlane.value.y) <
        1e-8
        ? 1
        : 0
    this.#valid.value = valid ? 1 : 0
    this.#phase.value.set(
      this.#phaseIndex % this.stride,
      Math.floor(this.#phaseIndex / this.stride),
    )
    const rw = Math.ceil(width / this.stride),
      rh = Math.ceil(height / this.stride)
    this.#rays.setSize(rw, rh)
    for (const history of this.#history) history.setSize(width, height)
    this.#size.value.set(width, height)
    this.#raySize.value.set(rw, rh)
    const p = UV.approxMeters(pose.position),
      basis = Q.basis(pose.orientation)
    this.#origin.value.set(p.x / PARSEC, p.y / PARSEC, p.z / PARSEC)
    if (previous !== null) {
      const delta = UV.difference(pose.position, previous.position)
      this.#translation.value.set(
        delta.x / PARSEC,
        delta.y / PARSEC,
        delta.z / PARSEC,
      )
    } else this.#translation.value.set(0, 0, 0)
    this.#right.value.set(basis.right.x, basis.right.y, basis.right.z)
    this.#up.value.set(basis.up.x, basis.up.y, basis.up.z)
    this.#forward.value.set(basis.forward.x, basis.forward.y, basis.forward.z)
    const half = Math.tan(verticalFov(lens) / 2)
    this.#plane.value.set((half * width) / height, half)
    this.#angle.value = verticalFov(lens) / height
    const heldTarget = renderer.getRenderTarget(),
      mrt = renderer.getMRT(),
      tone = renderer.toneMapping,
      color = renderer.outputColorSpace,
      clear = renderer.autoClear
    try {
      renderer.setMRT(null)
      renderer.toneMapping = NoToneMapping
      renderer.outputColorSpace = ColorManagement.workingColorSpace
      renderer.autoClear = true
      this.#quad.material = this.#rayMaterial
      renderer.setRenderTarget(this.#rays)
      this.#quad.render(renderer)
      this.#previousMap.value = this.#history[this.#slot]!.texture
      const next = 1 - this.#slot
      this.#quad.material = this.#resolveMaterial
      renderer.setRenderTarget(this.#history[next]!)
      this.#quad.render(renderer)
      this.#outputMap.value = this.#history[next]!.texture
      this.#slot = next
      this.#refreshed++
      this.#phaseIndex = (this.#phaseIndex + 1) % (this.stride * this.stride)
      this.#drawnPose = {
        position: { ...pose.position },
        orientation: { ...pose.orientation },
      }
      this.#drawnVersion = this.#version
      this.#previousRight.value.copy(this.#right.value)
      this.#previousUp.value.copy(this.#up.value)
      this.#previousForward.value.copy(this.#forward.value)
      this.#previousPlane.value.copy(this.#plane.value)
    } finally {
      renderer.setRenderTarget(heldTarget)
      renderer.setMRT(mrt)
      renderer.toneMapping = tone
      renderer.outputColorSpace = color
      renderer.autoClear = clear
    }
    return true
  }
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#rays.dispose()
    for (const history of this.#history) history.dispose()
    this.#rayMaterial.dispose()
    this.#resolveMaterial.dispose()
  }
}
