import type { Node } from 'three/webgpu'
import {
  array,
  atan,
  Break,
  float,
  Fn,
  If,
  ivec3,
  Loop,
  mix,
  uint,
  uniform,
  vec3,
  vec4,
} from 'three/tsl'
import { deriveSeed } from '@inertialref/procedural'
import {
  blackbodyColour,
  GALAXY_ARMS,
  GALAXY_HEIGHT_PARSECS,
  GALAXY_POPULATIONS,
  GALAXY_RADIUS_PARSECS,
  GALAXY_RADIANCE_FACTOR,
  POPULATION_NAMES,
  type GalaxyArm,
  type GalaxyField,
} from '@inertialref/universe'

const DEG = Math.PI / 180
const TAU = Math.PI * 2
/** The port has its own revision; the field manifest still identifies the CPU model. */
export const GALAXY_KERNEL_VERSION = 'galaxy-tsl@1'
export const GALAXY_MAX_STEPS = 16384

const smooth = (t: Node<'float'>) => {
  const x = t.clamp()
  return x.mul(x).mul(x.mul(-2).add(3))
}
// Metal's fast atan2 can reverse the sign at an exact zero denominator.
// The axes have known azimuths; naming them also avoids atan2(0, 0).
const betaAt = (p: Node<'vec3'>) =>
  p.x
    .equal(0)
    .select(
      p.z
        .equal(0)
        .select(
          float(0),
          p.z.greaterThan(0).select(float(-Math.PI / 2), float(Math.PI / 2)),
        ),
      atan(p.z.negate(), p.x.negate()),
    )
const warp = Fn(([radius, beta]: [Node<'float'>, Node<'float'>]) =>
  radius
    .div(1000)
    .sub(7.72)
    .max(0)
    .pow(1.33)
    .mul(60)
    .mul(beta.sub(17.5 * DEG).sin()),
).setLayout({
  name: 'galaxyWarp',
  type: 'float',
  inputs: [
    { name: 'radius', type: 'float' },
    { name: 'beta', type: 'float' },
  ],
})

const hash = Fn(([v]: [Node<'uint'>]) => {
  const h = v.toVar()
  h.bitXorAssign(h.shiftRight(16))
  h.mulAssign(uint(0x85ebca6b))
  h.bitXorAssign(h.shiftRight(13))
  h.mulAssign(uint(0xc2b2ae35))
  h.bitXorAssign(h.shiftRight(16))
  return h
}).setLayout({
  name: 'galaxyMix32',
  type: 'uint',
  inputs: [{ name: 'v', type: 'uint' }],
})

const noise = Fn(([seed, p]: [Node<'uint'>, Node<'vec3'>]) => {
  const cell = ivec3(p.floor()).toVar()
  const f = p.sub(p.floor()).toVar()
  const fade = f
    .mul(f)
    .mul(f)
    .mul(f.mul(f.mul(6).sub(15)).add(10))
    .toVar()
  const gradients = array([
    vec3(1, 1, 0),
    vec3(-1, 1, 0),
    vec3(1, -1, 0),
    vec3(-1, -1, 0),
    vec3(1, 0, 1),
    vec3(-1, 0, 1),
    vec3(1, 0, -1),
    vec3(-1, 0, -1),
    vec3(0, 1, 1),
    vec3(0, -1, 1),
    vec3(0, 1, -1),
    vec3(0, -1, -1),
  ])
  const corners: Node<'float'>[] = []
  for (let z = 0; z < 2; z++)
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        const lattice = cell.add(ivec3(x, y, z))
        const h = hash(
          uint(lattice.x)
            .bitXor(seed)
            .mul(uint(0x9e3779b1))
            .bitXor(uint(lattice.y).mul(uint(0x85ebca6b)))
            .bitXor(uint(lattice.z).mul(uint(0xc2b2ae35))),
        )
        corners.push(
          gradients.element(h.mod(uint(12))).dot(f.sub(vec3(x, y, z))),
        )
      }
  return mix(
    mix(
      mix(corners[0]!, corners[1]!, fade.x),
      mix(corners[2]!, corners[3]!, fade.x),
      fade.y,
    ),
    mix(
      mix(corners[4]!, corners[5]!, fade.x),
      mix(corners[6]!, corners[7]!, fade.x),
      fade.y,
    ),
    fade.z,
  )
}).setLayout({
  name: 'galaxyNoise',
  type: 'float',
  inputs: [
    { name: 'seed', type: 'uint' },
    { name: 'p', type: 'vec3' },
  ],
})

