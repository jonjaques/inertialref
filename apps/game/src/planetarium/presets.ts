import { Circle, type LucideIcon } from 'lucide-react'
import { DEFAULT_FILL } from '@inertialref/devtools'
import {
  PhaseCrescent,
  PhaseGibbous,
  PhaseHalf,
  PhaseRim,
} from '../icons/index.tsx'

/*
 * Light, distance and whole compositions — as data.
 *
 * Its own module because `PresetsPanel.tsx` must export components and nothing
 * else, or Fast Refresh gives up on the file. The lists are also the kind of
 * thing that gets edited without touching the component at all, which is most
 * of the point: a composition is an editorial judgement and adding one should
 * be a line here.
 *
 * The two angles are the photographer's, and they are the same pair
 * `devtools/src/shots.ts` uses for the flight harness's camera bookmarks —
 * `anglesForPhase` is the one solver under both, so `crescent` here and
 * `ir.shot('crescent')` mean the same thing.
 *
 *   phase  the sun–body–camera angle: 0° full face, 90° half lit, 180° behind.
 *   tilt   how far the swing plane is rolled out of the star's own plane. Not
 *          the camera's elevation: at phase 90 the two coincide, at phase 10
 *          a 60° tilt barely lifts the camera at all. It is what stops every
 *          framing from being flat-on.
 */

/** How much of the frame's height the body fills. Feeds `frameTarget`. */
type Fill = number

export const PHASES: readonly {
  label: string
  deg: number
  /** Rolled out of the star's plane, so relief has a direction to fall in. */
  tilt: number
  icon: LucideIcon
  why: string
}[] = [
  { label: 'Full', deg: 12, tilt: 8, icon: Circle, why: 'the whole lit disc' },
  {
    label: 'Gibbous',
    deg: 55,
    tilt: 12,
    icon: PhaseGibbous,
    why: 'three-quarter lit, shadow sculpting the terrain',
  },
  {
    label: 'Half',
    deg: 90,
    tilt: 6,
    icon: PhaseHalf,
    why: 'the terminator down the middle of the disc',
  },
  {
    label: 'Crescent',
    deg: 147,
    tilt: 5,
    icon: PhaseCrescent,
    why: 'a thin crescent, atmosphere ringing the dark limb',
  },
  {
    label: 'Rim',
    deg: 171,
    tilt: 4,
    icon: PhaseRim,
    why: 'the star behind it — an unlit disc inside its own airglow',
  },
]

export const RANGES: readonly { label: string; fill: Fill; why: string }[] = [
  { label: 'Close', fill: 0.95, why: 'the disc overflowing the frame' },
  { label: 'Portrait', fill: DEFAULT_FILL, why: 'the whole body, framed' },
  { label: 'Wide', fill: 0.18, why: 'the body small, the sky large' },
]

/**
 * Whole shots: light, angle and distance in one press.
 *
 * These replaced a "tour" — five buttons that flew the camera to Sol, Earth,
 * Jupiter, Saturn and Alpha Centauri. Two things were wrong with it. It was a
 * second, worse catalogue sitting next to the real one, which lists every
 * system within sixteen light years and searches; and *where* to look is the
 * one question this panel should never answer, because the panel's whole
 * subject is what to do once you are looking at something.
 *
 * So the presets are compositions now, and they work on whatever is in frame.
 * Each is a judgement about a picture rather than an axis — the axes are the
 * two lists above, and the reason to keep both is that changing the light
 * without losing your framing is the commonest thing anyone does here.
 *
 * The `fill` values are deliberately not all the same: a crescent wants room
 * around it and a raking terminator wants the disc big enough to see relief in.
 */
export const COMPOSITIONS: readonly {
  label: string
  phase: number
  tilt: number
  fill: Fill
  why: string
}[] = [
  {
    label: 'Blue Marble',
    phase: 12,
    tilt: 10,
    fill: 0.72,
    why: 'the whole lit face, north a little high — the Apollo framing',
  },
  {
    label: 'Raking',
    phase: 88,
    tilt: 30,
    fill: 0.88,
    why: 'light along the surface at its lowest, where relief is longest',
  },
  {
    label: 'Earthrise',
    phase: 132,
    tilt: 8,
    fill: 0.32,
    why: 'a crescent low and small, most of the frame left to the dark',
  },
  {
    label: 'Backlit',
    phase: 172,
    tilt: 5,
    fill: 0.58,
    why: 'the star straight behind it, the atmosphere doing all the work',
  },
  {
    label: 'High Angle',
    phase: 62,
    tilt: 72,
    fill: 0.66,
    why: 'up over the plane, looking down across the pole',
  },
  {
    label: 'First Light',
    phase: 152,
    tilt: 16,
    fill: 0.46,
    why: 'the star just clear of the limb, flaring across the frame',
  },
]
