import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import { ChevronDown, ChevronUp, Rows3, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { ErrorBoundary } from '../hud/ErrorBoundary.tsx'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { Logomark } from '../icons/Logomark.tsx'
import { HOME, overlayState, SETTINGS } from '../pages/paths.ts'
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
 * catalogue. Still comfortably under two thirds, and it is one tap to put the
 * sky back.
 */
const SHEET_HEIGHT = 'max-h-[58vh]'

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
  const location = useLocation()
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

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col">
      {open !== null && (
        <section
          className={`pointer-events-auto mx-2 flex ${SHEET_HEIGHT} type-readout min-h-0 flex-col overflow-hidden rounded-t-lg border border-b-0 border-slate-700/60 bg-slate-950/90 text-slate-300 shadow-xl backdrop-blur`}
        >
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
                onClick={() =>
                  setOpenId(panel.id === open.id ? null : panel.id)
                }
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
       * `pb-[env(safe-area-inset-bottom)]` keeps it off the home indicator on a
       * notched device, where the bottom 34 px belong to the OS and anything
       * drawn there is both dimmed and un-tappable.
       */}
      <nav
        aria-label="Workspace"
        className="pointer-events-auto flex items-center gap-1 border-t border-slate-700/60 bg-slate-950/90 px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] backdrop-blur"
      >
        <Link
          to={HOME}
          aria-label="Back to the menu"
          className={`flex min-h-11 shrink-0 items-center gap-2 rounded px-2 text-slate-300 transition-colors active:bg-slate-800/60 ${FOCUS_RING}`}
        >
          <Logomark className="size-4 shrink-0" />
          <span className="type-label truncate">{mode}</span>
        </Link>

        {/*
         * The panel toggle sits in the middle and takes the slack, so the two
         * navigation targets stay pinned to the edges a thumb reaches for.
         * Disabled rather than hidden when a workspace has nothing open —
         * `DESIGN.md` keeps a disabled control on screen because its presence
         * is information, and here the information is "this mode has panels".
         */}
        <Button
          variant="ghost"
          aria-expanded={open !== null}
          disabled={available.length === 0}
          onClick={(event) => {
            releaseFocus(event)
            setOpenId(open === null ? (available[0]?.id ?? null) : null)
          }}
          className={`mx-auto min-h-11 gap-1.5 rounded px-3 disabled:opacity-35 ${FOCUS_RING} ${
            open === null
              ? 'text-slate-400 hover:bg-transparent active:bg-slate-800/60'
              : 'bg-sky-500/15 text-sky-200 hover:bg-sky-500/25 hover:text-sky-100'
          }`}
        >
          <Rows3 className="size-4" />
          <span className="type-label">{open?.title ?? 'Panels'}</span>
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

        <Link
          to={SETTINGS}
          state={overlayState(location)}
          aria-label="Settings"
          className={`flex size-11 shrink-0 items-center justify-center rounded text-slate-400 transition-colors active:bg-slate-800/60 ${FOCUS_RING}`}
        >
          <SlidersHorizontal className="size-4" />
        </Link>
      </nav>
    </div>
  )
}
