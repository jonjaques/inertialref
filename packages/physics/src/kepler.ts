import {
  invariant,
  type Meters,
  type Mu,
  type Radians,
  type Seconds,
} from '@inertialref/shared'
import { Quaternion as Q, type Vec3, vec3 } from '@inertialref/spatial'
import { astroToSim, simToAstro } from './frameConvention.ts'

/*
 * Two-body Keplerian motion.
 *
 * Orbits are analytic, not integrated. Two reasons, both structural:
 *
 *   - Determinism. An analytic orbit is a pure function of time, so the state
 *     of the universe at tick 10^9 does not depend on having stepped through
 *     the preceding 10^9 ticks. Time warp, save/load and joining a session
 *     mid-flight all become trivial, and none of them accumulate drift.
 *   - Streaming. A system that is not loaded still has to answer "where is your
 *     third planet right now?" for the map and for interest management.
 *
 * N-body perturbation, where it eventually matters, belongs on top of this as a
 * correction to the elements, not as a replacement for it.
 */

export interface OrbitalElements {
  /** Semi-major axis, meters. */
  readonly semiMajorAxis: Meters
  /** Eccentricity, 0 ≤ e < 1. Hyperbolic trajectories are not modeled here. */
  readonly eccentricity: number
  /** Inclination from the reference plane, radians. */
  readonly inclination: Radians
  /** Longitude of the ascending node, radians. */
  readonly longitudeOfAscendingNode: Radians
  /** Argument of periapsis, radians. */
  readonly argumentOfPeriapsis: Radians
  /** Mean anomaly at the epoch, radians. */
  readonly meanAnomalyAtEpoch: Radians
  /** Simulation time the mean anomaly is quoted at, seconds. */
  readonly epoch: Seconds
}

export interface StateVector {
  readonly position: Vec3
  readonly velocity: Vec3
}

export const meanMotion = (mu: Mu, semiMajorAxis: Meters): number =>
  Math.sqrt(mu / (semiMajorAxis * semiMajorAxis * semiMajorAxis))

export const orbitalPeriod = (mu: Mu, semiMajorAxis: Meters): Seconds =>
  (2 * Math.PI) / meanMotion(mu, semiMajorAxis)

/** Vis-viva: speed at radius r on an orbit of semi-major axis a. */
export const visViva = (mu: Mu, r: Meters, semiMajorAxis: Meters): number =>
  Math.sqrt(mu * (2 / r - 1 / semiMajorAxis))

export const circularSpeed = (mu: Mu, r: Meters): number => Math.sqrt(mu / r)

export const escapeSpeed = (mu: Mu, r: Meters): number =>
  Math.sqrt((2 * mu) / r)

/**
 * Radius of the sphere of influence of a body orbiting a primary.
 *
 * The simulation uses this to decide when an approaching ship should be
 * re-framed onto a planet, so it is physics rather than a rendering heuristic.
 */
export function sphereOfInfluence(
  semiMajorAxis: Meters,
  bodyMass: number,
  primaryMass: number,
): Meters {
  return semiMajorAxis * (bodyMass / primaryMass) ** (2 / 5)
}

/**
 * Solve Kepler's equation M = E − e·sin E for the eccentric anomaly.
 *
 * Newton–Raphson from a Danby-style starting guess. The guess matters: plain
 * E₀ = M needs many iterations near e → 1 and can oscillate, and this runs once
 * per body per resolved frame, which is several hundred times a tick when a
 * system is loaded.
 */
export function solveKepler(
  meanAnomaly: Radians,
  eccentricity: number,
  tolerance = 1e-12,
): Radians {
  invariant(
    eccentricity >= 0 && eccentricity < 1,
    `solveKepler expects an elliptical orbit, got e=${eccentricity}`,
  )
  const M = normalizeAngle(meanAnomaly)
  if (eccentricity < 1e-12) return M

  let E = M + eccentricity * Math.sin(M) * (1 + eccentricity * Math.cos(M))
  for (let i = 0; i < 30; i += 1) {
    const f = E - eccentricity * Math.sin(E) - M
    const fPrime = 1 - eccentricity * Math.cos(E)
    const delta = f / fPrime
    E -= delta
    if (Math.abs(delta) < tolerance) return E
  }
  return E
}

/** Wrap to [0, 2π). */
export function normalizeAngle(angle: Radians): Radians {
  const twoPi = 2 * Math.PI
  const wrapped = angle % twoPi
  return wrapped < 0 ? wrapped + twoPi : wrapped
}

export function trueAnomalyFromEccentric(
  E: Radians,
  eccentricity: number,
): Radians {
  return (
    2 *
    Math.atan2(
      Math.sqrt(1 + eccentricity) * Math.sin(E / 2),
      Math.sqrt(1 - eccentricity) * Math.cos(E / 2),
    )
  )
}

export function meanAnomalyAt(
  elements: OrbitalElements,
  mu: Mu,
  t: Seconds,
): Radians {
  return normalizeAngle(
    elements.meanAnomalyAtEpoch +
      meanMotion(mu, elements.semiMajorAxis) * (t - elements.epoch),
  )
}

