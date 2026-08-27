import { MIN_STANCE_HEIGHT } from '@inertialref/rendering'
import type { Meters } from '@inertialref/shared'

/*
 * The Surface panel's vocabulary, in a `.ts` because its neighbor is a `.tsx`.
 *
 * `react/no-multi-comp` is an error here and a `.tsx` that exports anything but
 * components is a file Fast Refresh gives up on — which in this app means a full
 * reload, a rebuilt `WebGPURenderer` and a lost camera. Same rule as
 * `layers.ts` and `presets.ts`, applied to this panel's own words.
 */

/** A named rung on the descent, in meters above the ground. */
export interface DescentRung {
  readonly label: string
  /**
   * Height above the ground. `null` means the top of the band, which depends on
   * the body — see `surfaceHeightBounds`, whose ceiling is the orbit arm's
   * floor and is therefore 3,186 km at Earth and 118 km at Miranda.
   */
  readonly height: Meters | null
  readonly why: string
}

/**
 * Five rungs, chosen by what is legible from each rather than by round numbers.
 *
 * The slider covers the whole band continuously; these are for arriving
 * somewhere specific in one press, and for a capture script that wants the same
 * five heights on every body. `Ground` is `MIN_STANCE_HEIGHT` — eye height, and
 * the bottom the terrain milestone has to hold up at.
 */
export const DESCENT_RUNGS: readonly DescentRung[] = [
  {
    label: 'Ground',
    // The constant, not the number it currently is. `clampStanceHeight` lifts
    // anything below it silently, so a literal here would leave the rung
    // labelled "the bottom of the range" naming something else the first time
    // the near plane moves.
    height: MIN_STANCE_HEIGHT,
    why: 'eye height — the bottom of the range',
  },
  { label: 'Low', height: 120, why: 'above the rocks, below the ridgeline' },
  { label: 'Pass', height: 2_000, why: 'a low pass over a mountain range' },
  { label: 'Approach', height: 40_000, why: 'the horizon curves' },
  {
    label: 'Top',
    height: null,
    why: 'as high as this arm goes — a disk again',
  },
]

/** The eight points of the compass, as headings in degrees. */
export const COMPASS: readonly {
  readonly label: string
  readonly deg: number
}[] = [
  { label: 'N', deg: 0 },
  { label: 'NE', deg: 45 },
  { label: 'E', deg: 90 },
  { label: 'SE', deg: 135 },
  { label: 'S', deg: 180 },
  { label: 'SW', deg: 225 },
  { label: 'W', deg: 270 },
  { label: 'NW', deg: 315 },
]

/**
 * A signed elevation, in the units the panel reads at.
 *
 * The unit is chosen against the *rounded* magnitude rather than the raw one,
 * and the sign against the result. Both are the same rule: what is printed
 * decides, not what was measured. Choosing on the raw value puts `+1000 m` in
 * a column beside `+1.0 km` for two readings 0.3 m apart, and taking the sign
 * from the raw value puts `−0 m` under a site button — a minus in front of a
 * zero, in a column where the sign is the whole point of the reading. The datum
 * plain on Iapetus sits at −0.4 m, so that one is not hypothetical.
 *
 * A non-finite reading prints as no reading. It arrives from a body resolved
 * mid-save-load, and `+NaN m` under a site button is worse than a dash.
 */
export const elevationText = (meters: number): string => {
  if (!Number.isFinite(meters)) return '—'
  const magnitude = Math.abs(meters)
  if (magnitude < 0.5) return '0 m'
  const sign = meters < 0 ? '−' : '+'
  return magnitude >= 999.5
    ? `${sign}${(magnitude / 1000).toFixed(1)} km`
    : `${sign}${Math.round(magnitude)} m`
}
