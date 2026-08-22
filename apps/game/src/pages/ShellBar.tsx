import { Link, useLocation } from 'react-router'
import { motion } from 'motion/react'
import { Bug, ChevronLeft, SlidersHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Toggle } from '@/components/ui/toggle'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import type { AppMode } from './paths.ts'
import { HOME, overlayState, SETTINGS } from './paths.ts'

/*
 * The one piece of chrome that is on screen in every mode.
 *
 * Top left, which is the corner nothing else claims — the dev dock is top
 * right, the flight strip is bottom left, a transport is bottom centre. Three
 * controls and no more: where you are, the way back, and the settings.
 *
 * The settings link carries the current location as its `state`, which is what
 * keeps the mode behind it mounted (see `paths.ts`). Without it, opening
 * settings from the planetarium would drop the observatory's target and hand
 * the camera back to the ship behind the dialog.
 */

const MODE_LABEL: Record<AppMode, string> = {
  menu: '',
  flight: 'flight',
  planetarium: 'planetarium',
  cinema: 'cinema',
}

export function ShellBar({
  mode,
  debug,
  onDebug,
}: {
  mode: AppMode
  debug: boolean
  onDebug: (on: boolean) => void
}) {
  const location = useLocation()
  const label = MODE_LABEL[mode]

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="pointer-events-auto absolute top-3 left-3 flex items-center gap-1.5 rounded-lg border border-slate-700/60 bg-slate-950/85 px-1.5 py-1 font-mono text-[11px] backdrop-blur"
    >
      {/*
       * A real anchor rather than a click handler that navigates, so
       * middle-click, copy-link and the back button all behave. On the menu it
       * is a decoration rather than a control: linking home from home is a
       * no-op the pointer promises something for.
       */}
      {mode === 'menu' ? (
        <span
          aria-hidden
          className="px-1 tracking-[0.3em] text-slate-400 uppercase"
        >
          ir
        </span>
      ) : (
        <Link
          to={HOME}
          aria-label="Back to the menu"
          title="Back to the menu"
          className={`flex min-h-6 items-center gap-1 rounded px-1 py-0.5 text-slate-400 transition-colors hover:text-sky-200 ${FOCUS_RING}`}
        >
          <ChevronLeft className="size-3.5" />
          <span className="tracking-[0.3em] uppercase">ir</span>
        </Link>
      )}

      {label.length > 0 && (
        // `rounded`, not the registry's pill: this system has two radii and a
        // pill is neither. See `ModeLink` for the same override.
        <Badge
          variant="secondary"
          className="rounded bg-slate-800/70 px-1.5 py-px font-mono text-[10px] font-normal tracking-widest text-sky-300/80 uppercase"
        >
          {label}
        </Badge>
      )}

      <Separator
        orientation="vertical"
        className="mx-0.5 !h-3.5 bg-slate-800"
      />

      {/*
       * The debug overlay lives here rather than only on a key, because a
       * keyboard shortcut nobody has been told about is a feature that does not
       * exist. It is off by default and it says its own binding in the tooltip.
       *
       * `Toggle`, not `Switch`, and the difference is the whole reason this bar
       * exists in the corner nothing else claims. A switch is a 32 px track in
       * solid `--primary`, which beside two 14 px glyphs is the loudest thing
       * on a bar whose entire brief is three controls and no more. A toggle is
       * an icon button that stays pressed — same `aria-pressed` semantics the
       * hand-rolled `<button role="switch">` was reaching for, at the size the
       * rest of the bar is drawn at.
       */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={debug}
            onPressedChange={onDebug}
            onClick={releaseFocus}
            aria-label="Debug overlay"
            className={`size-6 min-w-6 rounded p-0 ${FOCUS_RING} ${
              debug
                ? 'bg-sky-500/15 text-sky-200 hover:bg-sky-500/25 hover:text-sky-100'
                : 'bg-transparent text-slate-400 hover:bg-transparent hover:text-sky-200'
            }`}
          >
            <Bug className="size-3.5" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent className="font-mono text-[10px]">
          Debug overlay ( ` )
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            asChild
            variant="ghost"
            size="icon-xs"
            className={`text-slate-400 hover:bg-transparent hover:text-sky-200 ${FOCUS_RING}`}
          >
            <Link
              to={SETTINGS}
              state={overlayState(location)}
              aria-label="Settings"
            >
              <SlidersHorizontal />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent className="font-mono text-[10px]">
          Settings
        </TooltipContent>
      </Tooltip>
    </motion.div>
  )
}
