/** Reid et al. 2019, Table 2; angles increase with rotation from the Sun's direction. */
export interface GalaxyArm {
  readonly id: string
  readonly kinkDegrees: number
  readonly kinkRadiusParsecs: number
  readonly pitchBeforeDegrees: number
  readonly pitchAfterDegrees: number
  readonly startDegrees: number
  readonly endDegrees: number
}
const DEG = Math.PI / 180
const TAU = 2 * Math.PI

/**
 * The near-3kpc radius and the two quadrant-IV pitches are calibrated within
 * Reid's 1σ intervals to Hou & Han 2014 Table 2's median tangencies. All other
 * fitted parameters retain Reid's values. Unmeasured far-side joins are a model.
 */
export const GALAXY_ARMS: readonly GalaxyArm[] = Object.freeze(
  [
    {
      id: 'near-3kpc',
      kinkDegrees: 15,
      kinkRadiusParsecs: 3300,
      pitchBeforeDegrees: -4.2,
      pitchAfterDegrees: -4.2,
      startDegrees: -100,
      endDegrees: 100,
    },
    {
      id: 'norma-outer',
      kinkDegrees: 18,
      kinkRadiusParsecs: 4460,
      pitchBeforeDegrees: -1,
      pitchAfterDegrees: 19.5,
      startDegrees: -540,
      endDegrees: 100,
    },
    {
      id: 'scutum-centaurus',
      kinkDegrees: 23,
      kinkRadiusParsecs: 4910,
      pitchBeforeDegrees: 12.4,
      pitchAfterDegrees: 12.1,
      startDegrees: -440,
      endDegrees: 155,
    },
    {
      id: 'sagittarius-carina',
      kinkDegrees: 24,
      kinkRadiusParsecs: 6040,
      pitchBeforeDegrees: 18.7,
      pitchAfterDegrees: 1,
      startDegrees: -240,
      endDegrees: 150,
    },
    {
      id: 'local',
      kinkDegrees: 9,
      kinkRadiusParsecs: 8260,
      pitchBeforeDegrees: 11.4,
      pitchAfterDegrees: 11.4,
      startDegrees: -25,
      endDegrees: 70,
    },
    {
      id: 'perseus',
      kinkDegrees: 40,
      kinkRadiusParsecs: 8870,
      pitchBeforeDegrees: 10.3,
      pitchAfterDegrees: 8.7,
      startDegrees: -240,
      endDegrees: 155,
    },
  ].map((arm) => Object.freeze(arm)),
)

const logSpiral = (
  radius: number,
  kink: number,
  before: number,
  after: number,
  beta: number,
): number =>
  Math.log(radius) -
  (beta - kink * DEG) * Math.tan((beta <= kink * DEG ? before : after) * DEG)

/** Radius of an arm at an unwrapped azimuth, in galactic-center frame parsecs. */
export function armRadius(arm: GalaxyArm, beta: number): number {
  if (arm.id !== 'norma-outer' || beta >= -100 * DEG)
    return Math.exp(
      logSpiral(
        arm.kinkRadiusParsecs,
        arm.kinkDegrees,
        arm.pitchBeforeDegrees,
        arm.pitchAfterDegrees,
        beta,
      ),
    )
  // Norma and Outer share a winding. A C1 join in log radius avoids two
  // overlapping independent arms, and leaves both measured arcs untouched.
  if (beta <= -240 * DEG)
    return Math.exp(logSpiral(12240, 18, 3, 9.4, beta + TAU))
  const left = -240 * DEG
  const span = 140 * DEG
  const t = (beta - left) / span
  const a = logSpiral(12240, 18, 3, 9.4, left + TAU)
  const b = logSpiral(4460, 18, -1, 19.5, -100 * DEG)
  const value =
    (2 * t ** 3 - 3 * t * t + 1) * a +
    (t ** 3 - 2 * t * t + t) * span * -Math.tan(9.4 * DEG) +
    (-2 * t ** 3 + 3 * t * t) * b +
    (t ** 3 - t * t) * span * -Math.tan(-DEG)
  return Math.exp(value)
}

const smooth = (t: number): number => {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

/** Smooth ridge sum; no field value is selected by nearest-arm identity. */
export function armStrength(radius: number, beta: number): number {
  let sum = 0
  for (const arm of GALAXY_ARMS) {
    const width =
      arm.id === 'local'
        ? 310
        : Math.max(140, 336 + 36 * (radius / 1000 - 8.15))
    for (let turn = -2; turn <= 1; turn++) {
      const angle = beta + turn * TAU
      const degrees = angle / DEG
      if (degrees <= arm.startDegrees || degrees >= arm.endDegrees) continue
      const ridge = armRadius(arm, angle)
      // The centerline may kink, but its transverse profile must not jump.
      // Blend the width projection across ±1° without moving the measured curve.
      const blend = smooth((degrees - arm.kinkDegrees + 1) / 2)
      const pitch =
        (arm.pitchBeforeDegrees +
          blend * (arm.pitchAfterDegrees - arm.pitchBeforeDegrees)) *
        DEG
      const distance = (radius - ridge) * Math.cos(pitch)
      const ends =
        smooth((degrees - arm.startDegrees) / 15) *
        smooth((arm.endDegrees - degrees) / 15)
      sum += ends * Math.exp(-0.5 * (distance / width) ** 2)
    }
  }
  return sum
}

/** Tangent roots from the curve's derivative, independent of the field's ridge sampler. */
export function armTangencies(arm: GalaxyArm): readonly number[] {
  const tangent = (beta: number): number => {
    const r = armRadius(arm, beta)
    const dr =
      (armRadius(arm, beta + 1e-5) - armRadius(arm, beta - 1e-5)) / 2e-5
    return r * r - 8178 * (r * Math.cos(beta) + dr * Math.sin(beta))
  }
  const out: number[] = []
  let previous = (arm.startDegrees + 1) * DEG
  for (
    let degrees = arm.startDegrees + 1.25;
    degrees < arm.endDegrees - 1;
    degrees += 0.25
  ) {
    const beta = degrees * DEG
    if (tangent(previous) * tangent(beta) < 0) {
      let lo = previous,
        hi = beta
      for (let i = 0; i < 35; i++) {
        const mid = (lo + hi) / 2
        if (tangent(lo) * tangent(mid) <= 0) hi = mid
        else lo = mid
      }
      const b = (lo + hi) / 2,
        r = armRadius(arm, b)
      out.push(
        (Math.atan2(r * Math.sin(b), 8178 - r * Math.cos(b)) / DEG + 360) % 360,
      )
    }
    previous = beta
  }
  return out
}