function logSpiral(
  radius: number,
  kink: number,
  before: number,
  after: number,
  angle: Node<'float'>,
) {
  return float(Math.log(radius)).sub(
    angle
      .sub(kink * DEG)
      .mul(
        angle
          .lessThanEqual(kink * DEG)
          .select(float(Math.tan(before * DEG)), float(Math.tan(after * DEG))),
      ),
  )
}
function armKernel(arm: GalaxyArm, index: number) {
  return Fn(([radius, beta]: [Node<'float'>, Node<'float'>]) => {
    const sum = float(0).toVar()
    const width =
      arm.id === 'local'
        ? float(310)
        : radius.div(1000).sub(8.15).mul(36).add(336).max(140)
    Loop({ start: -2, end: 2, type: 'int' }, ({ i }) => {
      const angle = beta.add(float(i).mul(TAU)).toVar()
      const degrees = angle.div(DEG).toVar()
      If(
        degrees
          .greaterThan(arm.startDegrees)
          .and(degrees.lessThan(arm.endDegrees)),
        () => {
          const logRadius = logSpiral(
            arm.kinkRadiusParsecs,
            arm.kinkDegrees,
            arm.pitchBeforeDegrees,
            arm.pitchAfterDegrees,
            angle,
          ).toVar()
          if (arm.id === 'norma-outer') {
            If(angle.lessThan(-100 * DEG), () => {
              If(angle.lessThanEqual(-240 * DEG), () => {
                logRadius.assign(logSpiral(12240, 18, 3, 9.4, angle.add(TAU)))
              }).Else(() => {
                const span = 140 * DEG
                const t = angle
                  .add(240 * DEG)
                  .div(span)
                  .toVar()
                const a =
                  Math.log(12240) - (120 - 18) * DEG * Math.tan(9.4 * DEG)
                const b = Math.log(4460) - (-100 - 18) * DEG * Math.tan(-DEG)
                logRadius.assign(
                  t
                    .pow(3)
                    .mul(2)
                    .sub(t.mul(t).mul(3))
                    .add(1)
                    .mul(a)
                    .add(
                      t
                        .pow(3)
                        .sub(t.mul(t).mul(2))
                        .add(t)
                        .mul(span * -Math.tan(9.4 * DEG)),
                    )
                    .add(t.pow(3).mul(-2).add(t.mul(t).mul(3)).mul(b))
                    .add(
                      t
                        .pow(3)
                        .sub(t.mul(t))
                        .mul(span * -Math.tan(-DEG)),
                    ),
                )
              })
            })
          }
          const blend = smooth(degrees.sub(arm.kinkDegrees).add(1).div(2))
          const pitch = blend
            .mul(arm.pitchAfterDegrees - arm.pitchBeforeDegrees)
            .add(arm.pitchBeforeDegrees)
            .mul(DEG)
          const distance = radius
            .sub(logRadius.exp())
            .mul(pitch.cos())
            .div(width)
          const ends = smooth(degrees.sub(arm.startDegrees).div(15)).mul(
            smooth(float(arm.endDegrees).sub(degrees).div(15)),
          )
          sum.addAssign(ends.mul(distance.mul(distance).mul(-0.5).exp()))
        },
      )
    })
    return sum
  }).setLayout({
    name: `galaxyArm${index}`,
    type: 'float',
    inputs: [
      { name: 'radius', type: 'float' },
      { name: 'beta', type: 'float' },
    ],
  })
}
const arms = GALAXY_ARMS.map(armKernel)
const emissionColors = POPULATION_NAMES.map((name) => {
  const population = GALAXY_POPULATIONS[name]
  const c = blackbodyColour(population.temperature)
  const factor = population.meanSolarLuminosities / (c.r + c.g + c.b)
  return [c.r * factor, c.g * factor, c.b * factor] as const
})

