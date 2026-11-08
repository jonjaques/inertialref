import type { Vec3 } from '@inertialref/spatial'

/*
 * The cloud shells' geometry from heights, in float64: the eye's height over
 * every boundary, the stable crossings, and altitude along a ray and at a
 * point. The CPU reference `cloudGeometry.ts` is held to, and the place a
 * crossing is formed from two heights rather than two radii (rule 52).
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

const notYet = (): never => {
  throw new Error('not yet: WP1')
}

export function shellHeights(
  _eyeFromCenter: Vec3,
  _datumRadius: number,
  _boundaries: readonly number[],
): ShellHeights {
  return notYet()
}

/**
 * The distances at which a ray with up-cosine `mu` meets the sphere `eyeOver`
 * below the eye: the stable quadratic of §5.2, or null when it misses. The
 * sign is (b ≥ 0 ? 1 : −1), never `Math.sign`, and t_b = 0 where q = 0, so a
 * level ray from an eye on a boundary is two zeros and not 0/0 (the shader's
 * form is the same).
 */
export function shellCrossings(
  _datumRadius: number,
  _eye: number,
  _eyeOver: number,
  _mu: number,
): readonly [number, number] | null {
  return notYet()
}

/** Height over the datum at distance `t` along that ray (§5.3). */
export function altitudeAlong(
  _datumRadius: number,
  _eye: number,
  _mu: number,
  _t: number,
): number {
  return notYet()
}

/**
 * Height over the datum of an eye-relative point, given its up-component
 * `up = up_e·o` and its squared length `o·o` (§5.3's form with μ·t → up).
 */
export function altitudeAt(
  _datumRadius: number,
  _eye: number,
  _up: number,
  _lengthSquared: number,
): number {
  return notYet()
}

/** The ray's span inside the union of the shells, clipped to [0, stop], or null. */
export function unionSpan(
  _shells: ShellHeights,
  _mu: number,
  _stop: number,
): readonly [number, number] | null {
  return notYet()
}
