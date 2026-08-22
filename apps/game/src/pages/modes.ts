import {
  Clapperboard,
  type LucideIcon,
  Rocket,
  Users,
  Wifi,
} from 'lucide-react'
import { Observatory } from '../icons/index.tsx'
import {
  CINEMA,
  PLANETARIUM,
  PLAY_MULTIPLAYER,
  PLAY_ONLINE,
  PLAY_SOLO,
} from './paths.ts'

/*
 * The five modes, as data.
 *
 * Its own module for the reason `tabs.ts` is: `HomePage.tsx` and `ModeLink.tsx`
 * both need this, and a `.tsx` exporting a constant beside its components is a
 * file Fast Refresh gives up on.
 */

export interface ModeCard {
  readonly to: string
  readonly title: string
  readonly blurb: string
  readonly icon: LucideIcon
  readonly status: 'ready' | 'soon' | 'deferred'
  readonly accent?: boolean
}

/*
 * In the order they are worth trying.
 *
 * The planetarium leads, which is a real decision rather than an accident of
 * this being the newest thing: it is the mode that needs no explanation, works
 * on a phone, and shows the one thing that makes this project unusual — a real
 * sky, derived rather than downloaded. Flight is the game; this is the door.
 *
 * The statuses are the design bible's own legend (`docs/design/README.md`), in
 * words rather than glyphs, because a menu that quietly links to something
 * unbuilt is worse than one that says so.
 */
export const MODES: readonly ModeCard[] = [
  {
    to: PLANETARIUM,
    title: 'Planetarium',
    blurb: 'Fly the catalogue. No ship, no fuel, nowhere you cannot go.',
    icon: Observatory,
    status: 'ready',
    accent: true,
  },
  {
    to: PLAY_SOLO,
    title: 'Solo',
    blurb: 'The whole game, offline. Nothing to download, nothing to ask for.',
    icon: Rocket,
    status: 'ready',
  },
  {
    to: CINEMA,
    title: 'Cinema',
    blurb: 'Scripted scenes over the live world, frame by frame.',
    icon: Clapperboard,
    status: 'ready',
  },
  {
    to: PLAY_ONLINE,
    title: 'Solo online',
    blurb:
      'The same game, connected: discovery credit, and sync across devices.',
    icon: Wifi,
    status: 'soon',
  },
  {
    to: PLAY_MULTIPLAYER,
    title: 'Multiplayer',
    blurb: 'One shared, persistent galaxy. Deliberately deferred.',
    icon: Users,
    status: 'deferred',
  },
]

export const STATUS_LABEL: Record<ModeCard['status'], string> = {
  ready: 'playable',
  soon: 'designed',
  deferred: 'deferred',
}

export const STATUS_TONE: Record<ModeCard['status'], string> = {
  ready: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  soon: 'border-amber-500/30 bg-amber-500/10 text-amber-200/90',
  deferred: 'border-slate-700 bg-slate-800/50 text-slate-400',
}
