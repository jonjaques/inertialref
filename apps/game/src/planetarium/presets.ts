import { Circle, type LucideIcon } from 'lucide-react'
import { DEFAULT_FILL } from '@inertialref/devtools'
import {
  PhaseCrescent,
  PhaseGibbous,
  PhaseHalf,
  PhaseRim,
} from '../icons/index.tsx'

/*
 * Light, and whole shots — as data.
 *
 * Its own module because `PresetsPanel.tsx` must export components and nothing
 * else, or Fast Refresh gives up on the file. The lists are also the kind of
 * thing that gets edited without touching the component at all, which is most
 * of the point: a shot is an editorial judgement and adding one should be a
 * line here.
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
 *   fill   the fraction of the frame's *height* the body subtends. Feeds
 *          `frameTarget`, which solves a distance for it against the lens.
 */

export const PHASES: readonly {
  label: string
  deg: number
  /** Rolled out of the star's plane, so relief has a direction to fall in. */
  tilt: number
  icon: LucideIcon
  why: string
}[] = [
  { label: 'Full', deg: 12, tilt: 8, icon: Circle, why: 'the whole lit disk' },
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
    why: 'the terminator down the middle of the disk',
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
    why: 'the star behind it — an unlit disk inside its own airglow',
  },
]

/**
 * Whole shots: light, angle and distance in one press.
 *
 * **One list, where there were two.** `Framing` was `Close · Portrait · Wide`
 * and `Compositions` was six named pictures, and they were not two kinds of
 * thing — a framing is a composition that happens not to move the light, and
 * side by side they read as two banks of identical word-buttons with no way to
 * tell what either would do. They are drawn now (`ShotThumb.tsx`) and the
 * drawing is what makes the distinction between any two of them visible, which
 * is also what made keeping them apart unnecessary.
 *
 * The two axes survive as the `PHASES` row above and the scale jumps in the
 * panel, because *changing the light without losing your framing* is the
 * commonest thing anyone does here and a shot cannot express it.
 *
 * Nine, in a three-column grid, chosen to spread across both axes: no two of
 * them produce a thumbnail that could be mistaken for another. The `fill`
 * values are deliberately not all the same — a crescent wants room around it
 * and a raking terminator wants the disk big enough to see relief in.
 */
export interface Shot {
  readonly label: string
  readonly phase: number
  readonly tilt: number
  readonly fill: number
  readonly why: string
}

export const SHOTS: readonly Shot[] = [
  {
    label: 'Portrait',
    phase: 20,
    tilt: 10,
    fill: DEFAULT_FILL,
    why: 'the whole body with sky around it — where a new target opens',
  },
  {
    label: 'Blue Marble',
    phase: 12,
    tilt: 10,
    fill: 0.72,
    why: 'the whole lit face, north a little high — the Apollo framing',
  },
  {
    label: 'Close',
    phase: 35,
    tilt: 12,
    fill: 0.95,
    why: 'the disk overflowing the frame, as near as the camera will go',
  },
  {
    label: 'Wide',
    phase: 25,
    tilt: 15,
    fill: 0.18,
    why: 'the body small and the sky large — scale, rather than surface',
  },
  {
    label: 'Half Lit',
    phase: 90,
    tilt: 6,
    fill: 0.6,
    why: 'the terminator straight down the middle',
  },
  {
    label: 'Raking',
    phase: 88,
    tilt: 30,
    fill: 0.88,
    why: 'light along the surface at its lowest, where relief is longest',
  },
  {
    label: 'High Angle',
    phase: 62,
    tilt: 72,
    fill: 0.66,
    why: 'up over the plane, looking down across the pole',
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
]
