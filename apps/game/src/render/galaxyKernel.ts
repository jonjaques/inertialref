import { Vector3, type Node } from 'three/webgpu'
import { PARSEC } from '@inertialref/shared'
import { UV } from '@inertialref/spatial'
import {
  array,
  atan,
  Break,
  bool,
  float,
  Fn,
  If,
  ivec3,
  Loop,
  mix,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { deriveSeed } from '@inertialref/procedural'
import {
  blackbodyColour,
  GALAXY_ARMS,
  LUMINOSITY_BANDS,
  POPULATION_LUMINOSITY_WEIGHTS,
  populationLimitingLuminosity,
  type ResolvedPopulationSelection,
  GALAXY_DUST,
  LOCAL_BUBBLE,
  LOCAL_CLOUDS,
  GALAXY_DUST_SETTLED_STEP_PARSECS,
  GALAXY_DUST_SETTLED_HEIGHT_FACTOR,
  GALAXY_FOOTPRINT_STEP_FRACTION,
  galaxyDustOctaveMean,
  GALAXY_HEIGHT_PARSECS,
  GALAXY_POPULATIONS,
  GALAXY_RADIUS_PARSECS,
  GALAXY_RADIANCE_FACTOR,
  GALAXY_OBSERVER_MIN_STEP_PARSECS,
  GALAXY_OBSERVER_STEP_GROWTH,
  type GalaxyRaySampling,
  POPULATION_NAMES,
  type GalaxyArm,
  type GalaxyField,
} from '@inertialref/universe'

import { coveredLuminosityCeiling } from './galaxyPopulationPartition.ts'

const DEG = Math.PI / 180
const TAU = Math.PI * 2
/** The port has its own revision; the field manifest still identifies the CPU model. */
export const GALAXY_KERNEL_VERSION = 'galaxy-tsl@7'
export const GALAXY_MAX_STEPS = 16384
/** The step cap, parsecs. `integrateGalaxyRay`'s default, and what diagnostics report. */
export const GALAXY_MAX_STEP_PARSECS = 100
/** The omitted light is bounded by this fraction of the ray's unextinguished source. */
export const GALAXY_TRANSMITTANCE_FLOOR = 1e-12

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
    const sum = vec2(0).toVar()
    const width =
      arm.id === 'local'
        ? float(310)
        : radius.div(1000).sub(8.15).mul(36).add(336).max(140)
    // Stars and dust share each centerline evaluation; only the lane offset
    // and transverse width differ.
    for (let turn = -2; turn < 2; turn++) {
      const angle = beta.add(turn * TAU).toVar()
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
          const displacement = radius.sub(logRadius.exp()).toVar()
          const projection = pitch.cos().div(width).toVar()
          const distance = vec2(
            displacement,
            displacement
              .sub(GALAXY_DUST.armOffsetParsecs)
              .div(GALAXY_DUST.armWidthScale),
          )
            .mul(projection)
            .toVar()
          const ends = smooth(degrees.sub(arm.startDegrees).div(15)).mul(
            smooth(float(arm.endDegrees).sub(degrees).div(15)),
          )
          sum.addAssign(ends.mul(distance.mul(distance).mul(-0.5).exp()))
        },
      )
    }
    return sum
  }).setLayout({
    name: `galaxyArm${index}`,
    type: 'vec2',
    inputs: [
      { name: 'radius', type: 'float' },
      { name: 'beta', type: 'float' },
    ],
  })
}
const arms = GALAXY_ARMS.map((arm, index) => armKernel(arm, index))
export const galaxyStructureAt = Fn(([p]: [Node<'vec3'>]) => {
  const radius = p.xz.length().toVar(),
    beta = betaAt(p).toVar()
  const strength = vec2(0).toVar()
  for (const arm of arms) strength.addAssign(arm(radius, beta))
  return vec3(strength, p.y.sub(warp(radius, beta)).abs())
}).setLayout({
  name: 'galaxyStructure',
  type: 'vec3',
  inputs: [{ name: 'p', type: 'vec3' }],
})
const emissionColors = POPULATION_NAMES.map((name) => {
  const population = GALAXY_POPULATIONS[name]
  const c = blackbodyColour(population.temperature)
  const factor = population.meanSolarLuminosities / c.g
  return [c.r * factor, c.g * factor, c.b * factor] as const
})

