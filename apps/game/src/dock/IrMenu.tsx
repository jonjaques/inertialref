import { Link, useLocation } from 'react-router'
import { motion } from 'motion/react'
import {
  BookText,
  PanelLeft,
  PanelRight,
  SlidersHorizontal,
} from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { AccountBadge } from '../account/AccountBadge.tsx'
import { FOCUS_RING } from '../hud/focus.ts'
import { Logomark } from '../icons/Logomark.tsx'
import { DOCS, HOME, overlayState, SETTINGS } from '../pages/paths.ts'
import { MenuToggle } from './MenuToggle.tsx'
import type { PanelGroup } from './panels.ts'
import type { DockPlacement } from './placement.ts'
import { PlacementMenu } from './PlacementMenu.tsx'
import { isOpen, type Workspace } from './useWorkspace.ts'

/*
 * The IR menu: the one bar that says where you are and what is on screen.
 *
 * Bottom center by default. It is the shortest travel from anywhere in the
 * frame, it is the band a transport already occupies in every tool that has
 * one, and it is the only edge the panes do not own. It floats there at the
 * system's own `0.75rem` inset — an edge, like the flight strip and the
 * notice, not the middle distance — so the center of the frame stays empty.
 *
 * Or attached, the full width of the top or bottom edge (`placement.ts`). The
 * bar is then a band rather than a card: its ground reaches the display's
 * edges, it keeps a single hairline on the side that faces the scene, and the
 * band is taken out of `.hud-layer` so no other chrome is laid out under it.
 * The attribute below is what `index.css` reads to do that.
 *
 * Read left to right it answers three questions in the order they are asked:
 * *where am I* (the mark and the mode), *what can I see* (the panes and the
 * panels), *what else is there* (the documentation, the settings, the bar
 * itself, and who is signed in). Attached, the third group moves to the far
 * end — a full-width bar with everything packed against its left edge is a
 * floating one with a strip of empty ground beside it.
 */

