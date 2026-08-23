import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import type { PaneZone } from './layout.ts'

/**
 * The tab a closed pane leaves at the edge of the frame.
 *
 * The menu can reopen a pane too, and this is still worth having: a pane closes
 * by sliding *sideways*, so the gesture puts the reopen exactly where the eye
 * last saw it go. A control that only existed forty pixels away in a bar at the
 * bottom would make the slide look like the pane had been destroyed.
 *
 * It carries the panel count rather than a name. "3" is the whole answer to
 * "was anything in there", and a pane has no name that is not its side.
 */
export function PaneHandle({
  zone,
  count,
  onOpen,
}: {
  zone: PaneZone
  count: number
  onOpen: () => void
}) {
  const Chevron = zone === 'left' ? ChevronRight : ChevronLeft
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Show the ${zone} pane`}
          onClick={(event) => {
            releaseFocus(event)
            onOpen()
          }}
          className={[
            'pointer-events-auto absolute top-1/2 flex -translate-y-1/2 flex-col items-center gap-1',
            'border border-slate-700/60 bg-slate-950/85 py-3 backdrop-blur transition-colors',
            'text-slate-400 hover:border-sky-500/60 hover:text-sky-200',
            FOCUS_RING,
            // Rounded on the inner side only. The Two Radii Rule is about the
            // *sizes* of the corners, not about every corner being drawn — a
            // tab flush to the frame edge with a rounded outer corner reads as
            // a panel that failed to reach the edge.
            zone === 'left'
              ? 'left-0 rounded-r-lg border-l-0 pr-1 pl-0.5'
              : 'right-0 rounded-l-lg border-r-0 pr-0.5 pl-1',
          ].join(' ')}
        >
          <Chevron aria-hidden className="size-3.5" />
          {count > 0 && (
            <span className="type-micro text-slate-400">{count}</span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side={zone === 'left' ? 'right' : 'left'}>
        {`Show the ${zone} pane — ${count} panel${count === 1 ? '' : 's'}`}
      </TooltipContent>
    </Tooltip>
  )
}