/** Galactic-center offsets in parsecs, packed from UniverseVector only at the host boundary. */
const sample = Fn(
  ([p, seed, normalization, structure, threshold, levelMask, coveredCeiling]: [
    Node<'vec3'>,
    Node<'uint'>,
    Node<'float'>,
    Node<'vec3'>,
    Node<'float'>,
    Node<'uint'>,
    Node<'float'>,
  ]) => {
    const radius = p.xz.length().toVar()
    const height = structure.z,
      strength = structure.x
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
    const fractions = populations.map(() => float(1).toVar())
    // Finite luminosity bands cannot contribute resolved light beyond their
    // brightest covered source. Exterior rays skip the entire partition;
    // the near field retains the exact same first-moment arithmetic.
    If(
      levelMask.notEqual(uint(0)).and(threshold.lessThan(coveredCeiling)),
      () => {
        const light = LUMINOSITY_BANDS.map((band) =>
          levelMask
            .bitAnd(uint(1 << band.level))
            .equal(uint(0))
            .select(
              float(1),
              threshold
                .sub(band.minSolarV)
                .div(band.maxSolarV - band.minSolarV)
                .clamp(),
            )
            .toVar(),
        )
        fractions.forEach((fraction, i) => {
          const name = POPULATION_NAMES[i]!
          fraction.assign(0)
          LUMINOSITY_BANDS.forEach((band, j) =>
            fraction.addAssign(
              light[j]!.mul(
                (POPULATION_LUMINOSITY_WEIGHTS[name][j]! * band.meanSolarV) /
                  GALAXY_POPULATIONS[name].meanSolarLuminosities,
              ),
            ),
          )
        })
      },
    )
    populations.forEach((density, i) => {
      result.addAssign(
        vec4(
          vec3(...emissionColors[i]!)
            .mul(density)
            .mul(fractions[i]!.clamp()),
          density,
        ),
      )
    })
    return result.mul(normalization)
  },
).setLayout({
  name: 'galaxySample',
  type: 'vec4',
  inputs: [
    { name: 'p', type: 'vec3' },
    { name: 'seed', type: 'uint' },
    { name: 'normalization', type: 'float' },
    { name: 'structure', type: 'vec3' },
    { name: 'threshold', type: 'float' },
    { name: 'levelMask', type: 'uint' },
    { name: 'coveredCeiling', type: 'float' },
  ],
})

const localDust = Fn(([p]: [Node<'vec3'>]) => {
  const distance = p
    .sub(vec3(-8178, 20.8, 0))
    .length()
    .toVar()
  const bubble = float(LOCAL_BUBBLE.residual).add(
    smooth(
      distance
        .sub(LOCAL_BUBBLE.radiusParsecs - LOCAL_BUBBLE.transitionParsecs)
        .div(2 * LOCAL_BUBBLE.transitionParsecs),
    ).mul(1 - LOCAL_BUBBLE.residual),
  )
  const clouds = float(0).toVar()
  // Every compact cloud lies within 1.5 kpc of the Sun; the outside disk pays one bound.
  If(distance.lessThan(1500), () => {
    for (const c of LOCAL_CLOUDS) {
      const d = p
        .sub(vec3(c.center.x, c.center.y, c.center.z))
        .div(vec3(c.sigma.x, c.sigma.y, c.sigma.z))
        .toVar()
      const q = d.dot(d).toVar()
      If(q.lessThan(25), () => {
        clouds.addAssign(
          q
            .mul(-0.5)
            .exp()
            .mul(c.extinctionPerParsec)
            .mul(smooth(float(25).sub(q).div(9))),
        )
      })
    }
  })
  return vec2(bubble, clouds)
}).setLayout({
  name: 'galaxyLocalDust',
  type: 'vec2',
  inputs: [{ name: 'p', type: 'vec3' }],
})

