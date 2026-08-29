import { Circle, type LucideIcon } from 'lucide-react'
import {
  PhaseCrescent,
  PhaseGibbous,
  PhaseHalf,
  PhaseRim,
} from '../icons/index.tsx'

/*
 * The light row — the panel's one axis that is not a whole composition.
 *
 * Its own module because `PresetsPanel.tsx` must export components and nothing
 * else, or Fast Refresh gives up on the file. It is also the kind of list that
 * gets edited without touching the component at all: a phase is an editorial
 * judgement and adding one should be a line here.
 *
 * Whole compositions live in `packages/rendering/src/compositions.ts`, which is
 * the one list `gibbous` here and `ir.shot('gibbous')` both come out of. This
 * row is what stays behind, because *changing the light without losing your
 * framing* is the commonest thing anyone does in the planetarium and a
 * composition cannot express it.
 *
 * The two angles are the photographer's, and `anglesForPhase` is the one solver
 * under both this row and the compositions:
 *
 *   phase  the sun–body–camera angle: 0° full face, 90° half lit, 180° behind.
 *   tilt   how far the swing plane is rolled out of the star's own plane. Not
 *          the camera's elevation: at phase 90 the two coincide, at phase 10
 *          a 60° tilt barely lifts the camera at all. It is what stops every
 *          framing from being flat-on.
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
