import { useEffect, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HOME } from './paths.ts'

/*
 * The frame every routed page is drawn in.
 *
 * `docs/design/ux.md` is explicit that there is no pause menu and that
 * "settings open as an overlay while the simulation runs" — so this is a
 * scrim over a live scene, not a screen the game stops behind. Nothing here
 * touches the clock, and flight keys deliberately keep working underneath:
 * the world is still there and the ship is still where you left it.
 *
 * A route rather than a piece of `App` state because these are pages — a menu
 * with sections, an almanac, a settings tree — and the back button is the one
 * affordance every player already knows for leaving one. `App` keeps its own
 * dock state; nothing about the dock is addressable and nothing about a page
 * should not be.
 */

export function OverlayPage({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}) {
  const navigate = useNavigate()

  /*
   * Escape closes. Bound at the window rather than on the panel because focus
   * during flight lives on the body — every control in this overlay hands it
   * straight back, see `hud/focus.ts` — so a handler on a focused element
   * would only fire for somebody who had just clicked something.
   *
   * It cannot collide with the cutscene's own Escape: routed pages unmount
   * while a cutscene is running, along with the rest of the chrome.
   */
  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void navigate(HOME)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [navigate])

  return (
    <motion.div
      /*
       * 70% black, and no backdrop blur. Both halves were measured in front of
       * Earth rather than picked.
       *
       * The blur is what took the first version past `docs/design/ux.md`'s
       * precedent — the map overlay is 70% with the cockpit still visible
       * behind — and obliterated the planet the page sits over, which makes
       * "the simulation keeps running" a claim the frame contradicts.
       *
       * 55% without the blur then went too far the other way, and the reason is
       * worth knowing: on the extended-range path the canvas carries a sunlit
       * planet well above diffuse white, so 45% of *that* is still about
       * diffuse white and the scrim barely registers. A scrim over this scene
       * has to be read against what is behind it, not against a swatch.
       */
      className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-slate-950/70"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      // The scrim is the dismiss target, but only when it is the thing that was
      // clicked — a drag that started inside the panel and released out here
      // reports the panel as its target and must not close the page.
      onClick={(event) => {
        if (event.target === event.currentTarget) void navigate(HOME)
      }}
    >
      <motion.div
        role="dialog"
        aria-modal="false"
        aria-label={title}
        className="flex max-h-[calc(100vh-4rem)] w-[34rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-slate-700/60 bg-slate-950/85 font-mono text-[11px] leading-relaxed text-slate-300 shadow-xl"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.18 }}
      >
        <header className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
          <h1 className="text-[10px] tracking-widest text-sky-300 uppercase">
            {title}
          </h1>
          {subtitle !== undefined && (
            <span className="min-w-0 truncate text-slate-500" title={subtitle}>
              {subtitle}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto text-slate-500 hover:text-sky-200"
            aria-label="Close (Escape)"
            title="Close (Escape)"
            onClick={() => void navigate(HOME)}
          >
            <X />
          </Button>
        </header>
        <div className="min-h-0 overflow-y-auto px-3 py-2">{children}</div>
      </motion.div>
    </motion.div>
  )
}