const extinction = Fn(
  ([p, seed, normalization, structure, footprint, dustScale]: [
    Node<'vec3'>,
    Node<'uint'>,
    Node<'float'>,
    Node<'vec3'>,
    Node<'float'>,
    Node<'float'>,
  ]) => {
    const radius = p.xz.length().toVar()
    const height = structure.z,
      strength = structure.y
    const logModulation = float(0).toVar()
    // `galaxyDustModulation`, octave by octave: an octave the footprint
    // cannot resolve is its lattice mean, not a noise evaluation. The
    // branch is what the volume's speed rests on — the four evaluations
    // are 87% of a draw, and from outside the disk none of them resolves.
    for (const octave of GALAXY_DUST.octaves) {
      const weight = footprint
        .div(octave.scaleParsecs)
        .negate()
        .add(2)
        .clamp()
        .toVar()
      If(weight.greaterThan(0), () => {
        logModulation.addAssign(
          noise(seed, p.div(octave.scaleParsecs))
            .mul(octave.logAmplitude)
            .mul(weight),
        )
      })
      logModulation.addAssign(
        weight
          .mul(weight)
          .oneMinus()
          .mul(Math.log(galaxyDustOctaveMean(octave.logAmplitude))),
      )
    }
    const vertical = height
      .div(-GALAXY_DUST.thinHeightParsecs)
      .exp()
      .mul(GALAXY_DUST.thinFraction)
      .add(
        height
          .div(-GALAXY_DUST.thickHeightParsecs)
          .exp()
          .mul(GALAXY_DUST.thickFraction),
      )
    const coefficient = float(8178)
      .sub(radius)
      .div(GALAXY_DUST.radialScaleParsecs)
      .exp()
      .mul(vertical)
      .mul(smooth(float(GALAXY_RADIUS_PARSECS).sub(radius).div(4000)))
      .mul(strength.mul(GALAXY_DUST.armContrast).add(1))
      .mul(logModulation.exp())
      .mul(normalization)
    const local = localDust(p).toVar()
    const rgb = GALAXY_DUST.extinctionRgb
    return vec3(rgb.r, rgb.g, rgb.b).mul(
      coefficient.mul(local.x).add(local.y.mul(dustScale)),
    )
  },
).setLayout({
  name: 'galaxyExtinction',
  type: 'vec3',
  inputs: [
    { name: 'p', type: 'vec3' },
    { name: 'seed', type: 'uint' },
    { name: 'normalization', type: 'float' },
    { name: 'structure', type: 'vec3' },
    { name: 'footprint', type: 'float' },
    { name: 'dustScale', type: 'float' },
  ],
})

/** Exact homogeneous-segment source integral, with a cancellation-free thin limit. */
const segmentTransmission = Fn(([q]: [Node<'vec3'>]) =>
  q
    .lessThan(0.01)
    .select(
      vec3(1).sub(q.mul(0.5)).add(q.mul(q).div(6)).sub(q.mul(q).mul(q).div(24)),
      vec3(1).sub(q.negate().exp()).div(q.max(1e-20)),
    ),
).setLayout({
  name: 'galaxySegmentTransmission',
  type: 'vec3',
  inputs: [{ name: 'q', type: 'vec3' }],
})

