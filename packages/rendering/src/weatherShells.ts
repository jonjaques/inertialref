import type { Vec3 } from '@inertialref/spatial'
import { MAX_CLOUD_LAYERS, type WeatherScenario } from './weatherScenario.ts'

/*
 * The cloud shells' geometry from heights, in float64: the eye's height over
 * every boundary, the stable crossings, and altitude along a ray and at a
 * point. The CPU reference `cloudGeometry.ts` is held to, and the place a
 * crossing is formed from two heights rather than two radii (rule 52).
 *
 * Each function takes the shader's own operations in the shader's own order,
 * so where the GPU test compares the two the only difference is the width of
 * the float.
 */

/**
 * The eye's height over every shell boundary, resolved in float64: what a
 * shader forms crossings from, never two radii (rule 52).
 */
export interface ShellHeights {
  /** The datum radius, true meters: the radius the air and the ground measure from. */
  readonly datumRadius: number
  /** The eye over the datum, meters. */
  readonly eye: number
  /**
   * [base₀, top₀, base₁, top₁, base₂, top₂] over the datum, ascending; an
   * absent layer repeats the union's top, so it has zero thickness.
   */
  readonly boundaries: readonly number[]
  /** eye − boundary for each, formed in float64. */
  readonly eyeOver: readonly number[]
}

/** Two boundaries a layer. */
const BOUNDARIES = 2 * MAX_CLOUD_LAYERS

/**
 * A scenario's six boundaries, each layer's base and top in order, an absent
 * layer at the union's top as `cloudUniforms.ts` writes it, so a march that
 * unrolls over all three finds nothing there.
 */
export function shellBoundaries(s: WeatherScenario): readonly number[] {
  const pairs = s.layers
    .slice(0, MAX_CLOUD_LAYERS)
    .flatMap((layer) => [layer.base, layer.top])
  return padBoundaries(pairs)
}

function padBoundaries(given: readonly number[]): readonly number[] {
  const kept = given.slice(0, BOUNDARIES)
  const ceiling = kept.length === 0 ? 0 : Math.max(...kept)
  while (kept.length < BOUNDARIES) kept.push(ceiling)
  return kept
}

/**
 * The eye's heights over `boundaries` (layer pairs, as `shellBoundaries`
 * lays them out; fewer than six are padded at their highest), from its
 * position against the body's center, body-fixed true meters.
 */
export function shellHeights(
  eyeFromCenter: Vec3,
  datumRadius: number,
  boundaries: readonly number[],
): ShellHeights {
  const eye =
    Math.hypot(eyeFromCenter.x, eyeFromCenter.y, eyeFromCenter.z) - datumRadius
  const padded = padBoundaries(boundaries)
  return {
    datumRadius,
    eye,
    boundaries: padded,
    eyeOver: padded.map((boundary) => eye - boundary),
  }
}

/**
 * The distances at which a ray with up-cosine `mu` meets the sphere `eyeOver`
 * below the eye: the stable quadratic of §5.2, or null when it misses. The
 * sign is (b ≥ 0 ? 1 : −1), never `Math.sign`, and t_b = 0 where q = 0, so a
 * level ray from an eye on a boundary is two zeros and not 0/0 (the shader's
 * form is the same).
 */
export function shellCrossings(
  datumRadius: number,
  eye: number,
  eyeOver: number,
  mu: number,
): readonly [number, number] | null {
  // c = (h_e − h_s)(2R + h_e + h_s), the boundary's height recovered from the
  // two heights the uniforms carry; no radius is subtracted from another.
  const boundary = eye - eyeOver
  const b = (datumRadius + eye) * mu
  const c = eyeOver * (2 * datumRadius + eye + boundary)
  const d = b * b - c
  if (!(d >= 0)) return null
  const sigma = b >= 0 ? 1 : -1
  const q = -(b + sigma * Math.sqrt(d))
  const other = q !== 0 ? c / q : 0
  return q <= other ? [q, other] : [other, q]
}

/**
 * h = (h_e(2R + h_e) + 2r_e·u + l²)/(r + R) with r² = R² + that numerator,
 * u being μ·t along a ray or up·o at a point and l² being t² or o·o. The
 * numerator is a sum of heights times radii, so it carries no difference of
 * two radii; r enters only the denominator.
 */
function heightFrom(
  datumRadius: number,
  eye: number,
  up: number,
  lengthSquared: number,
): number {
  const numerator =
    eye * (2 * datumRadius + eye) + (datumRadius + eye) * up * 2 + lengthSquared
  const radius = Math.sqrt(Math.max(datumRadius * datumRadius + numerator, 0))
  return numerator / (radius + datumRadius)
}

/** Height over the datum at distance `t` along that ray (§5.3). */
export function altitudeAlong(
  datumRadius: number,
  eye: number,
  mu: number,
  t: number,
): number {
  return heightFrom(datumRadius, eye, mu * t, t * t)
}

/**
 * Height over the datum of an eye-relative point, given its up-component
 * `up = up_e·o` and its squared length `o·o` (§5.3's form with μ·t → up).
 */
export function altitudeAt(
  datumRadius: number,
  eye: number,
  up: number,
  lengthSquared: number,
): number {
  return heightFrom(datumRadius, eye, up, lengthSquared)
}

/**
 * The ray's span inside the union of the shells, clipped to [0, stop], or null.
 *
 * `cloudRay`'s rule, in its order: the lowest base's sphere to the highest
 * top's, entered at 0 from inside, where it leaves the base's sphere from
 * below and where it meets the top's from above, and stopped at the datum
 * ahead of an eye over it. A ray that dips under the base and comes back up
 * is held to its first interval.
 */
export function unionSpan(
  shells: ShellHeights,
  mu: number,
  stop: number,
): readonly [number, number] | null {
  const { datumRadius, eye, eyeOver } = shells
  const lowest = eyeOver[0] ?? 0
  const highest = eyeOver[eyeOver.length - 1] ?? 0
  const top = shellCrossings(datumRadius, eye, highest, mu)
  const insideTop = highest <= 0
  // An eye inside a sphere always meets it, so with neither of these there
  // is no union ahead at all.
  if (top === null) return null
  const base = shellCrossings(datumRadius, eye, lowest, mu)
  const entry = lowest < 0 && base !== null ? base[1] : insideTop ? 0 : top[0]
  const exit = base !== null && base[0] > entry ? base[0] : top[1]
  const ground = shellCrossings(datumRadius, eye, eye, mu)
  const floorAhead = eye > 0 && ground !== null && ground[0] > 0
  const start = Math.max(entry, 0)
  const end = Math.min(exit, stop, floorAhead ? ground[0] : Infinity)
  return end > start ? [start, end] : null
}