/** Galactic-center offsets in parsecs, packed from UniverseVector only at the host boundary. */
const sample = Fn(
  ([p, seed, normalization]: [Node<'vec3'>, Node<'uint'>, Node<'float'>]) => {
    const radius = p.xz.length().toVar()
    const beta = betaAt(p).toVar()
    const height = p.y.sub(warp(radius, beta)).abs().toVar()
    const strength = float(0).toVar()
    for (const arm of arms) strength.addAssign(arm(radius, beta))
    const edge = smooth(
      float(GALAXY_RADIUS_PARSECS).sub(radius).div(4000),
    ).toVar()
    const radial = float(8178).sub(radius).div(2600).exp().mul(edge).toVar()
    const c = Math.cos(27 * DEG),
      s = Math.sin(27 * DEG)
    const along = p.x.mul(-c).sub(p.z.mul(s))
    const across = p.x.mul(s).sub(p.z.mul(c))
    const box = along.div(1500).pow(4).add(across.div(750).pow(4)).pow(0.25)
    const populations = [
      radial.mul(height.div(-300).exp()).mul(strength.mul(0.2).add(1)),
      float(8178)
        .sub(radius)
        .div(2000)
        .exp()
        .mul(height.div(-900).exp())
        .mul(edge)
        .mul(0.04),
      radial
        .mul(height.div(-19).exp())
        .mul(strength)
        .mul(noise(seed, p.div(350)).mul(0.2).add(1))
        .mul(0.003),
      box
        .negate()
        .sub(p.y.abs().div(390))
        .exp()
        .mul(radius.div(5000).pow(4).negate().exp())
        .mul(90),
      vec3(p.x, p.y.div(0.6), p.z)
        .length()
        .div(1000)
        .add(1)
        .div(1 + 8178 / 1000)
        .pow(-3.5)
        .mul(edge)
        .mul(0.001),
    ]
    const result = vec4(0).toVar()
    populations.forEach((density, i) =>
      result.addAssign(vec4(vec3(...emissionColors[i]!).mul(density), density)),
    )
    return result.mul(normalization)
  },
).setLayout({
  name: 'galaxySample',
  type: 'vec4',
  inputs: [
    { name: 'p', type: 'vec3' },
    { name: 'seed', type: 'uint' },
    { name: 'normalization', type: 'float' },
  ],
})

/** Midpoint intervals and the warped-plane step law are identical to integrateGalaxyRay. */
const integrate = Fn(
  ([origin, direction, distance, maxStep, seed, normalization]: [
    Node<'vec3'>,
    Node<'vec3'>,
    Node<'float'>,
    Node<'float'>,
    Node<'uint'>,
    Node<'float'>,
  ]) => {
    const d = direction.normalize().toVar()
    const near = float(0).toVar(),
      far = distance.toVar()
    const limits = [
      GALAXY_RADIUS_PARSECS,
      GALAXY_HEIGHT_PARSECS,
      GALAXY_RADIUS_PARSECS,
    ]
    for (const [index, axis] of (['x', 'y', 'z'] as const).entries()) {
      const o = origin[axis],
        v = d[axis],
        limit = limits[index]!
      If(v.abs().lessThan(1e-15), () => {
        If(o.abs().greaterThan(limit), () => {
          far.assign(-1)
        })
      }).Else(() => {
        const a = float(-limit).sub(o).div(v),
          b = float(limit).sub(o).div(v)
        near.assign(near.max(a.min(b)))
        far.assign(far.min(a.max(b)))
      })
    }
    const result = vec4(0).toVar()
    const t = near.toVar()
    Loop(GALAXY_MAX_STEPS, () => {
      If(t.greaterThanEqual(far), () => {
        Break()
      })
      const p = origin.add(d.mul(t)).toVar()
      const height = p.y.sub(warp(p.xz.length(), betaAt(p))).abs()
      const step = height
        .mul(0.2)
        .max(4)
        .div(d.y.abs().add(0.1))
        .min(maxStep)
        .min(far.sub(t))
        .toVar()
      result.addAssign(
        sample(
          origin.add(d.mul(t.add(step.mul(0.5)))),
          seed,
          normalization,
        ).mul(step),
      )
      t.addAssign(step)
    })
    return vec4(result.rgb.mul(GALAXY_RADIANCE_FACTOR), result.a)
  },
).setLayout({
  name: 'galaxyIntegral',
  type: 'vec4',
  inputs: [
    { name: 'origin', type: 'vec3' },
    { name: 'direction', type: 'vec3' },
    { name: 'distance', type: 'float' },
    { name: 'maxStep', type: 'float' },
    { name: 'seed', type: 'uint' },
    { name: 'normalization', type: 'float' },
  ],
})

export function createGalaxyKernel(field: GalaxyField) {
  const seed = uniform(
    deriveSeed(field.seed, 'galaxy-field:young-arms').a,
    'uint',
  )
  const normalization = uniform(field.normalization)
  return {
    structure: (p: Node<'vec3'>): Node<'vec4'> =>
      Fn(() => {
        const radius = p.xz.length().toVar(),
          beta = betaAt(p).toVar()
        const total = float(0).toVar()
        for (const arm of arms) total.addAssign(arm(radius, beta))
        return vec4(total, warp(radius, beta), 0, 1)
      })(),
    sample: (position: Node<'vec3'>): Node<'vec4'> =>
      sample(position, seed, normalization),
    integrate: (
      origin: Node<'vec3'>,
      direction: Node<'vec3'>,
      distance: number | Node<'float'> = 100000,
    ): Node<'vec4'> =>
      integrate(
        origin,
        direction,
        typeof distance === 'number' ? float(distance) : distance,
        float(100),
        seed,
        normalization,
      ),
  }
}