/** Rotation taking perifocal axes into simulation axes. */
function orbitOrientation(elements: OrbitalElements): Q.Quat {
  // Classical Z-up chain: Rz(Ω) · Rx(i) · Rz(ω). Converted to sim axes by the
  // caller via astroToSim, so this stays comparable to any textbook.
  const zAxis = vec3(0, 0, 1)
  const xAxis = vec3(1, 0, 0)
  return Q.multiply(
    Q.multiply(
      Q.fromAxisAngle(zAxis, elements.longitudeOfAscendingNode),
      Q.fromAxisAngle(xAxis, elements.inclination),
    ),
    Q.fromAxisAngle(zAxis, elements.argumentOfPeriapsis),
  )
}

/** Position and velocity relative to the primary, in simulation axes. */
export function stateVectorAt(
  elements: OrbitalElements,
  mu: Mu,
  t: Seconds,
): StateVector {
  const { semiMajorAxis: a, eccentricity: e } = elements
  const E = solveKepler(meanAnomalyAt(elements, mu, t), e)
  const nu = trueAnomalyFromEccentric(E, e)
  const r = a * (1 - e * Math.cos(E))
  const p = a * (1 - e * e)
  const speedScale = Math.sqrt(mu / p)

  const perifocalPosition = vec3(r * Math.cos(nu), r * Math.sin(nu), 0)
  const perifocalVelocity = vec3(
    -speedScale * Math.sin(nu),
    speedScale * (e + Math.cos(nu)),
    0,
  )

  const rotation = orbitOrientation(elements)
  return {
    position: astroToSim(Q.rotate(rotation, perifocalPosition)),
    velocity: astroToSim(Q.rotate(rotation, perifocalVelocity)),
  }
}

/**
 * Recover elements from a state vector.
 *
 * Used by the round-trip tests, by trajectory readouts in the HUD, and
 * eventually by anything that puts a ship into an orbit it did not start in.
 */
export function elementsFromStateVector(
  state: StateVector,
  mu: Mu,
  t: Seconds,
): OrbitalElements {
  const r = simToAstro(state.position)
  const v = simToAstro(state.velocity)
  const rMag = Math.hypot(r.x, r.y, r.z)
  const vMag = Math.hypot(v.x, v.y, v.z)
  invariant(rMag > 0, 'elementsFromStateVector: zero radius')

  // Specific angular momentum; its direction fixes the orbital plane.
  const h = vec3(
    r.y * v.z - r.z * v.y,
    r.z * v.x - r.x * v.z,
    r.x * v.y - r.y * v.x,
  )
  const hMag = Math.hypot(h.x, h.y, h.z)
  invariant(hMag > 0, 'elementsFromStateVector: degenerate (radial) trajectory')

  // Everything below is atan2/hypot rather than acos. acos is ill-conditioned
  // where its argument approaches ±1 — precisely at periapsis, apoapsis and
  // low inclination, which is most of what this game contains — and costs about
  // half the available digits there (~1e-8 relative). atan2 keeps full double
  // precision across the whole domain.
  const semiLatusRectum = (hMag * hMag) / mu
  const radialRate = (r.x * v.x + r.y * v.y + r.z * v.z) / rMag

  // From the conic equation: e·cos ν = p/r − 1, and ṙ = √(μ/p)·e·sin ν.
  const eCos = semiLatusRectum / rMag - 1
  const eSin = radialRate * Math.sqrt(semiLatusRectum / mu)
  const e = Math.hypot(eSin, eCos)
  const nu = Math.atan2(eSin, eCos)

  const energy = (vMag * vMag) / 2 - mu / rMag
  const a = -mu / (2 * energy)

  const hxy = Math.hypot(h.x, h.y)
  const inclination = Math.atan2(hxy, h.z)

  // Ω from the node vector n = ẑ × h = (−h.y, h.x, 0). For an equatorial orbit
  // the node is undefined; pin it to zero and let ω absorb the freedom, so the
  // round trip still reproduces the state exactly.
  const equatorial = hxy < 1e-12 * hMag
  const raan = equatorial ? 0 : Math.atan2(h.x, -h.y)

  // Argument of latitude: the angle from the ascending node to r, measured in
  // the orbital plane. ω is what is left after removing the true anomaly.
  const cosRaan = Math.cos(raan)
  const sinRaan = Math.sin(raan)
  const alongNode = r.x * cosRaan + r.y * sinRaan
  const acrossNode = equatorial
    ? r.y * cosRaan - r.x * sinRaan
    : r.z / Math.sin(inclination)
  const argumentOfLatitude = Math.atan2(acrossNode, alongNode)

  const E =
    2 *
    Math.atan2(
      Math.sqrt(1 - e) * Math.sin(nu / 2),
      Math.sqrt(1 + e) * Math.cos(nu / 2),
    )
  const M = normalizeAngle(E - e * Math.sin(E))

  return {
    semiMajorAxis: a,
    eccentricity: e,
    inclination,
    longitudeOfAscendingNode: normalizeAngle(raan),
    argumentOfPeriapsis: normalizeAngle(argumentOfLatitude - nu),
    meanAnomalyAtEpoch: M,
    epoch: t,
  }
}

export const periapsis = (elements: OrbitalElements): Meters =>
  elements.semiMajorAxis * (1 - elements.eccentricity)

export const apoapsis = (elements: OrbitalElements): Meters =>
  elements.semiMajorAxis * (1 + elements.eccentricity)
