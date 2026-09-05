import {
  whiteBalance,
  verticalFov,
  type Glass,
  type Lens,
  type SensorSettings,
} from '@inertialref/rendering'
import { Vector2, Vector3, type Node, type TextureNode } from 'three/webgpu'
import {
  colorSpaceToWorking,
  float,
  Fn,
  screenCoordinate,
  uint,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  workingToColorSpace,
} from 'three/tsl'
import { LINEAR_P3 } from './gamut.ts'

/** Integer hash: no wall clock, float lattice, texture or accumulating history. */
const random = Fn(([seed]: [Node<'uint'>]) => {
  const x = seed.toVar()
  x.assign(x.bitXor(x.shiftRight(16)).mul(uint(0x7feb352d)))
  x.assign(x.bitXor(x.shiftRight(15)).mul(uint(0x846ca68b)))
  x.assign(x.bitXor(x.shiftRight(16)))
  return float(x.shiftRight(8)).div(16777216)
})

/** The glass and detector, in linear light; output dither is a separate encode step. */
export function sensorSignature(input: TextureNode) {
  const size = uniform(new Vector2(1920, 1080))
  const tick = uniform(0, 'uint')
  const residual = uniform(1)
  const well = uniform(20000)
  const read = uniform(3)
  const direct = uniform(0)
  const field = uniform(new Vector2(1, 1))
  const correction = uniform(0.6)
  const lateral = uniform(0.25)
  const balance = uniform(new Vector3(1, 1, 1))
  const dither = uniform(1)
  const wide = uniform(0)
  const p = screenCoordinate.floor()
  const seed = uint(p.x)
    .mul(uint(1973))
    .add(uint(p.y).mul(uint(9277)))
    .bitXor(tick.mul(uint(26699)))
  const linear = Fn(() => {
    const centered = uv().sub(0.5).mul(2)
    const corner = centered.mul(vec2(size.x.div(size.y), 1))
    const radius = corner.length().div(vec2(size.x.div(size.y), 1).length())
    const offset = centered.mul(lateral).mul(radius.pow(2)).div(size)
    const image = vec3(
      input.sample(uv().add(offset)).r,
      input.sample(uv()).g,
      input.sample(uv().sub(offset)).b,
    )
    const cos4 = centered.mul(field).dot(centered.mul(field)).add(1).pow(-2)
    const vignette = direct
      .mul(correction.oneMinus())
      .mul(cos4.oneMinus())
      .oneMinus()
    const balanced = image.mul(residual).mul(vignette).mul(balance)
    const signal = wide
      .greaterThan(0.5)
      .select(
        (
          workingToColorSpace(
            vec4(balanced, 1),
            LINEAR_P3,
          ) as unknown as Node<'vec4'>
        ).rgb,
        balanced,
      )
      .max(vec3(0))
    // A twelve-uniform normal approximation has mean 0 and variance 1.
    // Independent channels retain photon color statistics without a costly log.
    const gaussian = vec3(0).toVar()
    for (let i = 0; i < 12; i += 1) {
      gaussian.addAssign(
        vec3(
          random(seed.add(uint(i * 3 + 1))),
          random(seed.add(uint(i * 3 + 2))),
          random(seed.add(uint(i * 3 + 3))),
        ),
      )
    }
    gaussian.subAssign(vec3(6))
    const electrons = signal.mul(well)
    const noise = electrons.add(read.mul(read)).sqrt().mul(gaussian).div(well)
    const floor = read.div(well)
    const noisy = signal.add(noise)
    const composite = noisy.max(vec3(floor.mul(0.5)))
    const clipped = noisy.sub(vec3(floor)).max(vec3(0))
    const result = vec4(direct.greaterThan(0.5).select(clipped, composite), 1)
    return wide
      .greaterThan(0.5)
      .select(colorSpaceToWorking(result, LINEAR_P3), result)
  })()
  return {
    linear,
    /** Triangular PDF, ± one encoded 8-bit step, after the transfer function. */
    encode(output: Node<'vec4'>): Node<'vec4'> {
      const noise = random(seed.add(uint(941)))
        .sub(random(seed.add(uint(1741))))
        .mul(dither)
        .div(255)
      return vec4(output.rgb.add(vec3(noise)).max(vec3(0)), 1)
    },
    update(
      lens: Lens,
      glass: Glass,
      settings: SensorSettings,
      width: number,
      height: number,
      /** The frame's integer tick; two frames with one tick draw one noise field. */
      noiseTick: number,
      gain: number,
      sdr: boolean,
      p3 = false,
    ): void {
      size.value.set(width, height)
      tick.value = Math.max(0, Math.floor(noiseTick)) >>> 0
      residual.value = gain
      well.value = (glass.fullWell * 100) / Math.max(1, lens.iso)
      read.value = glass.readNoise
      direct.value = settings.response === 'direct' ? 1 : 0
      const tangent = Math.tan(verticalFov(lens) / 2)
      field.value.set((tangent * width) / height, tangent)
      correction.value = glass.vignettingCorrection
      lateral.value = glass.lateralColor
      balance.value.set(...whiteBalance(settings.balance))
      dither.value = sdr ? 1 : 0
      wide.value = p3 ? 1 : 0
    },
  }
}
