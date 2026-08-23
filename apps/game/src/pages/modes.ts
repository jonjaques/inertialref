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
 * Its own module for the reason `hud/controls.ts` is: `HomePage.tsx`,
 * `ModeLink.tsx` and `ModeRow.tsx` all need this, and a `.tsx` exporting a
 * constant beside its components is a file Fast Refresh gives up on.
 */

export interface ModeCard {
  readonly to: string
  readonly title: string
  readonly blurb: string
  readonly icon: LucideIcon
  /**
   * Why it is or is not enterable, in the design bible's own legend
   * (`docs/design/README.md`) — in words rather than glyphs, because a menu
   * that quietly links to something unbuilt is worse than one that says so.
   *
   * `built` is the one that is not about progress. Solo flight works; it is
   * held out of this build's menu deliberately, and saying `designed` about
   * something that runs would be the menu lying in the other direction.
   */
  readonly status: 'ready' | 'built' | 'designed' | 'deferred'
  readonly accent?: boolean
}

/**
 * In the order they are worth trying.
 *
 * The planetarium leads, which is a real decision rather than an accident of
 * this being the newest thing: it is the mode that needs no explanation, works
 * on a phone, and shows the one thing that makes this project unusual — a real
 * sky, derived rather than downloaded.
 */
export const MODES: readonly ModeCard[] = [
  {
    to: PLANETARIUM,
    title: 'Planetarium',
    blurb: 'Fly the catalog. No ship, no fuel, nowhere you cannot go.',
    icon: Observatory,
    status: 'ready',
    accent: true,
  },
  {
    to: CINEMA,
    title: 'Cinema',
    blurb: 'Scripted scenes over the live world, frame by frame.',
    icon: Clapperboard,
    status: 'ready',
  },
  {
    to: PLAY_SOLO,
    title: 'Solo',
    blurb: 'The whole game, offline. Nothing to download, nothing to ask for.',
    icon: Rocket,
    status: 'built',
  },
  {
    to: PLAY_ONLINE,
    title: 'Solo Online',
    blurb:
      'The same game, connected: discovery credit, and sync across devices.',
    icon: Wifi,
    status: 'designed',
  },
  {
    to: PLAY_MULTIPLAYER,
    title: 'Multiplayer',
    blurb: 'One shared, persistent galaxy. Deliberately deferred.',
    icon: Users,
    status: 'deferred',
  },
]

/**
 * Whether the menu offers it as a door.
 *
 * One predicate, read by the menu and by nothing else — the *routes* stay
 * mounted, so a pasted `/play/solo` still resolves and the author still has a
 * way into flight. That is a deliberate split: this is a decision about what a
 * visitor is invited into, not about what the build can do, and the URL is the
 * product's public surface (ADR-0011). Re-enabling a mode is a one-word edit to
 * its `status` above.
 */
export const isEnterable = (mode: ModeCard): boolean => mode.status === 'ready'

export const ENTERABLE = MODES.filter(isEnterable)
export const WITHHELD = MODES.filter((mode) => !isEnterable(mode))

/*
 * Title case in the source, uppercase on screen.
 *
 * The badge sets these in `type-label`, which carries `text-transform:
 * uppercase` — so the case written here is the case a `title`, an `aria-label`
 * or a copied string reads in, and the typography decides what is shouted.
 * Writing 'PLAYABLE' in the source would be a shout nothing could turn off.
 */
export const STATUS_LABEL: Record<ModeCard['status'], string> = {
  ready: 'Playable',
  built: 'Built',
  designed: 'Designed',
  deferred: 'Deferred',
}

export const STATUS_TONE: Record<ModeCard['status'], string> = {
  ready: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  built: 'border-slate-600 bg-slate-800/60 text-slate-300',
  designed: 'border-amber-500/30 bg-amber-500/10 text-amber-200/90',
  deferred: 'border-slate-700 bg-slate-800/50 text-slate-400',
}