/** Midpoint coefficients and front-to-back transport match integrateGalaxyRay. */
function createIntegral(
  structureAt: (p: Node<'vec3'>) => Node<'vec3'>,
  radianceDepth: boolean,
  resolvedOrigin: Node<'vec3'>,
  resolvedLimit: Node<'float'>,
  resolvedMask: Node<'uint'>,
  resolvedCeiling: Node<'float'>,
) {
  return Fn(
    ([
      origin,
      direction,
      distance,
      maxStep,
      sampling,
      seed,
      normalization,
      dustSeed,
      dustNormalization,
      dustScale,
      transmissionOnly,
      pixelAngle,
    ]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'uint'>,
      Node<'uint'>,
      Node<'float'>,
      Node<'uint'>,
      Node<'float'>,
      Node<'float'>,
      Node<'bool'>,
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
      const moment = float(0).toVar()
      const transmission = vec3(1).toVar()
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
        // The floor sits under the two live laws and never under the
        // plane-crossing law above — `GALAXY_FOOTPRINT_STEP_FRACTION`.
        const floor = pixelAngle.mul(t).mul(GALAXY_FOOTPRINT_STEP_FRACTION)
        If(sampling.greaterThan(0), () => {
          step.assign(
            step.min(
              t
                .mul(GALAXY_OBSERVER_STEP_GROWTH)
                .add(GALAXY_OBSERVER_MIN_STEP_PARSECS)
                .max(floor),
            ),
          )
        })
        If(sampling.equal(2), () => {
          step.assign(
            step.min(
              height
                .mul(GALAXY_DUST_SETTLED_HEIGHT_FACTOR)
                .max(GALAXY_DUST_SETTLED_STEP_PARSECS)
                .max(floor),
            ),
          )
        })
        const midpoint = origin.add(d.mul(t.add(step.mul(0.5)))).toVar()
        const structure = structureAt(midpoint).toVar()
        const emitted = sample(
          midpoint,
          seed,
          normalization,
          structure,
          midpoint.sub(resolvedOrigin).lengthSq().mul(resolvedLimit),
          resolvedMask,
          resolvedCeiling,
        ).toVar()
        const q = vec3(0).toVar()
        const illuminated = transmission.r
          .max(transmission.g)
          .max(transmission.b)
          .greaterThan(GALAXY_TRANSMITTANCE_FLOOR)
        If(
          dustNormalization
            .greaterThan(0)
            .and(transmissionOnly.or(illuminated)),
          () => {
            q.assign(
              extinction(
                midpoint,
                dustSeed,
                dustNormalization,
                structure,
                pixelAngle.mul(t.add(step.mul(0.5))),
                dustScale,
              ).mul(step),
            )
          },
        )
        If(transmissionOnly.not().and(illuminated.not()), () => {
          transmission.assign(0)
        })
        if (radianceDepth)
          moment.addAssign(
            emitted.g
              .mul(transmission.g)
              .mul(segmentTransmission(q).g)
              .mul(step)
              .mul(t.add(step.mul(0.5))),
          )
        result.addAssign(
          vec4(
            emitted.rgb.mul(transmission).mul(segmentTransmission(q)),
            emitted.a,
          ).mul(step),
        )
        transmission.mulAssign(q.negate().exp())
        t.addAssign(step)
      })
      return transmissionOnly.select(
        vec4(transmission, 1),
        vec4(
          result.rgb.mul(GALAXY_RADIANCE_FACTOR),
          radianceDepth ? moment.div(result.g.max(1e-30)).min(65000) : result.a,
        ),
      )
    },
  )
}

export interface GalaxyKernelOptions {
  readonly structure?: (p: Node<'vec3'>) => Node<'vec3'>
  /** Physical emission-weighted distance in alpha, for diffuse history only. */
  readonly radianceDepth?: boolean
}

/** Height stays analytic so interpolating the arms cannot move the thin plane. */
export const galaxyWarpHeight = (p: Node<'vec3'>): Node<'float'> =>
  p.y.sub(warp(p.xz.length(), betaAt(p))).abs()

