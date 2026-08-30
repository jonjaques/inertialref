import { useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Rows3, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { ErrorBoundary } from '../hud/ErrorBoundary.tsx'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { Logomark } from '../icons/Logomark.tsx'
import { OverlayLink } from '../pages/OverlayLink.tsx'
import { HOME, SETTINGS } from '../pages/paths.ts'
import { CompactTab } from './CompactTab.tsx'
import type { DockLayout } from './layout.ts'
import { openPanels } from './layout.ts'
import type { DockPanelDefinition } from './panels.ts'

/*
 * The same workspace on a phone: a nav bar, and a sheet of panels above it.
 *
 * Docking is deliberately not offered here, and that is a design decision
 * rather than a shortcut. "Left" and "right" have no meaning on a 390 px screen
 * — a 19 rem column is the entire width — so a drag that moved a panel between
 * panes would be a gesture with an invisible effect, which is worse than no
 * gesture. Floating is the same argument twice over: there is nothing for a
 * panel to float *over* that it would not also cover.
 *
 * The arrangement is still the same `DockLayout`, so a workspace arranged on a
 * desktop and opened on a phone keeps its panel *set* — the zones simply stop
 * being read, floating included. Rotating a tablet back to landscape restores
 * the panes exactly as they were, because nothing was thrown away to draw this.
 *
 * ## What this replaced, and why
 *
 * One row of tabs across the bottom, scrolling horizontally. Two failures, and
 * the second is the serious one:
 *
 * 1. **A horizontal scroller hides its own contents.** At 390 px the fourth tab
 *    was clipped mid-word and the fifth was off-screen with nothing to say so.
 *    Open the author's instruments and there were eleven. The panels are named
 *    in words here precisely because a finger cannot hover a glyph to find out
 *    what it is — and then the words were the thing that did not fit.
 * 2. **There was no way out of the mode at all.** The IR menu carries the mark,
 *    the place and the settings, and `Workspace` renders it only in the desktop
 *    arrangement. On a phone the planetarium had no route home and no settings:
 *    the browser's back button was the entire navigation model.
 *
 * So the strip is a *nav bar* now — the same three questions the IR menu
 * answers, in the same order, at thumb scale — and the panels moved into the
 * sheet they open, where they wrap onto as many rows as they need instead of
 * scrolling off the edge of one.
 */

/**
 * How much of the screen the open sheet takes.
 *
 * Up from 42vh, because the sheet carries the panel picker now as well as the
 * panel: at 42 the tab rows left about 120 px of body, which is four rows of a
 * catalog. Still comfortably under two thirds, and it is one tap to put the
 * sky back.
 *
 * `dvh`, not `vh`. On iOS Safari `vh` is the height the page would have with
 * the toolbars hidden, so 58vh of a 100vh layout inside a viewport that is
 * really 88% of that put the bottom of the sheet — and the nav bar under it —
 * behind the browser's own chrome.
 */
const SHEET_HEIGHT = 'max-h-[58dvh]'

export function CompactDock({
  panels,
  layout,
  mode,
}: {
  panels: readonly DockPanelDefinition[]
  layout: DockLayout
  /** The name of the place, beside the mark — as in the IR menu. */
  mode: string
}) {
  const available = openPanels(panels, layout)

  /*
   * Which panel is showing, and whether the sheet is open at all.
   *
   * Not persisted, unlike the layout: which tab was last open is a fact about
   * one glance, and restoring it on the next visit puts a panel over the sky
   * before the user has asked for anything. The layout is a preference; this is
   * a gesture.
   */
  const [openId, setOpenId] = useState<string | null>(null)
  const open = available.find((panel) => panel.id === openId) ?? null

  /*
   * The panel the toggle reopens, remembered for this mount and no longer.
   *
   * Not persisted — the paragraph above is still the rule, and a sheet restored
   * on arrival puts a panel over the sky before anyone has asked for anything.
   * But *within* one visit, closing the sheet to look at something and pressing
   * the toggle again landed on `available[0]` rather than on the panel that was
   * just being read, which for every mode whose first panel is not the one you
   * wanted is the wrong panel every time.
   *
   * A ref, written from the event handlers and never during render: nothing
   * renders from it, so a write must not re-render — and a write during render
   * is a write React is entitled to throw away.
   */
  const lastId = useRef<string | null>(null)
  const show = (id: string | null): void => {
    if (id !== null) lastId.current = id
    setOpenId(id)
  }
  /** Close, keeping the memory of what was open. */
  const hide = (): void => setOpenId(null)
  const reopen = (): string | null =>
    available.find((panel) => panel.id === lastId.current)?.id ??
    available[0]?.id ??
    null

  return (
    /*
     * `hud-bleed-bottom`: the bar is a band pinned to the bottom of the screen,
     * so its ground has to reach the physical edges the way a native tab bar's
     * does. `.hud-layer` pads every piece of chrome clear of the safe areas —
     * right for a readout floating over the scene, wrong for this, which would
     * otherwise leave a strip of live sky under it and a gutter down each side
     * in landscape. The *contents* come back inside on their own — the `nav`
     * below with padding, the sheet above with margins. Both, not just the one
     * that draws the ground: the sheet is a card and would otherwise be the
     * thing sitting under the notch.
     */
    <div className="hud-bleed-bottom pointer-events-none absolute inset-x-0 bottom-0 flex flex-col">
      {open !== null && (
        <section
          className={`pointer-events-auto flex ${SHEET_HEIGHT} type-readout min-h-0 flex-col overflow-hidden rounded-t-lg border border-b-0 border-slate-700/60 bg-slate-950/90 text-slate-300 shadow-xl backdrop-blur`}
          /*
           * The sheet's half of `hud-bleed-bottom`, and it is not optional.
           * The wrapper is pulled out to the physical edges so the *bar's*
           * ground reaches them; the sheet is a card and has to come back in,
           * or in landscape its picker and body sit in the 44 px the OS keeps
           * down each side. `max`, like the bar below: the inset replaces the
           * design's 0.5 rem rather than adding to it.
           */
          style={{
            marginLeft: 'max(0.5rem, var(--safe-left))',
            marginRight: 'max(0.5rem, var(--safe-right))',
          }}
        >
          {/*
           * The grabber: what a sheet on this platform looks like when it can
           * be dismissed, and a second way to dismiss it.
           *
           * Redundant with the toggle in the bar, deliberately. The toggle is
           * where a thumb goes to *open* the sheet; once it is open the thumb
           * is up in the panel body, and reaching back down past the picker to
           * a control whose label has not changed is a worse close than the one
           * every other sheet on the device has. It is a button rather than a
           * drag target because a drag here would have to compete with the
           * panel scrolling underneath it.
           */}
          <button
            type="button"
            onClick={(event) => {
              releaseFocus(event)
              hide()
            }}
            aria-label="Hide panels"
            className={`flex w-full shrink-0 items-center justify-center py-2 ${FOCUS_RING}`}
          >
            <span className="h-1 w-9 rounded-full bg-slate-700" />
          </button>

          {/*
           * The picker, inside the sheet and wrapping.
           *
           * Wrapping rather than scrolling is the whole fix: every panel is on
           * screen at once, at whatever number of rows that takes, and nothing
           * is hidden behind a gesture with no affordance. It is capped and
           * scrollable as a backstop — eleven panels with the instruments out
           * is four rows, and a picker that could grow past the body it is
           * picking for would be the old problem on the other axis.
           */}
          <div
            role="group"
            aria-label="Panels"
            className="flex max-h-32 shrink-0 flex-wrap gap-1 overflow-y-auto border-b border-slate-800 px-2 py-1.5"
          >
            {available.map((panel) => (
              <CompactTab
                key={panel.id}
                panel={panel}
                active={panel.id === open.id}
                onClick={() => (panel.id === open.id ? hide() : show(panel.id))}
              />
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
            {/* The same wall `PanelChrome` puts around a body: a throw costs
                the sheet's body, not the nav bar that can close it. Keyed so
                switching panels resets a tripped boundary. */}
            <ErrorBoundary key={open.id} what={`the ${open.title} panel`}>
              {open.render()}
            </ErrorBoundary>
          </div>
        </section>
      )}

      {/*
       * The nav bar: where you are, what you can see, what else there is —
       * the IR menu's three questions, at thumb scale.
       *
       * The four `max(…, var(--safe-…))` paddings are the other half of the
       * `hud-bleed-bottom` above: the ground reaches the edges of the display
       * and the controls stay out of the corners the OS keeps. On a notched
       * phone the bottom 34 px belong to the home indicator, and in landscape
       * the 44 px down each side belong to the notch and the rounded corners —
       * anything drawn in either is dimmed and un-tappable, which for a tab bar
       * means the whole interface appears broken on exactly the devices it was
       * built for. `max` rather than a sum: the inset *replaces* the ordinary
       * padding rather than adding to it, so a device with no safe area gets
       * the design's own spacing and nothing else.
       */}
      <nav
        aria-label="Workspace"
        className="pointer-events-auto flex items-center gap-1 border-t border-slate-700/60 bg-slate-950/90 py-1.5 backdrop-blur"
        style={{
          paddingLeft: 'max(0.5rem, var(--safe-left))',
          paddingRight: 'max(0.5rem, var(--safe-right))',
          paddingBottom: 'max(0.375rem, var(--safe-bottom))',
        }}
      >
        <a
          href={HOME}
          aria-label="Back to the menu"
          className={`flex min-h-11 shrink-0 items-center gap-2 rounded px-2 text-slate-300 transition-colors active:bg-slate-800/60 ${FOCUS_RING}`}
        >
          <Logomark className="size-4 shrink-0" />
          <span className="type-label truncate">{mode}</span>
        </a>

        {/*
         * The panel toggle sits in the middle and takes the slack, so the two
         * navigation targets stay pinned to the edges a thumb reaches for.
         * Disabled rather than hidden when a workspace has nothing open —
         * `DESIGN.md` keeps a disabled control on screen because its presence
         * is information, and here the information is "this mode has panels".
         *
         * **The label is "Panels" whether the sheet is open or shut**, and it
         * used to be the open panel's title instead. That reads as a different
         * control: press a button marked *Panels*, and the button you pressed
         * is now marked *Catalog* — so the way back is a control that was never
         * on screen when the decision to press it was made, and nothing on the
         * bar says what it does any more. A toggle names what it toggles.
         *
         * Which panel is open is answered where the panel is: the picker in the
         * sheet marks it, and the body under it is the thing itself. What
         * belongs here is the *state* of this control, and that is what the
         * chevron and the accent ground carry — the same open/shut vocabulary
         * every disclosure in this interface uses, plus `aria-expanded` for a
         * reader that cannot see either.
         */}
        <Button
          variant="ghost"
          aria-expanded={open !== null}
          disabled={available.length === 0}
          onClick={(event) => {
            releaseFocus(event)
            if (open === null) show(reopen())
            else hide()
          }}
          className={`mx-auto min-h-11 gap-1.5 rounded px-3 disabled:opacity-35 ${FOCUS_RING} ${
            open === null
              ? 'text-slate-400 hover:bg-transparent active:bg-slate-800/60'
              : 'bg-sky-500/15 text-sky-200 hover:bg-sky-500/25 hover:text-sky-100'
          }`}
        >
          <Rows3 className="size-4" />
          <span className="type-label">Panels</span>
          {open === null ? (
            <ChevronUp className="size-3 opacity-60" />
          ) : (
            <ChevronDown className="size-3 opacity-60" />
          )}
        </Button>

        <Separator
          orientation="vertical"
          className="mx-0.5 !h-5 bg-slate-800"
        />

        <OverlayLink
          to={SETTINGS}
          aria-label="Settings"
          className={`flex size-11 shrink-0 items-center justify-center rounded text-slate-400 transition-colors active:bg-slate-800/60 ${FOCUS_RING}`}
        >
          <SlidersHorizontal className="size-4" />
        </OverlayLink>
      </nav>
    </div>
  )
}
