import type { Meters } from '@inertialref/shared'
import { MIN_STANCE_HEIGHT } from '@inertialref/rendering'

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
 * The sign is dropped below half a meter, and that is not fussiness: the datum
 * plain sits at −0.4 m on Iapetus, which rounds to zero and printed as `−0 m` —
 * a minus sign in front of a zero, in a column where the sign is the whole
 * point of the reading.
 */
export const elevationText = (meters: number): string => {
  const magnitude = Math.abs(meters)
  if (magnitude < 0.5) return '0 m'
  const sign = meters < 0 ? '−' : '+'
  return magnitude >= 1000
    ? `${sign}${(magnitude / 1000).toFixed(1)} km`
    : `${sign}${Math.round(magnitude)} m`
}
