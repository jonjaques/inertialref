import {
  invariant,
  type Meters,
  type Mu,
  type Seconds,
} from '@inertialref/shared'
import { Vec } from '@inertialref/spatial'
import { orbitalPeriod, type StateVector } from './kepler.ts'

/*
 * Two-body propagation in universal variables.
 *
 * `stateVectorAt` answers "where is a body on *these elements* at time t", for
 * the ellipses the catalog carries. A ship is the other shape of the same
 * question: it has a state rather than elements, and the conic that state lies
 * on is whatever the last burn left it on — an ellipse, an escape hyperbola,
 * or the parabola between them. The universal-variable formulation (Battin;
 * Vallado's "Kepler" algorithm) covers all three with one iteration and no
 * branch on eccentricity, which is what makes it the right shape for a thing
 * that is not a planet.
 *
 * What makes it usable as a *propagator* here is that it is a pure function of
 * the epoch state and the elapsed time, never of the path taken. Two hosts
 * that agree on the epoch and ask for tick 10^9 agree to the bit whether one
 * stepped through the intervening ticks or jumped them — which is what puts a
 * coasting ship on rails (ADR-0025) without giving up the determinism the
 * fixed step exists for.
 */

/**
 * Stumpff functions c₂(ψ) and c₃(ψ), for any sign of ψ.
 *
 * The closed forms lose digits to cancellation near zero — `(1 − cos √ψ)/ψ`
 * keeps about six of sixteen at ψ = 10⁻⁶ — and a parabola sits exactly there.
 * Below 10⁻³ the five-term series is exact to 10⁻¹⁷, and the closed forms have
 * their full precision back above it.
 */
function stumpff(psi: number): { c2: number; c3: number } {
  if (Math.abs(psi) < 1e-3) {
    const p2 = psi * psi
    const p3 = p2 * psi
    const p4 = p2 * p2
    return {
      c2: 1 / 2 - psi / 24 + p2 / 720 - p3 / 40_320 + p4 / 3_628_800,
      c3: 1 / 6 - psi / 120 + p2 / 5_040 - p3 / 362_880 + p4 / 39_916_800,
    }
  }
  if (psi > 0) {
    const s = Math.sqrt(psi)
    return { c2: (1 - Math.cos(s)) / psi, c3: (s - Math.sin(s)) / (s * psi) }
  }
  const s = Math.sqrt(-psi)
  return { c2: (1 - Math.cosh(s)) / psi, c3: (Math.sinh(s) - s) / (s * -psi) }
}

/** The dimensionless size of `α·r₀` below which a conic is treated as a parabola. */
const PARABOLIC = 1e-6

/**
 * Where a state is `dt` seconds later, under one point mass at the origin.
 *
 * `mu = 0` is the straight line: deep space between systems has no attractor,
 * and a coasting ship there is the simplest rails there are.
 *
 * An ellipse's elapsed time is reduced modulo its period first. The universal
 * anomaly grows without bound over many revolutions and the f-and-g series
 * lose precision with it, while the reduced time gives the same answer at
 * full precision — a year of warp over a ninety-minute orbit is several
 * thousand revolutions, and the ship has to land on the same meter either way.
 */
export function propagateTwoBody(
  state: StateVector,
  mu: Mu,
  dt: Seconds,
): StateVector {
  if (dt === 0) return state
  if (mu === 0) {
    return {
      position: Vec.add(state.position, Vec.scale(state.velocity, dt)),
      velocity: state.velocity,
    }
  }
  const r0 = state.position
  const v0 = state.velocity
  const r0m = Vec.length(r0)
  invariant(r0m > 0, 'propagateTwoBody: zero radius')
  const sqrtMu = Math.sqrt(mu)
  const rdotv = Vec.dot(r0, v0)
  const sigma = rdotv / sqrtMu
  // The reciprocal semi-major axis: positive bound, negative hyperbolic, zero
  // parabolic. Written from r and v directly rather than through the energy,
  // so the sign is decided by one subtraction rather than two.
  const alpha = 2 / r0m - Vec.lengthSquared(v0) / mu
  const alphaR = alpha * r0m

  let t = dt
  if (alphaR > PARABOLIC) {
    // The element form's own period, so a whole number of revolutions means
    // the same thing here as it does to `stateVectorAt`.
    const period = orbitalPeriod(mu, 1 / alpha)
    t = dt - period * Math.floor(dt / period)
    if (t === 0) return state
  }

  const conic: Conic = { t, alpha, alphaR, r0m, sigma, sqrtMu }
  const chi = solveUniversal(conic, initialGuess(conic, r0, v0, mu))
  const psi = chi * chi * alpha
  const { c2, c3 } = stumpff(psi)
  const r = chi * chi * c2 + sigma * chi * (1 - psi * c3) + r0m * (1 - psi * c2)

  const f = 1 - ((chi * chi) / r0m) * c2
  const g = t - ((chi * chi * chi) / sqrtMu) * c3
  const gDot = 1 - ((chi * chi) / r) * c2
  const fDot = (sqrtMu / (r * r0m)) * chi * (psi * c3 - 1)
  return {
    position: Vec.add(Vec.scale(r0, f), Vec.scale(v0, g)),
    velocity: Vec.add(Vec.scale(r0, fDot), Vec.scale(v0, gDot)),
  }
}

