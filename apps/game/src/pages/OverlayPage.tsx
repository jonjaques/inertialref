import { useEffect, useRef, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useOverlay } from './useOverlay.ts'

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
  /*
   * Closing goes back to the mode this dialog was opened over, not to the
   * menu.
   *
   * All three ways out — Escape, the scrim, the X — used to `navigate(HOME)`,
   * which is the one destination that is wrong whenever there is a background:
   * `/planetarium?at=s:SOL/b:5` unmounted, its cleanup ran
   * `observatory.clear()`, and the address in the URL was gone. The state that
   * says what to go back to was already being recorded by `ShellBar` and read
   * by `routes.tsx`; this file simply never asked for it. See `useOverlay`.
   */
  const { close } = useOverlay()

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
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  /*
   * Focus goes in when the dialog opens, and back where it came from when it
   * leaves.
   *
   * Without this the dialog was unreachable in practice. Every control in this
   * overlay hands focus back to the flight loop, so `document.activeElement` is
   * `<body>` when the gear is clicked — and the dialog is the last band in
   * `.hud-layer`, so it was measured at *79 tab stops* behind the rest of the
   * chrome. "Open settings, then press Tab eighty times" is not a keyboard
   * path.
   *
   * The panel takes focus rather than its first control: a dialog opening with
   * its close button focused reads to a screen reader as "Close", which is the
   * one thing the reader did not ask for. `tabIndex={-1}` makes it programmatic
   * only, so the panel never becomes a tab stop of its own.
   *
   * No focus trap, and that is the design rather than an omission. This is a
   * non-modal dialog over a simulation that keeps running — `aria-modal` is
   * `false` above for the same reason — so Tab past the last control leaves,
   * exactly as it would from any other region. What was broken was arriving,
   * not leaving.
   *
   * Restoring only happens if the dialog still had focus, and only to an
   * element still in the document. Two things make that fiddly enough to be
   * worth stating:
   *
   * The activeElement at cleanup is not reliably `<body>`. React runs a
   * deletion's destroy function around the same commit that detaches the node,
   * so focus may still be reported as the panel — checking only for `<body>`
   * skips the restore about half the time, depending on how the dialog was
   * closed. Both readings mean the same thing, so both count.
   *
   * And a mode can unmount behind an open dialog, so the opener may be gone by
   * the time we want it back. `focus()` on a detached node silently moves focus
   * to `<body>` — which is the state this whole effect exists to prevent.
   */
  const panel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const opener = document.activeElement
    const node = panel.current
    node?.focus({ preventScroll: true })
    return () => {
      const active = document.activeElement
      const dialogStillHadIt =
        active === null ||
        active === document.body ||
        node?.contains(active) === true
      if (
        dialogStillHadIt &&
        opener instanceof HTMLElement &&
        opener !== document.body &&
        opener.isConnected
      )
        opener.focus({ preventScroll: true })
    }
  }, [])

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
      // `hud-bleed` on the scrim alone. A dimmed screen with an undimmed band
      // above the notch reads as a rendering fault; the card it centers is
      // chrome and stays inside the safe area, which the flex centering does
      // for free because the scrim's own padding box is unchanged.
      className="hud-bleed pointer-events-auto absolute flex items-center justify-center bg-slate-950/70"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      // The scrim is the dismiss target, but only when it is the thing that was
      // clicked — a drag that started inside the panel and released out here
      // reports the panel as its target and must not close the page.
      onClick={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <motion.div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        aria-label={title}
        className="type-body flex max-h-[calc(100%-4rem)] w-[34rem] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-lg border border-slate-700/60 bg-slate-950/85 text-slate-300 shadow-xl"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.18 }}
      >
        <header className="flex items-baseline gap-3 border-b border-slate-800 px-4 py-2.5">
          {/*
           * The display face, because a page is a *place* — the same rule the
           * mode name follows in the IR menu and the mode title on the front
           * door. It was a 10px uppercase label, which made a dialog whose
           * whole job is to be read announce itself in the register reserved
           * for structure.
           */}
          <h1 className="type-title text-slate-100">{title}</h1>
          {subtitle !== undefined && (
            <span
              className="type-ui min-w-0 truncate text-slate-400"
              title={subtitle}
            >
              {subtitle}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto text-slate-400 hover:text-sky-200"
            aria-label="Close (Escape)"
            title="Close (Escape)"
            onClick={close}
          >
            <X />
          </Button>
        </header>
        <div className="min-h-0 overflow-y-auto px-4 py-3">{children}</div>
      </motion.div>
    </motion.div>
  )
}
