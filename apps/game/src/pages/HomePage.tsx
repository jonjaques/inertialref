import { useEffect } from 'react'
import { Link } from 'react-router'
import { motion } from 'motion/react'
import {
  ArrowRight,
  Clapperboard,
  Info,
  LogIn,
  Rocket,
  SlidersHorizontal,
  Users,
  Wifi,
  type LucideIcon,
} from 'lucide-react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { FOCUS_RING } from '../hud/focus.ts'
import { Observatory } from '../icons/index.tsx'
import {
  ABOUT,
  PLANETARIUM,
  PLAY_MULTIPLAYER,
  PLAY_ONLINE,
  PLAY_SOLO,
  SETTINGS,
  SIGN_IN,
  CINEMA,
} from './paths.ts'

/*
 * The front door.
 *
 * A menu over a running simulation rather than a screen in front of one: the
 * scene behind this is the real engine, framed on Earth, and it keeps turning
 * while the menu is up. That is the same claim `docs/design/ux.md` makes about
 * settings — "the simulation keeps running" — applied to the first thing anyone
 * ever sees, and it is worth the four lines of camera code below because it is
 * the only pitch this project has that a screenshot cannot fake.
 *
 * The layout is a poster: type and choices anchored left in a gradient that
 * fades to nothing, so the right two-thirds of the frame is the planet. A
 * centred modal over a scrim would have been easier and would have thrown away
 * the reason to have a scene behind it at all.
 */

/** Degrees per second the menu's camera drifts. A turn in about nine minutes. */
const DRIFT_PIXELS_PER_FRAME = -0.04

interface ModeCard {
  readonly to: string
  readonly title: string
  readonly blurb: string
  readonly icon: LucideIcon
  readonly status: 'ready' | 'soon' | 'deferred'
  readonly accent?: boolean
}

/*
 * The five modes, in the order they are worth trying.
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
const MODES: readonly ModeCard[] = [
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

const STATUS_LABEL: Record<ModeCard['status'], string> = {
  ready: 'playable',
  soon: 'designed',
  deferred: 'deferred',
}

const STATUS_TONE: Record<ModeCard['status'], string> = {
  ready: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  soon: 'border-amber-500/30 bg-amber-500/10 text-amber-200/90',
  deferred: 'border-slate-700 bg-slate-800/50 text-slate-500',
}

export function HomePage({ engine }: { engine: GameEngine }) {
  /*
   * Frame Earth and let it turn.
   *
   * Through the observatory rather than by moving the ship: the menu must not
   * change canonical state, so that arriving here from a flight session and
   * leaving again puts you back exactly where you were. The drift is applied as
   * a *drag* — the same verb a hand uses — so it costs nothing new and cannot
   * disagree with the camera the planetarium will hand over to.
   */
  useEffect(() => {
    const observatory = engine.harness.observatory
    const previousShip = engine.showShip
    engine.showShip = false
    try {
      observatory.focus('s:SOL/b:2', { fill: 0.78, ease: false })
      observatory.setPhase(58, 12)
    } catch {
      // A world without Sol is not a world this build makes, but a menu that
      // throws is a black page — and the scene behind it is decoration.
    }

    let handle = 0
    const drift = (): void => {
      handle = window.requestAnimationFrame(drift)
      observatory.drag(DRIFT_PIXELS_PER_FRAME, 0)
    }
    handle = window.requestAnimationFrame(drift)

    return () => {
      window.cancelAnimationFrame(handle)
      engine.showShip = previousShip
      observatory.clear()
    }
  }, [engine])

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* The gradient is the poster's dark side. It stops well short of the
          right edge so the planet is never behind a scrim — the whole reason
          the menu sits over a live scene. */}
      <div className="pointer-events-auto absolute inset-y-0 left-0 flex w-full max-w-[46rem] flex-col justify-center gap-8 overflow-y-auto bg-gradient-to-r from-slate-950 from-40% via-slate-950/85 to-transparent px-6 py-10 sm:px-12">
        <motion.header
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <h1 className="text-2xl leading-none font-light tracking-[0.42em] text-slate-100 uppercase sm:text-3xl">
            Inertial<span className="text-sky-400">ref</span>
          </h1>
          <p className="mt-3 max-w-md font-mono text-[11px] leading-relaxed text-slate-400">
            A real sky, derived rather than downloaded — 7,123 catalogued
            systems within 150 light years, and the rest generated from a seed.
            One continuous space, from a cockpit to a surface to another star.
          </p>
        </motion.header>

        {/* The column stops well inside the gradient's fade. A card that ran
            to the panel's edge had its last few words dissolving into Earth,
            which is a lovely effect and an unreadable sentence. */}
        <nav aria-label="Modes" className="flex max-w-[31rem] flex-col gap-2">
          {MODES.map((mode, index) => (
            <motion.div
              key={mode.to}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              // Staggered rather than simultaneous: five cards arriving at once
              // reads as a page load, and one at a time reads as a list being
              // laid out. 45 ms is under the threshold where it becomes a wait.
              transition={{ duration: 0.35, delay: 0.1 + index * 0.045 }}
            >
              <ModeLink mode={mode} />
            </motion.div>
          ))}
        </nav>

        <motion.footer
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.4 }}
          className="flex max-w-[31rem] flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[11px]"
        >
          <FooterLink to={SETTINGS} icon={SlidersHorizontal} label="settings" />
          <FooterLink to={ABOUT} icon={Info} label="about" />
          <FooterLink to={SIGN_IN} icon={LogIn} label="sign in" />
          {/* Inside the column rather than pushed to the panel's edge: right
              aligned, this sentence landed on the planet and became the one
              piece of type on the page nobody could read. */}
          <span className="ml-auto text-slate-600">simulation running</span>
        </motion.footer>
      </div>
    </div>
  )
}

