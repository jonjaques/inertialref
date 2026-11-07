/*
 * A slider's position as a gain, and back.
 *
 * Loudness is not linear in gain. A slider that set the gain directly would
 * do nearly everything in its first tenth — halfway along is only 6 dB down,
 * which most people hear as "barely quieter" — and the rest of its travel
 * would be fine adjustment nobody asked for. The square of the position
 * spreads the useful range across the whole travel: halfway is −12 dB,
 * a quarter is −24, a tenth is −40. It is the curve most mixers settle on for
 * the same reason, and its inverse is a square root, so the slider can read
 * back whatever gain it was given.
 */

/** Slider position, 0 to 1, as a linear gain. */
export const gainOf = (level: number): number => {
  const clamped = Math.min(1, Math.max(0, level))
  return clamped * clamped
}

/** A linear gain as a slider position. */
export const levelOf = (gain: number): number =>
  Math.sqrt(Math.min(1, Math.max(0, gain)))

/** A slider position as the decibels it sets, for a screen reader to say. */
export function decibelsOf(level: number): number {
  const gain = gainOf(level)
  return gain === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(gain)
}

/** What a level slider reads: a percentage, with zero said as off. */
export const readLevel = (level: number): string =>
  level <= 0 ? 'off' : `${Math.round(level * 100)}%`

/** What it says aloud: the percentage and the decibels it means. */
export function speakLevel(level: number): string {
  const decibels = decibelsOf(level)
  return Number.isFinite(decibels)
    ? `${Math.round(level * 100)} percent, ${decibels.toFixed(0)} decibels`
    : 'off'
}
