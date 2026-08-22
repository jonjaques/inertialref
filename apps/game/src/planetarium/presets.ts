import { Circle, type LucideIcon } from 'lucide-react'
import { DEFAULT_FILL } from '@inertialref/devtools'
import { PhaseCrescent, PhaseGibbous, PhaseHalf } from '../icons/index.tsx'

/*
 * Compositions, distances and a short tour — as data.
 *
 * Its own module because `PresetsPanel.tsx` must export components and nothing
 * else, or Fast Refresh gives up on the file. The lists are also the kind of
 * thing that gets edited without touching the component at all.
 */

export const PHASES: readonly {
  label: string
  deg: number
  icon: LucideIcon
}[] = [
  { label: 'full', deg: 12, icon: Circle },
  { label: 'gibbous', deg: 55, icon: PhaseGibbous },
  { label: 'half', deg: 90, icon: PhaseHalf },
  { label: 'crescent', deg: 147, icon: PhaseCrescent },
]

export const RANGES: readonly { label: string; fill: number }[] = [
  { label: 'close', fill: 0.95 },
  { label: 'portrait', fill: DEFAULT_FILL },
  { label: 'wide', fill: 0.18 },
]

/**
 * A short list of places that are worth the first thirty seconds.
 *
 * Hard-coded rather than generated: "somewhere impressive" is an editorial
 * judgement and there is no field in the catalogue for it.
 */
export const TOUR: readonly { label: string; address: string; why: string }[] =
  [
    {
      label: 'Sol',
      address: 'SOL',
      why: 'home, and the only star anyone knows by eye',
    },
    {
      label: 'Earth',
      address: 's:SOL/b:2',
      why: 'the disc every render is judged against',
    },
    {
      label: 'Jupiter',
      address: 's:SOL/b:5',
      why: 'oblate, banded, and the largest thing nearby',
    },
    {
      label: 'Saturn',
      address: 's:SOL/b:6',
      why: 'the rings, which are real geometry here',
    },
    {
      label: 'Alpha Cen',
      address: 'HIP71683',
      why: 'the nearest star system — four light years of nothing to cross',
    },
  ]