/**
 * The scalars of one propagation, shared by the solver and its starting guess.
 *
 * `alphaR` is `alpha · r0m` and `sqrtMu` is `√μ`; carried rather than derived
 * so the two are computed once, and named so that a call site cannot
 * transpose two same-typed numbers the checker would wave through.
 */
interface Conic {
  readonly t: Seconds
  readonly alpha: number
  readonly alphaR: number
  readonly r0m: Meters
  readonly sigma: number
  readonly sqrtMu: number
}

/**
 * The universal anomaly χ that lands `t` seconds along the conic.
 *
 * Newton–Raphson from the starting guess for the conic's kind, bracketed. The
 * equation is `F(χ) = √μ·t − χ³c₃ − σχ²c₂ − r₀χ(1 − ψc₃)` with `F' = −r`, and
 * `r` is a radius, so `F` is strictly decreasing and the root is unique — which
 * is what lets a Newton step that leaves the bracket be replaced by a
 * bisection, exactly as `bracketedKepler` does for the eccentric anomaly. A
 * plain Newton iteration overshoots near the periapsis of a very eccentric
 * orbit, where `r` is small and the step `F/r` is not.
 */
function solveUniversal(conic: Conic, guess: number): number {
  const { t, alpha, alphaR, r0m, sigma, sqrtMu } = conic
  let chi = guess
  // The root has the sign of t: χ is monotonic in time and zero at the epoch.
  let lo = t > 0 ? 0 : -Infinity
  let hi = t > 0 ? Infinity : 0
  // An ellipse's reduced time is under one period, so its anomaly is under
  // one circuit: 2π√a. That closes the bracket from the start.
  if (alphaR > PARABOLIC) {
    if (t > 0) hi = (2 * Math.PI) / Math.sqrt(alpha)
    else lo = -(2 * Math.PI) / Math.sqrt(alpha)
  }
  if (!(chi > lo && chi < hi)) chi = bisect(lo, hi)
  // The size of the last step taken, for the safeguard below.
  let previous = Infinity

  for (let i = 0; i < 100; i += 1) {
    const psi = chi * chi * alpha
    const { c2, c3 } = stumpff(psi)
    const r =
      chi * chi * c2 + sigma * chi * (1 - psi * c3) + r0m * (1 - psi * c2)
    const residual =
      sqrtMu * t -
      chi * chi * chi * c3 -
      sigma * chi * chi * c2 -
      r0m * chi * (1 - psi * c3)
    if (residual > 0) lo = Math.max(lo, chi)
    else hi = Math.min(hi, chi)
    /*
     * Converged when the *equation* is satisfied, never when the step is
     * small.
     *
     * The Newton step is `residual / r`, and `r` is the radius the propagation
     * lands at — 6 × 10¹⁰ m a hundred days along a hyperbola out of low Earth
     * orbit. So a residual still worth 176 in the units this equation is
     * written in divides down to a step of 2.9 × 10⁻⁹, slips under any
     * tolerance scaled to `chi`, and returns an anomaly one iteration short.
     * Measured on exactly that case: a relative residual of 8.8 × 10⁻¹³ where
     * the times either side of it reach 10⁻¹⁷, and 4.6 × 10⁻⁹ of angular
     * momentum quietly gone. A far propagation is both where this matters and
     * where the step is least able to report it.
     *
     * The scale is what the residual is a difference *of*, so the test says
     * "no significant digits left in it" rather than naming an epsilon.
     */
    const scale = Math.abs(sqrtMu * t) + r0m * Math.abs(chi)
    if (Math.abs(residual) <= 1e-15 * scale) return chi
    /*
     * A Newton step is taken only while it stays in the bracket *and* is at
     * least halving the step before it; otherwise the bracket is bisected.
     *
     * Staying in the bracket is not enough on the hyperbolic side. There `F`
     * grows like e^{χ√−α}, so from a χ that is far too large every Newton
     * step back is the same 1/√−α — 41,846 for an escape at a hair over
     * parabolic from 1.1 Earth radii — and a first step that overshot by
     * 5 × 10⁶ needs a hundred and twenty of them. The loop's cap returned the
     * hundredth, a radius of 10¹⁵ Earth radii for a ship doing 477 m/s, and
     * the property that caught it had one chance in thirty thousand of
     * drawing the state. Halving the bracket instead reaches the root's own
     * 1/√−α in a handful of iterations, and Newton is quadratic from there.
     */
    const newton = residual / r
    const next = chi + newton
    const stepped =
      Number.isFinite(next) &&
      next > lo &&
      next < hi &&
      Math.abs(newton) <= previous / 2
        ? next
        : bisect(lo, hi)
    // Nothing representable left to gain: the root lies between two adjacent
    // doubles, and iterating would return this same pair forever.
    if (stepped === chi) return chi
    previous = Math.abs(stepped - chi)
    chi = stepped
    if (hi - lo <= 1e-15 * Math.max(1, Math.abs(chi))) return chi
  }
  return chi
}