function ModeLink({ mode }: { mode: ModeCard }) {
  const Icon = mode.icon
  return (
    <Link
      to={mode.to}
      // The surfaces are near-opaque rather than a wash. They sit over a sunlit
      // planet at the brightest end of the frame, and a 50% slate over that is
      // a lighter grey than the type on it.
      className={`group flex items-center gap-4 rounded-lg border px-4 py-3 backdrop-blur-sm transition-all ${FOCUS_RING} ${
        mode.accent
          ? 'border-sky-500/40 bg-sky-950/70 hover:border-sky-400/70 hover:bg-sky-900/60'
          : 'border-slate-700/60 bg-slate-950/80 hover:border-slate-500 hover:bg-slate-900/85'
      }`}
    >
      <Icon
        aria-hidden
        className={`size-6 shrink-0 transition-colors ${
          mode.accent
            ? 'text-sky-300'
            : 'text-slate-500 group-hover:text-sky-300'
        }`}
        strokeWidth={1.5}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-slate-100">{mode.title}</span>
          <span
            className={`rounded-full border px-1.5 py-px font-mono text-[9px] tracking-widest uppercase ${STATUS_TONE[mode.status]}`}
          >
            {STATUS_LABEL[mode.status]}
          </span>
        </span>
        <span className="mt-0.5 block font-mono text-[11px] leading-snug text-slate-500">
          {mode.blurb}
        </span>
      </span>
      <ArrowRight
        aria-hidden
        className="size-4 shrink-0 -translate-x-1 text-slate-700 opacity-0 transition-all group-hover:translate-x-0 group-hover:text-sky-300 group-hover:opacity-100"
      />
    </Link>
  )
}

function FooterLink({
  to,
  icon: Icon,
  label,
}: {
  to: string
  icon: LucideIcon
  label: string
}) {
  return (
    <Link
      to={to}
      className={`flex items-center gap-1.5 rounded text-slate-500 transition-colors hover:text-sky-200 ${FOCUS_RING}`}
    >
      <Icon aria-hidden className="size-3.5" />
      {label}
    </Link>
  )
}