/** What the mark links back to, per mode. `menu` never renders this bar. */
export function IrMenu({
  mode,
  groups,
  workspace,
  revealed,
  onReveal,
  placement,
  onPlace,
}: {
  /** The name of the place, beside the mark. */
  mode: string
  groups: readonly PanelGroup[]
  workspace: Workspace
  /** Which guarded groups are currently disclosed, by group id. */
  revealed: ReadonlySet<string>
  onReveal: (group: string) => void
  placement: DockPlacement
  onPlace: (placement: DockPlacement) => void
}) {
  const location = useLocation()
  const attached = placement !== 'floating'
  /** Hints and menus open away from the edge the bar is on. */
  const side = placement === 'top' ? 'bottom' : 'top'

  return (
    <motion.nav
      // Keyed so a move between edges enters from the edge it arrived at,
      // rather than sliding across the frame from the one it left.
      key={placement}
      aria-label="Workspace"
      data-dock-attached={attached ? placement : undefined}
      initial={{ opacity: 0, y: placement === 'top' ? -8 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className={`pointer-events-auto absolute flex items-center gap-1 border-slate-700/60 bg-slate-950/90 backdrop-blur ${
        attached
          ? placement === 'top'
            ? 'dock-bar-top border-b'
            : 'dock-bar-bottom border-t'
          : 'bottom-3 left-1/2 max-w-[calc(100%-1.5rem)] -translate-x-1/2 overflow-x-auto rounded-lg border px-1.5 py-1 shadow-xl'
      }`}
    >
      {/*
       * One row that may scroll, inside a bar that may not. Attached, the bar
       * is the band's full height and the row is centered in it; a window too
       * narrow for every glyph scrolls the row rather than wrapping it into a
       * second line the band has no room for.
       */}
      <div
        className={`flex min-w-0 items-center gap-1 ${attached ? 'flex-1 overflow-x-auto' : ''}`}
      >
        {/*
         * A real anchor rather than a click handler that navigates, so
         * middle-click, copy-link and the back button all behave.
         *
         * The mark and the place are one target on purpose: they are one
         * answer, and two adjacent controls that go to the same address is a
         * thing a pointer has to choose between for no reason.
         */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={HOME}
              aria-label="Back to the menu"
              className={`flex min-h-7 shrink-0 items-center gap-2 rounded px-1.5 text-slate-300 transition-colors hover:text-sky-200 ${FOCUS_RING}`}
            >
              <Logomark className="size-4 shrink-0" />
              <span className="type-label">{mode}</span>
            </Link>
          </TooltipTrigger>
          <TooltipContent side={side}>Back to the menu</TooltipContent>
        </Tooltip>

        <Separator
          orientation="vertical"
          className="mx-0.5 !h-4 bg-slate-800"
        />

        {/* The panes. A pair, so the two read as one control with two sides
            rather than as two more panels. */}
        <MenuToggle
          icon={PanelLeft}
          label="Left pane"
          hint="slide it away, or bring it back"
          pressed={workspace.panes.left}
          onClick={() => workspace.togglePane('left')}
          side={side}
        />
        <MenuToggle
          icon={PanelRight}
          label="Right pane"
          hint="slide it away, or bring it back"
          pressed={workspace.panes.right}
          onClick={() => workspace.togglePane('right')}
          side={side}
        />

        {groups.map((group) => {
          const guarded = group.guarded === true
          const open = !guarded || revealed.has(group.id)
          const Disclosure = group.icon
          return (
            <div key={group.id} className="flex shrink-0 items-center gap-1">
              <Separator
                orientation="vertical"
                className="mx-0.5 !h-4 bg-slate-800"
              />
              {/*
               * The disclosure, for a group that is not a first-time visitor's
               * business. Pressed means "the instruments are out", and the
               * panels behind it are suppressed rather than closed — see
               * `PanelGroup.guarded` for why that distinction is load-bearing.
               */}
              {guarded && Disclosure !== undefined && (
                <MenuToggle
                  icon={Disclosure}
                  label={group.label}
                  hint="the author's instruments ( ` )"
                  pressed={open}
                  onClick={() => onReveal(group.id)}
                  side={side}
                />
              )}
              {open &&
                group.panels
                  .filter((panel) => panel.suppressed !== true)
                  .map((panel) => (
                    <MenuToggle
                      key={panel.id}
                      icon={panel.icon}
                      label={panel.title}
                      hint={panel.hint}
                      pressed={isOpen(workspace.layout, panel.id)}
                      onClick={() => workspace.toggle(panel.id)}
                      side={side}
                    />
                  ))}
            </div>
          )
        })}

        <Separator
          orientation="vertical"
          className={`mx-0.5 !h-4 bg-slate-800 ${attached ? 'hidden' : ''}`}
        />

        <div
          className={`flex shrink-0 items-center gap-1 ${attached ? 'ml-auto' : ''}`}
        >
          {/*
           * The documentation, from wherever you are.
           *
           * A plain link and deliberately not an overlay's: the reading room
           * is a *mode*, so going there leaves this one exactly as clicking the
           * mark does. It is beside the settings rather than beside the mark
           * because the bar answers three questions left to right and this is
           * the third — what else is there — which is also why it does not
           * appear on the front door's two doors. The menu offers what you can
           * fly; this offers what you can read.
           */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to={DOCS}
                aria-label="Documentation"
                className={`flex size-7 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-sky-200 ${FOCUS_RING}`}
              >
                <BookText aria-hidden className="size-4" />
              </Link>
            </TooltipTrigger>
            <TooltipContent side={side}>Documentation</TooltipContent>
          </Tooltip>

          {/*
           * Settings carries the current location as its `state`, which is
           * what keeps the mode behind it mounted (see `pages/paths.ts`).
           * Without it, opening settings from the planetarium drops the
           * observatory's target and hands the camera back to the ship behind
           * the dialog.
           */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to={SETTINGS}
                state={overlayState(location)}
                aria-label="Settings"
                className={`flex size-7 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-sky-200 ${FOCUS_RING}`}
              >
                <SlidersHorizontal className="size-4" />
              </Link>
            </TooltipTrigger>
            <TooltipContent side={side}>Settings</TooltipContent>
          </Tooltip>

          <PlacementMenu placement={placement} onPlace={onPlace} side={side} />

          {/*
           * Who is flying, last: the one control here that is about the person
           * rather than the place. Nothing at all in a build without accounts
           * — the badge decides that, so the separator comes with it.
           */}
          <AccountBadge divider side={side} />
        </div>
      </div>
    </motion.nav>
  )
}
