import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'

/**
 * One glyph in the menu: pressed when the thing it names is on screen.
 *
 * Icon-only, and this is the one place in the interface where that is settled
 * rather than argued: DESIGN.md forbids icon-only controls *on a readout
 * surface*, because an icon among a hundred labels is a guess. A menu is the
 * opposite surface — a row of peers with nothing else on it, read by shape and
 * position, at a size where fourteen words would be a paragraph across the
 * bottom of the frame.
 *
 * What that costs is the label, which comes back as a real tooltip rather than
 * a `title`. With no visible text the hint *is* the name, and a `title` that
 * takes a second to appear is one nobody waits for while hunting a panel they
 * closed.
 */
export function MenuToggle({
  icon: Icon,
  label,
  hint,
  pressed,
  onClick,
}: {
  icon: LucideIcon
  label: string
  /** The second half of the tooltip: what the thing is for. */
  hint?: string
  pressed: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-pressed={pressed}
          aria-label={label}
          onClick={(event) => {
            releaseFocus(event)
            onClick()
          }}
          /*
           * The accent as a wash, never as a fill behind the glyph — the same
           * rule every other control in this system follows, and the reason
           * `Button`'s `default` variant is not used anywhere in the overlay.
           * A pressed toggle is a lit key on a console, not a selected item in
           * a list.
           */
          className={`size-7 shrink-0 rounded ${FOCUS_RING} ${
            pressed
              ? 'bg-sky-500/15 text-sky-200 hover:bg-sky-500/25 hover:text-sky-100'
              : 'text-slate-400 hover:bg-slate-800/60 hover:text-sky-200'
          }`}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {hint === undefined ? label : `${label} — ${hint}`}
      </TooltipContent>
    </Tooltip>
  )
}
