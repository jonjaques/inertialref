import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import type { DockLayout } from './layout.ts'
import { DROP_ZONES } from './layout.ts'
import type { DockPanelDefinition } from './panels.ts'

/*
 * The same panels on a phone: a sheet, and a strip of glyphs to choose from.
 *
 * Docking is deliberately not offered here, and that is a design decision
 * rather than a shortcut. "Left" and "right" have no meaning on a 390 px screen
 * — a 19 rem column is the entire width — so a drag that moved a panel between
 * zones would be a gesture with an invisible effect, which is worse than no
 * gesture. What *does* transfer is the part that matters on a phone: every
 * panel is reachable, one at a time, over a scene that is still the whole
 * screen.
 *
 * The arrangement is still the same `DockLayout`, so a workspace arranged on a
 * desktop and opened on a phone keeps its panel *set* — the zones simply stop
 * being read. Rotating a tablet back to landscape restores the columns exactly
 * as they were, because nothing was thrown away to draw this.
 */

/** How much of the screen the open sheet takes. Under half, so the sky wins. */
const SHEET_HEIGHT = 'max-h-[42vh]'

export function CompactDock({
  panels,
  layout,
}: {
  panels: readonly DockPanelDefinition[]
  layout: DockLayout
}) {
  const order = DROP_ZONES.flatMap((zone) => [...layout[zone]])
  const available = order
    .map((id) => panels.find((panel) => panel.id === id))
    .filter((panel): panel is DockPanelDefinition => panel !== undefined)

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

  if (available.length === 0) return null

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col">
      {open !== null && (
        <section
          className={`pointer-events-auto mx-2 flex ${SHEET_HEIGHT} min-h-0 flex-col overflow-hidden rounded-t-lg border border-b-0 border-slate-700/60 bg-slate-950/90 font-mono text-[12px] leading-relaxed text-slate-300 shadow-xl backdrop-blur`}
        >
          <header className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
            <open.icon
              aria-hidden
              className="size-4 shrink-0 text-sky-400/80"
            />
            <h2 className="truncate text-[11px] tracking-widest text-sky-300 uppercase">
              {open.title}
            </h2>
            <button
              type="button"
              aria-label={`Close ${open.title}`}
              onClick={(event) => {
                releaseFocus(event)
                setOpenId(null)
              }}
              className={`ml-auto rounded p-1 text-slate-400 ${FOCUS_RING}`}
            >
              <ChevronDown className="size-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
            {open.render()}
          </div>
        </section>
      )}

      {/*
       * The tab strip, and the reason it scrolls horizontally rather than
       * wrapping: a second row of tabs on a phone eats the sky, and the panels
       * a person uses are the first two or three either way.
       *
       * `pb-[env(safe-area-inset-bottom)]` keeps the strip off the home
       * indicator on a notched device, where the bottom 34 px belong to the OS
       * and anything drawn there is both dimmed and un-tappable.
       */}
      <nav
        aria-label="Panels"
        className="pointer-events-auto flex gap-1 overflow-x-auto border-t border-slate-700/60 bg-slate-950/90 px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] backdrop-blur"
      >
        {available.map((panel) => {
          const Icon = panel.icon
          const active = panel.id === openId
          return (
            <button
              key={panel.id}
              type="button"
              aria-pressed={active}
              onClick={(event) => {
                releaseFocus(event)
                setOpenId(active ? null : panel.id)
              }}
              // 44 px of height, which is the platform minimum for a target a
              // thumb has to hit while the other hand is holding the device.
              className={`flex min-h-11 shrink-0 items-center gap-1.5 rounded px-3 font-mono text-[11px] transition-colors ${FOCUS_RING} ${
                active
                  ? 'bg-sky-500/15 text-sky-200'
                  : 'text-slate-400 active:bg-slate-800/60'
              }`}
            >
              <Icon className="size-4" />
              <span className="tracking-widest uppercase">{panel.title}</span>
              {active && <ChevronUp className="size-3 opacity-60" />}
            </button>
          )
        })}
      </nav>
    </div>
  )
}
