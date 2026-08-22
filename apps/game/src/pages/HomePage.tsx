import { useEffect } from 'react'
import { motion } from 'motion/react'
import { Info, LogIn, SlidersHorizontal } from 'lucide-react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { FooterLink } from './FooterLink.tsx'
import { ModeLink } from './ModeLink.tsx'
import { MODES } from './modes.ts'
import { ABOUT, SETTINGS, SIGN_IN } from './paths.ts'

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
          <span className="ml-auto text-slate-400">simulation running</span>
        </motion.footer>
      </div>
    </div>
  )
}