export function createGalaxyKernel(
  field: GalaxyField,
  options: GalaxyKernelOptions = {},
) {
  const structureAt =
    options.structure ?? ((p: Node<'vec3'>) => galaxyStructureAt(p))
  const resolvedOrigin = uniform(new Vector3())
  const resolvedLimit = uniform(0)
  const resolvedMask = uniform(0, 'uint')
  const resolvedCeiling = uniform(0)
  const integrate = createIntegral(
    structureAt,
    options.radianceDepth ?? false,
    resolvedOrigin,
    resolvedLimit,
    resolvedMask,
    resolvedCeiling,
  )
  const seed = uniform(
    deriveSeed(field.seed, 'galaxy-field:young-arms').a,
    'uint',
  )
  const normalization = uniform(field.normalization)
  const dustSeed = uniform(
    deriveSeed(field.seed, 'galaxy-field:dust').a,
    'uint',
  )
  const dustNormalization = uniform(field.dustNormalization * field.dustScale)
  const dustScale = uniform(field.dustScale)
  const ray = (
    origin: Node<'vec3'>,
    direction: Node<'vec3'>,
    distance: number | Node<'float'>,
    sampling: GalaxyRaySampling | Node<'uint'>,
    maxStep: number | Node<'float'>,
    transmissionOnly: boolean,
    pixelAngle: number | Node<'float'>,
  ) =>
    integrate(
      origin,
      direction,
      typeof distance === 'number' ? float(distance) : distance,
      typeof maxStep === 'number' ? float(maxStep) : maxStep,
      typeof sampling === 'string'
        ? uint(sampling === 'reference' ? 0 : sampling === 'observer' ? 1 : 2)
        : sampling,
      seed,
      normalization,
      dustSeed,
      dustNormalization,
      dustScale,
      bool(transmissionOnly),
      typeof pixelAngle === 'number' ? float(pixelAngle) : pixelAngle,
    )
  return {
    setResolved(selection: ResolvedPopulationSelection | undefined) {
      resolvedMask.value = selection?.levelMask ?? 0
      resolvedCeiling.value = coveredLuminosityCeiling(resolvedMask.value)
      resolvedLimit.value =
        selection === undefined
          ? 0
          : populationLimitingLuminosity(1, selection.apparentMagnitudeLimit)
      if (selection !== undefined) {
        const p = UV.approxMeters(selection.origin)
        resolvedOrigin.value.set(p.x / PARSEC, p.y / PARSEC, p.z / PARSEC)
      }
    },
    setField(next: GalaxyField) {
      seed.value = deriveSeed(next.seed, 'galaxy-field:young-arms').a
      normalization.value = next.normalization
      dustSeed.value = deriveSeed(next.seed, 'galaxy-field:dust').a
      dustNormalization.value = next.dustNormalization * next.dustScale
      dustScale.value = next.dustScale
    },
    structure: (p: Node<'vec3'>): Node<'vec4'> =>
      Fn(() => {
        const radius = p.xz.length().toVar(),
          beta = betaAt(p).toVar()
        const total = float(0).toVar()
        for (const arm of arms) total.addAssign(arm(radius, beta).x)
        return vec4(total, warp(radius, beta), 0, 1)
      })(),
    sample: (position: Node<'vec3'>): Node<'vec4'> =>
      sample(
        position,
        seed,
        normalization,
        structureAt(position),
        position.sub(resolvedOrigin).lengthSq().mul(resolvedLimit),
        resolvedMask,
        resolvedCeiling,
      ),
    extinction: (position: Node<'vec3'>): Node<'vec3'> =>
      extinction(
        position,
        dustSeed,
        dustNormalization,
        structureAt(position),
        float(0),
        dustScale,
      ),
    /** `pixelAngle` is `GalaxyRayOptions.pixelAngle`: zero is the exact field along the pixel's center. */
    integrate: (
      origin: Node<'vec3'>,
      direction: Node<'vec3'>,
      distance: number | Node<'float'> = 100000,
      sampling: GalaxyRaySampling | Node<'uint'> = 'observer',
      maxStep: number | Node<'float'> = GALAXY_MAX_STEP_PARSECS,
      pixelAngle: number | Node<'float'> = 0,
    ): Node<'vec4'> =>
      ray(origin, direction, distance, sampling, maxStep, false, pixelAngle),
    transmittance: (
      origin: Node<'vec3'>,
      direction: Node<'vec3'>,
      distance: number | Node<'float'> = 100000,
      sampling: GalaxyRaySampling | Node<'uint'> = 'observer',
      maxStep: number | Node<'float'> = GALAXY_MAX_STEP_PARSECS,
      pixelAngle: number | Node<'float'> = 0,
    ): Node<'vec3'> =>
      ray(origin, direction, distance, sampling, maxStep, true, pixelAngle).rgb,
  }
}
