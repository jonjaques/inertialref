import { Link, useLocation } from 'react-router'
import { motion } from 'motion/react'
import { PanelLeft, PanelRight, SlidersHorizontal } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { FOCUS_RING } from '../hud/focus.ts'
import { Logomark } from '../icons/Logomark.tsx'
import { HOME, overlayState, SETTINGS } from '../pages/paths.ts'
import { MenuToggle } from './MenuToggle.tsx'
import type { PanelGroup } from './panels.ts'
import { isOpen, type Workspace } from './useWorkspace.ts'

/*
 * The IR menu: the one bar that says where you are and what is on screen.
 *
 * Bottom centre, and that is a move rather than an inheritance. This used to be
 * a bar in the top-left corner carrying three controls, plus a launcher rail
 * down the left edge carrying the panels — two pieces of chrome, in two
 * corners, doing one job between them, and neither of them was where a hand
 * goes. Bottom centre is the shortest travel from anywhere in the frame, it is
 * the band a transport already occupies in every tool that has one, and it is
 * the only edge the panes do not own.
 *
 * Read left to right it answers three questions in the order they are asked:
 * *where am I* (the mark and the mode), *what can I see* (the panes and the
 * panels), *what else is there* (the settings). Everything between the first
 * separator and the last is a toggle, and every toggle is the same button.
 *
 * The centre of the frame stays empty, which is the rule this bar could most
 * easily have broken. It is anchored to the bottom edge at the system's own
 * `0.75rem` inset — an edge, like the flight strip and the notice, not the
 * middle distance.
 */

/** What the mark links back to, per mode. `menu` never renders this bar. */
export function IrMenu({
  mode,
  groups,
  workspace,
  revealed,
  onReveal,
}: {
  /** The name of the place, beside the mark. */
  mode: string
  groups: readonly PanelGroup[]
  workspace: Workspace
  /** Which guarded groups are currently disclosed, by group id. */
  revealed: ReadonlySet<string>
  onReveal: (group: string) => void
}) {
  const location = useLocation()

  return (
    <motion.nav
      aria-label="Workspace"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="pointer-events-auto absolute bottom-3 left-1/2 flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-lg border border-slate-700/60 bg-slate-950/90 px-1.5 py-1 shadow-xl backdrop-blur"
    >
      {/*
       * A real anchor rather than a click handler that navigates, so
       * middle-click, copy-link and the back button all behave.
       *
       * The mark and the place are one target on purpose: they are one answer,
       * and two adjacent controls that go to the same address is a thing a
       * pointer has to choose between for no reason.
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
        <TooltipContent side="top">Back to the menu</TooltipContent>
      </Tooltip>

      <Separator orientation="vertical" className="mx-0.5 !h-4 bg-slate-800" />

      {/* The panes. A pair, so the two read as one control with two sides
          rather than as two more panels. */}
      <MenuToggle
        icon={PanelLeft}
        label="Left pane"
        hint="slide it away, or bring it back"
        pressed={workspace.panes.left}
        onClick={() => workspace.togglePane('left')}
      />
      <MenuToggle
        icon={PanelRight}
        label="Right pane"
        hint="slide it away, or bring it back"
        pressed={workspace.panes.right}
        onClick={() => workspace.togglePane('right')}
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
              />
            )}
            {open &&
              group.panels.map((panel) => (
                <MenuToggle
                  key={panel.id}
                  icon={panel.icon}
                  label={panel.title}
                  hint={panel.hint}
                  pressed={isOpen(workspace.layout, panel.id)}
                  onClick={() => workspace.toggle(panel.id)}
                />
              ))}
          </div>
        )
      })}

      <Separator orientation="vertical" className="mx-0.5 !h-4 bg-slate-800" />

      {/*
       * Settings carries the current location as its `state`, which is what
       * keeps the mode behind it mounted (see `pages/paths.ts`). Without it,
       * opening settings from the planetarium drops the observatory's target
       * and hands the camera back to the ship behind the dialog.
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
        <TooltipContent side="top">Settings</TooltipContent>
      </Tooltip>
    </motion.nav>
  )
}
