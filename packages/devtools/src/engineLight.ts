/*
 * `ir.lightEngine`: a drive lit at a held throttle, for a stance that needs
 * something drawn over the clouds (the measurement runner's `overlay`).
 *
 * A presentation hold, like the track overlay's switch: the harness keeps
 * the throttle and the host reads it once a rendered frame. It never reaches
 * the world. `ir.throttle` would light the real drive, and a lit drive
 * accelerates the ship, so the stance would drift between samples and the
 * state hash a rig compares would move; the plume a measurement wants is the
 * drawn one alone. The host stands it in front of the lens, because the
 * stances that ask for it are cameras on the ground, nowhere near the ship.
 *
 * The verb's type is spelled where it is returned, not named: the harness
 * holds it as a public field, and TypeDoc refuses a public signature that
 * names a type the package's entry does not export.
 */

/**
 * The verb: light the drive at `on`'s throttle (`true` is full), or release
 * it with `false`; it returns the held throttle, null once released. Its
 * `throttle` is what the host reads once a rendered frame.
 */
export function engineLight(): ((on?: boolean | number) => number | null) & {
  /** The held throttle, 0..1, or null once released. */
  readonly throttle: number | null
} {
  let held: number | null = null
  const light = (on: boolean | number = true): number | null => {
    if (typeof on === 'number' && !Number.isFinite(on))
      throw new Error('A throttle is a finite number, 0..1.')
    held = on === false ? null : on === true ? 1 : Math.min(1, Math.max(0, on))
    return held
  }
  return Object.defineProperty(light, 'throttle', {
    get: () => held,
    enumerable: true,
  }) as typeof light & { readonly throttle: number | null }
}