/** The midpoint of a bracket, or a doubling step out of a half-open one. */
function bisect(lo: number, hi: number): number {
  if (Number.isFinite(lo) && Number.isFinite(hi)) return (lo + hi) / 2
  if (Number.isFinite(lo)) return lo === 0 ? 1 : lo * 2
  if (Number.isFinite(hi)) return hi === 0 ? -1 : hi * 2
  return 0
}

/**
 * Vallado's starting guesses, one per conic. A guess that comes back
 * non-finite — a radial parabola has no `p` to take a root of, and a
 * hyperbola's logarithm can be asked of a non-positive argument — falls back
 * to the bracket, which the solver then bisects into.
 */
function initialGuess(
  conic: Conic,
  r0: StateVector['position'],
  v0: StateVector['velocity'],
  mu: Mu,
): number {
  const { t, alpha, alphaR, r0m, sigma, sqrtMu } = conic
  if (alphaR > PARABOLIC) return sqrtMu * t * alpha
  if (alphaR < -PARABOLIC) {
    const a = 1 / alpha
    const sign = t < 0 ? -1 : 1
    const numerator = -2 * mu * alpha * t
    const denominator =
      sigma * sqrtMu + sign * Math.sqrt(-mu * a) * (1 - r0m * alpha)
    return sign * Math.sqrt(-a) * Math.log(numerator / denominator)
  }
  const h = Vec.length(Vec.cross(r0, v0))
  const p = (h * h) / mu
  const s = 0.5 * Math.atan(1 / (3 * Math.sqrt(mu / (p * p * p)) * t))
  const w = Math.atan(Math.cbrt(Math.tan(s)))
  return (Math.sqrt(p) * 2) / Math.tan(2 * w)
}

/**
 * The shape of the conic a state lies on, in the three numbers a flight
 * controller needs: how low it goes, how fast it gets there, and whether it
 * comes back.
 */
export interface ConicShape {
  /** Closest approach to the attractor's center, meters. Zero for a radial fall. */
  readonly periapsis: Meters
  /** Eccentricity: under one bound, one parabolic, above one hyperbolic. */
  readonly eccentricity: number
  /**
   * Speed at periapsis, which bounds the speed everywhere on the conic. This is
   * what a sphere-of-influence check is skipped against: a ship cannot close a
   * gap faster than this, so a gap divided by it is a time nothing can happen in.
   * `Infinity` for a radial fall, whose speed is unbounded at the center.
   */
  readonly periapsisSpeed: number
}

export function conicOf(state: StateVector, mu: Mu): ConicShape {
  invariant(mu > 0, 'conicOf: a conic needs an attractor')
  const r = Vec.length(state.position)
  invariant(r > 0, 'conicOf: zero radius')
  const h = Vec.length(Vec.cross(state.position, state.velocity))
  const energy = Vec.lengthSquared(state.velocity) / 2 - mu / r
  // e² = 1 + 2εh²/μ², clamped: a circular orbit computes to a hair under zero.
  const eccentricity = Math.sqrt(
    Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)),
  )
  const periapsis = (h * h) / mu / (1 + eccentricity)
  return {
    periapsis,
    eccentricity,
    periapsisSpeed: h === 0 ? Infinity : h / periapsis,
  }
}
